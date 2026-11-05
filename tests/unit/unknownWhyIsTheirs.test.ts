// "We don't track that" is an answer, and it is THEIRS.
//
// MEASURED, `eval/runs/ui-s-1793611326664`. The manager was asked why the
// dormant cardholders who do not transact stay inactive and said they do not
// track it. The model filed that faithfully and with the one basis the record
// throws away:
//
//   {"id":"reason-unknown","basis":"none","lever":"not-addressable"}
//
// `designableBarriers` keeps `user | user-belief | assumption`, so `none` is
// dropped, and turn 4's `lastBlocks` is `["no-barrier"]` — the application
// asking again for something the manager had already answered. `lever:
// 'not-addressable'` is the second half of the same mistake: it means "this
// reason is real and a drip cannot fix it", and an UNKNOWN reason is what the
// first run exists to settle.
//
// SECOND MEASUREMENT, `eval/runs/ui-s-1793616608652` turn 3. They answered
// "1. not sure / 2. not sure / 3. not really". The model filed
// `why-dormant-unknown` as `user` quoting "not sure" — and `quoteIsTheirs`
// wants three content words, so attribution stored it as `assumption`. The
// rewrite below bailed on ANY assumption, so `mustTestBarriers` stayed true
// and Plan shipped a two-arm "forgot the card" against "switched to UPI"
// experiment over a reason nobody had given. Confirm built it.
//
// An unknown filed under a weaker basis is still the manager saying they do
// not know. A cause the agent GUESSED is not, and the quote tells them apart.
//
// So the rewrite runs AFTER `recordBarriers` in the `record_findings`
// handler, where it is the last write and therefore wins, and outside the
// barriers block, so the same reply is heard on a call that files only
// converters or only success. It only ever RELEASES: it fires only while no
// designable barrier is on file, and a real stated barrier — including a real
// stated `not-addressable` one — is left exactly as the model filed it.
import { describe, it, expect } from 'vitest';
import { blocksFor } from '../../server/gate';
import { newBrief, recordConverters, recordDimensions, recordSuccessCriteria } from '../../server/discovery';
import { receive } from '../../server/record';
import { applyOutputTool } from '../../server/outputTools';
import { mustTestBarriers } from '../../server/findings';
import { readFileSync } from 'node:fs';

/** The reply and the row the live run filed, copied out — `eval/runs/` is gitignored. */
const LIVE = JSON.parse(
  readFileSync(new URL('./support/liveBriefs/ui-s-1793616608652.turn-3.filed.json', import.meta.url), 'utf8'),
) as { reply: string; recordFindings: { barriers: { id: string; quote: string; basis: string }[] } };

const OBJECTIVE = 'Reactivate dormant cardholders. Get them transacting again.';

/** Everything settled except why the rest do not convert. */
const settled = () => {
  let b = newBrief(OBJECTIVE);
  b = recordConverters(b, {
    shape: 'Everyone issued a card who has not transacted.',
    basis: 'user',
    knowledge: 'known',
  });
  b = recordSuccessCriteria(b, ['Count of dormant cards that transact again.']);
  return recordDimensions(b, [
    { name: 'months dormant', rationale: 'They said it.', status: 'retained', basis: 'user', note: 'Theirs.' },
    { name: 'card variant', rationale: 'Asked.', status: 'unavailable', basis: 'user', note: 'Not tracked.' },
    { name: 'limit band', rationale: 'Asked.', status: 'unavailable', basis: 'user', note: 'Not tracked.' },
  ]);
};

/** What the live model filed, verbatim from turn 3. */
const WRONG = {
  barriers: [
    {
      id: 'reason-unknown',
      statement: 'The reason dormant cardholders stay inactive is not known to the issuer.',
      basis: 'none',
      lever: 'not-addressable',
      quote: '',
    },
  ],
};

const fileIt = (reply: string, payload: unknown = WRONG) =>
  applyOutputTool(receive(settled(), reply).brief, 'record_findings', payload as never);

const codes = (b: Parameters<typeof blocksFor>[0]) => blocksFor(b).map((x) => x.code);

describe('an unknown "why" is the manager\'s answer, not an undesignable barrier', () => {
  // THE LIVE REPLY. `don't track` was not in `DONT_KNOW` before this slice,
  // which is why the one phrase the run actually got was the one the record
  // could not hear.
  it.each(["we don't track that", 'we dont track why they stay dormant', 'no idea honestly'])(
    'rewrites the model\'s basis:none / not-addressable row after %j',
    (reply) => {
      const out = fileIt(reply);
      const row = (out.brief.barriers ?? [])[0];
      expect(row.basis).toBe('user');
      expect(row.lever).not.toBe('not-addressable');
      expect(row.quote).toBe(reply);
      // The pin the whole slice is for: `no-barrier` is gone even though the
      // LAST tool call filed a row the gate would have dropped.
      expect(codes(out.brief)).not.toContain('no-barrier');
    },
  );

  // THE SAME REPLY ON A CALL THAT FILES SOMETHING ELSE. A barriers-only fix
  // would leave the hold standing here for exactly the reason it was lifted
  // above — the manager answered, and the record could not hear it. (A call
  // carrying no field at all is refused outright by the tool, so there is no
  // shape in which nothing is written.)
  it('files a row of its own when the model sent no barrier at all', () => {
    const out = fileIt("we don't track that", {
      successCriteria: ['Count of dormant cards that transact again.'],
    });
    const rows = out.brief.barriers ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].basis).toBe('user');
    expect(rows[0].statement).toMatch(/do not know why/i);
    expect(codes(out.brief)).not.toContain('no-barrier');
    expect(out.ok).toMatch(/do not know why/i);
  });

  it('leaves a real stated barrier exactly as filed, and it still clears the block', () => {
    const out = fileIt('they think the interest looks expensive', {
      barriers: [
        {
          id: 'cost',
          statement: 'They think the interest looks expensive.',
          basis: 'user-belief',
          lever: 'message',
          quote: 'interest looks expensive',
        },
      ],
    });
    const rows = out.brief.barriers ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('cost');
    expect(rows[0].statement).toBe('They think the interest looks expensive.');
    expect(codes(out.brief)).not.toContain('no-barrier');
  });

  // A reason they DID give that a drip cannot fix is not the same answer as
  // "we do not know". `recordBarriers` downgrades the unquoted basis to
  // `assumption`, which is designable, so the rewrite must not fire — and the
  // lever has to survive, because it is the honest one here.
  it('does not touch a stated not-addressable reason', () => {
    const out = fileIt('they have moved abroad, nothing we send will help', {
      barriers: [
        {
          id: 'abroad',
          statement: 'They have moved abroad.',
          basis: 'user',
          lever: 'not-addressable',
          quote: 'moved abroad',
        },
      ],
    });
    const row = (out.brief.barriers ?? [])[0];
    expect(row.id).toBe('abroad');
    expect(row.lever).toBe('not-addressable');
  });

  // It reads the latest reply, not the objective and not the whole
  // transcript. A turn whose reply says nothing about knowing leaves the
  // model's filing alone, so the block still stands and still asks.
  it('stays out of the way when the reply does not say they do not know', () => {
    const out = fileIt('month six is when most of them go quiet');
    const row = (out.brief.barriers ?? [])[0];
    expect(row.basis).toBe('none');
    expect(codes(out.brief)).toContain('no-barrier');
  });

  // THE LIVE PAYLOAD, through `record_findings` so attribution runs and
  // downgrades the basis exactly as it did on the run.
  it('settles the live "not sure" reply as one row, with no barrier left to test', () => {
    const out = fileIt(LIVE.reply, LIVE.recordFindings);
    const rows = out.brief.barriers ?? [];
    // ONE ROW, NOT TWO. Dropping the bail without widening `findIndex` files
    // `reason-unknown` beside the assumption: `mustTestBarriers` goes false
    // and the quasi-cause stays on the record anyway.
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('why-dormant-unknown');
    expect(rows[0].basis).toBe('user');
    expect(rows[0].lever).not.toBe('not-addressable');
    // THE STATEMENT IS THE APPLICATION'S, not the model's. Whatever wording
    // it filed, the row has to say the reason is unknown.
    expect(rows[0].statement).toMatch(/do not know why/i);
    expect(mustTestBarriers(out.brief.barriers), 'nothing left to explain-test').toBe(false);
    expect(codes(out.brief)).not.toContain('no-barrier');
  });

  // THE QUOTE IS WHAT TELLS THE TWO APART, and this is the case that needs
  // it: the reply IS about not knowing, and the row the model filed is still
  // a guess — its own quote names a cause. Rewriting that one would put the
  // agent's invention on the record wearing the manager's basis, which is the
  // laundering this whole function exists to prevent. The guess is left where
  // it is and the unknown is filed beside it, so nothing is lost either way.
  it('does not launder a guessed cause just because this reply says they do not know', () => {
    const out = fileIt('honestly no idea why they stopped', {
      barriers: [
        {
          id: 'guessed',
          statement: 'They switched their everyday spend to UPI.',
          basis: 'assumption',
          lever: 'message',
          quote: 'they probably moved to UPI',
        },
      ],
    });
    const rows = out.brief.barriers ?? [];
    const guess = rows.find((b) => b.id === 'guessed');
    expect(guess?.basis, 'still the agent\'s own').toBe('assumption');
    expect(guess?.statement).toMatch(/UPI/);
    expect(rows.some((b) => /do not know why/i.test(b.statement ?? '')), 'and the unknown is on file too').toBe(true);
  });

  // THE LOCK. A cause the agent guessed is not an unknown, and a reply that
  // is not about knowing must never rewrite one. Without this, the widened
  // search would launder every assumption into the manager's own words.
  it('leaves a guessed cause alone when the reply is not about not knowing', () => {
    const out = fileIt('month six is when most of them go quiet', {
      barriers: [
        {
          id: 'guessed',
          statement: 'They switched their everyday spend to UPI.',
          basis: 'assumption',
          lever: 'message',
          quote: 'they probably moved to UPI',
        },
      ],
    });
    const rows = out.brief.barriers ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].basis).toBe('assumption');
    expect(rows[0].statement).toMatch(/UPI/);
    expect(mustTestBarriers(out.brief.barriers), 'a guess is still something to test').toBe(true);
  });
});
