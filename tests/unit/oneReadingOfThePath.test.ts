/**
 * ONE READING OF THE PATH — the compiler, `propose_strategy` and the gate all
 * ask `server/pathReading.ts`.
 *
 * MEASURED, `eval/runs/ui-s-1793077922155` turn 3. Two proposes were refused
 * over sends that were already nested on the arms: the forks carried their
 * attribute in `on` rather than at the top level, the compiler classified a
 * fork by the ABSENCE of `entity`/`attribute`, and so a ticket-size split was
 * read as a delivery fork, failed its preceding-send check as the journey's
 * first step, and took its whole tree with it. Seven nested sends compiled to
 * none. Then five. The condition that was finally accepted had no `paths` at
 * all, so `whoGroups` — which only ever iterated `step.paths` — found no
 * groups and the plan was held for testing nothing.
 *
 * Every payload below is COPIED from that run (`...paths.json`, tracked
 * because `eval/runs/` is gitignored), not reconstructed. Three times this
 * month a reconstructed fixture has agreed with the bug.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { forkAttribute, forkKind, sendSteps, longestSendSteps, whoGroups, hasExperiment } from '../../server/pathReading';
import { buildFromBlueprint, type CampaignBlueprint } from '../../server/blueprint';
import { reactsToDelivery, journeyReacts } from '../../server/optionAudit';
import { decide, trendBlocks, cadenceBlocks } from '../../server/gate';
import { applyOutputTool } from '../../server/outputTools';
import type { WorkingBrief } from '../../server/discovery';

const LIVE = JSON.parse(
  readFileSync(new URL('./support/liveBriefs/ui-s-1793077922155.turn-3.paths.json', import.meta.url), 'utf8'),
) as {
  branchOnWithReadFork: unknown[];
  branchOnPlain: unknown[];
  filedCondition: unknown[];
  brief: WorkingBrief;
};

const CHANNELS = ['WHATSAPP', 'SMS', 'EMAIL'];

/** The blueprint the live run's propose payloads were wrapped in. */
const pathAs = (steps: unknown[]): CampaignBlueprint =>
  ({
    campaignName: 'EMI on eligible purchases',
    description: 'Prompt conversion inside the seven-day window.',
    goal: null,
    entry: { kind: 'event', eventCategory: 'Transaction Events', eventType: 'Transaction' },
    steps,
  }) as unknown as CampaignBlueprint;

const builtSends = (steps: unknown[]) => {
  const out = buildFromBlueprint(pathAs(steps), CHANNELS);
  const nodes = Object.values((out.graph?.nodes ?? {}) as Record<string, { type?: string }>);
  return { sends: nodes.filter((n) => n.type === 'SEND').length, issues: out.issues };
};

/** The brief as it stood on turn 3, with the plan the run finally filed. */
const liveBrief = () => structuredClone(LIVE.brief);
const filedPlan = () => structuredClone(LIVE.brief.lastProposal!.strategy as Record<string, unknown>);
const underReview = (steps: unknown[]) => ({ strategy: filedPlan(), blueprint: pathAs(steps) }) as never;

const send = (name: string, stage = 'first-touch') => ({
  kind: 'send',
  name,
  objective: ['emi'],
  stage,
  describe: 'd',
  copy: 'Split this purchase into EMI.',
  channelPreference: ['WHATSAPP'],
  barrier: 'eligibility-awareness',
});

describe('the fork reads its attribute from either place the model may put it', () => {
  it('reads `on`, so the live ticket split is an attribute fork and not a delivery one', () => {
    const fork = LIVE.branchOnWithReadFork[0] as Record<string, unknown>;
    // The live shape: `branch` + `on`, nothing at the top level. This is the
    // exact combination the old `!step.entity && !step.attribute` test called
    // an outcome fork.
    expect(fork.entity, 'the live payload carries nothing at the top level').toBeUndefined();
    expect(fork.attribute).toBeUndefined();
    expect(forkAttribute(fork)).toMatchObject({ entity: 'Transaction', attribute: 'Transaction Amount' });
    expect(forkKind(fork)).toBe('attribute');
  });

  it('an attribute beats named statuses, because that is the defect', () => {
    // A step carrying both is a cohort split that has also named statuses.
    // Reading it as a delivery fork is what dropped seven sends.
    const both = { kind: 'branch', on: { entity: 'Transaction', attribute: 'Transaction Amount' }, paths: [{ label: 'a', statuses: ['READ'] }] };
    expect(forkKind(both)).toBe('attribute');
    expect(forkKind({ kind: 'branch', paths: [{ label: 'a', statuses: ['READ'] }, { label: 'b', statuses: ['DELIVERED'] }] })).toBe('outcome');
  });
});

describe('every send the live run wrote reaches the canvas', () => {
  it('the 7-send branch+on with a nested read fork compiles to 7 messages', () => {
    // WAS ZERO. The refusal told the model to nest the sends inside the arms;
    // they were already there.
    expect(sendSteps(LIVE.branchOnWithReadFork)).toBe(7);
    const { sends, issues } = builtSends(LIVE.branchOnWithReadFork);
    expect(sends).toBe(7);
    expect(issues, 'and nothing is reported, so `ok` is not withheld').toHaveLength(0);
  });

  it('its who-groups are the two ticket bands, not the engagement arms inside one', () => {
    const groups = whoGroups(LIVE.branchOnWithReadFork);
    expect(groups.map((g) => g.label)).toEqual(['High ticket (>₹10,000)', 'Mid/low ticket (≤₹10,000)']);
    // Every band gets messages, which is the cadence question — and the read
    // fork nested on the lower band is an interior of that band rather than a
    // third guest list.
    expect(groups.map((g) => g.sends)).toEqual([2, 5]);
  });

  it('and it reacts — `reactsToDelivery` is UNCHANGED by the new reading', () => {
    // The point of this pin is that nothing moved. `reactsToDelivery` finds
    // the nested read fork either way; the attribute fork above it was never
    // a reaction and still is not.
    expect(reactsToDelivery(pathAs(LIVE.branchOnWithReadFork))).toBe(true);
    expect(journeyReacts(pathAs(LIVE.branchOnWithReadFork))).toBe(true);
  });

  it('the 5-send branch+on with no nested fork compiles to 5, and does NOT react', () => {
    expect(sendSteps(LIVE.branchOnPlain)).toBe(5);
    const { sends, issues } = builtSends(LIVE.branchOnPlain);
    expect(sends).toBe(5);
    expect(issues).toHaveLength(0);
    expect(whoGroups(LIVE.branchOnPlain)).toHaveLength(2);
    // UNCHANGED, the other half of the pin above: a ticket-size split is who
    // the customer is, never what they did with the last message.
    expect(reactsToDelivery(pathAs(LIVE.branchOnPlain))).toBe(false);
  });

  it('on this brief the 5-send plan clears trendBlocks, because the band is a stated trend', () => {
    // Ticket size is `retained` + `user` on this record — the manager said
    // ₹10,000-plus purchases convert more — so the cut IS the instrument and
    // no second one is owed.
    expect(trendBlocks(liveBrief(), underReview(LIVE.branchOnPlain))).toEqual([]);
  });
});

describe('the condition the run finally filed', () => {
  it('is a who-split of two groups, which `whoGroups` could not see before', () => {
    // A condition has no `paths`. The old walk iterated `step.paths` only, so
    // this produced NO groups, `comparesNothing` was true, and the plan was
    // held `nothing-tested` with no legal move except a split it already had.
    expect(forkKind(LIVE.filedCondition[0])).toBe('attribute');
    const groups = whoGroups(LIVE.filedCondition);
    expect(groups).toHaveLength(2);
    expect(groups[1].label, 'the remainder is named, because it keeps a path').toBe('everyone else');
    expect(groups.every((g) => g.sends > 0)).toBe(true);
  });

  it('proceeds, and is not nothing-tested', () => {
    const brief = liveBrief();
    const proposed = underReview(LIVE.filedCondition);
    expect(trendBlocks(brief, proposed)).toEqual([]);
    const d = decide(brief, { proposed });
    expect(d.blocks.map((b) => b.code), 'held `nothing-tested` live').toEqual([]);
    expect(d.proceed).toBe(true);
  });

  it('counts its sends ONCE, so the compile check does not refuse the plan that got through', () => {
    // THE REGRESSION THIS SLICE NEARLY SHIPPED. `armsOf` reads `yes`/`no` when
    // a condition has no `paths`, and `children` listed both that and the raw
    // fields — so the walk descended each arm twice. MEASURED: 10 sends in the
    // JSON against 5 on the canvas, and `outputTools` refuses on exactly that
    // mismatch. The consolidation written to stop a correct plan being
    // rejected would have rejected the only plan the live run filed.
    expect(sendSteps(LIVE.filedCondition)).toBe(5);
    expect(builtSends(LIVE.filedCondition).sends).toBe(5);

    const before = liveBrief();
    const out = applyOutputTool(before, 'propose_strategy', { ...filedPlan(), blueprint: pathAs(LIVE.filedCondition) });
    expect(out.error ?? null, 'the filed path is accepted').toBeNull();
    expect(out.brief.lastProposal).toBeTruthy();
  });
});

describe('what is still NOT a guest list', () => {
  it('a read/unread fork is the same person later, so it is no who-split', () => {
    const readFork = [
      send('Eligibility alert'),
      {
        kind: 'branch',
        paths: [
          { label: 'Unread', statuses: ['DELIVERED'], steps: [{ kind: 'wait', duration: 1, unit: 'days' }, send('Repeat the fact', 'reminder')] },
          { label: 'Read', statuses: ['READ'], steps: [send('Change the argument', 'reminder')] },
        ],
      },
    ];
    expect(forkKind(readFork[1])).toBe('outcome');
    expect(whoGroups(readFork), 'engagement arms are an interior').toEqual([]);
    // And because the journey reacts, it compares something: no trend hold.
    expect(reactsToDelivery(pathAs(readFork))).toBe(true);
    expect(trendBlocks(liveBrief(), underReview(readFork))).toEqual([]);
  });

  it('experiment arms are an interior too, and are found at any depth', () => {
    const arms = [{ kind: 'experiment', label: 'Wording', arms: [{ label: 'A', pct: 50, steps: [send('a')] }, { label: 'B', pct: 50, steps: [send('b')] }] }];
    expect(whoGroups(arms)).toEqual([]);
    expect(sendSteps(arms)).toBe(2);
    expect(hasExperiment(arms)).toBe(true);
    // The walk has to descend an attribute fork's arms to find one. NEITHER
    // live path contains an experiment — the 7-send one nests a READ fork
    // under its lower band, which is what the reacts pin above is about — so
    // the depth claim is made on a nest of the live shape rather than
    // attributed to a payload that does not have it.
    expect(hasExperiment(LIVE.branchOnWithReadFork)).toBe(false);
    expect(hasExperiment(LIVE.branchOnPlain)).toBe(false);
    const nested = [
      {
        kind: 'branch',
        on: { entity: 'Transaction', attribute: 'Transaction Amount', operator: 'Equals', value: '10000' },
        paths: [{ label: 'High', steps: [send('high')] }, { label: 'Low', steps: arms }],
      },
    ];
    expect(hasExperiment(nested)).toBe(true);
    expect(sendSteps(nested), 'and the sends under both are counted once each').toBe(3);
  });

  it('an outcome fork is still not an N-way outcome branch when it splits on an attribute', () => {
    // AMENDMENT 1, and the amendment was overstated. "Behaviour unchanged" is
    // true of every recorded payload — a ticket band carries operator/value,
    // which the engagement-statuses filter rejected either way — and FALSE
    // here: a fork carrying `on` AND statuses used to be read as an N-way
    // delivery branch and reported a reaction. `forkKind` calls it an
    // attribute fork, because an attribute beats a status, which is the defect
    // that dropped seven sends. This case is what proves the verdict moved,
    // and reverting the classifier is what made me write the comment honestly.
    const asAttribute = [
      send('open'),
      {
        kind: 'branch',
        on: { entity: 'Transaction', attribute: 'Transaction Amount', operator: 'Equals', value: '10000' },
        paths: [
          { label: 'High', statuses: ['READ'], steps: [send('x', 'reminder')] },
          { label: 'Low', statuses: ['DELIVERED'], steps: [{ kind: 'wait', duration: 1, unit: 'days' }, send('y', 'reminder')] },
        ],
      },
    ];
    expect(reactsToDelivery(pathAs(asAttribute))).toBe(false);
    // Drop the attribute and the identical arms ARE a reaction, which is what
    // makes the line above a statement about the classification rather than
    // about the arms.
    const sameArms = structuredClone(asAttribute) as Record<string, unknown>[];
    delete (sameArms[1] as { on?: unknown }).on;
    expect(reactsToDelivery(pathAs(sameArms))).toBe(true);
  });
});

describe('the cadence consequence of a condition becoming a who-group', () => {
  it('an attribute condition whose `no` arm has no sends is a cadence hold', () => {
    // DELIBERATE, AND STATED EITHER WAY. Teaching `whoGroups` to read a
    // condition's `yes`/`no` releases `nothing-tested` on the live plan and
    // tightens cadence on a shape it could not see before: a split that filters
    // at the door one step later, where the remainder gets no campaign at all.
    // That is the same failure the segmentation audit refuses, so holding it
    // here is the rule applying rather than a side effect to apologise for.
    const emptyRemainder = [
      {
        kind: 'condition',
        label: 'Big ticket',
        on: { entity: 'Transaction', attribute: 'Transaction Amount', operator: 'Equals', value: '10000' },
        yes: [send('Day 0'), send('Day 3', 'reminder')],
        no: [],
      },
    ];
    expect(whoGroups(emptyRemainder).map((g) => g.sends)).toEqual([2, 0]);
    expect(cadenceBlocks(underReview(emptyRemainder)).map((b) => b.code)).toEqual(['cadence-unnamed']);

    // Give the remainder one message and it is approvable — one send per band
    // is the standing lock.
    const withRemainder = structuredClone(emptyRemainder);
    withRemainder[0].no = [send('Day 0, lighter')];
    expect(cadenceBlocks(underReview(withRemainder))).toEqual([]);
  });
});

describe('the refusals this reading does NOT remove', () => {
  it('a waits-only path still refuses, and does not file', () => {
    const waits = [{ kind: 'wait', duration: 2, unit: 'days' }, { kind: 'exit', reason: 'Window closed.' }];
    expect(sendSteps(waits)).toBe(0);
    const out = applyOutputTool(liveBrief(), 'propose_strategy', { ...filedPlan(), blueprint: pathAs(waits) });
    expect(out.error).toMatch(/compiles to no messages/i);
    expect(out.strategy ?? null).toBeNull();
  });

  it('a mixed path with sends on the arms AND one after the fork still refuses', () => {
    // The sibling has no single arm to continue from, so the compiler reports
    // it and drops it. Counted, not classified: 3 written, 2 built.
    const mixed = [
      {
        kind: 'branch',
        on: { entity: 'Transaction', attribute: 'Transaction Amount', operator: 'Equals', value: '10000' },
        paths: [
          { label: 'High', steps: [send('High day 0')] },
          { label: 'Low', steps: [send('Low day 0')] },
        ],
      },
      send('Shared last chance', 'reminder'),
    ];
    expect(sendSteps(mixed)).toBe(3);
    expect(builtSends(mixed).sends).toBe(2);
    const out = applyOutputTool(liveBrief(), 'propose_strategy', { ...filedPlan(), blueprint: pathAs(mixed) });
    expect(out.error).toMatch(/has 3 messages in it and only 2 reached the journey/i);
    expect(out.error).toMatch(/Nest it inside the arm it belongs to/i);
    // QUOTES THE SKIP, rather than guessing the cause: the compiler names the
    // message it lost, so the refusal repeats its words.
    expect(out.error).toMatch(/Shared last chance/);
  });

  it('and a refusal quotes the compiler when the compiler knows why', () => {
    // An invented attribute drops the fork and its whole tree. The sentence
    // used to blame a send-after-a-fork, which was the one cause it knew about
    // — and was wrong twice on the live run.
    const badAttribute = [
      {
        kind: 'branch',
        name: 'Split',
        on: { entity: 'Transaction', attribute: 'Nonexistent Attr', operator: 'Equals', value: '1' },
        paths: [{ label: 'A', steps: [send('a')] }, { label: 'B', steps: [send('b')] }],
      },
    ];
    const out = applyOutputTool(liveBrief(), 'propose_strategy', { ...filedPlan(), blueprint: pathAs(badAttribute) });
    expect(out.error).toMatch(/has 2 messages in it and none of them reached the journey/i);
    expect(out.error).toMatch(/Transaction has no attribute "Nonexistent Attr"/);
    // AND NO BLANKET NEST INSTRUCTION. The sends here are nested on the arms
    // already; the fork was dropped because the attribute does not resolve.
    // Telling the model to nest them is the sentence that wasted two live
    // attempts on `ui-s-1793080526410`.
    expect(out.error).not.toMatch(/nest/i);
    expect(out.strategy ?? null, 'nothing is approvable').toBeNull();
  });
});

describe('density is one route, not every labelled row', () => {
  it('a nested read-fork on one who-arm is 3, not 2', () => {
    const send = { kind: 'send', name: 'm', objective: ['emi'], stage: 'first-touch', describe: 'd' };
    const steps = [
      {
        kind: 'branch',
        on: { entity: 'Transaction', attribute: 'Transaction Amount' },
        paths: [
          { label: 'High', steps: [send, send] },
          {
            label: 'Low',
            steps: [
              send,
              {
                kind: 'branch',
                paths: [
                  { label: 'Read', statuses: ['READ'], steps: [send, send] },
                  { label: 'Unread', statuses: ['DELIVERED'], steps: [send] },
                ],
              },
            ],
          },
        ],
      },
    ];
    expect(longestSendSteps(steps)).toBe(3);
    expect(sendSteps(steps)).toBe(6);
  });
});

describe('the honest limit: the client keeps its own reading', () => {
  it('`preview.ts` imports nothing from the server', () => {
    // Importing `pathReading` would pull the compiler and the reducer into the
    // browser bundle. The preview decides nothing — it draws a path — so a
    // second reading of the same two fields is tolerable, kept honest here.
    // Asserted on IMPORTS, not on the word: the file's own comment names
    // `server/pathReading` to say why it does not import it, and a grep for
    // the name is satisfied by that sentence either way.
    const src = readFileSync(new URL('../../src/designer/preview.ts', import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^\s*import\s[\s\S]*?from\s+'([^']+)';/gm)].map((m) => m[1]);
    expect(imports.filter((p) => /server\/|pathReading|blueprint/.test(p))).toEqual([]);
  });

  it('a branch carrying `on` and no top-level attribute is not drawn as "Split"', async () => {
    const { previewFromBlueprint } = await import('../../src/designer/preview');
    const view = previewFromBlueprint({
      campaignName: 'EMI',
      entry: { kind: 'event', eventCategory: 'Transaction Events', eventType: 'Transaction' },
      steps: LIVE.branchOnWithReadFork,
    } as never);
    const forks = (view?.rows ?? []).filter((r) => r.kind === 'fork');
    expect(forks.length, 'the ticket split is drawn').toBeGreaterThan(0);
    expect(forks[0].text).not.toBe('Split');
    expect(forks[0].text).toMatch(/Transaction amount/i);
  });
});
