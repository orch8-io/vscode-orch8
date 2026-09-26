import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import * as vscode from 'vscode';
import {
  applyArgs,
  commandLine,
  contractTestArgs,
  devArgs,
  preflightTerminalArgs,
  shellFlavorFor,
  smokeTestArgs,
} from './cliArgs';
import { cliEnv, readConfig } from './config';
import { contractsPathFor } from './sequenceFiles';

/** Resolve the target sequence document for a command (CodeLens passes a URI). */
export async function targetDocument(arg?: unknown): Promise<vscode.TextDocument | undefined> {
  const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
  if (!uri) {
    void vscode.window.showWarningMessage('Orch8: open a sequence file first.');
    return undefined;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  if (doc.isUntitled) {
    void vscode.window.showWarningMessage('Orch8: save the sequence to a file first.');
    return undefined;
  }
  if (doc.isDirty) await doc.save();
  return doc;
}

export class TerminalRunner implements vscode.Disposable {
  private readonly terminals = new Map<string, vscode.Terminal>();
  private readonly sub = vscode.window.onDidCloseTerminal((t) => {
    for (const [k, v] of this.terminals) if (v === t) this.terminals.delete(k);
  });

  constructor(private readonly secrets: vscode.SecretStorage) {}

  dispose(): void {
    this.sub.dispose();
  }

  /** Run `orch8 <args>` in a named integrated terminal. The API key is passed via env only. */
  async run(name: string, args: string[], cwd: string, scope: vscode.Uri, opts: { fresh?: boolean } = {}): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('Orch8: running the CLI is disabled in untrusted workspaces.');
      return;
    }
    const cfg = readConfig(scope);
    const env = await cliEnv(this.secrets);
    let term = this.terminals.get(name);
    if (term && opts.fresh) {
      term.dispose();
      term = undefined;
    }
    if (!term || term.exitStatus !== undefined) {
      term = vscode.window.createTerminal({ name, cwd, env, iconPath: new vscode.ThemeIcon('run') });
      this.terminals.set(name, term);
    }
    const shell = vscode.env.shell;
    term.show(true);
    term.sendText(commandLine(cfg.cliPath, args, shellFlavorFor(shell, process.platform)));
  }
}

export function registerActionCommands(ctx: vscode.ExtensionContext, runner: TerminalRunner): void {
  const reg = (id: string, fn: (arg?: unknown) => Promise<void>) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('orch8.runDev', async (arg) => {
    const doc = await targetDocument(arg);
    if (!doc) return;
    const cfg = readConfig(doc.uri);
    // `orch8 dev` is a long-running hot-reload studio: give each run a fresh terminal.
    await runner.run('orch8 dev', devArgs(doc.uri.fsPath, cfg.devExtraArgs), dirname(doc.uri.fsPath), doc.uri, { fresh: true });
  });

  reg('orch8.test', async (arg) => {
    const doc = await targetDocument(arg);
    if (!doc) return;
    const contracts = contractsPathFor(doc.uri.fsPath);
    const args = existsSync(contracts) ? contractTestArgs(contracts, doc.uri.fsPath) : smokeTestArgs(doc.uri.fsPath);
    await runner.run('orch8 test', args, dirname(doc.uri.fsPath), doc.uri);
  });

  reg('orch8.deploy', async (arg) => {
    const doc = await targetDocument(arg);
    if (!doc) return;
    const cfg = readConfig(doc.uri);
    const target = cfg.serverUrl?.trim() || 'the CLI default server (ORCH8_URL / context)';
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(diff) Dry run', description: 'orch8 sequence apply --dry-run', dryRun: true },
        { label: '$(cloud-upload) Apply', description: `orch8 sequence apply → ${target}`, dryRun: false },
      ],
      { title: `Deploy ${vscode.workspace.asRelativePath(doc.uri)}`, placeHolder: 'Git-ops apply: upload a new version only if the definition changed' },
    );
    if (!pick) return;
    await runner.run('orch8 deploy', applyArgs(doc.uri.fsPath, pick.dryRun, cfg), dirname(doc.uri.fsPath), doc.uri);
  });

  reg('orch8.preflightInTerminal', async (arg) => {
    const doc = await targetDocument(arg);
    if (!doc) return;
    const cfg = readConfig(doc.uri);
    await runner.run('orch8 preflight', preflightTerminalArgs(doc.uri.fsPath, cfg), dirname(doc.uri.fsPath), doc.uri);
  });
}

export class SequenceCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(private readonly isSequence: (doc: vscode.TextDocument) => boolean) {}

  refresh(): void {
    this.changed.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!readConfig(doc.uri).codeLens || !this.isSequence(doc) || doc.isUntitled) return [];
    const range = new vscode.Range(0, 0, 0, 0);
    const hasContracts = existsSync(contractsPathFor(doc.uri.fsPath));
    return [
      new vscode.CodeLens(range, { title: '$(play) Run in orch8 dev', command: 'orch8.runDev', arguments: [doc.uri], tooltip: 'orch8 dev <file>' }),
      new vscode.CodeLens(range, {
        title: hasContracts ? '$(beaker) Test (contracts)' : '$(beaker) Smoke test',
        command: 'orch8.test',
        arguments: [doc.uri],
        tooltip: hasContracts ? 'orch8 test run <file>.contracts.json --sequence <file>' : 'orch8 dev <file> --once --dry-run --skip-timers --no-server',
      }),
      new vscode.CodeLens(range, { title: '$(checklist) Preflight', command: 'orch8.preflightInTerminal', arguments: [doc.uri], tooltip: 'orch8 sequence preflight --file <file>' }),
      new vscode.CodeLens(range, { title: '$(cloud-upload) Deploy', command: 'orch8.deploy', arguments: [doc.uri], tooltip: 'orch8 sequence apply <file> [--dry-run]' }),
      new vscode.CodeLens(range, { title: '$(type-hierarchy) Graph', command: 'orch8.showGraph', arguments: [doc.uri] }),
    ];
  }
}
