import type { CapturedData, ConsoleEntry, NetworkEntry, PageErrorEntry } from '../types.js';

export interface ReportOptions {
  /** Max rows rendered per table, keeping the file small enough to open anywhere. */
  maxRows?: number;
  /** Include the inline screenshot data URI. Default true. */
  includeScreenshot?: boolean;
}

/**
 * Render a self contained, offline HTML report.
 *
 * The palette follows the light IDE theme: light background, dark text, no
 * external asset so the file can be mailed around or opened from disk.
 */
export function buildReport(data: CapturedData, options: ReportOptions = {}): string {
  const maxRows = options.maxRows ?? 500;
  const m = data.meta;
  const failures = data.network.filter((e) => e.failed || (typeof e.status === 'number' && e.status >= 400));
  const totalMs = data.network.reduce((sum, e) => sum + (e.durationMs ?? 0), 0);
  const transferred = data.network.reduce((sum, e) => sum + (e.encodedDataLength ?? 0), 0);

  const consoleRows = data.console.slice(-maxRows);
  const networkRows = data.network.slice(-maxRows);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>抓取报告 · ${esc(m.targetTitle ?? 'browser capture')}</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #f7f7f5; color: #2c2c2a; font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }
header { background: #ffffff; border-bottom: 1px solid #e3e2dd; padding: 20px 28px; }
h1 { margin: 0 0 4px; font-size: 18px; font-weight: 500; }
.sub { color: #6b6a65; font-size: 13px; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 20px 28px 60px; }
.cards { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
.card { flex: 1 1 150px; background: #fff; border: 1px solid #e3e2dd; border-radius: 10px; padding: 12px 16px; }
.card .k { color: #6b6a65; font-size: 12px; }
.card .v { font-size: 20px; font-weight: 500; margin-top: 2px; }
nav { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
nav button { border: 1px solid #e3e2dd; background: #fff; color: #2c2c2a; border-radius: 999px; padding: 6px 14px; font-size: 13px; cursor: pointer; }
nav button.active { background: #2c2c2a; border-color: #2c2c2a; color: #fff; }
.panel { display: none; background: #fff; border: 1px solid #e3e2dd; border-radius: 12px; padding: 16px; }
.panel.active { display: block; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #f0efeb; vertical-align: top; }
th { color: #6b6a65; font-weight: 500; position: sticky; top: 0; background: #fff; }
td.url { word-break: break-all; max-width: 520px; }
pre { margin: 0; background: #f7f7f5; border: 1px solid #e3e2dd; border-radius: 8px; padding: 12px; overflow: auto; max-height: 480px; font-size: 12px; }
input[type=search] { border: 1px solid #e3e2dd; border-radius: 8px; padding: 6px 10px; font-size: 13px; width: 260px; margin-bottom: 10px; }
.badge { display: inline-block; border-radius: 6px; padding: 1px 6px; font-size: 12px; }
.b-error, .b-fail { background: #fbeaea; color: #8f2323; }
.b-warn { background: #fbf1de; color: #7a4d09; }
.b-info { background: #e8f0fa; color: #1d4d82; }
.b-ok { background: #e9f3dd; color: #35650f; }
.b-muted { background: #f1efe8; color: #5f5e5a; }
.error-item { border-left: 3px solid #c0564d; padding: 6px 10px; margin-bottom: 8px; background: #fdf6f5; }
.hint { color: #6b6a65; font-size: 12px; margin: 8px 0 0; }
.kv { display: grid; grid-template-columns: 180px 1fr; gap: 4px 12px; font-size: 13px; }
.kv span:first-child { color: #6b6a65; }
img { max-width: 100%; border: 1px solid #e3e2dd; border-radius: 8px; }
details summary { cursor: pointer; margin-bottom: 8px; }
</style>
</head>
<body>
<header>
  <h1>${esc(m.targetTitle ?? '未命名页面')}</h1>
  <div class="sub">${esc(m.targetUrl ?? 'n/a')} · ${esc(m.browser ?? '未知浏览器')} · ${esc(new Date(m.startedAt).toLocaleString('zh-CN'))}</div>
</header>
<div class="wrap">
  <div class="cards">
    <div class="card"><div class="k">Console</div><div class="v">${data.console.length}</div></div>
    <div class="card"><div class="k">网络请求</div><div class="v">${data.network.length}</div></div>
    <div class="card"><div class="k">错误/异常</div><div class="v">${data.errors.length}</div></div>
    <div class="card"><div class="k">失败请求</div><div class="v">${failures.length}</div></div>
    <div class="card"><div class="k">传输体积</div><div class="v">${formatBytes(transferred)}</div></div>
    <div class="card"><div class="k">请求总耗时</div><div class="v">${Math.round(totalMs)} ms</div></div>
  </div>

  <nav>
    <button data-panel="overview" class="active">概览</button>
    <button data-panel="console">Console (${data.console.length})</button>
    <button data-panel="network">网络 (${data.network.length})</button>
    <button data-panel="errors">错误 (${data.errors.length})</button>
    <button data-panel="storage">存储</button>
    <button data-panel="dom">DOM</button>
    ${data.screenshot && options.includeScreenshot !== false ? '<button data-panel="shot">截图</button>' : ''}
  </nav>

  <div class="panel active" id="p-overview">
    <div class="kv">
      <span>会话 ID</span><code>${esc(m.sessionId)}</code>
      <span>浏览器</span><span>${esc(m.browser ?? '未知')} ${esc(m.browserVersion ?? '')}</span>
      <span>连接地址</span><span>${esc(`${m.host}${m.port ? `:${m.port}` : ''}`)}</span>
      <span>页面 URL</span><span>${esc(m.targetUrl ?? 'n/a')}</span>
      <span>抓取开始</span><span>${esc(new Date(m.startedAt).toLocaleString('zh-CN'))}</span>
    </div>
    ${renderMetrics(data)}
    ${renderStoragePreview(data)}
  </div>

  <div class="panel" id="p-console">
    <input type="search" placeholder="过滤 console 输出…" data-filter="t-console">
    <table id="t-console"><thead><tr><th>#</th><th>时间</th><th>级别</th><th>内容</th><th>位置</th></tr></thead><tbody>
      ${consoleRows.map(renderConsoleRow).join('\n')}
    </tbody></table>
    ${renderHint(data.console.length, consoleRows.length)}
  </div>

  <div class="panel" id="p-network">
    <input type="search" placeholder="过滤 URL / 状态…" data-filter="t-network">
    <table id="t-network"><thead><tr><th>#</th><th>时间</th><th>方法</th><th>URL</th><th>状态</th><th>类型</th><th>耗时</th><th>大小</th></tr></thead><tbody>
      ${networkRows.map(renderNetworkRow).join('\n')}
    </tbody></table>
    ${renderHint(data.network.length, networkRows.length)}
  </div>

  <div class="panel" id="p-errors">
    ${data.errors.length ? '' : '<p class="hint">没有捕获到异常。</p>'}
    ${data.errors.slice(-100).map(renderError).join('\n')}
  </div>

  <div class="panel" id="p-storage">
    ${renderStorage(data)}
  </div>

  <div class="panel" id="p-dom">
    ${renderDom(data)}
  </div>

  ${data.screenshot && options.includeScreenshot !== false ? `<div class="panel" id="p-shot">
    <p class="hint">抓取时间：${esc(new Date(data.screenshot.time).toLocaleString('zh-CN'))}${data.screenshot.width ? ` · ${data.screenshot.width}×${data.screenshot.height}` : ''}</p>
    <img src="data:${esc(data.screenshot.mimeType)};base64,${esc(data.screenshot.data)}" alt="页面截图">
  </div>` : ''}
</div>
<script>
document.querySelectorAll('nav button').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('nav button').forEach(function (b) { b.classList.remove('active'); });
    document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
    btn.classList.add('active');
    var panel = document.getElementById('p-' + btn.getAttribute('data-panel'));
    if (panel) panel.classList.add('active');
  });
});
document.querySelectorAll('input[data-filter]').forEach(function (input) {
  input.addEventListener('input', function () {
    var needle = input.value.trim().toLowerCase();
    var rows = document.querySelectorAll('#' + input.getAttribute('data-filter') + ' tbody tr');
    rows.forEach(function (row) {
      row.style.display = !needle || row.textContent.toLowerCase().indexOf(needle) !== -1 ? '' : 'none';
    });
  });
});
</script>
</body>
</html>
`;
}

function renderConsoleRow(entry: ConsoleEntry): string {
  const badge = levelClass(entry.level);
  return `<tr><td>${entry.seq}</td><td>${esc(shortTime(entry.time))}</td><td><span class="badge ${badge}">${esc(entry.level)}</span></td><td class="url">${esc(entry.text)}</td><td>${esc(entry.url ? `${entry.url}${entry.line ? `:${entry.line}` : ''}` : '')}</td></tr>`;
}

function renderNetworkRow(entry: NetworkEntry): string {
  const status = entry.failed
    ? '<span class="badge b-fail">FAIL</span>'
    : entry.status
      ? `<span class="badge ${statusClass(entry.status)}">${entry.status}</span>`
      : '<span class="badge b-muted">-</span>';
  return `<tr><td>${entry.seq}</td><td>${esc(shortTime(entry.time))}</td><td>${esc(entry.method)}</td><td class="url">${esc(entry.url)}</td><td>${status}</td><td>${esc(entry.type ?? '')}</td><td>${entry.durationMs !== undefined ? `${entry.durationMs} ms` : ''}</td><td>${entry.encodedDataLength !== undefined ? esc(formatBytes(entry.encodedDataLength)) : ''}</td></tr>`;
}

function renderError(err: PageErrorEntry): string {
  const where = err.url ? ` <span class="sub">(${esc(err.url)}${err.line ? `:${err.line}` : ''})</span>` : '';
  const stack = err.stack
    ? `<details><summary>调用栈</summary><pre>${esc(err.stack)}</pre></details>`
    : '';
  return `<div class="error-item"><strong>[${esc(err.source)}]</strong> ${esc(err.text)}${where}${stack}</div>`;
}

function renderMetrics(data: CapturedData): string {
  if (!data.performance) return '';
  const perf = data.performance;
  const rows: Array<[string, string]> = [];
  const metrics = perf.metrics;
  const labels: Record<string, [string, (v: number) => string]> = {
    ScriptDuration: ['脚本执行', (v) => `${(v * 1000).toFixed(1)} ms`],
    LayoutDuration: ['布局', (v) => `${(v * 1000).toFixed(1)} ms`],
    RecalcStyleDuration: ['样式重算', (v) => `${(v * 1000).toFixed(1)} ms`],
    TaskDuration: ['任务总耗时', (v) => `${(v * 1000).toFixed(1)} ms`],
    Nodes: ['DOM 节点', (v) => String(v)],
    Documents: ['文档数', (v) => String(v)],
    JSEventListeners: ['事件监听器', (v) => String(v)],
    LayoutCount: ['布局次数', (v) => String(v)],
    RecalcStyleCount: ['样式重算次数', (v) => String(v)],
    JSHeapUsedSize: ['JS 堆已用', (v) => formatBytes(v)],
    JSHeapTotalSize: ['JS 堆总量', (v) => formatBytes(v)],
  };

  for (const [key, [label, fmt]] of Object.entries(labels)) {
    if (typeof metrics[key] === 'number') rows.push([label, fmt(metrics[key])]);
  }

  if (perf.paintTimings) {
    for (const [name, value] of Object.entries(perf.paintTimings)) {
      rows.push([`绘制 ${name}`, `${Math.round(value)} ms`]);
    }
  }
  const nav = perf.navigation as Record<string, number> | undefined;
  if (nav) {
    const start = nav['startTime'] ?? 0;
    const delta = (key: string): string | undefined => {
      const value = nav[key];
      if (typeof value !== 'number' || value <= 0) return undefined;
      return `${Math.round(start ? value - start : value)} ms`;
    };
    const domReady = delta('domContentLoadedEventEnd');
    const loaded = delta('loadEventEnd');
    const ttfb = delta('responseStart');
    if (ttfb) rows.push(['首字节 (TTFB)', ttfb]);
    if (domReady) rows.push(['DOMContentLoaded', domReady]);
    if (loaded) rows.push(['Load', loaded]);
  }
  if (perf.memory) {
    rows.push(['堆内存已用', formatBytes(perf.memory.usedJSHeapSize)]);
  }

  if (!rows.length) return '<h3 class="hint">没有可用性能指标。</h3>';

  return `<h3>性能指标</h3><div class="kv">${rows
    .map(([k, v]) => `<span>${esc(k)}</span><span>${esc(v)}</span>`)
    .join('')}</div>`;
}

function renderStoragePreview(data: CapturedData): string {
  if (!data.storage) return '';
  const s = data.storage;
  return `<h3>存储概览</h3><div class="kv">
    <span>Cookies</span><span>${s.cookies.length}</span>
    <span>localStorage</span><span>${Object.keys(s.localStorage).length} 项</span>
    <span>sessionStorage</span><span>${Object.keys(s.sessionStorage).length} 项</span>
    <span>IndexedDB</span><span>${s.indexedDb.length ? esc(s.indexedDb.join(', ')) : '无'}</span>
  </div>`;
}

function renderStorage(data: CapturedData): string {
  if (!data.storage) return '<p class="hint">本次抓取未包含存储数据（调用 storage_read 后再保存）。</p>';
  const s = data.storage;
  const parts: string[] = [];
  parts.push(`<h3>Cookies (${s.cookies.length})</h3><pre>${esc(JSON.stringify(s.cookies, null, 2))}</pre>`);
  parts.push(`<h3>localStorage</h3><pre>${esc(JSON.stringify(s.localStorage, null, 2))}</pre>`);
  parts.push(`<h3>sessionStorage</h3><pre>${esc(JSON.stringify(s.sessionStorage, null, 2))}</pre>`);
  parts.push(`<h3>IndexedDB</h3><pre>${esc(JSON.stringify(s.indexedDb, null, 2))}</pre>`);
  if (s.errors?.length) {
    parts.push(`<p class="hint">读取警告：${esc(s.errors.join('；'))}</p>`);
  }
  return parts.join('\n');
}

function renderDom(data: CapturedData): string {
  if (!data.dom) return '<p class="hint">本次抓取未包含 DOM 快照（调用 page_dom 后再保存）。</p>';
  const d = data.dom;
  const parts: string[] = [`<div class="kv"><span>URL</span><span>${esc(d.url)}</span><span>节点数</span><span>${d.nodeCount ?? 'n/a'}</span><span>截断</span><span>${d.truncated ? '是' : '否'}</span></div>`];
  if (d.outline) parts.push(`<h3>结构大纲</h3><pre>${esc(d.outline)}</pre>`);
  if (d.html) {
    parts.push(
      `<details><summary>完整 HTML（${formatBytes(Buffer.byteLength(d.html, 'utf8'))}）</summary><pre>${esc(d.html)}</pre></details>`,
    );
  }
  return parts.join('\n');
}

function levelClass(level: string): string {
  if (level === 'error') return 'b-error';
  if (level === 'warn') return 'b-warn';
  if (level === 'info' || level === 'debug') return 'b-info';
  return 'b-muted';
}

function statusClass(status: number): string {
  if (status >= 500) return 'b-error';
  if (status >= 400) return 'b-warn';
  if (status >= 200 && status < 300) return 'b-ok';
  return 'b-muted';
}

function shortTime(epoch: number): string {
  return new Date(epoch).toLocaleTimeString('zh-CN', { hour12: false });
}

function renderHint(total: number, shown: number): string {
  return total > shown ? `<p class="hint">仅显示最近 ${shown} 条，共 ${total} 条，完整数据见同目录 JSON / CSV。</p>` : '';
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '-';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
