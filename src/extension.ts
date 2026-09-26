import * as vscode from 'vscode';
import { registerActionCommands, SequenceCodeLensProvider, TerminalRunner } from './actions';
import { SECRET_API_KEY, readConfig } from './config';
import { isSequenceTextDocument, SequenceValidator } from './diagnostics';
import { GraphPanel } from './graphPanel';
import { renderStarter, STARTERS, starterFileName } from './templates';

export function activate(ctx: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Orch8');
  const validator = new SequenceValidator(ctx.secrets, log);
  const runner = new TerminalRunner(ctx.secrets);
  const lenses = new SequenceCodeLensProvider(isSequenceTextDocument);
  ctx.subscriptions.push(log, validator, runner);

  const runValidation = (doc: vscode.TextDocument, reason: string) =>
    validator.validate(doc, reason).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.appendLine(`validation error: ${message}`);
      void vscode.window.showWarningMessage(`Orch8: ${message}`, 'Open Settings').then((choice) => {
        if (choice) void vscode.commands.executeCommand('workbench.action.openSettings', 'orch8.cliPath');
      });
    });

  // ---- context key for menus -------------------------------------------------
  const updateContext = (editor: vscode.TextEditor | undefined) => {
    void vscode.commands.executeCommand('setContext', 'orch8.isSequence', !!editor && isSequenceTextDocument(editor.document));
  };
  updateContext(vscode.window.activeTextEditor);

  // ---- diagnostics -----------------------------------------------------------
  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateContext),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (isSequenceTextDocument(doc) && readConfig(doc.uri).validateOnSave) void runValidation(doc, 'save');
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isSequenceTextDocument(doc) && readConfig(doc.uri).validateOnOpen) void runValidation(doc, 'open');
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => validator.clear(doc.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('orch8')) lenses.refresh();
    }),
    vscode.languages.registerCodeLensProvider(
      [
        { language: 'json', scheme: 'file' },
        { language: 'jsonc', scheme: 'file' },
        { language: 'yaml', scheme: 'file' },
      ],
      lenses,
    ),
  );

  // ---- commands --------------------------------------------------------------
  registerActionCommands(ctx, runner);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('orch8.validate', async (arg?: unknown) => {
      const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
      if (!uri) return;
      const doc = await vscode.workspace.openTextDocument(uri);
      const outcome = await runValidation(doc, 'command');
      if (outcome) {
        const where = outcome.mode === 'skipped' ? `skipped (${outcome.note ?? ''})` : `${outcome.mode}: ${outcome.issues} issue(s)`;
        void vscode.window.setStatusBarMessage(`Orch8 validation ${where}`, 5000);
      }
    }),

    vscode.commands.registerCommand('orch8.showGraph', async (arg?: unknown) => {
      const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
      if (!uri) {
        void vscode.window.showWarningMessage('Orch8: open a sequence file first.');
        return;
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      GraphPanel.show(ctx.extensionUri, doc, isSequenceTextDocument);
    }),

    vscode.commands.registerCommand('orch8.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: 'Orch8 API key',
        prompt: 'Stored in VS Code SecretStorage and passed to the CLI as ORCH8_API_KEY.',
        password: true,
        ignoreFocusOut: true,
      });
      if (key === undefined) return;
      if (key.trim() === '') await ctx.secrets.delete(SECRET_API_KEY);
      else await ctx.secrets.store(SECRET_API_KEY, key.trim());
      void vscode.window.showInformationMessage(key.trim() ? 'Orch8 API key saved.' : 'Orch8 API key cleared.');
    }),

    vscode.commands.registerCommand('orch8.clearApiKey', async () => {
      await ctx.secrets.delete(SECRET_API_KEY);
      void vscode.window.showInformationMessage('Orch8 API key cleared.');
    }),

    vscode.commands.registerCommand('orch8.newSequence', () => newSequence()),
  );

  // Validate sequences that are already open when the extension activates.
  for (const doc of vscode.workspace.textDocuments) {
    if (isSequenceTextDocument(doc) && readConfig(doc.uri).validateOnOpen) void runValidation(doc, 'open');
  }
}

async function newSequence(): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'New Orch8 Sequence (1/3)',
    prompt: 'Sequence name',
    value: 'my-workflow',
    validateInput: (v) => (v.trim() ? undefined : 'A name is required'),
  });
  if (!name) return;
  const starter = await vscode.window.showQuickPick(
    STARTERS.map((s) => ({ label: s.label, description: s.description, starter: s.kind })),
    { title: 'New Orch8 Sequence (2/3)', placeHolder: 'Starter' },
  );
  if (!starter) return;
  const fmt = await vscode.window.showQuickPick(
    [
      { label: 'JSON', description: '*.orch8.json', format: 'json' as const },
      { label: 'YAML', description: '*.orch8.yaml (needs an engine build with YAML support to run)', format: 'yaml' as const },
    ],
    { title: 'New Orch8 Sequence (3/3)', placeHolder: 'Format' },
  );
  if (!fmt) return;
  const content = renderStarter(name, starter.starter, fmt.format);
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    const doc = await vscode.workspace.openTextDocument({ language: fmt.format, content });
    await vscode.window.showTextDocument(doc);
    return;
  }
  const target = vscode.Uri.joinPath(folder.uri, 'sequences', starterFileName(name, fmt.format));
  try {
    await vscode.workspace.fs.stat(target);
    void vscode.window.showErrorMessage(`Orch8: ${vscode.workspace.asRelativePath(target)} already exists.`);
    return;
  } catch {
    /* does not exist — good */
  }
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
  const doc = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(doc);
}

export function deactivate(): void {
  /* disposables are released through the extension context */
}
