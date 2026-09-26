import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSequenceText } from '../../src/document';
import { buildGraph, LAYOUT, layoutGraph, type GraphNode } from '../../src/graph';

const value = parseSequenceText(readFileSync(join(__dirname, '..', 'fixtures', 'all-blocks.orch8.json'), 'utf8'), 'json').value;

function byId(nodes: GraphNode[], id: string): GraphNode | undefined {
  for (const n of nodes) {
    if (n.blockId === id) return n;
    for (const lane of n.lanes) {
      const hit = byId(lane.nodes, id);
      if (hit) return hit;
    }
  }
  return undefined;
}

describe('buildGraph', () => {
  const graph = buildGraph(value);
  const top = graph.sections[0].nodes;

  it('covers every block type', () => {
    expect(top.map((n) => n.kind)).toEqual([
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
    ]);
    expect(graph.name).toBe('all-blocks');
    expect(graph.sections.map((s) => s.label)).toEqual(['blocks', 'on_failure']);
    expect(graph.duplicateIds).toEqual([]);
  });

  it('builds lanes with correct pointers', () => {
    const parallel = byId(top, 'fan_out')!;
    expect(parallel.lanes.map((l) => l.nodes.map((n) => n.blockId))).toEqual([['a'], ['b', 'b2']]);
    expect(byId(top, 'b2')!.pointer).toEqual(['blocks', '1', 'branches', '1', '1']);

    const router = byId(top, 'route')!;
    expect(router.lanes.map((l) => l.label)).toEqual(['{{ context.data.tier == "gold" …', 'default']);
    expect(byId(top, 'gold')!.pointer).toEqual(['blocks', '5', 'routes', '0', 'blocks', '0']);

    expect(byId(top, 'guarded')!.lanes.map((l) => l.label)).toEqual(['try', 'catch', 'finally']);
    expect(byId(top, 'exp')!.lanes.map((l) => l.label)).toEqual(['control (75%)', 'variant_a (25%)']);

    const saga = byId(top, 'booking')!;
    const step = saga.lanes[0].nodes[0];
    expect(step.kind).toBe('saga_step');
    expect(step.lanes.map((l) => l.label)).toEqual(['action', 'compensate']);
    expect(byId(top, 'release_action')!.pointer).toEqual(['blocks', '10', 'steps', '0', 'compensation']);
  });

  it('adds details and badges', () => {
    expect(byId(top, 'start')).toMatchObject({ detail: 'log', badges: ['retry×3'] });
    expect(byId(top, 'child')!.detail).toBe('→ child-flow v2');
    expect(byId(top, 'poll')!.detail).toBe('while {{ outputs.check.done != true }}');
    expect(byId(top, 'poll')!.badges).toEqual(['max 5']);
    expect(byId(top, 'each')!.detail).toBe('each item in {{ context.data.items }}');
  });

  it('flags duplicate ids and tolerates junk', () => {
    const g = buildGraph({
      blocks: [
        { type: 'step', id: 'x', handler: 'noop' },
        { type: 'step', id: 'x', handler: 'noop' },
        { type: 'mystery', id: 'm' },
        { handler: 'noop' },
        42,
      ],
    });
    expect(g.duplicateIds).toEqual(['x']);
    expect(g.sections[0].nodes.map((n) => n.kind)).toEqual(['step', 'step', 'unknown', 'step', 'unknown']);
    expect(g.sections[0].nodes[3].label).toBe('(block without id)');
    expect(buildGraph(null).sections[0].nodes).toEqual([]);
  });
});

describe('layoutGraph', () => {
  const layout = layoutGraph(buildGraph(value));

  it('places every block once', () => {
    const keys = layout.boxes.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
    // 11 top-level + 1 on_failure + nested blocks (a,b,b2,fast,check,process,gold,other,risky,recover,cleanup,ctl,var,must)
    // + saga step + its action/compensation.
    expect(layout.boxes.length).toBe(11 + 1 + 14 + 3);
  });

  it('nests children inside their containers', () => {
    const find = (id: string) => layout.boxes.find((b) => b.label === id)!;
    const inside = (child: string, parent: string) => {
      const c = find(child);
      const p = find(parent);
      return c.x >= p.x && c.y >= p.y && c.x + c.w <= p.x + p.w && c.y + c.h <= p.y + p.h;
    };
    expect(inside('a', 'fan_out')).toBe(true);
    expect(inside('b2', 'fan_out')).toBe(true);
    expect(inside('release_action', 'booking')).toBe(true);
    expect(inside('recover', 'guarded')).toBe(true);
    expect(find('fan_out').container).toBe(true);
    expect(find('start').container).toBe(false);
  });

  it('stacks siblings vertically without overlap and links them with edges', () => {
    const top = layout.boxes.filter((b) => b.pointer.length === 2 && b.pointer[0] === 'blocks');
    for (let i = 1; i < top.length; i++) {
      expect(top[i].y).toBeGreaterThanOrEqual(top[i - 1].y + top[i - 1].h + LAYOUT.gapY - 0.001);
    }
    // 10 edges between the 11 top-level blocks, +1 between b and b2.
    expect(layout.edges.length).toBeGreaterThanOrEqual(11);
    for (const e of layout.edges) expect(e.y2).toBeGreaterThan(e.y1);
  });

  it('puts on_failure in its own column and reports overall size', () => {
    const alert = layout.boxes.find((b) => b.label === 'alert')!;
    const maxMainRight = Math.max(...layout.boxes.filter((b) => b.pointer[0] === 'blocks').map((b) => b.x + b.w));
    expect(alert.x).toBeGreaterThan(maxMainRight);
    expect(layout.width).toBeGreaterThanOrEqual(alert.x + alert.w);
    expect(layout.height).toBeGreaterThan(0);
  });

  it('handles an empty sequence', () => {
    const empty = layoutGraph(buildGraph({ blocks: [] }));
    expect(empty.boxes).toEqual([]);
    expect(empty.laneLabels).toHaveLength(1);
  });
});
