// Writes llm-prompt.html: prompt text vs tools on the call vs tool results.
// Run: npx vite-node eval/dump-llm-prompt.ts
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  systemForPhase,
  buildContextPrompt,
  MAX_DISCOVERY_ROUNDS,
  REACTION_RETRY,
  type OrchestratorRequest,
} from '../server/orchestrator.ts';
import { newBrief, briefForPrompt } from '../server/discovery.ts';
import { seedKnowledgeBase, knowledgeForPrompt } from '../server/knowledge.ts';
import { resolveTenant } from '../server/tenants.ts';
import { outputToolsForPhase } from '../server/outputTools.ts';
import { toolsForPhase, runTool } from '../server/agentTools.ts';
import { issuerContext, blueprintVocabulary } from '../server/blueprint.ts';
import type { Channel } from '../src/data/sharedConstants.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '../llm-prompt.html');

const STOP_LOOKUPS_ASK =
  'STOP CALLING TOOLS. Every lookup you need has already been made and the results are above. Answer now with ordinary text and the tool call this turn needs, using what you already know.';
const STOP_LOOKUPS_BUILD =
  'STOP LOOKING THINGS UP. Every lookup you need has already been made and the results are above. Call build_campaign now with what you have.';
const EMPTY_ROUND =
  'Your previous turn did not produce a usable answer. Every lookup you need has already been made and the results are above. Reply NOW with ordinary text and the tool call this turn needs, complete, and nothing else.';
const EMPTY_BUILD =
  'Your previous turn did not build the campaign. The manager has already approved this plan and is waiting for the journey. Call build_campaign NOW with what you have. If part of the plan cannot be expressed, build the rest and record the gap in "openItems".';

const tenant = resolveTenant('TEN-IBL');
if (!tenant) throw new Error('TEN-IBL missing');
const availableChannels = tenant.availableChannels.filter((c) => c.available).map((c) => c.channel as Channel);
const kb = seedKnowledgeBase();
const kbText = knowledgeForPrompt(kb, tenant.tenantId);
const brief = newBrief(
  'Customers authorised for an EMI-eligible purchase are not converting. Get more of them to convert before the request expires.',
);

const req = {
  sessionId: 'preview',
  messages: [],
  knowledge: kb,
  discoveryRounds: 0,
  tenantId: tenant.tenantId,
} satisfies OrchestratorRequest;

type Toolish = { name: string; description?: string; input_schema?: unknown };

const fmtTools = (tools: Toolish[]) => {
  if (!tools.length) return '(none on this turn)';
  return tools
    .map((t) => {
      const schema = t.input_schema ? JSON.stringify(t.input_schema, null, 2) : '(no schema)';
      return `### ${t.name}\n\n${t.description ?? ''}\n\n${schema}`;
    })
    .join('\n\n---\n\n');
};

const askingSystem = systemForPhase('asking');
const proposeSystem = systemForPhase('ready');
const buildSystem = systemForPhase('build');

const askingContext = buildContextPrompt(req, brief, tenant, kbText, availableChannels, false, false, false, false);
const proposeContext = buildContextPrompt(req, brief, tenant, kbText, availableChannels, false, false, false, true);
const buildContext = buildContextPrompt(req, brief, tenant, kbText, availableChannels, false, false, true, false);

// THREE PHASES, because the lookups and the journey grammar now move
// together: an asking turn has neither, a propose-ready turn has both, and
// Confirm swaps propose_strategy for build_campaign.
const askingLookups = toolsForPhase(false);
const proposeLookups = toolsForPhase(true);
const buildLookups = toolsForPhase(true);
const askingOutput = outputToolsForPhase('asking');
const proposeOutput = outputToolsForPhase('ready');
const buildOutput = outputToolsForPhase('build');

const issuer = issuerContext(availableChannels, tenant.templateLibraryAccess);
const catalogue = blueprintVocabulary(availableChannels, tenant.templateLibraryAccess);
const briefAlone = briefForPrompt(brief);

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function splitByHeading(text: string): { heading: string; body: string }[] {
  const parts = text.split(/\n(?=# )/g);
  return parts
    .map((p) => {
      const nl = p.indexOf('\n');
      if (nl < 0) return { heading: p.replace(/^# /, ''), body: '' };
      return { heading: p.slice(0, nl).replace(/^# /, ''), body: p.slice(nl + 1).trim() };
    })
    .filter((p) => p.heading);
}

function outline(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (depth >= 1) return `[${value.length} items]`;
    const first = outline(value[0], depth + 1);
    return `[${value.length} items, each like ${first}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as object);
    if (depth >= 2) return `{${keys.length} keys}`;
    if (keys.length > 10) return `{ ${keys.slice(0, 8).join(', ')}, … ${keys.length} keys }`;
    return `{ ${keys.map((k) => `${k}: ${outline((value as Record<string, unknown>)[k], depth + 1)}`).join('; ')} }`;
  }
  return typeof value;
}

const lookupResults = buildLookups.map((t) => {
  const out = runTool(t.name, {}, { tenant });
  const json = JSON.stringify(out.result);
  return {
    name: t.name,
    ok: out.ok,
    summary: out.summary,
    chars: json.length,
    outline: outline(out.result),
    sample: json.length > 1800 ? `${json.slice(0, 1800)}\n… truncated, ${json.length.toLocaleString()} chars total` : json,
  };
});

type Cell = 'prompt' | 'schema' | 'result' | 'none';
const cellLabel: Record<Cell, string> = {
  prompt: 'In the prompt text',
  schema: 'On the call as a tool (name + schema only)',
  result: 'Only after the model calls the tool',
  none: 'Not this turn',
};

type Row = { topic: string; ask: Cell; propose: Cell; confirm: Cell; note: string };

const rows: Row[] = [
  {
    topic: 'How to reason (method)',
    ask: 'prompt',
    propose: 'prompt',
    confirm: 'prompt',
    note: 'The system string. An asking turn gets discovery only — the role, the question cap, the ground rules, §1 outcome and success, §2 dimensions and the one probe, §9, questions and DISCOVER FIRST — and none of the design chapters, because nothing is being designed on it. Propose and Confirm get the whole method.',
  },
  {
    topic: 'How to write this turn',
    ask: 'prompt',
    propose: 'prompt',
    confirm: 'prompt',
    note: 'First user message. Ordinary text plus which output tool to call.',
  },
  {
    topic: 'Working brief',
    ask: 'prompt',
    propose: 'prompt',
    confirm: 'prompt',
    note: 'First user message. Empty shell in this dump; live chats fill it.',
  },
  {
    topic: 'Knowledge base (market, history, quiet hours, risk)',
    ask: 'prompt',
    propose: 'prompt',
    confirm: 'prompt',
    note: 'First user message. This is bank/market context, not builder grammar.',
  },
  {
    topic: 'Channels this issuer has, template library reachable?',
    ask: 'prompt',
    propose: 'prompt',
    confirm: 'prompt',
    note: 'First user message, “This issuer”. Confirm can also fetch the same via list_channels / check_template_availability.',
  },
  {
    topic: 'Event names, attribute names, step kinds, delivery statuses',
    ask: 'none',
    propose: 'result',
    confirm: 'result',
    note: 'No longer pasted anywhere. Both turns that write steps may call the lookups; the names arrive as a tool result.',
  },
  {
    topic: 'Attribute operators and allowed values',
    ask: 'none',
    propose: 'result',
    confirm: 'result',
    note: 'list_audience_attributes. Propose-ready needs them too: Confirm compiles the path it wrote.',
  },
  {
    topic: 'Full event / step / channel payloads',
    ask: 'none',
    propose: 'result',
    confirm: 'result',
    note: 'Fetched on demand, not pasted. An asking turn has no lookup tools at all.',
  },
  {
    topic: 'The journey grammar (step kinds, entry shapes)',
    ask: 'none',
    propose: 'schema',
    confirm: 'schema',
    note: 'propose_strategy.blueprint on any turn that may propose — including a forced one — and build_campaign on Confirm. An asking turn has neither tool, so no step grammar reaches it at all.',
  },
  {
    topic: 'Lookup tool definitions',
    ask: 'none',
    propose: 'schema',
    confirm: 'schema',
    note: 'Attached to the API call as tools[]. The model sees the name and schema, not the data, until it calls one.',
  },
  {
    topic: 'ask_questions / record_findings / record_dimensions / request_evidence',
    ask: 'schema',
    propose: 'schema',
    confirm: 'none',
    note: 'Output tools. Shape of the answer lives in the schema, not in the system prompt.',
  },
  {
    topic: 'build_campaign (and the journey JSON shape)',
    ask: 'none',
    propose: 'none',
    confirm: 'schema',
    note: 'Confirm only. The step grammar is the tool’s input schema. Propose carries a blueprint field on propose_strategy instead.',
  },
  {
    topic: 'Chat after the first user message',
    ask: 'prompt',
    propose: 'prompt',
    confirm: 'prompt',
    note: 'The live conversation. Not in this dump.',
  },
];

const cellClass = (c: Cell) => `cell ${c}`;

function toolsCard(title: string, tools: Toolish[], kind: 'lookup' | 'output'): string {
  if (!tools.length) {
    return `<div class="card">
      <h3>${esc(title)}</h3>
      <p class="empty">None on this turn. The model cannot call these.</p>
    </div>`;
  }
  const items = tools
    .map((t) => {
      const schemaChars = t.input_schema ? JSON.stringify(t.input_schema).length : 0;
      return `<li><strong>${esc(t.name)}</strong> <em>${schemaChars.toLocaleString()} chars of schema</em><span>${esc((t.description ?? '').slice(0, 180))}${(t.description ?? '').length > 180 ? '…' : ''}</span></li>`;
    })
    .join('');
  return `<div class="card">
    <h3>${esc(title)}</h3>
    <p class="hint">${kind === 'lookup' ? 'On the call as tools[]. Data is not included. Data arrives only if the model calls one, as a later user message.' : 'On the call as tools[]. This is how structured answers are written, not how catalogues are fetched.'}</p>
    <ul class="tool-list">${items}</ul>
  </div>`;
}

function promptStack(title: string, system: string, context: string): string {
  const parts = splitByHeading(context);
  const items = parts
    .map((p) => {
      const vocab = /Vocabulary you must stay inside|THE PLAN YOU PUT UP|THIS TURN BUILDS|NO BLUEPRINT/.test(p.heading);
      return `<details ${vocab ? 'open' : ''}>
        <summary>${esc(p.heading)} <em>${p.body.length.toLocaleString()} chars</em>${vocab ? '<span class="tag">builder catalogue</span>' : ''}</summary>
        <pre>${esc(p.body)}</pre>
      </details>`;
    })
    .join('');
  return `<div class="card">
    <h3>${esc(title)}</h3>
    <p class="hint">Sent as <code>system</code> plus the first <code>user</code> message. This is prompt text, not a tool.</p>
    <details>
      <summary>System <em>${system.length.toLocaleString()} chars</em></summary>
      <pre>${esc(system)}</pre>
    </details>
    ${items}
  </div>`;
}

const extras = [
  { id: 'retry', title: 'Reaction retry', when: 'Confirm only, if the built journey is a clock. Extra system paragraph. Forced build_campaign.', body: REACTION_RETRY },
  { id: 'stop-ask', title: 'Last lookup round (asking / propose)', when: 'Tool-round cap hit on a non-build turn.', body: STOP_LOOKUPS_ASK },
  { id: 'stop-build', title: 'Last lookup round (build)', when: 'Tool-round cap hit on a build turn.', body: STOP_LOOKUPS_BUILD },
  { id: 'empty-round', title: 'Empty-round recovery (asking / propose)', when: 'Previous turn produced no usable answer.', body: EMPTY_ROUND },
  { id: 'empty-build', title: 'Empty-round recovery (build)', when: 'Previous build turn did not call build_campaign.', body: EMPTY_BUILD },
];

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>What the model is sent — prompt vs tools</title>
  <style>
    :root { --bg: #0f1115; --panel: #171a21; --ink: #e8eaef; --muted: #8b93a7; --line: #2a3140; --prompt: #86efac; --schema: #fcd34d; --result: #7dd3fc; --none: #3a4150; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--ink); }
    header.top { padding: 28px 36px 8px; max-width: 1200px; }
    header.top h1 { margin: 0 0 8px; font-size: 22px; }
    header.top p { color: var(--muted); line-height: 1.5; max-width: 72ch; }
    .legend { display: flex; gap: 16px; flex-wrap: wrap; margin: 16px 0 8px; }
    .legend span { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .swatch { width: 12px; height: 12px; border-radius: 3px; }
    .swatch.prompt { background: var(--prompt); }
    .swatch.schema { background: var(--schema); }
    .swatch.result { background: var(--result); }
    .swatch.none { background: var(--none); }
    main { padding: 8px 36px 80px; max-width: 1200px; }
    h2 { font-size: 18px; margin: 32px 0 10px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border: 1px solid var(--line); padding: 8px 10px; vertical-align: top; text-align: left; }
    th { background: var(--panel); font-weight: 600; }
    td.note { color: var(--muted); font-size: 12px; }
    .cell { font-weight: 600; font-size: 12px; }
    .cell.prompt { color: var(--prompt); }
    .cell.schema { color: var(--schema); }
    .cell.result { color: var(--result); }
    .cell.none { color: var(--muted); }
    .turns { display: grid; grid-template-columns: 1fr; gap: 28px; }
    .turn h2 { margin-bottom: 4px; }
    .grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
    .card h3 { margin: 0 0 6px; font-size: 14px; }
    .hint, .empty { color: var(--muted); font-size: 12px; line-height: 1.45; margin: 0 0 10px; }
    details { border-top: 1px solid var(--line); padding: 6px 0; }
    summary { cursor: pointer; font-size: 13px; }
    summary em { color: var(--muted); font-style: normal; font-size: 11px; margin-left: 6px; }
    .tag { display: inline-block; margin-left: 8px; font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; background: #3f3a1a; color: var(--schema); padding: 1px 6px; border-radius: 999px; }
    pre { white-space: pre-wrap; word-break: break-word; background: #0b0d12; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; max-height: 280px; overflow: auto; margin: 8px 0 0; }
    .tool-list { margin: 0; padding-left: 18px; }
    .tool-list li { margin: 0 0 8px; }
    .tool-list span { display: block; color: var(--muted); font-size: 12px; }
    .sizes { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
  </style>
</head>
<body>
  <header class="top">
    <h1>What the model is sent</h1>
    <p>Three pipes, not one blob. <strong>Prompt text</strong> is the system string plus the first user message. <strong>Tool definitions</strong> ride on the same API call as <code>tools[]</code> — the model sees the name and the JSON schema, not the data. <strong>Tool results</strong> exist only after the model calls a tool; the server then appends a user message with the payload. Generated for ${esc(tenant.displayName)}. Discovery budget round 1 of ${MAX_DISCOVERY_ROUNDS}. Working brief is an empty EMI example.</p>
    <div class="legend">
      <span><i class="swatch prompt"></i> In the prompt text</span>
      <span><i class="swatch schema"></i> On the call as a tool (schema only)</span>
      <span><i class="swatch result"></i> Only after a tool call</span>
      <span><i class="swatch none"></i> Not this turn</span>
    </div>
  </header>
  <main>
    <h2>Where each kind of fact travels</h2>
    <table>
      <thead>
        <tr><th>Fact</th><th>Asking</th><th>Propose-ready</th><th>Confirm</th><th>What that means</th></tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (r) => `<tr>
          <td>${esc(r.topic)}</td>
          <td class="${cellClass(r.ask)}">${cellLabel[r.ask]}</td>
          <td class="${cellClass(r.propose)}">${cellLabel[r.propose]}</td>
          <td class="${cellClass(r.confirm)}">${cellLabel[r.confirm]}</td>
          <td class="note">${esc(r.note)}</td>
        </tr>`,
          )
          .join('\n')}
      </tbody>
    </table>

    <h2>Sizes on this dump</h2>
    <p class="sizes">Issuer block (every turn): ${issuer.length.toLocaleString()} chars. Builder catalogue (NOT in any prompt — ${catalogue.length.toLocaleString()} chars, fetched by lookup if asked). Knowledge base: ${kbText.length.toLocaleString()} chars. Asking system ${askingSystem.length.toLocaleString()} · propose/confirm system ${proposeSystem.length.toLocaleString()}.</p>

    <div class="turns">
      <section class="turn" id="asking">
        <h2>Asking turn</h2>
        <p class="hint">Discovery. No builder catalogue, no lookup tools, and no plan tool: an asking turn records and asks. Offering <code>propose_strategy</code> in order to refuse it cost two live conversations.</p>
        <div class="grid">
          ${promptStack('1. Prompt text', askingSystem, askingContext)}
          <div>
            ${toolsCard('2. Lookup tools on this call', askingLookups, 'lookup')}
            ${toolsCard('3. Output tools on this call', askingOutput, 'output')}
          </div>
        </div>
      </section>

      <section class="turn" id="propose">
        <h2>Propose-ready turn</h2>
        <p class="hint">The catalogue is <em>not in the prompt</em>. It arrives only if the model calls a lookup — and on this turn it can, because the path it writes has to name real events, attributes, operators and values. <strong>A forced propose lands here too</strong>: a spent round budget or “go ahead” is a propose, so it gets the same blueprint field and the same five lookups. Withholding them would have been a turn told to propose with nowhere to put the path.</p>
        <div class="grid">
          ${promptStack('1. Prompt text', proposeSystem, proposeContext)}
          <div>
            ${toolsCard('2. Lookup tools on this call', proposeLookups, 'lookup')}
            ${toolsCard('3. Output tools on this call', proposeOutput, 'output')}
          </div>
        </div>
      </section>

      <section class="turn" id="confirm">
        <h2>Confirm turn</h2>
        <p class="hint">Catalogue still in the prompt. Lookup tools are now on the call. Their <em>data</em> is not, until the model calls them.</p>
        <div class="grid">
          ${promptStack('1. Prompt text', buildSystem, buildContext)}
          <div>
            ${toolsCard('2. Lookup tools on this call', buildLookups, 'lookup')}
            ${toolsCard('3. Output tools on this call', buildOutput, 'output')}
          </div>
        </div>
      </section>
    </div>

    <h2>What a lookup returns if Confirm calls it</h2>
    <p class="hint">These payloads are <strong>not</strong> in the first request. They appear as a user message after <code>tool_use</code>. Outline is the live ${esc(tenant.displayName)} result.</p>
    ${lookupResults
      .map(
        (r) => `<div class="card" style="margin-bottom:12px">
      <h3>${esc(r.name)}</h3>
      <p class="hint">${esc(r.summary)} · ${r.chars.toLocaleString()} chars of JSON</p>
      <pre>${esc(r.outline)}</pre>
      <details><summary>Sample payload</summary><pre>${esc(r.sample)}</pre></details>
    </div>`,
      )
      .join('\n')}

    <h2>Fragments inside the first user message</h2>
    <div class="card">
      <h3>Working brief renderer (empty example)</h3>
      <pre>${esc(briefAlone)}</pre>
    </div>
    <div class="card" style="margin-top:12px">
      <h3>Knowledge base</h3>
      <pre>${esc(kbText)}</pre>
    </div>

    <h2>Extras (concatenated onto system when they fire)</h2>
    ${extras
      .map(
        (e) => `<div class="card" style="margin-bottom:12px">
      <h3>${esc(e.title)}</h3>
      <p class="hint">${esc(e.when)}</p>
      <pre>${esc(e.body)}</pre>
    </div>`,
      )
      .join('\n')}

    <h2>Verbatim tool schemas</h2>
    <details><summary>Asking output tools (${fmtTools(askingOutput).length.toLocaleString()} chars)</summary><pre>${esc(fmtTools(askingOutput))}</pre></details>
    <details><summary>Propose-ready output tools (${fmtTools(proposeOutput).length.toLocaleString()} chars)</summary><pre>${esc(fmtTools(proposeOutput))}</pre></details>
    <details><summary>Propose-ready lookup tools (${fmtTools(proposeLookups).length.toLocaleString()} chars)</summary><pre>${esc(fmtTools(proposeLookups))}</pre></details>
    <details><summary>Confirm lookup tools (${fmtTools(buildLookups).length.toLocaleString()} chars)</summary><pre>${esc(fmtTools(buildLookups))}</pre></details>
    <details><summary>Confirm output tools (${fmtTools(buildOutput).length.toLocaleString()} chars)</summary><pre>${esc(fmtTools(buildOutput))}</pre></details>
  </main>
</body>
</html>
`;

writeFileSync(outPath, html);
console.log(`Wrote ${outPath}`);
console.log(
  [
    `asking system ${askingSystem.length}`,
    `asking context ${askingContext.length}`,
    `propose system ${proposeSystem.length}`,
    `propose context ${proposeContext.length}`,
    `build system ${buildSystem.length}`,
    `build context ${buildContext.length}`,
    `catalogue ${catalogue.length}`,
    `lookups ${lookupResults.map((r) => `${r.name} ${r.chars}`).join(', ')}`,
  ].join('\n'),
);
