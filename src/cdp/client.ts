import WebSocket from 'ws';

export interface CDPCommandOptions {
  /** Target session id, when the command targets a page instead of the browser. */
  sessionId?: string;
  /** Per-command timeout. Defaults to 15s. */
  timeoutMs?: number;
}

export interface CDPRawEvent {
  method: string;
  params: any;
  sessionId?: string;
}

export type CDPListener = (event: CDPRawEvent) => void;

export interface CDPTargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  attached?: boolean;
  canAccessOpener?: boolean;
  browserContextId?: string;
}

/**
 * Recent Chrome builds report targets with `targetId`; older ones used `id`.
 * Normalising here keeps every caller on a single field name.
 */
export function normalizeTarget(raw: any): CDPTargetInfo {
  return {
    id: String(raw?.targetId ?? raw?.id ?? ''),
    type: String(raw?.type ?? ''),
    title: String(raw?.title ?? ''),
    url: String(raw?.url ?? ''),
    webSocketDebuggerUrl: typeof raw?.webSocketDebuggerUrl === 'string' ? raw.webSocketDebuggerUrl : undefined,
    attached: Boolean(raw?.attached),
    canAccessOpener: Boolean(raw?.canAccessOpener),
    browserContextId: typeof raw?.browserContextId === 'string' ? raw.browserContextId : undefined,
  };
}

/**
 * Minimal Chrome DevTools Protocol client over a single browser-level WebSocket.
 *
 * Page level commands are multiplexed with `Target.attachToTarget({flatten:true})`,
 * so one socket serves every tab instead of opening a connection per target.
 */
export class CDPClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; method: string }
  >();
  private readonly listeners = new Map<string, Set<CDPListener>>();
  private readonly wildcard = new Set<CDPListener>();

  constructor(readonly url: string) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(timeoutMs = 10_000): Promise<void> {
    if (this.connected) return;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`Timed out connecting to ${this.url}`));
      }, timeoutMs);

      ws.once('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to connect to ${this.url}: ${err.message}`));
      });
      ws.on('message', (raw) => this.handleMessage(raw.toString()));
      ws.on('close', () => this.handleClose());
    });
  }

  private handleMessage(payload: string): void {
    let msg: any;
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        const detail = msg.error.data ? ` (${msg.error.data})` : '';
        entry.reject(new Error(`CDP ${entry.method} failed: ${msg.error.message}${detail}`));
      } else {
        entry.resolve(msg.result ?? {});
      }
      return;
    }
    if (typeof msg.method === 'string') {
      const event: CDPRawEvent = { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId };
      for (const l of this.wildcard) safeCall(l, event);
      const set = this.listeners.get(msg.method);
      if (set) for (const l of [...set]) safeCall(l, event);
    }
  }

  private handleClose(): void {
    this.ws = null;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('CDP connection closed'));
    }
    this.pending.clear();
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, opts: CDPCommandOptions = {}): Promise<T> {
    if (!this.connected) return Promise.reject(new Error('CDP client is not connected'));
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (opts.sessionId) payload.sessionId = opts.sessionId;
    const timeoutMs = opts.timeoutMs ?? 15_000;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws!.send(JSON.stringify(payload), (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new Error(`CDP ${method} send failed: ${err.message}`));
        }
      });
    });
  }

  /** Subscribe to a specific CDP event. Returns an unsubscribe function. */
  on(method: string, listener: CDPListener): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  /** Subscribe to every CDP event. Returns an unsubscribe function. */
  onAny(listener: CDPListener): () => void {
    this.wildcard.add(listener);
    return () => this.wildcard.delete(listener);
  }

  /** Open a flattened session against a page target. */
  async attachToTarget(targetId: string): Promise<string> {
    const res = await this.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    return res.sessionId;
  }

  async detachFromTarget(sessionId: string): Promise<void> {
    try {
      await this.send('Target.detachFromTarget', { sessionId });
    } catch {
      /* target may already be gone */
    }
  }

  async getVersion(): Promise<Record<string, any>> {
    return this.send('Browser.getVersion');
  }

  async getTargets(): Promise<CDPTargetInfo[]> {
    const res = await this.send<{ targetInfos: CDPTargetInfo[] }>('Target.getTargets', { filter: [{ type: 'page' }] });
    return (res.targetInfos ?? []).map(normalizeTarget).filter((t) => t.id);
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.ws = null;
  }
}

function safeCall(fn: CDPListener, event: CDPRawEvent): void {
  try {
    fn(event);
  } catch (err) {
    // A throwing listener must never tear down the message loop.
    console.error(`[cdp] listener error on ${event.method}:`, err);
  }
}
