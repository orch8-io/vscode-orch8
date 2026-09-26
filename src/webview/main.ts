/**
 * Block graph webview. Renders the pre-computed layout as SVG. All text is
 * inserted with textContent (never innerHTML) and no remote resources are
 * loaded; the page runs under a nonce-only script CSP.
 */
import type { GraphLayout, LayoutBox } from '../graph';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface RenderMessage {
  type: 'render';
  title: string;
  layout?: GraphLayout;
  error?: string;
  duplicateIds: string[];
}

const vscode = acquireVsCodeApi();
const SVG_NS = 'http://www.w3.org/2000/svg';
const stage = document.getElementById('stage') as HTMLElement;
const titleEl = document.getElementById('title') as HTMLElement;
const warnEl = document.getElementById('warn') as HTMLElement;

const KIND_LABEL: Record<string, string> = {
  step: 'STEP',
  parallel: 'PARALLEL',
  race: 'RACE',
  loop: 'LOOP',
  for_each: 'FOR EACH',
  router: 'ROUTER',
  try_catch: 'TRY / CATCH',
  sub_sequence: 'SUB-SEQUENCE',
  ab_split: 'A/B SPLIT',
  cancellation_scope: 'CANCELLATION SCOPE',
  saga: 'SAGA',
  saga_step: 'SAGA STEP',
  unknown: 'UNKNOWN',
};

let scale = 1;
let tx = 16;
let ty = 16;
let svg: SVGSVGElement | undefined;
let viewport: SVGGElement | undefined;
let lastLayout: GraphLayout | undefined;

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}, cls?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (cls) node.setAttribute('class', cls);
  return node;
}

function text(x: number, y: number, content: string, cls: string, maxChars?: number): SVGTextElement {
  const t = el('text', { x, y }, cls);
  const clipped = maxChars && content.length > maxChars ? `${content.slice(0, maxChars - 1)}…` : content;
  t.textContent = clipped;
  if (clipped !== content) {
    const tip = el('title');
    tip.textContent = content;
    t.appendChild(tip);
  }
  return t;
}

function applyTransform(): void {
  viewport?.setAttribute('transform', `translate(${tx} ${ty}) scale(${scale})`);
}

function fit(): void {
  if (!lastLayout || !svg) return;
  const w = stage.clientWidth || 800;
  const h = stage.clientHeight || 600;
  const s = Math.min(1.25, (w - 32) / Math.max(1, lastLayout.width), (h - 32) / Math.max(1, lastLayout.height));
  scale = Math.max(0.2, s);
  tx = Math.max(16, (w - lastLayout.width * scale) / 2);
  ty = 16;
  applyTransform();
}

function reveal(box: LayoutBox): void {
  vscode.postMessage({ type: 'reveal', pointer: box.pointer });
}

function drawBox(g: SVGGElement, box: LayoutBox): void {
  const group = el('g', { tabindex: 0, role: 'button' }, `node kind-${box.kind}${box.container ? ' container' : ''}${box.duplicate ? ' duplicate' : ''}`);
  const aria = `${KIND_LABEL[box.kind] ?? box.kind} ${box.label}${box.detail ? `, ${box.detail}` : ''}`;
  group.setAttribute('aria-label', aria);
  const tip = el('title');
  tip.textContent = `${aria}${box.badges.length ? ` [${box.badges.join(', ')}]` : ''}${box.duplicate ? ' — duplicate id!' : ''}\nClick to reveal in editor`;
  group.appendChild(tip);
  group.appendChild(el('rect', { x: box.x, y: box.y, width: box.w, height: box.h, rx: 6, ry: 6 }, 'box'));
  group.appendChild(el('rect', { x: box.x, y: box.y, width: 4, height: box.container ? 36 : box.h, rx: 2 }, 'accent'));
  const maxChars = Math.floor((box.w - 20) / 7);
  group.appendChild(text(box.x + 12, box.y + 14, KIND_LABEL[box.kind] ?? box.kind, 'kind'));
  group.appendChild(text(box.x + 12, box.y + 29, box.label, 'label', maxChars));
  if (box.detail) {
    if (box.container) {
      group.appendChild(text(box.x + box.w - 10, box.y + 14, box.detail, 'detail right', Math.floor(maxChars / 2)));
    } else {
      group.appendChild(text(box.x + 12, box.y + 42, box.detail, 'detail', maxChars));
    }
  }
  if (box.badges.length && !box.container) {
    group.appendChild(text(box.x + box.w - 8, box.y + 14, box.badges.join(' · '), 'badges right', 22));
  } else if (box.badges.length) {
    group.appendChild(text(box.x + box.w - 10, box.y + 29, box.badges.join(' · '), 'badges right', 22));
  }
  group.addEventListener('click', (e) => {
    e.stopPropagation();
    reveal(box);
  });
  group.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      reveal(box);
    }
  });
  g.appendChild(group);
}

function render(msg: RenderMessage): void {
  titleEl.textContent = msg.title;
  if (msg.duplicateIds.length) {
    warnEl.hidden = false;
    warnEl.textContent = `Duplicate block ids: ${msg.duplicateIds.join(', ')}`;
  } else {
    warnEl.hidden = true;
    warnEl.textContent = '';
  }
  stage.replaceChildren();
  if (msg.error || !msg.layout) {
    const p = document.createElement('p');
    p.className = 'error';
    p.textContent = msg.error ?? 'Nothing to show.';
    stage.appendChild(p);
    svg = undefined;
    return;
  }
  const first = !lastLayout;
  lastLayout = msg.layout;
  svg = el('svg', { width: '100%', height: '100%' }, 'graph');
  const defs = el('defs');
  const marker = el('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
  marker.appendChild(el('path', { d: 'M 0 0 L 10 5 L 0 10 z' }, 'arrowhead'));
  defs.appendChild(marker);
  svg.appendChild(defs);
  viewport = el('g');
  svg.appendChild(viewport);

  const layout = msg.layout;
  // Containers first (outermost boxes precede their children in layout order).
  for (const box of layout.boxes) drawBox(viewport, box);
  for (const lane of layout.laneLabels) {
    viewport.appendChild(el('line', { x1: lane.x, y1: lane.y + 16, x2: lane.x + lane.w, y2: lane.y + 16 }, 'lane-rule'));
    viewport.appendChild(text(lane.x + 2, lane.y + 12, lane.text, 'lane', Math.floor(lane.w / 6.5)));
  }
  for (const e of layout.edges) {
    const midY = (e.y1 + e.y2) / 2;
    const d = e.x1 === e.x2 ? `M ${e.x1} ${e.y1} L ${e.x2} ${e.y2 - 1}` : `M ${e.x1} ${e.y1} C ${e.x1} ${midY}, ${e.x2} ${midY}, ${e.x2} ${e.y2 - 1}`;
    viewport.appendChild(el('path', { d, 'marker-end': 'url(#arrow)' }, 'edge'));
  }
  stage.appendChild(svg);
  if (first) fit();
  else applyTransform();
}

// ---- pan & zoom ------------------------------------------------------------
let dragging: { x: number; y: number; tx: number; ty: number } | undefined;
stage.addEventListener('pointerdown', (e) => {
  if ((e.target as Element).closest('.node')) return;
  dragging = { x: e.clientX, y: e.clientY, tx, ty };
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  tx = dragging.tx + (e.clientX - dragging.x);
  ty = dragging.ty + (e.clientY - dragging.y);
  applyTransform();
});
stage.addEventListener('pointerup', () => (dragging = undefined));
stage.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (!e.ctrlKey && !e.metaKey) {
      tx -= e.deltaX;
      ty -= e.deltaY;
      applyTransform();
      return;
    }
    zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.offsetX, e.offsetY);
  },
  { passive: false },
);

function zoomAt(factor: number, cx: number, cy: number): void {
  const next = Math.min(3, Math.max(0.15, scale * factor));
  const k = next / scale;
  tx = cx - (cx - tx) * k;
  ty = cy - (cy - ty) * k;
  scale = next;
  applyTransform();
}

document.getElementById('zoom-in')?.addEventListener('click', () => zoomAt(1.2, stage.clientWidth / 2, stage.clientHeight / 2));
document.getElementById('zoom-out')?.addEventListener('click', () => zoomAt(1 / 1.2, stage.clientWidth / 2, stage.clientHeight / 2));
document.getElementById('zoom-reset')?.addEventListener('click', fit);

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const msg = event.data as Partial<RenderMessage> | null;
  if (msg && msg.type === 'render') render(msg as RenderMessage);
});

vscode.postMessage({ type: 'ready' });
