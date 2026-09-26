import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { normalizeDraft, preflightJsonArgs, strictCheckArgs } from './cliArgs';
import {
  isPreflightUnavailable,
  issuesFromLocalError,
  issuesFromPreflight,
  parsePreflightStdout,
  resolveTarget,
  type Issue,
} from './cliOutput';
import { cliEnv, readConfig, type Orch8Config } from './config';
import { parseSequenceText } from './document';
import { runCli } from './runner';
import { formatOf, isSequenceDocument } from './sequenceFiles';

const SOURCE = 'orch8';

export function isSequenceTextDocument(doc: vscode.TextDocument): boolean {
  if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled') return false;
  return isSequenceDocument(doc.uri.fsPath, doc.getText());
}

function toSeverity(s: Issue['severity']): vscode.DiagnosticSeverity {
  switch (s) {
    case 'error':
      return vscode.DiagnosticSeverity.Error;
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    case 'info':
      return vscode.DiagnosticSeverity.Information;
  }
}

export interface ValidationOutcome {
  mode: 'preflight' | 'local' | 'skipped';
  issues: number;
  note?: string;
}

export class SequenceValidator implements vscode.Disposable {
  readonly collection = vscode.languages.createDiagnosticCollection(SOURCE);
  private readonly inflight = new Map<string, AbortController>();
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly log: vscode.OutputChannel,
  ) {
    this.status.name = 'Orch8 validation';
  }

  dispose(): void {
    for (const c of this.inflight.values()) c.abort();
    this.collection.dispose();
    this.status.dispose();
  }

  clear(uri: vscode.Uri): void {
    this.inflight.get(uri.toString())?.abort();
    this.collection.delete(uri);
  }

  async validate(doc: vscode.TextDocument, reason: string): Promise<ValidationOutcome> {
    const cfg = readConfig(doc.uri);
    const format = formatOf(doc.uri.fsPath) ?? (doc.languageId === 'yaml' ? 'yaml' : 'json');
    if (cfg.validationMode === 'off') return { mode: 'skipped', issues: 0, note: 'validation.mode is off' };
    if (!vscode.workspace.isTrusted) return { mode: 'skipped', issues: 0, note: 'workspace is not trusted' };
    if (format === 'yaml' && !cfg.validateYaml) return { mode: 'skipped', issues: 0, note: 'YAML CLI validation disabled' };

    const key = doc.uri.toString();
    this.inflight.get(key)?.abort();
    const abort = new AbortController();
    this.inflight.set(key, abort);

    const text = doc.getText();
    const startVersion = doc.version;
    const parsed = parseSequenceText(text, format);
    if (parsed.value === undefined || parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
      // Syntax errors are reported by the JSON / YAML language support.
      this.collection.delete(doc.uri);
      return { mode: 'skipped', issues: 0, note: 'document does not parse as an object' };
    }

    const draft = normalizeDraft(parsed.value as Record<string, unknown>, {
      tenantId: cfg.tenantId,
      newId: randomUUID,
      now: () => new Date(),
    });
    const dir = await mkdtemp(join(tmpdir(), 'orch8-vscode-'));
    const draftFile = join(dir, 'draft.json');
    try {
      await writeFile(draftFile, JSON.stringify(draft), 'utf8');
      const env = await cliEnv(this.secrets);
      const cwd = doc.uri.scheme === 'file' ? dirname(doc.uri.fsPath) : undefined;
      const { issues, mode, note } = await this.collect(cfg, draftFile, env, cwd, abort.signal);
      if (abort.signal.aborted) return { mode: 'skipped', issues: 0, note: 'superseded' };

      // The user may have kept typing while the CLI ran: map onto the current text.
      const current = doc.version === startVersion ? parsed : parseSequenceText(doc.getText(), format);
      const diagnostics = issues.map((issue) => {
        const loc = resolveTarget(issue.target, current);
        const range = new vscode.Range(doc.positionAt(loc.start), doc.positionAt(loc.end));
        const d = new vscode.Diagnostic(range, issue.message, toSeverity(issue.severity));
        d.source = mode === 'preflight' ? `${SOURCE} preflight` : `${SOURCE} strict-check`;
        if (issue.code) {
          d.code = issue.docsUrl ? { value: issue.code, target: vscode.Uri.parse(issue.docsUrl) } : issue.code;
        }
        return d;
      });
      this.collection.set(doc.uri, diagnostics);
      this.log.appendLine(`[${new Date().toISOString()}] ${reason}: ${mode} → ${diagnostics.length} issue(s) for ${doc.uri.fsPath}${note ? ` (${note})` : ''}`);
      this.showStatus(mode, diagnostics.length, note);
      return { mode, issues: diagnostics.length, note };
    } finally {
      if (this.inflight.get(key) === abort) this.inflight.delete(key);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async collect(
    cfg: Orch8Config,
    draftFile: string,
    env: Record<string, string>,
    cwd: string | undefined,
    signal: AbortSignal,
  ): Promise<{ issues: Issue[]; mode: 'preflight' | 'local'; note?: string }> {
    let note: string | undefined;
    if (cfg.validationMode === 'auto' || cfg.validationMode === 'preflight') {
      const args = preflightJsonArgs(draftFile, cfg);
      this.log.appendLine(`$ ${cfg.cliPath} ${args.join(' ')}`);
      const res = await runCli(cfg.cliPath, args, { cwd, env, timeoutMs: cfg.timeoutMs, signal });
      if (res.error?.code === 'ENOENT') throw this.cliMissing(cfg);
      const report = parsePreflightStdout(res.stdout);
      if (report) return { issues: issuesFromPreflight(report, cfg.docsBaseUrl), mode: 'preflight' };
      const why = res.error ? String(res.error.message) : res.stderr.trim();
      this.log.appendLine(`preflight unavailable: ${why}`);
      if (cfg.validationMode === 'preflight' || !(res.error || isPreflightUnavailable(res.stderr))) {
        // Preflight-only mode, or an unexpected CLI failure: surface it once on the document.
        return {
          issues: [{ message: `orch8 preflight failed: ${why || `exit ${res.code}`}`, severity: 'warning', target: { kind: 'document' }, origin: 'preflight' }],
          mode: 'preflight',
        };
      }
      note = 'server preflight unavailable; used offline strict check';
    }
    const args = strictCheckArgs(draftFile);
    this.log.appendLine(`$ ${cfg.cliPath} ${args.join(' ')}`);
    const res = await runCli(cfg.cliPath, args, { cwd, env, timeoutMs: cfg.timeoutMs, signal });
    if (res.error?.code === 'ENOENT') throw this.cliMissing(cfg);
    if (res.code === 0) return { issues: [], mode: 'local', note };
    if (res.error) {
      return {
        issues: [{ message: `orch8 strict check failed: ${res.error.message}`, severity: 'warning', target: { kind: 'document' }, origin: 'strict-check' }],
        mode: 'local',
        note,
      };
    }
    return { issues: issuesFromLocalError(res.stderr, cfg.docsBaseUrl), mode: 'local', note };
  }

  private cliMissing(cfg: Orch8Config): Error {
    return new Error(`orch8 CLI not found at "${cfg.cliPath}". Install it or set "orch8.cliPath".`);
  }

  private showStatus(mode: string, count: number, note?: string): void {
    this.status.text = count === 0 ? `$(pass) orch8 ${mode}` : `$(warning) orch8 ${mode}: ${count}`;
    this.status.tooltip = note ?? `Last Orch8 ${mode} validation`;
    this.status.command = 'workbench.actions.view.problems';
    this.status.show();
  }
}
