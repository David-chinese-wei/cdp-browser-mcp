/**
 * 端到端冒烟：启动 stdio 服务 → 握手 → 列工具 → 真实启动浏览器 → 抓取 → 一键保存 → 校验产物。
 * 运行： node scripts/smoke.mjs                （默认挑第一个装了的浏览器）
 *       node scripts/smoke.mjs --browser=edge  （指定 Edge / chrome / brave ...）
 * 需要先 npm run build
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE = process.execPath;
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const entry = join(root, 'dist', 'index.js');

/** --browser=edge / --browser edge / --browser=auto，默认 auto（挑第一个装了的）。 */
const WANTED_BROWSER = (() => {
  const idx = process.argv.findIndex((a) => a === '--browser' || a.startsWith('--browser='));
  if (idx === -1) return 'auto';
  const arg = process.argv[idx];
  const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : process.argv[idx + 1];
  return (value || 'auto').trim();
})();

const failures = [];
let step = 0;

function stage(name) {
  step += 1;
  console.log(`\n[${step}] ${name}`);
}

function assert(condition, label, detail) {
  if (condition) {
    console.log(`    ok  ${label}`);
  } else {
    console.log(`    FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

function callText(result) {
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 起一个本地静态页：不依赖外网，且必定产生 document / script / fetch / 404 四种请求，
 * 外加 console 输出、未捕获异常与 localStorage 写入。
 */
async function startFixture() {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>冒烟测试页</title></head>
<body><h1>Smoke fixture</h1><p>hello from fixture</p><script src="/app.js"></script></body></html>`;

  const appJs = `console.log('hello from fixture');
fetch('/api/data').then(function (r) { return r.json(); }).then(function (d) { console.info('fixture got', d.ok); });
try { localStorage.setItem('smoke', 'on'); } catch (e) {}
setTimeout(function () { throw new Error('fixture boom'); }, 50);`;

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (url === '/app.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      res.end(appJs);
      return;
    }
    if (url === '/api/data') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': 'smoke=1; Path=/' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('missing');
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    server,
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((r) => server.close(r)),
  };
}

const transport = new StdioClientTransport({
  command: NODE,
  args: [entry],
  stderr: 'pipe',
  env: { ...process.env },
});

const client = new Client({ name: 'smoke-client', version: '1.0.0' }, { capabilities: {} });

let fixture = null;

try {
  console.log(`browser-devtools-mcp 端到端冒烟 — 目标浏览器: ${WANTED_BROWSER}`);
  stage('握手 (stdio)');
  await client.connect(transport);
  const serverInfo = client.getServerVersion();
  assert(Boolean(serverInfo?.name), 'server 返回了身份信息', JSON.stringify(serverInfo));
  console.log(`    server: ${serverInfo?.name} v${serverInfo?.version}`);

  stage('tools/list');
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  assert(tools.tools.length >= 20, `工具数量 >= 20（实际 ${tools.tools.length}）`);
  const required = [
    'browser_list_processes',
    'browser_discover',
    'browser_launch',
    'browser_connect',
    'browser_close',
    'target_list',
    'target_select',
    'console_read',
    'network_list',
    'page_dom',
    'page_evaluate',
    'page_screenshot',
    'performance_metrics',
    'storage_read',
    'capture_start',
    'capture_status',
    'capture_stop',
    'capture_save',
    'capture_list_saved',
    'events_subscribe',
    'events_wait',
    'events_read',
    'events_unsubscribe',
    'events_list',
    'recording_start',
    'recording_stop',
  ];
  const missing = required.filter((n) => !names.includes(n));
  assert(missing.length === 0, '设计中的工具都在', `缺失: ${missing.join(', ')}`);
  console.log(`    工具: ${names.join(', ')}`);

  stage('prompts/list');
  const prompts = await client.listPrompts();
  assert(prompts.prompts.some((p) => p.name === 'diagnose_page'), 'diagnose_page prompt 存在');

  stage('browser_list_processes（本机进程枚举）');
  const procs = callText(await client.callTool({ name: 'browser_list_processes', arguments: {} }));
  assert(typeof procs.total === 'number', `枚举到 ${procs.total} 个浏览器进程`);
  console.log(`    可附加: ${procs.attachable ?? 0}，平台: ${procs.platform}`);

  stage('browser_installed');
  const installed = callText(await client.callTool({ name: 'browser_installed', arguments: {} }));
  const browsers = installed.browsers ?? [];
  console.log(`    已安装: ${browsers.map((b) => b.display).join(', ') || '无'}`);

  let launched = null;

  if (WANTED_BROWSER !== 'auto') {
    const hit = browsers.find((b) => b.kind === WANTED_BROWSER);
    assert(Boolean(hit), `本机装有 ${WANTED_BROWSER}`, `实际可用: ${browsers.map((b) => b.kind).join(', ') || '无'}`);
    if (hit) console.log(`    指定浏览器: ${hit.display} → ${hit.executable}`);
  }

  if (!browsers.length || (WANTED_BROWSER !== 'auto' && !browsers.some((b) => b.kind === WANTED_BROWSER))) {
    console.log('    找不到指定的浏览器，跳过端到端抓取部分');
  } else {
    // 本地测试页：不依赖外网，且必定产生 document / script / fetch 三种请求。
    fixture = await startFixture();

    stage(`browser_launch（headless 启动 ${WANTED_BROWSER === 'auto' ? '默认' : WANTED_BROWSER} 实例）`);
    const launchRes = callText(
      await client.callTool({
        name: 'browser_launch',
        arguments: { headless: true, kind: WANTED_BROWSER },
      }),
    );
    launched = launchRes.launched;
    assert(Boolean(launched?.port), '浏览器已启动并暴露调试端口', JSON.stringify(launchRes).slice(0, 200));
    assert(Boolean(launchRes.targetId), '已自动附加到页面');
    if (WANTED_BROWSER !== 'auto') {
      assert(launched?.kind === WANTED_BROWSER, `启动的确实是 ${WANTED_BROWSER}`, `实际 ${launched?.kind}`);
    }
    console.log(`    浏览器: ${launched?.display} v${(launched?.executable ?? '').match(/\d+(\.\d+)+/)?.[0] ?? '?'} 端口 ${launched?.port}`);

    stage('session_info');
    const info = callText(await client.callTool({ name: 'session_info', arguments: {} }));
    assert(info.connected === true, '会话处于连接状态');

    stage('page_evaluate（执行 JS）');
    const evaluated = callText(
      await client.callTool({
        name: 'page_evaluate',
        arguments: { expression: '1 + 1', awaitPromise: false },
      }),
    );
    assert(String(evaluated.text) === '2', `1+1 = ${evaluated.text}`);

    stage('导航到本地测试页（验证网络 / DOM / 错误采集）');
    await client.callTool({
      name: 'capture_start',
      arguments: {},
    });
    await client.callTool({
      name: 'page_evaluate',
      arguments: { expression: `window.location.href = '${fixture.url}'`, awaitPromise: false },
    });
    await sleep(2500);

    stage('console_read / page_dom / metrics / storage');
    const consoleData = callText(await client.callTool({ name: 'console_read', arguments: { limit: 20 } }));
    assert(
      (consoleData.entries ?? []).some((e) => e.text.includes('hello from fixture')),
      '测试页的 console.log 被记录',
    );
    const errData = callText(await client.callTool({ name: 'page_errors', arguments: { limit: 10 } }));
    assert(
      (errData.errors ?? []).some((e) => e.text.includes('fixture boom')),
      '未捕获异常被记入 page_errors',
    );

    const dom = callText(await client.callTool({ name: 'page_dom', arguments: { mode: 'both', maxHtmlChars: 5000 } }));
    assert(Boolean(dom.outline), 'DOM 大纲非空');
    assert(Boolean(dom.html), 'DOM HTML 非空');

    const perf = callText(await client.callTool({ name: 'performance_metrics', arguments: {} }));
    assert(typeof perf.metrics === 'object', '性能指标已获取');

    const storage = callText(await client.callTool({ name: 'storage_read', arguments: {} }));
    assert(Array.isArray(storage.cookies), '存储读取完成');

    stage('network_list');
    const net = callText(await client.callTool({ name: 'network_list', arguments: { limit: 50 } }));
    const types = new Set((net.entries ?? []).map((e) => String(e.type ?? '').toLowerCase()));
    assert(net.total >= 3, `捕获到 ${net.total} 个网络请求`, '测试页至少应产生 document/script/xhr');
    assert(types.has('document') && types.has('script'), `资源类型覆盖正常：${[...types].join(', ')}`);
    assert(
      (net.entries ?? []).some((e) => e.status === 404),
      '捕获到 404 请求',
    );

    const docEntry = (net.entries ?? []).find((e) => e.type === 'document');
    if (docEntry) {
      const detail = callText(await client.callTool({ name: 'network_detail', arguments: { requestId: docEntry.id } }));
      assert(detail.found !== false, 'network_detail 返回了请求详情');
      assert(Boolean(detail.responseHeaders), '请求详情包含响应头');
      assert(typeof detail.durationMs === 'number', `请求耗时已计算：${detail.durationMs} ms`);
    }

    const apiEntry = (net.entries ?? []).find((e) => e.url.includes('/api/data'));
    if (apiEntry) {
      const body = callText(await client.callTool({ name: 'network_body', arguments: { requestId: apiEntry.id } }));
      assert(String(body.body ?? '').includes('ok'), `network_body 取回响应体：${body.body}`);
    }

    stage('capture_save（一键保存）');
    const saved = callText(
      await client.callTool({
        name: 'capture_save',
        arguments: { name: 'smoke-capture', includeScreenshot: true, includeDom: true },
      }),
    );
    assert(Boolean(saved.dir), `产物目录: ${saved.dir}`);
    const expected = ['session.json', 'console.json', 'console.csv', 'network.har', 'network.csv', 'report.html', 'summary.md', 'manifest.json', 'dom.html'];
    const produced = (saved.files ?? []).map((f) => f.name);
    const absent = expected.filter((f) => !produced.includes(f));
    assert(absent.length === 0, '列出了全部关键产物', `缺失: ${absent.join(', ')}`);

    for (const name of expected) {
      const path = join(saved.dir, name);
      assert(existsSync(path) && readFileSync(path, 'utf8').length > 0, `${name} 已落盘且非空`);
    }
    const har = JSON.parse(readFileSync(join(saved.dir, 'network.har'), 'utf8'));
    assert(har.log?.version === '1.2', 'HAR 版本号正确');
    assert(Array.isArray(har.log?.entries), `HAR 含 ${har.log?.entries?.length ?? 0} 条记录`);
    const report = readFileSync(join(saved.dir, 'report.html'), 'utf8');
    assert(report.includes('<!DOCTYPE html>') && !report.includes('http://cdn'), '报告自包含且无外部依赖');

    if (saved.dir.includes('smoke-capture')) rmSync(saved.dir, { recursive: true, force: true });

    stage('events_subscribe（实时事件流）');
    let pushedEvents = 0;
    client.fallbackNotificationHandler = async (notification) => {
      if (notification.method === 'notifications/browser-devtools/events') {
        pushedEvents += Number(notification.params?.count ?? 0);
      }
    };

    const subscription = callText(
      await client.callTool({
        name: 'events_subscribe',
        arguments: {
          channels: ['console', 'network', 'error', 'navigation', 'target'],
          performanceSampleMs: 500,
          push: 'notification',
        },
      }),
    );
    assert(Boolean(subscription.subscriptionId), `订阅创建成功：${subscription.subscriptionId}`);

    stage('events_wait（长轮询：实时事件流）');
    await client.callTool({
      name: 'page_evaluate',
      arguments: { expression: 'window.location.reload()', awaitPromise: false },
    });

    const seen = new Set();
    let cursor = 0;
    let rounds = 0;
    let streamed = 0;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const round = callText(
        await client.callTool({
          name: 'events_wait',
          arguments: { subscriptionId: subscription.subscriptionId, cursor, timeoutMs: 4000, limit: 200 },
        }),
      );
      rounds += 1;
      streamed += round.count ?? 0;
      for (const event of round.events ?? []) seen.add(`${event.channel}/${event.kind}`);
      cursor = Math.max(cursor, Number(round.cursor ?? cursor));
      const wanted = ['console/message', 'navigation/frame', 'network/request', 'network/finished'];
      if (wanted.every((k) => seen.has(k))) break;
    }

    console.log(`    事件类型: ${[...seen].join(', ')}`);
    assert(rounds > 0 && streamed > 0, `${rounds} 次长轮询累计拿到 ${streamed} 条实时事件`);
    assert([...seen].some((k) => k.startsWith('network/')), '实时抓到网络生命周期事件');
    assert(seen.has('console/message'), '实时抓到 console 输出');
    assert(seen.has('navigation/frame'), '实时抓到导航事件');

    stage('events_wait（游标续接：不重不漏）');
    const nextRound = callText(
      await client.callTool({
        name: 'events_wait',
        arguments: { subscriptionId: subscription.subscriptionId, cursor, timeoutMs: 3000, limit: 200 },
      }),
    );
    const replayed = (nextRound.events ?? []).filter((e) => e.cursor <= cursor);
    assert(replayed.length === 0, `续接未重放旧事件（本次新增 ${nextRound.count} 条）`);
    await sleep(1000);
    assert(pushedEvents > 0, `服务端主动向客户端推送了 ${pushedEvents} 条事件通知`);

    stage('events_wait（静默期超时返回）');
    const quietSubscription = callText(
      await client.callTool({
        name: 'events_subscribe',
        arguments: { channels: ['target'], push: 'none' },
      }),
    );
    // 先排掉订阅瞬间已存在的 target 事件，再验证“确实没动静时会按时返回”。
    const drained = callText(
      await client.callTool({
        name: 'events_wait',
        arguments: { subscriptionId: quietSubscription.subscriptionId, timeoutMs: 800 },
      }),
    );
    const quietWait = callText(
      await client.callTool({
        name: 'events_wait',
        arguments: { subscriptionId: quietSubscription.subscriptionId, cursor: drained.cursor, timeoutMs: 1500 },
      }),
    );
    assert(
      quietWait.waitedMs <= 2500,
      `静默时长轮询按时返回，没有挂死（等待 ${quietWait.waitedMs} ms，收到 ${quietWait.count} 条）`,
    );
    assert(
      quietWait.count === 0 ? quietWait.timedOut === true : true,
      '空等待标记为 timedOut，有事件则正常返回',
    );
    await client.callTool({ name: 'events_unsubscribe', arguments: { subscriptionId: quietSubscription.subscriptionId } });

    stage('events_list');
    const subs = callText(await client.callTool({ name: 'events_list', arguments: {} }));
    assert((subs.subscriptions ?? []).length >= 1, `当前有 ${subs.subscriptions?.length ?? 0} 个订阅`);

    stage('events_subscribe（页面实时画面帧）');
    const frameSubscription = callText(
      await client.callTool({
        name: 'events_subscribe',
        arguments: { channels: ['frame'], frames: { maxWidth: 400, quality: 40 }, buffer: 20 },
      }),
    );
    const frames = callText(
      await client.callTool({
        name: 'events_wait',
        arguments: {
          subscriptionId: frameSubscription.subscriptionId,
          timeoutMs: 15000,
          limit: 5,
          includeFrameData: true,
        },
      }),
    );
    assert(frames.count > 0, `拿到 ${frames.count} 帧页面画面`);
    const frameSample = (frames.events ?? []).find((e) => e.data?.dataIncluded);
    assert(Boolean(frameSample?.data?.data), '画面帧返回了 base64 数据');
    await client.callTool({ name: 'events_unsubscribe', arguments: { subscriptionId: frameSubscription.subscriptionId } });

    stage('recording_start / recording_stop（实时落盘）');
    const recording = callText(
      await client.callTool({
        name: 'recording_start',
        arguments: { name: 'smoke-live', saveFrames: true, performanceSampleMs: 500 },
      }),
    );
    await client.callTool({
      name: 'page_evaluate',
      arguments: {
        expression: `console.log('recording tick'); fetch('/no-such-endpoint');`,
        awaitPromise: false,
      },
    });
    await sleep(2000);
    const stopped = callText(
      await client.callTool({ name: 'recording_stop', arguments: { recordingId: recording.recordingId } }),
    );
    assert(existsSync(stopped.eventsPath), `JSONL 已写入 ${stopped.eventsPath}`);
    const lines = readFileSync(stopped.eventsPath, 'utf8').trim().split('\n').filter(Boolean);
    const recorded = lines.map((line) => JSON.parse(line));
    assert(recorded.length > 0, `录制到 ${recorded.length} 条事件`);
    assert(recorded.some((e) => e.channel === 'network'), '录制流包含网络事件');
    assert(recorded.some((e) => e.channel === 'frame'), '录制流包含画面帧');
    assert(recorded.some((e) => e.channel === 'metric'), '录制流包含性能采样');
    const frameDir = join(stopped.dir, 'frames');
    const frameFiles = readdirSync(frameDir);
    assert(frameFiles.length > 0, `画面帧落盘 ${frameFiles.length} 张图片`);
    if (stopped.dir.includes('smoke-live')) rmSync(stopped.dir, { recursive: true, force: true });

    await client.callTool({ name: 'events_unsubscribe', arguments: { subscriptionId: subscription.subscriptionId } });

    stage('browser_close');
    const closed = callText(await client.callTool({ name: 'browser_close', arguments: { port: launched.port, closeAll: true } }));
    assert(closed.browsersClosed >= 1, `已关闭 ${closed.browsersClosed} 个由服务启动的实例`);
  }

  stage('summary');
  const targetLabel = launched ? `${launched.display}（${launched.kind}，端口 ${launched.port}）` : WANTED_BROWSER;
  if (failures.length) {
    console.log(`\n✗ 冒烟失败 ${failures.length} 项（${targetLabel}）：\n  - ${failures.join('\n  - ')}`);
  } else {
    console.log(`\n✓ 全部冒烟用例通过（${targetLabel}）`);
  }
} catch (err) {
  console.error('\n冒烟过程中抛出异常:', err);
  failures.push(`exception: ${err.message}`);
} finally {
  await client.close().catch(() => {});
  if (fixture) await fixture.close().catch(() => {});
}

process.exit(failures.length ? 1 : 0);
