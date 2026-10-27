// Discovery happens in business terms, not in the builder's.
//
// THE DEFECT THIS FIXES. The agent reasoned about filterable fields and
// suppression lists while the business question went untouched, and the
// reason was not its disposition: `blueprintVocabulary` — event names,
// attribute lists, step kinds, the stage enum and the list of things a
// blueprint cannot express — was injected into the context on EVERY turn
// including the first. It knew how the builder assembles a journey before it
// knew why customers were not converting.
//
// Gating the three lookup TOOLS did not fix that, because the terms were
// already in the prompt. This is the gate that matters.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { asking, ready, build, sticky } from './support/prompts.ts';
import { buildContextPrompt, systemForPhase } from '../../server/orchestrator';
import { issuerContext, blueprintVocabulary } from '../../server/blueprint';
import { OUTPUT_TOOLS, outputToolsForPhase } from '../../server/outputTools';
import { toolsForPhase } from '../../server/agentTools';
import { applyOutputTool } from '../../server/outputTools';
import { newBrief, recordAnswer, recordBarriers, recordConverters, recordDimensions } from '../../server/discovery';

const CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP'];
const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');

describe('what the issuer can do is business context, available from turn one', () => {
  const ctx = issuerContext(CHANNELS, 'unavailable');

  it('names the channels, because cost and reach shape a strategy honestly', () => {
    for (const c of CHANNELS) expect(ctx).toContain(c);
  });

  it('says plainly when the template library cannot be read', () => {
    expect(ctx).toMatch(/NOT readable from here/);
  });

  it('lists the demo templates for a tenant that has one', () => {
    expect(issuerContext(CHANNELS, 'synthetic-demo')).toMatch(/SYNTHETIC demo library/);
  });

  it('carries NONE of the builder vocabulary', () => {
    // The whole point of the split. A campaign manager would tell you which
    // channels exist; nobody would open a conversation about conversion by
    // reciting the step kinds.
    expect(ctx).not.toMatch(/Step kinds you may use/);
    expect(ctx).not.toMatch(/Entities and attributes usable in conditions/);
    expect(ctx).not.toMatch(/Event categories and their event types/);
    expect(ctx).not.toMatch(/first-touch/);
    expect(ctx).not.toMatch(/CANNOT express/);
  });
});

// AN ASKING TURN DOES NOT HAVE THE TOOL.
//
// REWRITTEN 2026-10-24, and the group it replaces is the lesson. The tool used
// to travel on an asking turn with `blueprint` and `$defs` stripped, so that
// the GATE rather than the tool list could decide when a proposal was allowed.
// Twice measured, that cost a conversation:
//
//  - `ui-s-1792834072700` turn 3: five identical refusals, then the plan in
//    the chat with a request for the manager to approve it by hand.
//  - `ui-s-1792839251135` turn 3: a settled record held by a bookkeeping bug,
//    the tool offered and refused, and the manager asked to type "go ahead".
//
// A tool on the list is an invitation, and refusing an invitation we extended
// teaches the model that the plan is the move. So the asking turn carries
// four tools and none of them is a plan.
describe('an asking turn has no propose_strategy at all', () => {
  it('offers exactly the four record-and-ask tools', () => {
    expect(outputToolsForPhase('asking').map((t) => t.name)).toEqual([
      'ask_questions',
      'record_findings',
      'record_dimensions',
      'request_evidence',
    ]);
  });

  it('gives the tool back, with its path, on the turn that may propose', () => {
    const ready = outputToolsForPhase('ready');
    expect(ready.map((t) => t.name)).toContain('propose_strategy');
    expect(JSON.stringify(ready.find((t) => t.name === 'propose_strategy')!.input_schema)).toContain('$defs');
    expect(ready.map((t) => t.name)).not.toContain('build_campaign');
  });

  it('and takes it away again on the turn that builds', () => {
    const build = outputToolsForPhase('build').map((t) => t.name);
    expect(build).toContain('build_campaign');
    expect(build).not.toContain('propose_strategy');
  });

  it('files success through record_findings, not through a refused plan', () => {
    // The harvest branch is gone with the tool. `record_findings` takes
    // `successCriteria`, so the manager's own measure has a door of its own
    // on the turn they say it.
    const schema = OUTPUT_TOOLS.find((t) => t.name === 'record_findings')!.input_schema;
    expect(schema.properties.successCriteria).toBeDefined();
    const mid = recordAnswer(newBrief('more EMI-eligible card purchases to EMI'), 'count of purchases converted');
    const out = applyOutputTool(mid, 'record_findings', {
      successCriteria: ['The number of eligible purchases converted.'],
    } as never);
    expect(out.error).toBeUndefined();
    expect(out.brief.successCriteria).toEqual(['The number of eligible purchases converted.']);
  });

  it('does not wrap a propose refusal with "do not go back to discovery" on an asking turn', () => {
    // The wrapper is a PAYLOAD correction for a turn that may propose. There
    // is no asking-turn propose left to wrap, and the gate keys on the phase
    // rather than on the wording of our own refusal.
      // MOVED INTO `toolResultBlock`, which both the round loop and the
      // forced propose call. The expression used to be written out at each
      // site, and the forced one carried no correction at all for a while.
    expect(orch).toMatch(/tool === 'propose_strategy' && phase !== 'asking'/);
  });
});

// THE COPY IS A CLEAN REMAINDER OF THE PAPER, not a paste with overlaps.
//
// The first assembly shared too much and then let each body repeat it: "Lead
// with what you now understand" appeared TWICE on asking and on ready, the
// invent-numbers rule twice on every phase, and "The steps live in the tool"
// was in the shared opening although it is not in the Discovery paper at all.
// A sentence a model reads twice is a sentence it weighs twice.
describe('each phase reads every rule once, and only the rules that are its own', () => {
  const phase = { asking, ready, build };

  it('says each shared rule exactly once per phase', () => {
    for (const probe of [
      'Lead with what you now understand',
      'Never claim a conversion lift',
      'Do not ask about quiet hours',
      'A drop-off does not prove its cause',
      'Do not narrate your own bookkeeping',
    ]) {
      for (const [name, get] of Object.entries(phase)) {
        const n = get().split(probe).length - 1;
        expect(n, `${probe} on ${name}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('Discovery says the sent-questions sentence, and has no steps to speak of', () => {
    // RESTORED. `colleagueVoice` pins this sentence because a live turn 1
    // opened "I've sent these two questions to the campaign manager" —
    // written to them, about them, in the third person.
    expect(asking().split('sent questions to the campaign manager').length - 1).toBe(1);
    // AND NOT THIS: "The steps live in the tool. The bubble stays in their
    // language." is a Plan and Confirm line. It is not in the Discovery paper,
    // and a discovery turn has no steps.
    expect(asking()).not.toContain('The steps live in the tool');
    expect(ready()).toContain('The steps live in the tool');
    expect(build()).toContain('The steps live in the tool');
  });

  it('keeps the path rules off Discovery and the quiet-hours reason on all three', () => {
    for (const pathRule of ['Do not put a holdout in the path', 'Respect the night quiet hours in the sends you time']) {
      expect(asking(), pathRule).not.toContain(pathRule);
      expect(ready(), pathRule).toContain(pathRule);
      expect(build(), pathRule).toContain(pathRule);
    }
    // The reason travels with the rule rather than being orphaned on one phase.
    for (const [name, get] of Object.entries(phase)) {
      expect(get(), name).toContain('Asking for them reads as though you have not looked');
    }
  });

  it('gives each phase its own ground rule and nobody else\'s', () => {
    expect(asking()).toContain('Do not go looking for events, entities or attributes yet');
    expect(ready()).not.toContain('Do not go looking for events, entities or attributes yet');
    expect(ready()).toContain('Settle who the campaign is for and what it should do in business terms first');
    expect(asking()).not.toContain('Settle who the campaign is for');
    expect(build()).toContain('Build the path they approved');
    expect(asking()).not.toContain('Build the path they approved');
  });

  it('the Confirm sticky does not say ask_questions might be on the list', () => {
    // IT USED TO. "ask_questions may still be on the list. Do not use it." was
    // true when the tool travelled on a build turn and became a lie the moment
    // it came off. Confirm now says it the way Plan does.
    expect(sticky('build')).not.toMatch(/may still be on the list/);
    expect(sticky('build')).toMatch(/ask_questions is not here/);
    expect(sticky('build')).toMatch(/request_evidence is not here/);
    // And the tools it DOES have are still on the list.
    for (const kept of ['record_findings', 'record_dimensions', 'The lookup tools']) {
      expect(sticky('build'), kept).toContain(kept);
    }
  });

  it('the paper file was corrected too, so the next copy cannot bring it back', () => {
    const paper = readFileSync(new URL('../../prompt-review-confirm-current.md', import.meta.url), 'utf8');
    expect(paper).not.toMatch(/may still be on the list/);
    expect(paper).toMatch(/ask_questions is not here/);
    // SAME LIE, DIFFERENT WORDS. The explainer grepped clean for "on the list"
    // and still said Confirm "may still be listed".
    const html = readFileSync(new URL('../../prompt-review-e2e.html', import.meta.url), 'utf8');
    expect(html).not.toMatch(/may still be listed/);
    expect(html).not.toMatch(/even if that tool is still on the list/);
    expect(html).not.toMatch(/may still be on the list/);
  });

  it('every sentence of the prompt is in a paper file', () => {
    // THE CLAIM THIS PASS EXISTS TO MAKE TRUE. The strings are sliced from the
    // three manuals, so a sentence that is in the prompt and in no paper is
    // either a transcription slip or an invention.
    const papers = (['discovery', 'plan', 'confirm'] as const)
      .map((n) => readFileSync(new URL(`../../prompt-review-${n}-current.md`, import.meta.url), 'utf8'))
      .join('\n');
    for (const [name, get] of Object.entries(phase)) {
      for (const line of get().split('\n')) {
        const t = line.trim().replace(/^- /, '');
        if (t.length < 30 || t.startsWith('#')) continue;
        for (const s of t.split(/(?<=\.) (?=[A-Z\u201C])/)) {
          if (s.length > 30) expect(papers, `${name}: ${s.slice(0, 60)}`).toContain(s);
        }
      }
    }
  });
});

describe('the context prompt carries the phase sticky and a phase-correct budget', () => {
  // R3 AND R4 OF THIS SLICE WERE UNPINNED until these existed: both changes
  // could be reverted with the suite still green, which is the thing this
  // file keeps learning. Both are asserted on the string `buildContextPrompt`
  // actually returns, per phase.
  const ctx = (phase: 'asking' | 'ready' | 'build', limitReached = false) =>
    buildContextPrompt(
      { sessionId: 's', tenantId: 'TEN-IBL', messages: [{ role: 'user', content: 'More EMI conversions.' }], discoveryRounds: 2, knowledge: { version: 'test' } } as never,
      newBrief('More EMI conversions.'),
      { id: 'TEN-IBL', name: 'IndusInd Bank (IBL)', channels: CHANNELS, templateLibraryAccess: 'unavailable' } as never,
      '# Knowledge',
      CHANNELS,
      limitReached,
      false,
      phase,
    );

  it('the docs describe what the code does: no live reaction retry, real lengths', () => {
    // EVERY LEFTOVER THIS CONFIRM WORK FLAGGED, pinned so it cannot come back
    // as a parked comment.
    const dump = readFileSync(new URL('../../eval/dump-llm-prompt.ts', import.meta.url), 'utf8');
    // The constant survives and is sent by nothing, so the dump must not
    // advertise it as a Confirm extra with a forced tool call.
    expect(dump).not.toMatch(/Extra system paragraph\. Forced build_campaign/);
    expect(dump).toMatch(/Reaction retry \(retired\)/);

    // The length bullets have to match the strings `systemForPhase` returns,
    // which grew when the sticky joined them. Measured here rather than
    // transcribed, so the bullet cannot drift again.
    const log = readFileSync(new URL('../../server/CLAUDE.md', import.meta.url), 'utf8');
    const fmt = (n: number) => n.toLocaleString('en-US');
    for (const phase of ['asking', 'ready', 'build'] as const) {
      const len = phase === 'asking' ? asking().length : phase === 'ready' ? ready().length : build().length;
      expect(log, `${phase} length bullet`).toContain(fmt(len));
    }
    // AND THE SUPERSEDED TRIPLE IS GONE. Asserting the current numbers are
    // present is satisfied by any one mention, so it cannot catch a stale
    // bullet sitting next to a correct one — which is exactly how these came
    // to be wrong. The pre-sticky figures must not appear at all.
    for (const stale of ['11,205', '8,838', '4,364']) {
      expect(log, `${stale} is a pre-sticky length and must not be quoted`).not.toContain(stale);
    }
  });

  it('R4: the sticky rides the PER-ROUND system string, not the frozen context', () => {
    // MOVED, and the move is the fix. The context message is built once per
    // send and pushed onto `conversation`, while the method prompt and the
    // tool list are rebuilt every round from `phaseNow()`. A send that starts
    // on an asking turn and closes the record with `record_findings` therefore
    // handed round two Plan tools with a Discovery sticky still in the history
    // saying there is no plan tool on this turn.
    for (const phase of ['asking', 'ready', 'build'] as const) {
      expect(systemForPhase(phase), phase).toContain(sticky(phase));
      expect(ctx(phase), `${phase} context must not carry a second copy`).not.toContain(sticky(phase));
    }
    // And no phase gets another phase's sticky.
    expect(systemForPhase('asking')).not.toContain(sticky('ready'));
    expect(systemForPhase('build')).not.toContain(sticky('asking'));
  });

  it('R3: an asking turn gets a round count and is never told to propose', () => {
    const asked = ctx('asking');
    expect(asked).toMatch(/# Discovery budget: round 3 of \d+/);
    // THE DEFECT: this line was keyed on `limitReached` alone, so a discovery
    // turn read "If the brief is already clear enough, propose instead" while
    // `propose_strategy` was not on its tool list — the same contradiction
    // that made a live run ask the manager to type "go ahead".
    expect(asked).not.toMatch(/propose instead/);
    expect(asked).not.toMatch(/action:"propose"/);
    expect(asked).not.toMatch(/Put the plan up now/);
  });

  it('R3: a ready turn is where proposing belongs, limit reached or not', () => {
    expect(ctx('ready')).toMatch(/send one rather than asking more/);
    expect(ctx('ready', true)).toMatch(/DISCOVERY LIMIT REACHED/);
    expect(ctx('ready', true)).toMatch(/Put the plan up now/);
  });

  it('R3: a build turn gets no discovery budget at all', () => {
    expect(ctx('build')).not.toMatch(/Discovery budget/);
    expect(ctx('build', true)).not.toMatch(/DISCOVERY LIMIT REACHED/);
    // Confirm is not a discovery budget: the plan is approved and the only
    // job left is to compile it.
    // Its sticky is on the per-round system string now, not in this message.
    expect(systemForPhase('build')).toContain(sticky('build'));
  });
});

describe('each phase is told its own job, once', () => {
  // WAS "a propose-ready turn gets instructions, not a catalogue", pinned on
  // three per-phase blocks in `buildContextPrompt`. Those blocks are gone:
  // each said, in different words, what that phase's sticky already says, and
  // the asking one told a discovery turn to describe the journey in
  // "strategy.approach" on a turn where `propose_strategy` is not on the tool
  // list. The sticky is now the single statement of the turn's job.
  it('tells a ready turn the path is the job, and the lookups come first', () => {
    expect(sticky('ready')).toMatch(/propose_strategy — the plan and its path/);
    expect(sticky('ready')).toMatch(/Use them after you have settled the business plan/);
    expect(sticky('ready')).toMatch(/build_campaign is not here/);
  });

  it('never tells a ready turn it has no blueprint', () => {
    expect(sticky('ready')).not.toMatch(/strategy\.approach/);
    expect(sticky('ready')).not.toMatch(/OMIT "blueprint"/);
  });

  it('tells an asking turn there is no plan tool, and does not ask for a journey', () => {
    expect(sticky('asking')).toMatch(/propose_strategy is not here/);
    expect(sticky('asking')).toMatch(/build_campaign is not here/);
    // THE DEFECT THAT DELETED THOSE BLOCKS: a discovery turn was asked for the
    // journey in prose and called it "the deliverable this turn".
    expect(sticky('asking')).not.toMatch(/strategy\.approach/);
    expect(sticky('asking')).not.toMatch(/Describe the journey/);
  });

  it('tells a build turn to call the tool', () => {
    expect(sticky('build')).toMatch(/build_campaign — the approved path, as a journey/);
    expect(sticky('build')).toMatch(/propose_strategy is not here/);
  });
});

describe('how the builder assembles a journey stays in the builder vocabulary', () => {
  const v = blueprintVocabulary(CHANNELS, 'unavailable');

  it('still carries everything the split moved out of discovery', () => {
    expect(v).toMatch(/Event categories and their event types/);
    expect(v).toMatch(/Entities and attributes usable in conditions/);
    expect(v).toMatch(/Step kinds you may use/);
    expect(v).toMatch(/CANNOT express/);
  });
});

describe('the vocabulary is a tool call, not a paste', () => {
  it('is pasted into the context on NO turn at all', () => {
    // RETARGETED, not relaxed. The rule was "release the catalogue only when
    // something is being built", enforced by gating a paste — and a paste is
    // the wrong instrument either way: it spends the first user message on
    // something the model can read on demand, and it put every attribute
    // name in front of the agent in one block. The catalogue is now the
    // lookup TOOLS, phased by the same two facts, so nothing pastes it.
    expect(orch).not.toMatch(/'# Vocabulary you must stay inside'/);
    expect(orch).not.toMatch(/blueprintVocabulary\(availableChannels/);
  });

  it('gives the lookups to the turns that write steps, and to nobody else', () => {
    // Propose-ready is the turn that has to name real events, attributes,
    // operators and values, because Confirm compiles exactly its path. An
    // asking turn leaves all three operands false and gets none.
    expect(orch).toMatch(/toolsForPhase\(phase !== 'asking' \|\| designSeen\)/);
    const asking = toolsForPhase(false);
    expect(asking).toEqual([]);
    const ready = toolsForPhase(true).map((t) => t.name);
    expect(ready).toContain('list_event_types');
    expect(ready).toContain('list_audience_attributes');
    expect(ready).toContain('list_step_types');
    expect(ready).toContain('list_channels');
  });

  it('keeps the journey grammar off an asking turn by not offering the tool', () => {
    // The grammar cannot leak through a tool that is not on the list. This
    // used to assert on a stripped copy of `propose_strategy`; stripping was
    // the half-measure that made the tool refusable instead of absent.
    expect(outputToolsForPhase('asking').map((t) => t.name)).not.toContain('propose_strategy');
    const askingSchemas = JSON.stringify(outputToolsForPhase('asking').map((t) => t.input_schema));
    for (const leak of ['"branch"', '"waitForEvent"', 'first-touch', 'campaignName', '$defs', 'extraEntityGroups']) {
      expect(askingSchemas, leak).not.toContain(leak);
    }
    // And the two turns that write steps do have it.
    const ready = JSON.stringify(outputToolsForPhase('ready').find((t) => t.name === 'propose_strategy')!.input_schema);
    expect(ready).toContain('first-touch');
    expect(ready).toContain('$defs');
    const build = JSON.stringify(outputToolsForPhase('build').find((t) => t.name === 'build_campaign')!.input_schema);
    expect(build).toContain('first-touch');
  });

  it('still keeps build_campaign away from both non-build turns', () => {
    for (const phase of ['asking', 'ready'] as const) {
      expect(outputToolsForPhase(phase).map((t) => t.name)).not.toContain('build_campaign');
    }
    // And proposing belongs to exactly one of them.
    expect(outputToolsForPhase('ready').map((t) => t.name)).toContain('propose_strategy');
    expect(outputToolsForPhase('asking').map((t) => t.name)).not.toContain('propose_strategy');
  });

  it('counts a confirmation or a refinement, and nothing else', () => {
    const block = orch.slice(orch.indexOf('const isBuildTurn'), orch.indexOf('const isBuildTurn') + 160);
    expect(block).toMatch(/req\.intent \?\? 'converse'\) === 'confirm'/);
    expect(block).toMatch(/isRefinement/);
  });

  it('does NOT release it when the discovery budget runs out', () => {
    // Running out of budget forces a proposal, and a proposal is a plan, not
    // a journey. Handing over the vocabulary here would put the agent back
    // inside the builder's limits at exactly the moment it is under pressure
    // to wrap up.
    const block = orch.slice(orch.indexOf('const isBuildTurn'), orch.indexOf('const isBuildTurn') + 160);
    expect(block).not.toMatch(/limitReached/);
  });

  it('tells the agent WHY the catalogue is absent, in the sticky', () => {
    // WAS pinned on the "# NO BLUEPRINT THIS TURN" block, which is deleted.
    // The asking sticky carries the reason, and it is the honest one: nothing
    // is being designed, so the builder's vocabulary is not a question that
    // needs answering yet.
    expect(asking()).toMatch(/Nothing is being built this turn, so what the builder supports is not a question you need answered/);
    expect(sticky('asking')).toMatch(/The lookup tools for events, attributes, and channels are not here/);
  });

  it('keeps issuer context unconditional', () => {
    const i = orch.indexOf("'# This issuer'");
    expect(i).toBeGreaterThan(-1);
    expect(orch.slice(i, i + 200)).toMatch(/issuerContext\(availableChannels, tenant\.templateLibraryAccess\)/);
  });
});

describe('the system prompt itself withholds the blueprint grammar', () => {
  // THE LARGEST LEAK, and the one I had already claimed was fixed. Removing
  // blueprintVocabulary from the per-turn context did little while SYSTEM —
  // sent on every turn — carried a superset of it: the entry and goal shapes,
  // every step kind, real entity and attribute names, the existence lookback
  // and entity groups. The agent was told to omit a thing whose complete
  // grammar it had just been handed.
  it('strips the grammar on an ASKING turn', async () => {
    // NARROWED 2026-10-23, and the principle it protects is unchanged: while
    // still learning who converts, the agent must not be handed the
    // filterable field list, because it then reasons in those terms. What
    // changed is that "not a build turn" was two different turns — asking,
    // and putting a plan up for approval — and the second one has to carry
    // the sequence it is asking them to approve. `journeyAllowed` is false
    // here, which is every asking turn.
    const { systemForPhase } = await import('../../server/orchestrator');
    const discovery = systemForPhase('asking');
    for (const leak of [
      '"kind":"branch"',
      '"kind":"experiment"',
      '"kind":"condition"',
      'Transaction Amount',
      'existence',
      'first-touch|reminder',
      '"campaignName"',
    ]) {
      expect(discovery).not.toContain(leak);
    }
  });

  it('ready and build are no longer the same string', () => {
    // WAS "releases the grammar on the turn that puts a plan up for approval",
    // which asserted `systemForPhase('ready') === systemForPhase('build')` —
    // true, and the defect: a Confirm turn was read the entire Plan method,
    // including "think of two approaches" on a turn where the approach is
    // already approved. Three manuals, three strings.
    expect(ready()).not.toBe(build());
    expect(ready()).toContain('### This turn is Plan or Revise');
    expect(build()).toContain('### This turn is Confirm');
    expect(build()).not.toContain('Think of two approaches that are actually different');
  });

  // ------------------------------------------------------------------
  // THE ASKING PROMPT IS THE DISCOVERY MANUAL, not the plan prompt minus six
  // chapters.
  //
  // WAS "SLICE B: the asking prompt is discovery only", whose tests pinned the
  // CUT: that 'NAME EVERY TOUCH', '3. The business strategy', '6. The
  // strategic options' and the rest were ABSENT, and that a list of
  // discovery-shaped headings was still present. Both halves were about
  // chapter titles in one big string, and neither survives the rewrite — the
  // asking prompt is now a separate document that never contained them.
  //
  // What replaces them is the thing the cut was FOR: a discovery turn must
  // not be given the plan's jobs.
  describe('the asking prompt is discovery only', () => {
    it('does not carry the Plan jobs', () => {
      for (const planJob of [
        // the path and its grammar
        'Send that one journey',
        'propose_strategy — the plan and its path',
        // two approaches, then one journey
        'Think of two approaches that are actually different',
        'The canvas gets one journey',
        // writing the customer-facing messages
        'Write each one as the customer will read it',
        'Put the action in the call to action',
        // the reaction/cadence rules
        'A clock with no reaction is still a complete plan',
        'Failed delivery is the fallback on the send, not an arm',
      ]) {
        expect(asking(), planJob).not.toContain(planJob);
      }
    });

    it('carries the discovery jobs, named as its own', () => {
      expect(asking()).toMatch(/### This turn is Discovery/);
      for (const kept of [
        'Do not design the journey on this turn',
        'Ask who already does this, in their words',
        'Ask why the rest do not, in their words',
        'Derive three to five of them from this objective',
        'Time-to-act is timing, not an axis',
        'Do not invent a cutoff, a band, or a rupee figure',
        'Read their reply as an answer first',
      ]) {
        expect(asking(), kept).toContain(kept);
      }
    });

    it('does not carry the Confirm job either', () => {
      expect(asking()).not.toContain('### This turn is Confirm');
      expect(asking()).not.toContain('### This turn is Plan or Revise');
      expect(ready()).toContain('### This turn is Plan or Revise');
      expect(build()).toContain('### This turn is Confirm');
    });
  });

  it('each phase prompt is bounded, and the three are no longer one string', () => {
    // WAS "the cut cannot grow back a sentence at a time", with asking < ready
    // because asking was ready minus six chapters. They are separate manuals
    // now: discovery is the LONGEST, because discovery is the longest job.
    expect(asking().length).toBeLessThanOrEqual(22000);
    expect(ready().length).toBeLessThanOrEqual(22000);
    expect(build().length).toBeLessThanOrEqual(14000);
    // READY AND BUILD ARE NOT THE SAME STRING. They were identical at 32,779
    // characters, so a Confirm turn was read the whole Plan method.
    expect(ready()).not.toBe(build());
    expect(build().length).toBeLessThan(ready().length);
  });

  it('THE SCISSORS CUT IS GONE: three manuals, not one novel minus six chapters', () => {
    const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    // `discoveryOnly`, `DROPPED_FROM_ASKING` and the marker-throw were how the
    // asking prompt used to be made: the plan prompt with chapters sliced out.
    // It failed twice, once eating its own end marker and deleting three
    // chapters — and it meant discovery's prompt was defined by what had been
    // removed from someone else's.
    expect(orch).not.toMatch(/discoveryOnly/);
    expect(orch).not.toMatch(/DROPPED_FROM_ASKING/);
    expect(orch).not.toMatch(/const SYSTEM = `/);
    expect(orch).toMatch(/BODY: Record<TurnPhase, string>/);
  });

  it('gives the ready turn the lookups, and says to use them before committing', () => {
    // The catalogue is a TOOL CALL on this turn, never a paste — that half is
    // unchanged and asserted below. What moved is where the instruction lives.
    expect(sticky('ready')).toMatch(/The lookup tools — events, attributes, channels/);
    expect(ready()).toMatch(/Before you commit to an entry, a goal event, a field, or a channel, check it with a tool/);
  });

  it('does not tell a ready turn to omit the blueprint', () => {
    expect(sticky('ready')).not.toMatch(/OMIT "blueprint"/);
    expect(ready()).not.toMatch(/OMIT "blueprint"/);
  });

  it('releases it on EVERY turn that may propose, escapes included', async () => {
    // RETARGETED, and the rule it replaces was correct only while a propose
    // carried no journey. It asserted `d.proceed && !d.forcedBy`: a spent
    // round budget or a manager typing "go ahead" was a propose WITHOUT the
    // vocabulary. Now `propose_strategy` refuses a plan with no `blueprint`
    // and the gate holds a reactive plan without one, so excluding the
    // escapes made a turn that MUST propose and CANNOT — no blueprint field
    // in the schema, no lookups on the call, and a refusal telling it to
    // send a path.
    //
    // MEASURED, and it is why the expression is not `decide(brief, {})`:
    // that sees the budget escape, because rounds live on the record, and
    // misses the typed one entirely, because "go ahead" is a fact about the
    // TURN. `limitReached` is the same input the turn's own decision uses.
    const orchSrc = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    // ONE FUNCTION NOW, and the inputs are the same union. `turnPhase` is
    // pinned here rather than the old boolean because every reader takes it:
    // the prompt, both tool lists, the handler and the retry wrapper.
    expect(orchSrc).toMatch(/const phaseNow = \(\): TurnPhase => turnPhase\(brief, \{ isBuildTurn, limitReached \}\);/);
    expect(orchSrc).not.toMatch(/d\.proceed && !d\.forcedBy/);

    // And the behaviour either side of it, which is what actually matters.
    const { decide, MAX_ROUNDS } = await import('../../server/gate');
    const { newBrief, recordAnswer } = await import('../../server/discovery');
    const thin = recordAnswer(newBrief('Get more eligible purchases converted'), 'ok');
    const allowed = (brief: typeof thin, limitReached: boolean) =>
      decide(brief, { proceedRequested: limitReached }).proceed;

    // An asking turn: no escape, record not ready.
    expect(allowed(thin, false)).toBe(false);
    // The budget escape, and the typed one. Both must be true, and the
    // second is the one a record-only reading misses.
    expect(allowed({ ...thin, rounds: MAX_ROUNDS }, false)).toBe(true);
    expect(allowed(thin, true)).toBe(true);
  });

  it('gives a forced propose the blueprint field and the lookups', () => {
    // The trap, as a test: the turn is told to propose, and the schema it is
    // given has nowhere to put a path.
    const forced = outputToolsForPhase('ready').find((t) => t.name === 'propose_strategy')!;
    expect(forced.input_schema.properties.blueprint).toBeDefined();
    expect(forced.input_schema.$defs?.step).toBeDefined();
    expect(toolsForPhase(true).map((t) => t.name)).toHaveLength(5);
    // And an asking turn has no plan tool and no lookups — the trap closed
    // from the other end: there is no schema to be missing a field.
    expect(outputToolsForPhase('asking').find((t) => t.name === 'propose_strategy')).toBeUndefined();
    expect(toolsForPhase(false)).toEqual([]);
  });

  it('keeps all of it on a build turn, where it is needed', () => {
    // THE GRAMMAR MOVED. It is no longer prose in SYSTEM at all — it is the
    // input schema of `build_campaign`, checked by the API. So the phase gate
    // moved with it, from `systemForPhase` to `outputToolsForPhase`, and this
    // test follows it rather than being deleted.
    const build = JSON.stringify(
      outputToolsForPhase('build').find((t) => t.name === 'build_campaign')!.input_schema,
    );
    for (const needed of ['"branch"', '"experiment"', 'campaignName', 'first-touch']) {
      expect(build).toContain(needed);
    }
  });

  it('does not name a tool the asking turn does not have', () => {
    // Naming a tool the model cannot call is how a live Confirm came to reply
    // that the build was unavailable to it. Each sticky lists only its own
    // phase's tools, and says plainly which are not here.
    const names = outputToolsForPhase('asking').map((t) => t.name);
    expect(names).not.toContain('propose_strategy');
    expect(names).not.toContain('build_campaign');
    expect(sticky('asking')).toMatch(/propose_strategy is not here/);
    expect(sticky('asking')).toMatch(/build_campaign is not here/);
  });

  it('does not offer the build tool at all before there is a plan', () => {
    // Stronger than the old prompt-level omission: the tool is simply absent,
    // so there is no grammar to withhold and nothing to explain away.
    expect(outputToolsForPhase('asking').map((t) => t.name)).not.toContain('build_campaign');
    expect(outputToolsForPhase('build').map((t) => t.name)).toContain('build_campaign');
  });

  it('is what actually gets SENT — no raw SYSTEM reaches the model', () => {
    // Three send sites: the normal round, the stop-looking-up round, and the
    // unusable-answer retry. A raw ${SYSTEM} in any of them reopens the leak.
    expect(orch).not.toMatch(/system: `\$\{SYSTEM\}/);
    expect(orch).not.toMatch(/\? `\$\{SYSTEM\}/);
    expect(orch).not.toMatch(/: SYSTEM,/);
  });
});
