import { describe, expect, it } from 'vitest';
import { contractsPathFor, declaresSequenceSchema, formatOf, isSequenceDocument, isSequencePath } from '../../src/sequenceFiles';

describe('sequence file detection', () => {
  it('matches the documented patterns', () => {
    for (const p of [
      '/w/checkout.orch8.json',
      '/w/checkout.orch8.yaml',
      '/w/checkout.orch8.yml',
      '/w/orch8.sequence.json',
      '/w/sequences/a.json',
      '/w/sequences/nested/b.yaml',
      'C:\\w\\sequences\\c.yml',
    ]) {
      expect(isSequencePath(p), p).toBe(true);
    }
  });

  it('rejects other files', () => {
    for (const p of ['/w/package.json', '/w/sequences.json', '/w/my-sequences/a.json', '/w/sequences/a.contracts.json', '/w/sequences/readme.md', '/w/x.orch8.txt']) {
      expect(isSequencePath(p), p).toBe(false);
    }
  });

  it('accepts any json/yaml declaring the Orch8 schema', () => {
    const text = '{\n  "$schema": "https://orch8.io/contracts/sequence.schema.json",\n  "name": "x"\n}';
    expect(declaresSequenceSchema(text)).toBe(true);
    expect(isSequenceDocument('/w/flow.json', text)).toBe(true);
    expect(isSequenceDocument('/w/flow.txt', text)).toBe(false);
    expect(isSequenceDocument('/w/flow.json', '{}')).toBe(false);
  });

  it('derives formats and contract paths', () => {
    expect(formatOf('/a/B.JSON')).toBe('json');
    expect(formatOf('/a/b.yml')).toBe('yaml');
    expect(formatOf('/a/b.txt')).toBeUndefined();
    expect(contractsPathFor('/w/checkout.orch8.json')).toBe('/w/checkout.orch8.contracts.json');
    expect(contractsPathFor('/w/sequences/a.yaml')).toBe('/w/sequences/a.contracts.json');
  });
});
