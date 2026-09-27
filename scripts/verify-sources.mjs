/**
 * 核对本 MCP 能否覆盖「开发者工具 → 源代码 / Sources → 页面」面板里的全部内容。
 *
 * 截图里那个面板 = frame 树 + 每个 frame 加载的全部资源（文档 / 样式 / 脚本 / 图片 /
 * 字体 / 音视频）。本脚本验证：
 *   1. resources_list 能还原这棵树（frame 层级 + 资源清单）；
 *   2. 树里每个资源都能用 resources_get 取回内容；
 *   3. 取回的内容与本地 site/ 目录逐字节一致（文本按字符比，二进制按 base64 比）；
 *   4. 与 network_list 的 HTTP 视角互相印证，没有资源只出现在一边而丢失。
 *
 * 运行： node scripts/verify-sources.mjs [url] [本地目录] [浏览器]
 *       node scripts/verify-sources.mjs https://static-asset-test.app.workbuddy.host/ ./site edge
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE = process.execPath;
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const entry = join(root, 'dist', 'index.js');

const BASE = (process.argv[2] ?? 'https://static-asset-test.app.workbuddy.host/').replace(/\/+$/, '');
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 递归列出本地目录里的所有文件，返回相对 root 的路径数组。 */
function walk(dir, root, out = []) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) walk(full, root, out);
    else out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

const LOCAL_FILES = walk(LOCAL_DIR, LOCAL_DIR).sort();
const TEXT_FILES = LOCAL_FILES.filter((f) => /\.(html?|txt|md|json|css|js|mjs|svg|xml|csv)$/i.test(f));

const transport = new StdioClientTransport({
  command: NODE,
  args: [entry],
  stderr: 'pipe',
  env: { ...process.env },
});

const client = new Client({ name: 'sources-verifier', version: '1.0.0' }, { capabilities: {} });

try {
  console.log(
    `Sources 面板覆盖核对\n  站点: ${BASE}/\n  本地: ${LOCAL_DIR}（${LOCAL_FILES.length} 个文件）\n  浏览器: ${BROWSER}`,
  );

  stage('握手与启动');
  await client.connect(transport);
  assert(Boolean(client.getServerVersion()?.name), 'MCP 服务已就绪');

  const launched = callText(
    await client.callTool({ name: 'browser_launch', arguments: { kind: BROWSER, headless: false } }),
  );
  assert(Boolean(launched?.launched?.port), `浏览器已启动（端口 ${launched?.launched?.port}）`);

  await client.callTool({ name: 'capture_start', arguments: {} });
  await client.callTool({
    name: 'page_evaluate',
    arguments: { expression: `window.location.href = '${BASE}/'`, awaitPromise: false },
  });
  // 等页面加载稳定：懒加载的图片 / 音视频 / 脚本注入的数据是逐步进来的。
  // 真实 DevTools 里也是等加载完再看 Sources，抓早了树本来就不完整。
  await sleep(3000);
  async function treeSize() {
    const t = callText(await client.callTool({ name: 'resources_list', arguments: {} }));
    return { count: t?.resourceCount ?? 0, tree: t };
  }
  let prev = await treeSize();
  let stable = 0;
  for (let i = 0; i < 12 && stable < 2; i++) {
    await sleep(1500);
    const cur = await treeSize();
    stable = cur.count === prev.count && cur.count > 0 ? stable + 1 : 0;
    prev = cur;
  }
  note(`资源树稳定在 ${prev.count} 个资源（${stable >= 2 ? '已等待到稳定' : '等待超时'}）`);

  // ── 1. resources_list：还原 Sources → 页面 面板那棵树 ──────────────────
  stage('resources_list（还原 Sources → 页面 面板的资源树）');
  const tree = callText(await client.callTool({ name: 'resources_list', arguments: {} }));
  assert(tree?.found === true, '拿到了资源树', JSON.stringify(tree).slice(0, 200));
  assert(typeof tree?.resourceCount === 'number' && tree.resourceCount > 0, `资源树非空（${tree?.resourceCount} 个资源）`);
  assert(typeof tree?.frameCount === 'number' && tree.frameCount >= 1, `frame 层级正确（${tree?.frameCount} 个 frame）`);

  const frames = Array.isArray(tree?.frames) ? tree.frames : [];
  for (const f of frames) {
    note(`frame「${f.path}」— ${f.url} — ${f.resources?.length ?? 0} 个资源`);
  }
  assert(
    frames.some((f) => f.frame === 'top'),
    '主 frame 标记为 top（与面板一致）',
  );

  /** 把树打平成一维资源列表。 */
  const flatten = (nodes) => nodes.flatMap((f) => f.resources ?? []);
  const treeResources = flatten(frames);
  const treeUrls = new Set(treeResources.map((r) => r.url));
  note(`资源树 URL 样例: ${[...treeUrls].slice(0, 4).join(' | ')}`);

  /** 一个本地文件在面板里可能出现的 URL（首页显示为 frame 自身的 .../）。 */
  const candidatesFor = (rel) => [`${BASE}/${rel}`, rel === 'index.html' ? `${BASE}/` : null].filter(Boolean);

  /** 资源 URL → 本地相对路径；不在本地目录里返回 null。 */
  const localRel = (url) => {
    if (url === `${BASE}/` || url === `${BASE}/index.html`) return 'index.html';
    if (!url.startsWith(`${BASE}/`)) return null;
    return LOCAL_FILES.includes(url.slice(BASE.length + 1)) ? url.slice(BASE.length + 1) : null;
  };

  /** 取回一个资源并与本地文件比对：文本按字符，二进制按 sha256。 */
  async function fetchAndCompare(url, rel) {
    const isText = TEXT_FILES.includes(rel);
    const res = callText(
      await client.callTool({
        name: 'resources_get',
        arguments: isText
          ? { url, maxChars: 5_000_000 }
          : { url, asBase64: true, maxChars: 5_000_000 },
      }),
    );
    const local = readFileSync(join(LOCAL_DIR, rel));
    if (!res || res.available === false) return { okp: false, label: `${rel} 可读`, detail: 'resources_get 返回不可用' };
    if (isText) {
      const body = String(res.body ?? '');
      return {
        okp: body === local.toString('utf8'),
        label: `${rel} 文本内容逐字符一致（${[...body].length} 字符${res.source === 'page-fetch' ? '，页内重新拉取' : ''}）`,
        detail: /�/.test(body) ? '出现替换字符 U+FFFD，说明解码有损' : '内容不一致',
      };
    }
    const got = Buffer.from(String(res.body ?? ''), 'base64');
    return {
      okp: got.length === local.length && sha256(got) === sha256(local),
      label: `${rel} 二进制逐字节一致（${local.length} 字节）`,
      detail: `取回 ${got.length} 字节`,
    };
  }

  // ── 2. 面板里列出的每个资源，都要能点开读到内容 ──────────────────────
  stage('树里的资源逐个可读（面板点开文件 = resources_get）');
  for (const resource of treeResources) {
    const rel = localRel(resource.url);
    if (!rel) {
      note(`跳过非站点资源: ${resource.url}`);
      continue;
    }
    const { okp, label, detail } = await fetchAndCompare(resource.url, rel);
    assert(okp, label, detail);
  }

  // ── 3. 站点的每个文件都要能拿到内容（含面板树里不列的 fetch 资源） ────
  stage('本地 site/ 每个文件都能取到内容');
  const notInTree = LOCAL_FILES.filter((rel) => !candidatesFor(rel).some((u) => treeUrls.has(u)));
  if (notInTree.length) {
    note(`不出现在 Sources 树里（由 fetch 加载，真实 DevTools 也不列）: ${notInTree.join(', ')}`);
  }
  for (const rel of LOCAL_FILES) {
    const { okp, label, detail } = await fetchAndCompare(`${BASE}/${rel}`, rel);
    assert(okp, label, detail);
  }

  // ── 4. 与 network_list（HTTP 视角）互证 ───────────────────────────────
  stage('与 network_list 互证（两个视角是否一致）');
  const net = callText(await client.callTool({ name: 'network_list', arguments: { limit: 500 } }));
  const netUrls = new Set((net?.entries ?? []).map((e) => e.url));
  const onlyInTree = [...treeUrls].filter((u) => !netUrls.has(u));
  const onlyInNet = [...netUrls].filter((u) => !treeUrls.has(u) && u.startsWith(BASE));
  assert(
    onlyInTree.length === 0,
    '资源树里的资源都能在 network_list 找到对应请求',
    onlyInTree.length ? `仅资源树有: ${onlyInTree.join(', ')}` : undefined,
  );
  note(
    onlyInNet.length
      ? `network_list 多出的（favicon / HEAD 探测等，非页面资源）: ${onlyInNet.length} 条`
      : 'network_list 没有多出资源',
  );

  // ── 收尾 ─────────────────────────────────────────────────────────────
  stage('browser_close');
  await client.callTool({ name: 'browser_close', arguments: {} });
  assert(true, '已关闭浏览器');
} catch (err) {
  console.error('\n脚本异常:', err?.message ?? err);
  failures.push(`脚本异常: ${err?.message ?? err}`);
} finally {
  await client.close().catch(() => undefined);
}

console.log('\n────────────────────────────────');
if (failures.length) {
  console.log(`✗ ${failures.length} 项未通过：`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exitCode = 1;
} else {
  console.log('✓ Sources 面板里的全部内容都能被本 MCP 抓到，且与本地目录逐字节一致');
}
