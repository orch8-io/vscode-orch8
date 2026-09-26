/**
 * Which files are Orch8 sequences. Pure — no `vscode` import — so it is unit-testable.
 *
 * Mirrors the `jsonValidation` / `yamlValidation` fileMatch patterns in package.json:
 *   *.orch8.json, *.orch8.yaml, *.orch8.yml, orch8.sequence.json,
 *   and any .json/.yaml/.yml under a `sequences/` directory.
 * A document whose `$schema` points at the Orch8 sequence contract also counts.
 */

export type SequenceFormat = 'json' | 'yaml';

const SCHEMA_URL_RE = /orch8\.io\/contracts\/sequence(\.authoring)?\.schema\.json/;

function normalize(fsPath: string): string {
  return fsPath.replace(/\\/g, '/');
}

export function formatOf(fsPath: string): SequenceFormat | undefined {
  const lower = normalize(fsPath).toLowerCase();
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  return undefined;
}

/** True when the path alone identifies an Orch8 sequence file. */
export function isSequencePath(fsPath: string): boolean {
  const path = normalize(fsPath);
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  if (!formatOf(path)) return false;
  if (/\.orch8\.(json|ya?ml)$/.test(base)) return true;
  if (base === 'orch8.sequence.json') return true;
  // Any file below a `sequences/` directory segment. Contract suites
  // (`*.contracts.json`) live next to sequences but are not sequences.
  if (/(^|\/)sequences\//.test(path) && !base.endsWith('.contracts.json')) return true;
  return false;
}

/** True when the text declares the Orch8 sequence schema via `$schema`. */
export function declaresSequenceSchema(text: string): boolean {
  // Only look at the head of the file: `$schema` is conventionally first.
  return SCHEMA_URL_RE.test(text.slice(0, 2048));
}

export function isSequenceDocument(fsPath: string, text: string): boolean {
  if (!formatOf(fsPath)) return false;
  return isSequencePath(fsPath) || declaresSequenceSchema(text);
}

/** `checkout.orch8.json` → `checkout.orch8.contracts.json`; `a/b.json` → `a/b.contracts.json`. */
export function contractsPathFor(fsPath: string): string {
  return fsPath.replace(/\.(json|ya?ml)$/i, '.contracts.json');
}
