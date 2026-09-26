import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findBlockIdPointer,
  findStringValue,
  parsePointer,
  parseSequenceText,
  readablePathToSegments,
  toPointer,
} from '../../src/document';

const fixture = (name: string) => readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8');
const slice = (text: string, r: { start: number; end: number }) => text.slice(r.start, r.end);

describe('JSON pointers', () => {
  it('parses RFC 6901 pointers including escapes and # prefix', () => {
    expect(parsePointer('')).toEqual([]);
    expect(parsePointer('/')).toEqual([]);
    expect(parsePointer('/blocks/0/params')).toEqual(['blocks', '0', 'params']);
    expect(parsePointer('#/a~1b/c~0d')).toEqual(['a/b', 'c~d']);
    expect(parsePointer('blocks/1')).toEqual(['blocks', '1']);
  });

  it('round-trips through toPointer', () => {
    const segs = ['blocks', '0', 'a/b', 'x~y'];
    expect(parsePointer(toPointer(segs))).toEqual(segs);
    expect(toPointer([])).toBe('');
  });

  it('converts engine readable paths', () => {
    expect(readablePathToSegments('blocks[0].retry.max_attempts')).toEqual(['blocks', '0', 'retry', 'max_attempts']);
    expect(readablePathToSegments('blocks.0.retires')).toEqual(['blocks', '0', 'retires']);
    expect(readablePathToSegments('blocks[1].branches[0][2].id')).toEqual(['blocks', '1', 'branches', '0', '2', 'id']);
    expect(readablePathToSegments('on_failure[0].?.handler')).toEqual(['on_failure', '0', 'handler']);
  });
});

describe('JSON locate', () => {
  const text = fixture('all-blocks.orch8.json');
  const doc = parseSequenceText(text, 'json');

  it('decodes the value', () => {
    expect((doc.value as { name: string }).name).toBe('all-blocks');
    expect(doc.syntaxErrors).toEqual([]);
  });

  it('resolves a leaf value exactly', () => {
    const loc = doc.locate(['blocks', '0', 'handler']);
    expect(loc.exact).toBe(true);
    expect(slice(text, loc)).toBe('"log"');
  });

  it('resolves to the key with preferKey', () => {
    const loc = doc.locate(['blocks', '0', 'retry'], { preferKey: true });
    expect(slice(text, loc)).toBe('"retry"');
  });

  it('highlights a container member by its key, an array element by its opening token', () => {
    expect(slice(text, doc.locate(['blocks', '0', 'params']))).toBe('"params"');
    expect(slice(text, doc.locate(['blocks', '1']))).toBe('{');
  });

  it('falls back to the deepest existing ancestor', () => {
    const loc = doc.locate(['blocks', '0', 'retry', 'nope']);
    expect(loc.exact).toBe(false);
    expect(slice(text, loc)).toBe('"retry"');
    const missing = doc.locate(['blocks', '99']);
    expect(missing.exact).toBe(false);
    expect(slice(text, missing)).toBe('"blocks"');
  });

  it('maps the root to the first line', () => {
    const loc = doc.locate([]);
    expect(loc.start).toBe(0);
    expect(text.slice(loc.start, loc.end)).toBe('{');
  });

  it('reports syntax errors without throwing', () => {
    const broken = parseSequenceText('{ "name": ', 'json');
    expect(broken.syntaxErrors.length).toBeGreaterThan(0);
    expect(() => broken.locate(['name'])).not.toThrow();
  });
});

describe('YAML locate', () => {
  const text = fixture('all-blocks.orch8.yaml');
  const doc = parseSequenceText(text, 'yaml');

  it('decodes the value', () => {
    expect((doc.value as { name: string }).name).toBe('yaml-flow');
  });

  it('resolves scalars and keys', () => {
    expect(slice(text, doc.locate(['blocks', '0', 'handler']))).toBe('log');
    expect(slice(text, doc.locate(['blocks', '1', 'branches', '1', '0', 'retires'], { preferKey: true }))).toBe('retires');
    expect(slice(text, doc.locate(['blocks', '0', 'params']))).toBe('params');
  });

  it('falls back to an ancestor key', () => {
    const loc = doc.locate(['blocks', '0', 'params', 'missing']);
    expect(loc.exact).toBe(false);
    expect(slice(text, loc)).toBe('params');
  });

  it('reports YAML syntax errors', () => {
    const broken = parseSequenceText('name: [unclosed', 'yaml');
    expect(broken.value).toBeUndefined();
    expect(broken.syntaxErrors.length).toBeGreaterThan(0);
  });
});

describe('value searches', () => {
  const value = parseSequenceText(fixture('all-blocks.orch8.json'), 'json').value;

  it('finds nested block ids', () => {
    expect(findBlockIdPointer(value, 'b2')).toEqual(['blocks', '1', 'branches', '1', '1', 'id']);
    expect(findBlockIdPointer(value, 'release_action')).toEqual(['blocks', '10', 'steps', '0', 'compensation', 'id']);
    expect(findBlockIdPointer(value, 'nope')).toBeUndefined();
  });

  it('finds string values under a member', () => {
    expect(findStringValue(value, 'http_request', 'handler')).toEqual(['blocks', '6', 'try_block', '0', 'handler']);
    expect(findStringValue(value, 'child-flow', 'sequence_name')).toEqual(['blocks', '7', 'sequence_name']);
  });
});
