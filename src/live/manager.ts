import type { DevToolsSession, ScreencastOptions } from '../capture/session.js';
import { LIVE_CHANNELS, type LiveChannel, type LiveEvent } from '../capture/store.js';
import type { ConsoleLevel } from '../types.js';

export type PushMode = 'none' | 'notification' | 'logging';

export interface SubscriptionFilters {
  channels?: LiveChannel[];
  /** Substring match against console text / request URL / frame-less payloads. */
  search?: string;
  level?: ConsoleLevel[];
  targetId?: string;
  /** Only errors and exceptions. */
  errorsOnly?: boolean;
}

export interface SubscriptionOptions extends SubscriptionFilters {
  /** Buffered events kept per subscription, even if nobody reads them. */
  buffer?: number;
  push?: PushMode;
  /** Unsubscribe automatically after this many matched events. */
  maxEvents?: number;
  /** Unsubscribe automatically after this long. */
  maxDurationMs?: number;
  /** Poll Performance.getMetrics every N ms. */
  performanceSampleMs?: number;
  /** Forward rendered frames; `true` uses sensible defaults. */
  frames?: ScreencastOptions | true;
  /** Internal subscriptions (the disk recorder) stay out of `events_list`. */
  hidden?: boolean;
}

export interface Subscription {
  id: string;
  createdAt: number;
  options: SubscriptionOptions;
  channels: Set<LiveChannel>;
  buffer: LiveEvent[];
  /** Newest cursor already handed to the push handler. */
  pushedCursor: number;
  matched: number;
  lastEventAt?: number;
  expiresAt?: number;
  closedAt?: number;
  closeReason?: string;
  active: boolean;
  hidden?: boolean;
}

export interface ReadOptions {
  /** Start after this cursor instead of the subscription position. */
  cursor?: number;
  limit?: number;
  includeFrameData?: boolean;
}

export interface ReadResult {
  subscriptionId: string;
  active: boolean;
  /** Cursor to pass on the next call. */
  cursor: number;
  count: number;
  totalMatched: number;
  dropped: number;
  events: Array<Record<string, unknown>>;
}

export interface WaitResult extends ReadResult {
  waitedMs: number;
  timedOut: boolean;
}

export type PushHandler = (subscription: Subscription, events: LiveEvent[]) => void | Promise<void>;
export type RawListener = (event: LiveEvent) => void;

const ALL_CHANNELS: LiveChannel[] = [...LIVE_CHANNELS];
const DEFAULT_BUFFER = 500;
const FRAME_BUFFER = 40;
const MAX_FRAME_EVENTS_PER_READ = 12;

let subSeq = 0;

/**
 * Turns the session's live event feed into something a client can consume
 * incrementally: a filter plus a per-subscription buffer, a cursor to resume
 * from, and an optional push towards whoever is listening on the transport.
 *
 * Buffering is the important half: even if the client never reads anything, up
 * to `buffer` events stay available, so polling loses nothing.
 */
export class LiveManager {
  readonly subscriptions = new Map<string, Subscription>();

  /** Set by the server layer to actually ship events towards the client. */
  pushHandler: PushHandler | null = null;

  private session: DevToolsSession | null = null;
  private detachListener: (() => void) | null = null;
  private readonly rawListeners = new Set<RawListener>();
  private readonly waiters = new Map<string, Array<{ min: number; cursor: number; finish: () => void }>>();
  private readonly pushTimers = new Map<string, NodeJS.Timeout>();

  // ------------------------------------------------------------------ source

  attach(session: DevToolsSession | null): void {
    this.detach();
    this.session = session;
    if (!session) return;
    this.detachListener = session.store.onEvent((event) => this.route(event));
    void this.syncFeatures();
  }

  detach(): void {
    if (this.detachListener) this.detachListener();
    this.detachListener = null;
    this.session = null;
    this.wakeAll();
  }

  get activeSession(): DevToolsSession | null {
    return this.session;
  }

  /** Listen to every event, regardless of subscriptions (used by the recorder). */
  onRawEvent(listener: RawListener): () => void {
    this.rawListeners.add(listener);
    return () => {
      this.rawListeners.delete(listener);
    };
  }

  // ------------------------------------------------------------ subscription

  async subscribe(options: SubscriptionOptions = {}, meta: { hidden?: boolean } = {}): Promise<Subscription> {
    const channels = normalizeChannels(options.channels);
    const wantsFrames = Boolean(options.frames);
    // buffer: 0 means "push only, do not retain" (used by the disk recorder).
    const bufferSize = options.buffer === undefined ? (wantsFrames ? FRAME_BUFFER : DEFAULT_BUFFER) : options.buffer;

    const subscription: Subscription = {
      id: `sub-${Date.now().toString(36)}-${++subSeq}`,
      createdAt: Date.now(),
      options: { ...options, channels, buffer: bufferSize },
      channels: new Set(channels),
      buffer: [],
      pushedCursor: this.session?.store.liveCursor ?? 0,
      matched: 0,
      active: true,
      hidden: meta.hidden,
    };

    if (options.maxDurationMs && options.maxDurationMs > 0) {
      subscription.expiresAt = subscription.createdAt + options.maxDurationMs;
    }

    this.subscriptions.set(subscription.id, subscription);
    if (this.session) subscription.pushedCursor = this.session.store.liveCursor;
    await this.syncFeatures();
    return subscription;
  }

  unsubscribe(id: string): { id: string; reason?: string } | null {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return null;
    const open = subscription.active;
    subscription.active = false;
    subscription.closedAt = Date.now();
    if (open) subscription.closeReason = 'unsubscribed';
    this.wake(id);
    void this.syncFeatures();
    return { id, reason: subscription.closeReason };
  }

  closeAll(reason = 'closed'): number {
    let n = 0;
    for (const subscription of this.subscriptions.values()) {
      if (!subscription.active) continue;
      subscription.active = false;
      subscription.closedAt = Date.now();
      subscription.closeReason = reason;
      this.wake(subscription.id);
      n++;
    }
    void this.syncFeatures();
    return n;
  }

  get(id: string): Subscription | undefined {
    return this.subscriptions.get(id);
  }

  list(options: { includeHidden?: boolean } = {}): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const subscription of this.subscriptions.values()) {
      if (subscription.hidden && !options.includeHidden) continue;
      out.push(this.describe(subscription));
    }
    return out;
  }

  describe(subscription: Subscription): Record<string, unknown> {
    return {
      id: subscription.id,
      active: subscription.active,
      createdAt: new Date(subscription.createdAt).toISOString(),
      channels: [...subscription.channels],
      search: subscription.options.search,
      level: subscription.options.level,
      targetId: subscription.options.targetId,
      errorsOnly: subscription.options.errorsOnly,
      performanceSampleMs: subscription.options.performanceSampleMs,
      frameCapture: subscription.options.frames ? subscription.options.frames : undefined,
      push: subscription.options.push ?? 'notification',
      matched: subscription.matched,
      buffered: subscription.buffer.length,
      cursor: this.session?.store.liveCursor ?? 0,
      lastEventAt: subscription.lastEventAt ? new Date(subscription.lastEventAt).toISOString() : undefined,
      expiresAt: subscription.expiresAt ? new Date(subscription.expiresAt).toISOString() : undefined,
      closedAt: subscription.closedAt ? new Date(subscription.closedAt).toISOString() : undefined,
      closeReason: subscription.closeReason,
    };
  }

  // ------------------------------------------------------------------ read

  read(id: string, options: ReadOptions = {}): ReadResult {
    const subscription = this.require(id);
    const since = options.cursor ?? 0;
    const limit = clampInt(options.limit, 50, 1, 2000);

    const pending = subscription.buffer.filter((e) => e.cursor > since).slice(0, limit);
    let framesIncluded = 0;
    const events = pending.map((event) => {
      if (event.channel === 'frame') framesIncluded++;
      const includeData = options.includeFrameData && framesIncluded <= MAX_FRAME_EVENTS_PER_READ;
      return serializeEvent(event, includeData);
    });

    return {
      subscriptionId: subscription.id,
      active: subscription.active,
      cursor: pending.length ? pending[pending.length - 1].cursor : since,
      count: events.length,
      totalMatched: subscription.matched,
      dropped: 0,
      events,
    };
  }

  /**
   * Long poll: return as soon as `min` new events landed, otherwise hold the
   * call for up to `timeoutMs`. This is what makes real time work over plain
   * request/response transports.
   */
  async wait(id: string, options: { cursor?: number; timeoutMs?: number; min?: number; limit?: number; includeFrameData?: boolean } = {}): Promise<WaitResult> {
    const subscription = this.require(id);
    const startedAt = Date.now();
    const timeoutMs = clampInt(options.timeoutMs, 15_000, 0, 120_000);
    const min = clampInt(options.min, 1, 1, 2000);
    const since = options.cursor ?? 0;

    const available = subscription.buffer.filter((e) => e.cursor > since).length;
    this.expired(subscription);
    if (available >= min || !subscription.active) {
      return { ...this.read(id, options), waitedMs: Date.now() - startedAt, timedOut: false };
    }

    return new Promise<WaitResult>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const list = this.waiters.get(id);
        if (list) {
          const index = list.findIndex((w) => w.finish === finish);
          if (index >= 0) list.splice(index, 1);
        }
        try {
          this.expired(subscription);
        } catch {
          /* nothing to do */
        }
        const result = this.read(id, options);
        resolve({ ...result, waitedMs: Date.now() - startedAt, timedOut: result.count === 0 });
      };

      const waiters = this.waiters.get(id) ?? [];
      waiters.push({ min, cursor: since, finish });
      this.waiters.set(id, waiters);
      const timer = setTimeout(finish, Math.max(1, timeoutMs));
      timer.unref?.();
    });
  }

  // --------------------------------------------------------------- internal

  private require(id: string): Subscription {
    const subscription = this.subscriptions.get(id);
    if (!subscription) throw new Error(`没有订阅 ${id}。先用 events_subscribe 创建一个。`);
    return subscription;
  }

  private route(event: LiveEvent): void {
    for (const listener of [...this.rawListeners]) {
      try {
        listener(event);
      } catch {
        /* recorder failures must not stop capture */
      }
    }

    for (const subscription of [...this.subscriptions.values()]) {
      if (!subscription.active) continue;
      if (this.expired(subscription)) continue;
      if (!matches(subscription, event)) continue;

      subscription.buffer.push(event);
      const max = subscription.options.buffer ?? DEFAULT_BUFFER;
      if (subscription.buffer.length > max) {
        subscription.buffer.splice(0, subscription.buffer.length - max);
      }
      subscription.matched++;
      subscription.lastEventAt = event.time;

      if (subscription.options.maxEvents && subscription.matched >= subscription.options.maxEvents) {
        subscription.active = false;
        subscription.closedAt = Date.now();
        subscription.closeReason = 'maxEvents';
      }

      this.wake(subscription.id);
      this.schedulePush(subscription);
    }

    void this.syncFeatures();
  }

  private expired(subscription: Subscription): boolean {
    if (!subscription.active) return true;
    if (subscription.expiresAt && Date.now() >= subscription.expiresAt) {
      subscription.active = false;
      subscription.closedAt = Date.now();
      subscription.closeReason = 'expired';
      this.wake(subscription.id);
      return true;
    }
    return false;
  }

  private wake(id: string): void {
    const waiters = this.waiters.get(id);
    if (!waiters?.length) return;
    const subscription = this.subscriptions.get(id);
    if (!subscription) return;

    for (const waiter of [...waiters]) {
      // Count what actually matters to this waiter: events newer than the
      // cursor it started from, not everything sitting in the buffer.
      const pending = subscription.buffer.reduce((n, event) => (event.cursor > waiter.cursor ? n + 1 : n), 0);
      if (pending >= waiter.min || !subscription.active) waiter.finish();
    }
  }

  private wakeAll(): void {
    for (const id of [...this.waiters.keys()]) this.wake(id);
  }

  /** Coalesce bursts so a page emitting hundreds of events per second stays readable. */
  private schedulePush(subscription: Subscription): void {
    const mode = subscription.options.push ?? 'notification';
    if (mode === 'none' || !this.pushHandler) return;
    if (this.pushTimers.has(subscription.id)) return;

    const timer = setTimeout(() => {
      this.pushTimers.delete(subscription.id);
      const pending = subscription.buffer.filter((e) => e.cursor > subscription.pushedCursor);
      if (!pending.length) return;
      subscription.pushedCursor = pending[pending.length - 1].cursor;
      const handler = this.pushHandler;
      if (handler) void handler(subscription, pending);
    }, 40);
    timer.unref?.();
    this.pushTimers.set(subscription.id, timer);
  }

  /** Start/stop session level features (metric polling, screencast) to match demand. */
  private async syncFeatures(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const open = [...this.subscriptions.values()].filter((s) => s.active);

    const sampling = open.filter((s) => s.options.performanceSampleMs);
    if (sampling.length) {
      const interval = Math.min(...sampling.map((s) => s.options.performanceSampleMs ?? 1000));
      if (session.metricsIntervalMs !== interval) {
        try {
          await session.startMetricsSampling(interval);
        } catch {
          /* page may not be ready yet */
        }
      }
    } else if (session.metricsIntervalMs !== null) {
      session.stopMetricsSampling();
    }

    const frames = open.filter((s) => s.options.frames);
    if (frames.length) {
      const config = mergeFrameOptions(frames.map((s) => s.options.frames));
      if (!session.screencastActive) {
        try {
          await session.startScreencast(config);
        } catch {
          /* headless build may not support it */
        }
      }
    } else if (session.screencastActive) {
      await session.stopScreencast().catch(() => undefined);
    }
  }
}

function mergeFrameOptions(list: Array<ScreencastOptions | true | undefined>): ScreencastOptions {
  const merged: ScreencastOptions = { format: 'jpeg', quality: 60, everyNthFrame: 1 };
  for (const item of list) {
    if (item === true || !item) continue;
    if (item.format) merged.format = item.format;
    if (item.quality) merged.quality = Math.min(merged.quality ?? 60, item.quality);
    if (item.everyNthFrame) merged.everyNthFrame = Math.min(merged.everyNthFrame ?? 1, item.everyNthFrame);
    if (item.maxWidth) merged.maxWidth = merged.maxWidth ? Math.max(merged.maxWidth, item.maxWidth) : item.maxWidth;
    if (item.maxHeight) merged.maxHeight = merged.maxHeight ? Math.max(merged.maxHeight, item.maxHeight) : item.maxHeight;
  }
  return merged;
}

function normalizeChannels(channels?: LiveChannel[]): LiveChannel[] {
  if (!channels || !channels.length) return ALL_CHANNELS;
  const set = new Set<LiveChannel>();
  for (const channel of channels) {
    if ((ALL_CHANNELS as string[]).includes(channel)) set.add(channel);
  }
  return set.size ? [...set] : ALL_CHANNELS;
}

function matches(subscription: Subscription, event: LiveEvent): boolean {
  if (!subscription.channels.has(event.channel)) return false;
  const options = subscription.options;

  if (options.targetId && event.targetId && event.targetId !== options.targetId) return false;
  if (options.level?.length) {
    const data = event.data as { level?: string } | undefined;
    if (!data?.level || !options.level.includes(data.level as ConsoleLevel)) return false;
  }
  if (options.errorsOnly) {
    const data = event.data as { level?: string; source?: string; failed?: boolean; status?: number } | undefined;
    const bad =
      data?.level === 'error' ||
      data?.source === 'exception' ||
      data?.failed === true ||
      (typeof data?.status === 'number' && data.status >= 400);
    if (!bad) return false;
  }
  if (options.search) {
    const needle = options.search.toLowerCase();
    if (!JSON.stringify(event.data ?? '').toLowerCase().includes(needle)) return false;
  }
  return true;
}

/**
 * Serialise a live event for the wire. `_`-prefixed fields are internal CDP
 * bookkeeping, and frame payloads are dropped unless explicitly asked for.
 */
export function serializeEvent(event: LiveEvent, includeFrameData = false): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    cursor: event.cursor,
    time: new Date(event.time).toISOString(),
    epochMs: event.time,
    channel: event.channel,
    kind: event.kind,
    targetId: event.targetId,
    targetTitle: event.targetTitle,
  };

  if (event.channel === 'frame') {
    const frame = event.data as { data?: string; format?: string; bytes?: number; metadata?: unknown };
    envelope.data = {
      format: frame?.format,
      bytes: frame?.bytes,
      metadata: frame?.metadata,
      dataIncluded: Boolean(includeFrameData && frame?.data),
      ...(includeFrameData && frame?.data ? { data: frame.data } : {}),
    };
    return envelope;
  }

  envelope.data = stripPrivate(event.data);
  return envelope;
}

function stripPrivate<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => stripPrivate(item)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('_')) continue;
    if (item && typeof item === 'object') {
      out[key] = stripPrivate(item);
      continue;
    }
    out[key] = item;
  }
  return out as unknown as T;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}
