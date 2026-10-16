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

describe('how the builder assembles a journey stays in the builder vocabulary', () => {
  const v = blueprintVocabulary(CHANNELS, 'unavailable');

  it('still carries everything the split moved out of discovery', () => {
    expect(v).toMatch(/Event categories and their event types/);
    expect(v).toMatch(/Entities and attributes usable in conditions/);
    expect(v).toMatch(/Step kinds you may use/);
    expect(v).toMatch(/CANNOT express/);
  });
});

describe('the vocabulary arrives only when something is being BUILT', () => {
  it('is gated on a build turn, not merely on discovery being finished', () => {
    // Stricter than the first version of this rule, deliberately. Releasing
    // it the moment discovery completed still meant the agent composed its
    // PROPOSAL knowing what the builder supports — and a proposal written
    // inside the platform's limits is a proposal the platform wrote.
    expect(orch).toMatch(/isBuildTurn\s*\n?\s*\? \[\s*\n?\s*'# Vocabulary you must stay inside/s);
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
  it('strips the grammar on a turn that is not building', async () => {
    const { systemForPhase } = await import('../../server/orchestrator');
    const discovery = systemForPhase(false);
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

  it('keeps all of it on a build turn, where it is needed', () => {
    // THE GRAMMAR MOVED. It is no longer prose in SYSTEM at all — it is the
    // input schema of `build_campaign`, checked by the API. So the phase gate
    // moved with it, from `systemForPhase` to `outputToolsForPhase`, and this
    // test follows it rather than being deleted.
    const build = JSON.stringify(
      outputToolsForPhase(true).find((t) => t.name === 'build_campaign')!.input_schema,
    );
    for (const needed of ['"branch"', '"experiment"', 'campaignName', 'first-touch']) {
      expect(build).toContain(needed);
    }
  });

  it('does not offer the build tool at all before there is a plan', () => {
    // Stronger than the old prompt-level omission: the tool is simply absent,
    // so there is no grammar to withhold and nothing to explain away.
    expect(outputToolsForPhase(false).map((t) => t.name)).not.toContain('build_campaign');
    expect(outputToolsForPhase(true).map((t) => t.name)).toContain('build_campaign');
  });

  it('is what actually gets SENT — no raw SYSTEM reaches the model', () => {
    // Three send sites: the normal round, the stop-looking-up round, and the
    // unusable-answer retry. A raw ${SYSTEM} in any of them reopens the leak.
    expect(orch).not.toMatch(/system: `\$\{SYSTEM\}/);
    expect(orch).not.toMatch(/\? `\$\{SYSTEM\}/);
    expect(orch).not.toMatch(/: SYSTEM,/);
  });
});
