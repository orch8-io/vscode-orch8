/** Starter documents for "Orch8: New Orch8 Sequence". Pure — no `vscode` import. */
import { stringify } from 'yaml';
import type { SequenceFormat } from './sequenceFiles';

export type StarterKind = 'hello' | 'llm-review' | 'blank';

export const STARTERS: { kind: StarterKind; label: string; description: string }[] = [
  { kind: 'hello', label: 'Hello world', description: 'Two steps with a retry policy' },
  { kind: 'llm-review', label: 'LLM + human review', description: 'llm_call, a human approval gate, then a router' },
  { kind: 'blank', label: 'Blank', description: 'One noop step' },
];

/** Valid sequence names: what the CLI slugs accept (letters, digits, `-`, `_`, `.`). */
export function sanitizeName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'my-workflow';
}

export function starterSequence(name: string, kind: StarterKind): Record<string, unknown> {
  // No `$schema`: the published https://orch8.io/contracts/sequence.schema.json
  // requires server-assigned fields (id, created_at, …) that drafts omit, and an
  // in-document `$schema` overrides the bundled authoring-schema association.
  // The generated file name (`*.orch8.json` under `sequences/`) is enough.
  const head = {
    schema_version: 1,
    namespace: 'default',
    name: sanitizeName(name),
  };
  switch (kind) {
    case 'blank':
      return { ...head, blocks: [{ type: 'step', id: 'start', handler: 'noop', params: {} }] };
    case 'hello':
      return {
        ...head,
        blocks: [
          { type: 'step', id: 'greet', handler: 'log', params: { message: 'Hello from Orch8!' } },
          {
            type: 'step',
            id: 'call_api',
            handler: 'http_request',
            params: { method: 'GET', url: 'https://example.com' },
            retry: { max_attempts: 3, initial_backoff: 1000, backoff_multiplier: 2 },
          },
        ],
      };
    case 'llm-review':
      return {
        ...head,
        blocks: [
          {
            type: 'step',
            id: 'draft',
            handler: 'llm_call',
            params: {
              provider: 'anthropic',
              model: 'claude-opus-5',
              api_key: 'credentials://llm/api_key',
              messages: [{ role: 'user', content: 'Draft a reply to: {{ context.data.message }}' }],
            },
            retry: { max_attempts: 3 },
          },
          {
            type: 'step',
            id: 'review',
            handler: 'human_review',
            params: { review_data: '{{ outputs.draft }}', instructions: 'Approve the drafted reply' },
            wait_for_input: {
              prompt: 'Send this reply?',
              timeout: 86400000,
              choices: [
                { label: 'Send', value: 'send' },
                { label: 'Discard', value: 'discard' },
              ],
              store_as: 'decision',
            },
          },
          {
            type: 'router',
            id: 'decide',
            routes: [
              {
                condition: 'data.decision == "send"',
                blocks: [{ type: 'step', id: 'send', handler: 'log', params: { message: 'sending' } }],
              },
            ],
            default: [{ type: 'step', id: 'discard', handler: 'log', params: { message: 'discarded' } }],
          },
        ],
      };
  }
}

export function renderStarter(name: string, kind: StarterKind, format: SequenceFormat): string {
  const doc = starterSequence(name, kind);
  return format === 'json' ? `${JSON.stringify(doc, null, 2)}\n` : stringify(doc, { lineWidth: 0 });
}

export function starterFileName(name: string, format: SequenceFormat): string {
  return `${sanitizeName(name)}.orch8.${format === 'json' ? 'json' : 'yaml'}`;
}
