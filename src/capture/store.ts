import type { ConsoleEntry, ConsoleLevel, NetworkEntry, PageErrorEntry } from '../types.js';

export interface StoreLimits {
  maxConsole: number;
  maxNetwork: number;
  maxErrors: number;
  /** How many live events are kept for incremental consumers. */
  maxEvents: number;
}

export const DEFAULT_LIMITS: StoreLimits = {
  maxConsole: 5000,
  maxNetwork: 5000,
  maxErrors: 1000,
  maxEvents: 5000,
};

/**
 * Everything Streamable sources are grouped into. Filters close to what a human
 * asks for ("anything network", "any navigation") instead of CDP method names.
 */
export type LiveChannel = 'console' | 'network' | 'error' | 'navigation' | 'target' | 'metric' | 'frame';

export const LIVE_CHANNELS: LiveChannel[] = [
  'console',
  'network',
  'error',
  'navigation',
  'target',
  'metric',
  'frame',
];

export interface LiveEvent {
  /** Session wide monotonic position. Consumers advance a cursor over it. */
  cursor: number;
  time: number;
  channel: LiveChannel;
  /** `request` / `response` / `finished` / `navigated` / `created` / ... */
  kind: string;
  targetId?: string;
  targetTitle?: string;
  data: unknown;
}

export type LiveListener = (event: LiveEvent) => void;

export interface ConsoleQuery {
  level?: ConsoleLevel | ConsoleLevel[];
  search?: string;
  limit?: number;
  /** Only entries captured after this epoch ms. */
  since?: number;
  targetId?: string;
  /** Only entries whose source is a thrown exception. */
  errorsOnly?: boolean;
}

export interface NetworkQuery {
  search?: string;
  method?: string;
  type?: string;
  status?: number | 'failed' | 'error';
  limit?: number;
  since?: number;
  targetId?: string;
  /** Exclude entries that finished successfully. */
  failuresOnly?: boolean;
  /** Only entries with a 4xx/5xx status. */
  httpErrorsOnly?: boolean;
}

/**
 * Ring buffered store for everything captured from DevTools.
 * Oldest entries are dropped once a buffer is full.
 */
export class CaptureStore {
  private consoleSeq = 0;
  private networkSeq = 0;
  private readonly consoleEntries: ConsoleEntry[] = [];
  private readonly networkEntries = new Map<string, NetworkEntry>();
  private readonly networkOrder: string[] = [];
  private readonly errorEntries: PageErrorEntry[] = [];
  private limits: StoreLimits;

  private liveSeq = 0;
  private readonly liveEvents: LiveEvent[] = [];
  private readonly liveListeners = new Set<LiveListener>();

  constructor(limits: Partial<StoreLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  setLimits(limits: Partial<StoreLimits>): void {
    this.limits = { ...this.limits, ...limits };
    this.trim();
  }

  getLimits(): StoreLimits {
    return { ...this.limits };
  }

  addConsole(entry: Omit<ConsoleEntry, 'seq'>): ConsoleEntry {
    const full: ConsoleEntry = { ...entry, seq: ++this.consoleSeq };
    this.consoleEntries.push(full);
    if (this.consoleEntries.length > this.limits.maxConsole) {
      this.consoleEntries.splice(0, this.consoleEntries.length - this.limits.maxConsole);
    }
    const event = this.emit(
      'console',
      full.level === 'error' || full.source === 'exception' ? 'error' : 'message',
      full,
      { id: full.targetId, title: full.targetTitle },
    );
    event.time = full.time;
    return full;
  }

  addError(entry: PageErrorEntry): PageErrorEntry {
    this.errorEntries.push(entry);
    if (this.errorEntries.length > this.limits.maxErrors) {
      this.errorEntries.splice(0, this.errorEntries.length - this.limits.maxErrors);
    }
    const event = this.emit('error', entry.source ?? 'exception', entry, { id: undefined, title: undefined });
    event.time = entry.time;
    return entry;
  }

  /** Insert or merge a network entry keyed by CDP requestId. */
  upsertNetwork(id: string, patch: Partial<NetworkEntry> & { url?: string }): NetworkEntry {
    const existing = this.networkEntries.get(id);
    if (existing) {
      Object.assign(existing, patch);
      return existing;
    }
    const entry: NetworkEntry = {
      id,
      seq: ++this.networkSeq,
      time: patch.time ?? Date.now(),
      url: patch.url ?? '',
      method: patch.method ?? 'GET',
      finished: false,
      ...patch,
    };
    this.networkEntries.set(id, entry);
    this.networkOrder.push(id);
    if (this.networkOrder.length > this.limits.maxNetwork) {
      const dropped = this.networkOrder.splice(0, this.networkOrder.length - this.limits.maxNetwork);
      for (const key of dropped) this.networkEntries.delete(key);
    }
    return entry;
  }

  getNetwork(id: string): NetworkEntry | undefined {
    return this.networkEntries.get(id);
  }

  listConsole(query: ConsoleQuery = {}): ConsoleEntry[] {
    let items = this.consoleEntries;
    const levels = query.level ? (Array.isArray(query.level) ? query.level : [query.level]) : undefined;
    if (levels?.length) items = items.filter((e) => levels.includes(e.level));
    if (query.errorsOnly) items = items.filter((e) => e.level === 'error' || e.source === 'exception');
    if (query.targetId) items = items.filter((e) => e.targetId === query.targetId);
    if (query.since) items = items.filter((e) => e.time >= query.since!);
    const search = query.search?.trim().toLowerCase();
    if (search) items = items.filter((e) => e.text.toLowerCase().includes(search));
    const limit = clampLimit(query.limit, 200);
    return items.slice(-limit);
  }

  listNetwork(query: NetworkQuery = {}): NetworkEntry[] {
    let items = this.networkOrder.map((id) => this.networkEntries.get(id)!).filter(Boolean);
    if (query.method) {
      const m = query.method.toUpperCase();
      items = items.filter((e) => e.method.toUpperCase() === m);
    }
    if (query.type) {
      const t = query.type.toLowerCase();
      items = items.filter((e) => (e.type ?? '').toLowerCase() === t);
    }
    if (query.status === 'failed' || query.status === 'error') {
      items = items.filter((e) => e.failed || (typeof e.status === 'number' && e.status >= 400));
    } else if (typeof query.status === 'number') {
      items = items.filter((e) => e.status === query.status);
    }
    if (query.failuresOnly) items = items.filter((e) => Boolean(e.failed));
    if (query.httpErrorsOnly) items = items.filter((e) => typeof e.status === 'number' && e.status >= 400);
    if (query.targetId) items = items.filter((e) => e.targetId === query.targetId);
    if (query.since) items = items.filter((e) => e.time >= query.since!);
    const search = query.search?.trim().toLowerCase();
    if (search) items = items.filter((e) => e.url.toLowerCase().includes(search));
    const limit = clampLimit(query.limit, 200);
    return items.slice(-limit);
  }

  listErrors(limit = 100): PageErrorEntry[] {
    return this.errorEntries.slice(-clampLimit(limit, 200));
  }

  clear(): void {
    this.consoleEntries.length = 0;
    this.errorEntries.length = 0;
    this.networkEntries.clear();
    this.networkOrder.length = 0;
  }

  counts(): { console: number; network: number; errors: number } {
    return {
      console: this.consoleEntries.length,
      network: this.networkEntries.size,
      errors: this.errorEntries.length,
    };
  }

  snapshot(): { console: ConsoleEntry[]; network: NetworkEntry[]; errors: PageErrorEntry[] } {
    return {
      console: [...this.consoleEntries],
      network: this.networkOrder.map((id) => this.networkEntries.get(id)!).filter(Boolean),
      errors: [...this.errorEntries],
    };
  }

  // --------------------------------------------------------------- live feed

  /** subscribe to the live feed. returns an unsubscribe function. */
  onEvent(listener: LiveListener): () => void {
    this.liveListeners.add(listener);
    return () => {
      this.liveListeners.delete(listener);
    };
  }

  /** Position of the newest live event; 0 when nothing happened yet. */
  get liveCursor(): number {
    return this.liveSeq;
  }

  /**
   * Publish a live event. Callers pass the payload by reference: the object may
   * still be mutated afterwards (a network entry gains fields as it completes),
   * which is what makes incremental reads cheap.
   */
  emit(
    channel: LiveChannel,
    kind: string,
    data: unknown,
    target?: { id?: string; title?: string },
  ): LiveEvent {
    const event: LiveEvent = {
      cursor: ++this.liveSeq,
      time: Date.now(),
      channel,
      kind,
      targetId: target?.id,
      targetTitle: target?.title,
      data,
    };

    this.liveEvents.push(event);
    if (this.liveEvents.length > this.limits.maxEvents) {
      this.liveEvents.splice(0, this.liveEvents.length - this.limits.maxEvents);
    }
    for (const listener of [...this.liveListeners]) {
      try {
        listener(event);
      } catch {
        /* a broken consumer must never stall capture */
      }
    }
    return event;
  }

  /**
   * Everything newer than `cursor`. `dropped` tells the caller how many events
   * aged out of the ring buffer before it got around to reading them.
   */
  eventsSince(
    cursor: number,
    limit = 200,
  ): { events: LiveEvent[]; cursor: number; dropped: number; earliestCursor: number } {
    const oldest = this.liveEvents.length ? this.liveEvents[0].cursor : this.liveSeq + 1;
    const newer = this.liveEvents.filter((e) => e.cursor > cursor);
    const capped = clampLimit(limit, 200, 5000);
    return {
      events: newer.slice(0, capped),
      cursor: this.liveSeq,
      dropped: Math.max(0, oldest - cursor - 1),
      earliestCursor: oldest,
    };
  }

  /** Drop live events older than everything a reader needs. Cheap safety valve for the frame channel. */
  dropOlderThan(channel: LiveChannel, keep: number): number {
    const keepers: LiveEvent[] = [];
    let remove: LiveEvent[] = [];
    for (const event of this.liveEvents) {
      if (event.channel === channel) keepers.push(event);
    }
    if (keepers.length <= keep) return 0;
    const doomed = new Set(keepers.slice(0, keepers.length - keep).map((e) => e.cursor));
    remove = [...this.liveEvents];
    this.liveEvents.length = 0;
    for (const event of remove) {
      if (!doomed.has(event.cursor)) this.liveEvents.push(event);
    }
    return doomed.size;
  }

  private trim(): void {
    if (this.consoleEntries.length > this.limits.maxConsole) {
      this.consoleEntries.splice(0, this.consoleEntries.length - this.limits.maxConsole);
    }
    if (this.errorEntries.length > this.limits.maxErrors) {
      this.errorEntries.splice(0, this.errorEntries.length - this.limits.maxErrors);
    }
    if (this.networkOrder.length > this.limits.maxNetwork) {
      const dropped = this.networkOrder.splice(0, this.networkOrder.length - this.limits.maxNetwork);
      for (const key of dropped) this.networkEntries.delete(key);
    }
  }
}

export function clampLimit(value: number | undefined, fallback: number, max = 20_000): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}
