#!/usr/bin/env node
// Generate snippets/orch8.json.code-snippets and snippets/orch8.yaml.code-snippets
// from scripts/snippet-defs.mjs.   node scripts/gen-snippets.mjs [--check]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, isScalar, stringify, visit } from 'yaml';
import { SNIPPETS } from './snippet-defs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

/** Escape snippet metacharacters, then turn markers into tab stops. */
export function toSnippetSource(text) {
  let out = text
    .replace(/(["']?)@@(⟨[^⟩]*⟩|[^@]*)@@\1/g, '$2') // unquote numeric markers
    .replace(/\\/g, '\\\\')
    .replace(/\$/g, '\\$')
    .replace(/\}/g, '\\}');
  out = out.replace(/⟨(\d+)\|([^⟩]*)\|⟩/g, (_, n, opts) => `\${${n}|${opts.replace(/\\\}/g, '}')}|}`);
  out = out.replace(/⟨(\d+):([^⟩]*)⟩/g, (_, n, def) => `\${${n}:${def}}`);
  return out;
}

/** The text a marker-bearing string becomes when every tab stop keeps its default. */
function defaultsOf(text) {
  return text
    .replace(/\u27e8\d+\|([^,|]*)[^\u27e9]*\|\u27e9/g, '$1')
    .replace(/\u27e8\d+:([^\u27e9]*)\u27e9/g, '$1');
}

/**
 * YAML: a marker at the start of a plain scalar hides characters (e.g. `{{`)
 * that need quoting once the default is expanded. Quote those scalars.
 */
function toYaml(value) {
  const doc = new Document(value);
  visit(doc, {
    Scalar(_, node) {
      if (!isScalar(node) || typeof node.value !== 'string' || !node.value.includes('\u27e8')) return;
      if (/^@@.*@@$/.test(node.value)) return; // numeric marker, emitted bare
      const expanded = stringify(defaultsOf(node.value)).trim();
      if (expanded.startsWith('"') || expanded.startsWith("'")) node.type = 'QUOTE_DOUBLE';
    },
  });
  return doc.toString({ lineWidth: 0 }).trimEnd();
}

function render(kind) {
  const file = {};
  for (const s of SNIPPETS) {
    const text =
      kind === 'json'
        ? JSON.stringify(s.body, null, 2)
        : toYaml(s.name === 'Orch8: sequence' ? s.body : [s.body]);
    file[s.name] = { prefix: s.prefix, description: s.description, body: toSnippetSource(text).split('\n') };
  }
  return `${JSON.stringify(file, null, 2)}\n`;
}

let stale = false;
for (const kind of ['json', 'yaml']) {
  const rel = `snippets/orch8.${kind}.code-snippets`;
  const target = join(root, rel);
  const content = render(kind);
  const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (current === content) {
    console.log(`up to date  ${rel}`);
    continue;
  }
  stale = true;
  if (check) console.log(`STALE       ${rel}`);
  else {
    writeFileSync(target, content);
    console.log(`wrote       ${rel}`);
  }
}
if (check && stale) process.exit(1);
