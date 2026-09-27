import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LIVE_CHANNELS } from '../capture/store.js';
import type { BrowserHub } from '../hub.js';
import { guard, ok } from './support.js';

const channelsSchema = z
  .array(z.enum(LIVE_CHANNELS as [string, ...string[]]))
  .optional()
  .describe('通道：console / network / error / navigation / target / metric / frame，省略表示全部');

const frameSchema = z
  .object({
    format: z.enum(['jpeg', 'png']).optional(),
    quality: z.number().int().min(1).max(100).optional(),
    maxWidth: z.number().int().optional(),
    maxHeight: z.number().int().optional(),
    everyNthFrame: z.number().int().min(1).optional(),
  })
  .optional();

/**
 * Real time tools: subscribe once, then either long poll (`events_wait`) or let
 * the server push events down the transport, plus persistent disk recording.
 */
export function registerLiveTools(server: McpServer, hub: BrowserHub): void {
  server.registerTool(
    'events_subscribe',
    {
      title: '订阅实时事件',
      description:
        '订阅实时事件流：所有新发生的 console 输出、网络请求（请求/响应/完成/失败）、异常、导航、标签页增减、性能指标采样与页面画面帧都会即时进入该订阅。返回 subscriptionId，之后用 events_wait（阻塞等待）或 events_read（立即取）消费。',
      inputSchema: {
        channels: channelsSchema,
        search: z.string().optional().describe('关键字过滤，命中 URL / 文本 / 载荷'),
        level: z.array(z.string()).optional().describe('console 级别过滤，如 ["error","warn"]'),
        targetId: z.string().optional().describe('只看某个标签页'),
        errorsOnly: z.boolean().optional().describe('只看错误与失败请求'),
        buffer: z.number().int().optional().describe('保留的最大事件数，默认 500（画面帧订阅默认 40）'),
        push: z
          .enum(['none', 'notification', 'logging'])
          .optional()
          .describe('是否主动向客户端推送通知，默认 notification（若客户端不支持会自动退化为轮询）'),
        maxEvents: z.number().int().optional().describe('匹配到这么多条后自动退订'),
        maxDurationMs: z.number().int().optional().describe('持续这么久后自动退订'),
        performanceSampleMs: z.number().int().optional().describe('每隔多少毫秒采样一次性能指标并产出 metric 事件'),
        frames: frameSchema.describe('订阅页面实时画面（Page.startScreencast），可配置画质与帧率'),
      },
    },
    async (args) =>
      guard(async () => {
        await hub.ensureSession();
        const subscription = await hub.live.subscribe({
          channels: args.channels as never,
          search: args.search,
          level: args.level as never,
          targetId: args.targetId,
          errorsOnly: args.errorsOnly,
          buffer: args.buffer,
          push: args.push as never,
          maxEvents: args.maxEvents,
          maxDurationMs: args.maxDurationMs,
          performanceSampleMs: args.performanceSampleMs,
          frames: args.frames,
        });

        return ok({
          subscriptionId: subscription.id,
          channels: [...subscription.channels],
          cursor: hub.activeSession?.store.liveCursor ?? 0,
          push: subscription.options.push ?? 'notification',
          performanceSampleMs: subscription.options.performanceSampleMs,
          frameCapture: subscription.options.frames,
          hint: [
            '订阅已生效，此刻起发生的一切都会被记录下来（即便你不读取，最近 buffer 条也保留着）。',
            '用 events_wait 阻塞等待新事件（服务端有数据立刻返回，超时说明这段时间没动静）；',
            '用 events_read 取快照不想等待；用完 events_unsubscribe。',
          ].join(''),
        });
      }),
  );

  server.registerTool(
    'events_wait',
    {
      title: '等待实时事件',
      description:
        '长轮询：等到有匹配的实时事件就立刻返回，最多等待 timeoutMs（默认 15 秒，上限 120 秒）。传入上次返回的 cursor 就不会漏也不会重。这是任何客户端都能用的实时消费方式。',
      inputSchema: {
        subscriptionId: z.string().describe('events_subscribe 返回的订阅 ID'),
        cursor: z.number().int().optional().describe('上次消费到的游标位置'),
        timeoutMs: z.number().int().optional().describe('最长等待毫秒数，默认 15000'),
        min: z.number().int().optional().describe('至少攒够几条才返回，默认 1'),
        limit: z.number().int().optional().describe('本次最多返回多少条，默认 50'),
        includeFrameData: z.boolean().optional().describe('画面帧事件是否包含 base64 数据，默认 false'),
      },
    },
    async (args) =>
      guard(async () => {
        const result = await hub.live.wait(args.subscriptionId, {
          cursor: args.cursor,
          timeoutMs: args.timeoutMs,
          min: args.min,
          limit: args.limit,
          includeFrameData: args.includeFrameData,
        });
        return ok({
          ...result,
          hint: result.count
            ? `拿到 ${result.count} 条新事件，下次用 cursor=${result.cursor} 继续。`
            : '这段时间没有匹配的新事件（不是出错）。可以继续等，或确认页面是否在活动。',
        });
      }),
  );

  server.registerTool(
    'events_read',
    {
      title: '读取实时事件快照',
      description: '立即读取订阅里已积累的实时事件，不等待。适合先看一眼再决定是否阻塞等待。',
      inputSchema: {
        subscriptionId: z.string(),
        cursor: z.number().int().optional().describe('只返回该游标之后的事件'),
        limit: z.number().int().optional().describe('最多返回条数，默认 50'),
        includeFrameData: z.boolean().optional(),
      },
    },
    async (args) =>
      guard(async () =>
        ok(
          hub.live.read(args.subscriptionId, {
            cursor: args.cursor,
            limit: args.limit,
            includeFrameData: args.includeFrameData,
          }),
        ),
      ),
  );

  server.registerTool(
    'events_unsubscribe',
    {
      title: '取消订阅',
      description: '结束订阅并释放缓冲。会自动停止没人用的性能采样与画面推流。',
      inputSchema: {
        subscriptionId: z.string(),
      },
    },
    async (args) =>
      guard(async () => {
        const closed = hub.live.unsubscribe(args.subscriptionId);
        if (!closed) return ok({ subscriptionId: args.subscriptionId, found: false, hint: '订阅不存在或已结束。' });
        return ok({ ...closed, found: true });
      }),
  );

  server.registerTool(
    'events_list',
    {
      title: '列出实时订阅',
      description: '列出所有订阅及其过滤条件、已匹配条数、缓冲条数与当前游标。',
      inputSchema: {
        includeHidden: z.boolean().optional().describe('是否包含内部订阅（磁盘录制用），默认 false'),
      },
    },
    async (args) =>
      guard(async () =>
        ok({
          count: hub.live.subscriptions.size,
          subscriptions: hub.live.list({ includeHidden: args.includeHidden }),
          hint: 'cursor 是当前会话事件流的位置；events_wait 传 cursor 可从该处继续。',
        }),
      ),
  );

  server.registerTool(
    'recording_start',
    {
      title: '开始实时录制到磁盘',
      description:
        '把实时事件流持续追加写入 JSONL 文件（每条一行），适合长时间监控而不怕内存爆掉；可同时把页面画面帧按序存成图片。用 recording_stop 结束并拿统计。',
      inputSchema: {
        name: z.string().optional().describe('输出目录名，缺省 live-<时间戳>'),
        dir: z.string().optional().describe('直接指定输出目录（绝对路径），优先于 name'),
        rootDir: z.string().optional().describe('输出根目录，缺省 <cwd>/captures'),
        saveFrames: z.boolean().optional().describe('是否把画面帧存到 frames/ 目录，默认 false'),
        channels: channelsSchema.describe('只录制指定通道，省略表示全部'),
        performanceSampleMs: z.number().int().optional().describe('同时开启性能采样写入事件流'),
      },
    },
    async (args) =>
      guard(async () => {
        const started = await hub.startRecording({
          name: args.name,
          dir: args.dir,
          rootDir: args.rootDir,
          saveFrames: args.saveFrames,
          channels: args.channels as never,
          performanceSampleMs: args.performanceSampleMs,
        });
        return ok({
          recordingId: started.id,
          dir: started.dir,
          eventsPath: started.eventsPath,
          hint: '正在实时写入 live-events.jsonl。结束后用 recording_stop 拿统计；配合 events_subscribe 可同时实时查看。',
        });
      }),
  );

  server.registerTool(
    'recording_stop',
    {
      title: '停止录制',
      description: '结束实时录制并输出统计信息与产物路径。',
      inputSchema: {
        recordingId: z.string().optional().describe('要停止的录制 ID；省略则停止全部'),
      },
    },
    async (args) =>
      guard(async () => {
        if (!args.recordingId) {
          const summaries = hub.stopAllRecordings();
          return ok({ stopped: summaries.length, recordings: summaries });
        }
        const summary = hub.stopRecording(args.recordingId);
        if (!summary) return ok({ recordingId: args.recordingId, found: false, hint: '没有这个录制，或已经停过了。' });
        return ok({ recordingId: args.recordingId, found: true, ...summary });
      }),
  );
}
