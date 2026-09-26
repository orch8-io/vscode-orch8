/**
 * Parse a sequence document (JSON or YAML) into a plain value plus a locator
 * that maps JSON pointers back to source offsets. Pure — no `vscode` import.
 */
import * as jsonc from 'jsonc-parser';
import { isMap, isPair, isScalar, isSeq, parseDocument } from 'yaml';
import type { SequenceFormat } from './sequenceFiles';

export interface OffsetRange {
  start: number;
  end: number;
}

export interface Located extends OffsetRange {
  /** True when the whole pointer resolved; false when an ancestor was used. */
  exact: boolean;
}

export interface ParsedDocument {
  format: SequenceFormat;
  /** The decoded value; `undefined` when the text could not be parsed at all. */
  value: unknown;
  /** Syntax errors (the editor's own language support also reports these). */
  syntaxErrors: { message: string; range: OffsetRange }[];
  /**
   * Resolve a JSON pointer (as segments) to a source range. Falls back to the
   * deepest existing ancestor. With `preferKey`, an object member resolves to
   * its key instead of its value (useful for "unknown field" findings).
   */
  locate(segments: readonly string[], options?: { preferKey?: boolean }): Located;
}

// ---------------------------------------------------------------------------
// JSON pointers and CLI "readable paths"
// ---------------------------------------------------------------------------

/** RFC 6901 pointer → segments. Accepts `""`, `"/"`-prefixed, and `#/`-prefixed forms. */
export function parsePointer(pointer: string): string[] {
  let p = pointer.trim();
  if (p.startsWith('#')) p = p.slice(1);
  if (p === '' || p === '/') return [];
  if (!p.startsWith('/')) p = `/${p}`;
  return p
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function toPointer(segments: readonly string[]): string {
  if (segments.length === 0) return '';
  return `/${segments.map((s) => s.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
}

/**
 * The engine reports decode errors with "readable" paths such as
 * `blocks[0].retry.max_attempts` (serde_path_to_error, prettified) and
 * unknown fields as `blocks.0.retires` / `blocks[0].retires`. Convert either
 * form to pointer segments.
 */
export function readablePathToSegments(path: string): string[] {
  const out: string[] = [];
  for (const m of path.matchAll(/\[(\d+)\]|\[["']([^"']*)["']\]|([^.[\]]+)/g)) {
    const seg = m[1] ?? m[2] ?? m[3];
    if (seg === undefined || seg === '?') continue;
    out.push(seg);
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

function jsonChild(node: jsonc.Node, segment: string): jsonc.Node | undefined {
  if (node.type === 'object') {
    // Last duplicate key wins, matching JSON.parse semantics.
    let found: jsonc.Node | undefined;
    for (const prop of node.children ?? []) {
      const key = prop.children?.[0];
      if (key && key.value === segment) found = prop;
    }
    return found;
  }
  if (node.type === 'array' && /^\d+$/.test(segment)) {
    return node.children?.[Number(segment)];
  }
  return undefined;
}

function firstLine(text: string): OffsetRange {
  const nl = text.indexOf('\n');
  return { start: 0, end: nl < 0 ? text.length : Math.max(1, nl) };
}

function parseJson(text: string): ParsedDocument {
  const errors: jsonc.ParseError[] = [];
  const root = jsonc.parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  const value: unknown = root ? jsonc.getNodeValue(root) : undefined;
  const whole = firstLine(text);
  return {
    format: 'json',
    value,
    syntaxErrors: errors.map((e) => ({
      message: jsonc.printParseErrorCode(e.error),
      range: { start: e.offset, end: e.offset + Math.max(1, e.length) },
    })),
    locate(segments, options) {
      if (!root) return { ...whole, exact: false };
      let node: jsonc.Node = root;
      let prop: jsonc.Node | undefined; // property node wrapping `node`, if any
      let exact = true;
      for (const seg of segments) {
        const child = jsonChild(node, seg);
        if (!child) {
          exact = false;
          break;
        }
        if (child.type === 'property') {
          prop = child;
          const valueNode = child.children?.[1];
          if (!valueNode) {
            node = child;
            break;
          }
          node = valueNode;
        } else {
          prop = undefined;
          node = child;
        }
      }
      const keyOf = (p: jsonc.Node | undefined) => p?.children?.[0];
      if (options?.preferKey && exact) {
        const key = keyOf(prop);
        if (key) return { start: key.offset, end: key.offset + key.length, exact };
      }
      // A container (or an unresolved pointer that stopped at one) highlights
      // its key rather than its (possibly huge) body.
      if (node.type === 'object' || node.type === 'array') {
        const key = keyOf(prop);
        if (key) return { start: key.offset, end: key.offset + key.length, exact };
      }
      if (node === root && (node.type === 'object' || node.type === 'array')) {
        return { ...whole, exact: exact && segments.length === 0 };
      }
      if (node.type === 'object' || node.type === 'array') {
        // Array element container (no key): highlight just the opening token.
        return { start: node.offset, end: node.offset + 1, exact };
      }
      return { start: node.offset, end: node.offset + node.length, exact };
    },
  };
}

// ---------------------------------------------------------------------------
// YAML
// ---------------------------------------------------------------------------

function yamlRange(node: unknown): OffsetRange | undefined {
  const r = (node as { range?: [number, number, number] } | null | undefined)?.range;
  return r ? { start: r[0], end: Math.max(r[1], r[0] + 1) } : undefined;
}

function parseYaml(text: string): ParsedDocument {
  const doc = parseDocument(text, { prettyErrors: false, uniqueKeys: false });
  let value: unknown;
  try {
    value = doc.errors.length === 0 ? doc.toJS({ maxAliasCount: 100 }) : undefined;
  } catch {
    value = undefined;
  }
  const whole = firstLine(text);
  return {
    format: 'yaml',
    value,
    syntaxErrors: doc.errors.map((e) => ({
      message: e.message,
      range: { start: e.pos[0], end: Math.max(e.pos[1], e.pos[0] + 1) },
    })),
    locate(segments, options) {
      let node: unknown = doc.contents;
      let keyNode: unknown;
      let exact = true;
      for (const seg of segments) {
        let next: unknown;
        let nextKey: unknown;
        let matched = false;
        if (isMap(node)) {
          for (const item of node.items) {
            if (!isPair(item)) continue;
            const k = isScalar(item.key) ? String(item.key.value) : String(item.key);
            if (k === seg) {
              matched = true;
              next = item.value;
              nextKey = item.key;
            }
          }
        } else if (isSeq(node) && /^\d+$/.test(seg)) {
          next = node.items[Number(seg)];
          matched = next !== undefined;
          nextKey = undefined;
        }
        if (!matched) {
          exact = false;
          break;
        }
        keyNode = nextKey;
        node = next;
        if (next === null || next === undefined) break; // `key:` with no value
      }
      const isContainer = isMap(node) || isSeq(node);
      if (keyNode && (options?.preferKey || !exact || node === null || node === undefined || isContainer)) {
        const r = yamlRange(keyNode);
        if (r) return { ...r, exact };
      }
      if (node === doc.contents) return { ...whole, exact: exact && segments.length === 0 };
      if (isContainer) {
        const r = yamlRange(node);
        if (r) return { start: r.start, end: r.start + 1, exact };
      }
      const r = yamlRange(node);
      return r ? { ...r, exact } : { ...whole, exact: false };
    },
  };
}

export function parseSequenceText(text: string, format: SequenceFormat): ParsedDocument {
  return format === 'json' ? parseJson(text) : parseYaml(text);
}

// ---------------------------------------------------------------------------
// Value-level searches (return pointer segments)
// ---------------------------------------------------------------------------

type Visit = (value: unknown, segments: string[]) => boolean;

/** Depth-first walk; stops at the first node for which `visit` returns true and returns its path. */
export function walk(value: unknown, visit: Visit, segments: string[] = []): string[] | undefined {
  if (visit(value, segments)) return segments;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = walk(value[i], visit, [...segments, String(i)]);
      if (hit) return hit;
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const hit = walk(v, visit, [...segments, k]);
      if (hit) return hit;
    }
  }
  return undefined;
}

function hasStringId(v: unknown): v is { id: string } {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && typeof (v as { id?: unknown }).id === 'string';
}

/** Pointer to the `id` member of the first block / saga step with this id. */
export function findBlockIdPointer(value: unknown, blockId: string): string[] | undefined {
  const hit = walk(value, (v, segs) => segs.length > 0 && hasStringId(v) && v.id === blockId);
  return hit ? [...hit, 'id'] : undefined;
}

/** Pointer to the first string value equal to `needle` (optionally only under a member named `member`). */
export function findStringValue(value: unknown, needle: string, member?: string): string[] | undefined {
  return walk(
    value,
    (v, segs) => typeof v === 'string' && v === needle && (member === undefined || segs[segs.length - 1] === member),
  );
}

/** Pointer to the first string value containing `needle`. */
export function findStringContaining(value: unknown, needle: string): string[] | undefined {
  if (!needle) return undefined;
  return walk(value, (v) => typeof v === 'string' && v.includes(needle));
}
