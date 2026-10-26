// ONE DEFINITION OF DONE, OWNED BY THE RECORD.
//
// MEASURED, `eval/runs/ui-s-1792839251135`. Three turns, and the manager did
// all of the work: success is the number of conversions, ₹10,000-plus
// purchases convert on their own, the barrier is that customers think it costs
// extra, and the extra-axis probe came back "not something we track". Every
// finding reached the brief. The run still ended in discovery with nothing on
// the canvas.
//
// What held it was bookkeeping. All four questions ended the run with
// `answeredInRound: 0` and `addressedInRound: undefined`:
//
//   - live ingest called `recordAnswer`, which sets the first field;
//   - `outstanding` and `decide` read the second;
//   - `recordReply` had always closed both, and nothing in production called
//     it;
//   - the tool-only exit (`!parsed.ok && recordedViaTools`) returned before the
//     one closer that did run on the parsed path.
//
// Two fields, two write-paths, and `awaiting-reply` on four answered
// questions. The turn therefore stayed `asking`, which still offered
// `propose_strategy` and then refused it, and the agent ended up putting the
// plan in the chat and asking the manager to type "go ahead".
//
// This file walks that conversation through the real ingest.
import { describe, it, expect } from 'vitest';
import { receive, recordReply, reopen, outstanding, recordAsked } from '../../server/record';
import {
  newBrief,
  noteClosedOtherAxes,
  noteOpeningFacts,
  recordBarriers,
  recordDimensions,
  recordSuccessCriteria,
  segmentationDimensions,
  seenAxes,
  briefDimensions,
  type WorkingBrief,
} from '../../server/discovery';
import { recordConverters } from '../../server/findings';
import { decide, turnPhase, otherAxesProbed } from '../../server/gate';
import { applyOutputTool, outputToolsForPhase } from '../../server/outputTools';

const OBJECTIVE = 'Customers are not converting eligible purchases to EMI. Get more of them converting.';

// The manager's three replies, verbatim from the run.
const TURN_1_REPLY = '1. number of conversions\n2. 10k+ txns convert more\n3. think its extra cost';
const TURN_2_PROBE_REPLY = '1. not something we track';

/** Turn 1: the agent asks, through the tool the asking phase actually has. */
const afterTheAgentAsked = (): WorkingBrief =>
  recordAsked(
    noteOpeningFacts(newBrief(OBJECTIVE), OBJECTIVE),
    [
      { text: 'When you say more purchases should become EMI, do you mean the largest number of conversions, or the value converted?', impact: 'fork' },
      { text: 'Have you seen a pattern in which purchases get converted today?', impact: 'shaping' },
      { text: 'What do you think is stopping the rest?', impact: 'shaping' },
    ],
    'agent',
  );

/**
 * Turn 2: the reply arrives and the agent files what it carried.
 *
 * The findings go in through `record_findings`, which is the only door an
 * asking turn has — and which takes `successCriteria` as well as the two
 * customer findings, so nothing has to be smuggled through a plan.
 */
function afterTheirFirstReply(): WorkingBrief {
  const ingested = receive(afterTheAgentAsked(), TURN_1_REPLY).brief;
  const filed = applyOutputTool(ingested, 'record_findings', {
    successCriteria: ['The number of eligible purchases converted.'],
    converters: {
      shape: 'Purchases of ₹10,000 and above convert on their own more often.',
      basis: 'user',
      knowledge: 'known',
    },
    barriers: [
      {
        id: 'cost-belief',
        statement: 'Customers believe converting adds extra cost.',
        basis: 'user-belief',
        lever: 'message',
        quote: 'think its extra cost',
      },
    ],
  } as never);
  expect(filed.error).toBeUndefined();
  return recordDimensions(filed.brief, [
    { name: 'purchase ticket size', rationale: 'They said ₹10,000-plus converts more.', status: 'retained', basis: 'user', note: 'Their own figure.' },
    { name: 'merchant category', rationale: 'Might split who acts.', status: 'open', basis: 'assumption', note: 'Asked about it.' },
    { name: 'first-time versus repeat EMI user', rationale: 'Might split who acts.', status: 'open', basis: 'assumption', note: 'Asked about it.' },
  ]);
}

/** Turn 3: the named-axis probe goes out, and they close it. */
function afterTheProbe(): WorkingBrief {
  const asked = recordAsked(
    afterTheirFirstReply(),
    [{ text: 'Besides ticket size, have you seen a pattern by merchant category, or by first-time versus repeat EMI users?', impact: 'shaping' }],
    'agent',
  );
  const ingested = receive(asked, TURN_2_PROBE_REPLY).brief;
  return noteClosedOtherAxes(ingested, TURN_2_PROBE_REPLY);
}

describe('a manager reply closes the questions that were on screen', () => {
  it('needs no answered array and no questionResolutions', () => {
    const asked = afterTheAgentAsked();
    // Three from the agent, plus whatever `recordAsked` injected: it adds the
    // customer-gap question itself when converters or barriers are missing,
    // which is the application asking rather than the model.
    expect(outstanding(asked).length).toBeGreaterThanOrEqual(3);

    const after = receive(asked, TURN_1_REPLY).brief;
    expect(outstanding(after)).toHaveLength(0);
    expect(decide(after).blocks.map((b) => b.code)).not.toContain('awaiting-reply');
    // The answer text lands in the same write, so the record can verify a
    // quote against what they typed.
    expect(after.answers.map((a) => a.text)).toEqual([TURN_1_REPLY]);
  });

  it('is the orchestrator path, not a test-only one', async () => {
    // THE FIXTURE IS THE POINT. `recordAnswer` alone was the production
    // ingest, and a test that used it to mean "the manager replied" was
    // reproducing the bug rather than the behaviour.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8'),
    );
    expect(src).toMatch(/brief = receive\(brief, latestUserText\)\.brief;/);
    expect(src).not.toMatch(/brief = recordAnswer\(brief, latestUserText\)/);
  });

  it('does not double-count the discovery rounds', () => {
    // `recordReply` used to advance `brief.rounds` while `recordAnswer` did
    // not, so wiring it in would have counted a round for the reply AND a
    // round for the questions that went out with it. `MAX_ROUNDS` is rounds of
    // QUESTIONS, so the counter stays with `recordQuestions`.
    const asked = afterTheAgentAsked();
    expect(receive(asked, TURN_1_REPLY).brief.rounds).toBe(asked.rounds);
    expect(recordReply(asked, TURN_1_REPLY).rounds).toBe(asked.rounds);
  });

  it('closes a fork the same way, and notCovered is the only exception', () => {
    const after = receive(afterTheAgentAsked(), TURN_1_REPLY).brief;
    const fork = after.questions.find((q) => q.impact === 'fork')!;
    expect(fork.addressedInRound).not.toBeUndefined();
    // And the bounded way back, which is the model's claim rather than a
    // standing presumption that every reply is insufficient.
    expect(outstanding(reopen(after, [fork.id])).map((q) => q.id)).toEqual([fork.id]);
  });
});

describe('nobody is asked to type "go ahead"', () => {
  it('the canned sentence is reachable only from a refused PROPOSE', async () => {
    // "I could not put it up this turn… Tell me to go ahead and I will send it
    // again." It is set in exactly one place — a `propose_strategy` call that
    // `applyOutputTool` refused — and that tool is not on an asking turn's
    // list any more, so a stalled discovery turn cannot produce it. Patching
    // the sentence was never the fix; removing the turn that reached it is.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8'),
    );
    const setters = src.split('proposeRefused =').length - 1;
    expect(setters).toBe(1);
    expect(src).toMatch(/if \(tu\.name === 'propose_strategy'\) \{/);
    expect(outputToolsForPhase('asking').map((t) => t.name)).not.toContain('propose_strategy');
  });

  it('and saysProceed does not re-accept a refused plan', () => {
    // `saysProceed` stays what it was: Skip & propose, and an explicit "stop
    // asking". It releases the NEXT turn through `limitReached`; it does not
    // resurrect a payload this turn refused, and the refusal fallback does not
    // consult it.
    const final = afterTheProbe();
    expect(turnPhase(final, { isBuildTurn: false, limitReached: true })).toBe('ready');
    expect(decide(final, { proceedRequested: true }).proceed).toBe(true);
    // The record got there on its own, so the escape changes nothing here.
    expect(decide(final).proceed).toBe(true);
  });
});

describe('the probe they answered stays answered', () => {
  it('"not something we track" closes it, and files the axes that question named', () => {
    const before = afterTheirFirstReply();
    expect(seenAxes(before).map((d) => d.name)).toEqual(['purchase ticket size']);
    expect(otherAxesProbed(before)).toBe(false);

    const after = afterTheProbe();
    expect(otherAxesProbed(after)).toBe(true);
    expect(decide(after).blocks.map((b) => b.code)).not.toContain('unprobed-other-axes');
    expect(decide(after).blocks.map((b) => b.code)).not.toContain('awaiting-reply');

    // THE AXES THAT QUESTION NAMED, marked from their own sentence. No axis is
    // invented: these two rows were already on the brief, and the seen split
    // is untouched.
    const rows = segmentationDimensions(after);
    const byName = (n: string) => rows.find((d) => d.name === n)!;
    for (const named of ['merchant category', 'first-time versus repeat EMI user']) {
      expect(byName(named).status, named).toBe('unavailable');
      expect(byName(named).basis, named).toBe('user');
      expect(byName(named).note, named).toContain(TURN_2_PROBE_REPLY);
    }
    expect(byName('purchase ticket size').status).toBe('retained');
    expect(byName('purchase ticket size').basis).toBe('user');
    // And nothing new was added to satisfy a count.
    expect(briefDimensions(after)).toHaveLength(briefDimensions(before).length);
  });
});

describe('the whole three-turn conversation reaches a plan', () => {
  it('ends ready, with no escape typed and nothing outstanding', () => {
    const final = afterTheProbe();

    // The findings the manager gave are all on the record.
    expect(final.successCriteria).toEqual(['The number of eligible purchases converted.']);
    expect(final.converters?.basis).toBe('user');
    expect((final.barriers ?? []).map((b) => b.id)).toEqual(['cost-belief']);

    // Nothing is waiting on them.
    expect(outstanding(final)).toHaveLength(0);
    expect(decide(final).blocks).toEqual([]);

    // AND THE TURN IS READY WITHOUT `proceedRequested`. The live run needed
    // the manager to type "go ahead"; the record now says it on its own.
    expect(turnPhase(final, { isBuildTurn: false, limitReached: false })).toBe('ready');
    expect(decide(final).forcedBy).toBeUndefined();
  });

  it('the asking turns on the way there could not have proposed', () => {
    for (const brief of [afterTheAgentAsked(), afterTheirFirstReply()]) {
      const phase = turnPhase(brief, { isBuildTurn: false, limitReached: false });
      expect(phase).toBe('asking');
      expect(outputToolsForPhase(phase).map((t) => t.name)).toEqual([
        'ask_questions',
        'record_findings',
        'record_dimensions',
        'request_evidence',
      ]);
    }
  });

  it('Confirm is still the act that builds', () => {
    // This slice removes a wall in discovery. It does not approve anything on
    // the manager's behalf: the ready turn proposes, they confirm, and only a
    // build turn carries `build_campaign`.
    const final = afterTheProbe();
    expect(outputToolsForPhase('ready').map((t) => t.name)).not.toContain('build_campaign');
    expect(outputToolsForPhase('build').map((t) => t.name)).toContain('build_campaign');
    expect(turnPhase(final, { isBuildTurn: true, limitReached: false })).toBe('build');
  });
});
