// The conversation state machine, the confirmation gate, and the tools.
//
// The defect these lock down: the graph used to be built the moment the model
// said "propose", so a finished campaign appeared before anyone had agreed the
// strategy. Construction is now reachable only via intent:'confirm' or a
// refinement of a campaign that already exists.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AGENT_TOOLS, runTool, toolTitle } from '../../server/agentTools';
import { EventEmitterSeq, type RunEvent } from '../../server/runEvents';
import { resolveTenant } from '../../server/tenants';
import { EVENT_CATEGORIES, ELIGIBILITY_META } from '../../src/data/sharedConstants';

const tenant = resolveTenant('TEN-IBL')!;
const demoTenant = resolveTenant('TEN-DEMO')!;

describe('agent tools return real application data', () => {
  it('every declared tool is executable', () => {
    for (const t of AGENT_TOOLS) {
      const out = runTool(t.name, {}, { tenant });
      expect(out.summary.length, t.name).toBeGreaterThan(0);
      expect(out.result, t.name).toBeDefined();
      expect(toolTitle(t.name)).toBe(t.title);
    }
  });

  // These two assert PROVENANCE: every value the tool reports is read from the
  // application's own definitions. The shape grew in Phase 1 (types, operators,
  // allowed values, entity mapping, isNew) — see agentMetadata.test.ts for what
  // the added fields must contain. The provenance requirement is unchanged.
  it('event types come from the application, not a copy', () => {
    const out = runTool('list_event_types', {}, { tenant });
    const result = out.result as Record<string, { events: string[] }>;
    expect(Object.keys(result)).toEqual(Object.keys(EVENT_CATEGORIES));
    for (const [category, meta] of Object.entries(EVENT_CATEGORIES)) {
      expect(result[category].events).toEqual(meta.events);
    }
  });

  it('audience attributes come from ELIGIBILITY_META', () => {
    // One call returns every entity: the tool takes no narrowing parameter,
    // because a tool that CAN be called per entity was called per entity and
    // burned the whole tool budget. See agentMetadata.test.ts.
    const out = runTool('list_audience_attributes', {}, { tenant });
    const result = out.result as { entities: Record<string, { attributes: Record<string, unknown> }> };
    expect(Object.keys(result.entities)).toEqual(Object.keys(ELIGIBILITY_META));
    expect(Object.keys(result.entities.Account.attributes)).toEqual(Object.keys(ELIGIBILITY_META.Account));
  });

  it('an unknown entity fails rather than returning something plausible', () => {
    const out = runTool('list_audience_attributes', { entity: 'Spaceship' }, { tenant });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out.result)).toMatch(/Unknown entity/);
  });

  it('channels are scoped to the tenant that asked', () => {
    const ibl = runTool('list_channels', {}, { tenant });
    const yes = runTool('list_channels', {}, { tenant: resolveTenant('TEN-YES')! });
    expect(JSON.stringify(ibl.result)).toContain('EMAIL');
    // Yes Bank has EMAIL disabled, so it must not appear as available.
    expect((yes.result as { availableCheapestFirst: string[] }).availableCheapestFirst).not.toContain('EMAIL');
  });

  it('template availability reports "cannot verify", not "none exists"', () => {
    const out = runTool('check_template_availability', {}, { tenant });
    const r = out.result as { reachable: boolean; meaning: string };
    expect(r.reachable).toBe(false);
    expect(r.meaning).toMatch(/cannot confirm OR deny/i);
    // And the demo tenant's library is labelled as synthetic.
    const demo = runTool('check_template_availability', {}, { tenant: demoTenant });
    expect(JSON.stringify(demo.result)).toMatch(/SYNTHETIC demo library/);
  });

  it('an unknown tool name fails loudly', () => {
    const out = runTool('delete_everything', {}, { tenant });
    expect(out.ok).toBe(false);
  });
});

describe('run events', () => {
  it('are sequenced, timestamped and carry the run id', () => {
    const seen: RunEvent[] = [];
    const em = new EventEmitterSeq('run-1', (e) => seen.push(e));
    em.emit('run.started', 'understanding', 'Starting');
    em.emit('model.started', 'discovery', 'Thinking', { status: 'running' });
    em.emit('run.completed', 'review', 'Done', { durationMs: 120 });

    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(seen.every((e) => e.runId === 'run-1')).toBe(true);
    expect(seen.every((e) => !Number.isNaN(Date.parse(e.at)))).toBe(true);
    expect(seen[1].status).toBe('running');
    expect(seen[2].durationMs).toBe(120);
  });

  it('correlates a tool request with its execution and result', () => {
    const seen: RunEvent[] = [];
    const em = new EventEmitterSeq('run-2', (e) => seen.push(e));
    em.emit('model.tool_call.requested', 'understanding', 'Checking channels', { correlationId: 'tu_1' });
    em.emit('model.tool_call.started', 'understanding', 'Checking channels', { correlationId: 'tu_1' });
    em.emit('model.tool_call.completed', 'understanding', 'Checking channels', { correlationId: 'tu_1' });

    const forTool = seen.filter((e) => e.correlationId === 'tu_1');
    expect(forTool).toHaveLength(3);
    // Three distinct phases, as the UI must be able to tell them apart.
    expect(forTool.map((e) => e.type)).toEqual([
      'model.tool_call.requested',
      'model.tool_call.started',
      'model.tool_call.completed',
    ]);
  });
});

describe('the confirmation gate is structural, not advisory', () => {
  it('the orchestrator only builds for confirm or refinement', async () => {
    // Read the source rather than mocking a model: the guarantee is that
    // there is exactly one construction call per path, and the conversation
    // path returns before reaching it.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8'),
    );
    const buildCalls = [...src.matchAll(/buildAndValidate\(/g)];
    // One definition + three call sites: the confirm short-circuit, a
    // refinement, and the build-turn tail.
    //
    // The third was added when the proposal stopped carrying a blueprint.
    // With `pendingBlueprint: null` the client sends `confirmedBlueprint:
    // null`, so an approval misses the short-circuit, reaches the model loop
    // and must build THERE — otherwise it returns "Generate this campaign?"
    // for a second time and the user has to press approve twice.
    //
    // The guarantee is unchanged and is asserted below, not by a count:
    // every construction is behind a build-turn condition.
    expect(buildCalls.length).toBe(4);
    expect(src).toMatch(/if \(isBuildTurn\) \{\n    const out = buildAndValidate\(/);
    expect(src).toMatch(/intent === 'confirm' && req\.confirmedBlueprint/);
    // ...and the confirm site is guarded by the state machine, not just by
    // the presence of a blueprint.
    expect(src).toMatch(/const permitted = briefMatchesStrategy/);
    // The proposal path returns awaiting-confirmation carrying the blueprint
    // for the user to confirm, and does not build it.
    //
    // Asserted structurally rather than by source offset: 'awaiting-confirmation'
    // legitimately appears more than once now (the stale-confirmation refusal
    // also returns it), so comparing character positions was brittle and said
    // nothing about the real guarantee.
    // The reply is built just above the return as `replyText`, so the jargon
    // check can read it before it is recorded as an application verdict. Still
    // one return, still built by renderStrategy — assert both, not the old
    // inline call site.
    expect(src).toMatch(/phase: 'awaiting-confirmation',\s*\n\s*stage: 'proposed',\s*\n\s*reply: replyText,/);
    expect(src).toMatch(/const replyText = renderStrategy\(/);
    expect(src).toMatch(/pendingBlueprint: blueprint/);
    // Neither build site sits inside the proposal return.
    const proposalBlock = src.slice(
      src.indexOf("reply: renderStrategy(strategy)"),
      src.indexOf('/** Builds the graph and validates it'),
    );
    expect(proposalBlock).not.toMatch(/buildAndValidate\(/);
  });

  it('thinking is round-tripped to the API and exposed to nobody', async () => {
    // Changed deliberately in Phase 5. Thinking blocks used to be STRIPPED
    // from the assistant turn, which malformed the conversation and made a
    // later round answer with an empty turn — three evaluation scenarios died
    // that way, and the same cause had been surfacing for two phases as an
    // intermittent "unparseable JSON". The blocks now travel complete.
    //
    // The privacy guarantee is unchanged and is what this test protects: the
    // reasoning goes from one API request to the next and NOWHERE else.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../server/anthropic.ts', import.meta.url), 'utf8'),
    );
    // Reassembled completely, so the API never sees an empty thinking block.
    expect(src).toMatch(/thinking_delta/);
    expect(src).toMatch(/signature_delta/);
    expect(src).not.toMatch(/b\.type !== 'thinking'/);

    // Text reaches the caller from exactly two places — a streamed delta and
    // a block that arrived complete — and both carry TEXT-block content only.
    const textYields = [...src.matchAll(/yield \{ text: ([^}]+) \}/g)].map((m) => m[1].trim());
    expect(textYields).toEqual(['opening.text', 'ev.delta.text']);
    // The thinking branch accumulates and yields nothing.
    const thinkBranch = src.slice(src.indexOf("thinking_delta'"), src.indexOf("signature_delta'"));
    // Matches a yield STATEMENT, not the word in the comment above it.
    expect(thinkBranch).not.toMatch(/yield \{/);

    // And the orchestrator never puts model content into an event payload.
    const orch = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8'),
    );
    expect(orch).not.toMatch(/data: \{ *turnContent/);
    // turnContent (which now carries thinking) goes into the conversation and
    // nowhere else: never into an emitted event, never into the reply.
    // A bare occurrence count was the old proxy for this, and it broke the
    // moment a second assignment was added by the empty-round recovery — while
    // the guarantee itself was never in danger. Assert the guarantee instead:
    // every mention is a declaration, an assignment from the stream, or the
    // push into the conversation. Nothing reads it for any other purpose.
    const mentions = [...orch.matchAll(/^.*turnContent.*$/gm)].map((m) => m[0].trim());
    for (const line of mentions) {
      expect(
        /^let turnContent/.test(line) ||
          /^turnContent = chunk\.done\.content;$/.test(line) ||
          /^conversation\.push\(\{ role: 'assistant', content: turnContent \}\);$/.test(line),
        line,
      ).toBe(true);
    }
    // Exactly one consumer, however many times the stream assigns it.
    expect(mentions.filter((l) => l.startsWith('conversation.push'))).toHaveLength(1);
    expect(orch).toMatch(/conversation\.push\(\{ role: 'assistant', content: turnContent \}\)/);
  });
});

describe('the tool loop terminates with an answer, not an error', () => {
  const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');

  it('serves a repeated lookup from cache instead of re-running it', () => {
    // Every tool is deterministic and most take no arguments, so a second
    // identical call cannot return anything new.
    expect(src).toMatch(/const toolCache = new Map/);
    expect(src).toMatch(/const cached = toolCache\.get\(key\)/);
    expect(src).toMatch(/Calling it again cannot return anything different/);
    // The payload itself is NOT resent — only a pointer to where it already is.
    expect(src).not.toMatch(/\$\{payload\}\\n\\nYou already called/);
  });

  it('forbids tool USE rather than asking the model to stop, and keeps the definitions', () => {
    // A live run spent rounds 2, 3 and 4 re-fetching results it already had,
    // at ~45s a round, until the budget ran out and the user got an error
    // instead of a strategy. A request to stop is one a model can decline.
    expect(src).toMatch(/toolChoice: stopLookingUp \? \{ type: 'none' \} : undefined/);
    // The definitions must STILL be sent: a history containing tool_use and
    // tool_result blocks with no tools attached made the model answer with an
    // empty turn, which killed three evaluation scenarios outright.
    expect(src).not.toMatch(/tools: stopLookingUp/);
    // Still sent, now phase-filtered: the builder's vocabulary (event types,
    // audience attributes, step types) is withheld until the agent has stated
    // an intervention, so discovery is not conducted in the builder's terms.
    // That cannot reintroduce the empty-turn failure above: the conversation
    // is seeded from plain text messages, tool blocks exist only within a
    // turn, and within a turn the tool list only ever grows.
    expect(src).toMatch(/tools: toolsForPhase\(designSeen\)\.map/);
  });

  it('separates "nothing left to look up" from "budget spent"', () => {
    // Conflating them was a real defect: one repeated lookup on round 2 made
    // round 3 the last round, and a model that asked for one more tool there
    // had its whole run failed five rounds early.
    expect(src).toMatch(/const budgetSpent = round === MAX_TOOL_ROUNDS - 1/);
    // The repeat signal is now a COUNT, not a single-round flag: one repeated
    // lookup withdrew tool use, and the round that followed came back with no
    // text at all in two measured runs. Withdrawal is now the bounded
    // fallback at MAX_REPEAT_ROUNDS, covered by toolRepeatRounds.test.ts.
    expect(src).toMatch(/const stopLookingUp = budgetSpent \|\| repeatRounds >= MAX_REPEAT_ROUNDS/);
    expect(src).not.toMatch(/stopLookingUp = budgetSpent \|\| nudgeToStop/);
    // Only a spent budget ends the run.
    expect(src).toMatch(/if \(budgetSpent\) \{/);
    expect(src).not.toMatch(/if \(lastRound\) \{/);
  });
});
