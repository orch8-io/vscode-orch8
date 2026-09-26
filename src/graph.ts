/**
 * Build a renderable block graph from a sequence value, and lay it out.
 * Pure — no `vscode` import; shared by the extension host and tests.
 *
 * Model: every block is a node. Composite blocks own *lanes* (branches,
 * try/catch/finally, loop body, router routes, A/B variants, saga steps …);
 * each lane is a vertical list of nodes executed in order. The layout is a
 * nested-box flow: lanes sit side by side inside their parent, nodes stack
 * top-to-bottom within a lane, and consecutive nodes are joined by edges.
 */

export type BlockKind =
  | 'step'
  | 'parallel'
  | 'race'
  | 'loop'
  | 'for_each'
  | 'router'
  | 'try_catch'
  | 'sub_sequence'
  | 'ab_split'
  | 'cancellation_scope'
  | 'saga'
  | 'saga_step'
  | 'unknown';

export interface GraphLane {
  label: string;
  pointer: string[];
  nodes: GraphNode[];
}

export interface GraphNode {
  /** Block id (or a pointer-derived key when the block has no id). */
  key: string;
  blockId?: string;
  kind: BlockKind;
  /** Primary label: the block id. */
  label: string;
  /** Secondary label: handler, condition, sequence name, … */
  detail?: string;
  /** Pointer to the block object — used for click-to-reveal. */
  pointer: string[];
  lanes: GraphLane[];
  /** Small badges: retry, human gate, timeout, when … */
  badges: string[];
}

export interface SequenceGraph {
  name?: string;
  sections: GraphLane[]; // blocks, on_failure, on_cancel
  duplicateIds: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function truncate(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function inferKind(b: Obj): BlockKind {
  const t = s(b.type);
  const known: BlockKind[] = [
    'step',
    'parallel',
    'race',
    'loop',
    'for_each',
    'router',
    'try_catch',
    'sub_sequence',
    'ab_split',
    'cancellation_scope',
    'saga',
  ];
  if (t && (known as string[]).includes(t)) return t as BlockKind;
  if (t) return 'unknown';
  // Untagged: infer from the distinguishing members (legacy/sloppy drafts).
  if ('handler' in b) return 'step';
  if ('try_block' in b) return 'try_catch';
  if ('routes' in b) return 'router';
  if ('variants' in b) return 'ab_split';
  if ('steps' in b) return 'saga';
  if ('sequence_name' in b) return 'sub_sequence';
  if ('collection' in b) return 'for_each';
  if ('condition' in b && 'body' in b) return 'loop';
  if ('branches' in b) return 'parallel';
  return 'unknown';
}

class Builder {
  private seen = new Map<string, number>();

  lane(label: string, value: unknown, pointer: string[]): GraphLane {
    return {
      label,
      pointer,
      nodes: arr(value).map((b, i) => this.block(b, [...pointer, String(i)])),
    };
  }

  duplicates(): string[] {
    return [...this.seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  }

  block(raw: unknown, pointer: string[]): GraphNode {
    const b = isObj(raw) ? raw : {};
    const blockId = s(b.id);
    if (blockId) this.seen.set(blockId, (this.seen.get(blockId) ?? 0) + 1);
    const kind = inferKind(b);
    const node: GraphNode = {
      key: `${pointer.join('/')}`,
      blockId,
      kind,
      label: blockId ?? `(${s(b.type) ?? 'block'} without id)`,
      pointer,
      lanes: [],
      badges: [],
    };
    const p = (m: string) => [...pointer, m];
    switch (kind) {
      case 'step': {
        node.detail = s(b.handler);
        if (isObj(b.retry)) node.badges.push(`retry×${String(b.retry.max_attempts ?? '?')}`);
        if (isObj(b.wait_for_input)) node.badges.push('human');
        if (b.timeout != null) node.badges.push('timeout');
        if (b.when != null) node.badges.push('when');
        if (isObj(b.delay)) node.badges.push('delay');
        if (isObj(b.compensation)) node.badges.push('comp');
        break;
      }
      case 'parallel':
      case 'race': {
        node.detail = kind === 'race' ? s(b.semantics) ?? 'first wins' : 'all branches';
        arr(b.branches).forEach((br, i) => node.lanes.push(this.lane(`branch ${i + 1}`, br, [...p('branches'), String(i)])));
        break;
      }
      case 'loop': {
        node.detail = s(b.condition) ? `while ${truncate(s(b.condition) ?? '')}` : undefined;
        if (typeof b.max_iterations === 'number') node.badges.push(`max ${b.max_iterations}`);
        node.lanes.push(this.lane('body', b.body, p('body')));
        break;
      }
      case 'for_each': {
        node.detail = s(b.collection) ? `each ${s(b.item_var) ?? 'item'} in ${truncate(s(b.collection) ?? '')}` : undefined;
        node.lanes.push(this.lane('body', b.body, p('body')));
        break;
      }
      case 'router': {
        arr(b.routes).forEach((r, i) => {
          const route = isObj(r) ? r : {};
          node.lanes.push(
            this.lane(truncate(s(route.condition) ?? `route ${i + 1}`, 32), route.blocks, [...p('routes'), String(i), 'blocks']),
          );
        });
        if (Array.isArray(b.default)) node.lanes.push(this.lane('default', b.default, p('default')));
        break;
      }
      case 'try_catch': {
        node.lanes.push(this.lane('try', b.try_block, p('try_block')));
        node.lanes.push(this.lane('catch', b.catch_block, p('catch_block')));
        if (Array.isArray(b.finally_block)) node.lanes.push(this.lane('finally', b.finally_block, p('finally_block')));
        break;
      }
      case 'sub_sequence': {
        const version = typeof b.version === 'number' ? ` v${b.version}` : '';
        node.detail = s(b.sequence_name) ? `→ ${s(b.sequence_name)}${version}` : undefined;
        break;
      }
      case 'ab_split': {
        const variants = arr(b.variants);
        const total = variants.reduce<number>((acc, v) => acc + (isObj(v) && typeof v.weight === 'number' ? v.weight : 0), 0);
        variants.forEach((v, i) => {
          const variant = isObj(v) ? v : {};
          const w = typeof variant.weight === 'number' ? variant.weight : 0;
          const pct = total > 0 ? ` (${Math.round((w / total) * 100)}%)` : '';
          node.lanes.push(this.lane(`${s(variant.name) ?? `variant ${i + 1}`}${pct}`, variant.blocks, [...p('variants'), String(i), 'blocks']));
        });
        break;
      }
      case 'cancellation_scope': {
        node.detail = 'non-cancellable';
        node.lanes.push(this.lane('scope', b.blocks, p('blocks')));
        break;
      }
      case 'saga': {
        // Saga steps run in order; each shows its action and compensation.
        const lane: GraphLane = { label: 'steps', pointer: p('steps'), nodes: [] };
        arr(b.steps).forEach((st, i) => {
          const step = isObj(st) ? st : {};
          const sp = [...p('steps'), String(i)];
          const stepId = s(step.id);
          const sagaStep: GraphNode = {
            key: sp.join('/'),
            blockId: stepId,
            kind: 'saga_step',
            label: stepId ?? `(saga step ${i + 1})`,
            pointer: sp,
            lanes: [],
            badges: [],
          };
          if (step.action !== undefined) {
            sagaStep.lanes.push({ label: 'action', pointer: [...sp, 'action'], nodes: [this.block(step.action, [...sp, 'action'])] });
          }
          if (isObj(step.compensation)) {
            sagaStep.lanes.push({
              label: 'compensate',
              pointer: [...sp, 'compensation'],
              nodes: [this.block(step.compensation, [...sp, 'compensation'])],
            });
          }
          lane.nodes.push(sagaStep);
        });
        node.lanes.push(lane);
        break;
      }
      case 'saga_step':
      case 'unknown':
        node.detail = s(b.type) ? `unknown type "${s(b.type)}"` : undefined;
        break;
    }
    return node;
  }
}

export function buildGraph(value: unknown): SequenceGraph {
  const root = isObj(value) ? value : {};
  const b = new Builder();
  const sections: GraphLane[] = [b.lane('blocks', root.blocks, ['blocks'])];
  if (Array.isArray(root.on_failure)) sections.push(b.lane('on_failure', root.on_failure, ['on_failure']));
  if (Array.isArray(root.on_cancel)) sections.push(b.lane('on_cancel', root.on_cancel, ['on_cancel']));
  return { name: s(root.name), sections, duplicateIds: b.duplicates() };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface LayoutBox {
  key: string;
  kind: BlockKind;
  label: string;
  detail?: string;
  badges: string[];
  pointer: string[];
  container: boolean;
  duplicate: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutLaneLabel {
  text: string;
  x: number;
  y: number;
  w: number;
  pointer: string[];
}

export interface LayoutEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface GraphLayout {
  width: number;
  height: number;
  boxes: LayoutBox[];
  laneLabels: LayoutLaneLabel[];
  edges: LayoutEdge[];
}

export const LAYOUT = {
  leafW: 184,
  leafH: 48,
  gapY: 22,
  gapX: 16,
  pad: 10,
  header: 40,
  laneLabelH: 20,
  sectionGap: 36,
  minLaneW: 120,
} as const;

interface Size {
  w: number;
  h: number;
}

function laneSize(lane: GraphLane): Size {
  const sizes = lane.nodes.map(nodeSize);
  const w = Math.max(LAYOUT.minLaneW, ...sizes.map((z) => z.w));
  const body = sizes.reduce((acc, z) => acc + z.h, 0) + Math.max(0, sizes.length - 1) * LAYOUT.gapY;
  return { w, h: LAYOUT.laneLabelH + Math.max(body, 24) };
}

const sizeCache = new WeakMap<GraphNode, Size>();

function nodeSize(node: GraphNode): Size {
  const cached = sizeCache.get(node);
  if (cached) return cached;
  const size = computeNodeSize(node);
  sizeCache.set(node, size);
  return size;
}

function computeNodeSize(node: GraphNode): Size {
  if (node.lanes.length === 0) return { w: LAYOUT.leafW, h: LAYOUT.leafH };
  const lanes = node.lanes.map(laneSize);
  const inner = lanes.reduce((acc, z) => acc + z.w, 0) + Math.max(0, lanes.length - 1) * LAYOUT.gapX;
  return {
    w: Math.max(LAYOUT.leafW, inner + LAYOUT.pad * 2),
    h: LAYOUT.header + Math.max(...lanes.map((z) => z.h)) + LAYOUT.pad,
  };
}

export function layoutGraph(graph: SequenceGraph): GraphLayout {
  const out: GraphLayout = { width: 0, height: 0, boxes: [], laneLabels: [], edges: [] };
  const dup = new Set(graph.duplicateIds);

  const placeLane = (lane: GraphLane, x: number, y: number, w: number) => {
    out.laneLabels.push({ text: lane.label, x, y, w, pointer: lane.pointer });
    let cy = y + LAYOUT.laneLabelH;
    let prevBottom: { x: number; y: number } | undefined;
    for (const node of lane.nodes) {
      const size = nodeSize(node);
      const nx = x + (w - size.w) / 2;
      if (prevBottom) out.edges.push({ x1: prevBottom.x, y1: prevBottom.y, x2: nx + size.w / 2, y2: cy });
      placeNode(node, nx, cy);
      prevBottom = { x: nx + size.w / 2, y: cy + size.h };
      cy += size.h + LAYOUT.gapY;
    }
  };

  const placeNode = (node: GraphNode, x: number, y: number) => {
    const size = nodeSize(node);
    out.boxes.push({
      key: node.key,
      kind: node.kind,
      label: node.label,
      detail: node.detail,
      badges: node.badges,
      pointer: node.pointer,
      container: node.lanes.length > 0,
      duplicate: node.blockId !== undefined && dup.has(node.blockId),
      x,
      y,
      w: size.w,
      h: size.h,
    });
    if (node.lanes.length === 0) return;
    const laneSizes = node.lanes.map(laneSize);
    const inner = laneSizes.reduce((acc, z) => acc + z.w, 0) + Math.max(0, laneSizes.length - 1) * LAYOUT.gapX;
    let lx = x + (size.w - inner) / 2;
    node.lanes.forEach((lane, i) => {
      placeLane(lane, lx, y + LAYOUT.header, laneSizes[i].w);
      lx += laneSizes[i].w + LAYOUT.gapX;
    });
  };

  let x = 0;
  for (const section of graph.sections) {
    const size = laneSize(section);
    placeLane(section, x, 0, size.w);
    x += size.w + LAYOUT.sectionGap;
    out.height = Math.max(out.height, size.h);
  }
  out.width = Math.max(0, x - LAYOUT.sectionGap);
  return out;
}
