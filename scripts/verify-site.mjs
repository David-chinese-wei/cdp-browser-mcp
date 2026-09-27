/**
 * 公网站点核对：用本 MCP 抓取一个真实公网静态站，再与本地目录逐文件比对。
 *
 * 两层校验：
 *   A. 内容一致性 —— 在页面内 fetch 每个资源并算 SHA-256，与本地文件比对（含 UTF-8 是否乱码）。
 *   B. 抓取链路 —— network_list 是否记录到请求、network_body 能否取回原文、
 *      page_dom / capture_save 落盘的 HTML 是否与源文件一致。
 *
 * 运行： node scripts/verify-site.mjs [url] [本地目录] [浏览器]
 *       node scripts/verify-site.mjs https://static-asset-test.app.workbuddy.host/ ./site edge
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE = process.execPath;
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const entry = join(root, 'dist', 'index.js');

const URL_ = process.argv[2] ?? 'https://static-asset-test.app.workbuddy.host/';
const LOCAL_DIR = resolve(process.argv[3] ?? join(root, 'site'));
const BROWSER = process.argv[4] ?? 'edge';

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

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 相对路径 → { sha256, bytes }；本地目录里没有就返回 null。 */
function localFile(rel) {
  const p = join(LOCAL_DIR, rel);
  if (!existsSync(p)) return null;
  const buf = readFileSync(p);
  return { sha256: sha256(buf), bytes: buf.length };
}

const transport = new StdioClientTransport({
  command: NODE,
  args: [entry],
  stderr: 'pipe',
  env: { ...process.env },
});

const client = new Client({ name: 'site-verifier', version: '1.0.0' }, { capabilities: {} });

try {
  console.log(`公网站点核对\n  站点: ${URL_}\n  本地: ${LOCAL_DIR}\n  浏览器: ${BROWSER}`);

  stage('握手');
  await client.connect(transport);
  assert(Boolean(client.getServerVersion()?.name), 'MCP 服务已就绪');

  stage(`browser_launch（${BROWSER}，有头模式）`);
  const launched = callText(
    await client.callTool({ name: 'browser_launch', arguments: { kind: BROWSER, headless: false } }),
  );
  assert(Boolean(launched?.launched?.port), `浏览器已启动（端口 ${launched?.launched?.port}）`);

  stage(`导航到 ${URL_}`);
  await client.callTool({ name: 'capture_start', arguments: {} });
  await client.callTool({
    name: 'page_evaluate',
    arguments: { expression: `window.location.href = '${URL_}'`, awaitPromise: false },
  });
  // 图片 lazy loading + HEAD 统计表 + 首屏脚本，给足时间。
  await sleep(6000);

  const info = callText(await client.callTool({ name: 'session_info', arguments: {} }));
  note(`浏览器: ${info.meta?.browser}；目标页: ${info.meta?.targetTitle} — ${info.meta?.targetUrl}`);
  assert(String(info.meta?.targetUrl ?? '').startsWith(URL_), '确实停在目标站点');

  // ── A. 内容一致性：在页面内下载每个资源算 SHA-256 ──────────────────────
  stage('A. 内容一致性（页面内 fetch 每个资源 → SHA-256 对比本地）');
  const FILES = [
    'index.html',
    'sample.txt',
    'notes.md',
    'data.json',
    'images/banner.png',
    'images/grid.png',
    'images/waves.png',
    'audio/tone-440hz.wav',
    'audio/chime.wav',
    'audio/sweep.wav',
  ];

  const hashExpr = `(async () => {
    const paths = ${JSON.stringify(FILES)};
    const out = {};
    for (const p of paths) {
      try {
        const r = await fetch(p, { cache: 'no-store' });
        if (!r.ok) { out[p] = { error: 'HTTP ' + r.status }; continue; }
        const buf = await r.arrayBuffer();
        const d = await crypto.subtle.digest('SHA-256', buf);
        out[p] = {
          sha256: [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join(''),
          bytes: buf.byteLength,
          type: r.headers.get('content-type'),
        };
      } catch (e) { out[p] = { error: String(e) }; }
    }
    return out;
  })()`;

  const hashResult = callText(
    await client.callTool({ name: 'page_evaluate', arguments: { expression: hashExpr, awaitPromise: true } }),
  );
  const remote = typeof hashResult === 'object' && hashResult.value ? hashResult.value : hashResult;
  assert(remote && typeof remote === 'object', '页面内返回了哈希结果', JSON.stringify(remote).slice(0, 200));

  for (const rel of FILES) {
    const got = remote?.[rel];
    const want = localFile(rel);
    if (!want) {
      assert(false, `本地缺少 ${rel}`);
      continue;
    }
    if (!got || got.error) {
      assert(false, `${rel} 远程可取`, got?.error ?? '无结果');
      continue;
    }
    const same = got.sha256 === want.sha256 && got.bytes === want.bytes;
    assert(
      same,
      `${rel} 内容一致（${got.bytes} 字节）`,
      same ? '' : `远程 sha=${String(got.sha256).slice(0, 12)}/${got.bytes}B vs 本地 sha=${want.sha256.slice(0, 12)}/${want.bytes}B`,
    );
  }

  // UTF-8 不乱码：直接比对文本文件的字符内容，而不是只看哈希。
  stage('A2. 文本文件 UTF-8 逐字符比对（防乱码）');
  for (const rel of ['sample.txt', 'notes.md', 'data.json']) {
    const textResult = callText(
      await client.callTool({
        name: 'page_evaluate',
        arguments: {
          expression: `(async () => (await fetch('${rel}', { cache: 'no-store' })).text())()`,
          awaitPromise: true,
        },
      }),
    );
    const got = typeof textResult === 'object' ? textResult.text ?? textResult.value : textResult;
    const want = readFileSync(join(LOCAL_DIR, rel), 'utf8');
    assert(got === want, `${rel} 文本内容逐字符相同（${want.length} 字符）`, got === want ? '' : `远程 ${String(got).length} 字符 / 本地 ${want.length} 字符`);
    if (got !== want) {
      const at = [...String(got)].findIndex((c, i) => c !== [...want][i]);
      note(`首个不一致位置: ${at}`);
    }
  }

  // ── B. 抓取链路 ─────────────────────────────────────────────────────────
  stage('B. network_list（抓取到的网络请求是否覆盖全部资源）');
  const net = callText(await client.callTool({ name: 'network_list', arguments: { limit: 100 } }));
  const entries = net.entries ?? [];
  note(`共 ${net.total} 个请求`);
  const byUrl = (suffix) => entries.filter((e) => String(e.url ?? '').endsWith(suffix));
  for (const rel of FILES) {
    const hits = byUrl(rel);
    assert(hits.length > 0, `记录到 ${rel} 的请求`, `未出现`);
  }
  // 真实失败 = 非 favicon、非 HEAD 预检、且非浏览器正常中止（net::ERR_ABORTED）的请求。
  // 页面脚本会用 fetch(HEAD) 预检文件大小，部分会被浏览器中止，属正常行为，不算失败。
  const benign = (e) => {
    const url = String(e.url ?? '');
    if (/\/favicon\.ico(\?|$)/i.test(url)) return true;
    if (String(e.method ?? '').toUpperCase() === 'HEAD') return true;
    if (e.errorText === 'net::ERR_ABORTED') return true;
    return false;
  };
  const failed = entries.filter(
    (e) => !benign(e) && (e.failed || (typeof e.status === 'number' && e.status >= 400 && e.status !== 304)),
  );
  assert(failed.length === 0, '没有失败请求', failed.map((f) => `${f.url} → ${f.status ?? 'failed'}`).join('; '));

  stage('B2. 资源大小与状态码（与本地文件比对）');
  for (const rel of FILES) {
    const hits = byUrl(rel).filter((e) => e.method !== 'HEAD');
    if (!hits.length) continue;
    // 取体积最大的那条（完整下载），避免拿到 <audio preload> 的 Range 预检或中止请求。
    const hit = hits.reduce((a, b) => ((b.encodedDataLength ?? 0) > (a.encodedDataLength ?? 0) ? b : a));
    const want = localFile(rel);
    const got = hit.encodedDataLength;
    if (typeof got === 'number' && got > 0 && want) {
      // encodedDataLength 含 HTTP 响应头，允许一定余量；只要不小于文件字节即说明正文完整收到。
      assert(
        got >= want.bytes && got <= want.bytes + 8192,
        `${rel} 抓到的大小 ${got} 覆盖本地 ${want.bytes}`,
        `远程 ${got} / 本地 ${want.bytes}`,
      );
    }
  }

  stage('B3. network_body（用 MCP 取回文本文件原文并与本地比对）');
  for (const rel of ['sample.txt', 'notes.md', 'data.json']) {
    const target = entries.find((e) => String(e.url ?? '').endsWith(rel) && e.method !== 'HEAD');
    if (!target) {
      assert(false, `${rel} 在网络记录里有可取的条目`);
      continue;
    }
    const body = callText(await client.callTool({ name: 'network_body', arguments: { requestId: target.id } }));
    const want = readFileSync(join(LOCAL_DIR, rel), 'utf8');
    const got = String(body.body ?? '');
    assert(got === want, `network_body 取回 ${rel} 与本地一致`, `远程 ${got.length} 字符 / 本地 ${want.length} 字符`);
  }

  stage('B4. page_dom（DOM 是否完整抓到页面结构）');
  const dom = callText(
    await client.callTool({ name: 'page_dom', arguments: { mode: 'both', maxHtmlChars: 200000 } }),
  );
  assert(Boolean(dom.html), 'DOM HTML 非空');
  const imgCount = (dom.html.match(/<img\b/gi) ?? []).length;
  const audioCount = (dom.html.match(/<audio\b/gi) ?? []).length;
  assert(imgCount === 3, `DOM 含 3 张图片（实际 ${imgCount}）`);
  assert(audioCount === 3, `DOM 含 3 个音频（实际 ${audioCount}）`);
  assert(dom.html.includes('静态资源测试站'), 'DOM 含页面标题');
  assert(dom.html.includes('支持 Range 断点下载'), 'DOM 含徽标文案');
  note(`大纲 ${String(dom.outline ?? '').length} 字符，HTML ${dom.html.length} 字符`);

  // 页面脚本执行后会把文件清单渲染进表格，这是 DOM 快照是否「抓到执行后状态」的证据。
  const rowCount = (dom.html.match(/<tr>/gi) ?? []).length;
  assert(rowCount >= 10, `文件清单表格已渲染（${rowCount} 行，含表头）`);
  assert(!dom.html.includes('大小统计中…'), '表格不再是「统计中」占位（说明拿到的是脚本执行后的 DOM）');

  stage('B5. 页面内 viewer 是否读到 sample.txt 原文');
  const viewer = callText(
    await client.callTool({
      name: 'page_evaluate',
      arguments: { expression: "document.getElementById('viewer').textContent", awaitPromise: false },
    }),
  );
  const viewerText = typeof viewer === 'object' ? viewer.text ?? viewer.value : viewer;
  const sampleLocal = readFileSync(join(LOCAL_DIR, 'sample.txt'), 'utf8');
  assert(String(viewerText) === sampleLocal, '页面 viewer 显示的 sample.txt 与本地一致');

  stage('B6. capture_save（一键保存并核对落盘的 DOM）');
  const saved = callText(
    await client.callTool({
      name: 'capture_save',
      arguments: {
        name: 'verify-public-site',
        includeDom: true,
        includeScreenshot: true,
        includePerformance: true,
        includeStorage: true,
      },
    }),
  );
  assert(Boolean(saved.dir), `产物目录 ${saved.dir}`);
  note(`产物 ${(saved.files ?? []).length} 个文件`);
  const savedDom = readFileSync(join(saved.dir, 'dom.html'), 'utf8');
  const localIndex = readFileSync(join(LOCAL_DIR, 'index.html'), 'utf8');
  // 落盘的是「脚本执行后」的 DOM，源文件必然是它的子集性前缀内容，不做逐字节相等，
  // 但要保证源文件的所有结构性内容都还在。
  const lost = ['静态资源测试站', 'images/banner.png', 'audio/sweep.wav', 'data.json', 'sample.txt'].filter(
    (needle) => !savedDom.includes(needle) && localIndex.includes(needle),
  );
  assert(lost.length === 0, '落盘 DOM 保留了源文件的全部关键内容', `丢失: ${lost.join(', ')}`);

  const har = JSON.parse(readFileSync(join(saved.dir, 'network.har'), 'utf8'));
  const harUrls = (har.log?.entries ?? []).map((e) => e.request?.url ?? '');
  const missing = FILES.filter((f) => !harUrls.some((u) => u.endsWith(f)));
  assert(missing.length === 0, `HAR 覆盖了全部 ${FILES.length} 个资源`, `缺失: ${missing.join(', ')}`);

  stage('browser_close');
  const closed = callText(await client.callTool({ name: 'browser_close', arguments: { closeAll: true } }));
  assert(closed.browsersClosed >= 1, `已关闭 ${closed.browsersClosed} 个实例`);
} catch (err) {
  console.error('\n核对过程抛出异常:', err);
  failures.push(`exception: ${err.message}`);
} finally {
  await client.close().catch(() => {});
}

console.log('\n────────────────────────────────');
if (failures.length) {
  console.log(`✗ 核对失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`);
} else {
  console.log(`✓ 公网站点内容与本地目录完全一致，抓取链路无缺失`);
}
process.exit(failures.length ? 1 : 0);
