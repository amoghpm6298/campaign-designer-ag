// The two findings discovery has to produce: who converts, and why the rest
// do not.
//
// The tests that matter here are the ATTRIBUTION ones. A barrier the agent
// invented and credited to the manager is the failure this whole module
// exists to prevent, and it is indistinguishable from a real one unless the
// application checks the claim.
import { describe, it, expect } from 'vitest';
import {
  isDesignable,
  designableBarriers,
  mustBeAddressed,
  convertersSettled,
  mustLearnAudience,
  mustTestBarriers,
  type Barrier,
} from '../../server/findings';
import { newBrief, recordAnswer, recordBarriers, recordConverters, briefBarriers } from '../../server/discovery';
import { decide } from '../../server/gate';

const barrier = (over: Partial<Barrier> = {}): Barrier => ({
  id: 'cost',
  statement: 'They see the interest and think it is too expensive.',
  basis: 'user-belief',
  lever: 'message',
  ...over,
});

describe('which barriers a campaign may rest on', () => {
  it('accepts one the manager stated as fact', () => {
    expect(isDesignable(barrier({ basis: 'user' }))).toBe(true);
  });

  it('accepts their belief about cause, unverified as it is', () => {
    // A barrier is almost always a belief — nobody can know why customers
    // behave as they do. What matters is that a person offered it.
    expect(isDesignable(barrier({ basis: 'user-belief' }))).toBe(true);
  });

  it('ACCEPTS one the agent assumed, because no facts is the ordinary case', () => {
    // Refusing these deadlocked a real run: a manager who genuinely cannot
    // say why customers behave as they do is normal, and blocking there
    // blocks for ever. When there are no facts the honest move is a strong
    // assumption, stated as one — and a campaign built to find out whether it
    // holds. `mustTestBarriers` carries that obligation.
    expect(isDesignable(barrier({ basis: 'assumption' }))).toBe(true);
  });

  it('flags a design resting ENTIRELY on the agent\'s own reading', () => {
    expect(mustTestBarriers([barrier({ basis: 'assumption' })])).toBe(true);
  });

  it('does not flag one the manager actually supports', () => {
    expect(mustTestBarriers([barrier({ basis: 'user-belief' })])).toBe(false);
    expect(mustTestBarriers([barrier({ basis: 'user-belief' }), barrier({ id: 'b', basis: 'assumption' })])).toBe(false);
  });

  it('refuses one with nothing behind it at all', () => {
    expect(isDesignable(barrier({ basis: 'none' }))).toBe(false);
  });

  it('filters a mixed list down to what is designable', () => {
    const list = [barrier({ id: 'a', basis: 'user' }), barrier({ id: 'b', basis: 'none' })];
    expect(designableBarriers(list).map((b) => b.id)).toEqual(['a']);
  });

  it('treats an absent list as empty rather than throwing', () => {
    expect(designableBarriers(undefined)).toEqual([]);
  });
});

describe('barriers the design must not silently ignore', () => {
  it('includes a designable barrier with a lever', () => {
    expect(mustBeAddressed([barrier()]).map((b) => b.id)).toEqual(['cost']);
  });

  it('excludes one the agent judged unaddressable', () => {
    // "A drip campaign cannot fix this" is a real answer, and one the agent
    // previously had no way to give. It must not read as an omission.
    expect(mustBeAddressed([barrier({ lever: 'not-addressable' })])).toEqual([]);
  });

  it('excludes one resting on nothing at all', () => {
    expect(mustBeAddressed([barrier({ basis: 'none' })])).toEqual([]);
  });
});

describe('attribution is verified against what the manager actually typed', () => {
  const asked = () => {
    let b = newBrief('we want more customers converting their outstanding balance into EMI');
    b = recordAnswer(
      b,
      'honestly not sure. my guess is they see the interest and think it is too expensive. but it could just be they do not know the option is there',
    );
    return b;
  };

  it('keeps the basis when the quote is genuinely theirs', () => {
    const b = recordBarriers(asked(), [
      barrier({ quote: 'they see the interest and think it is too expensive' }),
    ]);
    expect(briefBarriers(b)[0].basis).toBe('user-belief');
    expect(isDesignable(briefBarriers(b)[0])).toBe(true);
  });

  it('still keeps it when the agent paraphrased rather than transcribed', () => {
    // A model quoting a conversation drops filler and fixes grammar. Demanding
    // a literal substring would reject honest attributions more often than
    // dishonest ones, which would make the check worse than nothing.
    const b = recordBarriers(asked(), [
      barrier({ quote: 'the interest looks too expensive to them' }),
    ]);
    expect(briefBarriers(b)[0].basis).toBe('user-belief');
  });

  it('DOWNGRADES a barrier the manager never mentioned', () => {
    // The whole point. This barrier is plausible, well written, and invented.
    const b = recordBarriers(asked(), [
      barrier({
        id: 'trust',
        statement: 'They do not trust the bank not to add hidden charges.',
        quote: 'customers worry about hidden fees and small print',
      }),
    ]);
    expect(briefBarriers(b)[0].basis).toBe('assumption');
    // It may still drive a design — refusing outright deadlocks a manager who
    // has nothing to offer. What it must not do is pass as something they
    // said, so it carries the obligation to be tested rather than assumed.
    expect(mustTestBarriers(briefBarriers(b))).toBe(true);
  });

  it('downgrades when the basis claims the user but no quote is given', () => {
    const b = recordBarriers(asked(), [barrier({ quote: undefined })]);
    expect(briefBarriers(b)[0].basis).toBe('assumption');
  });

  it('keeps the barrier itself after a downgrade, losing only the claim', () => {
    // Nothing is thrown away and nothing errors. The agent reads the
    // corrected record next round.
    const b = recordBarriers(asked(), [barrier({ quote: 'nothing like what they said' })]);
    expect(briefBarriers(b)).toHaveLength(1);
    expect(briefBarriers(b)[0].statement).toContain('too expensive');
  });

  it('cannot be satisfied by quoting the objective instead of an answer', () => {
    // The objective is what the agent was handed, not something the manager
    // offered in reply. Only answers count.
    let b = newBrief('we want more customers converting their outstanding balance into EMI');
    b = recordBarriers(b, [
      barrier({ quote: 'customers converting their outstanding balance into EMI' }),
    ]);
    expect(briefBarriers(b)[0].basis).toBe('assumption');
  });

  it('PROMOTES an honest guess that carries the manager\'s real words', () => {
    // The deadlock this prevents, from a real eight-turn run: the agent sent
    // basis 'assumption' with the quote "my guess is they see the interest
    // and think it is too expensive" — the manager's exact words. It had read
    // their hedge as making it an assumption, which is a fair reading of the
    // word and fatal here: `isDesignable` rejects 'assumption', so the gate
    // blocked for ever on a barrier that was perfectly well evidenced.
    //
    // The quote is the evidence. The label is the model's opinion about the
    // evidence, and the application should not make it win a vocabulary
    // argument to be heard.
    const b = recordBarriers(asked(), [
      barrier({ basis: 'assumption', quote: 'my guess is they see the interest and think it is too expensive' }),
    ]);
    expect(briefBarriers(b)[0].basis).toBe('user-belief');
    expect(isDesignable(briefBarriers(b)[0])).toBe(true);
  });

  it('does not promote one whose quote they never said', () => {
    const b = recordBarriers(asked(), [
      barrier({ basis: 'assumption', quote: 'customers worry about hidden fees and small print' }),
    ]);
    expect(briefBarriers(b)[0].basis).toBe('assumption');
  });

  it('does not treat an assumption as a dishonest claim', () => {
    // An agent that honestly labels its own guess keeps that label.
    const b = recordBarriers(asked(), [barrier({ basis: 'assumption', quote: undefined })]);
    expect(briefBarriers(b)[0].basis).toBe('assumption');
  });
});

describe('recording barriers', () => {
  it('merges by id and preserves what an update omits', () => {
    let b = newBrief('o');
    b = recordAnswer(b, 'they think the interest is too expensive');
    b = recordBarriers(b, [barrier({ quote: 'the interest is too expensive' })]);
    b = recordBarriers(b, [{ id: 'cost', statement: barrier().statement, basis: 'user-belief', lever: 'timing' }]);
    expect(briefBarriers(b)).toHaveLength(1);
    expect(briefBarriers(b)[0].lever).toBe('timing');
    expect(briefBarriers(b)[0].quote).toBe('the interest is too expensive');
  });

  it('matches ids case-insensitively, because a model supplies them', () => {
    let b = recordBarriers(newBrief('o'), [barrier({ id: 'Cost' })]);
    b = recordBarriers(b, [barrier({ id: 'cost', statement: 'Reworded.' })]);
    expect(briefBarriers(b)).toHaveLength(1);
    expect(briefBarriers(b)[0].statement).toBe('Reworded.');
  });

  it('derives an id when the model omits one', () => {
    const b = recordBarriers(newBrief('o'), [{ ...barrier(), id: '' }]);
    expect(briefBarriers(b)[0].id).toBeTruthy();
  });

  it('drops a barrier with no statement', () => {
    expect(briefBarriers(recordBarriers(newBrief('o'), [barrier({ statement: '   ' })]))).toEqual([]);
  });

  it('falls back to a real lever when the model sends an unknown one', () => {
    const b = recordBarriers(newBrief('o'), [{ ...barrier(), lever: 'telepathy' as never }]);
    expect(briefBarriers(b)[0].lever).toBe('message');
  });

  it('leaves the brief untouched for an empty update', () => {
    const before = newBrief('o');
    expect(recordBarriers(before, [])).toBe(before);
    expect(recordBarriers(before, undefined)).toBe(before);
  });

  it('defaults to empty for a brief saved before barriers existed', () => {
    const legacy = { ...newBrief('o') } as Record<string, unknown>;
    delete legacy.barriers;
    expect(briefBarriers(legacy as never)).toEqual([]);
  });
});

describe('who converts today — when the manager knows', () => {
  const known = (over = {}) => ({ shape: 'mostly large-ticket purchases', basis: 'user' as const, knowledge: 'known' as const, ...over });

  it('is unsettled on a fresh brief', () => {
    expect(convertersSettled(newBrief('o').converters)).toBe(false);
  });

  it('is settled once the manager describes them', () => {
    const b = recordConverters(newBrief('o'), known());
    expect(convertersSettled(b.converters)).toBe(true);
  });

  it('does NOT count the agent deciding for itself', () => {
    const b = recordConverters(newBrief('o'), known({ basis: 'assumption' }));
    expect(convertersSettled(b.converters)).toBe(false);
  });

  it('replaces rather than accumulating, so a correction supersedes', () => {
    let b = recordConverters(newBrief('o'), known());
    b = recordConverters(b, known({ shape: 'actually, people who called the helpline' }));
    expect(b.converters?.shape).toBe('actually, people who called the helpline');
  });

  it('ignores a blank shape', () => {
    const before = newBrief('o');
    expect(recordConverters(before, known({ shape: '  ' }))).toBe(before);
  });

  it('falls back to an assumption when the model sends an unknown basis', () => {
    const b = recordConverters(newBrief('o'), known({ basis: 'vibes' as never }));
    expect(b.converters?.basis).toBe('assumption');
  });
});

describe('who converts today — the manager described the audience', () => {
  // The activation run, 2026-10-22, turn 3. They said: every newly issued card
  // that has not transacted, one track, do not split. The record held that
  // faithfully — basis `user`, shape exactly that — and wrote `knowledge:
  // 'none-yet'`, which is ALSO true: nobody can point at a sub-group that
  // activates faster. The gate took the second statement, fell through to the
  // candidate path with no candidates, and refused the proposal with "I do not
  // yet know who does this today" about an audience they had just defined.
  //
  // So a user-stated shape settles this finding whatever `knowledge` says.
  const described = (over = {}) => ({
    shape: 'every newly issued card that has not transacted, one track',
    basis: 'user' as const,
    knowledge: 'unknown' as const,
    ...over,
  });

  it('settles on a user-stated shape even when knowledge is not "known"', () => {
    for (const knowledge of ['unknown', 'none-yet'] as const) {
      const b = recordConverters(newBrief('o'), described({ knowledge }));
      expect(convertersSettled(b.converters)).toBe(true);
    }
  });

  it('does not need candidates when the manager named the audience', () => {
    const b = recordConverters(newBrief('o'), described());
    expect(b.converters?.candidates).toEqual([]);
    expect(convertersSettled(b.converters)).toBe(true);
  });

  it('stops the gate asking who converts', () => {
    // The live symptom, and the only thing the manager actually saw.
    const b = recordConverters(newBrief('o'), described());
    const codes = decide(b).blocks.map((x) => x.code);
    expect(codes).not.toContain('converters-unknown');
    expect(decide(b).blocks.every((x) => !/who does this today/.test(x.reason))).toBe(true);
  });

  it('still has to find out who converts — the obligation moved, it did not go', () => {
    // `mustLearnAudience` is unchanged, so the campaign is still one whose job
    // includes learning who responds. It is carried as a limitation on the
    // design rather than as a refusal to proceed.
    const b = recordConverters(newBrief('o'), described());
    expect(mustLearnAudience(b.converters)).toBe(true);
  });

  it('does not accept a shape the AGENT wrote, however well put', () => {
    const b = recordConverters(newBrief('o'), described({ basis: 'assumption' }));
    expect(convertersSettled(b.converters)).toBe(false);
  });

  it('accepts a user-stated non-answer, which is the cost of the above', () => {
    // RECORDED AS BEHAVIOUR, not asserted as desirable. "nobody can say" with
    // basis `user` is a non-empty user shape, so it settles with no
    // candidates — the narrowed remains of the hole this function's history
    // describes.
    //
    // Closing it would mean reading their prose to decide whether a shape
    // names a group or reports an absence, and judging their words to RAISE a
    // block is the one thing `record.ts` forbids. The protection sits on the
    // design instead: `mustLearnAudience` holds, so a journey that learns
    // nothing about who converts is reported as a limitation.
    const b = recordConverters(newBrief('o'), described({ shape: 'nobody can say who converts' }));
    expect(convertersSettled(b.converters)).toBe(true);
    expect(mustLearnAudience(b.converters)).toBe(true);
  });
});

describe("who converts today — when NOBODY knows and the shape is the agent's own", () => {
  // The case that matters most and was wrong first time round: "they have no
  // data on this" used to close the question, so the one situation where the
  // agent needed to think hardest was the one it was allowed to skip.
  //
  // THE FIXTURE'S BASIS CHANGED 2026-10-22, and it is the whole point of the
  // group. These cases used `basis: 'user'`, which now settles on the shape
  // alone — so written that way they would all pass without exercising a
  // single candidate rule. The two-candidate requirement applies where it was
  // always aimed: a shape the AGENT supplied. `recordConverters` refuses an
  // empty shape outright, so "no user shape" means a non-user basis in
  // practice, and that is the path these tests walk.
  const blank = (over = {}) => ({ shape: 'nobody has converted yet', basis: 'assumption' as const, knowledge: 'none-yet' as const, ...over });

  it('is NOT settled by the agent reporting that nobody knows', () => {
    const b = recordConverters(newBrief('o'), blank());
    expect(convertersSettled(b.converters)).toBe(false);
  });

  it('is NOT settled by a single candidate segment, which is a guess', () => {
    const b = recordConverters(newBrief('o'), blank({
      candidates: [{ segment: 'High spenders', restsOn: 'balance size', why: 'Larger balances cost more to carry.' }],
    }));
    expect(convertersSettled(b.converters)).toBe(false);
  });

  it('IS settled on the turn the candidates are recorded, with no further reply', () => {
    // REVERSED 2026-10-21. This used to assert false, on the reasoning that
    // the agent must not treat its own suggestion as agreed — it required a
    // manager reply after the candidates were raised.
    //
    // Measured on the PIN-activation run: the manager had already said they
    // have no visibility on who activates, the agent put up two groups
    // resting on different things, and the gate held and re-asked "who tends
    // to do this already today". It was asking the manager to pick a
    // targeting group out of guesses, which is the thing the campaign exists
    // to find out.
    //
    // Nobody knows plus two distinct candidates IS this question answered.
    // The obligation that remains is on the design: `mustLearnAudience`
    // stays true and `checkAudienceLearning` refuses a flat journey, so the
    // candidates must still be told apart by what gets built.
    let b = newBrief('o');
    b = recordConverters(b, blank({
      candidates: [
        { segment: 'High spenders', restsOn: 'balance size', why: 'Larger balances cost more to carry.' },
        { segment: 'Recent big-ticket buyers', restsOn: 'recent purchase size', why: 'A single large purchase is the classic EMI trigger.' },
      ],
    }));
    expect(b.converters?.raisedInRound).toBe(0);
    expect(convertersSettled(b.converters)).toBe(true);
    // Still a campaign that has to find out, which is where the protection is.
    expect(mustLearnAudience(b.converters)).toBe(true);
  });

  it('REJECTING the candidates does not reopen the question', () => {
    // "Do not target off those guesses" is agreement about the state of
    // knowledge, not a refusal to answer. Under the old rule a rejection was
    // unrepresentable: any reply counted as settling it, and no reply left it
    // open, so the one thing the manager might actually want to say had
    // nowhere to land.
    let b = newBrief('o');
    b = recordConverters(b, blank({
      candidates: [
        { segment: 'Welcome-offer sign-ups', restsOn: 'the acquisition incentive at sign-up', why: 'A reward tied to first use is its own reason to act.' },
        { segment: 'Existing product holders', restsOn: 'an existing relationship with the bank', why: 'Familiarity removes first-time friction.' },
      ],
    }));
    b = { ...b, rounds: 1 };
    b = recordAnswer(b, 'do not target off those guesses, we have no visibility on this');
    expect(convertersSettled(b.converters)).toBe(true);
  });

  it('IS settled once two reasoned candidates were raised and the manager replied after', () => {
    let b = newBrief('o');
    b = recordConverters(b, blank({
      candidates: [
        { segment: 'High spenders', restsOn: 'balance size', why: 'Larger balances cost more to carry.' },
        { segment: 'Recent big-ticket buyers', restsOn: 'recent purchase size', why: 'A single large purchase is the classic EMI trigger.' },
      ],
    }));
    b = { ...b, rounds: 1 };
    b = recordAnswer(b, 'the second one sounds right, go with big-ticket buyers');
    expect(convertersSettled(b.converters)).toBe(true);
  });

  it('rejects a candidate with no reasoning behind it', () => {
    const b = recordConverters(newBrief('o'), blank({
      candidates: [
        { segment: 'High spenders', restsOn: 'balance size', why: '' },
        { segment: 'Recent big-ticket buyers', restsOn: 'recent purchase size', why: 'A large purchase is the classic trigger.' },
      ],
    }));
    expect(b.converters?.candidates).toHaveLength(1);
    expect(convertersSettled(b.converters)).toBe(false);
  });

  it('does not reset the clock when the same candidates are sent again', () => {
    // Re-sending must not wipe out a reply that already came back.
    const cands = [
      { segment: 'High spenders', restsOn: 'balance size', why: 'Larger balances cost more to carry.' },
      { segment: 'Recent big-ticket buyers', restsOn: 'recent purchase size', why: 'A single large purchase is the classic trigger.' },
    ];
    let b = recordConverters(newBrief('o'), blank({ candidates: cands }));
    b = { ...b, rounds: 2 };
    b = recordConverters(b, blank({ candidates: cands }));
    expect(b.converters?.raisedInRound).toBe(0);
  });

  it('REJECTS two names for the same group', () => {
    // The agent is supposed to catch this before putting the options up. It is
    // not the manager's job to notice that "high spenders" and "big spenders"
    // are one group. The application cannot judge whether two segments mean
    // the same thing, so the agent declares what each RESTS ON and that is
    // what gets compared. Same shape as an experiment declaring what it tests
    // and the arms having to really differ.
    const b = recordConverters(newBrief('o'), blank({
      candidates: [
        { segment: 'High spenders', restsOn: 'balance size', why: 'Larger balances cost more to carry.' },
        { segment: 'Big spenders', restsOn: 'Balance Size', why: 'A bigger balance is more expensive to hold.' },
      ],
    }));
    expect(convertersSettled(b.converters)).toBe(false);
  });

  it('accepts two groups that genuinely rest on different things', () => {
    let b = newBrief('o');
    b = recordConverters(b, blank({
      candidates: [
        { segment: 'High spenders', restsOn: 'balance size', why: 'Larger balances cost more to carry.' },
        { segment: 'Helpline callers', restsOn: 'called the helpline', why: 'They already asked about repayment, so intent is shown.' },
      ],
    }));
    b = { ...b, rounds: 1 };
    b = recordAnswer(b, 'go with the helpline callers');
    expect(convertersSettled(b.converters)).toBe(true);
  });

  it('drops a candidate that does not say what it rests on', () => {
    const b = recordConverters(newBrief('o'), blank({
      candidates: [
        { segment: 'High spenders', restsOn: '', why: 'Larger balances cost more.' },
        { segment: 'Helpline callers', restsOn: 'called the helpline', why: 'Intent is shown.' },
      ],
    }));
    expect(b.converters?.candidates).toHaveLength(1);
    expect(convertersSettled(b.converters)).toBe(false);
  });

  it('treats an unrecognised knowledge value as unknown, not as known', () => {
    // Failing open here would let a malformed payload skip the whole rule.
    const b = recordConverters(newBrief('o'), blank({ knowledge: 'maybe' as never }));
    expect(b.converters?.knowledge).toBe('unknown');
    expect(convertersSettled(b.converters)).toBe(false);
  });
});

describe('a campaign that cannot say who converts must be built to find out', () => {
  it('applies when nobody knows', () => {
    expect(mustLearnAudience({ shape: 'x', basis: 'user', knowledge: 'none-yet' })).toBe(true);
    expect(mustLearnAudience({ shape: 'x', basis: 'user', knowledge: 'unknown' })).toBe(true);
  });

  it('does not apply when the manager described them', () => {
    expect(mustLearnAudience({ shape: 'x', basis: 'user', knowledge: 'known' })).toBe(false);
  });
});

// An invented barrier must not come back as "You told me".
//
// THE LIVE FAILURE. Confirm refused a build the manager had approved with:
// "You told me: Customers may notice individual eligible-purchase pings but
// tune out…" — and later the same for first-time versus repeat EMI. They had
// said neither. The agent had floated both as rival theories, which is its
// job; three mechanisms then turned them into the manager's own words.
//
//   recordBarriers merged and never deleted, so a theory withdrawn on a
//   later turn stayed on the record for ever;
//   quoteIsTheirs scored 40% word overlap across the WHOLE transcript, which
//   in a long EMI conversation is nearly free, upgrading an assumption to
//   user-belief;
//   mustBeAddressed admitted assumptions, so coverage then demanded the
//   journey answer a theory nobody had raised.
describe('an invented barrier is the agent’s, not the manager’s', () => {
  const said = (text: string) => recordAnswer(newBrief('Raise OS-to-EMI conversion.'), text);
  const theirs = 'they think the interest is too expensive';

  it('excludes an assumption from what the campaign owes an answer to', () => {
    const mixed: Barrier[] = [
      { id: 'cost', statement: 'They think it is expensive.', basis: 'user-belief', lever: 'message' },
      { id: 'fatigue', statement: 'They tune out repeated pings.', basis: 'assumption', lever: 'message' },
    ];
    expect(mustBeAddressed(mixed).map((b) => b.id)).toEqual(['cost']);
    // Still designable, and still something the journey must TEST when it is
    // all there is — neither rule is loosened.
    expect(designableBarriers(mixed)).toHaveLength(2);
    expect(mustTestBarriers([mixed[1]])).toBe(true);
  });

  it('still owes an answer to a not-addressable barrier being excluded', () => {
    const bs: Barrier[] = [{ id: 'x', statement: 'A product problem.', basis: 'user', lever: 'not-addressable' }];
    expect(mustBeAddressed(bs)).toHaveLength(0);
  });

  describe('the quote has to be a phrase they typed', () => {
    const basisFor = (answer: string, quote: string) =>
      briefBarriers(
        recordBarriers(said(answer), [
          { id: 'b', statement: 'A barrier.', basis: 'assumption', lever: 'message', quote },
        ]),
      )[0]?.basis;

    it('upgrades on their exact words', () => {
      expect(basisFor(theirs, theirs)).toBe('user-belief');
    });

    it('upgrades on a near phrase, because a model paraphrases', () => {
      // Demanding a literal substring would reject honest attributions more
      // often than dishonest ones, and the record would then carry the
      // agent's label instead of their belief.
      expect(basisFor(theirs, 'the interest looks too expensive to them')).toBe('user-belief');
    });

    it('does NOT upgrade when they repeated the theory to reject it', () => {
      // The trap a contiguity check walks into on its own: the denial
      // contains the phrase verbatim.
      expect(basisFor('I did not say they tune out repeated pings', 'they tune out repeated pings')).toBe('assumption');
    });

    it('does NOT upgrade on a long answer that never states the rival', () => {
      // The live case. Scored across the whole transcript this cleared 40%
      // on "customers", "repeated" and "purchase" alone.
      const long =
        'every eligible purchase should get it, one track, do not split by customer type or by repeated purchase behaviour, and keep it simple';
      expect(basisFor(long, 'customers may notice individual eligible-purchase pings but tune out')).toBe('assumption');
    });

    it('still upgrades a barrier that is ITSELF about an absence', () => {
      // "not" appears in their own sentence; the denial test ignores words
      // that are part of the quote, so this is not mistaken for a rejection.
      const answer = 'they do not know how to set the PIN';
      expect(basisFor(answer, answer)).toBe('user-belief');
    });
  });

  describe('a sent list replaces; an omitted one is kept', () => {
    it('drops a rival the agent stopped naming', () => {
      let b = said(theirs);
      b = recordBarriers(b, [
        { id: 'cost', statement: 'They think it is expensive.', basis: 'user-belief', lever: 'message', quote: theirs },
        { id: 'fatigue', statement: 'They tune out repeated pings.', basis: 'assumption', lever: 'message' },
        { id: 'first-time', statement: 'First-time EMI users hesitate.', basis: 'assumption', lever: 'message' },
      ]);
      expect(briefBarriers(b)).toHaveLength(3);
      b = recordBarriers(b, [
        { id: 'cost', statement: 'They think it is expensive.', basis: 'user-belief', lever: 'message' },
      ]);
      expect(briefBarriers(b).map((x) => x.id)).toEqual(['cost']);
    });

    it('keeps the quote the update did not repeat', () => {
      // Terseness is not retraction, and the quote is the evidence of what
      // they said.
      let b = said(theirs);
      b = recordBarriers(b, [{ id: 'cost', statement: 'Expensive.', basis: 'user-belief', lever: 'message', quote: theirs }]);
      b = recordBarriers(b, [{ id: 'cost', statement: 'Expensive.', basis: 'user-belief', lever: 'timing' }]);
      expect(briefBarriers(b)[0].quote).toBe(theirs);
      expect(briefBarriers(b)[0].lever).toBe('timing');
    });

    it('does not wipe the barriers on a converters-only turn', () => {
      // `record_findings` may carry one field or both. Replace on SENT, keep
      // on OMITTED — the whole weight of the empty guard.
      let b = said(theirs);
      b = recordBarriers(b, [{ id: 'cost', statement: 'Expensive.', basis: 'user-belief', lever: 'message' }]);
      b = recordBarriers(b, undefined);
      b = recordBarriers(b, []);
      expect(briefBarriers(b)).toHaveLength(1);
    });
  });
});
