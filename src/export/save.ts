import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CapturedData, SavedCapture, SavedCaptureFile } from '../types.js';
import { buildReport } from './report.js';
import { buildSummary, consoleCsv, networkCsv } from './csv.js';
import { harToString } from './har.js';

export interface SaveCaptureOptions {
  /** Write into this exact directory. Takes precedence over `rootDir` + `name`. */
  dir?: string;
  /** Parent directory for a generated capture folder. Defaults to `<cwd>/captures`. */
  rootDir?: string;
  /** Folder name inside `rootDir`. Defaults to the session id. */
  name?: string;
  /** Maximum table rows rendered into report.html. */
  maxRows?: number;
  /** Embed the screenshot into the report. Default true. */
  includeScreenshot?: boolean;
  /** Version stamped into the HAR creator and the manifest. */
  version?: string;
}

const DEFAULT_ROOT = 'captures';

/**
 * Persist everything captured from DevTools into a single self describing folder.
 *
 * Produced files: session.json, console.json, console.csv, network.har,
 * network.csv, metrics.json, storage.json, dom.html, screenshot.(png|jpeg),
 * report.html, summary.md, manifest.json. Optional parts are skipped when the
 * corresponding data was never captured.
 */
export async function saveCapture(data: CapturedData, options: SaveCaptureOptions = {}): Promise<SavedCapture> {
  const dir = resolve(options.dir ?? join(options.rootDir ?? join(process.cwd(), DEFAULT_ROOT), sanitize(options.name ?? data.meta.sessionId)));
  await mkdir(dir, { recursive: true });

  const files: SavedCaptureFile[] = [];
  const version = options.version ?? '0.1.0';

  files.push(await writeText(dir, 'session.json', `${JSON.stringify(data, null, 2)}\n`, '原始全量数据（console / network / errors / dom / 指标 / 存储）'));
  files.push(await writeText(dir, 'console.json', `${JSON.stringify(data.console, null, 2)}\n`, 'console 日志（结构化）'));
  files.push(await writeText(dir, 'console.csv', consoleCsv(data.console), 'console 日志（表格）'));
  files.push(await writeText(dir, 'network.har', harToString(data, version), 'HAR 1.2 网络记录，可直接导入 DevTools / Charles'));
  files.push(await writeText(dir, 'network.csv', networkCsv(data.network), '网络请求（表格）'));

  if (data.performance) {
    files.push(await writeText(dir, 'metrics.json', `${JSON.stringify(data.performance, null, 2)}\n`, '性能指标快照'));
  }
  if (data.storage) {
    files.push(await writeText(dir, 'storage.json', `${JSON.stringify(data.storage, null, 2)}\n`, 'Cookies / localStorage / sessionStorage / IndexedDB'));
  }
  if (data.dom?.html) {
    files.push(await writeText(dir, 'dom.html', data.dom.html, '页面 HTML 快照'));
  }
  if (data.dom?.outline) {
    files.push(await writeText(dir, 'dom-outline.txt', `${data.dom.outline}\n`, '页面结构大纲（适合 LLM 快速阅读）'));
  }
  if (data.screenshot) {
    const ext = data.screenshot.format === 'png' ? 'png' : data.screenshot.format === 'webp' ? 'webp' : 'jpeg';
    const buffer = Buffer.from(data.screenshot.data, 'base64');
    await writeFile(join(dir, `screenshot.${ext}`), buffer);
    files.push({
      path: join(dir, `screenshot.${ext}`),
      bytes: buffer.byteLength,
      description: `页面截图（${data.screenshot.width ?? '?'}×${data.screenshot.height ?? '?'}）`,
    });
  }

  files.push(await writeText(dir, 'report.html', buildReport(data, { maxRows: options.maxRows, includeScreenshot: options.includeScreenshot }), '离线 HTML 报告，双击即可查看'));
  files.push(await writeText(dir, 'summary.md', buildSummary(data), 'Markdown 摘要，适合贴到对话里'));

  const manifest = {
    version,
    createdAt: new Date().toISOString(),
    session: data.meta,
    counts: {
      console: data.console.length,
      network: data.network.length,
      errors: data.errors.length,
    },
    files: files.map((f) => ({ name: f.path.split(/[\\/]/).pop(), bytes: f.bytes, description: f.description })),
  };
  const manifestPath = join(dir, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  files.push({ path: manifestPath, bytes: Buffer.byteLength(JSON.stringify(manifest)), description: '产物索引' });

  return {
    dir,
    files,
    manifestPath,
    counts: {
      console: data.console.length,
      network: data.network.length,
      errors: data.errors.length,
    },
  };
}

async function writeText(dir: string, name: string, content: string, description: string): Promise<SavedCaptureFile> {
  const path = join(dir, name);
  await writeFile(path, content, 'utf8');
  return { path, bytes: Buffer.byteLength(content, 'utf8'), description };
}

function sanitize(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^[._]+/, '');
  return cleaned || `capture-${Date.now()}`;
}
