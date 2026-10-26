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
    expect(orch).toMatch(/tu\.name === 'propose_strategy' && phase !== 'asking'/);
  });
});

describe('a propose-ready turn gets instructions, not a catalogue', () => {
  it('says the plan must carry its path, and points at the lookups', () => {
    expect(orch).toMatch(/# THE PLAN YOU PUT UP MUST CARRY ITS PATH/);
    expect(orch).toMatch(/LOOK IT UP BEFORE YOU WRITE IT/);
    expect(orch).toMatch(/Do NOT call build_campaign this turn/);
  });

  it('never tells a ready turn it has no blueprint', () => {
    // The three branches are exclusive, and the asking one would contradict
    // the instruction above if both arrived.
    const ready = orch.slice(orch.indexOf('# THE PLAN YOU PUT UP MUST CARRY ITS PATH'), orch.indexOf("].join('\\n')\n      : isBuildTurn"));
    expect(ready.length).toBeGreaterThan(0);
    expect(ready).not.toMatch(/NO BLUEPRINT THIS TURN/);
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

  it('tells the agent WHY it is missing rather than leaving a silent hole', () => {
    expect(orch).toMatch(/# NO BLUEPRINT THIS TURN/);
    expect(orch).toMatch(/nothing is being built yet/);
    // And the build turn says the opposite just as plainly.
    expect(orch).toMatch(/# THIS TURN BUILDS THE APPROVED PLAN/);
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

  it('releases the grammar on the turn that puts a plan up for approval', async () => {
    // MEASURED, `ui-s-1792748248345` turn 4: `propose_strategy` returned
    // prose, the response carried `blueprint: false`, and Confirm appeared
    // under an essay — so the canvas was invented on the turn AFTER the
    // manager signed. A turn that asks for approval of a sequence must carry
    // the sequence.
    //
    // AND WHAT `systemForPhase` ACTUALLY WITHHOLDS IS ONE GROUND RULE, which
    // I had to measure to write this honestly. The step grammar is no longer
    // prose in SYSTEM at all — it moved into the tool schemas — so the only
    // live difference between the two strings is the vocabulary rule. The
    // assertions above about `"kind":"branch"` pass because SYSTEM contains
    // none of it on any turn; the real withholding is
    // `outputToolsForPhase` (no build_campaign) and the catalogue block in
    // the context prompt, both of which still apply.
    const { systemForPhase } = await import('../../server/orchestrator');
    const asking = systemForPhase('asking');
    const ready = systemForPhase('ready');
    expect(asking).toMatch(/Do not go looking for events, entities or attributes yet/);
    expect(asking).not.toMatch(/Use only the events, entities, attributes, values, channels and step kinds the tools report/);
    expect(ready).toMatch(/Use only the events, entities, attributes, values, channels and step kinds the tools report/);
    // THE STRING ITSELF IS UNCHANGED. The release is a gate, not new prose: a
    // ready turn gets exactly what a build turn has always had.
    expect(ready).toBe(systemForPhase('build'));
  });

  // ------------------------------------------------------------------
  // SLICE B: the asking prompt is discovery only.
  //
  // An asking turn was reading the entire design method on every round of
  // every conversation — the platform mapping, the entry event, the
  // hypothesis, the seven options, the journey and the message copy, all
  // about a campaign it may not design yet. The cut is straight: §3 to §8
  // out, nothing rewritten, `SYSTEM` itself untouched so every `promptMethod`
  // pin on the constant still holds.
  describe('the asking prompt is discovery only', () => {
    it('drops the design chapters', async () => {
      const { systemForPhase } = await import('../../server/orchestrator');
      const asking = systemForPhase('asking');
      for (const designOnly of [
        'NAME EVERY TOUCH',
        'A STEADY CADENCE IS A COMPLETE PLAN',
        'IF YOU WRITE BOTH CANDIDATES, THE REACTING ONE WINS',
        '3. The business strategy',
        '4. The sequence',
        '5. The hypothesis',
        '6. The strategic options',
        '7. The journey',
        '8. The messages',
        'Experimentation',
        'Write each one as the CUSTOMER will read it',
      ]) {
        expect(asking, designOnly).not.toContain(designOnly);
      }
    });

    it('keeps everything discovery actually runs on', async () => {
      const { systemForPhase } = await import('../../server/orchestrator');
      const asking = systemForPhase('asking');
      for (const kept of [
        'AT MOST THREE QUESTIONS THIS ROUND',
        'NEVER ASK ABOUT QUIET HOURS',
        'NEVER INVENT A PERFORMANCE NUMBER',
        'GROUND RULES',
        'FIRST, FIND OUT WHO CONVERTS AND WHY THE REST DO NOT',
        '"We do not track that" closes it',
        'Do not invent a cutoff',
        '2. The dimensions',
        '9. Honesty about what is settled',
        'QUESTIONS AND OPEN ITEMS',
        'DISCOVER FIRST',
        'Propose only once the user has answered at least one question',
      ]) {
        expect(asking, kept).toContain(kept);
      }
    });

    it('drops the propose-payload paragraphs the cut strands', async () => {
      // The `openItems` kind-list is written for a payload this turn does not
      // send; the limitation paragraph under it names those kinds and means
      // nothing without them; and the last sentence invites exactly the move
      // the asking-turn refusal exists to stop.
      const { systemForPhase } = await import('../../server/orchestrator');
      const asking = systemForPhase('asking');
      expect(asking).not.toContain('When you propose, list what is still open in "openItems"');
      expect(asking).not.toContain('Propose a complete, coherent strategy even when something is open');
      expect(asking).not.toContain('strategic-ambiguity');
    });

    it('is bounded, so the cut cannot grow back a sentence at a time', async () => {
      const { systemForPhase } = await import('../../server/orchestrator');
      // Measured at 17,837 on the slice that made the cut. The bound exists
      // because there is no other check on this string: the 33,500 cap is on
      // the SYSTEM constant, which an asking turn no longer receives in full.
      expect(systemForPhase('asking').length).toBeLessThanOrEqual(22_000);
      // And it is genuinely a subset of the full method, not a variant of it.
      expect(systemForPhase('asking').length).toBeLessThan(systemForPhase('ready').length);
    });

    it('throws rather than guess when a marker has moved', async () => {
      // THE FAILURE MODES THIS RULES OUT ARE BOTH SILENT. Falling back to the
      // full prompt hands the design method to a discovery turn with nothing
      // to say so; a slice whose end marker has gone quietly becomes "the
      // rest of the file", which is how two tests in `emptyRoundRecovery`
      // came to assert against everything to EOF.
      const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
      expect(src).toMatch(/throw new Error\(`systemForPhase: the asking prompt cannot be cut/);
      // The markers are read from one list, so the cut is stated once.
      expect(src).toMatch(/const DROPPED_FROM_ASKING: \[string, string\]\[\]/);
    });
  });

  it('gives the ready turn the catalogue, so its steps can name real things', () => {
    // Confirm compiles the proposed path, so an attribute the agent invented
    // at propose time would reach the canvas as a dropped condition. The
    // names travel with the grammar; the build-turn INSTRUCTIONS do not.
    expect(orch).toMatch(/phase === 'ready'/);
    expect(orch).toMatch(/THE PLAN YOU PUT UP MUST CARRY ITS PATH/);
    expect(orch).toMatch(/Do NOT call build_campaign this turn/);
  });

  it('does not tell a ready turn to omit the blueprint', async () => {
    // MEASURED in llm-prompt.html: the catalogue was a nested list joined with
    // commas, sitting above the asking-turn "OMIT blueprint" block, so a ready
    // turn was told to carry the path and then to omit it.
    const { buildContextPrompt } = await import('../../server/orchestrator');
    const { newBrief } = await import('../../server/discovery');
    const { resolveTenant } = await import('../../server/tenants');
    const tenant = resolveTenant('TEN-IBL')!;
    const req = {
      sessionId: 't',
      messages: [],
      knowledge: { version: 'test', entries: [] },
      discoveryRounds: 0,
      tenantId: tenant.tenantId,
    };
    const brief = newBrief('Get more of them to convert before the request expires.');
    const channels = tenant.availableChannels.filter((c) => c.available).map((c) => c.channel);
    const asking = buildContextPrompt(req, brief, tenant, '', channels, false, false, false, 'asking');
    const ready = buildContextPrompt(req, brief, tenant, '', channels, false, false, false, 'ready');
    expect(asking).toMatch(/# NO BLUEPRINT THIS TURN/);
    expect(asking).not.toMatch(/THE PLAN YOU PUT UP MUST CARRY ITS PATH/);
    expect(ready).toMatch(/THE PLAN YOU PUT UP MUST CARRY ITS PATH/);
    expect(ready).not.toMatch(/# NO BLUEPRINT THIS TURN/);
    expect(ready).not.toMatch(/Vocabulary you must stay inside,/);
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
    // that the build was unavailable to it. The asking turn's "how to write
    // this turn" line used to list `propose_strategy` as the plan tool; it
    // now says plainly that neither plan tool is on the call, and names the
    // four that are.
    const howTo = orch.slice(orch.indexOf("'# How to write this turn'"), orch.indexOf("'# This issuer'"));
    const askingLine = howTo.slice(howTo.lastIndexOf(": 'Put everything structured"));
    expect(askingLine).toMatch(/Neither "propose_strategy" nor "build_campaign" is on this turn/);
    expect(askingLine).toMatch(/"request_evidence"/);
    expect(askingLine).not.toMatch(/"propose_strategy" for the plan/);
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
