/** Turn CDP RemoteObject payloads (console arguments, evaluate results) into readable text. */

export function describeRemoteObject(obj: any, depth = 2): string {
  if (obj == null) return 'undefined';
  if (typeof obj !== 'object') return String(obj);

  if (obj.unserializableValue !== undefined) return String(obj.unserializableValue);
  if ('value' in obj) return formatScalar(obj.value);
  if (obj.subtype === 'null') return 'null';
  if (obj.preview) return previewToText(obj.preview, depth);
  if (obj.description !== undefined) return String(obj.description);
  if (obj.className) return `[${obj.className}]`;
  return obj.type ?? 'unknown';
}

export function describeArgs(args: any[] | undefined): string {
  if (!args?.length) return '';
  return args.map((a) => describeRemoteObject(a)).join(' ');
}

/** JSON friendly, size bounded preview of console arguments. */
export function previewArgs(args: any[] | undefined, maxItems = 20): unknown[] {
  if (!args?.length) return [];
  return args.slice(0, maxItems).map((a) => safeValue(a, 2));
}

function formatScalar(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return `${value}n`;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function previewToText(preview: any, depth: number): string {
  const subtype = preview.subtype;
  if (subtype === 'regexp') return preview.description ?? '/regex/';
  if (subtype === 'date') return preview.description ?? 'Date';
  if (subtype === 'error') return preview.description ?? 'Error';
  if (subtype === 'node') return preview.description ?? '<node>';

  if (preview.type === 'function') return preview.description ?? 'ƒ ()';
  if (depth <= 0) return preview.description ?? '…';

  const props: any[] = preview.properties ?? [];
  const overflow = Boolean(preview.overflow);
  if (preview.subtype === 'array' || preview.type === 'object') {
    const parts = props.map((p) => {
      const key = p.name;
      const value = p.value !== undefined ? describeRemoteObject({ value: p.value }, depth - 1) : describeRemoteObject(p, depth - 1);
      return `${key}: ${value}`;
    });
    if (overflow) parts.push('…');
    const wrapped = preview.subtype === 'array' || preview.description === 'Array' ? ['[', ']'] : ['{', '}'];
    return `${wrapped[0]} ${parts.join(', ')} ${wrapped[1]}`.replace(/\s+/g, ' ').trim();
  }
  return preview.description ?? preview.type ?? 'object';
}

function safeValue(obj: any, depth: number): unknown {
  if (obj == null) return null;
  if (typeof obj !== 'object') return obj;
  if (obj.unserializableValue !== undefined) return obj.unserializableValue;
  if ('value' in obj) return obj.value;
  if (depth <= 0) return obj.description ?? obj.type;
  if (obj.preview?.properties) {
    const out: Record<string, unknown> = {};
    for (const p of obj.preview.properties.slice(0, 20)) {
      out[p.name] = p.value !== undefined ? p.value : safeValue(p, depth - 1);
    }
    return out;
  }
  return obj.description ?? obj.type;
}
