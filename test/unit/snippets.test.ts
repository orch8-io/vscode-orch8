import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { renderStarter, sanitizeName, STARTERS, starterFileName } from '../../src/templates';

const root = join(__dirname, '..', '..');
const load = (rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const schema = load('schemas/sequence.authoring.schema.json');
const strict = load('schemas/sequence.schema.json');

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const validateBlock = ajv.compile({ $ref: `${schema.$id as string}#/$defs/BlockDefinition` });

/** Expand a snippet body the way VS Code does when every tab stop keeps its default. */
function expandDefaults(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && i + 1 < body.length && '$}\\'.includes(body[i + 1])) {
      out += body[++i];
    } else if (ch === '$' && body[i + 1] === '{') {
      // ${n:default} or ${n|a,b|}
      let j = i + 2;
      while (/\d/.test(body[j])) j++;
      if (body[j] === '|') {
        const end = body.indexOf('|}', j + 1);
        out += body.slice(j + 1, end).split(',')[0];
        i = end + 1;
      } else if (body[j] === ':') {
        // Default runs to the matching unescaped `}`.
        let k = j + 1;
        let def = '';
        while (k < body.length && body[k] !== '}') {
          if (body[k] === '\\' && '$}\\'.includes(body[k + 1])) {
            def += body[k + 1];
            k += 2;
          } else def += body[k++];
        }
        out += def;
        i = k;
      } else throw new Error(`unsupported snippet syntax at ${i}`);
    } else if (ch === '$' && /\d/.test(body[i + 1])) {
      throw new Error('bare tab stops are not used');
    } else out += ch;
  }
  return out;
}

describe('snippets', () => {
  const json = load('snippets/orch8.json.code-snippets') as Record<string, { prefix: string[]; body: string[] }>;
  const yaml = load('snippets/orch8.yaml.code-snippets') as Record<string, { prefix: string[]; body: string[] }>;

  it('JSON and YAML files offer the same snippets', () => {
    expect(Object.keys(json).sort()).toEqual(Object.keys(yaml).sort());
    const prefixes = Object.values(json).flatMap((s) => s.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('covers every block type and the common handlers', () => {
    const bodies = Object.values(json).map((s) => s.body.join('\n'));
    const types = (strict.$defs.BlockDefinition.oneOf as { allOf: { properties?: { type?: { enum: string[] } } }[] }[]).map(
      (o) => o.allOf[1].properties!.type!.enum[0],
    );
    for (const t of types) expect(bodies.some((b) => b.includes(`"type": "${t}"`)), t).toBe(true);
    for (const h of ['llm_call', 'human_review', 'http_request', 'wait_for_event', 'email', 'notify']) {
      expect(bodies.some((b) => b.includes(`"handler": "${h}"`)), h).toBe(true);
    }
  });

  for (const [name, snippet] of Object.entries(json)) {
    it(`JSON "${name}" expands to schema-valid JSON`, () => {
      const value = JSON.parse(expandDefaults(snippet.body.join('\n')));
      const ok = name === 'Orch8: sequence' ? validate(value) : validateBlock(value);
      expect(ok, JSON.stringify((name === 'Orch8: sequence' ? validate : validateBlock).errors)).toBe(true);
    });
  }

  for (const [name, snippet] of Object.entries(yaml)) {
    it(`YAML "${name}" expands to the same value as JSON`, () => {
      const fromYaml = parseYaml(expandDefaults(snippet.body.join('\n')));
      const fromJson = JSON.parse(expandDefaults(json[name].body.join('\n')));
      expect(name === 'Orch8: sequence' ? fromYaml : fromYaml[0]).toEqual(fromJson);
    });
  }
});

describe('starter templates', () => {
  for (const s of STARTERS) {
    for (const format of ['json', 'yaml'] as const) {
      it(`${s.kind} (${format}) is schema-valid`, () => {
        const text = renderStarter('My Flow!', s.kind, format);
        const value = format === 'json' ? JSON.parse(text) : parseYaml(text);
        expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
        expect(value.name).toBe('my-flow');
      });
    }
  }

  it('sanitizes names and file names', () => {
    expect(sanitizeName('  Hello World  ')).toBe('hello-world');
    expect(sanitizeName('***')).toBe('my-workflow');
    expect(starterFileName('Order Flow', 'yaml')).toBe('order-flow.orch8.yaml');
  });
});

describe('bundled schemas', () => {
  it('authoring schema only relaxes server-assigned root fields', () => {
    expect(strict.required).toEqual(expect.arrayContaining(['id', 'created_at', 'name', 'blocks']));
    expect(schema.required).toEqual(['name', 'blocks']);
    expect(schema.$defs).toEqual(strict.$defs);
    expect(schema.properties).toEqual(strict.properties);
  });

  it('rejects an obviously wrong block', () => {
    expect(validateBlock({ type: 'step', id: 'x' })).toBe(false); // handler missing
  });
});
