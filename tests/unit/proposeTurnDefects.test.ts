// Two defects from the PIN-activation propose turn, 2026-10-21.
//
// Both were visible in the same four-turn run, and both were the application
// speaking badly about state it already had.
//
//   1. The proposal printed the literal word `undefined` three times, under
//      each of the two candidate approaches: "Who it reaches: undefined",
//      "Why it should work: undefined", "What it gives up: undefined". The
//      model had written real text for two of those — the audience sentence
//      and the trade-off — and the chosen candidate's rationale was dropped
//      without a trace.
//
//   2. The gate held on who converts, and said: "I have put up two possible
//      groups to go after and I am waiting to hear which one you would back."
//      Then it re-asked "who tends to do this already today". The manager had
//      already said they have no visibility on it, and the agent had already
//      named two guess-groups resting on different things. That IS the
//      question answered, and asking which guess to back is asking the
//      manager to make a targeting decision the campaign exists to settle.
import { describe, it, expect } from 'vitest';
import { renderStrategy, type Strategy } from '../../server/orchestrator';
import { applyOutputTool } from '../../server/outputTools';
import { newBrief, recordAnswer, recordBarriers, recordConverters, recordDimensions, briefForPrompt, evaluateDiscovery, type WorkingBrief } from '../../server/discovery';
import { blocksFor } from '../../server/gate';
import { convertersSettled, mustLearnAudience } from '../../server/findings';

// ---------------------------------------------------------------- 1. render

/** The two candidates as the model actually sent them, trimmed. */
const ARCHITECTURES_AS_SENT = [
  {
    name: 'Know-how only: simple instructional journey, tiered by credit limit',
    barrier: 'know-how',
    lever: 'message',
    audience: 'All new cardholders not yet PIN-set, split only by credit-limit tier for cadence intensity',
    timing: 'Fixed cadence from day 0 to day 14, tiered by credit limit',
    journey: 'linear',
    measurement: 'Can track PIN-set rate by tier only',
    tradeOff: 'Acts immediately and simply, but assumes know-how is the real barrier.',
    chosen: false,
    why: 'Rejected because it treats one guessed barrier as settled fact.',
  },
  {
    name: 'Motivation treated as a real, untested barrier',
    barrier: 'motivation',
    lever: 'message content test',
    audience: 'All new cardholders issued a card and not yet PIN-set, randomly split into a how-to arm, a reason-to-use arm and a small no-message holdout',
    timing: 'Entry at card issuance; checkpoints at day 0, 3-4, 8-9 and 13',
    journey: 'experiment',
    measurement: 'Compare PIN-set rate within 14 days across the arms and the holdout',
    tradeOff: 'Splits the cohort into more cells, so it reads more slowly.',
    chosen: true,
    why: 'You said "probably both" when asked which barrier is stopping activation.',
  },
];

const base = (over: Partial<Strategy> = {}): Strategy => ({
  summary: 'New cardholders who have not set their PIN enter a 14-day activation journey.',
  approach: ['Entry at card issuance.'],
  assumptions: [],
  unknowns: [],
  ...over,
});

/** Put the architectures through the tool, which is the only way they arrive. */
const recordPlan = (architectures: unknown[]): Strategy => {
  const out = applyOutputTool(
    recordBarriers(recordAnswer(newBrief('Get new cardholders activated'), 'they do not know how, or do not see a reason yet'), [
      { id: 'know-how', statement: 'They do not know how to set the PIN.', basis: 'user-belief', lever: 'message', quote: 'they do not know how' },
      { id: 'motivation', statement: 'They do not see a reason to use the card yet.', basis: 'user-belief', lever: 'message', quote: 'do not see a reason yet' },
    ]),
    'propose_strategy',
    { ...base(), architectures },
  );
  expect(out.error, out.error).toBeUndefined();
  return out.strategy as Strategy;
};

describe('an approach never prints the word undefined', () => {
  it('shows what the model wrote for who it reaches, when and what it gives up', () => {
    // The field names disagreed: the tool schema asks for `audience`,
    // `tradeOff` and `why`; everything downstream reads `entry`, `tradeoff`
    // and `whyChosen`. Reconciled at the tool boundary, so the text survives
    // instead of being silently replaced by a label and `undefined`.
    const out = renderStrategy(recordPlan(ARCHITECTURES_AS_SENT));
    expect(out).not.toContain('undefined');
    expect(out).toContain('Who it reaches: All new cardholders issued a card and not yet PIN-set');
    expect(out).toContain('What it gives up: Splits the cohort into more cells');
    // The best sentence in the proposal, previously dropped without a trace.
    expect(out).toContain('Why this one: You said "probably both"');
  });

  it('omits the line entirely when the field is blank, rather than labelling nothing', () => {
    // A label with nothing after it reads as a question put to the manager —
    // "who does this reach?" — about a plan that has already said.
    const out = renderStrategy(
      recordPlan([
        { name: 'A', barrier: 'know-how', timing: 'Day 0 to day 14' },
        { name: 'B', barrier: 'motivation', timing: 'Day 0 only' },
      ]),
    );
    expect(out).not.toContain('undefined');
    expect(out).not.toMatch(/Who it reaches:\s*$/m);
    expect(out).not.toContain('Who it reaches');
    expect(out).not.toContain('What it gives up');
    expect(out).not.toContain('Why it should work');
    // What IS there still renders.
    expect(out).toContain('When: Day 0 to day 14');
    expect(out).toContain('The problem: know-how');
  });

  it('never prints a bare label for any architecture field, on any mix of blanks', () => {
    // The general form, so the next field added cannot reintroduce this.
    const LABELS = ['The problem', 'What it does', 'Who it reaches', 'When', 'Why it should work', 'You would know it worked by', 'What it gives up', 'Why this one'];
    for (const fields of [{}, { audience: '   ' }, { tradeOff: '' }, { why: '' }, { timing: 'Day 0' }]) {
      const out = renderStrategy(
        recordPlan([
          { name: 'A', barrier: 'know-how', ...fields },
          { name: 'B', barrier: 'motivation', ...fields },
        ]),
      );
      expect(out, JSON.stringify(fields)).not.toContain('undefined');
      for (const label of LABELS) {
        expect(out.includes(`${label}:\n`), `${label} printed with nothing after it`).toBe(false);
        expect(out.trimEnd().endsWith(`${label}:`), `${label} printed with nothing after it`).toBe(false);
      }
    }
  });
});

// ------------------------------------------------------------ 2. converters

/**
 * The run's state: the manager has no visibility, and the agent has named
 * two guess-groups resting on different things.
 */
const pinActivation = (): WorkingBrief => {
  let b = recordAnswer(
    newBrief('I want more new cardholders to activate their cards.'),
    'honestly we have no visibility on who already activates without a nudge',
  );
  b = recordConverters(b, {
    // BASIS IS THE AGENT'S OWN, deliberately, and it is what makes this group
    // of tests about candidates at all. Since 2026-10-22 a user-stated shape
    // settles the finding on its own, so a fixture with `basis: 'user'` would
    // pass every assertion below without a candidate rule ever running. This
    // shape is the agent characterising a non-answer, which is an assumption
    // either way.
    shape: 'No converter pattern the manager trusts yet.',
    basis: 'assumption',
    knowledge: 'none-yet',
    candidates: [
      { segment: 'Cardholders who signed up through a welcome offer', restsOn: 'the acquisition incentive attached at sign-up', why: 'A reward tied to first use is its own reason to act.' },
      { segment: 'Cardholders who already hold another active product', restsOn: 'an existing relationship and trust with the issuer', why: 'Familiarity removes first-time friction.' },
    ],
  });
  b = recordBarriers(b, [
    { id: 'know-how', statement: 'They do not know how to set the PIN.', basis: 'user-belief', lever: 'message', quote: 'no visibility on who already activates' },
  ]);
  return recordDimensions(b, [
    { name: 'Days since the card was issued', rationale: 'Early silence may differ from late.', status: 'retained', basis: 'user' },
    { name: 'Assigned credit limit', rationale: 'Higher limits may activate faster.', status: 'retained', basis: 'user' },
    { name: 'App installed on the phone', rationale: 'Decides whether a how-to can be acted on.', status: 'deferred', basis: 'assumption', note: 'No attribute for it, so assumed present.' },
  ]);
};

describe('unknown plus two candidates IS who-converts settled', () => {
  it('settles the finding on the turn the candidates are recorded', () => {
    expect(convertersSettled(pinActivation().converters)).toBe(true);
  });

  it('does not block the proposal on converters', () => {
    expect(blocksFor(pinActivation()).map((b) => b.code)).not.toContain('converters-unknown');
  });

  it('never says it is waiting to hear which group to back', () => {
    // The sentence the run produced, and the block it came from. Both gone:
    // `converters-unreacted` was deleted rather than left unreachable.
    for (const b of blocksFor(pinActivation())) {
      expect(b.reason).not.toMatch(/which one you would back/);
      expect(b.code).not.toBe('converters-unreacted');
    }
  });

  it('does not ask who tends to do this already', () => {
    // The generic fallback question `evaluateDiscovery` reaches for when the
    // finding is open. With the finding settled it must not be generated —
    // the manager has already answered it, with "we have no visibility".
    const out = evaluateDiscovery({
      brief: pinActivation(),
      modelAction: 'propose',
      modelQuestions: [],
      maxRounds: 8,
    } as never);
    const asked = (out.questions ?? []) as ({ text: string } | string)[];
    for (const q of asked) {
      expect(typeof q === 'string' ? q : q.text).not.toMatch(/who tends to do this already/i);
    }
  });

  it('keeps the obligation where it belongs — on the design, not the record', () => {
    // This is what makes dropping the reply requirement safe. The campaign
    // still may not target a guess as if it were known: it has to be built so
    // the candidates can be told apart, and `checkAudienceLearning` refuses a
    // flat single-audience journey when this is true.
    expect(mustLearnAudience(pinActivation().converters)).toBe(true);
  });

  it('does not reopen when the manager rejects the guesses', () => {
    // "Do not target off those guesses" is agreement about the state of
    // knowledge, not a refusal to answer. Under the old rule it had nowhere
    // to land: any reply settled the finding and no reply left it open.
    let b = pinActivation();
    b = { ...b, rounds: b.rounds + 1 };
    b = recordAnswer(b, 'do not target off those two guesses, we genuinely do not know');
    expect(convertersSettled(b.converters)).toBe(true);
    expect(blocksFor(b).map((x) => x.code)).not.toContain('converters-unknown');
  });

  it('still blocks when nobody knows and only one guess was offered', () => {
    // The rule that remains, and where it now applies: a shape the AGENT
    // supplied. One candidate is a guess dressed as analysis; two resting on
    // different things is a set of options a campaign can actually tell apart.
    // A shape the MANAGER stated settles the finding by itself.
    const b = recordConverters(pinActivation(), {
      shape: 'No pattern yet.',
      basis: 'assumption',
      knowledge: 'none-yet',
      candidates: [{ segment: 'Welcome-offer sign-ups', restsOn: 'the acquisition incentive', why: 'A reward is its own reason.' }],
    });
    expect(convertersSettled(b.converters)).toBe(false);
    expect(blocksFor(b).map((x) => x.code)).toContain('converters-unknown');
    // And the brief says what would clear it, which is the invariant.
    expect(briefForPrompt(b).length).toBeGreaterThan(0);
  });
});
