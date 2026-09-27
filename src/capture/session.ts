import { CDPClient, normalizeTarget, type CDPRawEvent } from '../cdp/client.js';
import { describeArgs, describeRemoteObject, previewArgs } from '../cdp/remote-object.js';
import { buildOutline, buildSnapshot, type DomOutlineOptions, type DomNode } from './dom.js';
import { CaptureStore, type LiveChannel, type LiveEvent, type StoreLimits } from './store.js';
import type {
  CapturedData,
  CaptureSessionMeta,
  ConsoleEntry,
  ConsoleLevel,
  DomSnapshot,
  NetworkEntry,
  PageErrorEntry,
  PerformanceSnapshot,
  ResourceTreeSnapshot,
  ResourceTreeNode,
  ScreenshotEntry,
  StorageSnapshot,
} from '../types.js';

export interface SessionTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  /** Flattened session id, present once the target is attached. */
  sessionId?: string;
  attached: boolean;
}

export interface SessionOptions {
  /** Browser level WebSocket, e.g. ws://127.0.0.1:9222/devtools/browser/<id>. */
  webSocketUrl: string;
  host?: string;
  port?: number;
  browser?: string;
  browserVersion?: string;
  /** Renderer user agent, only used to seed the metadata. */
  browserUserAgent?: string;
  /** Attach to the first suitable page automatically. Default true. */
  autoAttach?: boolean;
  timeoutMs?: number;
  storeLimits?: Partial<StoreLimits>;
  /** Keep adding domains to every page target that appears, not just the active one. */
  watchAllTargets?: boolean;
}

export interface EvaluateResult {
  value?: unknown;
  text: string;
  type?: string;
  subtype?: string;
  exception?: string;
}

export interface ScreencastOptions {
  format?: 'jpeg' | 'png';
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** Forward every nth frame; 1 keeps them all. */
  everyNthFrame?: number;
}

export interface ScreencastFrame {
  format: 'jpeg' | 'png';
  data: string;
  bytes: number;
  time: number;
  targetId?: string;
  metadata?: {
    offsetTop?: number;
    pageScaleFactor?: number;
    deviceWidth?: number;
    deviceHeight?: number;
    scrollOffsetX?: number;
    scrollOffsetY?: number;
    timestamp?: number;
  };
}

export interface NetworkBodyResult {
  body: string;
  base64Encoded: boolean;
  /** True when the body was not retained by the browser (usually because it was too large). */
  unavailable?: boolean;
}

const CONSOLE_LEVELS: Record<string, ConsoleLevel> = {
  log: 'log',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
  warning: 'warn',
  verbose: 'verbose',
  trace: 'trace',
  startGroup: 'log',
  startGroupCollapsed: 'log',
  endGroup: 'log',
  assert: 'error',
  table: 'table',
  dir: 'log',
  dirxml: 'dirxml',
  count: 'log',
  timeEnd: 'log',
};

let uid = 0;
function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${++uid}`;
}

/**
 * A live DevTools session bound to one browser endpoint.
 *
 * Every page target is multiplexed over the single browser WebSocket with
 * `Target.attachToTarget({flatten:true})`; events are routed back to the owning
 * target through the sessionId carried on each frame.
 */
export class DevToolsSession {
  readonly store: CaptureStore;
  readonly meta: CaptureSessionMeta;
  readonly warnings: string[] = [];

  private readonly client: CDPClient;
  private readonly targets = new Map<string, SessionTarget>();
  private readonly sessionToTarget = new Map<string, string>();
  private readonly unsubscribers: Array<() => void> = [];
  private activeTargetId: string | null = null;
  private closed = false;
  private readonly watchAllTargets: boolean;
  private metricsTimer: NodeJS.Timeout | null = null;
  private metricsInterval = 1000;
  private screencastOptions: ScreencastOptions | null = null;

  constructor(client: CDPClient, options: SessionOptions) {
    this.client = client;
    this.store = new CaptureStore(options.storeLimits);
    this.watchAllTargets = Boolean(options.watchAllTargets);
    this.meta = {
      sessionId: nextId('sess'),
      browser: options.browser,
      browserVersion: options.browserVersion,
      browserUserAgent: options.browserUserAgent,
      host: options.host ?? '127.0.0.1',
      port: options.port,
      startedAt: Date.now(),
    };
  }

  static async connect(options: SessionOptions): Promise<DevToolsSession> {
    const client = new CDPClient(options.webSocketUrl);
    await client.connect(options.timeoutMs ?? 10_000);
    const session = new DevToolsSession(client, options);
    await session.init(Boolean(options.autoAttach ?? true));
    return session;
  }

  get targetId(): string | null {
    return this.activeTargetId;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ---------------------------------------------------------------- lifecycle

  private async init(autoAttach: boolean): Promise<void> {
    try {
      const version = await this.client.getVersion();
      // Browser.getVersion speaks camelCase (product / protocolVersion / userAgent) while
      // the HTTP /json/version endpoint speaks PascalCase (Browser / Protocol-Version).
      // Accept both so a caller can seed the meta from either source.
      const product = String(version.product ?? version['Browser'] ?? '');
      const protocol = String(version.protocolVersion ?? version['Protocol-Version'] ?? '');
      const productVersion = product.split('/')[1] ?? '';
      // The product string is authoritative: callers sometimes pre-seed browserVersion
      // with the protocol revision, which is a different thing entirely.
      this.meta.browser = product || this.meta.browser || 'Chromium';
      this.meta.browserVersion = productVersion || this.meta.browserVersion || protocol;
      this.meta.protocolVersion = protocol || this.meta.protocolVersion;
      if (typeof version.userAgent === 'string') {
        this.meta.browserUserAgent = version.userAgent;
      }
    } catch (err) {
      this.warnings.push(`Browser.getVersion failed: ${(err as Error).message}`);
    }

    try {
      await this.client.send('Target.setDiscoverTargets', { discover: true });
    } catch (err) {
      this.warnings.push(`Target.setDiscoverTargets failed: ${(err as Error).message}`);
    }

    this.wireEvents();
    await this.listTargets();

    if (!autoAttach) return;
    let preferred = await this.pickInitialTarget();
    // Browsers whose only targets are their own packaged UI pages get a blank tab.
    if (!preferred) preferred = await this.createBlankTab();
    if (preferred) {
      await this.selectTarget(preferred.id);
    } else {
      this.warnings.push('No page target available to attach to yet');
    }
  }

  /**
   * Pick the page most likely to be interesting: a real http(s) document first,
   * then any other non-internal page.
   *
   * Internal pages must never be picked as a fallback. Vivaldi — and any other
   * Chromium shell that paints its own UI as a packaged app — starts with *only*
   * `chrome-extension://` targets and no ordinary tab. Attaching to one of those
   * hangs the session instead of capturing anything, so when no real tab exists we
   * return undefined and the caller opens one (`createBlankTab`).
   *
   * Newly started browsers need a moment before their first tab shows up, hence
   * the short polling loop.
   */
  private async pickInitialTarget(timeoutMs = 3000): Promise<SessionTarget | undefined> {
    const deadline = Date.now() + timeoutMs;
    let pages: SessionTarget[] = [];

    while (Date.now() < deadline) {
      pages = [...this.targets.values()].filter((t) => t.type === 'page');
      // Only a real (non-internal) page counts as "the browser is ready".
      if (pages.some((t) => !isInternalUrl(t.url))) break;
      await sleep(250);
      await this.listTargets().catch(() => undefined);
    }

    const real = pages.filter((t) => !isInternalUrl(t.url));
    if (!real.length) return undefined;
    return real.find((t) => /^https?:/i.test(t.url)) ?? real[0];
  }

  /**
   * Open a blank tab ourselves. Needed for browsers that expose no ordinary tab at
   * startup (see `pickInitialTarget`); without this there would be nothing safe to
   * attach to and every capture tool would fail.
   */
  private async createBlankTab(): Promise<SessionTarget | undefined> {
    try {
      const res = await this.client.send<{ targetId: string }>(
        'Target.createTarget',
        { url: 'about:blank' },
        { timeoutMs: 10_000 },
      );
      const id = res?.targetId;
      if (!id) return undefined;
      await this.listTargets();
      return this.targets.get(id);
    } catch (err) {
      this.warnings.push(`Target.createTarget failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Refresh the target list. Detached targets that disappeared are dropped. */
  async listTargets(): Promise<SessionTarget[]> {
    const res = await this.client.send<{ targetInfos: unknown[] }>('Target.getTargets', {});
    const infos = (res.targetInfos ?? []).map(normalizeTarget).filter((t) => t.id);

    for (const info of infos) {
      const existing = this.targets.get(info.id);
      if (existing) {
        existing.title = info.title;
        existing.url = info.url;
        existing.type = info.type;
      } else {
        this.targets.set(info.id, {
          id: info.id,
          type: info.type,
          title: info.title,
          url: info.url,
          attached: false,
        });
      }
    }

    const alive = new Set(infos.map((i) => i.id));
    for (const id of [...this.targets.keys()]) {
      if (!alive.has(id)) this.dropTarget(id);
    }

    return [...this.targets.values()];
  }

  async selectTarget(targetId: string): Promise<SessionTarget> {
    let target = this.targets.get(targetId);
    if (!target) {
      await this.listTargets();
      target = this.targets.get(targetId);
    }
    if (!target) throw new Error(`Unknown target ${targetId}`);

    if (!target.sessionId) {
      const sessionId = await this.client.attachToTarget(targetId);
      target.sessionId = sessionId;
      target.attached = true;
      this.sessionToTarget.set(sessionId, targetId);
      await this.enableForSession(sessionId);
    }

    this.activeTargetId = targetId;
    this.syncMeta(target);
    return target;
  }

  /** Detach from the active target and, optionally, pick another one. */
  async detachTarget(targetId?: string): Promise<boolean> {
    const id = targetId ?? this.activeTargetId;
    if (!id) return false;
    const target = this.targets.get(id);
    if (!target?.sessionId) return false;

    await this.client.detachFromTarget(target.sessionId);
    this.sessionToTarget.delete(target.sessionId);
    target.sessionId = undefined;
    target.attached = false;
    if (this.activeTargetId === id) {
      const next = [...this.targets.values()].find((t) => t.attached);
      this.activeTargetId = next?.id ?? null;
      if (next) this.syncMeta(next);
    }
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopMetricsSampling();
    if (this.screencastOptions) void this.stopScreencast().catch(() => undefined);
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.client.close();
  }

  private dropTarget(id: string): void {
    const target = this.targets.get(id);
    if (target?.sessionId) this.sessionToTarget.delete(target.sessionId);
    this.targets.delete(id);
    if (this.activeTargetId === id) {
      const next = [...this.targets.values()].find((t) => t.attached);
      this.activeTargetId = next?.id ?? null;
      if (next) this.syncMeta(next);
    }
  }

  private syncMeta(target: SessionTarget): void {
    this.meta.targetId = target.id;
    this.meta.targetTitle = target.title;
    this.meta.targetUrl = target.url;
  }

  private requireSession(): string {
    const target = this.activeTargetId ? this.targets.get(this.activeTargetId) : undefined;
    if (!target?.sessionId) {
      throw new Error('没有已附加的页面，请先调用 target_select（或用 browser_connect 连接）');
    }
    return target.sessionId;
  }

  private async enableForSession(sessionId: string): Promise<void> {
    // Every domain gets a short leash. Some browsers accept `Target.attachToTarget`
    // and then never answer a single session command — Vivaldi in headed mode does
    // exactly that. Without a timeout the caller hangs until its own request times
    // out, which looks like the whole MCP server is broken.
    const runtime = await this.enableDomain('Runtime', sessionId);
    await this.enableDomain('Log', sessionId);
    await this.enableDomain('Page', sessionId);
    await this.enableDomain('DOM', sessionId);
    await this.enableDomain('Performance', sessionId);
    try {
      await this.client.send(
        'Network.enable',
        { maxResourceBufferSize: 50 * 1024 * 1024, maxTotalBufferSize: 100 * 1024 * 1024 },
        { sessionId, timeoutMs: ENABLE_TIMEOUT_MS },
      );
    } catch (err) {
      this.warnings.push(`Network.enable failed: ${(err as Error).message}`);
    }
    if (!runtime) {
      throw new Error(
        '该标签页不响应 CDP 会话命令（Runtime.enable 超时）。浏览器本身连上了，但它的页面不接受调试指令 —— 例如 Vivaldi 在有头模式下就是这样，改用 headless 即可正常抓取。',
      );
    }
  }

  /** @returns whether the domain answered in time. */
  private async enableDomain(domain: string, sessionId: string): Promise<boolean> {
    try {
      await this.client.send(`${domain}.enable`, {}, { sessionId, timeoutMs: ENABLE_TIMEOUT_MS });
      return true;
    } catch (err) {
      this.warnings.push(`${domain}.enable failed: ${(err as Error).message}`);
      return false;
    }
  }

  // ------------------------------------------------------------------- events

  private wireEvents(): void {
    const methods = [
      'Runtime.consoleAPICalled',
      'Runtime.exceptionThrown',
      'Log.entryAdded',
      'Network.requestWillBeSent',
      'Network.requestServedFromCache',
      'Network.responseReceived',
      'Network.responseReceivedExtraInfo',
      'Network.requestWillBeSentExtraInfo',
      'Network.dataReceived',
      'Network.loadingFinished',
      'Network.loadingFailed',
      'Page.frameNavigated',
      'Target.targetInfoChanged',
      'Target.targetCreated',
      'Target.targetDestroyed',
      'Inspector.targetCrashed',
      'Page.screencastFrame',
    ];
    for (const method of methods) {
      this.unsubscribers.push(this.client.on(method, (event) => this.handleEvent(method, event)));
    }
  }

  private handleEvent(method: string, event: CDPRawEvent): void {
    const targetId = event.sessionId ? this.sessionToTarget.get(event.sessionId) : undefined;
    const target = targetId ? this.targets.get(targetId) : undefined;
    const params = event.params ?? {};

    try {
      switch (method) {
        case 'Runtime.consoleAPICalled':
          this.onConsoleApi(params, target);
          break;
        case 'Runtime.exceptionThrown':
          this.onException(params, target);
          break;
        case 'Log.entryAdded':
          this.onLogEntry(params, target);
          break;
        case 'Network.requestWillBeSent':
          this.onRequestWillBeSent(params, target);
          break;
        case 'Network.requestServedFromCache':
          this.update(params['requestId'], { fromCache: true }, target);
          break;
        case 'Network.responseReceived':
          this.onResponseReceived(params, target);
          break;
        case 'Network.responseReceivedExtraInfo':
          this.update(params['requestId'], { responseHeaders: flatHeaders(params['headers']) }, target);
          break;
        case 'Network.requestWillBeSentExtraInfo':
          this.update(params['requestId'], { requestHeaders: flatHeaders(params['headers']) }, target);
          break;
        case 'Network.dataReceived':
          this.onDataReceived(params, target);
          break;
        case 'Network.loadingFinished':
          this.onLoadingFinished(params, target);
          break;
        case 'Network.loadingFailed':
          this.onLoadingFailed(params, target);
          break;
        case 'Page.frameNavigated':
          this.onFrameNavigated(params, target);
          break;
        case 'Target.targetInfoChanged':
          this.onTargetInfoChanged(params);
          break;
        case 'Target.targetCreated':
          void this.onTargetCreated(params.targetInfo);
          break;
        case 'Target.targetDestroyed':
          this.onTargetDestroyed(String(params.targetId ?? ''));
          break;
        case 'Inspector.targetCrashed':
          this.addError(
            { id: nextId('err'), time: Date.now(), text: 'Renderer crashed', source: 'crash', url: target?.url },
            target,
          );
          this.emit('target', 'crashed', { reason: 'renderer' }, target);
          break;
        case 'Page.screencastFrame':
          this.onScreencastFrame(event, target);
          break;
        default:
          break;
      }
    } catch (err) {
      this.warnings.push(`处理 ${method} 事件失败: ${(err as Error).message}`);
    }
  }

  private onConsoleApi(params: any, target?: SessionTarget): void {
    const level = CONSOLE_LEVELS[String(params.type ?? 'log')] ?? 'unknown';
    const text = describeArgs(params.args) || String(params.type ?? '');
    const frame = params.stackTrace?.callFrames?.[0];

    const entry: Omit<ConsoleEntry, 'seq'> = {
      id: nextId('con'),
      time: Date.now(),
      level,
      source: 'console',
      text,
      url: frame?.url,
      line: frame?.lineNumber !== undefined ? frame.lineNumber + 1 : undefined,
      column: frame?.columnNumber !== undefined ? frame.columnNumber + 1 : undefined,
      stack: formatStack(params.stackTrace),
      args: previewArgs(params.args),
      targetId: target?.id,
      targetTitle: target?.title,
    };
    this.store.addConsole(entry);
  }

  private onException(params: any, target?: SessionTarget): void {
    const details = params.exceptionDetails ?? {};
    const exception = details.exception ?? {};
    const text =
      String(exception.description ?? exception.value ?? details.text ?? 'Uncaught exception').split('\n')[0];

    const entry: Omit<ConsoleEntry, 'seq'> = {
      id: nextId('con'),
      time: Date.now(),
      level: 'error',
      source: 'exception',
      text,
      url: details.url || undefined,
      line: details.lineNumber !== undefined ? details.lineNumber + 1 : undefined,
      column: details.columnNumber !== undefined ? details.columnNumber + 1 : undefined,
      stack: details.exception?.description ?? formatStack(details.stackTrace),
      args: previewArgs(exception.preview ? [exception] : undefined),
      targetId: target?.id,
      targetTitle: target?.title,
    };
    this.store.addConsole(entry);

    this.addError(
      {
        id: nextId('err'),
        time: Date.now(),
        text,
        url: details.url || undefined,
        line: details.lineNumber !== undefined ? details.lineNumber + 1 : undefined,
        column: details.columnNumber !== undefined ? details.columnNumber + 1 : undefined,
        stack: exception.description ?? formatStack(details.stackTrace),
        source: 'exception',
      },
      target,
    );
  }

  private onLogEntry(params: any, target?: SessionTarget): void {
    const entry = params.entry ?? {};
    const source = String(entry.source ?? 'other');
    // `console-api` / `javascript` are already covered by Runtime.consoleAPICalled.
    if (source === 'console-api' || source === 'javascript') return;

    const level = LOG_LEVELS[String(entry.level ?? 'info')] ?? 'log';
    const text = String(entry.text ?? '').trim() || describeArgs(entry.args);

    const mapped: Omit<ConsoleEntry, 'seq'> = {
      id: nextId('con'),
      time: Math.round(Number(entry.timestamp ?? Date.now())),
      level,
      source: mapLogSource(source),
      text,
      url: entry.url || undefined,
      line: entry.lineNumber !== undefined ? entry.lineNumber + 1 : undefined,
      stack: formatStack(entry.stackTrace),
      targetId: target?.id,
      targetTitle: target?.title,
    };
    this.store.addConsole(mapped);

    if (level === 'error') {
      this.addError(
        {
          id: nextId('err'),
          time: mapped.time,
          text,
          url: mapped.url,
          line: mapped.line,
          stack: mapped.stack,
          source: 'log',
        },
        target,
      );
    }
  }

  private onRequestWillBeSent(params: any, target?: SessionTarget): void {
    const request = params.request ?? {};
    const existing = this.store.getNetwork(String(params.requestId));
    // A redirect reuses the requestId; keep the original entry and record the hop.
    if (existing && params.redirectResponse) {
      const hop = this.update(String(params.requestId), { redirectUrl: String(request.url ?? '') }, target);
      this.emit('network', 'redirect', hop, target);
      return;
    }

    const patch: Partial<NetworkEntry> = {
      time: resolveWallTime(params.wallTime),
      url: String(request.url ?? ''),
      method: String(request.method ?? 'GET'),
      type: params.type ? String(params.type) : undefined,
      requestHeaders: flatHeaders(request.headers),
      postData: request.postData ? String(request.postData) : undefined,
      initiator: params.initiator,
      fromCache: false,
      finished: false,
      targetId: target?.id,
      targetTitle: target?.title,
      _cdpStart: Number(params.timestamp ?? 0),
    };
    const started = this.store.upsertNetwork(String(params.requestId), patch);
    this.emit('network', 'request', started, target);
  }

  private onResponseReceived(params: any, target?: SessionTarget): void {
    const response = params.response ?? {};
    const entry = this.update(
      String(params.requestId),
      {
        status: typeof response.status === 'number' ? response.status : undefined,
        statusText: response.statusText ? String(response.statusText) : undefined,
        mimeType: response.mimeType ? String(response.mimeType) : undefined,
        responseHeaders: flatHeaders(response.headers),
        type: params.type ? String(params.type) : undefined,
        protocol: response.protocol ? String(response.protocol) : undefined,
        securityState: response.securityState ? String(response.securityState) : undefined,
        remoteAddress: response.remoteIPAddress ? String(response.remoteIPAddress) : undefined,
        timing: response.timing ?? undefined,
        encodedDataLength:
          typeof response.encodedDataLength === 'number' ? response.encodedDataLength : undefined,
        fromCache: Boolean(response.fromDiskCache) || Boolean(response.fromPrefetchCache),
        fromServiceWorker: Boolean(response.fromServiceWorker),
        responseTime: resolveWallTime(params.wallTime),
        _cdpEnd: Number(params.timestamp ?? 0),
      },
      target,
    );
    this.emit('network', 'response', entry, target);
  }

  private onDataReceived(params: any, target?: SessionTarget): void {
    // `Network.dataReceived` arrives once per chunk, so `dataLength` must be summed
    // into whatever we already have. Assigning it through `update()` first would
    // overwrite the running total with the current chunk (and then double it below),
    // which silently doubled every exported size in the HAR and CSV.
    const entry = this.update(String(params.requestId), {}, target);
    const chunk = Number(params.dataLength ?? 0);
    if (Number.isFinite(chunk)) {
      entry.decodedBodyLength = (entry.decodedBodyLength ?? 0) + chunk;
    }
  }

  private onLoadingFinished(params: any, target?: SessionTarget): void {
    const end = Number(params.timestamp ?? 0);
    const entry = this.update(
      String(params.requestId),
      {
        finished: true,
        endTime: Date.now(),
        encodedDataLength:
          typeof params.encodedDataLength === 'number' ? params.encodedDataLength : undefined,
        _cdpEnd: end,
      },
      target,
    );
    entry.durationMs = computeDuration(entry._cdpStart, entry._cdpEnd);
    this.emit('network', 'finished', entry, target);
  }

  private onLoadingFailed(params: any, target?: SessionTarget): void {
    const end = Number(params.timestamp ?? 0);
    const entry = this.update(
      String(params.requestId),
      {
        failed: true,
        finished: true,
        errorText: String(params.errorText ?? 'failed'),
        endTime: Date.now(),
        _cdpEnd: end,
      },
      target,
    );
    entry.durationMs = computeDuration(entry._cdpStart, entry._cdpEnd);
    this.emit('network', 'failed', entry, target);
  }

  private onFrameNavigated(params: any, target?: SessionTarget): void {
    const frame = params.frame ?? {};
    // Nested frames must not overwrite the top level URL.
    if (frame.parentId) return;
    if (target && typeof frame.url === 'string') {
      target.url = frame.url;
      if (this.activeTargetId === target.id) this.meta.targetUrl = frame.url;
    }
    this.emit(
      'navigation',
      'frame',
      {
        url: String(frame.url ?? target?.url ?? ''),
        frameId: frame.id ? String(frame.id) : undefined,
        name: frame.name ? String(frame.name) : undefined,
        loaderId: frame.loaderId ? String(frame.loaderId) : undefined,
        mimeType: frame.mimeType ? String(frame.mimeType) : undefined,
        securityOrigin: frame.securityOrigin ? String(frame.securityOrigin) : undefined,
      },
      target,
    );
  }

  private onTargetInfoChanged(params: any): void {
    // The browser level event still uses `targetId`, hence the normalisation.
    const info = normalizeTarget(params.targetInfo);
    const target = this.targets.get(info.id);
    if (!target) return;
    if (typeof info.title === 'string') target.title = info.title;
    if (typeof info.url === 'string') target.url = info.url;
    if (this.activeTargetId === target.id) this.syncMeta(target);
  }

  private onTargetDestroyed(targetId: string): void {
    if (!targetId || !this.targets.has(targetId)) return;
    const target = this.targets.get(targetId);
    this.emit('target', 'destroyed', { id: targetId, title: target?.title, url: target?.url }, target);
    this.dropTarget(targetId);
  }

  /** A tab or window appeared while we were watching: record it, optionally arm it. */
  private async onTargetCreated(raw: unknown): Promise<void> {
    const info = normalizeTarget(raw);
    if (!info.id) return;

    const existing = this.targets.get(info.id);
    if (existing) {
      existing.title = info.title;
      existing.url = info.url;
      existing.type = info.type;
      return;
    }

    this.targets.set(info.id, {
      id: info.id,
      type: info.type,
      title: info.title,
      url: info.url,
      attached: false,
    });
    this.emit('target', 'created', {
      id: info.id,
      type: info.type,
      title: info.title,
      url: info.url,
    });

    if (this.watchAllTargets && info.type === 'page') {
      try {
        const sessionId = await this.client.attachToTarget(info.id);
        const target = this.targets.get(info.id);
        if (target) {
          target.sessionId = sessionId;
          target.attached = true;
        }
        this.sessionToTarget.set(sessionId, info.id);
        await this.enableForSession(sessionId);
      } catch (err) {
        this.warnings.push(`自动附加新标签页失败: ${(err as Error).message}`);
      }
    }
  }

  private onScreencastFrame(event: CDPRawEvent, target?: SessionTarget): void {
    const params = event.params ?? {};
    const data = String(params.data ?? '');
    // The renderer stops producing frames until the previous one is acked.
    if (event.sessionId) {
      void this.client.send('Page.screencastFrameAck', {}, { sessionId: event.sessionId }).catch(() => undefined);
    }

    const frame: ScreencastFrame = {
      format: (this.screencastOptions?.format ?? 'jpeg') as 'jpeg' | 'png',
      data,
      bytes: Math.ceil((data.length * 3) / 4),
      time: Date.now(),
      targetId: target?.id,
      metadata: params.metadata,
    };
    this.emit('frame', 'frame', frame, target);
    // Frames are fat; keep only the newest handful in the event ring.
    this.store.dropOlderThan('frame', 12);
  }

  private update(requestId: string, patch: Partial<NetworkEntry>, target?: SessionTarget): NetworkEntry {
    return this.store.upsertNetwork(requestId, {
      ...patch,
      targetId: patch.targetId ?? target?.id,
      targetTitle: patch.targetTitle ?? target?.title,
    });
  }

  private addError(entry: PageErrorEntry, target?: SessionTarget): void {
    if (target && !entry.url) entry.url = target.url;
    this.store.addError(entry);
  }

  // ----------------------------------------------------------------- commands

  async evaluate(
    expression: string,
    options: { awaitPromise?: boolean; returnByValue?: boolean; timeoutMs?: number } = {},
  ): Promise<EvaluateResult> {
    const sessionId = this.requireSession();
    const res = await this.client.send<{ result: any; exceptionDetails?: any }>(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: options.awaitPromise ?? true,
        returnByValue: options.returnByValue ?? true,
        includeCommandLineAPI: true,
        userGesture: true,
      },
      { sessionId, timeoutMs: options.timeoutMs ?? 30_000 },
    );

    if (res.exceptionDetails) {
      const details = res.exceptionDetails;
      const text = String(details.exception?.description ?? details.text ?? 'Evaluation failed');
      return { text, exception: text, type: 'error' };
    }

    const remote = res.result ?? {};
    return {
      value: 'value' in remote ? remote.value : undefined,
      text: describeRemoteObject(remote),
      type: remote.type,
      subtype: remote.subtype,
    };
  }

  async getDom(
    options: {
      mode?: 'html' | 'outline' | 'both';
      depth?: number;
      maxNodes?: number;
      maxTextLength?: number;
      skipHidden?: boolean;
      maxHtmlChars?: number;
    } = {},
  ): Promise<DomSnapshot> {
    const sessionId = this.requireSession();
    const target = this.targets.get(this.activeTargetId!)!;
    const mode = options.mode ?? 'both';

    let html: string | undefined;
    let outline: string | undefined;
    let nodeCount: number | undefined;
    let truncated = false;

    if (mode === 'html' || mode === 'both') {
      const doc = await this.client.send<{ root: DomNode }>('DOM.getDocument', { depth: -1 }, { sessionId });
      const outer = await this.client.send<{ outerHTML: string }>(
        'DOM.getOuterHTML',
        { nodeId: doc.root.nodeId },
        { sessionId },
      );
      html = String(outer.outerHTML ?? '');
    }

    if (mode === 'outline' || mode === 'both') {
      const outlineOptions: DomOutlineOptions = {
        depth: options.depth ?? 4,
        maxNodes: options.maxNodes ?? 800,
        maxTextLength: options.maxTextLength ?? 60,
        skipHidden: options.skipHidden ?? true,
      };
      const depth = outlineOptions.depth ?? 4;
      const doc = await this.client.send<{ root: DomNode }>(
        'DOM.getDocument',
        { depth: depth + 1 },
        { sessionId, timeoutMs: 20_000 },
      );
      const built = buildOutline(doc.root, outlineOptions);
      outline = built.outline;
      nodeCount = built.nodeCount;
      truncated = built.truncated;
    }

    return buildSnapshot({
      targetId: target.id,
      title: target.title,
      url: target.url,
      html,
      outline,
      nodeCount,
      truncated,
      maxHtmlChars: options.maxHtmlChars,
    });
  }

  async screenshot(
    options: { fullPage?: boolean; format?: 'png' | 'jpeg' | 'webp'; quality?: number } = {},
  ): Promise<ScreenshotEntry> {
    const sessionId = this.requireSession();
    const target = this.targets.get(this.activeTargetId!)!;
    const format = options.format ?? 'png';

    const params: Record<string, unknown> = { format, fromSurface: true };
    if (format !== 'png' && typeof options.quality === 'number') params.quality = options.quality;
    // `captureBeyondViewport` is deprecated on newer builds; retry without it when rejected.
    if (options.fullPage) params.captureBeyondViewport = true;

    let data: string;
    try {
      const res = await this.client.send<{ data: string }>('Page.captureScreenshot', params, {
        sessionId,
        timeoutMs: 30_000,
      });
      data = String(res.data ?? '');
    } catch (err) {
      if (!options.fullPage) throw err;
      this.warnings.push(`captureBeyondViewport 不被支持，退化为视口截图: ${(err as Error).message}`);
      const res = await this.client.send<{ data: string }>(
        'Page.captureScreenshot',
        { format, fromSurface: true },
        { sessionId, timeoutMs: 30_000 },
      );
      data = String(res.data ?? '');
    }

    const size = imageSize(data, format);
    return {
      targetId: target.id,
      time: Date.now(),
      encoding: 'base64',
      format,
      mimeType: `image/${format}`,
      width: size?.width,
      height: size?.height,
      data,
    };
  }

  async performance(): Promise<PerformanceSnapshot> {
    const sessionId = this.requireSession();
    const metrics: Record<string, number> = {};

    try {
      const res = await this.client.send<{ metrics: Array<{ name: string; value: number }> }>(
        'Performance.getMetrics',
        {},
        { sessionId },
      );
      for (const m of res.metrics ?? []) metrics[m.name] = m.value;
    } catch (err) {
      this.warnings.push(`Performance.getMetrics 失败: ${(err as Error).message}`);
    }

    const probe = await this.evaluate(
      `(() => {
        const nav = performance.getEntriesByType?.('navigation')?.[0];
        const timing = nav
          ? Object.fromEntries(Object.keys(nav.toJSON?.() ?? {}).map((k) => [k, nav[k]]).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)))
          : undefined;
        const paint = {};
        try {
          for (const e of performance.getEntriesByType('paint')) paint[e.name] = e.startTime;
        } catch {}
        const mem = performance.memory
          ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize, jsHeapSizeLimit: performance.memory.jsHeapSizeLimit }
          : undefined;
        return { navigation: timing, paintTimings: paint, memory: mem };
      })()`,
      { awaitPromise: false },
    );

    const payload = (probe.value ?? {}) as Record<string, any>;
    return {
      time: Date.now(),
      metrics,
      navigation: payload['navigation'] ?? undefined,
      paintTimings: payload['paintTimings'] ?? undefined,
      memory: payload['memory']
        ? {
            usedJSHeapSize: Number(payload['memory'].usedJSHeapSize ?? 0),
            totalJSHeapSize: Number(payload['memory'].totalJSHeapSize ?? 0),
            limit: payload['memory'].jsHeapSizeLimit ? Number(payload['memory'].jsHeapSizeLimit) : undefined,
          }
        : undefined,
    };
  }

  async storage(): Promise<StorageSnapshot> {
    const sessionId = this.requireSession();
    const target = this.targets.get(this.activeTargetId!)!;
    const errors: string[] = [];

    let cookies: Array<Record<string, unknown>> = [];
    try {
      const res = await this.client.send<{ cookies: Array<Record<string, unknown>> }>(
        'Network.getCookies',
        target.url && !isEmptyUrl(target.url) ? { urls: [target.url] } : {},
        { sessionId },
      );
      cookies = res.cookies ?? [];
    } catch (err) {
      errors.push(`读取 cookies 失败: ${(err as Error).message}`);
    }

    const probe = await this.evaluate(
      `(() => {
        const read = (store) => {
          try {
            const out = {};
            for (let i = 0; i < store.length; i++) {
              const key = store.key(i);
              if (key === null) continue;
              out[key] = store.getItem(key);
            }
            return out;
          } catch (e) {
            return { __error: String(e && e.message ? e.message : e) };
          }
        };
        const local = read(window.localStorage);
        const session = read(window.sessionStorage);
        let idb = [];
        try {
          if (typeof indexedDB !== 'undefined' && indexedDB.databases) {
            idb = (indexedDB.databases() || []).map((d) => d.name).filter(Boolean);
          }
        } catch {}
        return { local, session, idb: Array.isArray(idb) ? idb : [] };
      })()`,
      { awaitPromise: false },
    );

    const payload = (probe.value ?? {}) as Record<string, any>;
    const unwrap = (value: any): Record<string, string> => {
      if (!value || typeof value !== 'object') return {};
      if (typeof value.__error === 'string') {
        errors.push(value.__error);
        return {};
      }
      const out: Record<string, string> = {};
      for (const [key, item] of Object.entries(value)) out[key] = String(item ?? '');
      return out;
    };

    return {
      targetId: target.id,
      url: target.url,
      time: Date.now(),
      cookies,
      localStorage: unwrap(payload['local']),
      sessionStorage: unwrap(payload['session']),
      indexedDb: Array.isArray(payload['idb']) ? payload['idb'].map(String) : [],
      errors: errors.length ? errors : undefined,
    };
  }

  /**
   * The resource tree shown by devtools' Sources > Page pane: for each frame, every
   * resource it loaded. Backed by `Page.getResourceTree`, so it reflects what the
   * page actually has rather than only what the Network domain recorded (inline
   * stylesheets, media requested by CSS, cached resources, ...). Each resource is
   * cross-referenced with the network buffer when available so the caller also gets
   * the requestId to pass to `network_body`.
   */
  async resourceTree(): Promise<ResourceTreeSnapshot> {
    const sessionId = this.requireSession();
    const target = this.targets.get(this.activeTargetId!)!;
    const res = await this.client.send<{ frameTree?: RawResourceFrameNode }>(
      'Page.getResourceTree',
      {},
      { sessionId, timeoutMs: 20_000 },
    );
    const frame = normalizeResourceFrame(res.frameTree, target.url);
    if (!frame) return {};

    let resourceCount = 0;
    let frameCount = 0;
    const walk = (node: ResourceTreeNode): void => {
      frameCount++;
      const seen = this.networkByUrl(node.url);
      if (seen) node.resources.push({
        url: node.url,
        type: 'Document',
        mimeType: node.mimeType || 'text/html',
        requestId: seen.id,
        status: seen.status,
        size: seen.decodedBodyLength ?? seen.encodedDataLength,
      });
      for (const r of node.resources) {
        resourceCount++;
        const hit = this.networkByUrl(r.url);
        if (hit) {
          r.requestId = hit.id;
          r.status = hit.status;
          r.size = hit.decodedBodyLength ?? hit.encodedDataLength;
        }
      }
      for (const child of node.childFrames ?? []) walk(child);
    };
    walk(frame);

    return { frame, resourceCount, frameCount };
  }

  /** Most recent non-HEAD network entry for a URL, from the capture buffer. */
  private networkByUrl(url: string): NetworkEntry | undefined {
    if (!url) return undefined;
    const matches = this.store
      .listNetwork({ search: url, limit: 200 })
      .filter((e) => e.url === url && e.method !== 'HEAD');
    return matches.at(-1);
  }

  /**
   * Content of any resource in the Sources > Page tree, addressed by URL (rather
   * than by requestId), the way a developer clicks a file in devtools to read it.
   *
   * Tries the captured request first, then falls back to re-fetching through the
   * page. The fallback matters: several things make the network layer useless
   * here — `HEAD`-only probes (the page asks for a resource just to read its
   * size), media requested with `Range` headers, still-loading requests whose
   * partial `getResponseBody` would otherwise be passed off as the whole file,
   * and bodies the browser dropped for being too large. In devtools you would
   * still be able to see that file, so a "resource not retained" answer — or a
   * silently truncated one — would be a fidelity gap.
   */
  async resourceBody(
    url: string,
    options: { asBase64?: boolean } = {},
  ): Promise<
    NetworkBodyResult & {
      url: string;
      requestId?: string;
      mimeType?: string;
      status?: number;
      size?: number;
      source?: 'network' | 'page-fetch';
    }
  > {
    const hit = this.networkByUrl(url);
    if (hit) {
      const result = await this.networkBody(hit.id);
      if (!result.unavailable && result.body !== '' && bodyLooksComplete(result, hit)) {
        return {
          ...result,
          url,
          requestId: hit.id,
          mimeType: hit.mimeType,
          status: hit.status,
          size: hit.decodedBodyLength ?? hit.encodedDataLength,
          source: 'network',
        };
      }
    }

    const fresh = await this.fetchResourceInPage(url);
    if (!fresh) {
      return { body: '', base64Encoded: false, unavailable: true, url, requestId: hit?.id };
    }
    const mimeType = fresh.mimeType ?? hit?.mimeType;
    const wantBytes = options.asBase64 || !looksTextual(mimeType);
    return {
      body: wantBytes ? fresh.base64 : Buffer.from(fresh.base64, 'base64').toString('utf8'),
      base64Encoded: wantBytes,
      url,
      requestId: hit?.id,
      mimeType,
      status: fresh.status ?? hit?.status,
      size: Buffer.from(fresh.base64, 'base64').length,
      source: 'page-fetch',
    };
  }

  /**
   * Re-fetch a URL inside the page and hand back the raw bytes as base64.
   * `Response.arrayBuffer()` sidesteps the document decoder entirely, so the bytes
   * are exactly what the server sent regardless of any missing `charset`.
   */
  private async fetchResourceInPage(
    url: string,
  ): Promise<{ base64: string; mimeType?: string; status?: number } | null> {
    try {
      const res = await this.evaluate(
        `(async () => { try { const r = await fetch(${JSON.stringify(url)}, { cache: 'no-store' }); const buf = await r.arrayBuffer(); const u8 = new Uint8Array(buf); let bin = ''; for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]); return { status: r.status, mimeType: r.headers.get('content-type') || '', base64: btoa(bin) }; } catch { return null; } })()`,
        { awaitPromise: true, timeoutMs: 30_000 },
      );
      const payload = res?.value as { status?: number; mimeType?: string; base64?: string } | null;
      if (!payload?.base64) return null;
      return {
        base64: payload.base64,
        mimeType: payload.mimeType || undefined,
        status: payload.status,
      };
    } catch {
      return null; // navigating away, or the page forbids fetching this URL
    }
  }

  async networkBody(requestId: string): Promise<NetworkBodyResult> {
    const sessionId = this.requireSession();
    const entry = this.store.getNetwork(requestId);
    try {
      const res = await this.client.send<{ body: string; base64Encoded: boolean }>(
        'Network.getResponseBody',
        { requestId },
        { sessionId, timeoutMs: 20_000 },
      );
      let body = String(res.body ?? '');
      const base64Encoded = Boolean(res.base64Encoded);
      // Chromium decodes the response body with the charset declared by the server.
      // When a text resource is served without one (e.g. `text/plain`, no
      // `; charset=utf-8`), it falls back to the browser's locale default. On an
      // English-locale machine that is Latin-1/CP1252 (reversible byte-for-byte),
      // but on a Chinese-locale machine it can be GBK, which mangles the original
      // UTF-8 bytes non-reversibly. Recover the original text where possible.
      if (!base64Encoded) {
        const recovered = await this.recoverTextBody(body, entry);
        if (recovered !== null && recovered !== body) body = recovered;
      }
      return { body, base64Encoded };
    } catch (err) {
      const message = (err as Error).message;
      if (/not found|no resource|no data/i.test(message)) {
        return { body: '', base64Encoded: false, unavailable: true };
      }
      throw err;
    }
  }

  /**
   * Recovery for `Network.getResponseBody` text that Chromium decoded with the wrong
   * charset. Returns the original UTF-8 text when it can be reconstructed, else null
   * (caller keeps the raw body).
   *
   *  - If the server declared a charset, Chromium decoded with it — trust the body.
   *  - If the body is single-byte (no code unit above 0xff), try a reversible
   *    Windows-1252 / Latin-1 round-trip; a perfect round-trip proves the bytes.
   *  - Otherwise re-fetch the URL through the page: per the WHATWG Fetch spec
   *    `Response.text()` always UTF-8-decodes the bytes (charset-less text defaults
   *    to UTF-8 in `fetch`, unlike the document decoder), so this recovers text that
   *    the locale default (e.g. GBK on a Chinese Windows) irreversibly mangled.
   */
  private async recoverTextBody(body: string, entry?: NetworkEntry): Promise<string | null> {
    if (!body) return null;
    if (!looksTextual(entry?.mimeType)) return null;

    // (1) A declared charset means Chromium already used the right codec.
    if (/charset=/i.test(entry?.mimeType ?? '')) return null;

    // (2) Reversible single-byte locale default (Windows-1252 / Latin-1).
    let singleByte = true;
    for (let i = 0; i < body.length; i++) {
      if (body.charCodeAt(i) > 0xff) {
        singleByte = false;
        break;
      }
    }
    if (singleByte) {
      const bytes = Buffer.from(body, 'latin1');
      const decoded = bytes.toString('utf8');
      if (decoded.length && decoded !== body && Buffer.from(decoded, 'utf8').equals(bytes)) {
        return decoded;
      }
    }

    // (3) In-page re-fetch: raw bytes decoded as UTF-8 per the WHATWG spec.
    if (entry && entry.method === 'GET' && entry.url && sameOrigin(entry.url, this.meta.targetUrl)) {
      try {
        const res = await this.evaluate(
          `(async () => { try { const r = await fetch(${JSON.stringify(entry.url)}, { cache: 'no-store' }); if (!r.ok) return ''; const buf = await r.arrayBuffer(); const u8 = new Uint8Array(buf); let bin = ''; for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]); return btoa(bin); } catch { return ''; } })()`,
          { awaitPromise: true, timeoutMs: 15_000 },
        );
        const b64 = typeof res?.value === 'string' ? res.value : '';
        if (b64) {
          const text = Buffer.from(b64, 'base64').toString('utf8');
          if (text && text !== body) return text;
        }
      } catch {
        /* page mid-navigation or fetch blocked: keep the raw body */
      }
    }
    return null;
  }

  clear(): void {
    this.store.clear();
  }

  counts(): { console: number; network: number; errors: number } {
    return this.store.counts();
  }

  /** Full dump of everything captured, ready for the exporters. */
  snapshot(): CapturedData {
    const { console: consoleEntries, network, errors } = this.store.snapshot();
    return {
      meta: { ...this.meta },
      console: consoleEntries,
      network: network.map(stripInternalFields),
      errors,
    };
  }

  // -------------------------------------------------------------- live feed

  get metricsIntervalMs(): number | null {
    return this.metricsTimer ? this.metricsInterval : null;
  }

  get screencastActive(): boolean {
    return this.screencastOptions !== null;
  }

  get watchAllTargetsEnabled(): boolean {
    return this.watchAllTargets;
  }

  /**
   * Poll `Performance.getMetrics` on a timer so a consumer can watch a metric
   * move in real time instead of asking for a one shot snapshot.
   */
  async startMetricsSampling(intervalMs: number): Promise<number> {
    const interval = clampInterval(intervalMs);
    this.stopMetricsSampling();
    this.metricsInterval = interval;

    const tick = async (): Promise<void> => {
      if (this.closed) return;
      try {
        const sessionId = this.targets.get(this.activeTargetId ?? '')?.sessionId;
        if (!sessionId) return;
        const res = await this.client.send<{ metrics: Array<{ name: string; value: number }> }>(
          'Performance.getMetrics',
          {},
          { sessionId, timeoutMs: Math.max(1000, interval - 200) },
        );
        const metrics: Record<string, number> = {};
        for (const m of res.metrics ?? []) metrics[m.name] = m.value;
        const time = Date.now();
        this.emit('metric', 'sample', { time, metrics });
      } catch {
        /* page may be mid-navigation; the next tick will retry */
      }
    };

    this.metricsTimer = setInterval(() => void tick(), interval);
    this.metricsTimer.unref?.();
    await tick();
    return interval;
  }

  stopMetricsSampling(): void {
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    this.metricsTimer = null;
  }

  /** Continuously forward rendered frames (Page.startScreencast). */
  async startScreencast(options: ScreencastOptions = {}): Promise<ScreencastOptions> {
    const sessionId = this.requireSession();
    const config: ScreencastOptions = {
      format: options.format ?? 'jpeg',
      quality: options.quality ?? 60,
      maxWidth: options.maxWidth ?? 800,
      maxHeight: options.maxHeight ?? 600,
      everyNthFrame: options.everyNthFrame ?? 1,
    };

    await this.client.send(
      'Page.startScreencast',
      {
        format: config.format,
        quality: config.quality,
        maxWidth: config.maxWidth,
        maxHeight: config.maxHeight,
        everyNthFrame: config.everyNthFrame,
      },
      { sessionId },
    );

    this.screencastOptions = config;
    return config;
  }

  async stopScreencast(): Promise<boolean> {
    if (!this.screencastOptions) return false;
    this.screencastOptions = null;
    const sessionId = this.targets.get(this.activeTargetId ?? '')?.sessionId;
    if (!sessionId) return true;
    await this.client.send('Page.stopScreencast', {}, { sessionId }).catch(() => undefined);
    return true;
  }

  /** Publish one event on the live feed. */
  emit(
    channel: LiveChannel,
    kind: string,
    data: unknown,
    target?: { id?: string; title?: string },
  ): LiveEvent {
    return this.store.emit(channel, kind, data, target);
  }
}

const LOG_LEVELS: Record<string, ConsoleLevel> = {
  verbose: 'verbose',
  info: 'info',
  warning: 'warn',
  error: 'error',
};

/** Drop keys that only exist for internal duration maths. */
function stripInternalFields(entry: NetworkEntry): NetworkEntry {
  const { _cdpStart: _s, _cdpEnd: _e, ...rest } = entry;
  return rest;
}

function mapLogSource(source: string): ConsoleEntry['source'] {
  if (source === 'deprecation') return 'deprecation';
  if (source === 'violation' || source === 'intervention' || source === 'recommendation') return 'violation';
  return 'log';
}

function flatHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    out[key] = Array.isArray(value) ? value.join('\n') : String(value ?? '');
  }
  return Object.keys(out).length ? out : undefined;
}

function formatStack(stack: any): string | undefined {
  const frames: any[] = stack?.callFrames ?? [];
  if (!frames.length) return undefined;
  return frames
    .slice(0, 12)
    .map((f) => `    at ${f.functionName || '(anonymous)'} (${f.url ?? 'unknown'}:${(f.lineNumber ?? 0) + 1}:${(f.columnNumber ?? 0) + 1})`)
    .join('\n');
}

/**
 * CDP timestamps are monotonic seconds, so a duration is only meaningful as a
 * difference between two of them. Wall time, when present, is epoch seconds.
 */
function computeDuration(start?: number, end?: number): number | undefined {
  if (!start || !end || end < start) return undefined;
  return Math.round((end - start) * 1000 * 100) / 100;
}

function resolveWallTime(wallTime: unknown): number {
  return typeof wallTime === 'number' && Number.isFinite(wallTime) && wallTime > 0
    ? Math.round(wallTime * 1000)
    : Date.now();
}

/** How long a single `*.enable` may take before we treat the session as unusable. */
const ENABLE_TIMEOUT_MS = 5000;

function clampInterval(ms: number): number {
  const value = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 1000;
  return Math.min(Math.max(value, 200), 60_000);
}

/** Raw `Page.getResourceTree` frame payload (loosely typed CDP response). */
interface RawResourceFrameNode {
  frame?: { id?: string; url?: string; mimeType?: string; securityOrigin?: string; unreachableUrl?: string; name?: string };
  resources?: Array<{ url?: string; type?: string; mimeType?: string }>;
  childFrames?: RawResourceFrameNode[];
}

/** Pull a short label out of a frame URL, defaulting to 'top' for the main frame. */
function frameLabel(url: string, depth: number): string {
  if (depth === 0) return 'top';
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last || u.hostname;
  } catch {
    return url.slice(0, 60);
  }
}

/** Convert the raw CDP resource tree into the shape we expose to callers. */
function normalizeResourceFrame(
  node: RawResourceFrameNode | undefined,
  fallbackUrl: string,
  depth = 0,
): ResourceTreeNode | undefined {
  if (!node?.frame?.id) return undefined;
  const url = String(node.frame.url ?? fallbackUrl ?? '');
  const tree: ResourceTreeNode = {
    id: String(node.frame.id),
    url,
    name: frameLabel(url, depth),
    mimeType: String(node.frame.mimeType ?? ''),
    securityOrigin: node.frame.securityOrigin,
    unreachableUrl: node.frame.unreachableUrl,
    resources: (node.resources ?? [])
      .filter((r) => r.url)
      .map((r) => ({
        url: String(r.url),
        type: String(r.type ?? ''),
        mimeType: String(r.mimeType ?? ''),
      })),
  };
  const children = (node.childFrames ?? [])
    .map((child) => normalizeResourceFrame(child, fallbackUrl, depth + 1))
    .filter((c): c is ResourceTreeNode => Boolean(c));
  if (children.length) tree.childFrames = children;
  return tree;
}

/**
 * `Network.getResponseBody` returns whatever has streamed in so far, so reading a
 * still-loading request yields a half file that looks like a complete one — this
 * is what silently truncated `images/waves.png` during the Chrome run. Treat the
 * captured body as trustworthy only once the request has actually finished and
 * the number of bytes we can measure matches what arrived.
 *
 * Note: `decodedBodyLength` counts bytes received over the wire, so a compressed
 * (gzip/br) response legitimately reports fewer bytes than the decoded content.
 * That only ever makes us fall back to re-fetching, which is still correct — just
 * slower — so the check stays conservative.
 */
export function bodyLooksComplete(result: NetworkBodyResult, entry?: NetworkEntry): boolean {
  if (!result.body) return false;
  if (!entry) return true; // nothing to verify against; assume the caller knows
  if (entry.failed || !entry.finished) return false;
  const expected = entry.decodedBodyLength;
  if (typeof expected !== 'number' || expected <= 0) return true;
  const actual = result.base64Encoded
    ? Buffer.from(result.body, 'base64').length
    : Buffer.from(result.body, 'utf8').length;
  return actual >= expected - 1;
}

/** True for MIME types we should treat as decoded text rather than raw bytes. */
function looksTextual(mime?: string): boolean {
  if (!mime) return true; // unknown: rely on the round-trip / fetch fallback above
  return /^(text\/|application\/(json|xml|javascript|ecmascript|x-www-form-urlencoded|ld\+json))|xml|json|\+xml|\+json|javascript/i.test(
    mime,
  );
}

/** Whether two URLs share an origin (used to gate the in-page fetch fallback). */
function sameOrigin(a: string, b?: string): boolean {
  try {
    const oa = new URL(a).origin;
    if (!b) return true; // no context to compare; let the fetch guard handle it
    return oa === new URL(b).origin;
  } catch {
    return false;
  }
}

function isInternalUrl(url: string): boolean {
  return !url || /^(devtools|chrome|edge|brave|opera|vivaldi|chrome-extension|moz-extension|about):/i.test(url);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isEmptyUrl(url: string): boolean {
  return !url || url === 'about:blank';
}

function imageSize(base64: string, format: string): { width: number; height: number } | undefined {
  if (!base64) return undefined;
  try {
    const buffer = Buffer.from(base64, 'base64');
    if (format === 'png' && buffer.length > 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (format === 'jpeg') {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset++;
          continue;
        }
        const marker = buffer[offset + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + buffer.readUInt16BE(offset + 2);
      }
    }
  } catch {
    /* ignore malformed payloads */
  }
  return undefined;
}
