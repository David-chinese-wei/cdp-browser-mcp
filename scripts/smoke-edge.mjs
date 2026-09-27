/**
 * 有头浏览器专项验收：在真实有头实例上跑一遍，覆盖冒烟脚本没测到的场景：
 *
 *   1. 有头模式启动（headless=false，用户日常用的形态）
 *   2. 进程枚举能否识别目标浏览器进程并判断可附加
 *   3. browser_connect 附加到「已运行的」实例（而非 launch 自动附加）
 *   4. watchAllTargets：多标签页同时抓取，含之后新开的页
 *   5. 真实外部站点抓取 + 实时录制 + 一键保存
 *
 * 运行： node scripts/smoke-edge.mjs        （先 npm run build）
 *       node scripts/smoke-edge.mjs chrome  （同一套用例换浏览器）
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
const KIND = (process.argv[2] ?? 'edge').replace(/^--/, '') || 'edge';

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

function note(text) {
  console.log(`    ·  ${text}`);
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

/** 本地测试页：产生 document / script / fetch / 404 四类请求 + console + 未捕获异常。 */
async function startFixture() {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>验收页 A</title></head>
<body><h1>Page A</h1><script src="/a.js"></script></body></html>`;

  const pageB = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>验收页 B</title></head>
<body><h1>Page B</h1><script>console.log('hello from page B');</script></body></html>`;

  const appJs = `console.log('hello from page A');
fetch('/api/data').then(function (r) { return r.json(); }).then(function (d) { console.info('page A got', d.ok); });
setTimeout(function () { throw new Error('page A boom'); }, 50);`;

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (url === '/b') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pageB);
      return;
    }
    if (url === '/a.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      res.end(appJs);
      return;
    }
    if (url === '/api/data') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
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
    urlB: `http://127.0.0.1:${port}/b`,
    close: () => new Promise((r) => server.close(r)),
  };
}

const transport = new StdioClientTransport({
  command: NODE,
  args: [entry],
  stderr: 'pipe',
  env: { ...process.env },
});

const client = new Client({ name: 'edge-acceptance', version: '1.0.0' }, { capabilities: {} });

let fixture = null;
let launched = null;

try {
  console.log(`浏览器专项验收 — 目标: ${KIND}，有头模式`);

  stage('握手 (stdio)');
  await client.connect(transport);
  const serverInfo = client.getServerVersion();
  assert(Boolean(serverInfo?.name), 'server 返回身份信息');

  stage(`browser_installed（确认本机有 ${KIND}）`);
  const installed = callText(await client.callTool({ name: 'browser_installed', arguments: {} }));
  const browsers = installed.browsers ?? [];
  note(`已安装: ${browsers.map((b) => b.display).join(', ') || '无'}`);
  const target = browsers.find((b) => b.kind === KIND);
  assert(Boolean(target), `本机装有 ${KIND}`, `可用: ${browsers.map((b) => b.kind).join(', ') || '无'}`);
  if (!target) throw new Error(`${KIND} 未安装，无法继续`);
  note(`路径: ${target.executable}`);
  // 这套用例对 Edge 和 Chrome 通用，展示名与 UA 里的标识按目标浏览器推导，
  // 不要写死 Edge —— 否则换浏览器跑就会出现「假失败」。
  const DISPLAY = target.display ?? KIND;
  const IDENT = new RegExp(KIND === 'edge' ? 'edg' : KIND.replace(/[^a-z]/gi, ''), 'i');

  fixture = await startFixture();

  // ── 有头模式 ────────────────────────────────────────────────────────────
  stage(`browser_launch（有头模式 headless=false，附加但不自动连会话）`);
  const launchRes = callText(
    await client.callTool({
      name: 'browser_launch',
      arguments: { kind: KIND, headless: false, attach: false, url: fixture.url },
    }),
  );
  launched = launchRes.launched;
  assert(launched?.kind === KIND, `启动的是 ${KIND}`, `实际 ${launched?.kind}`);
  assert(launched?.headless === false, '确实是有头模式（会弹出可见窗口）');
  assert(Boolean(launched?.port), `调试端口 ${launched?.port}`);
  note(`pid ${launched?.pid}，临时 profile: ${launched?.temporaryProfile}`);
  await sleep(1500);

  // ── 进程枚举能否识别这个浏览器 ───────────────────────────────────────────
  stage(`browser_list_processes（进程枚举能否认出 ${DISPLAY}）`);
  const procs = callText(await client.callTool({ name: 'browser_list_processes', arguments: { filter: KIND } }));
  const totalAll = callText(await client.callTool({ name: 'browser_list_processes', arguments: {} }));
  note(`本机浏览器进程 ${totalAll.total} 个，其中可附加 ${totalAll.attachable} 个`);
  const edgeProc = (procs.processes ?? []).find((p) => p.pid === launched.pid);
  assert(Boolean(edgeProc), `进程枚举找到了刚启动的 ${DISPLAY}（pid ${launched.pid}）`, `实际: ${(procs.processes ?? []).map((p) => p.pid).join(', ')}`);
  if (edgeProc) {
    assert(edgeProc.display === DISPLAY, `识别为 ${DISPLAY}`, `实际 ${edgeProc.display}`);
    assert(edgeProc.family === 'chromium', '归类到 chromium 家族（即可走 CDP）');
    assert(edgeProc.debuggingPort === launched.port, `从命令行解析出调试端口 ${launched.port}`);
    assert(edgeProc.attachable === true, '判定为「可附加」', edgeProc.reason);
    assert(String(edgeProc.commandLine).includes('--remote-allow-origins=*'), '启动参数带 --remote-allow-origins=*');
  }

  // ── browser_discover 端口扫描 ────────────────────────────────────────────
  stage(`browser_discover（端口扫描发现这个 ${DISPLAY}）`);
  const discovered = callText(
    await client.callTool({ name: 'browser_discover', arguments: { ports: [launched.port] } }),
  );
  const hit = (discovered.browsers ?? []).find((b) => b.port === launched.port);
  assert(Boolean(hit), `扫描到端口 ${launched.port} 上的端点`);
  if (hit) note(`${hit.browser} / CDP ${hit.protocolVersion} / 页面数 ${hit.targets}`);

  // ── browser_connect 附加到「已运行的」浏览器实例 ──────────────────────────
  stage('browser_connect（附加到已运行的实例，watchAllTargets=true）');
  const connected = callText(
    await client.callTool({
      name: 'browser_connect',
      arguments: { port: launched.port, watchAllTargets: true },
    }),
  );
  assert(Boolean(connected.targetId), `已附加到页面 ${connected.targetId}`);
  note(`会话: ${connected.sessionId ?? '(见 session_info)'}`);

  await sleep(2500);

  stage(`session_info（确认连的确实是 ${DISPLAY}）`);
  const info = callText(await client.callTool({ name: 'session_info', arguments: {} }));
  assert(info.connected === true, '会话处于连接状态');
  const meta = info.meta ?? {};
  // 这里正是为了兜住“browser 恒为 Chromium”这类静默错误而设的断言。
  assert(IDENT.test(String(meta.browser ?? '')), `meta.browser 识别为 ${DISPLAY}（${meta.browser}）`);
  assert(Boolean(meta.browserVersion), `浏览器版本 ${meta.browserVersion}`);
  assert(IDENT.test(String(meta.browserUserAgent ?? '')), `meta.browserUserAgent 含 ${DISPLAY} 标识`);
  assert(String(meta.browserVersion ?? '').includes('.'), `版本号不是协议号（${meta.browserVersion}，协议 ${meta.protocolVersion}）`);
  note(`浏览器: ${meta.browser} / CDP ${meta.protocolVersion}`);
  const metaNow = info.meta ?? {};
  note(`目标页: ${metaNow.targetTitle} — ${metaNow.targetUrl}`);
  note(`缓冲计数: ${JSON.stringify(info.counts)}`);

  // 页面是在附加之前就加载好的：抓不到它历史的网络请求属于正常行为。
  // 这里重新导航一次，产生附加之后才发生的流量，才是本用例要验证的东西。
  stage('重新导航（验证「附加之后才发生」的请求能被抓到）');
  await client.callTool({
    name: 'capture_start',
    arguments: {},
  });
  await client.callTool({
    name: 'page_evaluate',
    arguments: { expression: `window.location.href = '${fixture.url}'`, awaitPromise: false },
  });
  await sleep(3000);

  // ── 内容抓取 ────────────────────────────────────────────────────────────
  stage('console_read / page_errors（有头页面的输出与异常）');
  const consoleData = callText(await client.callTool({ name: 'console_read', arguments: { limit: 20 } }));
  assert(
    (consoleData.entries ?? []).some((e) => e.text.includes('hello from page A')),
    '抓到页面 A 的 console.log',
  );
  const errors = callText(await client.callTool({ name: 'page_errors', arguments: { limit: 10 } }));
  assert(
    (errors.errors ?? []).some((e) => e.text.includes('page A boom')),
    '抓到未捕获异常',
  );

  // 404 不靠 favicon 兜：浏览器是否请求 favicon 取决于窗口形态，行为不稳定。
  await client.callTool({
    name: 'page_evaluate',
    arguments: { expression: "fetch('/definitely-missing-404')", awaitPromise: false },
  });
  await sleep(1200);

  stage('network_list（document / script / fetch / 404）');
  const net = callText(await client.callTool({ name: 'network_list', arguments: { limit: 50 } }));
  const types = new Set((net.entries ?? []).map((e) => String(e.type ?? '').toLowerCase()));
  assert(net.total >= 3, `捕获到 ${net.total} 个请求`);
  assert(types.has('document') && types.has('script'), `类型覆盖: ${[...types].filter(Boolean).join(', ')}`);
  assert((net.entries ?? []).some((e) => e.status === 404), '含 404 请求');

  stage('page_dom / performance_metrics / storage_read');
  const dom = callText(await client.callTool({ name: 'page_dom', arguments: { mode: 'both', maxHtmlChars: 3000 } }));
  assert(Boolean(dom.outline) && Boolean(dom.html), 'DOM 大纲与 HTML 均非空');
  const perf = callText(await client.callTool({ name: 'performance_metrics', arguments: {} }));
  assert(typeof perf.metrics === 'object' && Object.keys(perf.metrics ?? {}).length > 0, `性能指标 ${Object.keys(perf.metrics ?? {}).length} 项`);
  const storage = callText(await client.callTool({ name: 'storage_read', arguments: {} }));
  assert(Array.isArray(storage.cookies), 'storage 读取完成');

  stage('page_screenshot（有头窗口截图）');
  const shot = callText(
    await client.callTool({ name: 'page_screenshot', arguments: { format: 'png', returnBase64: true } }),
  );
  assert(shot.dataIncluded === true && Boolean(shot.data), '截图成功并返回 base64', `dataIncluded=${shot.dataIncluded} ${shot.hint ?? ''}`);
  if (shot.data) note(`${shot.width}x${shot.height} ${shot.format}，${shot.bytes} 字节`);
  const shotNoData = callText(await client.callTool({ name: 'page_screenshot', arguments: { format: 'png' } }));
  assert(shotNoData.data === undefined, '默认不回传 base64（避免挤爆上下文窗口）');

  // ── 多标签页 watchAllTargets ─────────────────────────────────────────────
  stage('watchAllTargets（新开标签页也能抓到）');
  const targetsBefore = callText(await client.callTool({ name: 'target_list', arguments: {} }));
  note(`当前 ${targetsBefore.count} 个目标`);
  await client.callTool({
    name: 'page_evaluate',
    arguments: { expression: `window.open('${fixture.urlB}', '_blank')`, awaitPromise: false },
  });
  await sleep(3000);
  const targetsAfter = callText(await client.callTool({ name: 'target_list', arguments: {} }));
  assert(targetsAfter.count > targetsBefore.count, `新标签页被识别（${targetsBefore.count} → ${targetsAfter.count}）`);
  const pageB = (targetsAfter.targets ?? []).find((t) => String(t.title ?? '').includes('验收页 B'));
  assert(Boolean(pageB), '新标签页的标题已同步', JSON.stringify((targetsAfter.targets ?? []).map((t) => t.title)));
  const noisy = (targetsAfter.targets ?? []).filter((t) => !(t.type === 'page' || t.type === undefined));
  note(`返回目标 ${targetsAfter.count} 个，共 ${targetsAfter.totalTargets} 个，隐藏后台 ${targetsAfter.hiddenBackground} 个`);
  // 有头浏览器会带一堆自带扩展，默认视图必须过滤掉它们，
  // 否则用户要在十几个后台目标里找真人页面。
  assert(
    targetsAfter.hiddenBackground > 0 || targetsAfter.count === targetsAfter.totalTargets,
    '默认过滤了扩展/后台页面（有头浏览器上这类目标特别多）',
    `hiddenBackground=${targetsAfter.hiddenBackground}，共 ${targetsAfter.totalTargets}`,
  );
  assert(
    targetsAfter.count > 0 && targetsAfter.count <= targetsAfter.totalTargets,
    '默认视图只留真实页面',
    `${targetsAfter.count} / ${targetsAfter.totalTargets}`,
  );
  const allTargets = callText(await client.callTool({ name: 'target_list', arguments: { includeBackground: true } }));
  assert(allTargets.count === allTargets.totalTargets, 'includeBackground:true 可看到全量目标');

  if (pageB) {
    const selected = callText(await client.callTool({ name: 'target_select', arguments: { targetId: pageB.id } }));
    assert(selected.activeTargetId === pageB.id, '已切换到新标签页');
    await sleep(1500);
    const consoleB = callText(await client.callTool({ name: 'console_read', arguments: { limit: 20 } }));
    assert(
      (consoleB.entries ?? []).some((e) => e.text.includes('hello from page B')),
      'watchAllTargets 让新标签页开页就已被抓取（无需手动重连）',
    );
  }

  // ── 实时订阅 + 录制 ─────────────────────────────────────────────────────
  stage('events_subscribe + 实时录制（有头模式下的画面帧）');
  let pushed = 0;
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === 'notifications/browser-devtools/events') pushed += Number(n.params?.count ?? 0);
  };
  const sub = callText(
    await client.callTool({
      name: 'events_subscribe',
      arguments: { channels: ['console', 'network', 'error', 'navigation', 'frame'], performanceSampleMs: 500, push: 'notification' },
    }),
  );
  const recording = callText(
    await client.callTool({
      name: 'recording_start',
      arguments: { name: 'edge-acceptance', saveFrames: true, performanceSampleMs: 500 },
    }),
  );

  await client.callTool({ name: 'page_evaluate', arguments: { expression: 'location.reload()', awaitPromise: false } });

  const seen = new Set();
  let cursor = 0;
  let streamed = 0;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const round = callText(
      await client.callTool({
        name: 'events_wait',
        arguments: { subscriptionId: sub.subscriptionId, cursor, timeoutMs: 4000, limit: 200 },
      }),
    );
    streamed += round.count ?? 0;
    for (const e of round.events ?? []) seen.add(`${e.channel}/${e.kind}`);
    cursor = Math.max(cursor, Number(round.cursor ?? cursor));
    if (seen.has('console/message') && seen.has('navigation/frame') && [...seen].some((k) => k.startsWith('network/'))) break;
  }
  note(`长轮询累计 ${streamed} 条，类型: ${[...seen].join(', ')}`);
  assert(streamed > 0, `${DISPLAY} 上实时事件流正常出数`);
  assert(seen.has('console/message'), '含 console 事件');
  assert(seen.has('navigation/frame'), '含导航事件');
  assert([...seen].some((k) => k.startsWith('network/')), '含网络生命周期事件');
  await sleep(1200);
  assert(pushed > 0, `服务端推送 ${pushed} 条通知到客户端`);

  await sleep(1500);
  const stopped = callText(
    await client.callTool({ name: 'recording_stop', arguments: { recordingId: recording.recordingId } }),
  );
  const lines = readFileSync(stopped.eventsPath, 'utf8').trim().split('\n').filter(Boolean);
  const recorded = lines.map((l) => JSON.parse(l));
  assert(recorded.length > 0, `录制 ${recorded.length} 条事件`);
  assert(recorded.some((e) => e.channel === 'frame'), '录制流含画面帧');
  assert(recorded.some((e) => e.channel === 'metric'), '录制流含性能采样');
  const frameFiles = existsSync(join(stopped.dir, 'frames')) ? readdirSync(join(stopped.dir, 'frames')) : [];
  assert(frameFiles.length > 0, `画面帧落盘 ${frameFiles.length} 张`);
  note(`录制目录: ${stopped.dir}`);
  await client.callTool({ name: 'events_unsubscribe', arguments: { subscriptionId: sub.subscriptionId } });

  // ── 真实外部站点 ────────────────────────────────────────────────────────
  stage('真实外部站点（example.com）抓取 + 一键保存');
  await client.callTool({
    name: 'page_evaluate',
    arguments: { expression: "location.href='https://example.com'", awaitPromise: false },
  });
  await sleep(4000);
  const saved = callText(
    await client.callTool({
      name: 'capture_save',
      arguments: { name: 'edge-acceptance-site', includeScreenshot: true, includeDom: true, includePerformance: true, includeStorage: true },
    }),
  );
  assert(Boolean(saved.dir), `产物目录 ${saved.dir}`);
  const expected = ['session.json', 'console.json', 'console.csv', 'network.har', 'network.csv', 'report.html', 'summary.md', 'manifest.json', 'dom.html', 'screenshot.png'];
  const produced = (saved.files ?? []).map((f) => f.name);
  const absent = expected.filter((f) => !produced.includes(f));
  assert(absent.length === 0, '关键产物齐全', `缺失: ${absent.join(', ')}`);
  for (const name of expected) {
    const p = join(saved.dir, name);
    assert(existsSync(p) && readFileSync(p, 'utf8').length > 0, `${name} 非空`);
  }
  const reportHtml = readFileSync(join(saved.dir, 'report.html'), 'utf8');
  assert(reportHtml.includes('<!DOCTYPE html>') && !reportHtml.includes('http://cdn'), '报告自包含');
  note(`产物 ${produced.length} 个文件，共 ${(saved.files ?? []).reduce((a, f) => a + (f.bytes ?? 0), 0)} 字节`);
  note(`报告: ${saved.dir}\\report.html`);

  stage('browser_close');
  const closed = callText(await client.callTool({ name: 'browser_close', arguments: { closeAll: true } }));
  assert(closed.sessionClosed === true, '会话已断开');
  assert(closed.browsersClosed >= 1, `已关闭 ${closed.browsersClosed} 个实例`);
} catch (err) {
  console.error('\n验收过程抛出异常:', err);
  failures.push(`exception: ${err.message}`);
} finally {
  await client.close().catch(() => {});
  if (fixture) await fixture.close().catch(() => {});
}

// 临时存档的自清理：只删我们这次自己产出的名字。
for (const name of ['smoke-edge-tmp']) {
  try {
    rmSync(join(root, 'captures', name), { recursive: true, force: true });
  } catch {
    /* nothing to clean */
  }
}

console.log('\n────────────────────────────────');
if (failures.length) {
  console.log(`✗ Edge 验收失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`);
} else {
  console.log(`✓ 验收全部通过（${launched?.display ?? DISPLAY ?? KIND}，有头模式）`);
}
process.exit(failures.length ? 1 : 0);
