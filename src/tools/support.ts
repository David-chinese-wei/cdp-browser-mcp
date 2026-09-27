import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Successful tool result carrying the JSON payload as text. */
export function ok(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: stringify(payload) }] };
}

/** Tool result flagged as an error, with the reason kept readable for the model. */
export function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `错误：${message}` }], isError: true };
}

export function okText(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/** Wrap a handler so a thrown Error becomes a flagged tool result instead of a protocol error. */
export async function guard(action: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await action();
  } catch (err) {
    return fail((err as Error).message ?? String(err));
  }
}

export function stringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_key, raw: unknown) => {
      if (typeof raw === 'bigint') return raw.toString();
      if (raw instanceof Error) return { name: raw.name, message: raw.message };
      if (raw && typeof raw === 'object') {
        if (seen.has(raw as object)) return '[Circular]';
        seen.add(raw as object);
      }
      return raw;
    },
    2,
  );
}

/** Clip long text payloads so a tool reply stays transport friendly. */
export function clipText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: `${value.slice(0, maxChars)}\n…[已截断，共 ${value.length} 字符]`, truncated: true };
}

export function formatNow(epoch: number): string {
  return new Date(epoch).toLocaleString('zh-CN', { hour12: false });
}
