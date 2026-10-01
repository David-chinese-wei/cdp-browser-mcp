import type { DiscoveredBrowser } from '../types.js';

export interface HttpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** Probe a single host:port for a DevTools HTTP endpoint. */
export async function probePort(
  port: number,
  host = '127.0.0.1',
  timeoutMs = 700,
): Promise<DiscoveredBrowser | null> {
  const version = await getJson<Record<string, any>>(`http://${host}:${port}/json/version`, timeoutMs);
  if (!version || typeof version['Browser'] !== 'string') return null;

  const targets = await getJson<HttpTarget[]>(`http://${host}:${port}/json/list`, timeoutMs);

  return {
    port,
    host,
    browser: String(version['Browser']),
    protocolVersion: String(version['Protocol-Version'] ?? ''),
    webSocketDebuggerUrl: String(version['webSocketDebuggerUrl'] ?? ''),
    userAgent: typeof version['User-Agent'] === 'string' ? version['User-Agent'] : undefined,
    targets: Array.isArray(targets) ? targets.filter((t) => t.type === 'page').length : 0,
  };
}

/** Scan a port range (plus any extra ports) for running DevTools endpoints. */
export async function discoverBrowsers(
  options: { host?: string; from?: number; to?: number; ports?: number[]; concurrency?: number } = {},
): Promise<DiscoveredBrowser[]> {
  const host = options.host ?? '127.0.0.1';
  const from = options.from ?? 9222;
  const to = options.to ?? 9400;
  const extra = options.ports ?? [];
  const ports = Array.from(new Set([...extra, ...range(from, to)]));
  const concurrency = Math.max(1, options.concurrency ?? 12);

  const found: DiscoveredBrowser[] = [];
  for (let i = 0; i < ports.length; i += concurrency) {
    const batch = ports.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((p) => probePort(p, host)));
    for (const r of results) if (r) found.push(r);
  }
  return found.sort((a, b) => a.port - b.port);
}

/** Browser level WebSocket URL, e.g. ws://127.0.0.1:9222/devtools/browser/<id>. */
export async function getBrowserWebSocketUrl(port: number, host = '127.0.0.1'): Promise<string> {
  const version = await getJson<Record<string, any>>(`http://${host}:${port}/json/version`, 3000);
  const url = version?.['webSocketDebuggerUrl'];
  if (typeof url !== 'string' || !url) {
    throw new Error(`No DevTools endpoint on ${host}:${port}`);
  }
  return url;
}

export async function listHttpTargets(port: number, host = '127.0.0.1'): Promise<HttpTarget[]> {
  const targets = await getJson<HttpTarget[]>(`http://${host}:${port}/json/list`, 3000);
  return Array.isArray(targets) ? targets : [];
}

export async function activateHttpTarget(port: number, id: string, host = '127.0.0.1'): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/json/activate/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function getJson<T>(url: string, timeoutMs: number): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let p = from; p <= to; p++) out.push(p);
  return out;
}
