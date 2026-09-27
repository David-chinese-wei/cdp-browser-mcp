import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import net from 'node:net';
import { findInstalledBrowser, type BrowserKind } from './install.js';
import { getBrowserWebSocketUrl, probePort } from './discovery.js';

export interface LaunchOptions {
  /** Which browser to start. Defaults to the first one installed. */
  kind?: BrowserKind;
  /** Explicit path to a Chromium based executable. Overrides `kind`. */
  executable?: string;
  /** Debugging port. Omit to auto pick a free one. */
  port?: number;
  host?: string;
  /** Run with `--headless=new`. Default false. */
  headless?: boolean;
  /** Optional URL or file path to open on start. */
  url?: string;
  /** Persistent profile directory. Omit for a throwaway profile. */
  userDataDir?: string;
  /** Extra Chromium switches. */
  args?: string[];
  /** Keep the temporary profile on disk after close. Default false. */
  keepProfile?: boolean;
  /** Milliseconds to wait for the DevTools endpoint. Default 20000. */
  timeoutMs?: number;
}

export interface LaunchedBrowser {
  kind: BrowserKind;
  display: string;
  executable: string;
  host: string;
  port: number;
  pid: number;
  userDataDir: string;
  webSocketDebuggerUrl: string;
  temporaryProfile: boolean;
  headless: boolean;
}

interface ManagedInstance extends LaunchedBrowser {
  child: ChildProcess;
  keepProfile: boolean;
}

/** Owns browser instances started by this server so they can be shut down later. */
export class BrowserLauncher {
  private readonly instances = new Map<number, ManagedInstance>();

  async launch(options: LaunchOptions = {}): Promise<LaunchedBrowser> {
    const host = options.host ?? '127.0.0.1';

    let executable = options.executable;
    let kind: BrowserKind = options.kind ?? 'auto';
    let display = 'custom';

    if (executable) {
      if (!existsSync(executable)) throw new Error(`Executable not found: ${executable}`);
      display = basename(executable);
    } else {
      const found = findInstalledBrowser(kind);
      if (!found) {
        throw new Error(
          'No Chromium based browser found. Pass `executable` with an explicit path to chrome/edge/brave.',
        );
      }
      executable = found.executable;
      kind = found.kind;
      display = found.display;
    }

    // Reuse an endpoint that is already up on the requested port.
    if (options.port) {
      const existing = await probePort(options.port, host, 700);
      if (existing) {
        return {
          kind,
          display,
          executable,
          host,
          port: options.port,
          pid: -1,
          userDataDir: existing.browser,
          webSocketDebuggerUrl: existing.webSocketDebuggerUrl || (await getBrowserWebSocketUrl(options.port, host)),
          temporaryProfile: false,
          headless: Boolean(options.headless),
        };
      }
    }

    const port = options.port ?? (await pickFreePort(host));
    const temporaryProfile = !options.userDataDir;
    const userDataDir = options.userDataDir ?? createProfileDir();

    const args: string[] = [
      `--remote-debugging-port=${port}`,
      // Required since Chrome 111: without it the WebSocket handshake is rejected.
      '--remote-allow-origins=*',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,OptimizationHints,MediaRouter',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-ipc-flooding-protection',
      '--metrics-recording-only',
      '--mute-audio',
      '--window-size=1440,900',
      ...(options.headless ? ['--headless=new'] : []),
      ...(options.args ?? []),
    ];
    if (options.url) args.push(options.url);

    const child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    const pid = child.pid ?? -1;
    const deadline = Date.now() + (options.timeoutMs ?? 20_000);
    let webSocketDebuggerUrl = '';

    while (Date.now() < deadline) {
      if (pid > 0 && child.exitCode !== null) {
        throw new Error(`${display} exited during startup with code ${child.exitCode}`);
      }
      try {
        webSocketDebuggerUrl = await getBrowserWebSocketUrl(port, host);
        break;
      } catch {
        await sleep(200);
      }
    }
    if (!webSocketDebuggerUrl) {
      throw new Error(`${display} did not expose a DevTools endpoint on ${host}:${port} in time`);
    }

    const instance: ManagedInstance = {
      kind,
      display,
      executable,
      host,
      port,
      pid,
      userDataDir,
      webSocketDebuggerUrl,
      temporaryProfile,
      headless: Boolean(options.headless),
      child,
      keepProfile: Boolean(options.keepProfile),
    };
    if (pid > 0) this.instances.set(port, instance);
    return toPublic(instance);
  }

  /** Close a browser we started, by port. Returns false when unknown. */
  async close(port: number): Promise<boolean> {
    const instance = this.instances.get(port);
    if (!instance) return false;
    await killTree(instance);
    removeProfile(instance);
    this.instances.delete(port);
    return true;
  }

  async closeAll(): Promise<number> {
    const ports = [...this.instances.keys()];
    let count = 0;
    for (const port of ports) if (await this.close(port)) count++;
    return count;
  }

  list(): LaunchedBrowser[] {
    return [...this.instances.values()].map(toPublic);
  }
}

function toPublic(instance: ManagedInstance): LaunchedBrowser {
  const { child: _child, keepProfile: _keepProfile, ...rest } = instance;
  return rest;
}

async function killTree(instance: ManagedInstance): Promise<void> {
  const pid = instance.pid;
  if (pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      await run('taskkill', ['/PID', String(pid), '/T', '/F']);
      return;
    }
    process.kill(pid, 'SIGTERM');
    await sleep(1200);
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete the throwaway profile we created. Guarded so it can never remove
 * anything outside our own temp directory.
 *
 * A Chrome profile holds tens of thousands of files and deleting it inline
 * blocks the tool call for tens of seconds on Windows, so the removal is handed
 * to a detached child process instead of being awaited.
 */
function removeProfile(instance: ManagedInstance): void {
  if (instance.keepProfile || !instance.temporaryProfile) return;
  if (!isManagedProfile(instance.userDataDir)) return;

  const dir = instance.userDataDir;
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else {
      spawn('rm', ['-rf', dir], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* nothing we can do about it */
  }
}

function isManagedProfile(dir: string): boolean {
  const target = resolve(dir);
  const root = resolve(tmpdir());
  return target.startsWith(root) && target.includes('browser-devtools-mcp');
}

function createProfileDir(): string {
  const dir = join(tmpdir(), 'browser-devtools-mcp', `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function pickFreePort(host: string, from = 9222, attempts = 60): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    const port = from + i;
    if (await isPortFree(port, host)) return port;
  }
  throw new Error('No free debugging port found');
}

function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = net.createServer();
    server.once('error', () => resolvePromise(false));
    server.once('listening', () => server.close(() => resolvePromise(true)));
    server.listen(port, host);
  });
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.once('error', () => resolvePromise());
    child.once('close', () => resolvePromise());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
