import type { DomSnapshot } from '../types.js';

export interface DomOutlineOptions {
  /** How deep to walk. 1 = only <html>. */
  depth?: number;
  maxNodes?: number;
  maxTextLength?: number;
  /** Skip script/style/noscript nodes. */
  skipHidden?: boolean;
}

const DEFAULT_DEPTH = 4;
const DEFAULT_MAX_NODES = 800;
const DEFAULT_TEXT = 60;

export interface DomNode {
  nodeId: number;
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  attributes?: string[];
  children?: DomNode[];
  contentDocument?: DomNode;
  frameId?: string;
}

/** Render a CDP DOM tree as an indented, LLM friendly outline. */
export function buildOutline(root: DomNode, options: DomOutlineOptions = {}): { outline: string; nodeCount: number; truncated: boolean } {
  const depth = options.depth ?? DEFAULT_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxText = options.maxTextLength ?? DEFAULT_TEXT;
  const skipHidden = options.skipHidden ?? true;

  const lines: string[] = [];
  let visited = 0;
  let truncated = false;

  const walk = (node: DomNode, level: number): void => {
    if (visited >= maxNodes || truncated) {
      truncated = true;
      return;
    }
    if (node.nodeType === 3 /* text */) {
      const text = (node.nodeValue ?? '').replace(/\s+/g, ' ').trim();
      if (text && level <= depth) {
        lines.push(`${indent(level)}"${clip(text, maxText)}"`);
        visited++;
      }
      return;
    }
    if (node.nodeType !== 1 /* element */) return;
    const name = (node.nodeName ?? '').toLowerCase();
    if (skipHidden && (name === 'script' || name === 'style' || name === 'noscript')) return;
    if (level > depth) {
      truncated = true;
      return;
    }

    lines.push(`${indent(level)}${formatTag(node)}`);
    visited++;

    if (node.contentDocument) walk(node.contentDocument, level + 1);
    for (const child of node.children ?? []) walk(child, level + 1);
  };

  walkDocument(root, walk);
  return { outline: lines.join('\n'), nodeCount: visited, truncated };
}

/**
 * `DOM.getDocument` hands back a document node (nodeType 9) rather than an
 * element, so its children have to be walked directly.
 */
function walkDocument(node: DomNode, walk: (n: DomNode, level: number) => void): void {
  if (node.nodeType !== 9) {
    walk(node, 0);
    return;
  }
  if (node.contentDocument) walk(node.contentDocument, 0);
  for (const child of node.children ?? []) walk(child, 0);
}

export function buildSnapshot(input: {
  targetId: string;
  title: string;
  url: string;
  html?: string;
  outline?: string;
  nodeCount?: number;
  truncated?: boolean;
  maxHtmlChars?: number;
}): DomSnapshot {
  let html = input.html;
  let truncated = Boolean(input.truncated);
  const maxHtmlChars = input.maxHtmlChars ?? 200_000;
  if (html && html.length > maxHtmlChars) {
    html = `${html.slice(0, maxHtmlChars)}\n<!-- truncated -->`;
    truncated = true;
  }
  return {
    targetId: input.targetId,
    title: input.title,
    url: input.url,
    capturedAt: Date.now(),
    html,
    outline: input.outline,
    nodeCount: input.nodeCount,
    truncated,
  };
}

function formatTag(node: DomNode): string {
  const name = (node.nodeName ?? 'div').toLowerCase();
  const attrs = attrMap(node.attributes);
  let out = `<${name}`;
  if (attrs.id) out += `#${attrs.id}`;
  if (attrs.class) {
    const classes = attrs.class.split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    if (classes) out += `.${classes}`;
  }
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'id' || key === 'class' || key === 'style') continue;
    if (key.startsWith('data-') || key.startsWith('aria-')) continue;
    if (value.length > 40) continue;
    out += ` ${key}="${value}"`;
  }
  out += '>';
  return out;
}

function attrMap(attributes?: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!attributes) return out;
  for (let i = 0; i + 1 < attributes.length; i += 2) {
    out[attributes[i]] = attributes[i + 1];
  }
  return out;
}

function indent(level: number): string {
  return '  '.repeat(level);
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
