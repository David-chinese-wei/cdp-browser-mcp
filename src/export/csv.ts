import type { CapturedData, ConsoleEntry, NetworkEntry } from '../types.js';

/** Build the network CSV companion to `network.har`. */
export function networkCsv(entries: NetworkEntry[]): string {
  const rows: string[][] = [
    [
      'time',
      'seq',
      'method',
      'url',
      'status',
      'status_text',
      'type',
      'mime_type',
      'duration_ms',
      'encoded_bytes',
      'decoded_bytes',
      'from_cache',
      'failed',
      'error_text',
      'redirect_url',
      'target',
    ],
  ];

  for (const e of entries) {
    rows.push([
      new Date(e.time).toISOString(),
      String(e.seq),
      e.method,
      e.url,
      e.status !== undefined ? String(e.status) : '',
      e.statusText ?? '',
      e.type ?? '',
      e.mimeType ?? '',
      e.durationMs !== undefined ? String(e.durationMs) : '',
      e.encodedDataLength !== undefined ? String(e.encodedDataLength) : '',
      e.decodedBodyLength !== undefined ? String(e.decodedBodyLength) : '',
      String(Boolean(e.fromCache)),
      String(Boolean(e.failed)),
      e.errorText ?? '',
      e.redirectUrl ?? '',
      e.targetTitle ?? '',
    ]);
  }

  return rows.map(csvRow).join('\r\n') + '\r\n';
}

/** Build the console CSV companion to `console.json`. */
export function consoleCsv(entries: ConsoleEntry[]): string {
  const rows: string[][] = [['time', 'seq', 'level', 'source', 'text', 'url', 'line', 'column', 'target']];

  for (const e of entries) {
    rows.push([
      new Date(e.time).toISOString(),
      String(e.seq),
      e.level,
      e.source,
      e.text,
      e.url ?? '',
      e.line !== undefined ? String(e.line) : '',
      e.column !== undefined ? String(e.column) : '',
      e.targetTitle ?? '',
    ]);
  }

  return rows.map(csvRow).join('\r\n') + '\r\n';
}

export interface SummaryOptions {
  /** Maximum number of rows per section. */
  maxConsole?: number;
  maxNetwork?: number;
  maxErrors?: number;
}

/** Short markdown digest, useful when pasting results into a chat. */
export function buildSummary(data: CapturedData, options: SummaryOptions = {}): string {
  const maxConsole = options.maxConsole ?? 30;
  const maxNetwork = options.maxNetwork ?? 30;
  const maxErrors = options.maxErrors ?? 15;

  const lines: string[] = [];
  const m = data.meta;
  lines.push('# 抓取摘要');
  lines.push('');
  lines.push(`- 浏览器：${browserLabel(m)}`);
  lines.push(`- 目标页：${m.targetTitle ?? '(未命名)'} — ${m.targetUrl ?? 'n/a'}`);
  lines.push(`- 抓取时间：${new Date(m.startedAt).toLocaleString('zh-CN')}`);
  lines.push(`- console 条目：${data.console.length}；网络请求：${data.network.length}；错误：${data.errors.length}`);

  if (data.performance) {
    const perf = data.performance.metrics;
    const notable = ['Timestamp', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration', 'Nodes', 'JSEventListeners', 'LayoutCount'];
    lines.push('');
    lines.push('## 性能指标');
    lines.push('');
    lines.push('| 指标 | 值 |');
    lines.push('| --- | --- |');
    for (const key of notable) {
      if (key in perf) lines.push(`| ${key} | ${formatNumber(perf[key])} |`);
    }
  }

  lines.push('');
  lines.push('## 错误');
  lines.push('');
  if (!data.errors.length) {
    lines.push('无。');
  } else {
    for (const err of data.errors.slice(-maxErrors)) {
      const where = err.url ? ` (${err.url}${err.line ? `:${err.line}` : ''})` : '';
      lines.push(`- [${err.source}] ${escapeMarkdown(err.text)}${where}`);
    }
    if (data.errors.length > maxErrors) lines.push(`- …… 另有 ${data.errors.length - maxErrors} 条`);
  }

  lines.push('');
  lines.push('## 最近的网络请求');
  lines.push('');
  if (!data.network.length) {
    lines.push('无。');
  } else {
    lines.push('| 状态 | 方法 | URL | 耗时(ms) | 大小(B) |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const e of data.network.slice(-maxNetwork)) {
      lines.push(
        `| ${e.failed ? 'FAIL' : (e.status ?? '')} | ${e.method} | ${escapeMarkdown(shorten(e.url, 110))} | ${e.durationMs ?? ''} | ${e.encodedDataLength ?? ''} |`,
      );
    }
  }

  lines.push('');
  lines.push('## 最近的 console 输出');
  lines.push('');
  if (!data.console.length) {
    lines.push('无。');
  } else {
    for (const e of data.console.slice(-maxConsole)) {
      lines.push(`- \`${e.level}\` ${escapeMarkdown(shorten(e.text, 200))}`);
    }
  }

  if (data.dom) {
    lines.push('');
    lines.push('## DOM');
    lines.push('');
    lines.push(`- URL：${data.dom.url}`);
    lines.push(`- 节点数（outline 内）：${data.dom.nodeCount ?? 'n/a'}`);
    lines.push(`- HTML 是否被截断：${data.dom.truncated ? '是' : '否'}`);
  }

  lines.push('');
  return lines.join('\n');
}

function csvRow(values: string[]): string {
  return values.map(csvCell).join(',');
}

function csvCell(value: string): string {
  const text = value ?? '';
  // Prefix formulas so spreadsheets do not evaluate pasted content.
  const guard = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(guard) ? `"${guard.replace(/"/g, '""')}"` : guard;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function shorten(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * `browser` is usually the product string (`Edg/140.0.3485.54`), so appending the
 * version again would just repeat it. The CDP protocol revision is separate.
 */
function browserLabel(m: { browser?: string; browserVersion?: string; protocolVersion?: string }): string {
  const product = m.browser ?? '未知';
  const version = m.browserVersion && !String(product).includes(m.browserVersion) ? ` ${m.browserVersion}` : '';
  const protocol = m.protocolVersion ? `（CDP ${m.protocolVersion}）` : '';
  return `${product}${version}${protocol}`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
