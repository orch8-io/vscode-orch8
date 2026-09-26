import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cliErrorMessage,
  docsUrlForCode,
  isPreflightUnavailable,
  issueFromLocalMessage,
  issuesFromLocalError,
  issuesFromPreflight,
  parsePreflightStdout,
  resolveTarget,
} from '../../src/cliOutput';
import { parseSequenceText } from '../../src/document';

const text = readFileSync(join(__dirname, '..', 'fixtures', 'all-blocks.orch8.json'), 'utf8');
const doc = parseSequenceText(text, 'json');
const at = (r: { start: number; end: number }) => text.slice(r.start, r.end);

// Shape matches engine orch8-types PreflightReport / Finding serialization.
const REPORT = {
  sequence_name: 'all-blocks',
  sequence_version: 1,
  overall: 'fail',
  generated_at: '2026-09-26T00:00:00Z',
  checks: [
    { id: 'definition_valid', status: 'pass', summary: 'definition is valid' },
    {
      id: 'handlers_have_workers',
      status: 'fail',
      summary: '1 handler has no live worker',
      findings: [
        {
          code: 'NO_COMPATIBLE_WORKER',
          severity: 'error',
          summary: 'no live worker polls handler "http_request"',
          affected_resource: { kind: 'handler', id: 'http_request' },
          remediation: [{ summary: 'start a worker', command: 'orch8 runtime list', side_effect_risk: false }],
          confidence: 'high',
          observed_at: '2026-09-26T00:00:00Z',
        },
      ],
    },
    {
      id: 'lint',
      status: 'warning',
      summary: 'lint warnings',
      findings: [
        {
          code: 'ORCH8-P012',
          severity: 'warning',
          summary: 'retry without backoff',
          affected_resource: { kind: 'block', id: 'start' },
          confidence: 'certain',
          observed_at: '2026-09-26T00:00:00Z',
        },
        {
          code: 'ORCH8-P020',
          severity: 'info',
          summary: 'pointer-located finding',
          pointer: '/blocks/0/retry/max_attempts',
          docs_url: 'https://example.test/custom',
          confidence: 'certain',
          observed_at: '2026-09-26T00:00:00Z',
        },
      ],
    },
    { id: 'credentials_present', status: 'unknown', summary: 'credential inventory unavailable' },
  ],
};

describe('preflight report parsing', () => {
  it('extracts the report from pretty-printed stdout with noise', () => {
    const stdout = `warning: something\n${JSON.stringify(REPORT, null, 2)}\n`;
    expect(parsePreflightStdout(stdout)?.overall).toBe('fail');
    expect(parsePreflightStdout('Error: preflight request failed: 400')).toBeUndefined();
    expect(parsePreflightStdout('{"not":"a report"}')).toBeUndefined();
  });

  it('maps findings and failing checks to issues', () => {
    const issues = issuesFromPreflight(REPORT);
    expect(issues).toHaveLength(4);
    const [worker, lint, ptr, unknown] = issues;
    expect(worker).toMatchObject({
      severity: 'error',
      code: 'NO_COMPATIBLE_WORKER',
      docsUrl: undefined,
      origin: 'preflight/handlers_have_workers',
      target: { kind: 'resource', resourceKind: 'handler', id: 'http_request' },
    });
    expect(worker.message).toContain('fix: orch8 runtime list');
    expect(lint).toMatchObject({ severity: 'warning', code: 'ORCH8-P012', docsUrl: 'https://orch8.io/docs/errors#ORCH8-P012', target: { kind: 'block', id: 'start' } });
    expect(ptr).toMatchObject({ severity: 'info', docsUrl: 'https://example.test/custom', target: { kind: 'pointer', segments: ['blocks', '0', 'retry', 'max_attempts'] } });
    expect(unknown).toMatchObject({ severity: 'warning', target: { kind: 'document' }, message: 'credentials_present: credential inventory unavailable' });
  });

  it('resolves issue targets to ranges', () => {
    const [worker, lint, ptr, unknown] = issuesFromPreflight(REPORT);
    expect(at(resolveTarget(worker.target, doc))).toBe('"http_request"');
    expect(at(resolveTarget(lint.target, doc))).toBe('"start"');
    expect(at(resolveTarget(ptr.target, doc))).toBe('3');
    expect(resolveTarget(unknown.target, doc).start).toBe(0);
  });

  it('resolves sub-sequence resources by sequence_name', () => {
    expect(at(resolveTarget({ kind: 'resource', resourceKind: 'sequence', id: 'child-flow' }, doc))).toBe('"child-flow"');
    const missing = resolveTarget({ kind: 'resource', resourceKind: 'credential', id: 'nope' }, doc);
    expect(missing.exact).toBe(false);
  });
});

describe('docs links', () => {
  it('builds anchors only for documented codes', () => {
    expect(docsUrlForCode('ORCH8-P001')).toBe('https://orch8.io/docs/errors#ORCH8-P001');
    expect(docsUrlForCode('ORCH8-P001', 'https://docs.example/errors/')).toBe('https://docs.example/errors#ORCH8-P001');
    expect(docsUrlForCode('NO_COMPATIBLE_WORKER')).toBeUndefined();
    expect(docsUrlForCode(undefined)).toBeUndefined();
  });
});

describe('offline strict-check errors', () => {
  it('strips the anyhow envelope', () => {
    expect(cliErrorMessage('Error: boom\n\nCaused by:\n    inner')).toBe('boom');
    expect(cliErrorMessage('  plain message ')).toBe('plain message');
  });

  it('maps unknown-field warnings (joined by "; ") to keys', () => {
    const issues = issuesFromLocalError(
      'Error: unknown field "retires" at blocks[0].retires (did you mean "retry"?); unknown field "wehn" at blocks.1.wehn',
    );
    expect(issues).toHaveLength(2);
    expect(issues[0].target).toEqual({ kind: 'pointer', segments: ['blocks', '0', 'retires'], preferKey: true });
    expect(issues[1].target).toEqual({ kind: 'pointer', segments: ['blocks', '1', 'wehn'], preferKey: true });
    // The field doesn't exist in the fixture, so it falls back to the block container.
    expect(at(resolveTarget(issues[0].target, doc))).toBe('{');
  });

  it('maps path-prefixed decode errors', () => {
    const issue = issueFromLocalMessage('blocks[0].retry.max_attempts: invalid type: string "x", expected u32');
    expect(issue.target).toEqual({ kind: 'pointer', segments: ['blocks', '0', 'retry', 'max_attempts'] });
    expect(at(resolveTarget(issue.target, doc))).toBe('3');
  });

  it('maps block-scoped validation errors', () => {
    expect(issueFromLocalMessage('duplicate block id: gold').target).toEqual({ kind: 'block', id: 'gold' });
    expect(issueFromLocalMessage('block `poll`: max_iterations must be > 0').target).toEqual({ kind: 'block', id: 'poll' });
    expect(issueFromLocalMessage('invalid human_review on block `review`: bad').target).toEqual({ kind: 'block', id: 'review' });
    expect(issueFromLocalMessage('block `(root)`: sequence has no blocks').target).toEqual({ kind: 'document' });
    expect(issueFromLocalMessage('missing field `name`').target).toEqual({ kind: 'document' });
  });

  it('picks up documented codes in messages', () => {
    const issue = issueFromLocalMessage('ORCH8-P003: blocks[0]: bad');
    expect(issue.code).toBe('ORCH8-P003');
    expect(issue.docsUrl).toBe('https://orch8.io/docs/errors#ORCH8-P003');
  });

  it('returns nothing for empty stderr', () => {
    expect(issuesFromLocalError('')).toEqual([]);
  });
});

describe('fallback detection', () => {
  it('detects unreachable / rejecting servers', () => {
    expect(isPreflightUnavailable('Error: preflight request failed: 400 Bad Request')).toBe(true);
    expect(isPreflightUnavailable('Error: error sending request for url (http://127.0.0.1:8080/api/v1/sequences/preflight)')).toBe(true);
    expect(isPreflightUnavailable('Caused by: tcp connect error: Connection refused (os error 61)')).toBe(true);
    expect(isPreflightUnavailable('Error: invalid JSON in draft.json')).toBe(false);
  });
});

describe('real CLI output', () => {
  // Captured from `orch8 --url http://127.0.0.1:18080/api/v1 --output json sequence preflight --file <all-blocks draft>`
  // against `orch8 dev` built from engine main (c487ae1).
  const real = readFileSync(join(__dirname, '..', 'fixtures', 'preflight-report.real.json'), 'utf8');

  it('parses the report and locates every finding in the document', () => {
    const report = parsePreflightStdout(real)!;
    expect(report.overall).toBe('fail');
    const issues = issuesFromPreflight(report);
    expect(issues.length).toBeGreaterThanOrEqual(9);
    for (const issue of issues) {
      const loc = resolveTarget(issue.target, doc);
      expect(loc.exact, `${issue.origin}: ${issue.message}`).toBe(true);
    }
    const missing = issues.find((i) => i.code === 'SUB_SEQUENCE_MISSING')!;
    expect(missing.severity).toBe('error');
    expect(at(resolveTarget(missing.target, doc))).toBe('"child-flow"');
    const poll = issues.find((i) => i.message.startsWith('[poll]'))!;
    expect(at(resolveTarget(poll.target, doc))).toBe('"poll"');
  });

  it('parses real strict-check stderr', () => {
    // Verbatim stderr lines from `orch8 sequence upgrade-format <draft>`.
    const cases: [string, string][] = [
      ['Error: unknown field "retires" at blocks[0].retires (did you mean "retry"?)', '{'],
      ['Error: blocks[1].branches[0][0].retry.max_attempts: invalid type: string "x", expected u32', '{'],
      ['Error: duplicate block id: start', '"start"'],
    ];
    for (const [stderr, expected] of cases) {
      const [issue] = issuesFromLocalError(stderr);
      expect(at(resolveTarget(issue.target, doc)), stderr).toBe(expected);
    }
  });
});
