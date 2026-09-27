import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BrowserFamily, BrowserProcessInfo } from '../types.js';

const execFileAsync = promisify(execFile);

/** Matches the browser processes we care about, on every platform. */
const BROWSER_NAME_RE =
  /(chrome|chromium|chrome_crashpad|msedge|edge|brave|opera|vivaldi|firefox|waterfox|safari|iexplore|arc)/i;

const DISPLAY_BY_NAME: Array<{ test: RegExp; display: string; family: BrowserFamily }> = [
  { test: /msedge|microsoft\s*edge|^\s*edge/i, display: 'Microsoft Edge', family: 'chromium' },
  { test: /brave/i, display: 'Brave', family: 'chromium' },
  { test: /vivaldi/i, display: 'Vivaldi', family: 'chromium' },
  { test: /opera/i, display: 'Opera', family: 'chromium' },
  { test: /arc/i, display: 'Arc', family: 'chromium' },
  { test: /chrome-headless-shell/i, display: 'Chrome Headless Shell', family: 'chromium' },
  { test: /chromium/i, display: 'Chromium', family: 'chromium' },
  { test: /chrome/i, display: 'Google Chrome', family: 'chromium' },
  { test: /firefox|waterfox/i, display: 'Mozilla Firefox', family: 'firefox' },
  { test: /safari/i, display: 'Safari', family: 'safari' },
  { test: /iexplore/i, display: 'Internet Explorer', family: 'unknown' },
];

export interface ListProcessesOptions {
  /** Include renderer / gpu / utility child processes. Defaults to false. */
  includeChildren?: boolean;
  /** Restrict to processes whose name or command line matches this string. */
  filter?: string;
}

export interface ListProcessesResult {
  platform: NodeJS.Platform;
  processes: BrowserProcessInfo[];
  /** Populated when enumeration failed or was partially unavailable. */
  warnings: string[];
}

/**
 * Enumerate running browser processes on the current machine.
 *
 * Command lines are required to discover an existing `--remote-debugging-port`,
 * so Windows uses CIM and unix uses `ps -eo pid,comm,args`.
 */
export async function listBrowserProcesses(options: ListProcessesOptions = {}): Promise<ListProcessesResult> {
  const warnings: string[] = [];
  let raw: RawProcess[] = [];

  try {
    raw = process.platform === 'win32' ? await listWindows() : await listUnix();
  } catch (err) {
    warnings.push(`Process enumeration failed: ${(err as Error).message}`);
  }

  const filter = options.filter?.trim().toLowerCase();
  const processes = raw
    .filter((p) => BROWSER_NAME_RE.test(p.name) || BROWSER_NAME_RE.test(p.command))
    // `--type=renderer|gpu|utility` marks a child process spawned by the browser.
    .filter((p) => options.includeChildren || !/\s--type=/i.test(p.command))
    .map(toBrowserProcessInfo)
    .filter((p) => !filter || p.display.toLowerCase().includes(filter) || p.commandLine.toLowerCase().includes(filter))
    .sort((a, b) => (a.debuggingPort ? 0 : 1) - (b.debuggingPort ? 0 : 1) || a.pid - b.pid);

  return { platform: process.platform, processes, warnings };
}

interface RawProcess {
  pid: number;
  name: string;
  command: string;
}

async function listWindows(): Promise<RawProcess[]> {
  const script = `
$ErrorActionPreference = 'Stop'
$procs = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match 'chrome|chromium|msedge|brave|opera|vivaldi|firefox|waterfox|iexplore'
} | Select-Object ProcessId, Name, CommandLine
ConvertTo-Json -Compress -InputObject @($procs)
`.trim();

  const { stdout } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
  );

  const parsed = parseJson(stdout);
  const arr = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return arr
    .filter((p: any) => p && p.ProcessId)
    .map((p: any) => ({ pid: Number(p.ProcessId), name: String(p.Name ?? ''), command: String(p.CommandLine ?? '') }))
    .filter((p) => Number.isFinite(p.pid));
}

async function listUnix(): Promise<RawProcess[]> {
  // `-ww` keeps long command lines intact on macOS.
  const { stdout } = await execFileAsync('ps', ['-ww', '-eo', 'pid=,comm=,args='], {
    maxBuffer: 32 * 1024 * 1024,
  });

  const out: RawProcess[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(\S+)\s+([\s\S]*)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isFinite(pid)) continue;
    out.push({ pid, name: match[2], command: match[3] });
  }
  return out;
}

function toBrowserProcessInfo(raw: RawProcess): BrowserProcessInfo {
  const familyMatch = DISPLAY_BY_NAME.find((d) => d.test.test(raw.name));
  const display = familyMatch?.display ?? raw.name;
  const family = familyMatch?.family ?? 'unknown';
  const debuggingPort = parseDebuggingPort(raw.command);
  const debuggingPipe = /--remote-debugging-pipe/i.test(raw.command);
  const userDataDir = /--user-data-dir(?:=|\s+)("?)([^"\s]+)\1/i.exec(raw.command)?.[2];

  let attachable = false;
  let reason: string | undefined;
  if (family !== 'chromium') {
    reason = `${display} does not speak the Chrome DevTools Protocol`;
  } else if (debuggingPipe) {
    reason = 'Uses --remote-debugging-pipe, which is not reachable over TCP';
  } else if (!debuggingPort) {
    reason = 'No --remote-debugging-port; use browser_launch to start an attachable instance';
  } else {
    attachable = true;
  }

  return {
    pid: raw.pid,
    process: raw.name,
    display,
    family,
    commandLine: truncate(raw.command, 4000),
    debuggingPort,
    debuggingPipe,
    userDataDir,
    attachable,
    reason,
  };
}

function parseDebuggingPort(command: string): number | undefined {
  const eq = /--remote-debugging-port(?:=|\s+)(\d{1,5})/i.exec(command);
  if (eq) {
    const port = Number(eq[1]);
    if (port > 0 && port < 65536) return port;
  }
  return undefined;
}

function parseJson(text: string): any {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // PowerShell sometimes prefixes the payload with progress output; take the last JSON value.
    const start = trimmed.search(/[[{]/);
    if (start > 0) {
      try {
        return JSON.parse(trimmed.slice(start));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}… (truncated)` : value;
}
