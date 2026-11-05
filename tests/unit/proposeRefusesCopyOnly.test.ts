// A copy-only explanation experiment does not reach the record.
//
// MEASURED, `eval/runs/ui-s-1793616608652` turn 3. The manager answered "not
// sure" to why the dormant cardholders stopped, so the reason was settled as
// unknown — and the plan came back with `tests: 'explanation'` and two arms
// labelled "forgot the card" against "switched to UPI". Causes nobody had
// named, and structurally one journey: same contacts, same channels, same
// spacing, different paragraphs. It was filed, Confirm built it, and whichever
// arm won it could not have said which reason was real.
//
// `checkExperimentClaims` has refused exactly this since it was written. It
// was only ever asked AFTER a refinement, never at propose time, so the first
// plan of a conversation walked straight past it. This moves the same
// function one turn earlier, before the stash.
//
// The rule is unchanged and is not re-stated here: `tests: 'wording'` is
// exempt, because two paragraphs is what a wording test IS. Arms that
// genuinely differ pass whatever they claim.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyOutputTool } from '../../server/outputTools';
import { COPY_ONLY_ARMS, experimentOf, send } from './support/journeys';

/** A settled brief and a plan it already accepted, from a recorded run. */
const SETTLED = JSON.parse(
  readFileSync(new URL('./support/liveBriefs/ui-s-1793077922155.turn-3.paths.json', import.meta.url), 'utf8'),
) as { brief: { lastProposal: { strategy: Record<string, unknown> } } };

const BARRIER = 'eligibility-awareness';
const opening = () => send({ name: 'First ask', stage: 'first-touch', barrier: BARRIER });

const propose = (steps: unknown[]) =>
  applyOutputTool(structuredClone(SETTLED.brief) as never, 'propose_strategy', {
    ...structuredClone(SETTLED.brief.lastProposal.strategy),
    blueprint: {
      campaignName: 'Reactivate dormant cardholders',
      description: 'Get dormant cardholders transacting again.',
      goal: null,
      entry: { kind: 'audience', entity: 'Card', conditions: [] },
      steps,
    },
  } as never);

/** Nothing on the record moved: this brief arrives carrying its own plan. */
const filedNothing = (out: ReturnType<typeof applyOutputTool>) =>
  expect(out.brief.lastProposal).toEqual(SETTLED.brief.lastProposal);

describe('propose_strategy refuses an experiment that cannot answer its own claim', () => {
  it('does not file a copy-only explanation', () => {
    const out = propose([opening(), experimentOf('explanation')]);
    expect(out.error).toMatch(/same journey/i);
    expect(out.error).toMatch(/which barrier was real/i);
    // The way out is named, and neither way is a question to the manager:
    // the arms are the agent's own claim about its own design.
    expect(out.error).toMatch(/genuinely different journeys|drop the experiment/i);
    expect(out.error).not.toMatch(/which (way|do you want)/i);
    filedNothing(out);
    expect(out.strategy ?? null).toBeNull();
  });

  it('refuses the same arms when the claim is timing, and when nothing is declared', () => {
    // Not an explanation-only rule. The exemption is `wording` alone, and
    // silence has never bought permission.
    expect(propose([opening(), experimentOf('timing')]).error).toMatch(/when to make contact/i);
    expect(propose([opening(), experimentOf('')]).error).toMatch(/same journey/i);
  });

  it('files the same arms when they are declared honestly as a wording test', () => {
    // THE ESCAPE HATCH IS REAL, so this cannot become a trap. Two paragraphs
    // is exactly what a wording test is, and the plan is approvable.
    const out = propose([opening(), experimentOf('wording')]);
    expect(out.error ?? null).toBeNull();
    expect(out.brief.lastProposal).not.toEqual(SETTLED.brief.lastProposal);
  });

  it('files an explanation whose arms actually differ', () => {
    // The other legal move: same claim, arms that are different journeys.
    // One waits ten days before it says anything, the other does not.
    const out = propose([
      opening(),
      experimentOf('explanation', [
        [send({ name: 'Now', barrier: BARRIER })],
        [{ kind: 'wait', durationHours: 240 }, send({ name: 'Later', barrier: BARRIER })],
      ] as [unknown[], unknown[]]),
    ]);
    expect(out.error ?? null).toBeNull();
    expect(out.brief.lastProposal).not.toEqual(SETTLED.brief.lastProposal);
  });

  it('is the audit itself, not a second copy of its rule', () => {
    // Two definitions of "the same journey" would drift, and the drift would
    // be invisible because each half would keep passing its own tests.
    const src = readFileSync(new URL('../../server/outputTools.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/checkExperimentClaims\(path as never\)/);
    expect(src, 'no local notion of identical arms').not.toMatch(/armShape|identicalArms\s*=/);
  });
});
