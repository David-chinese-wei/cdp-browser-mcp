import type { CapturedData, NetworkEntry } from '../types.js';

export interface HarLike {
  log: {
    version: string;
    creator: { name: string; version: string };
    browser?: { name: string; version: string };
    pages: HarPage[];
    entries: HarEntry[];
  };
}

export interface HarPage {
  startedDateTime: string;
  id: string;
  title: string;
  pageTimings: { onContentLoad?: number; onLoad?: number };
}

export interface HarEntry {
  pageref?: string;
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: Record<string, unknown>;
  timings: HarTimings;
  serverIPAddress?: string;
  connection?: string;
  comment?: string;
}

export interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  cookies: HarCookie[];
  headers: HarHeader[];
  queryString: HarQuery[];
  postData?: { mimeType: string; text: string };
  headersSize: number;
  bodySize: number;
}

export interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  cookies: HarCookie[];
  headers: HarHeader[];
  content: { size: number; mimeType: string; text?: string };
  redirectURL: string;
  headersSize: number;
  bodySize: number;
  _transferSize?: number;
}

export interface HarTimings {
  blocked: number;
  dns: number;
  connect: number;
  send: number;
  wait: number;
  receive: number;
  ssl: number;
}

export interface HarCookie {
  name: string;
  value: string;
}

export interface HarHeader {
  name: string;
  value: string;
}

export interface HarQuery {
  name: string;
  value: string;
}

const PAGE_ID = 'page_1';

/**
 * Convert captured network traffic to HAR 1.2.
 *
 * Response bodies are not part of this mapping: they are only available through
 * `network_body`, which must opt in per request.
 */
export function buildHar(data: CapturedData, version = '0.1.0'): HarLike {
  const entries = data.network.map(toHarEntry);

  return {
    log: {
      version: '1.2',
      creator: { name: 'browser-devtools-mcp', version },
      browser: data.meta.browser
        ? { name: data.meta.browser, version: data.meta.browserVersion ?? '' }
        : undefined,
      pages: [
        {
          startedDateTime: new Date(data.meta.startedAt).toISOString(),
          id: PAGE_ID,
          title: data.meta.targetTitle ?? data.meta.targetUrl ?? 'captured page',
          pageTimings: extractPageTimings(data),
        },
      ],
      entries,
    },
  };
}

export function harToString(data: CapturedData, version?: string): string {
  return `${JSON.stringify(buildHar(data, version), null, 2)}\n`;
}

function toHarEntry(entry: NetworkEntry): HarEntry {
  const httpVersion = normalizeHttpVersion(entry.protocol);
  const url = urlOrNull(entry.url);

  const request: HarRequest = {
    method: entry.method,
    url: entry.url,
    httpVersion,
    cookies: parseCookies(headersValue(entry.requestHeaders, 'cookie')),
    headers: toHarHeaders(entry.requestHeaders),
    queryString: url ? [...url.searchParams.entries()].map(([name, value]) => ({ name, value })) : [],
    headersSize: -1,
    bodySize: entry.postData ? Buffer.byteLength(entry.postData, 'utf8') : 0,
  };

  if (entry.postData) {
    request.postData = {
      mimeType: headersValue(entry.requestHeaders, 'content-type') ?? 'application/octet-stream',
      text: entry.postData,
    };
  }

  const responseContentType = headersValue(entry.responseHeaders, 'content-type') ?? entry.mimeType ?? '';

  const response: HarResponse = {
    status: entry.status ?? 0,
    statusText: entry.statusText ?? '',
    httpVersion,
    cookies: parseCookies(headersValue(entry.responseHeaders, 'set-cookie')),
    headers: toHarHeaders(entry.responseHeaders),
    content: {
      size: typeof entry.decodedBodyLength === 'number' ? entry.decodedBodyLength : -1,
      mimeType: responseContentType,
    },
    redirectURL: entry.redirectUrl ?? '',
    headersSize: -1,
    bodySize:
      typeof entry.encodedDataLength === 'number' && entry.encodedDataLength > 0
        ? entry.encodedDataLength
        : -1,
  };
  if (typeof entry.encodedDataLength === 'number' && entry.encodedDataLength > 0) {
    response._transferSize = entry.encodedDataLength;
  }

  const harEntry: HarEntry = {
    startedDateTime: new Date(entry.time).toISOString(),
    time: Math.max(0, Math.round(entry.durationMs ?? 0)),
    request,
    response,
    cache: {},
    timings: toHarTimings(entry),
    pageref: PAGE_ID,
  };

  if (entry.remoteAddress) harEntry.serverIPAddress = entry.remoteAddress;
  if (entry.protocol) harEntry.connection = entry.protocol;
  if (entry.failed && entry.errorText) harEntry.comment = entry.errorText;

  return harEntry;
}

/**
 * CDP hands back absolute offsets in seconds relative to the request start,
 * with -1 meaning "this phase did not happen".
 */
function toHarTimings(entry: NetworkEntry): HarTimings {
  const t = (entry.timing ?? {}) as Record<string, number>;
  const isSet = (value: unknown): value is number => typeof value === 'number' && value >= 0;
  const span = (start: unknown, end: unknown): number => (isSet(start) && isSet(end) ? toMs(end - start) : 0);

  const dns = span(t['dnsStart'], t['dnsEnd']);
  const connect = span(t['connectStart'], t['connectEnd']);
  const ssl = span(t['sslStart'], t['sslEnd']);
  const send = span(t['sendStart'], t['sendEnd']);
  const proxy = span(t['proxyStart'], t['proxyEnd']);

  // Time before anything else happened is queue/stale-connection blocking.
  let blocked = 0;
  if (proxy > 0) blocked = proxy;
  else if (isSet(t['dnsStart'])) blocked = toMs(t['dnsStart']);
  else if (isSet(t['connectStart'])) blocked = toMs(t['connectStart']);

  const headersEnd = isSet(t['receiveHeadersEnd']) ? toMs(t['receiveHeadersEnd']) : 0;
  const total = Math.max(0, entry.durationMs ?? 0);
  const wait = headersEnd > send ? headersEnd - send : 0;
  const receive = Math.max(0, total - (blocked + dns + connect + send + wait + ssl));

  return { blocked, dns, connect, send, wait, receive, ssl };
}

function extractPageTimings(data: CapturedData): { onContentLoad?: number; onLoad?: number } {
  const nav = data.performance?.navigation as Record<string, number> | undefined;
  if (!nav) return {};
  const start = nav['startTime'] ?? nav['navigationStart'] ?? 0;
  const pick = (key: string): number | undefined => {
    const value = nav[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
    if (!start) return Math.round(value);
    const delta = value - start;
    return delta >= 0 ? Math.round(delta) : undefined;
  };
  return {
    onContentLoad: pick('domContentLoadedEventEnd'),
    onLoad: pick('loadEventEnd'),
  };
}

function toMs(seconds: number): number {
  return Math.max(0, Math.round(seconds * 1000 * 100) / 100);
}

function toHarHeaders(headers: Record<string, string> | undefined): HarHeader[] {
  if (!headers) return [];
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function headersValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function parseCookies(header: string | undefined): HarCookie[] {
  if (!header) return [];
  return header
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [pair] = part.split(';');
      const index = pair.indexOf('=');
      return index > 0
        ? { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim() }
        : { name: pair.trim(), value: '' };
    });
}

function normalizeHttpVersion(protocol?: string): string {
  if (!protocol) return 'http/1.1';
  const lower = protocol.toLowerCase();
  if (lower === 'h2' || lower === 'http2' || lower === 'http/2') return 'HTTP/2';
  if (lower === 'h3' || lower === 'http3' || lower === 'http/3') return 'HTTP/3';
  if (lower === 'http/0.9') return 'HTTP/0.9';
  if (lower === 'http/1.0') return 'HTTP/1.0';
  return 'HTTP/1.1';
}

function urlOrNull(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
