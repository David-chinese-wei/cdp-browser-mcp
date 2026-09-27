import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LiveChannel, LiveEvent } from '../capture/store.js';

export interface RecordingOptions {
  /** Absolute output directory; wins over name+rootDir. */
  dir?: string;
  name?: string;
  rootDir?: string;
  /** Write screencast frames to `frames/<n>.jpg` instead of dropping them. */
  saveFrames?: boolean;
  /** Poll Performance.getMetrics every N ms so the recording has a metric timeline. */
  performanceSampleMs?: number;
  /** Skip channel, useful when only network traffic matters. */
  channels?: LiveChannel[];
}

export interface RecordingSummary {
  dir: string;
  eventsPath: string;
  framesDir?: string;
  startedAt: number;
  stoppedAt?: number;
  durationMs?: number;
  total: number;
  bytes: number;
  frames: number;
  counts: Partial<Record<LiveChannel, number>>;
}

/**
 * Appends the live feed to a JSONL file as events arrive, so a long monitoring
 * session never depends on how much fits in memory.
 */
export class LiveRecorder {
  readonly dir: string;
  readonly eventsPath: string;
  readonly framesDir?: string;
  readonly startedAt = Date.now();

  private readonly channelFilter: Set<LiveChannel> | null;
  private counts = new Map<LiveChannel, number>();
  private total = 0;
  private bytes = 0;
  private frames = 0;
  private stopped = false;

  constructor(options: RecordingOptions = {}) {
    const base = options.dir
      ? resolve(options.dir)
      : resolve(options.rootDir ?? join(process.cwd(), 'captures'), options.name ?? `live-${Date.now()}`);
    this.dir = base;
    this.eventsPath = join(base, 'live-events.jsonl');
    if (options.saveFrames) this.framesDir = join(base, 'frames');
    this.channelFilter = options.channels?.length ? new Set(options.channels) : null;

    mkdirSync(base, { recursive: true });
    if (this.framesDir) mkdirSync(this.framesDir, { recursive: true });
    writeFileSync(
      join(base, 'recording-start.json'),
      `${JSON.stringify({ startedAt: this.startedAt, startedAtText: new Date(this.startedAt).toISOString(), options }, null, 2)}\n`,
      'utf8',
    );
  }

  handle(event: LiveEvent): void {
    if (this.stopped) return;
    if (this.channelFilter && !this.channelFilter.has(event.channel)) return;

    let payload: unknown = event.data;
    if (event.channel === 'frame') {
      const frame = event.data as { data?: string; format?: string };
      payload = { ...frame, data: undefined, bytes: frame.data ? Math.ceil((frame.data.length * 3) / 4) : 0 };
      if (frame.data && this.framesDir) this.writeFrame(event.cursor, frame.data, frame.format ?? 'jpeg');
    } else {
      payload = stripPrivate(event.data);
    }

    const line = JSON.stringify({
      cursor: event.cursor,
      time: new Date(event.time).toISOString(),
      epochMs: event.time,
      channel: event.channel,
      kind: event.kind,
      targetId: event.targetId,
      targetTitle: event.targetTitle,
      data: payload,
    });

    try {
      appendFileSync(this.eventsPath, `${line}\n`, 'utf8');
      this.bytes += Buffer.byteLength(line) + 1;
    } catch {
      return;
    }

    this.total++;
    this.counts.set(event.channel, (this.counts.get(event.channel) ?? 0) + 1);
  }

  stop(): RecordingSummary {
    if (this.stopped) {
      return this.summary(undefined);
    }
    this.stopped = true;
    const stoppedAt = Date.now();
    const summary = this.summary(stoppedAt);
    try {
      writeFileSync(join(this.dir, 'recording-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    } catch {
      /* read only disk, nothing else we can do */
    }
    return summary;
  }

  private summary(stoppedAt: number | undefined): RecordingSummary {
    const counts: Partial<Record<LiveChannel, number>> = {};
    for (const [channel, count] of this.counts) counts[channel] = count;
    return {
      dir: this.dir,
      eventsPath: this.eventsPath,
      framesDir: this.framesDir,
      startedAt: this.startedAt,
      stoppedAt,
      durationMs: stoppedAt ? stoppedAt - this.startedAt : undefined,
      total: this.total,
      bytes: this.bytes,
      frames: this.frames,
      counts,
    };
  }

  private writeFrame(cursor: number, base64: string, format: string): void {
    if (!this.framesDir) return;
    try {
      const name = `${String(cursor).padStart(8, '0')}.${format === 'png' ? 'png' : 'jpg'}`;
      writeFileSync(join(this.framesDir, name), Buffer.from(base64, 'base64'));
      this.frames++;
      this.bytes += Math.ceil((base64.length * 3) / 4);
    } catch {
      /* disk full or file locked; keep going */
    }
  }
}

function stripPrivate<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => stripPrivate(item)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('_')) continue;
    out[key] = item && typeof item === 'object' ? stripPrivate(item) : item;
  }
  return out as unknown as T;
}
