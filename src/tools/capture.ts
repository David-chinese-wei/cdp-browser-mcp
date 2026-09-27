import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildSummary } from '../export/csv.js';
import { saveCapture, type SaveCaptureOptions } from '../export/save.js';
import type { BrowserHub } from '../hub.js';
import type { CapturedData } from '../types.js';
import { formatNow, guard, ok } from './support.js';

export interface CaptureToolOptions {
  includeDom?: boolean;
  includeScreenshot?: boolean;
  includePerformance?: boolean;
  includeStorage?: boolean;
  since?: number;
}

/** Collect everything currently buffered, optionally topping it up with live reads. */
export async function collectCapture(hub: BrowserHub, options: CaptureToolOptions = {}): Promise<CapturedData> {
  const session = await hub.ensureSession();
  const since = options.since ?? hub.captureSince ?? undefined;
  const limit = 20_000;

  const data: CapturedData = {
    meta: { ...session.meta },
    console: session.store.listConsole({ since, limit }),
    network: session.store.listNetwork({ since, limit }).map(stripCdpFields),
    errors: session.store.listErrors(limit),
  };

  if (options.includeDom) data.dom = await session.getDom({ mode: 'both' });
  if (options.includeScreenshot) data.screenshot = await session.screenshot();
  if (options.includePerformance) data.performance = await session.performance();
  if (options.includeStorage) data.storage = await session.storage();

  return data;
}

/** One shot capture tools: start / status / stop / save / list. */
export function registerCaptureTools(server: McpServer, hub: BrowserHub): void {
  server.registerTool(
    'capture_start',
    {
      title: '开始一轮抓取',
      description: '清空缓冲并记录起始时间，之后发生的 console / 网络 / 错误都会被计入本轮抓取。',
      inputSchema: {
        targetId: z.string().optional().describe('可选，顺带切换到该标签页'),
      },
    },
    async (args) =>
      guard(async () => {
        await hub.ensureSession({ targetId: args.targetId });
        const startedAt = hub.markCaptureStart();
        return ok({
          startedAt,
          startedAtText: formatNow(startedAt),
          hint: '缓冲已清空。现在可以刷新页面或复现操作，然后用 capture_stop / capture_save 收尾。',
        });
      }),
  );

  server.registerTool(
    'capture_status',
    {
      title: '抓取状态',
      description: '查看当前会话的缓冲计数、目标页与是否处于某一轮抓取中。',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const session = hub.activeSession;
        if (!session) return ok({ connected: false, hint: '尚未建立会话，用 browser_connect 或 browser_launch。' });
        const since = hub.captureSince;
        const counts = session.counts();
        const scoped = since
          ? {
              console: session.store.listConsole({ since, limit: 20_000 }).length,
              network: session.store.listNetwork({ since, limit: 20_000 }).length,
              errors: session.store.listErrors(20_000).filter((e) => e.time >= since).length,
            }
          : undefined;

        return ok({
          connected: true,
          meta: session.meta,
          buffer: counts,
          inCapture: since !== null,
          captureStartedAt: since ?? undefined,
          elapsedMs: since ? Date.now() - since : undefined,
          thisRound: scoped,
        });
      }),
  );

  server.registerTool(
    'capture_stop',
    {
      title: '结束抓取并汇总',
      description: '结束当前这一轮抓取，返回统计与建议摘要（不落盘；要落盘用 capture_save）。',
      inputSchema: {
        includeDom: z.boolean().optional(),
        includeScreenshot: z.boolean().optional(),
        includePerformance: z.boolean().optional(),
        includeStorage: z.boolean().optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const since = hub.captureSince;
        const data = await collectCapture(hub, { ...args, since: since ?? undefined });
        hub.markCaptureStop();
        return ok({
          counts: {
            console: data.console.length,
            network: data.network.length,
            errors: data.errors.length,
          },
          summary: buildSummary(data),
          target: { title: data.meta.targetTitle, url: data.meta.targetUrl },
          hint: '这只是内存里的摘要。用 capture_save 可以把 HAR / CSV / HTML 报告整套落盘。',
        });
      }),
  );

  server.registerTool(
    'capture_save',
    {
      title: '一键保存',
      description:
        '把抓到的全部内容落盘成一个目录：session.json、console.json/csv、network.har、network.csv、metrics.json、storage.json、dom.html、截图、离线 HTML 报告 report.html、summary.md 与 manifest.json。',
      inputSchema: {
        dir: z.string().optional().describe('直接指定输出目录（绝对路径）；缺省用 captures/<会话名>'),
        name: z.string().optional().describe('输出目录名，缺省用会话 ID'),
        rootDir: z.string().optional().describe('输出根目录，缺省 <cwd>/captures'),
        includeDom: z.boolean().optional().describe('是否抓取 DOM 快照，默认 true'),
        includeScreenshot: z.boolean().optional().describe('是否抓取截图，默认 true'),
        includePerformance: z.boolean().optional().describe('是否抓取性能指标，默认 true'),
        includeStorage: z.boolean().optional().describe('是否抓取存储数据，默认 true'),
        maxRows: z.number().int().optional().describe('HTML 报告里每表最多渲染行数，默认 500'),
        includeSummary: z.boolean().optional().describe('是否返回 Markdown 摘要文本，默认 true'),
      },
    },
    async (args) =>
      guard(async () => {
        const data = await collectCapture(hub, {
          includeDom: args.includeDom ?? true,
          includeScreenshot: args.includeScreenshot ?? true,
          includePerformance: args.includePerformance ?? true,
          includeStorage: args.includeStorage ?? true,
        });

        const options: SaveCaptureOptions = {
          dir: args.dir,
          name: args.name,
          rootDir: args.rootDir,
          maxRows: args.maxRows,
        };
        const saved = await saveCapture(data, options);
        hub.rememberCapture(saved.dir);

        return ok({
          dir: saved.dir,
          manifest: saved.manifestPath,
          counts: saved.counts,
          files: saved.files.map((f) => ({ name: f.path.split(/[\\/]/).pop(), bytes: f.bytes, description: f.description })),
          summary: args.includeSummary === false ? undefined : buildSummary(data),
          hint: '打开该目录下的 report.html 即可看到完整离线报告；network.har 可直接导入 DevTools / Charles。',
        });
      }),
  );

  server.registerTool(
    'capture_list_saved',
    {
      title: '列出已保存的抓取',
      description: '列出之前保存过的抓取目录（含内存记录与 captures 根目录下的结果）。',
      inputSchema: {
        rootDir: z.string().optional().describe('要扫描的根目录，缺省 <cwd>/captures'),
      },
    },
    async (args) =>
      guard(async () => {
        const captures = hub.listSavedCaptures(args.rootDir);
        return ok({
          root: args.rootDir ?? hub.defaultCaptureRoot,
          count: captures.length,
          captures,
          hint: captures.length ? '每个目录下的 report.html 可直接打开查看。' : '还没有保存过抓取。',
        });
      }),
  );
}

function stripCdpFields(entry: CapturedData['network'][number]): CapturedData['network'][number] {
  const { _cdpStart: _start, _cdpEnd: _end, ...rest } = entry;
  return rest;
}
