import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { discoverBrowsers } from '../browser/discovery.js';
import { listInstalledBrowsers } from '../browser/install.js';
import { listBrowserProcesses } from '../browser/process.js';
import type { BrowserHub } from '../hub.js';
import { guard, ok } from './support.js';

/**
 * A target that renders nothing worth inspecting: extension pages, browser
 * internals, service workers and offscreen documents.
 *
 * Chromium browsers ship several of these by default and Edge adds its own
 * (feedback, shopping, WebRTC internals...), so without this filter a real
 * page list of two or three entries drowns in a dozen background targets.
 *
 * `about:blank` is deliberately kept: a fresh tab the user just opened is a
 * perfectly valid target to attach to.
 */
function isRealPage(target: { type: string; url: string }): boolean {
  if (target.type !== 'page') return false;
  return !/^(chrome-extension|devtools|chrome|edge|chrome-untrusted):/i.test(target.url ?? '');
}

/** Browser enumeration, launch, connect and target switching. */
export function registerBrowserTools(server: McpServer, hub: BrowserHub): void {
  server.registerTool(
    'browser_list_processes',
    {
      title: '列出浏览器进程',
      description:
        '枚举本机正在运行的浏览器进程，标出哪些可以通过 CDP 附加（需要 --remote-debugging-port）。Firefox/Safari 不走 CDP，会被标记为不可附加。',
      inputSchema: {
        includeChildren: z.boolean().optional().describe('是否包含 renderer/gpu 等子进程，默认 false'),
        filter: z.string().optional().describe('按浏览器名或命令行过滤'),
      },
    },
    async (args) =>
      guard(async () => {
        const result = await listBrowserProcesses({
          includeChildren: args.includeChildren ?? false,
          filter: args.filter,
        });
        const attachable = result.processes.filter((p) => p.attachable);
        return ok({
          platform: result.platform,
          total: result.processes.length,
          attachable: attachable.length,
          warnings: result.warnings,
          processes: result.processes.map((p) => ({
            pid: p.pid,
            display: p.display,
            family: p.family,
            process: p.process,
            debuggingPort: p.debuggingPort,
            debuggingPipe: p.debuggingPipe,
            userDataDir: p.userDataDir,
            attachable: p.attachable,
            reason: p.reason,
            commandLine: p.commandLine,
          })),
          hint: attachable.length
            ? `可用 browser_connect（port=${attachable[0].debuggingPort}）附加，或用 browser_launch 启动新实例。`
            : '没有可直接附加的进程，请用 browser_launch 启动一个带调试端口的实例。',
        });
      }),
  );

  server.registerTool(
    'browser_discover',
    {
      title: '扫描调试端口',
      description: '扫描本机的 DevTools HTTP 端点（默认 9222–9235），找出已经开启远程调试的浏览器。',
      inputSchema: {
        host: z.string().optional().describe('目标主机，默认 127.0.0.1'),
        from: z.number().int().optional().describe('起始端口，默认 9222'),
        to: z.number().int().optional().describe('结束端口，默认 9235'),
        ports: z.array(z.number().int()).optional().describe('额外要探测的端口'),
      },
    },
    async (args) =>
      guard(async () => {
        const found = await discoverBrowsers({
          host: args.host,
          from: args.from,
          to: args.to,
          ports: args.ports,
        });
        return ok({
          count: found.length,
          browsers: found,
          hint: found.length
            ? '用 browser_connect 附加，或直接调用其它抓取类工具（会自动连接第一个）。'
            : '没有发现可用端点，可用 browser_launch 启动一个。',
        });
      }),
  );

  server.registerTool(
    'browser_launch',
    {
      title: '启动浏览器',
      description:
        '以独立 user-data-dir 启动一个带远程调试端口的 Chromium 浏览器（不污染你的个人配置），默认立即附加会话。',
      inputSchema: {
        kind: z.enum(['chrome', 'edge', 'brave', 'chromium', 'opera', 'vivaldi', 'auto']).optional(),
        executable: z.string().optional().describe('浏览器可执行文件绝对路径，优先级高于 kind'),
        port: z.number().int().optional().describe('调试端口，缺省自动挑选空闲端口'),
        host: z.string().optional(),
        headless: z.boolean().optional().describe('是否使用 --headless=new'),
        url: z.string().optional().describe('启动后打开的 URL'),
        userDataDir: z.string().optional().describe('指定持久化 profile 目录；缺省用临时目录'),
        keepProfile: z.boolean().optional().describe('关闭后保留临时 profile，默认 false'),
        args: z.array(z.string()).optional().describe('额外的 Chromium 启动参数'),
        attach: z.boolean().optional().describe('是否启动后自动附加会话，默认 true'),
        targetId: z.string().optional().describe('附加后要切换到的标签页'),
        watchAllTargets: z.boolean().optional().describe('是否为所有标签页（含之后新开的）都开启抓取，默认 false'),
      },
    },
    async (args) =>
      guard(async () => {
        const launched = await hub.launch({
          kind: args.kind,
          executable: args.executable,
          port: args.port,
          host: args.host,
          headless: args.headless,
          url: args.url,
          userDataDir: args.userDataDir,
          keepProfile: args.keepProfile,
          args: args.args,
          attach: args.attach,
          targetId: args.targetId,
          watchAllTargets: args.watchAllTargets,
        });
        return ok({
          launched,
          targetId: hub.activeTargetId,
          hint: `已启动并附加 ${launched.display}（端口 ${launched.port}）。可用 browser_close 关掉它。`,
        });
      }),
  );

  server.registerTool(
    'browser_connect',
    {
      title: '连接浏览器',
      description: '附加到已开启调试端口的浏览器实例（或给定完整 WebSocket 地址），建立 CDP 会话。',
      inputSchema: {
        port: z.number().int().optional().describe('调试端口；省略时自动扫描'),
        host: z.string().optional(),
        webSocketUrl: z.string().optional().describe('完整 browser WebSocket 地址，优先于 port'),
        targetId: z.string().optional().describe('要切换到的标签页 ID；省略时自动选第一个可用页面'),
        autoAttach: z.boolean().optional().describe('是否自动附加页面，默认 true'),
        watchAllTargets: z
          .boolean()
          .optional()
          .describe('连到浏览器后是否为所有标签页（含之后新开的）都开启抓取，默认 false 只抓当前页'),
      },
    },
    async (args) =>
      guard(async () => {
        const result = await hub.connect({
          port: args.port,
          host: args.host,
          webSocketUrl: args.webSocketUrl,
          targetId: args.targetId,
          autoAttach: args.autoAttach,
          watchAllTargets: args.watchAllTargets,
        });
        return ok({
          ...result,
          hint: result.targetId
            ? '会话已就绪，可直接调用 console_read / network_list / capture_save 等工具。'
            : '已连接但没有附加页面，请用 target_select。',
        });
      }),
  );

  server.registerTool(
    'browser_close',
    {
      title: '关闭连接或浏览器',
      description: '断开当前 CDP 会话；可选按端口关闭由本服务启动的浏览器实例，或全部关闭。',
      inputSchema: {
        port: z.number().int().optional().describe('要关闭的已启动实例端口'),
        killBrowser: z.boolean().optional().describe('同时关闭当前连接对应的已启动实例'),
        closeAll: z.boolean().optional().describe('关闭本服务启动的所有实例'),
      },
    },
    async (args) =>
      guard(async () => {
        const result = await hub.closeSession({
          port: args.port,
          killBrowser: args.killBrowser,
          closeAllBrowsers: args.closeAll,
        });
        return ok({
          sessionClosed: result.session,
          browsersClosed: result.browsers,
          running: hub.launcher.list(),
          hint: '关闭浏览器会连带结束它的所有标签页；会话断开本身不会关闭浏览器。',
        });
      }),
  );

  server.registerTool(
    'browser_installed',
    {
      title: '查找已安装浏览器',
      description: '列出本机已安装的 Chromium 系浏览器及其可执行文件路径，供 browser_launch 使用。',
      inputSchema: {},
    },
    async () =>
      guard(async () => ok({ browsers: listInstalledBrowsers() })),
  );

  server.registerTool(
    'target_list',
    {
      title: '列出标签页',
      description:
        '列出当前浏览器中可附加的页面。默认隐藏扩展页 / service worker / devtools 等后台目标（Edge、Chrome 装着扩展时这类目标往往有十几个），需要全量时把 includeBackground 设为 true。',
      inputSchema: {
        includeBackground: z
          .boolean()
          .optional()
          .describe('是否包含扩展页、service worker、offscreen 文档等后台目标，默认 false'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = await hub.ensureSession();
        const all = await session.listTargets();
        const hidden = args.includeBackground ? [] : all.filter((t) => !isRealPage(t));
        // Showing an empty list would read as "this browser has no pages at all",
        // so fall back to everything when the filter would hide every target.
        const visible = args.includeBackground || all.length === hidden.length ? all : all.filter((t) => isRealPage(t));
        const hiddenCount = all.length - visible.length;
        return ok({
          activeTargetId: session.targetId,
          count: visible.length,
          totalTargets: all.length,
          hiddenBackground: hiddenCount,
          targets: visible.map((t) => ({ id: t.id, type: t.type, title: t.title, url: t.url, attached: t.attached })),
          hint: args.includeBackground
            ? '用 target_select 切换抓取对象。'
            : hiddenCount > 0
              ? `已隐藏 ${hiddenCount} 个后台目标（扩展页 / service worker 等），传 includeBackground: true 查看全部。`
              : '用 target_select 切换抓取对象。',
        });
      }),
  );

  server.registerTool(
    'target_select',
    {
      title: '切换标签页',
      description: '附加到指定标签页并把它设为当前抓取对象；后续 console / network / DOM 工具都作用在这个页面上。',
      inputSchema: {
        targetId: z.string().describe('目标 ID，可用 target_list 查看'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = await hub.ensureSession();
        const target = await session.selectTarget(args.targetId);
        return ok({
          activeTargetId: session.targetId,
          target,
          hint: '该页面此后的 console / network 会被记录到此会话；历史数据可用 console_clear 清空。',
        });
      }),
  );

  server.registerTool(
    'session_info',
    {
      title: '会话状态',
      description: '查看当前会话的连接信息、目标页、缓冲计数与告警。常用于判断“现在到底连着谁”。',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const session = hub.activeSession;
        if (!session) {
          return ok({
            connected: false,
            hint: '当前没有会话。调用 browser_connect 或 browser_launch 建立连接。',
            launched: hub.launcher.list(),
          });
        }
        const targets = await session.listTargets();
        return ok({
          connected: true,
          meta: session.meta,
          counts: session.counts(),
          targets: targets.map((t) => ({ id: t.id, title: t.title, url: t.url, attached: t.attached })),
          warnings: session.warnings,
        });
      }),
  );

  server.registerTool(
    'session_dump',
    {
      title: '导出原始会话数据',
      description: '把当前缓冲里的全部数据按 CapturedData 结构返回（不做落盘），适合你想自己加工时用。',
      inputSchema: {
        includeDom: z.boolean().optional(),
        includeScreenshot: z.boolean().optional(),
        includePerformance: z.boolean().optional(),
        includeStorage: z.boolean().optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const session = await hub.ensureSession();
        const data = { ...session.snapshot() };
        if (args.includeDom) data.dom = await session.getDom();
        if (args.includeScreenshot) data.screenshot = await session.screenshot();
        if (args.includePerformance) data.performance = await session.performance();
        if (args.includeStorage) data.storage = await session.storage();
        return ok(data);
      }),
  );
}
