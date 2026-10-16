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
    expect(convertersSettled(b.converters, b.answers.map((a) => a.round))).toBe(true);
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

describe('who converts today — when NOBODY knows', () => {
  // The case that matters most and was wrong first time round: "they have no
  // data on this" used to close the question, so the one situation where the
  // agent needed to think hardest was the one it was allowed to skip.
  const blank = (over = {}) => ({ shape: 'nobody has converted yet', basis: 'user' as const, knowledge: 'none-yet' as const, ...over });

  it('is NOT settled just because the manager said they have no idea', () => {
    const b = recordConverters(newBrief('o'), blank());
    expect(convertersSettled(b.converters, [0, 1])).toBe(false);
  });

  it('is NOT settled by a single candidate segment, which is a guess', () => {
    const b = recordConverters(newBrief('o'), blank({
      candidates: [{ segment: 'High spenders', restsOn: 'balance size', why: 'Larger balances cost more to carry.' }],
    }));
    expect(convertersSettled(b.converters, [0, 1, 2])).toBe(false);
  });

  it('is NOT settled while the manager has had no chance to react', () => {
    // The agent proposing a target and treating its own suggestion as agreed
    // is the failure this guards, and a fresh campaign is where it is most
    // tempting.
    let b = newBrief('o');
    b = recordConverters(b, blank({
      candidates: [
        { segment: 'High spenders', restsOn: 'balance size', why: 'Larger balances cost more to carry.' },
        { segment: 'Recent big-ticket buyers', restsOn: 'recent purchase size', why: 'A single large purchase is the classic EMI trigger.' },
      ],
    }));
    expect(b.converters?.raisedInRound).toBe(0);
    expect(convertersSettled(b.converters, [])).toBe(false);
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
    expect(convertersSettled(b.converters, b.answers.map((a) => a.round))).toBe(true);
  });

  it('rejects a candidate with no reasoning behind it', () => {
    const b = recordConverters(newBrief('o'), blank({
      candidates: [
        { segment: 'High spenders', restsOn: 'balance size', why: '' },
        { segment: 'Recent big-ticket buyers', restsOn: 'recent purchase size', why: 'A large purchase is the classic trigger.' },
      ],
    }));
    expect(b.converters?.candidates).toHaveLength(1);
    expect(convertersSettled(b.converters, [0, 1, 2])).toBe(false);
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
    expect(convertersSettled(b.converters, [0, 1, 2])).toBe(false);
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
    expect(convertersSettled(b.converters, b.answers.map((a) => a.round))).toBe(true);
  });

  it('drops a candidate that does not say what it rests on', () => {
    const b = recordConverters(newBrief('o'), blank({
      candidates: [
        { segment: 'High spenders', restsOn: '', why: 'Larger balances cost more.' },
        { segment: 'Helpline callers', restsOn: 'called the helpline', why: 'Intent is shown.' },
      ],
    }));
    expect(b.converters?.candidates).toHaveLength(1);
    expect(convertersSettled(b.converters, [0, 1, 2])).toBe(false);
  });

  it('treats an unrecognised knowledge value as unknown, not as known', () => {
    // Failing open here would let a malformed payload skip the whole rule.
    const b = recordConverters(newBrief('o'), blank({ knowledge: 'maybe' as never }));
    expect(b.converters?.knowledge).toBe('unknown');
    expect(convertersSettled(b.converters, [0, 1])).toBe(false);
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
