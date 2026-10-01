import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BrowserHub } from '../hub.js';
import { guard, ok } from './support.js';

/**
 * Real runtime interaction: a raw CDP pass-through plus genuine input events
 * (mouse / keyboard / text) dispatched through the `Input` domain. These replace
 * in-page `dispatchEvent` synthesis, which many engines (games, canvas, video)
 * ignore because the synthesised events carry no real input pipeline metadata.
 */
export function registerInteractionTools(server: McpServer, hub: BrowserHub): void {
  server.registerTool(
    'cdp_send',
    {
      title: '发送任意 CDP 命令',
      description:
        '向页面（默认）或浏览器（browserLevel）发送任意 Chrome DevTools Protocol 命令，返回完整结果。一次性解锁 Emulation.setDeviceMetricsOverride、Page.bringToFront、Input.dispatchKeyEvent、DOM.focus 等未单独封装的能力。',
        inputSchema: {
          method: z.string().describe('CDP 方法名，例如 "Emulation.setDeviceMetricsOverride" 或 "Input.dispatchKeyEvent"'),
        params: z.record(z.any()).optional().describe('命令参数对象'),
        sessionId: z.string().optional().describe('显式指定页面会话 ID；省略则用当前附加页'),
        browserLevel: z.boolean().optional().describe('为 true 时命令发往浏览器根（不带 sessionId），如 Target.* / Browser.*'),
        timeoutMs: z.number().int().optional().describe('命令超时（毫秒），默认 15000'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = await hub.ensureSession();
        const result = await session.cdpSend(args.method, (args.params ?? {}) as Record<string, unknown>, {
          sessionId: args.sessionId,
          browserLevel: args.browserLevel,
          timeoutMs: args.timeoutMs,
        });
        return ok({
          method: args.method,
          browserLevel: Boolean(args.browserLevel),
          result,
          hint: '返回的是 CDP 原始响应。复杂结果可能较大。',
        });
      }),
  );

  server.registerTool(
    'page_click',
    {
      title: '点击页面',
      description:
        '在视口坐标或 CSS 选择器中心点击鼠标（真实 Input.dispatchMouseEvent，press+release）。用于游戏/Canvas/表单等合成事件无效的场景。',
      inputSchema: {
        selector: z.string().optional().describe('要点击的元素 CSS 选择器；命中后自动滚动到视野中心并取其中心'),
        x: z.number().describe('视口 X 坐标（与 selector 二选一）'),
        y: z.number().describe('视口 Y 坐标（与 selector 二选一）'),
        button: z.enum(['left', 'middle', 'right']).optional().describe('鼠标键，默认 left'),
        double: z.boolean().optional().describe('是否双击（clickCount=2）'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = await hub.ensureSession();
        const at = await session.mouseClick({
          selector: args.selector,
          x: args.x,
          y: args.y,
          button: args.button,
          double: args.double,
        });
        return ok({
          clicked: true,
          ...at,
          hint: args.selector ? `已对 "${args.selector}" 中心发起点击` : '已在指定坐标发起点击',
        });
      }),
  );

  server.registerTool(
    'page_key',
    {
      title: '按键 / 按住 / 松开',
      description:
        '通过 Input.dispatchKeyEvent 发送真实键盘事件。action=press（默认）为按下并松开；action=down 仅按下（按住，可跨多帧，适合游戏移动）；action=up 仅松开。',
      inputSchema: {
        key: z.string().describe('按键，如 "d"、"Enter"、"ArrowUp"、" "（空格）'),
        code: z.string().optional().describe('CDP code，如 "KeyD"；省略时按 key 自动推导'),
        modifiers: z.number().int().optional().describe('修饰键位掩码：1=Alt 2=Ctrl 4=Meta 8=Shift'),
        action: z.enum(['press', 'down', 'up']).optional().describe('press=按下并松开（默认），down=仅按下，up=仅松开'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = await hub.ensureSession();
        await session.keyDispatch({
          key: args.key,
          code: args.code,
          modifiers: args.modifiers,
          action: args.action,
        });
        return ok({
          key: args.key,
          code: args.code ?? '(auto)',
          action: args.action ?? 'press',
          hint: args.action === 'down' ? '已按下并保持；需要时再用 action=up 松开' : '已发送键盘事件',
        });
      }),
  );

  server.registerTool(
    'page_type',
    {
      title: '输入文本',
      description: '通过 Input.insertText 在当前焦点处输入文本（与真实打字一致，IME 无关），用于表单、聊天框等。',
      inputSchema: {
        text: z.string().describe('要输入的文本'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = await hub.ensureSession();
        await session.typeText(args.text);
        return ok({ typed: args.text.length });
      }),
  );

  server.registerTool(
    'page_wait_for',
    {
      title: '等待页面就绪',
      description:
        '轮询直到某个 CSS 选择器出现、页面文本包含某串、或某段 JS 表达式返回真。替代手写固定 sleep，可靠性更高。',
      inputSchema: {
        selector: z.string().optional().describe('等待出现的选择器（与 text / predicate 三选一）'),
        text: z.string().optional().describe('等待页面文本包含该串（与 selector / predicate 三选一）'),
        predicate: z.string().optional().describe('等待返回真值的 JS 表达式，如 "window.ready === true" 或 "(() => window.ready)()"'),
        timeoutMs: z.number().int().optional().describe('最大等待时间（毫秒），默认 10000'),
        pollMs: z.number().int().optional().describe('轮询间隔（毫秒），默认 250'),
      },
    },
    async (args) =>
      guard(async () => {
        const session = await hub.ensureSession();
        if (!args.selector && !args.text && !args.predicate) {
          return ok({ matched: false, timedOut: false, error: 'selector / text / predicate 至少给一个' });
        }
        const res = await session.waitFor({
          selector: args.selector,
          text: args.text,
          predicate: args.predicate,
          timeoutMs: args.timeoutMs,
          pollMs: args.pollMs,
        });
        return ok({
          ...res,
          hint: res.matched ? '条件已满足' : '等待超时：条件在限定时间内未满足',
        });
      }),
  );

  server.registerTool(
    'page_reload',
    {
      title: '刷新页面',
      description: '通过 Page.reload 重新加载当前页面（比 page_evaluate 执行 location.reload() 更可靠）。',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const session = await hub.ensureSession();
        await session.reload();
        return ok({ reloaded: true });
      }),
  );

  server.registerTool(
    'page_back',
    {
      title: '浏览器后退',
      description: '在当前标签页执行 history.back() 返回上一页。',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const session = await hub.ensureSession();
        await session.navigateBack();
        return ok({ navigated: 'back' });
      }),
  );
}
