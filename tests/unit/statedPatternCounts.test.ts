// A MANAGER-STATED WHO-CONVERTS PATTERN COUNTS.
//
// MEASURED, `eval/runs/ui-s-1792842540156`. Three turns, Confirm never
// appeared, `lastPhase` discovery, `strategy` null, run title "Waiting for
// your answer".
//
// The ingest lid held: all five questions carry `addressedInRound`,
// `awaiting-reply` is gone, nobody was asked to type "go ahead". What blocked
// `decide` was the record reading its own labels too narrowly.
//
// The manager said "10k+ txns convert more" and, asked about category, "nothing
// as of now". The model wrote:
//
//   converters  shape = "Transactions of ₹10,000 and above convert … at a
//               noticeably higher rate", basis `user-belief`, ONE candidate
//   dimensions  ticket size — retained / `user-belief`
//               purchase category or merchant type — deferred / `assumption`
//
// and then:
//
//  - `convertersSettled` wanted `basis: 'user'` or two candidate groups, so
//    who-converts stayed open;
//  - `seenAxes` wanted `basis: 'user'`, so ticket size was invisible and
//    `unprobed-other-axes` never even ran;
//  - `recordAsked` injected "Who tends to do this already today" as q0-4,
//    after they had answered q0-1 about the same thing — their next reply
//    reads "already said txn 10k+ convert more";
//  - two real dimension rows then failed the old three-row count
//    (`too-few-dimensions`, deleted 2026-10-26 — a count was never a search).
//
// `decide` was `['converters-unknown', 'too-few-dimensions']`. The turn stayed
// `asking`, so `propose_strategy` was not on the list, and round 1 dumped a
// seven-day email trade-off into the chat with no tools at all. That essay is
// a consequence, not a separate defect.
//
// THE BRIEF BELOW IS THAT RUN'S TURN 3, not a cleaner fixture.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decide, turnPhase, otherAxesProbed } from '../../server/gate';
import { seenAxes, nextCustomerQuestion, recordDimensions, type WorkingBrief } from '../../server/discovery';
import { recordAsked, outstanding, reopen } from '../../server/record';
import { convertersSettled } from '../../server/findings';

/**
 * That run's turn-3 brief, byte-for-byte, copied into the repo.
 *
 * `eval/runs/` is gitignored — the transcripts are ~47MB and regenerable — so
 * reading the brief from there made this test pass on my machine and fail from
 * a clone. The copy is the recorded object and nothing else from the turn
 * file: `JSON.parse(turn.response.brief)`, re-serialised. Not a tidied
 * fixture; the labels that caused the stall are exactly as the model wrote
 * them.
 */
const live = (): WorkingBrief =>
  JSON.parse(
    readFileSync(new URL('./support/liveBriefs/ui-s-1792842540156.turn-3.brief.json', import.meta.url), 'utf8'),
  ) as WorkingBrief;

describe('the live brief that could not propose', () => {
  it('is the shape this slice is about, read off the run', () => {
    const b = live();
    expect(b.converters?.basis).toBe('user-belief');
    expect(b.converters?.shape).toMatch(/₹10,000 and above/);
    expect(b.converters?.candidates).toHaveLength(1);
    expect(b.dimensions?.map((d) => [d.name, d.status, d.basis])).toEqual([
      ['Transaction ticket size', 'retained', 'user-belief'],
      ['Purchase category or merchant type', 'deferred', 'assumption'],
    ]);
    // The findings and the success measure were already filed, and every
    // question — including the category probe — had been answered.
    expect(b.successCriteria?.length).toBeGreaterThan(0);
    expect((b.barriers ?? []).length).toBeGreaterThan(0);
    expect(outstanding(b)).toHaveLength(0);
    expect(b.questions?.length).toBe(5);
  });

  it('settles who converts on their stated pattern', () => {
    expect(convertersSettled(live().converters)).toBe(true);
  });

  it('sees the axis they gave', () => {
    expect(seenAxes(live()).map((d) => d.name)).toEqual(['Transaction ticket size']);
  });

  it('counts the probe they answered, without changing their words', () => {
    const b = live();
    // Their reply is untouched: no phrase was added to `closesOtherAxes`, and
    // the question that closed this said "Beyond transaction size…", which no
    // taught phrase would have matched.
    expect(b.answers?.some((a) => a.text.includes('nothing as of now'))).toBe(true);
    expect(b.questions?.find((q) => q.id === 'q0-3')?.text).toMatch(/^Beyond transaction size/);
    expect(otherAxesProbed(b)).toBe(true);
  });

  it('does not ask for a third line of enquiry that does not exist', () => {
    const b = live();
    // Two rows, and no rule left that counts them: the block that did is
    // gone, and `unprobed-other-axes` reads the probe instead.
    expect((b.dimensions ?? []).length).toBe(2);
    expect(decide(b).blocks.map((x) => x.code)).not.toContain('too-few-dimensions');
    expect(decide(b).blocks).toEqual([]);
  });

  it('has nothing left to block on', () => {
    const codes = decide(live()).blocks.map((x) => x.code);
    for (const gone of ['converters-unknown', 'unprobed-other-axes', 'too-few-dimensions', 'awaiting-reply']) {
      expect(codes, gone).not.toContain(gone);
    }
    expect(codes).toEqual([]);
  });

  it('IS READY, with nothing typed', () => {
    const b = live();
    expect(turnPhase(b, { isBuildTurn: false, limitReached: false })).toBe('ready');
    expect(decide(b).proceed).toBe(true);
    expect(decide(b).forcedBy).toBeUndefined();
  });

  it('does not reprint the question they answered', () => {
    const b = live();
    // The inject keys on the SHAPE now, not on settledness, so a brief that
    // holds their sentence never gets the generic question again.
    expect(nextCustomerQuestion(b, { skipSuccess: true })).toBeNull();
    const after = recordAsked(b, [{ text: 'Shall SMS cover the sends WhatsApp does not land?', impact: 'detail' }], 'agent');
    const added = after.questions.slice(b.questions.length).map((q) => q.text);
    expect(added).toEqual(['Shall SMS cover the sends WhatsApp does not land?']);
    expect(added.some((t) => /Who tends to do this already/.test(t))).toBe(false);
  });
});

describe('the line is theirs versus ours, not which honest label the model picked', () => {
  it('an assumption shape still does not settle who converts', () => {
    const b = live();
    const invented: WorkingBrief = {
      ...b,
      converters: { ...b.converters!, basis: 'assumption' },
    };
    expect(convertersSettled(invented.converters)).toBe(false);
    expect(decide(invented).blocks.map((x) => x.code)).toContain('converters-unknown');
  });

  it('and even an UNSETTLED shape is not re-asked in the generic words', () => {
    // THE SECOND LOCK, and the only state that exercises it now that the
    // basis rule is fixed: an `assumption` shape leaves the BLOCK standing —
    // the agent wrote that, not the manager — but there is still nothing to
    // gain from printing "Who tends to do this already today" at someone who
    // has a shape on their brief. The block's own `clears.how` says what to
    // do instead.
    //
    // This is what reprinted as q0-4 in the live run, after they had answered
    // the same thing as q0-1. Their next message: "already said txn 10k+
    // convert more".
    const b = live();
    const invented: WorkingBrief = { ...b, converters: { ...b.converters!, basis: 'assumption' } };
    expect(convertersSettled(invented.converters)).toBe(false);
    expect(decide(invented).blocks.map((x) => x.code)).toContain('converters-unknown');
    expect(nextCustomerQuestion(invented, { skipSuccess: true })).toBeNull();
    const after = recordAsked(invented, [{ text: 'Is 7 days the window you want?', impact: 'shaping' }], 'agent');
    expect(after.questions.slice(invented.questions.length).map((q) => q.text)).toEqual([
      'Is 7 days the window you want?',
    ]);
  });

  it('an assumption dimension is still not a seen axis', () => {
    const b = live();
    const guessed = recordDimensions(b, [
      { name: 'Transaction ticket size', rationale: 'A hunch of mine.', status: 'retained', basis: 'assumption', note: 'Mine.' },
    ]);
    expect(seenAxes(guessed).map((d) => d.name)).not.toContain('Transaction ticket size');
  });

  it('a seen axis with the extra-axis question still outstanding holds the probe', () => {
    // `reopen` is the bounded way the model says a reply did not touch a
    // question, and it is the state this rule must still catch: the axis is
    // on the record, and nobody has answered whether there is another.
    const back = reopen(live(), ['q0-3']);
    expect(outstanding(back).map((q) => q.id)).toEqual(['q0-3']);
    expect(otherAxesProbed(back)).toBe(false);
    const codes = decide(back).blocks.map((x) => x.code);
    expect(codes).toContain('unprobed-other-axes');
    // AND NOTHING COUNTS ROWS ALONGSIDE IT, since 2026-10-26: the search is
    // one rule now, and an unanswered probe is the whole of it.
    expect(codes).not.toContain('too-few-dimensions');
  });

  it('an agent-only row leaves the record with no seen axis at all', () => {
    // RETARGETED with the count that is gone. What this is really about is
    // that `assumption` is the agent talking to itself: it is not a pattern
    // anyone saw, so it cannot be the axis a cut rests on. The second-pattern
    // probe stays silent here on purpose — the who-converts conversation owns
    // this state, and two blocks asking adjacent things read as the
    // application talking over itself.
    const b = live();
    const nothingSeen: WorkingBrief = {
      ...b,
      dimensions: [{ ...b.dimensions![0], basis: 'assumption', status: 'open' }],
    };
    expect(seenAxes(nothingSeen)).toHaveLength(0);
    expect(otherAxesProbed(nothingSeen)).toBe(false);
    expect(decide(nothingSeen).blocks.map((x) => x.code)).not.toContain('unprobed-other-axes');
  });
});
