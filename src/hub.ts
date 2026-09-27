import { readdirSync, readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { discoverBrowsers, getBrowserWebSocketUrl, probePort } from './browser/discovery.js';
import { BrowserLauncher, type LaunchOptions, type LaunchedBrowser } from './browser/launch.js';
import { DevToolsSession, type SessionTarget } from './capture/session.js';
import { LiveManager, type SubscriptionOptions } from './live/manager.js';
import { LiveRecorder, type RecordingOptions, type RecordingSummary } from './live/recorder.js';
import type { DiscoveredBrowser } from './types.js';

export interface ConnectOptions {
  /** DevTools port of an already running browser. */
  port?: number;
  host?: string;
  /** Full browser WebSocket URL. Takes precedence over port scanning. */
  webSocketUrl?: string;
  /** Target to attach to straight away. Defaults to the first usable page. */
  targetId?: string;
  autoAttach?: boolean;
  timeoutMs?: number;
  storeLimits?: { maxConsole?: number; maxNetwork?: number; maxErrors?: number };
  /** Capture every page target that appears, not only the active one. */
  watchAllTargets?: boolean;
}

export interface ConnectResult {
  host: string;
  port?: number;
  webSocketUrl: string;
  browser?: string;
  browserVersion?: string;
  targetId: string | null;
  targets: SessionTarget[];
  warnings: string[];
}

export interface SavedCaptureSummary {
  dir: string;
  createdAt?: string;
  counts?: { console: number; network: number; errors: number };
  title?: string;
  files: number;
}

interface RecordingEntry {
  recorder: LiveRecorder;
  subscriptionId: string;
  off: () => void;
}

/**
 * Owns the single active DevTools session plus the browsers this server started,
 * so every MCP tool sees the same state.
 */
export class BrowserHub {
  readonly launcher = new BrowserLauncher();
  readonly savedCaptures: string[] = [];
  /** Live subscriptions shared by every tool. */
  readonly live = new LiveManager();
  readonly recordings = new Map<string, RecordingEntry>();

  private session: DevToolsSession | null = null;
  private connection: { host: string; port?: number; webSocketUrl: string } | null = null;
  private captureMark: number | null = null;

  readonly defaultCaptureRoot: string;

  constructor(options: { captureRoot?: string } = {}) {
    this.defaultCaptureRoot = resolve(options.captureRoot ?? join(process.cwd(), 'captures'));
  }

  get activeSession(): DevToolsSession | null {
    return this.session && !this.session.isClosed ? this.session : null;
  }

  get activeTargetId(): string | null {
    return this.activeSession?.targetId ?? null;
  }

  get captureSince(): number | null {
    return this.captureMark;
  }

  /** Require an attached page, attaching to something usable when nothing is connected yet. */
  async ensureSession(options: { targetId?: string } = {}): Promise<DevToolsSession> {
    let session = this.activeSession;
    if (!session) {
      await this.connect({ targetId: options.targetId });
      session = this.activeSession;
    }
    if (!session) throw new Error('无法建立 DevTools 会话');
    if (options.targetId && session.targetId !== options.targetId) {
      await session.selectTarget(options.targetId);
    }
    if (!session.targetId) throw new Error('当前没有已附加的页面，请先调用 target_select');
    return session;
  }

  async connect(options: ConnectOptions = {}): Promise<ConnectResult> {
    const host = options.host ?? '127.0.0.1';
    let webSocketUrl = options.webSocketUrl;
    let browser: string | undefined;
    let browserUserAgent: string | undefined;
    let port = options.port;

    if (!webSocketUrl) {
      let discovered: DiscoveredBrowser | undefined;
      if (port) {
        const found = await probePort(port, host, 3000);
        if (!found) {
          throw new Error(
            `${host}:${port} 上没有 DevTools 端点。目标浏览器需要用 --remote-debugging-port=${port} 启动（可用 browser_launch 代劳）。`,
          );
        }
        discovered = found;
      } else {
        const all = await discoverBrowsers({ host });
        if (!all.length) {
          throw new Error(
            `没有发现带调试端口的浏览器（已扫描 ${host} 的 9222–9235）。可用 browser_launch 启动一个可附加实例。`,
          );
        }
        discovered = all[0];
      }

      port = discovered.port;
      browser = discovered.browser;
      // Not `protocolVersion`: that is the DevTools protocol revision, not the product version.
      // The session resolves the real version from `Browser.getVersion().product`.
      browserUserAgent = discovered.userAgent;
      webSocketUrl = discovered.webSocketDebuggerUrl || (await getBrowserWebSocketUrl(discovered.port, host));
    }

    if (!webSocketUrl) {
      throw new Error('无法确定 DevTools WebSocket 地址，请显式传入 webSocketUrl。');
    }

    // Reuse the existing socket when reconnecting to the same endpoint.
    if (this.activeSession && this.connection?.webSocketUrl === webSocketUrl && !options.targetId) {
      const targets = await this.activeSession.listTargets();
      return {
        host,
        port,
        webSocketUrl,
        browser: this.activeSession.meta.browser ?? browser,
        browserVersion: this.activeSession.meta.browserVersion,
        targetId: this.activeSession.targetId,
        targets,
        warnings: ['已复用现有连接'],
      };
    }

    this.disconnectSession();

    const session = await DevToolsSession.connect({
      webSocketUrl,
      host,
      port,
      browser,
      browserUserAgent,
      autoAttach: options.autoAttach ?? true,
      timeoutMs: options.timeoutMs,
      storeLimits: options.storeLimits,
      watchAllTargets: options.watchAllTargets,
    });

    this.session = session;
    this.connection = { host, port, webSocketUrl };
    this.captureMark = null;
    this.live.attach(session);

    if (options.targetId) await session.selectTarget(options.targetId);

    return {
      host,
      port,
      webSocketUrl,
      browser: session.meta.browser,
      browserVersion: session.meta.browserVersion,
      targetId: session.targetId,
      targets: await session.listTargets(),
      warnings: [...session.warnings],
    };
  }

  async launch(
    options: LaunchOptions & { targetId?: string; attach?: boolean; watchAllTargets?: boolean } = {},
  ): Promise<LaunchedBrowser> {
    const launched = await this.launcher.launch(options);
    if (options.attach !== false) {
      await this.connect({
        port: launched.port,
        host: launched.host,
        targetId: options.targetId,
        watchAllTargets: options.watchAllTargets,
      });
    }
    return launched;
  }

  /** Detach and drop the current session, leaving the browser running. */
  disconnectSession(): boolean {
    if (!this.session) return false;
    this.stopAllRecordings();
    this.live.detach();
    this.session.close();
    this.session = null;
    this.connection = null;
    this.captureMark = null;
    return true;
  }

  // ------------------------------------------------------------- live recording

  /** Start streaming every event to disk. Returns the recorder plus its subscription id. */
  async startRecording(options: RecordingOptions = {}): Promise<{
    id: string;
    recorder: LiveRecorder;
    subscriptionId: string;
    dir: string;
    eventsPath: string;
  }> {
    await this.ensureSession();
    const recorder = new LiveRecorder(options);
    const id = `rec-${Date.now().toString(36)}-${this.recordings.size + 1}`;

    const subscriptionOptions: SubscriptionOptions = {
      channels: options.channels,
      buffer: 0,
      push: 'none',
      hidden: true,
    };
    // Frame capture has to be driven by a subscription, even though the recorder
    // listens to the raw feed.
    if (options.saveFrames) subscriptionOptions.frames = true;
    if (options.performanceSampleMs) subscriptionOptions.performanceSampleMs = options.performanceSampleMs;

    const subscription = await this.live.subscribe(subscriptionOptions, { hidden: true });
    const off = this.live.onRawEvent((event) => recorder.handle(event));
    const entry: RecordingEntry = { recorder, subscriptionId: subscription.id, off };

    this.recordings.set(id, entry);
    return {
      id,
      recorder: entry.recorder,
      subscriptionId: subscription.id,
      dir: recorder.dir,
      eventsPath: recorder.eventsPath,
    };
  }

  stopRecording(id: string): RecordingSummary | null {
    const entry = this.recordings.get(id);
    if (!entry) return null;
    this.recordings.delete(id);
    entry.off();
    this.live.unsubscribe(entry.subscriptionId);
    return entry.recorder.stop();
  }

  stopAllRecordings(): RecordingSummary[] {
    const out: RecordingSummary[] = [];
    for (const id of [...this.recordings.keys()]) {
      const summary = this.stopRecording(id);
      if (summary) out.push(summary);
    }
    return out;
  }

  /**
   * Shut the session down and, when requested, the browsers this server started.
   * Returns what was actually closed.
   */
  async closeSession(options: { port?: number; killBrowser?: boolean; closeAllBrowsers?: boolean } = {}): Promise<{
    session: boolean;
    browsers: number;
  }> {
    const hadSession = this.disconnectSession();
    let browsers = 0;

    if (options.closeAllBrowsers) {
      browsers = await this.launcher.closeAll();
    } else if (options.port !== undefined) {
      browsers = (await this.launcher.close(options.port)) ? 1 : 0;
    } else if (options.killBrowser && this.connection?.port !== undefined) {
      browsers = (await this.launcher.close(this.connection.port)) ? 1 : 0;
      if (!browsers) browsers = await this.launcher.closeAll();
    }

    return { session: hadSession, browsers };
  }

  markCaptureStart(): number {
    this.captureMark = Date.now();
    if (this.activeSession) this.activeSession.clear();
    return this.captureMark;
  }

  markCaptureStop(): number | null {
    const mark = this.captureMark;
    this.captureMark = null;
    return mark;
  }

  rememberCapture(dir: string): void {
    const absolute = resolve(dir);
    if (!this.savedCaptures.includes(absolute)) this.savedCaptures.push(absolute);
  }

  /** Union of in-memory saves and anything found under the capture root. */
  listSavedCaptures(rootDir?: string): SavedCaptureSummary[] {
    const root = resolve(rootDir ?? this.defaultCaptureRoot);
    const dirs = new Set<string>([
      ...this.savedCaptures.filter((d) => rootDir === undefined || d.startsWith(root)),
    ]);

    if (existsSync(root)) {
      try {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (entry.isDirectory()) dirs.add(join(root, entry.name));
        }
      } catch {
        /* unreadable capture root */
      }
    }

    const out: SavedCaptureSummary[] = [];
    for (const dir of dirs) {
      const manifestPath = join(dir, 'manifest.json');
      if (!existsSync(manifestPath)) {
        out.push({ dir, files: countFiles(dir) });
        continue;
      }
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>;
        out.push({
          dir,
          createdAt: typeof manifest['createdAt'] === 'string' ? manifest['createdAt'] : undefined,
          counts: manifest['counts'],
          title: manifest['session']?.targetTitle ?? manifest['session']?.targetUrl,
          files: Array.isArray(manifest['files']) ? manifest['files'].length : countFiles(dir),
        });
      } catch {
        out.push({ dir, files: countFiles(dir) });
      }
    }

    return out.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  }
}

function countFiles(dir: string): number {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}
