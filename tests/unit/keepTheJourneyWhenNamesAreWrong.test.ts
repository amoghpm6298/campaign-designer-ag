/**
 * A WRONG LABEL IS AN ISSUE ON A JOURNEY, NOT A DELETED GRAPH.
 *
 * Same family as defaulting a missing `stage`: a send they wrote is a send on
 * the canvas.
 *
 * MEASURED, `eval/runs/ui-s-1793080526410` turn 3. The agent filed the right
 * campaign — a ticket-size split with five messages on the two arms — and
 * Confirm never appeared, because the compiler treated a catalogue MISS as
 * "there is no campaign":
 *
 *  - entry was `Transaction Events / Purchase Posted`. The category is real and
 *    the type is invented, and the compiler returned before any step ran.
 *  - the who-split was `Transaction` / `Amount`. The only amount field on
 *    Transaction is `Transaction Amount`; the compiler said the entity has no
 *    such attribute and returned before the arms.
 *  - three `condition` steps labelled "Check conversion" named nothing, and
 *    skipping one cost every message after it on its arm.
 *
 * The refusal then told the model to nest the sends inside the arms. They were
 * already nested, twice over.
 *
 * These are COMPILER tests, not chat tests. Resolution happens inside
 * `buildFromBlueprint`, which the dry run and Confirm already share, so both
 * see the same graph — and the filed JSON is never rewritten.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildFromBlueprint, type CampaignBlueprint } from '../../server/blueprint';
import { applyOutputTool } from '../../server/outputTools';
import { decide, turnPhase } from '../../server/gate';
import type { WorkingBrief } from '../../server/discovery';

const LIVE = JSON.parse(
  readFileSync(new URL('./support/liveBriefs/ui-s-1793080526410.turn-3.paths.json', import.meta.url), 'utf8'),
) as {
  entry: { kind: 'event'; eventCategory: string; eventType: string };
  steps: unknown[];
  brief: WorkingBrief;
};

const CHANNELS = ['WHATSAPP', 'SMS', 'EMAIL'];

const build = (bp: Partial<CampaignBlueprint> & { steps: unknown[] }) =>
  buildFromBlueprint(
    {
      campaignName: 'EMI on eligible purchases',
      description: 'Prompt conversion inside the window.',
      goal: null,
      entry: { kind: 'audience', entity: 'Customer', conditions: [] },
      ...bp,
    } as unknown as CampaignBlueprint,
    CHANNELS,
  );

const typesIn = (r: ReturnType<typeof buildFromBlueprint>) =>
  Object.values(r.graph?.nodes ?? {}).reduce<Record<string, number>>(
    (a, n) => ((a[n.type] = (a[n.type] ?? 0) + 1), a),
    {},
  );
const rootType = (r: ReturnType<typeof buildFromBlueprint>) => r.graph?.nodes[r.graph.rootId!]?.type;
const said = (r: ReturnType<typeof buildFromBlueprint>, re: RegExp) => r.issues.some((i) => re.test(i.problem));

const send = (name: string, stage?: string) => ({
  kind: 'send',
  name,
  label: name,
  objective: ['emi'],
  ...(stage ? { stage } : {}),
  describe: 'd',
  copy: 'Split this purchase into EMI.',
  channelPreference: ['WHATSAPP'],
  barrier: 'no-identified-reason',
});

describe('the live turn that lost a whole campaign to two names', () => {
  const live = () => build({ entry: LIVE.entry as never, steps: LIVE.steps });

  it('builds all five messages, under the default entry, on a real ticket split', () => {
    const r = live();
    expect(typesIn(r).SEND, 'five designed, five on the canvas — was zero').toBe(5);
    expect(typesIn(r).DECISION_SPLIT).toBe(1);

    // The entry is the application's own, not a guess at what they meant.
    expect(rootType(r)).toBe('ENTRY_SEGMENT');
    expect(r.graph.nodes[r.graph.rootId!]?._config?.entity).toBe('Customer');
    expect(r.graph.rootId, 'steps attach to the entry, so there has to be a root').not.toBeNull();

    const split = Object.values(r.graph.nodes).find((n) => n.type === 'DECISION_SPLIT');
    expect(split?._config?.attribute, '"Amount" resolved on the entity they named').toBe('Transaction Amount');
    expect(split?._config?.source).toBe('Transaction attribute');
  });

  it('reports both misses, and `ok` stays false', () => {
    const r = live();
    expect(said(r, /"Transaction Events \/ Purchase Posted" is not a real event/)).toBe(true);
    expect(said(r, /every eligible customer instead/), 'and says what stood in for it').toBe(true);
    expect(said(r, /"Amount" was read as "Transaction Amount"/)).toBe(true);
    // The canvas exists and the export is not clean. That is the stage
    // default's bargain: Confirm can still show.
    expect(r.ok).toBe(false);
  });

  it('does not plant the invented trigger anywhere on the graph', () => {
    // Not a fake ENTRY_EVENT named "Purchase Posted", and not mapped onto
    // `Transaction` because the campaign happens to be post-purchase.
    expect(JSON.stringify(live().graph)).not.toMatch(/Purchase Posted/);
    expect(Object.values(live().graph.nodes).some((n) => n.type === 'ENTRY_EVENT')).toBe(false);
  });

  it('and the plan FILES, which is the point of the slice', () => {
    const brief = structuredClone(LIVE.brief);
    expect(decide(brief).blocks, 'the record was finished on this turn').toEqual([]);
    expect(turnPhase(brief, {})).toBe('ready');
    const barrier = (brief.barriers ?? [])[0]!.id;
    const out = applyOutputTool(brief, 'propose_strategy', {
      summary: 'Nudge every eligible purchase inside the window, split by ticket size.',
      approach: ['Enter on the eligible purchase.'],
      assumptions: [],
      unknowns: [],
      architectures: [
        { name: 'Immediate per-purchase nudge', barrier, audience: 'Every eligible purchase', timing: 'Within the hour', lever: 'timing', journey: 'linear', chosen: true },
        { name: 'Statement-cycle digest', barrier, audience: 'Every eligible purchase', timing: 'At statement', lever: 'message', journey: 'linear' },
      ],
      touches: [
        { day: 0, channel: 'WHATSAPP', path: 'Above ₹10,000', purpose: 'Name the purchase', ifStillUnconverted: 'Unread after a day, repeat on SMS; read and no action, change the argument' },
        { day: 3, channel: 'WHATSAPP', path: 'Above ₹10,000', purpose: 'Reminder', ifStillUnconverted: 'Unread after a day, repeat on SMS; read and no action, change the argument' },
        { day: 0, channel: 'WHATSAPP', path: '₹10,000 or below', purpose: 'Name the purchase', ifStillUnconverted: 'Unread after a day, repeat on SMS; read and no action, change the argument' },
        { day: 3, channel: 'WHATSAPP', path: '₹10,000 or below', purpose: 'Explain the mechanic', ifStillUnconverted: 'Unread after a day, repeat on SMS; read and no action, change the argument' },
      ],
      blueprint: { campaignName: 'EMI on eligible purchases', description: 'Prompt conversion inside the window.', goal: null, entry: LIVE.entry, steps: LIVE.steps },
    } as never);
    expect(out.error ?? null, 'refused twice live, over names').toBeNull();
    expect(out.brief.lastProposal, 'so there is something to Confirm').toBeTruthy();
  });
});

describe('the manager is told what the canvas will say, before they approve', () => {
  /**
   * THE LEFTOVER, and it is a reporting defect rather than a compile one.
   *
   * The Plan preview draws the filed JSON — `Purchase Posted`, `Amount` —
   * because `src/designer/preview.ts` cannot import the compiler. The RESOLVED
   * graph only appears once Confirm compiles. So the compiler's own direction
   * sat on `dry.issues`, which nobody reads at propose time, and the tool
   * result said "Plan recorded." A manager approving that is approving a
   * picture that is not yet the canvas.
   */
  const brief = () => structuredClone(LIVE.brief);
  const propose = (entry: unknown, steps: unknown[]) => {
    const barrier = (LIVE.brief.barriers ?? [])[0]!.id;
    const t = (p: string, day: number, purpose: string) => ({
      day,
      channel: 'WHATSAPP',
      path: p,
      purpose,
      ifStillUnconverted: 'Unread, repeat on SMS; read and no action, change the argument',
    });
    return applyOutputTool(brief(), 'propose_strategy', {
      summary: 'Nudge every eligible purchase inside the window, split by ticket size.',
      approach: ['Enter on the eligible purchase.'],
      assumptions: [],
      unknowns: [],
      architectures: [
        { name: 'Immediate nudge', barrier, audience: 'All', timing: 'Now', lever: 'timing', journey: 'linear', chosen: true },
        { name: 'Statement digest', barrier, audience: 'All', timing: 'Later', lever: 'message', journey: 'linear' },
      ],
      touches: [t('Above ₹10,000', 0, 'Name it'), t('Above ₹10,000', 3, 'Remind'), t('₹10,000 or below', 0, 'Name it'), t('₹10,000 or below', 3, 'Explain')],
      blueprint: { campaignName: 'EMI', description: 'Prompt conversion inside the window.', goal: null, entry, steps },
    } as never);
  };

  it('both substitutions become open items the strategy bubble prints', async () => {
    const out = propose(LIVE.entry, LIVE.steps);
    expect(out.error ?? null).toBeNull();
    const items = (out.openItems ?? []) as { kind?: string; question?: string; ifUnanswered?: string }[];
    const subs = items.filter((i) => i.kind === 'optional-preference');
    expect(subs.length, 'the stand-in entry and the resolved attribute').toBe(2);

    // THROUGH THE REAL RENDERER, because the fields `renderStrategy` reads are
    // the only ones that reach a manager. A first version of this used a
    // `default` key, which that function never looks at — the line would have
    // been dropped and this test would have passed on `question` alone.
    const { renderStrategy } = await import('../../server/orchestrator');
    const bubble = renderStrategy(out.strategy as never, out.openItems as never);
    expect(bubble).toContain('**Defaults applied**');
    expect(bubble).toMatch(/"Transaction Events \/ Purchase Posted" is not a real event/);
    expect(bubble, 'and what stood in for it').toMatch(/starts from every eligible customer/);
    expect(bubble, 'and the way to provide the real one').toMatch(/Name the real trigger to change it/);
    expect(bubble).toMatch(/"Amount" was read as "Transaction Amount"/);
    // The known-event list is the direction: it is how they name a real one.
    expect(bubble).toMatch(/EMI_STATUS_CHANGED/);
  });

  it('the tool result tells the model to say it, rather than only "Plan recorded"', () => {
    const out = propose(LIVE.entry, LIVE.steps);
    expect(out.ok).toMatch(/Plan recorded/);
    expect(out.ok).toMatch(/Tell them what the canvas will actually say/);
    expect(out.ok, 'the stand-in asks for the trigger').toMatch(/Ask them for the real trigger/);
  });

  it('and a plan whose names are all real says none of this', () => {
    // It must not fire on every proposal, or it is noise next to the button.
    const out = propose({ kind: 'event', eventCategory: 'Transaction Events', eventType: 'Transaction' }, [
      {
        kind: 'branch',
        label: 'Split',
        on: { entity: 'Transaction', attribute: 'Transaction Amount', operator: 'Equals', value: '10000' },
        paths: [
          { label: 'High', steps: [send('h1', 'first-touch'), send('h2', 'reminder')] },
          { label: 'Low', steps: [send('l1', 'first-touch'), send('l2', 'reminder')] },
        ],
      },
    ]);
    expect(out.error ?? null).toBeNull();
    expect(((out.openItems ?? []) as { kind?: string }[]).filter((i) => i.kind === 'optional-preference')).toHaveLength(0);
    expect(out.ok).not.toMatch(/Tell them what the canvas/);
  });

  it('the filed path keeps the names as written, so Confirm resolves the same object', () => {
    const out = propose(LIVE.entry, LIVE.steps);
    const filed = out.brief.lastProposal!.blueprint as { entry: { eventType?: string }; steps: unknown[] };
    expect(filed.entry.eventType, 'the JSON is never rewritten').toBe('Purchase Posted');
    expect(JSON.stringify(filed.steps)).toMatch(/"attribute":\s*"Amount"/);
    // And compiling it again gives the resolved graph, not a second reading.
    const again = build({ entry: filed.entry as never, steps: filed.steps });
    expect(Object.values(again.graph.nodes).find((n) => n.type === 'DECISION_SPLIT')?._config?.attribute).toBe(
      'Transaction Amount',
    );
  });
});

describe('resolution is unique-only, against the catalogue the lookups read', () => {
  const splitOn = (entity: string, attribute: string) => ({
    kind: 'branch',
    label: 'Split',
    on: { entity, attribute, operator: 'Equals', value: '10000' },
    paths: [
      { label: 'A', steps: [send('a', 'first-touch')] },
      { label: 'B', steps: [send('b', 'first-touch')] },
    ],
  });

  it('`Amount` on Transaction is the only amount field, so it maps', () => {
    const r = build({ steps: [splitOn('Transaction', 'Amount')] });
    const split = Object.values(r.graph.nodes).find((n) => n.type === 'DECISION_SPLIT');
    expect(split?._config?.attribute).toBe('Transaction Amount');
    expect(said(r, /"Amount" was read as "Transaction Amount"/)).toBe(true);
    expect(typesIn(r).SEND).toBe(2);
  });

  it('`Status` on Transaction maps; on Customer it does NOT, because two fields match', () => {
    const txn = build({ steps: [splitOn('Transaction', 'Status')] });
    expect(Object.values(txn.graph.nodes).find((n) => n.type === 'DECISION_SPLIT')?._config?.attribute).toBe(
      'Transaction Status',
    );

    // Customer has `KYC Status` AND `FKYC Status`. Picking one would silently
    // build a different audience, so neither is picked.
    const cust = build({ steps: [splitOn('Customer', 'Status')] });
    expect(said(cust, /has no attribute "Status"/)).toBe(true);
    expect(said(cust, /was read as/), 'and nothing is reported as mapped').toBe(false);
    expect(Object.values(cust.graph.nodes).some((n) => n.type === 'DECISION_SPLIT')).toBe(false);
  });

  it('an attribute with no entity resolves nothing — there is no table to search', () => {
    const r = build({ steps: [{ ...splitOn('', 'Status'), on: { attribute: 'Status', operator: 'Equals', value: 'x' } }] as never });
    expect(said(r, /was read as/)).toBe(false);
    expect(Object.values(r.graph.nodes).some((n) => n.type === 'DECISION_SPLIT')).toBe(false);
  });

  it('exact names still compile with no resolve issue at all', () => {
    const r = build({
      goal: { eventCategory: 'EMI Events', eventType: 'EMI_STATUS_CHANGED', conditions: [] } as never,
      steps: [splitOn('Transaction', 'Transaction Amount')],
    });
    expect(said(r, /was read as/), 'nothing was renamed, so nothing is reported').toBe(false);
    expect(said(r, /is not a real event/)).toBe(false);
    expect(r.goal?.eventType).toBe('EMI_STATUS_CHANGED');
    expect(Object.values(r.graph.nodes).find((n) => n.type === 'DECISION_SPLIT')?._config?.attribute).toBe(
      'Transaction Amount',
    );
  });

  it('an invented EMI conversion event maps to the one real EMI event, on a wait and on a goal', () => {
    const r = build({
      steps: [
        send('open', 'first-touch'),
        { kind: 'waitForEvent', eventCategory: 'EMI Events', eventType: 'EMI Conversion Completed', timeoutDays: 7, conditions: [] },
      ],
    });
    expect(said(r, /was read as "EMI Events \/ EMI_STATUS_CHANGED"/)).toBe(true);
    expect(typesIn(r).WAIT_UNTIL, 'the wait is on the canvas').toBe(1);
    expect(typesIn(r).SEND).toBe(1);
    // NOT asserted here: that a send AFTER the wait attaches. A WAIT_UNTIL
    // auto-inserts its own Yes/No fork, so a trailing sibling genuinely has
    // more than one arm it could continue from — pre-existing behaviour, the
    // same rule as a send after a branch, and out of this slice.

    const g = build({
      goal: { eventCategory: 'EMI Events', eventType: 'EMI Conversion Completed', conditions: [] } as never,
      steps: [send('open', 'first-touch')],
    });
    expect(said(g, /was read as "EMI Events \/ EMI_STATUS_CHANGED"/)).toBe(true);
    expect(g.goal?.eventType, 'resolved, then attached').toBe('EMI_STATUS_CHANGED');
  });

  it('but `Purchase Posted` maps to nothing, even though its category holds one event', () => {
    // THE GUARD THAT MATTERS. Transaction Events holds only `Transaction`, so
    // matching on the written CATEGORY would turn any junk under it into a
    // purchase trigger. Offer Events holding only `Outcome Issuance` is the
    // same trap. The distinctive tokens come from the TYPE.
    const r = build({ entry: LIVE.entry as never, steps: [send('one', 'first-touch')] });
    expect(said(r, /is not a real event/)).toBe(true);
    expect(said(r, /was read as/)).toBe(false);
    expect(rootType(r)).toBe('ENTRY_SEGMENT');

    const offer = build({
      entry: { kind: 'event', eventCategory: 'Offer Events', eventType: 'Coupon Redeemed Somewhere' } as never,
      steps: [send('one', 'first-touch')],
    });
    expect(said(offer, /was read as/)).toBe(false);
    expect(rootType(offer)).toBe('ENTRY_SEGMENT');
  });

  it('an unknown ENTITY on an audience entry gets the same stand-in, then the steps', () => {
    const r = build({
      entry: { kind: 'audience', entity: 'Cardholder', conditions: [] } as never,
      steps: [send('one', 'first-touch'), send('two', 'reminder')],
    });
    expect(said(r, /"Cardholder" is not a real entity/)).toBe(true);
    expect(rootType(r)).toBe('ENTRY_SEGMENT');
    expect(r.graph.nodes[r.graph.rootId!]?._config?.entity).toBe('Customer');
    expect(typesIn(r).SEND).toBe(2);
  });
});

describe('an unresolved name still cannot become a split', () => {
  it('`Nonexistent Attr` builds no fork, so sends that lived only on its arms are lost', () => {
    const r = build({
      steps: [
        {
          kind: 'branch',
          label: 'Split',
          on: { entity: 'Transaction', attribute: 'Nonexistent Attr', operator: 'Equals', value: '1' },
          paths: [
            { label: 'A', steps: [send('a', 'first-touch')] },
            { label: 'B', steps: [send('b', 'first-touch')] },
          ],
        },
      ],
    });
    expect(said(r, /Transaction has no attribute "Nonexistent Attr"/)).toBe(true);
    expect(said(r, /was read as/)).toBe(false);
    expect(Object.values(r.graph.nodes).some((n) => n.type === 'DECISION_SPLIT')).toBe(false);
    expect(typesIn(r).SEND ?? 0, 'there is no field to point a node at').toBe(0);
  });

  it('and `propose_strategy` refuses it quoting the compiler, with no blanket nest instruction', () => {
    const brief = structuredClone(LIVE.brief);
    const barrier = (brief.barriers ?? [])[0]!.id;
    const plan = (steps: unknown[]) => ({
      summary: 'Nudge every eligible purchase inside the window.',
      approach: ['Enter on the eligible purchase.'],
      assumptions: [],
      unknowns: [],
      architectures: [
        { name: 'Immediate nudge', barrier, audience: 'All', timing: 'Now', lever: 'timing', journey: 'linear', chosen: true },
        { name: 'Statement digest', barrier, audience: 'All', timing: 'Later', lever: 'message', journey: 'linear' },
      ],
      touches: [
        { day: 0, channel: 'WHATSAPP', path: 'all', purpose: 'Name it', ifStillUnconverted: 'Unread, repeat on SMS; read and no action, change the argument' },
        { day: 3, channel: 'WHATSAPP', path: 'all', purpose: 'Remind', ifStillUnconverted: 'Unread, repeat on SMS; read and no action, change the argument' },
      ],
      blueprint: { campaignName: 'EMI', description: 'Prompt conversion inside the window.', goal: null, entry: { kind: 'audience', entity: 'Customer', conditions: [] }, steps },
    });
    const out = applyOutputTool(brief, 'propose_strategy', plan([
      {
        kind: 'branch',
        label: 'Split',
        on: { entity: 'Transaction', attribute: 'Nonexistent Attr', operator: 'Equals', value: '1' },
        paths: [
          { label: 'A', steps: [send('a', 'first-touch')] },
          { label: 'B', steps: [send('b', 'first-touch')] },
        ],
      },
    ]) as never);
    expect(out.error).toMatch(/has 2 messages in it and none of them reached the journey/i);
    expect(out.error).toMatch(/Transaction has no attribute "Nonexistent Attr"/);
    // THE SENTENCE THAT WAS A LIE TWICE. The sends are nested on the arms
    // already; the fork was dropped over the name.
    expect(out.error).not.toMatch(/nest/i);
    expect(out.brief.lastProposal ?? null).toBeNull();
  });
});

describe('a nameless check is skipped and costs nothing around it', () => {
  it('keeps every message on an arm when a "Check conversion" sits between them', () => {
    // THE CURSOR BUG, and it is what held the live canvas to two of five
    // sends. A skipped step used to reset the chain's position, so the next
    // send fell back to a whole-graph search, saw the sibling arm's slots and
    // was reported ambiguous. A skip is not a move.
    const r = build({
      steps: [
        {
          kind: 'branch',
          label: 'Split',
          on: { entity: 'Transaction', attribute: 'Amount', operator: 'Equals', value: '10000' },
          paths: [
            { label: 'High', steps: [send('h1', 'first-touch'), { kind: 'condition', label: 'Check conversion' }, send('h2', 'reminder')] },
            { label: 'Low', steps: [send('l1', 'first-touch')] },
          ],
        },
      ],
    });
    expect(typesIn(r).SEND).toBe(3);
    expect(said(r, /names nothing to check/)).toBe(true);
    expect(said(r, /the continuation is ambiguous/), 'nothing is ambiguous inside one arm').toBe(false);
  });

  it('invents no event for it, and no SPLIT', () => {
    const r = build({ steps: [send('one', 'first-touch'), { kind: 'condition', label: 'Check conversion' }] });
    expect(JSON.stringify(r.graph)).not.toMatch(/EMI_STATUS_CHANGED/);
    expect(Object.values(r.graph.nodes).some((n) => n.type === 'SPLIT')).toBe(false);
  });

  it('an unresolvable waitForEvent is skipped, and the messages around it still attach', () => {
    const r = build({
      steps: [
        send('one', 'first-touch'),
        { kind: 'waitForEvent', eventCategory: 'Transaction Events', eventType: 'Purchase Posted', timeoutDays: 3, conditions: [] },
        send('two', 'reminder'),
      ],
    });
    expect(said(r, /is not a real event, so this wait is not on the canvas/)).toBe(true);
    expect(typesIn(r).WAIT_UNTIL ?? 0).toBe(0);
    expect(typesIn(r).SEND, 'the messages around it still are').toBe(2);
  });
});

describe('what this does NOT weaken', () => {
  const brief = () => structuredClone(LIVE.brief);
  const envelope = (steps: unknown[]) => {
    const barrier = (LIVE.brief.barriers ?? [])[0]!.id;
    return {
      summary: 'Nudge every eligible purchase inside the window.',
      approach: ['Enter on the eligible purchase.'],
      assumptions: [],
      unknowns: [],
      architectures: [
        { name: 'Immediate nudge', barrier, audience: 'All', timing: 'Now', lever: 'timing', journey: 'linear', chosen: true },
        { name: 'Statement digest', barrier, audience: 'All', timing: 'Later', lever: 'message', journey: 'linear' },
      ],
      touches: [
        { day: 0, channel: 'WHATSAPP', path: 'all', purpose: 'Name it', ifStillUnconverted: 'Unread, repeat on SMS; read and no action, change the argument' },
        { day: 3, channel: 'WHATSAPP', path: 'all', purpose: 'Remind', ifStillUnconverted: 'Unread, repeat on SMS; read and no action, change the argument' },
      ],
      blueprint: { campaignName: 'EMI', description: 'Prompt conversion inside the window.', goal: null, entry: { kind: 'audience', entity: 'Customer', conditions: [] }, steps },
    };
  };

  it('a waits-only path still refuses', () => {
    const out = applyOutputTool(brief(), 'propose_strategy', envelope([
      { kind: 'wait', durationHours: 48 },
      { kind: 'exit', reason: 'Window closed.' },
    ]) as never);
    expect(out.error).toMatch(/compiles to no messages/i);
    expect(out.brief.lastProposal ?? null).toBeNull();
  });

  it('a mixed 3-written / 2-built path still refuses, and still does not file', () => {
    const out = applyOutputTool(brief(), 'propose_strategy', envelope([
      {
        kind: 'branch',
        label: 'Split',
        on: { entity: 'Transaction', attribute: 'Amount', operator: 'Equals', value: '10000' },
        paths: [
          { label: 'High', steps: [send('h1', 'first-touch')] },
          { label: 'Low', steps: [send('l1', 'first-touch')] },
        ],
      },
      // The trailing sibling: no single arm to continue from.
      send('shared last chance', 'reminder'),
    ]) as never);
    expect(out.error).toMatch(/has 3 messages in it and only 2 reached the journey/i);
    // HERE the compiler really did say it, so the instruction is its own.
    expect(out.error).toMatch(/Nest it inside the arm it belongs to/i);
    expect(out.brief.lastProposal ?? null).toBeNull();
  });

  it('and the trailing sibling is still not attached to an arbitrary arm', () => {
    const r = build({
      steps: [
        {
          kind: 'branch',
          label: 'Split',
          on: { entity: 'Transaction', attribute: 'Amount', operator: 'Equals', value: '10000' },
          paths: [
            { label: 'High', steps: [send('h1', 'first-touch')] },
            { label: 'Low', steps: [send('l1', 'first-touch')] },
          ],
        },
        send('shared last chance', 'reminder'),
      ],
    });
    expect(typesIn(r).SEND, 'two, not three, and not fanned onto both arms').toBe(2);
    expect(said(r, /Nest it inside the arm it belongs to/)).toBe(true);
  });

  it('the same sends nested on the arms file, as they always did', () => {
    const out = applyOutputTool(brief(), 'propose_strategy', envelope([
      {
        kind: 'branch',
        label: 'Split',
        on: { entity: 'Transaction', attribute: 'Amount', operator: 'Equals', value: '10000' },
        paths: [
          { label: 'High', steps: [send('h1', 'first-touch'), send('h2', 'reminder')] },
          { label: 'Low', steps: [send('l1', 'first-touch'), send('l2', 'reminder')] },
        ],
      },
    ]) as never);
    expect(out.error ?? null).toBeNull();
    expect(out.brief.lastProposal).toBeTruthy();
  });
});
