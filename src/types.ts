/** Shared data shapes used by the collector, exporters and MCP tools. */

export type BrowserFamily = 'chromium' | 'firefox' | 'safari' | 'unknown';

export interface BrowserProcessInfo {
  pid: number;
  /** OS level process name, e.g. `chrome.exe`. */
  process: string;
  /** Human friendly product name, e.g. `Google Chrome`. */
  display: string;
  family: BrowserFamily;
  commandLine: string;
  /** Parsed from `--remote-debugging-port=`. */
  debuggingPort?: number;
  /** Parsed from `--remote-debugging-pipe` (not reachable over a TCP port). */
  debuggingPipe: boolean;
  userDataDir?: string;
  /** Only chromium browsers exposing a TCP debugging port can be attached to. */
  attachable: boolean;
  /** Why the process cannot be attached to, when applicable. */
  reason?: string;
}

export interface DiscoveredBrowser {
  port: number;
  host: string;
  browser: string;
  protocolVersion: string;
  webSocketDebuggerUrl: string;
  userAgent?: string;
  targets: number;
}

export type ConsoleLevel =
  | 'log'
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'
  | 'verbose'
  | 'trace'
  | 'dirxml'
  | 'table'
  | 'exception'
  | 'unknown';

export interface ConsoleEntry {
  id: string;
  seq: number;
  /** Wall clock capture time, epoch milliseconds. */
  time: number;
  level: ConsoleLevel;
  source: 'console' | 'exception' | 'log' | 'deprecation' | 'violation' | 'other';
  text: string;
  url?: string;
  line?: number;
  column?: number;
  stack?: string;
  /** Best effort preview of the original arguments. */
  args?: unknown[];
  targetId?: string;
  targetTitle?: string;
}

export interface NetworkEntry {
  id: string;
  seq: number;
  /** Wall clock capture time, epoch milliseconds. */
  time: number;
  url: string;
  method: string;
  /** CDP resource type: document, script, xhr, fetch, ... */
  type?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string;
  /** Wall clock of the first byte of the response, when known. */
  responseTime?: number;
  /** Response completion time; used to compute duration. */
  endTime?: number;
  durationMs?: number;
  timing?: Record<string, number>;
  encodedDataLength?: number;
  decodedBodyLength?: number;
  fromCache?: boolean;
  fromServiceWorker?: boolean;
  failed?: boolean;
  errorText?: string;
  initiator?: unknown;
  redirectUrl?: string;
  remoteAddress?: string;
  protocol?: string;
  securityState?: string;
  finished: boolean;
  targetId?: string;
  targetTitle?: string;
  /**
   * CDP monotonic timestamps, used to compute `durationMs`.
   * Internal only: never written to the exported files.
   */
  _cdpStart?: number;
  _cdpEnd?: number;
}

/**
 * One entry of the resource tree, i.e. exactly what devtools' Sources > Page pane
 * shows for a frame: every resource the frame loaded (documents, stylesheets,
 * scripts, images, fonts, media, ...).
 */
export interface PageResource {
  url: string;
  type: string;
  mimeType: string;
  /** Present when the same URL was also seen on the network layer. */
  requestId?: string;
  status?: number;
  size?: number;
}

/** A node of the frame tree, mirroring devtools' Sources > Page hierarchy. */
export interface ResourceTreeNode {
  id: string;
  url: string;
  /** Human readable frame label: 'top' for the main frame. */
  name: string;
  mimeType: string;
  securityOrigin?: string;
  unreachableUrl?: string;
  resources: PageResource[];
  childFrames?: ResourceTreeNode[];
}

export interface ResourceTreeSnapshot {
  frame?: ResourceTreeNode;
  resourceCount?: number;
  frameCount?: number;
}

export interface PageErrorEntry {
  id: string;
  time: number;
  text: string;
  url?: string;
  line?: number;
  column?: number;
  stack?: string;
  source: 'exception' | 'console' | 'log' | 'crash';
}

export interface DomSnapshot {
  targetId: string;
  title: string;
  url: string;
  capturedAt: number;
  html?: string;
  /** Flattened, trimmed DOM outline for quick reading by an LLM. */
  outline?: string;
  nodeCount?: number;
  truncated?: boolean;
}

export interface ScreenshotEntry {
  targetId: string;
  time: number;
  encoding: 'base64';
  format: 'png' | 'jpeg' | 'webp';
  mimeType: string;
  width?: number;
  height?: number;
  data: string;
}

export interface PerformanceSnapshot {
  time: number;
  /** CDP Performance.getMetrics, keyed by name. */
  metrics: Record<string, number>;
  /** Navigation timing from `performance.timing` when available. */
  navigation?: Record<string, number>;
  /** Largest Contentful Paint and friends, when available. */
  paintTimings?: Record<string, number>;
  memory?: { usedJSHeapSize: number; totalJSHeapSize: number; limit?: number };
}

export interface StorageSnapshot {
  targetId: string;
  url: string;
  time: number;
  cookies: Array<Record<string, unknown>>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  indexedDb: string[];
  errors?: string[];
}

export interface CaptureSessionMeta {
  sessionId: string;
  /** Product string, e.g. `Edg/139.0.3405.86` or `Chrome/127.0.6533.72`. */
  browser?: string;
  /** Version part of the product string, e.g. `139.0.3405.86`. */
  browserVersion?: string;
  /** Full renderer user agent, useful when archiving a capture. */
  browserUserAgent?: string;
  /** DevTools protocol revision reported by the browser, e.g. `1.3`. */
  protocolVersion?: string;
  host: string;
  port?: number;
  startedAt: number;
  targetId?: string;
  targetTitle?: string;
  targetUrl?: string;
}

export interface CapturedData {
  meta: CaptureSessionMeta;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  errors: PageErrorEntry[];
  dom?: DomSnapshot;
  screenshot?: ScreenshotEntry;
  performance?: PerformanceSnapshot;
  storage?: StorageSnapshot;
}

export interface SavedCaptureFile {
  path: string;
  bytes: number;
  description: string;
}

export interface SavedCapture {
  /** Absolute path of the capture directory. */
  dir: string;
  files: SavedCaptureFile[];
  manifestPath: string;
  counts: {
    console: number;
    network: number;
    errors: number;
  };
}
