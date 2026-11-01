import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import net from 'node:net';
import { findInstalledBrowser, type BrowserKind } from './install.js';
import { getBrowserWebSocketUrl, probePort } from './discovery.js';

/**
 * Detects whether the current environment requires Chromium sandbox bypass flags.
 * Returns an object describing which runtime-context flags should be auto-appended.
 */
interface RuntimeHints {
  /** Running as uid 0 — Chrome refuses to launch unless --no-sandbox is present. */
  isRoot: boolean;
  /** Likely inside a container (Docker/Podman/Kubernetes/LXC) where /dev/shm is tiny. */
  isContainer: boolean;
  /** /usr/bin/Xvfb or similar virtual display likely absent — headless mode safer. */
  noDisplay: boolean;
}

let cachedRuntimeHints: RuntimeHints | null = null;

function detectRuntimeHints(): RuntimeHints {
  if (cachedRuntimeHints) return cachedRuntimeHints;

  const isRoot = process.platform !== 'win32' && process.getuid?.() === 0;

  // Container detection: several cheap signals, any one is enough.
  const env = process.env;
  const isContainer =
    process.platform !== 'win32' &&
    (existsSync('/.dockerenv') ||
      existsSync('/run/.containerenv') ||
      Boolean(env.DOCKER) ||
      Boolean(env.KUBERNETES_SERVICE_HOST) ||
      Boolean(env.PODMAN) ||
      Boolean(env.CONTAINER));

  // DISPLAY unset on unix → headed mode will fail; headless is the safe default.
  const noDisplay = process.platform !== 'win32' && !env.DISPLAY && !env.WAYLAND_DISPLAY;

  cachedRuntimeHints = { isRoot, isContainer, noDisplay };
  return cachedRuntimeHints;
}

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
  /** Milliseconds to wait for the DevTools endpoint. Default 30000. */
  timeoutMs?: number;
  /** Keep the page active/visible so headless still runs rAF and game loops: adds anti-backgrounding flags and the session calls Page.setWebLifecycleState({state:'active'}). */
  emulateVisible?: boolean;
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
          headless: existing.headless ?? Boolean(options.headless),
        };
      }
    }

    const port = options.port ?? (await pickFreePort(host));
    const temporaryProfile = !options.userDataDir;
    const userDataDir = options.userDataDir ?? createProfileDir();

    const hints = detectRuntimeHints();

    // Auto flags that the runtime *requires* — always included (deduped below).
    const runtimeArgs: string[] = [];
    if (hints.isRoot) runtimeArgs.push('--no-sandbox');
    if (hints.isContainer || hints.noDisplay) runtimeArgs.push('--disable-dev-shm-usage');
    if (hints.isContainer || hints.noDisplay) runtimeArgs.push('--disable-gpu');

    // Effective headless: either user asked for it, or there's no display server.
    const effectiveHeadless = Boolean(options.headless) || hints.noDisplay;
    if (hints.noDisplay && !options.headless) {
      // If the user didn't opt in but we have no DISPLAY, force headless and warn below.
      console.warn(
        `[BrowserLauncher] No DISPLAY detected — forcing --headless. Set DISPLAY or pass headless:false explicitly if you have Xvfb/Wayland.`,
      );
    }

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
      ...runtimeArgs,
      ...(options.emulateVisible ? ['--disable-backgrounding-occluded-windows'] : []),
      ...(effectiveHeadless ? ['--headless=new'] : []),
      // User-supplied args come last so they can override any defaults above.
      ...(options.args ?? []),
    ];

    // Dedupe so duplicate --no-sandbox etc. don't crash Chrome (first wins).
    const seen = new Set<string>();
    const dedupedArgs: string[] = [];
    for (const arg of args) {
      const key = arg.split('=', 1)[0];
      if (!seen.has(key)) {
        seen.add(key);
        dedupedArgs.push(arg);
      }
    }

    if (options.url) dedupedArgs.push(options.url);

    const child = spawn(executable, dedupedArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    const pid = child.pid ?? -1;
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
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
      headless: effectiveHeadless,
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
  return target.startsWith(root) && target.includes('cdp-browser-mcp');
}

function createProfileDir(): string {
  const dir = join(tmpdir(), 'cdp-browser-mcp', `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function pickFreePort(host: string, from = 9222, to = 9400): Promise<number> {
  for (let port = from; port <= to; port++) {
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(`No free debugging port found in range ${from}-${to}`);
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
