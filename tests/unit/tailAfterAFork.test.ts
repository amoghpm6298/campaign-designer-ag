// The tail after a fork is the rest of one path, and fan-out is a join.
//
// MEASURED, `eval/runs/ui-s-1793613837789` turn 4. The agent filed the shape
// this product is for: a first send, a read/not-read fork with a reminder on
// each arm, then a wait and a last reminder AFTER the fork. The compiler had
// nowhere to attach that tail — several arms are open — so it dropped it,
// `propose_strategy` recounted 4 written against 3 built and refused, and the
// manager got an empty canvas twice running.
//
// It is not a mistake. Everyone who is still in the journey gets that last
// reminder, whichever arm they took. So the tail is COPIED onto the arms that
// are still open: the written count and the built count are allowed to
// differ, because nobody receives two of them.
//
// What this does NOT change: a path with no messages still refuses, a trailing
// exit is still skipped, another fork after a fork is still left where it was,
// and the recount still files when FEWER sends are built than were written.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildFromBlueprint } from '../../server/blueprint';
import { longestSendPath } from '../../server/journeySummary';
import { applyOutputTool } from '../../server/outputTools';
import { sendSteps } from '../../server/pathReading';

/** The live turn-4 steps, copied out of the run — `eval/runs/` is gitignored. */
const LIVE_PATH = JSON.parse(
  readFileSync(new URL('./support/liveBriefs/ui-s-1793613837789.turn-4.path.json', import.meta.url), 'utf8'),
) as unknown[];

/** A settled brief and an accepted plan, from another recorded run. */
const SETTLED = JSON.parse(
  readFileSync(new URL('./support/liveBriefs/ui-s-1793077922155.turn-3.paths.json', import.meta.url), 'utf8'),
) as { brief: { lastProposal?: { strategy: Record<string, unknown> } } };

const CHANNELS = ['WHATSAPP', 'SMS', 'EMAIL'];

const pathAs = (steps: unknown[]) => ({
  campaignName: 'Reactivate dormant cardholders',
  description: 'Get dormant cardholders transacting again.',
  goal: null,
  entry: { kind: 'audience', entity: 'Card', conditions: [] },
  steps,
});

const build = (steps: unknown[]) => buildFromBlueprint(pathAs(steps) as never, CHANNELS);

type Node = { id: string; type: string; label?: string };
const compiled = (steps: unknown[]) => {
  const r = build(steps);
  const nodes = Object.values(r.graph.nodes) as Node[];
  return {
    ...r,
    sends: nodes.filter((n) => n.type === 'SEND'),
    openSlots: r.graph.edges.filter((e) => e.to === null).length,
    lost: r.issues.filter((i) => /was not added to the journey/.test(i.problem)),
  };
};

/** Every SEND label reachable from one edge, which is how an arm is read. */
const sendsUnder = (graph: { nodes: Record<string, Node>; edges: { from: string; to: string | null }[] }, from: string) => {
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const n = graph.nodes[id];
    if (n?.type === 'SEND') out.push(n.label ?? '');
    graph.edges.filter((e) => e.from === id && e.to).forEach((e) => walk(e.to as string));
  };
  walk(from);
  return out;
};

const send = (name: string, stage = 'reminder') => ({
  kind: 'send',
  name,
  objective: ['emi'],
  stage,
  describe: 'd',
  copy: 'One small spend keeps the card active.',
  channelPreference: ['WHATSAPP'],
  barrier: 'reason-unknown',
});

describe('the live turn-4 path reaches the canvas whole', () => {
  it('builds every message the plan wrote, with the tail on both arms', () => {
    const r = compiled(LIVE_PATH);
    // FOUR WRITTEN, FIVE BUILT: the first send, a reminder on each arm, and
    // the last reminder twice. Deliberately not pinned at four — the written
    // count is what `sendSteps` reads, and it is unchanged.
    expect(sendSteps(LIVE_PATH as never)).toBe(4);
    expect(r.sends).toHaveLength(5);
    expect(r.lost, 'nothing was dropped').toHaveLength(0);
    expect(r.openSlots, 'every path is closed').toBe(0);
  });

  it('both arms of the read fork carry the last reminder', () => {
    const r = build(LIVE_PATH);
    const fork = Object.values(r.graph.nodes).find((n) => (n as { type: string }).type === 'DECISION_SPLIT') as Node;
    const arms = r.graph.edges.filter((e) => e.from === fork.id && e.to);
    // Three edges leave the split: the two the plan named, plus the reducer's
    // own catch-all. The catch-all is never recursed into, so it is not an arm
    // that can receive a copy.
    const named = arms.filter((e) => /not read|read/i.test(e.branchLabel ?? ''));
    expect(named.length).toBe(2);
    for (const arm of named) {
      const labels = sendsUnder(r.graph as never, arm.to as string);
      expect(labels, `arm "${arm.branchLabel}"`).toContain('Final reminder before close');
    }
  });

  it('and one person still receives three messages', () => {
    // The copy is a join, not a dose. Longest route through the graph: the
    // opening send, this arm's reminder, the shared last reminder.
    expect(longestSendPath(build(LIVE_PATH).graph as never)).toBe(3);
  });

  it('says what it did, in the manager\'s terms', () => {
    const note = build(LIVE_PATH).limitations.find((l) => /comes after a fork/.test(l.note));
    expect(note?.note).toMatch(/Final reminder before close/);
    expect(note?.note).toMatch(/each of the 2 paths that were still open/);
    expect(note?.note).toMatch(/receives it once/);
  });

  it('so propose_strategy files it instead of refusing', () => {
    const brief = structuredClone(SETTLED.brief) as never;
    const out = applyOutputTool(brief, 'propose_strategy', {
      ...structuredClone(SETTLED.brief.lastProposal!.strategy),
      blueprint: pathAs(LIVE_PATH),
    } as never);
    expect(out.error ?? null, 'the live refusal is gone').toBeNull();
    // THIS turn's path, not the one the fixture brief arrived carrying — a
    // truthy `lastProposal` proves nothing on a brief that already had one.
    expect((out.brief.lastProposal as { blueprint: { steps: unknown[] } }).blueprint.steps).toEqual(LIVE_PATH);
    // THE PLAN ON FILE IS THE PLAN THEY SAW. Confirm compiles exactly this,
    // so the duplicate lives on the canvas and never in the approved plan —
    // no 3-message journey stashed against a 4-message plan.
    expect(sendSteps((out.brief.lastProposal as { blueprint: { steps: unknown[] } }).blueprint.steps as never)).toBe(4);
  });
});

describe('what the tail rule deliberately leaves alone', () => {
  it('a fork after a fork is not a tail', () => {
    const r = compiled([
      {
        kind: 'branch',
        on: { entity: 'Transaction', attribute: 'Transaction Amount', operator: 'Equals', value: '10000' },
        paths: [
          { label: 'High', steps: [send('h1', 'first-touch')] },
          { label: 'Low', steps: [send('l1', 'first-touch')] },
        ],
      },
      // A second decision, not the rest of one path. Left where it was.
      {
        kind: 'branch',
        on: { entity: 'Transaction', attribute: 'Transaction Amount', operator: 'Equals', value: '500' },
        paths: [{ label: 'Small', steps: [send('s1')] }, { label: 'Big', steps: [send('b1')] }],
      },
      // AND THE SEND BEHIND IT GOES WITH IT. This is the half that needed a
      // pin of its own: the fork breaks the tail, so a message after the fork
      // must not be copied onto the FIRST fork's arms across the gap. Without
      // the reset it was, which quietly reattached it two steps back.
      send('after both forks'),
    ]);
    expect(r.sends, 'only the two on the first fork').toHaveLength(2);
    expect(r.limitations.some((l) => /comes after a fork/.test(l.note))).toBe(false);
    expect(r.lost, 'and the message is still named as lost').toHaveLength(1);
    expect(r.lost[0].problem).toMatch(/after both forks/);
  });

  it('a step that was dropped for any other reason breaks the tail too', () => {
    // `waitForEvent` after a fork has no single arm either, so it is reported
    // and dropped exactly as before — and the send behind it is then no longer
    // the step after the fork. Same rule as the fork-after-a-fork case, from a
    // different cause, which is why the reset keys on the drop and not on the
    // kind.
    const r = compiled([
      {
        kind: 'branch',
        on: { entity: 'Transaction', attribute: 'Transaction Amount', operator: 'Equals', value: '10000' },
        paths: [
          { label: 'High', steps: [send('h1', 'first-touch')] },
          { label: 'Low', steps: [send('l1', 'first-touch')] },
        ],
      },
      { kind: 'waitForEvent', event: { category: 'Transaction Events', type: 'Transaction' }, timeoutHours: 48 },
      send('after the wait'),
    ]);
    expect(r.sends).toHaveLength(2);
    expect(r.limitations.some((l) => /comes after a fork/.test(l.note))).toBe(false);
    expect(r.lost[0]?.problem).toMatch(/after the wait/);
  });

  it('a trailing exit after a fork is still skipped silently', () => {
    const r = compiled([
      {
        kind: 'branch',
        on: { entity: 'Transaction', attribute: 'Transaction Amount', operator: 'Equals', value: '10000' },
        paths: [
          { label: 'High', steps: [send('h1', 'first-touch')] },
          { label: 'Low', steps: [send('l1', 'first-touch')] },
        ],
      },
      { kind: 'exit', reason: 'Window closed.' },
    ]);
    expect(r.sends).toHaveLength(2);
    expect(r.issues).toHaveLength(0);
    expect(r.limitations.some((l) => /comes after a fork/.test(l.note))).toBe(false);
  });

  it('an arm that ended deliberately gets no copy', () => {
    const r = build([
      {
        kind: 'branch',
        on: { entity: 'Transaction', attribute: 'Transaction Amount', operator: 'Equals', value: '10000' },
        paths: [
          { label: 'High', steps: [send('h1', 'first-touch')] },
          { label: 'Low', steps: [send('l1', 'first-touch'), { kind: 'exit', reason: 'Not worth another message.' }] },
        ],
      },
      send('shared last chance'),
    ]);
    const nodes = Object.values(r.graph.nodes) as Node[];
    expect(nodes.filter((n) => n.type === 'SEND' && n.label === 'shared last chance'), 'one copy, on the open arm').toHaveLength(1);
    const note = r.limitations.find((l) => /comes after a fork/.test(l.note));
    expect(note?.note).toMatch(/each of the 1 paths that were still open/);
  });

  it('a path with no messages in it still refuses', () => {
    const brief = structuredClone(SETTLED.brief) as never;
    const out = applyOutputTool(brief, 'propose_strategy', {
      ...structuredClone(SETTLED.brief.lastProposal!.strategy),
      blueprint: pathAs([{ kind: 'wait', delayDays: 2 }, { kind: 'exit', reason: 'Window closed.' }]),
    } as never);
    expect(out.error).toMatch(/compiles to no messages/i);
    // NOT STASHED. This brief arrives carrying the plan its own run filed, so
    // "nothing was filed" is that one surviving untouched rather than a null.
    expect(out.brief.lastProposal).toEqual(SETTLED.brief.lastProposal);
  });
});
