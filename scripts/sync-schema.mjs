#!/usr/bin/env node
// Re-sync the bundled sequence JSON Schema from the engine repo.
//
//   node scripts/sync-schema.mjs [path/to/engine]      (default: ../engine)
//   ORCH8_ENGINE_DIR=/path/to/engine npm run sync-schema
//   node scripts/sync-schema.mjs --check               (exit 1 if out of date)
//
// Writes two files:
//   schemas/sequence.schema.json            verbatim copy of engine/contracts/sequence.schema.json
//   schemas/sequence.authoring.schema.json  same schema, but server-assigned root
//                                           fields (id, created_at, tenant_id,
//                                           namespace, version) are optional — the
//                                           CLI (`orch8 dev`, `sequence apply`,
//                                           `generate`) fills them for drafts.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
const positional = args.filter((a) => !a.startsWith('--'));
const engineDir = resolve(positional[0] ?? process.env.ORCH8_ENGINE_DIR ?? join(root, '..', 'engine'));
const source = join(engineDir, 'contracts', 'sequence.schema.json');

if (!existsSync(source)) {
  console.error(`sync-schema: ${source} not found (pass the engine repo path as the first argument)`);
  process.exit(2);
}

export const SERVER_ASSIGNED = ['id', 'created_at', 'tenant_id', 'namespace', 'version'];

const raw = readFileSync(source, 'utf8');
const schema = JSON.parse(raw);
const authoring = structuredClone(schema);
authoring.$id = 'https://orch8.io/contracts/sequence.authoring.schema.json';
authoring.title = `${schema.title ?? 'SequenceDefinition'} (authoring draft)`;
authoring.description =
  'Authoring variant of the Orch8 sequence schema bundled with the VS Code extension. ' +
  'Server-assigned fields (id, created_at, tenant_id, namespace, version) are optional; ' +
  'the CLI fills them when a draft is run, applied, or preflighted.';
authoring.required = (schema.required ?? []).filter((f) => !SERVER_ASSIGNED.includes(f));

const outputs = {
  'schemas/sequence.schema.json': raw.endsWith('\n') ? raw : `${raw}\n`,
  'schemas/sequence.authoring.schema.json': `${JSON.stringify(authoring, null, 2)}\n`,
};

let stale = false;
for (const [rel, content] of Object.entries(outputs)) {
  const target = join(root, rel);
  const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (current === content) {
    console.log(`up to date  ${rel}`);
    continue;
  }
  stale = true;
  if (check) {
    console.log(`STALE       ${rel}`);
  } else {
    writeFileSync(target, content);
    console.log(`wrote       ${rel}`);
  }
}
if (check && stale) process.exit(1);
