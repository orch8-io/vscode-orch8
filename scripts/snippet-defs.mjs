// Single source for the JSON and YAML snippet files (see gen-snippets.mjs).
//
// Write values as plain data. Tab stops use helpers that emit markers the
// generator turns into VS Code snippet syntax *after* serialisation, so JSON
// / YAML quoting and snippet escaping never interfere:
//   p(1, 'default text')   -> ${1:default text}
//   c(2, ['a', 'b'])       -> ${2|a,b|}
//   num(p(3, '3'))         -> emitted unquoted (numbers stay numbers)
// Field names follow engine/contracts/sequence.schema.json; handler params
// follow the engine handler docs (llm_call, human_review, http_request,
// wait_for_event, email, notify).

export const p = (n, text) => `⟨${n}:${text}⟩`;
export const c = (n, options) => `⟨${n}|${options.join(',')}|⟩`;
export const num = (marker) => `@@${marker}@@`;

const step = (id, handler, params, extra = {}) => ({ type: 'step', id, handler, params, ...extra });

export const SNIPPETS = [
  // ---- whole document --------------------------------------------------------
  {
    name: 'Orch8: sequence',
    prefix: ['orch8-sequence'],
    description: 'A new Orch8 sequence document',
    body: {
      schema_version: num('1'),
      namespace: p(1, 'default'),
      name: p(2, 'my-workflow'),
      blocks: [step(p(3, 'first_step'), p(4, 'noop'), { message: p(5, 'Hello from Orch8') })],
    },
  },
  // ---- blocks ----------------------------------------------------------------
  {
    name: 'Orch8: step block',
    prefix: ['orch8-step'],
    description: 'Step: run one handler',
    body: step(p(1, 'step_id'), p(2, 'noop'), { [p(3, 'key')]: p(4, 'value') }),
  },
  {
    name: 'Orch8: step with retry',
    prefix: ['orch8-step-retry'],
    description: 'Step with a retry policy and a timeout (ms)',
    body: step(p(1, 'step_id'), p(2, 'http_request'), {}, {
      retry: { max_attempts: num(p(3, '3')), initial_backoff: num(p(4, '1000')), backoff_multiplier: num(p(5, '2')) },
      timeout: num(p(6, '30000')),
    }),
  },
  {
    name: 'Orch8: parallel block',
    prefix: ['orch8-parallel'],
    description: 'Parallel: run every branch concurrently',
    body: {
      type: 'parallel',
      id: p(1, 'fan_out'),
      branches: [[step(p(2, 'branch_a'), p(3, 'noop'), {})], [step(p(4, 'branch_b'), p(5, 'noop'), {})]],
    },
  },
  {
    name: 'Orch8: race block',
    prefix: ['orch8-race'],
    description: 'Race: the first branch to finish wins',
    body: {
      type: 'race',
      id: p(1, 'first_wins'),
      branches: [[step(p(2, 'fast_path'), p(3, 'noop'), {})], [step(p(4, 'slow_path'), p(5, 'noop'), {})]],
    },
  },
  {
    name: 'Orch8: loop block',
    prefix: ['orch8-loop'],
    description: 'Loop: repeat the body while the condition holds',
    body: {
      type: 'loop',
      id: p(1, 'poll'),
      condition: p(2, '{{ outputs.check.done != true }}'),
      max_iterations: num(p(3, '10')),
      body: [step(p(4, 'check'), p(5, 'noop'), {})],
    },
  },
  {
    name: 'Orch8: for_each block',
    prefix: ['orch8-foreach'],
    description: 'ForEach: run the body for every item of a collection',
    body: {
      type: 'for_each',
      id: p(1, 'each_item'),
      collection: p(2, '{{ context.data.items }}'),
      item_var: p(3, 'item'),
      body: [step(p(4, 'process_item'), p(5, 'noop'), {})],
    },
  },
  {
    name: 'Orch8: router block',
    prefix: ['orch8-router'],
    description: 'Router: take the first route whose condition matches',
    body: {
      type: 'router',
      id: p(1, 'route'),
      routes: [{ condition: p(2, '{{ context.data.tier == "gold" }}'), blocks: [step(p(3, 'gold_path'), p(4, 'noop'), {})] }],
      default: [step(p(5, 'default_path'), p(6, 'noop'), {})],
    },
  },
  {
    name: 'Orch8: try_catch block',
    prefix: ['orch8-trycatch'],
    description: 'TryCatch: catch blocks run when try fails; finally always runs',
    body: {
      type: 'try_catch',
      id: p(1, 'guarded'),
      try_block: [step(p(2, 'risky'), p(3, 'http_request'), {})],
      catch_block: [step(p(4, 'recover'), p(5, 'log'), { message: 'recovering' })],
      finally_block: [step(p(6, 'cleanup'), p(7, 'noop'), {})],
    },
  },
  {
    name: 'Orch8: sub_sequence block',
    prefix: ['orch8-subsequence'],
    description: 'SubSequence: invoke another sequence as a child workflow',
    body: {
      type: 'sub_sequence',
      id: p(1, 'child'),
      sequence_name: p(2, 'child-workflow'),
      input: { [p(3, 'key')]: p(4, '{{ context.data.value }}') },
    },
  },
  {
    name: 'Orch8: cancellation_scope block',
    prefix: ['orch8-cancellation-scope'],
    description: 'CancellationScope: children keep running when the instance is cancelled',
    body: {
      type: 'cancellation_scope',
      id: p(1, 'protected'),
      blocks: [step(p(2, 'must_finish'), p(3, 'noop'), {})],
    },
  },
  {
    name: 'Orch8: ab_split block',
    prefix: ['orch8-absplit'],
    description: 'A/B split: route traffic to a variant by weight',
    body: {
      type: 'ab_split',
      id: p(1, 'experiment'),
      variants: [
        { name: p(2, 'control'), weight: num(p(3, '50')), blocks: [step(p(4, 'control_step'), p(5, 'noop'), {})] },
        { name: p(6, 'variant_a'), weight: num(p(7, '50')), blocks: [step(p(8, 'variant_step'), p(9, 'noop'), {})] },
      ],
    },
  },
  {
    name: 'Orch8: saga block',
    prefix: ['orch8-saga'],
    description: 'Saga: ordered steps whose compensations run in reverse on failure',
    body: {
      type: 'saga',
      id: p(1, 'booking'),
      steps: [
        {
          id: p(2, 'reserve'),
          action: step(p(3, 'reserve_action'), p(4, 'http_request'), {}),
          compensation: step(p(5, 'release_action'), p(6, 'http_request'), {}),
        },
      ],
    },
  },
  // ---- handlers --------------------------------------------------------------
  {
    name: 'Orch8: llm_call step',
    prefix: ['orch8-llm'],
    description: 'Call an LLM provider (llm_call)',
    body: step(p(1, 'ask_llm'), 'llm_call', {
      provider: c(2, ['anthropic', 'openai', 'mistral', 'groq']),
      model: p(3, 'claude-opus-5'),
      api_key: p(4, 'credentials://llm/api_key'),
      messages: [{ role: 'user', content: p(5, 'Summarize: {{ context.data.text }}') }],
    }, { retry: { max_attempts: num(p(6, '3')) } }),
  },
  {
    name: 'Orch8: human_review step',
    prefix: ['orch8-human-review'],
    description: 'Pause for a human decision (human_review + wait_for_input)',
    body: step(p(1, 'review'), 'human_review', {
      review_data: p(2, '{{ outputs.ask_llm }}'),
      instructions: p(3, 'Approve or reject this output'),
      reviewer: p(4, 'team-lead'),
    }, { wait_for_input: { prompt: p(5, 'Approve this?'), timeout: num(p(6, '86400000')) } }),
  },
  {
    name: 'Orch8: http_request step',
    prefix: ['orch8-http'],
    description: 'HTTP request (http_request)',
    body: step(p(1, 'call_api'), 'http_request', {
      method: c(2, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      url: p(3, 'https://api.example.com/resource'),
      headers: { 'content-type': 'application/json' },
      body: p(4, '{"id": "{{ context.data.id }}"}'),
      timeout_ms: num(p(5, '10000')),
    }, { retry: { max_attempts: num(p(6, '3')), initial_backoff: num(p(7, '1000')) } }),
  },
  {
    name: 'Orch8: wait_for_event step',
    prefix: ['orch8-wait-event'],
    description: 'Durably wait for correlated external events (wait_for_event)',
    body: step(p(1, 'await_events'), 'wait_for_event', {
      events: [p(2, 'payment_received')],
      correlation_key: p(3, '{{ context.data.order_id }}'),
      join: c(4, ['all', 'any', 'count']),
    }, { wait_for_input: { prompt: p(5, 'waiting for events'), timeout: num(p(6, '86400000')) } }),
  },
  {
    name: 'Orch8: email step',
    prefix: ['orch8-email'],
    description: 'Send an email via Resend / SMTP / SES (email handler; needs an engine build that ships it)',
    body: step(p(1, 'send_email'), 'email', {
      provider: c(2, ['resend', 'smtp', 'ses']),
      api_key: p(3, 'credentials://resend/api_key'),
      from: p(4, 'Orch8 <noreply@example.com>'),
      to: p(5, '{{ context.data.email }}'),
      subject: p(6, 'Hello'),
      text: p(7, 'Your workflow finished.'),
    }),
  },
  {
    name: 'Orch8: notify step',
    prefix: ['orch8-notify'],
    description: 'Post to Slack / Discord / Teams (notify handler; needs an engine build that ships it)',
    body: step(p(1, 'notify_team'), 'notify', {
      provider: c(2, ['slack', 'discord', 'teams']),
      url: p(3, 'credentials://ops-slack/url'),
      title: p(4, 'Workflow update'),
      text: p(5, 'Order {{ context.data.order_id }} shipped'),
    }),
  },
];
