import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BrowserHub } from '../hub.js';
import type { ResourceTreeNode } from '../types.js';
import { bodyLooksComplete } from '../capture/session.js';
import { clipText, guard, ok } from './support.js';

/** Console, network, DOM, evaluation, screenshot, metrics and storage readers. */
export function registerContentTools(server: McpServer, hub: BrowserHub): void {
  server.registerTool(
    'console_read',
    {
      title: '读取 console 日志',
      description:
        '读取已捕获的 console 输出，支持按级别、关键字、时间、来源页过滤。适用于排查报错、定位日志来源。',
      inputSchema: {
        level: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe('级别过滤：log/debug/info/warn/error/trace 等，可传数组'),
        search: z.string().optional().describe('文本包含匹配'),
        limit: z.number().int().optional().describe('最多返回条数，默认 200'),
        since: z.number().optional().describe('仅返回该时间戳（epoch ms）之后的条目'),
        errorsOnly: z.boolean().optional().describe('只要 error 级别与异常'),
        targetId: z.string().optional().describe('限定某个标签页'),
        format: z.enum(['json', 'lines']).optional().describe('输出格式，默认 json'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = await hub.ensureSession({ targetId: args.targetId });
        const entries = session.store.listConsole({
          level: args.level as never,
          search: args.search,
          limit: args.limit ?? 200,
          since: args.since,
          errorsOnly: args.errorsOnly,
          targetId: args.targetId,
        });

        if (args.format === 'lines') {
          const text = entries
            .map((e) => `${new Date(e.time).toLocaleTimeString('zh-CN', { hour12: false })} [${e.level}] ${e.text}`)
            .join('\n');
          const clipped = clipText(text, 40_000);
          return ok({
            count: entries.length,
            total: session.counts().console,
            truncated: clipped.truncated,
            lines: clipped.text,
          });
        }

        return ok({
          count: entries.length,
          total: session.counts().console,
          target: { id: session.targetId, title: session.meta.targetTitle, url: session.meta.targetUrl },
          entries,
          hint: entries.length === 0 ? '缓冲区为空：确认页面已刷新/触发输出，或用 capture_start 重新计数。' : undefined,
        });
      }),
  );

  server.registerTool(
    'console_clear',
    {
      title: '清空 console 缓冲',
      description: '清空当前会话缓冲的 console 数据（不影响已经落盘的产物）。',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const session = await hub.ensureSession();
        const before = session.counts().console;
        session.store.clear();
        return ok({ cleared: before, hint: 'console 缓冲已清空（错误与网络记录也会被清掉）。' });
      }),
  );

  server.registerTool(
    'network_list',
    {
      title: '列出网络请求',
      description:
        '列出捕获到的网络请求，可按 URL 关键字、方法、资源类型、状态码过滤，也可只看失败或 4xx/5xx。',
      inputSchema: {
        search: z.string().optional().describe('URL 包含匹配'),
        method: z.string().optional().describe('HTTP 方法，如 GET/POST'),
        type: z.string().optional().describe('资源类型：document/script/xhr/fetch/image 等'),
        status: z
          .union([z.number().int(), z.enum(['failed', 'error'])])
          .optional()
          .describe('状态码，或 failed/error 表示只要失败'),
        limit: z.number().int().optional().describe('最多返回条数，默认 200'),
        since: z.number().optional().describe('仅返回该时间戳之后的请求'),
        failuresOnly: z.boolean().optional().describe('只要加载失败的请求'),
        httpErrorsOnly: z.boolean().optional().describe('只要 4xx/5xx'),
        targetId: z.string().optional(),
      },
    },
    async (args) =>
      guard(async () => {
        const session = await hub.ensureSession({ targetId: args.targetId });
        const entries = session.store.listNetwork({
          search: args.search,
          method: args.method,
          type: args.type,
          status: args.status as never,
          limit: args.limit ?? 200,
          since: args.since,
          failuresOnly: args.failuresOnly,
          httpErrorsOnly: args.httpErrorsOnly,
          targetId: args.targetId,
        });

        return ok({
          count: entries.length,
          total: session.counts().network,
          entries: entries.map((e) => ({
            id: e.id,
            seq: e.seq,
            time: new Date(e.time).toISOString(),
            method: e.method,
            url: e.url,
            status: e.status,
            statusText: e.statusText,
            type: e.type,
            mimeType: e.mimeType,
            durationMs: e.durationMs,
            encodedDataLength: e.encodedDataLength,
            fromCache: e.fromCache,
            failed: e.failed,
            errorText: e.errorText,
            finished: e.finished,
          })),
          hint: '要看请求/响应头与 POST body 用 network_detail，要响应体用 network_body。',
        });
      }),
  );

  server.registerTool(
    'network_detail',
    {
      title: '查看单个请求详情',
      description: '按 requestId 查看单个请求的完整信息：请求头、响应头、Post body、timing、initiator、cookie 等。',
      inputSchema: {
        requestId: z.string().describe('CDP requestId，可用 network_list 获取'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = await hub.ensureSession();
        const entry = session.store.getNetwork(args.requestId);
        if (!entry) {
          return ok({
            found: false,
            requestId: args.requestId,
            hint: '缓冲区里没有这个请求：可能已被环形缓冲淘汰，或还没发生。用 network_list 查现有 id。',
          });
        }
        const { _cdpStart: _start, _cdpEnd: _end, ...rest } = entry;
        return ok({ found: true, ...rest });
      }),
  );

  server.registerTool(
    'network_body',
    {
      title: '获取响应体',
      description: '取指定请求的响应体内容（文本）。二进制响应建议结合 mimeType 自行判断是否需要 base64。',
      inputSchema: {
        requestId: z.string(),
        maxChars: z.number().int().optional().describe('最多返回字符数，默认 20000'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = await hub.ensureSession();
        const entry = session.store.getNetwork(args.requestId);
        const result = await session.networkBody(args.requestId);
        if (result.unavailable) {
          return ok({
            requestId: args.requestId,
            available: false,
            hint: '浏览器没有保留该响应体（通常是页面已导航、请求过大或已被清理）。',
          });
        }
        const clipped = clipText(result.body, args.maxChars ?? 20_000);
        const partial = bodyLooksComplete(result, entry) === false;
        return ok({
          requestId: args.requestId,
          url: entry?.url,
          mimeType: entry?.mimeType,
          status: entry?.status,
          base64Encoded: result.base64Encoded,
          truncated: clipped.truncated,
          partial,
          hint: partial
            ? '这个请求还没加载完，收到的是半截内容。请等 finish 后再取，或改用 resources_get（会自动等待并按完整资源返回）。'
            : undefined,
          body: clipped.text,
        });
      }),
  );

  server.registerTool(
    'network_clear',
    {
      title: '清空网络缓冲',
      description: '清空当前会话缓冲的网络请求记录。',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const session = await hub.ensureSession();
        const before = session.counts();
        session.store.clear();
        return ok({ cleared: before, hint: 'console / network / errors 缓冲已全部清空。' });
      }),
  );

  server.registerTool(
    'page_errors',
    {
      title: '页面错误列表',
      description: '列出捕获到的未捕获异常、console.error、日志错误与渲染进程崩溃，含 URL 与调用栈。',
      inputSchema: {
        limit: z.number().int().optional().describe('最多返回条数，默认 100'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = await hub.ensureSession();
        const errors = session.store.listErrors(args.limit ?? 100);
        return ok({
          count: errors.length,
          total: session.counts().errors,
          errors,
          hint: errors.length ? undefined : '没有捕获到错误。注意该错误表记录的是“会话开始之后”发生的异常。',
        });
      }),
  );

  server.registerTool(
    'page_dom',
    {
      title: '抓取页面 DOM',
      description:
        '获取当前页面的 DOM：可返回原始 HTML、适合 LLM 阅读的缩进结构大纲，或两者。默认 both，并自动截断超长 HTML。',
      inputSchema: {
        mode: z.enum(['html', 'outline', 'both']).optional().describe('输出内容，默认 both'),
        depth: z.number().int().optional().describe('大纲层级深度，默认 4'),
        maxNodes: z.number().int().optional().describe('大纲最多节点数，默认 800'),
        maxHtmlChars: z.number().int().optional().describe('HTML 最大字符数，默认 50000'),
        maxTextLength: z.number().int().optional().describe('大纲里文本节点的最大长度，默认 60'),
        skipHidden: z.boolean().optional().describe('是否跳过 script/style/noscript，默认 true'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = await hub.ensureSession();
        const snapshot = await session.getDom({
          mode: args.mode ?? 'both',
          depth: args.depth,
          maxNodes: args.maxNodes,
          maxHtmlChars: args.maxHtmlChars ?? 50_000,
          maxTextLength: args.maxTextLength,
          skipHidden: args.skipHidden,
        });
        return ok({
          url: snapshot.url,
          title: snapshot.title,
          capturedAt: new Date(snapshot.capturedAt).toISOString(),
          nodeCount: snapshot.nodeCount,
          truncated: snapshot.truncated,
          htmlLength: snapshot.html?.length ?? 0,
          html: snapshot.html,
          outline: snapshot.outline,
          hint: 'outline 是精简版结构，适合快速理解页面；html 是完整快照，可能已被截断。',
        });
      }),
  );

  server.registerTool(
    'page_evaluate',
    {
      title: '执行 JavaScript',
      description: '在当前页面上下文执行一段 JavaScript 并返回结果（支持 await Promise），等价于 DevTools Console。',
      inputSchema: {
        expression: z.string().describe('要执行的 JS 表达式或语句'),
        awaitPromise: z.boolean().optional().describe('是否等待返回的 Promise，默认 true'),
        returnByValue: z.boolean().optional().describe('是否按值返回，默认 true'),
        timeoutMs: z.number().int().optional().describe('执行超时（毫秒），默认 30000；长任务可调大避免被砍断'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = await hub.ensureSession();
        const result = await session.evaluate(args.expression, {
          awaitPromise: args.awaitPromise,
          returnByValue: args.returnByValue,
          timeoutMs: args.timeoutMs,
        });
        return ok({
          expression: args.expression,
          url: session.meta.targetUrl,
          text: result.text,
          type: result.type,
          exception: result.exception,
          value: result.value,
          hint: result.exception ? '表达式执行出错，见 exception 字段。' : undefined,
        });
      }),
  );

  server.registerTool(
    'page_screenshot',
    {
      title: '页面截图',
      description: '对当前页面截图。图片数据默认不回传（体积大），需要看图时把 returnBase64 设为 true。',
      inputSchema: {
        fullPage: z.boolean().optional().describe('是否尝试整页截图，默认 false'),
        format: z.enum(['png', 'jpeg', 'webp']).optional().describe('图片格式，默认 png'),
        quality: z.number().int().optional().describe('jpeg/webp 质量 0-100'),
        returnBase64: z.boolean().optional().describe('是否返回 base64 数据，默认 false'),
        maxBytes: z.number().int().optional().describe('返回 base64 的体积上限，默认 800000 字节'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = await hub.ensureSession();
        const shot = await session.screenshot({
          fullPage: args.fullPage,
          format: args.format,
          quality: args.quality,
        });
        const bytes = Math.ceil((shot.data.length * 3) / 4);
        const limit = args.maxBytes ?? 800_000;

        const payload: Record<string, unknown> = {
          targetId: shot.targetId,
          time: new Date(shot.time).toISOString(),
          format: shot.format,
          mimeType: shot.mimeType,
          width: shot.width,
          height: shot.height,
          bytes,
        };

        if (args.returnBase64) {
          if (bytes > limit) {
            payload.dataIncluded = false;
            payload.hint = `截图有 ${bytes} 字节，超过 ${limit} 上限，未回传。可用 capture_save 落盘后查看 report.html。`;
          } else {
            payload.dataIncluded = true;
            payload.data = shot.data;
          }
        } else {
          payload.dataIncluded = false;
          payload.hint = '未回传图片数据。需要给模型看图请传 returnBase64=true，或用 capture_save 落盘查看报告。';
        }

        return ok(payload);
      }),
  );

  server.registerTool(
    'resources_list',
    {
      title: '页面资源树（Sources 面板）',
      description:
        '返回开发者工具「源代码 / Sources > 页面」面板里那棵树：按 frame 分层，列出页面实际加载的全部资源（文档、样式表、脚本、图片、字体、音视频等），并交叉带上对应的 requestId / 状态码 / 大小。与 network_list 互补：这里给的是页面资源视角（含已进入页面但未必在 Network 缓冲里的资源），network_list 给的是 HTTP 请求视角。',
      inputSchema: {
        targetId: z.string().optional().describe('限定某个标签页，默认当前页'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = await hub.ensureSession({ targetId: args.targetId });
        const tree = await session.resourceTree();
        if (!tree.frame) {
          return ok({
            found: false,
            hint: '当前页面没有可取的资源树（可能正在导航或目标不是普通页面）。',
          });
        }
        const flatten = (node: ResourceTreeNode, path: string[] = []): unknown[] =>
          (node.childFrames ?? []).reduce<unknown[]>(
            (acc, child) => acc.concat(flatten(child, [...path, node.name])),
            [{ path: [...path, node.name].join(' / '), frame: node.name, url: node.url, mimeType: node.mimeType, resources: node.resources }],
          );
        return ok({
          found: true,
          frameCount: tree.frameCount,
          resourceCount: tree.resourceCount,
          frames: flatten(tree.frame),
          hint: '要读取某个资源的原始内容，用 resources_get 传它的 url（或用 network_body 传 requestId）。',
        });
      }),
  );

  server.registerTool(
    'resources_get',
    {
      title: '读取资源内容（按 URL）',
      description:
        '按 URL 读取页面资源的内容，等同于在开发者工具 Sources 面板里点开某个文件看源码。会自动采用 UTF-8 纠偏，避免无 charset 的中文文本变乱码。图片/音视频等二进制会返回 base64。',
      inputSchema: {
        url: z.string().describe('资源 URL，可用 resources_list 或 network_list 获取'),
        maxChars: z.number().int().optional().describe('最多返回字符数，默认 20000'),
        asBase64: z.boolean().optional().describe('强制按 base64 返回原始字节，适合图片/音视频'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = await hub.ensureSession();
        const result = await session.resourceBody(args.url, { asBase64: args.asBase64 });
        if (result.unavailable) {
          return ok({
            url: args.url,
            available: false,
            hint: '既没有可用的请求记录，页内重新拉取也失败了（可能跨域被拦截，或这个 URL 不是页面资源）。用 resources_list 确认 URL。',
          });
        }
        if (args.asBase64) {
          const bytes = result.base64Encoded
            ? Buffer.from(result.body, 'base64')
            : Buffer.from(result.body, 'utf8');
          const clipped = clipText(bytes.toString('base64'), args.maxChars ?? 20_000);
          return ok({
            url: args.url,
            requestId: result.requestId,
            mimeType: result.mimeType,
            status: result.status,
            bytes: bytes.length,
            source: result.source,
            base64Encoded: true,
            truncated: clipped.truncated,
            body: clipped.text,
          });
        }
        const clipped = clipText(result.body, args.maxChars ?? 20_000);
        return ok({
          url: args.url,
          requestId: result.requestId,
          mimeType: result.mimeType,
          status: result.status,
          source: result.source,
          base64Encoded: result.base64Encoded,
          truncated: clipped.truncated,
          body: clipped.text,
        });
      }),
  );

  server.registerTool(
    'performance_metrics',
    {
      title: '性能指标',
      description: '获取 Performance.getMetrics 指标，以及导航计时、绘制时间和 JS 堆占用。',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const session = await hub.ensureSession();
        const snapshot = await session.performance();
        return ok(snapshot);
      }),
  );

  server.registerTool(
    'storage_read',
    {
      title: '读取页面存储',
      description: '读取当前页面的 Cookies、localStorage、sessionStorage 与 IndexedDB 数据库名。',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const session = await hub.ensureSession();
        const snapshot = await session.storage();
        return ok({
          ...snapshot,
          counts: {
            cookies: snapshot.cookies.length,
            localStorage: Object.keys(snapshot.localStorage).length,
            sessionStorage: Object.keys(snapshot.sessionStorage).length,
          },
        });
      }),
  );
}
