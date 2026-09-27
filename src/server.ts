import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BrowserHub } from './hub.js';
import { serializeEvent, type Subscription } from './live/manager.js';
import { registerBrowserTools } from './tools/browser.js';
import { registerCaptureTools } from './tools/capture.js';
import { registerContentTools } from './tools/content.js';
import { registerLiveTools } from './tools/live.js';

/** Notification method used to push live events towards the client. */
export const LIVE_EVENTS_NOTIFICATION = 'notifications/browser-devtools/events';

export interface CreateServerOptions {
  version?: string;
  captureRoot?: string;
  /** Share one hub across several server instances (used by the HTTP transport). */
  hub?: BrowserHub;
}

export interface ServerBundle {
  server: McpServer;
  hub: BrowserHub;
}

export function createServer(options: CreateServerOptions = {}): ServerBundle {
  const hub = options.hub ?? new BrowserHub({ captureRoot: options.captureRoot });
  const server = new McpServer(
    { name: 'browser-devtools-mcp', version: options.version ?? '0.1.0' },
    { capabilities: { tools: {}, prompts: {}, logging: {} } },
  );

  registerBrowserTools(server, hub);
  registerContentTools(server, hub);
  registerCaptureTools(server, hub);
  registerLiveTools(server, hub);
  wireLivePush(server, hub);
  registerPrompts(server);

  return { server, hub };
}

/**
 * Ship events to whoever is listening on the transport.
 *
 * Push is best effort: plenty of clients ignore notifications they do not know,
 * and Streamable HTTP can only push while a GET stream is open. When sending
 * fails we switch that subscription to `none` and let the caller fall back to
 * `events_wait`, which never loses data because everything is buffered anyway.
 */
function wireLivePush(server: McpServer, hub: BrowserHub): void {
  hub.live.pushHandler = async (subscription: Subscription, events) => {
    const payload = events.map((event) => serializeEvent(event, false));
    const cursor = payload.length ? Number(payload[payload.length - 1]?.cursor ?? 0) : 0;

    try {
      if (subscription.options.push === 'logging') {
        await server.server.notification({
          method: 'notifications/message',
          params: {
            level: 'info',
            logger: 'browser-devtools',
            data: { subscriptionId: subscription.id, cursor, count: payload.length, events: payload },
          },
        });
        return;
      }
      await server.server.notification({
        method: LIVE_EVENTS_NOTIFICATION,
        params: { subscriptionId: subscription.id, cursor, count: payload.length, events: payload },
      });
    } catch {
      subscription.options.push = 'none';
    }
  };
}

function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'diagnose_page',
    {
      title: '排查页面问题',
      description: '按固定顺序抓取 console、错误与网络失败，最后生成一份诊断结论与产物。',
      argsSchema: {
        url: z.string().optional().describe('可选：先打开的页面地址'),
        reload: z.boolean().optional().describe('是否先刷新页面以便抓到加载期数据，默认 true'),
      },
    },
    (args) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              '请按下面的顺序排查当前页面，并在最后给出结论：',
              args.url ? `1. 用 browser_launch（或 browser_connect）确保会话就绪，并打开 ${args.url}。` : '1. 用 browser_connect / session_info 确认当前已连到目标页面。',
              args.reload === false ? '2. 跳过刷新，直接读取现有数据。' : '2. 刷新页面（page_evaluate 执行 location.reload()），确保能捕获加载期的请求与报错。',
              '3. page_errors 看异常，console_read 看日志，network_list 看 4xx/5xx 与失败请求。',
              '4. 对可疑请求用 network_detail / network_body 深入，必要时 performance_metrics 与 storage_read。',
              '5. capture_save 落盘，告诉我 report.html 与 network.har 的路径，然后给出根因判断与修复建议。',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'monitor_live',
    {
      title: '实时盯页面',
      description: '订阅实时事件流，持续观察一段时间内的日志、请求、性能指标与画面变化，最后给出观察结论。',
      argsSchema: {
        seconds: z.number().optional().describe('要盯多少秒，默认 20'),
        reload: z.boolean().optional().describe('是否先刷新页面以便看到加载全过程，默认 true'),
        frames: z.boolean().optional().describe('是否同时订阅页面实时画面帧，默认 false'),
      },
    },
    (args) => {
      const seconds = Math.min(Math.max(Math.floor(args.seconds ?? 20), 1), 300);
      const frames = Boolean(args.frames);
      const reload = args.reload !== false;
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                `请实时盯住当前页面约 ${seconds} 秒，并按下面的步骤做：`,
                '1. 用 browser_connect（必要时先 browser_launch）确保会话已就绪。',
                reload ? '2. events_subscribe 建立订阅（需要画面时传 frames 参数），再执行 location.reload() 触发加载。' : '2. events_subscribe 建立订阅，直接观察现有活动。',
                frames ? '3. 若订阅了画面帧，需要看图时用 events_wait 并传 includeFrameData=true。' : '3. 反复调用 events_wait（带上次返回的 cursor），把新事件累计记录下来。',
                `4. 累计观察满 ${seconds} 秒后停止循环。`,
                '5. 汇总：出现了哪些错误/失败请求、请求耗时分布、console 关键输出、指标趋势，必要时 capture_save 落盘后给出结论。',
                '6. 最后 events_unsubscribe（或 recording_stop）收尾。',
              ].join('\n'),
            },
          },
        ],
      };
    },
  );
}
