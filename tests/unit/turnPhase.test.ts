// ONE FACT ABOUT THE TURN, and every reader takes it.
//
// WHAT THIS REPLACES. Seven places behaved differently on a discovery turn, a
// propose turn and a build turn, and each worked the answer out for itself:
//
//  - `systemForPhase(isBuildTurn, journeyAllowed)` — two booleans, four
//    states, one of which cannot exist.
//  - `toolsForPhase(isBuildTurn || journeyAllowed() || designSeen)`.
//  - `outputToolsForPhase(isBuildTurn, journeyAllowed())`.
//  - `applyOutputTool`, which asked `decide(brief)` with NO escape at all.
//  - the "do not go back to discovery" wrapper, keyed on a regex over our own
//    refusal text.
//  - two `decide(...)` calls passing only `saysProceed(latestUserText)`.
//
// The inputs diverged, and the divergence was the live wall: a manager typing
// "go ahead" on a thin record got a turn where `propose_strategy` DID carry
// `blueprint` (the schema reads `limitReached`, which folds the typed escape)
// and where the handler refused the payload for arriving on an unfinished
// record (it read the brief, which cannot see a typed escape). Five identical
// errors, then the plan dumped into the chat for the manager to approve by
// hand — `eval/runs/ui-s-1792834072700` turn 3.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { turnPhase, decide, MAX_ROUNDS } from '../../server/gate';
import { newBrief, recordAnswer, recordBarriers, recordConverters, recordDimensions, recordSuccessCriteria } from '../../server/discovery';
import { outputToolsForPhase, applyOutputTool } from '../../server/outputTools';
import { toolsForPhase } from '../../server/agentTools';

const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');

/** A record the gate is satisfied by: findings, success, three reasoned axes. */
const settled = () => {
  let b = recordAnswer(
    newBrief('Get more eligible purchases converted to EMI'),
    'purchases above 10,000 convert more, they do not realise it qualifies, and we do not track category',
  );
  b = recordBarriers(b, [
    { id: 'awareness', statement: 'They do not realise it qualifies.', basis: 'user-belief', lever: 'message', quote: 'they do not realise it qualifies' },
  ]);
  b = recordConverters(b, { shape: 'Purchases above ₹10,000 convert more often.', basis: 'user', knowledge: 'known' });
  b = recordDimensions(b, [
    { name: 'purchase ticket size', rationale: 'They said bigger ones convert.', status: 'retained', basis: 'user', note: 'Theirs.' },
    { name: 'merchant category', rationale: 'Asked about it.', status: 'unavailable', basis: 'user', note: 'They do not track it.' },
    { name: 'channel preference', rationale: 'Where to reach them.', status: 'unavailable', basis: 'none', note: 'No per-customer history.' },
  ]);
  return recordSuccessCriteria(b, ['More eligible purchases converted before they lapse.']);
};

/** Someone has said one thing and nothing is established. */
const thin = () => recordAnswer(newBrief('Get more eligible purchases converted'), 'ok');

describe('turnPhase is the one answer', () => {
  it('is build whenever the turn builds, whatever the record says', () => {
    // The plan is already approved. A thin record cannot un-approve it, and
    // refusing here would leave them with an approval that did nothing.
    expect(turnPhase(thin(), { isBuildTurn: true, limitReached: false })).toBe('build');
    expect(turnPhase(settled(), { isBuildTurn: true, limitReached: false })).toBe('build');
  });

  it('is asking while the record is unfinished', () => {
    expect(turnPhase(thin(), { isBuildTurn: false, limitReached: false })).toBe('asking');
    expect(decide(thin()).proceed).toBe(false);
  });

  it('is ready once the record supports a plan', () => {
    expect(turnPhase(settled(), { isBuildTurn: false, limitReached: false })).toBe('ready');
  });

  it('A THIN BRIEF PLUS AN ESCAPE IS READY, which is the whole divergence', () => {
    // `limitReached` is the union the orchestrator already computes: the
    // round budget, the Skip & propose button, and `saysProceed` on their
    // latest message. Any reader using a narrower one is a second escape set,
    // and the gap between two of them is where a refusal outlives the
    // instruction to stop refusing.
    expect(turnPhase(thin(), { isBuildTurn: false, limitReached: true })).toBe('ready');
    // Including the budget escape, read off the record rather than the turn.
    const spent = { ...thin(), rounds: MAX_ROUNDS };
    expect(turnPhase(spent, { isBuildTurn: false, limitReached: false })).toBe('ready');
  });
});

describe('every reader is keyed off it', () => {
  it('the tool list: one plan tool per phase, and none on an asking turn', () => {
    // REWRITTEN with the phase it reads. `propose_strategy` used to travel on
    // an asking turn with `blueprint` stripped so the gate could refuse it.
    // Two live conversations show what offering-to-refuse teaches: the model
    // resubmits, then asks the manager to approve the plan by hand.
    expect(outputToolsForPhase('asking').map((t) => t.name)).toEqual([
      'ask_questions',
      'record_findings',
      'record_dimensions',
      'request_evidence',
    ]);
    const ready = outputToolsForPhase('ready').find((t) => t.name === 'propose_strategy')!;
    expect(ready.input_schema.properties.blueprint).toBeDefined();
    expect(outputToolsForPhase('build').map((t) => t.name)).toContain('build_campaign');
    expect(outputToolsForPhase('build').map((t) => t.name)).not.toContain('propose_strategy');
  });

  it('the lookups: asking gets none, every other turn gets all five', () => {
    expect(toolsForPhase(false)).toEqual([]);
    expect(toolsForPhase(true)).toHaveLength(5);
    expect(orch).toMatch(/toolsForPhase\(phase !== 'asking' \|\| designSeen\)/);
  });

  it('the handler: no phase argument, because the tool list already decided', () => {
    // THE LEFTOVER THIS CLOSES, and it closed from the other end. The handler
    // read `decide(brief)` — which could not see a manager typing "go ahead"
    // — then took the phase as an argument, then stopped needing one: a turn
    // that may not propose does not carry the tool. An escaped turn (budget,
    // Skip & propose, a typed "go ahead") is `ready`, so the schema carries
    // the path and the handler judges only the payload.
    expect(turnPhase(thin(), { isBuildTurn: false, limitReached: true })).toBe('ready');
    const src = readFileSync(new URL('../../server/outputTools.ts', import.meta.url), 'utf8');
    // The TOOL LIST still takes a phase — that is where the decision lives.
    // The HANDLER does not, and there is no asking-turn branch left in it.
    expect(src).toMatch(/export const outputToolsForPhase = \(phase: TurnPhase\)/);
    expect(src).toMatch(
      /export function applyOutputTool\(brief: WorkingBrief, name: string, input: unknown\): ApplyResult \{/,
    );
    expect(src).not.toMatch(/if \(phase === 'asking'\)/);
    // A payload refused on a ready turn is refused for what it contains, and
    // the record's own live blocks travel with the message rather than a
    // shorter list written here.
    const out = applyOutputTool(thin(), 'propose_strategy', { summary: 'A plan.' } as never);
    expect(out.error).not.toMatch(/Discovery is not finished/);
    expect(out.error).toMatch(/Still on the record:/);
  });

  it('the wrapper: keyed on the phase, not on the wording of our own refusal', () => {
      // MOVED INTO `toolResultBlock`, which both the round loop and the
      // forced propose call. The expression used to be written out at each
      // site, and the forced one carried no correction at all for a while.
    expect(orch).toMatch(/tool === 'propose_strategy' && phase !== 'asking'/);
  });

  it('one computation per model round, not one per reader', () => {
    expect(orch).toMatch(/const phaseNow = \(\): TurnPhase => turnPhase\(brief, \{ isBuildTurn, limitReached \}\);/);
    expect(orch).toMatch(/const phase: TurnPhase = phaseNow\(\);/);
    // PER ROUND, NOT PER TURN. Round one may file the last finding the record
    // needed; round two of the same turn is then genuinely ready. A value
    // frozen at the start of the turn would file success and hold the asking
    // schema for the rest of it, which is a one-round-late loop.
    const loop = orch.slice(orch.indexOf('for (let round = 0; round < MAX_TOOL_ROUNDS'));
    expect(loop.indexOf('const phase: TurnPhase = phaseNow();')).toBeGreaterThan(-1);
  });

  it('the two decide() calls adopt the same union', () => {
    // They passed `saysProceed(latestUserText)` alone, so the turn's own gate
    // could not see the round budget or the button while the schema could.
    // `evaluateDiscovery` below them already took `limitReached` as `forced`,
    // which is how the divergence stayed invisible.
    expect(orch).not.toMatch(/proceedRequested: saysProceed\(latestUserText\)/);
    expect(orch).toMatch(/const gateNow = decide\(brief, \{ proceedRequested: limitReached \}\);/);
  });
});
