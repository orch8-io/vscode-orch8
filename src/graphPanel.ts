import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { parseSequenceText } from './document';
import { buildGraph, layoutGraph, type GraphLayout } from './graph';
import { formatOf } from './sequenceFiles';

/** Messages the webview sends. Validated before use — the webview is untrusted input. */
type FromWebview = { type: 'ready' } | { type: 'reveal'; pointer: string[] };

export interface RenderMessage {
  type: 'render';
  title: string;
  layout?: GraphLayout;
  error?: string;
  duplicateIds: string[];
}

function isFromWebview(m: unknown): m is FromWebview {
  if (!m || typeof m !== 'object') return false;
  const msg = m as { type?: unknown; pointer?: unknown };
  if (msg.type === 'ready') return true;
  return (
    msg.type === 'reveal' &&
    Array.isArray(msg.pointer) &&
    msg.pointer.length < 256 &&
    msg.pointer.every((s) => typeof s === 'string' && s.length < 512)
  );
}

export function renderMessageFor(text: string, fsPath: string, languageId: string): RenderMessage {
  const format = formatOf(fsPath) ?? (languageId === 'yaml' ? 'yaml' : 'json');
  const parsed = parseSequenceText(text, format);
  const title = fsPath.split(/[\\/]/).pop() ?? 'sequence';
  if (parsed.value === undefined || parsed.value === null || typeof parsed.value !== 'object') {
    const first = parsed.syntaxErrors[0];
    return { type: 'render', title, error: first ? `Cannot parse: ${first.message}` : 'Cannot parse the document.', duplicateIds: [] };
  }
  const graph = buildGraph(parsed.value);
  return { type: 'render', title: graph.name ?? title, layout: layoutGraph(graph), duplicateIds: graph.duplicateIds };
}

export class GraphPanel implements vscode.Disposable {
  static readonly viewType = 'orch8.blockGraph';
  private static current: GraphPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private ready = false;

  static show(extensionUri: vscode.Uri, doc: vscode.TextDocument, isSequence: (d: vscode.TextDocument) => boolean): void {
    if (GraphPanel.current) {
      GraphPanel.current.setDocument(doc);
      GraphPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      GraphPanel.viewType,
      'Orch8 Graph',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        enableCommandUris: false,
        enableFindWidget: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );
    GraphPanel.current = new GraphPanel(panel, extensionUri, doc, isSequence);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private doc: vscode.TextDocument,
    isSequence: (d: vscode.TextDocument) => boolean,
  ) {
    panel.webview.html = this.html();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: unknown) => this.onMessage(m)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === this.doc.uri.toString()) this.schedule();
      }),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (ed && ed.document.uri.toString() !== this.doc.uri.toString() && isSequence(ed.document)) this.setDocument(ed.document);
      }),
    );
  }

  dispose(): void {
    if (GraphPanel.current === this) GraphPanel.current = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private setDocument(doc: vscode.TextDocument): void {
    this.doc = doc;
    this.post();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.post(), 250);
  }

  private post(): void {
    if (!this.ready) return;
    const msg = renderMessageFor(this.doc.getText(), this.doc.uri.fsPath, this.doc.languageId);
    this.panel.title = `Graph: ${msg.title}`;
    void this.panel.webview.postMessage(msg);
  }

  private async onMessage(raw: unknown): Promise<void> {
    if (!isFromWebview(raw)) return;
    if (raw.type === 'ready') {
      this.ready = true;
      this.post();
      return;
    }
    const format = formatOf(this.doc.uri.fsPath) ?? (this.doc.languageId === 'yaml' ? 'yaml' : 'json');
    const parsed = parseSequenceText(this.doc.getText(), format);
    const idLoc = parsed.locate([...raw.pointer, 'id']);
    const loc = idLoc.exact ? idLoc : parsed.locate(raw.pointer);
    const range = new vscode.Range(this.doc.positionAt(loc.start), this.doc.positionAt(loc.end));
    const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === this.doc.uri.toString());
    const editor = await vscode.window.showTextDocument(this.doc, {
      viewColumn: visible?.viewColumn ?? vscode.ViewColumn.One,
      preserveFocus: false,
      selection: range,
    });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'graph.css'));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource}`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style.toString()}">
<title>Orch8 Graph</title>
</head>
<body>
<header class="toolbar">
  <span id="title" class="title"></span>
  <span id="warn" class="warn" hidden></span>
  <span class="spacer"></span>
  <button id="zoom-out" type="button" title="Zoom out">−</button>
  <button id="zoom-reset" type="button" title="Fit">Fit</button>
  <button id="zoom-in" type="button" title="Zoom in">+</button>
</header>
<main id="stage" tabindex="0" aria-label="Sequence block graph"></main>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }
}
