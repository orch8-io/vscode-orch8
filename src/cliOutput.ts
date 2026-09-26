/**
 * Turn orch8 CLI output into editor-agnostic issues, and resolve issues to
 * source ranges. Pure — no `vscode` import.
 *
 * Two producers:
 *  - `orch8 -o json sequence preflight --file <draft>` prints a
 *    `PreflightReport` (engine: orch8-types/src/preflight.rs + finding.rs):
 *    `{ sequence_name, sequence_version, overall, checks: [{ id, status,
 *    summary, findings: [Finding] }], generated_at }`.
 *  - `orch8 sequence upgrade-format <draft>` (offline strict decode +
 *    validate) exits non-zero with `Error: <message>` on stderr.
 */
import {
  findBlockIdPointer,
  findStringContaining,
  findStringValue,
  parsePointer,
  readablePathToSegments,
  type Located,
  type ParsedDocument,
} from './document';

export type IssueSeverity = 'error' | 'warning' | 'info';

export type IssueTarget =
  | { kind: 'pointer'; segments: string[]; preferKey?: boolean }
  | { kind: 'block'; id: string }
  | { kind: 'resource'; resourceKind: string; id: string }
  | { kind: 'document' };

export interface Issue {
  message: string;
  severity: IssueSeverity;
  code?: string;
  docsUrl?: string;
  target: IssueTarget;
  /** Which producer/check reported it, e.g. `preflight/handlers_have_workers`. */
  origin: string;
}

export const DEFAULT_DOCS_BASE = 'https://orch8.io/docs/errors';

/** Codes like `ORCH8-P001` get a documentation anchor. */
export const DOCUMENTED_CODE_RE = /^ORCH8-[A-Z]+\d+$/i;

export function docsUrlForCode(code: string | undefined, base = DEFAULT_DOCS_BASE): string | undefined {
  if (!code || !DOCUMENTED_CODE_RE.test(code)) return undefined;
  return `${base.replace(/#.*$/, '').replace(/\/+$/, '')}#${code}`;
}

// ---------------------------------------------------------------------------
// Preflight report
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export interface PreflightReport {
  sequence_name?: string;
  sequence_version?: number;
  overall: string;
  checks: Json[];
}

/**
 * Extract the report from CLI stdout. The CLI pretty-prints exactly one JSON
 * object; be tolerant of stray log lines around it.
 */
export function parsePreflightStdout(stdout: string): PreflightReport | undefined {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    if (isObj(parsed) && typeof parsed.overall === 'string' && Array.isArray(parsed.checks)) {
      return parsed as unknown as PreflightReport;
    }
  } catch {
    /* not a report */
  }
  return undefined;
}

function findingSeverity(s: unknown): IssueSeverity {
  switch (s) {
    case 'critical':
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    default:
      return 'info';
  }
}

function checkSeverity(status: unknown): IssueSeverity | undefined {
  switch (status) {
    case 'fail':
      return 'error';
    case 'unknown':
    case 'warning':
      return 'warning';
    default:
      return undefined; // pass
  }
}

/** Location hints a finding may carry. The engine is growing pointer support; accept the likely spellings. */
function findingTarget(f: Json): IssueTarget {
  const loc = isObj(f.location) ? f.location : undefined;
  const pointer = str(f.pointer) ?? str(f.json_pointer) ?? str(loc?.pointer) ?? str(loc?.json_pointer);
  if (pointer !== undefined) return { kind: 'pointer', segments: parsePointer(pointer) };
  const path = str(f.path) ?? str(loc?.path);
  if (path !== undefined) {
    return path.startsWith('/') || path.startsWith('#/')
      ? { kind: 'pointer', segments: parsePointer(path) }
      : { kind: 'pointer', segments: readablePathToSegments(path) };
  }
  const res = isObj(f.affected_resource) ? f.affected_resource : undefined;
  const kind = str(res?.kind);
  const id = str(res?.id);
  if (kind && id) {
    return kind === 'block' ? { kind: 'block', id } : { kind: 'resource', resourceKind: kind, id };
  }
  const blockId = str(f.block_id);
  if (blockId) return { kind: 'block', id: blockId };
  return { kind: 'document' };
}

function findingDocsUrl(f: Json, code: string | undefined, docsBase: string): string | undefined {
  const explicit = str(f.docs_url) ?? str(f.doc_url) ?? str(f.documentation_url) ?? str(f.help_url) ?? str(f.url);
  if (explicit && /^https?:\/\//.test(explicit)) return explicit;
  return docsUrlForCode(code, docsBase);
}

function remediationText(f: Json): string {
  const rems = Array.isArray(f.remediation) ? f.remediation.filter(isObj) : [];
  const parts = rems.map((r) => str(r.command) ?? str(r.summary)).filter((s): s is string => !!s);
  return parts.length ? ` — fix: ${parts.join(' | ')}` : '';
}

export function issuesFromPreflight(report: PreflightReport, docsBase = DEFAULT_DOCS_BASE): Issue[] {
  const issues: Issue[] = [];
  for (const check of report.checks) {
    const checkId = str(check.id) ?? 'check';
    const findings = Array.isArray(check.findings) ? check.findings.filter(isObj) : [];
    const origin = `preflight/${checkId}`;
    if (findings.length === 0) {
      const severity = checkSeverity(check.status);
      if (severity) {
        issues.push({
          message: `${checkId}: ${str(check.summary) ?? String(check.status)}`,
          severity,
          target: { kind: 'document' },
          origin,
        });
      }
      continue;
    }
    for (const f of findings) {
      const code = str(f.error_code) ?? str(f.code);
      issues.push({
        message: `${str(f.summary) ?? checkId}${remediationText(f)}`,
        severity: findingSeverity(f.severity),
        code,
        docsUrl: findingDocsUrl(f, code, docsBase),
        target: findingTarget(f),
        origin,
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Offline strict check (`sequence upgrade-format`) errors
// ---------------------------------------------------------------------------

/** Strip `Error: ` and the anyhow `Caused by:` trailer. */
export function cliErrorMessage(stderr: string): string {
  let text = stderr.trim();
  const errIdx = text.lastIndexOf('Error: ');
  if (errIdx >= 0) text = text.slice(errIdx + 'Error: '.length);
  const caused = text.indexOf('\n\nCaused by:');
  if (caused >= 0) text = text.slice(0, caused);
  return text.trim();
}

const UNKNOWN_FIELD_RE = /^unknown field "([^"]+)" at (\S+)/;
const PATH_PREFIX_RE = /^((?:[A-Za-z_$][\w$]*|\[\d+\])(?:\.[A-Za-z_$][\w$]*|\.\d+|\[\d+\])*): (.+)$/s;
const BLOCK_RE = /block `([^`]+)`|duplicate block id: (\S+)/;
const CODE_RE = /\b(ORCH8-[A-Z]+\d+)\b/i;

export function issueFromLocalMessage(message: string, docsBase = DEFAULT_DOCS_BASE): Issue {
  const origin = 'strict-check';
  const code = message.match(CODE_RE)?.[1];
  const base = { severity: 'error' as const, origin, code, docsUrl: docsUrlForCode(code, docsBase), message };
  const unknown = message.match(UNKNOWN_FIELD_RE);
  if (unknown) {
    return { ...base, target: { kind: 'pointer', segments: readablePathToSegments(unknown[2]), preferKey: true } };
  }
  const pathed = message.match(PATH_PREFIX_RE);
  if (pathed) {
    return { ...base, target: { kind: 'pointer', segments: readablePathToSegments(pathed[1]) } };
  }
  const block = message.match(BLOCK_RE);
  const blockId = block?.[1] ?? block?.[2];
  if (blockId && blockId !== '(root)') {
    return { ...base, target: { kind: 'block', id: blockId } };
  }
  return { ...base, target: { kind: 'document' } };
}

export function issuesFromLocalError(stderr: string, docsBase = DEFAULT_DOCS_BASE): Issue[] {
  const message = cliErrorMessage(stderr);
  if (!message) return [];
  // Unknown-field warnings are joined with "; " by the engine.
  return message
    .split(/;\s+(?=unknown field ")/)
    .map((m) => m.trim())
    .filter(Boolean)
    .map((m) => issueFromLocalMessage(m, docsBase));
}

/**
 * Should `auto` mode fall back from preflight to the offline strict check?
 * True when the server could not be reached or rejected the draft outright
 * (the CLI reports `preflight request failed: <status>` without a body).
 */
export function isPreflightUnavailable(stderr: string): boolean {
  return /preflight request failed|error sending request|connection refused|tcp connect|dns error|timed out/i.test(stderr);
}

// ---------------------------------------------------------------------------
// Resolve targets to ranges
// ---------------------------------------------------------------------------

const RESOURCE_MEMBER: Record<string, string> = {
  handler: 'handler',
  sequence: 'sequence_name',
  queue: 'queue_name',
};

export function resolveTarget(target: IssueTarget, doc: ParsedDocument): Located {
  switch (target.kind) {
    case 'pointer':
      return doc.locate(target.segments, { preferKey: target.preferKey });
    case 'block': {
      const segs = findBlockIdPointer(doc.value, target.id);
      return segs ? doc.locate(segs) : { ...doc.locate([]), exact: false };
    }
    case 'resource': {
      const member = RESOURCE_MEMBER[target.resourceKind];
      const segs =
        (member ? findStringValue(doc.value, target.id, member) : undefined) ??
        findStringValue(doc.value, target.id) ??
        findStringContaining(doc.value, target.id);
      return segs ? doc.locate(segs) : { ...doc.locate([]), exact: false };
    }
    case 'document':
      return { ...doc.locate([]), exact: false };
  }
}
