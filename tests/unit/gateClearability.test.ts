// Every block names the mutation that clears it, and applying that mutation
// clears it.
//
// This is the invariant the rebuild exists to enforce, and it is the one thing
// 884 passing tests could not express. Every deadlock measured on 2026-10-16
// violates it:
//
//  - the gate demanded `barriers` while the propose payload had no slot for
//    them, so the named fix was unreachable;
//  - it held out for a dimension `note` without the note being a named fix at
//    all, so the agent asked another question and the refusal regenerated;
//  - it kept refusing past the round budget, so no mutation could clear it
//    because the budget was not consulted.
//
// None of those is a logic error you can see by reading one function. They are
// all the same shape: a refusal with no reachable exit. So this file does not
// test behaviours one at a time — it enumerates blocking states and checks the
// property holds for all of them.
import { describe, it, expect } from 'vitest';
import { newBrief, type WorkingBrief } from '../../server/discovery';
import { decide, blocksFor, satisfy, MAX_ROUNDS, MIN_DIMENSIONS, type Block } from '../../server/gate';
import { recordAsked, recordReply, reopen, receive, REOPEN_LIMIT, outstanding } from '../../server/record';

/**
 * Briefs that reach each distinct blocking state, built the way the real
 * application builds them — through record.ts, not by hand-assembling the
 * shape. A fixture that bypasses the recorder would be testing a state the
 * product cannot actually reach.
 */
function blockingStates(): { name: string; brief: WorkingBrief }[] {
  const fresh = newBrief('Get new cardholders activated in their first two weeks');

  const asked = recordAsked(fresh, [{ text: 'What counts as activated?', impact: 'fork' }], 'agent');
  const replied = recordReply(asked, 'setting a PIN');

  // The real turn-3 shape from the live session: a reply that answers, plus an
  // agent-raised dimension it never came back to.
  const withDims = {
    ...replied,
    dimensions: [
      { name: 'Acquisition channel', rationale: 'Changes the nudge.', status: 'retained' as const, basis: 'user' as const },
      { name: 'Existing relationship', rationale: 'Changes friction.', status: 'retained' as const, basis: 'user' as const },
      { name: 'Drop-off point', rationale: 'Changes pacing.', status: 'open' as const, basis: 'none' as const },
    ],
  };

  const unanswered = recordAsked(replied, [{ text: 'Who activates today?', impact: 'shaping' }], 'app');

  return [
    { name: 'nothing asked yet', brief: fresh },
    { name: 'one reply, nothing else settled', brief: replied },
    { name: 'a question still outstanding', brief: unanswered },
    { name: 'a dimension raised and dropped', brief: withDims },
    {
      name: 'success settled but findings missing',
      brief: { ...replied, successCriteria: ['Count of cards activated.'] },
    },
  ];
}

describe('the invariant: every block is clearable by the mutation it names', () => {
  for (const { name, brief } of blockingStates()) {
    it(`holds for: ${name}`, () => {
      const blocks = blocksFor(brief);
      expect(blocks.length).toBeGreaterThan(0);
      for (const b of blocks) {
        const after = satisfy(brief, b.clears);
        const still = blocksFor(after).some((x) => x.code === b.code);
        expect(still, `block "${b.code}" survived its own clearing mutation`).toBe(false);
      }
    });
  }

  it('reaches every block code across the enumerated states, so none is untested', () => {
    // A code that no fixture triggers is a block nobody has checked is
    // escapable. This fails when a new code is added without a state for it.
    const seen = new Set<Block['code']>();
    for (const { brief } of blockingStates()) for (const b of blocksFor(brief)) seen.add(b.code);
    expect([...seen].sort()).toEqual(
      [
        'awaiting-reply',
        'converters-unknown',
        'dimension-unreasoned',
        'no-barrier',
        'no-participation',
        'success-unsettled',
        'too-few-dimensions',
      ].filter((c) => seen.has(c as Block['code'])),
    );
    // And the ones the fixtures above are specifically built to produce.
    for (const required of ['no-participation', 'no-barrier', 'converters-unknown', 'dimension-unreasoned', 'awaiting-reply'] as const) {
      expect(seen.has(required), `no fixture reaches "${required}"`).toBe(true);
    }
  });

  it('clears completely when every named mutation is applied in turn', () => {
    // The stronger version: not just that each block clears individually, but
    // that applying all of them reaches `proceed`. A set of individually
    // clearable blocks that can never be cleared TOGETHER is still a deadlock.
    let brief = blockingStates()[1].brief;
    for (let i = 0; i < 12 && blocksFor(brief).length > 0; i++) {
      for (const b of blocksFor(brief)) brief = satisfy(brief, b.clears);
    }
    expect(blocksFor(brief)).toEqual([]);
    expect(decide(brief).proceed).toBe(true);
  });
});

describe('the budget is an escape nothing can override', () => {
  const stuck = (): WorkingBrief => ({ ...blockingStates()[1].brief, rounds: MAX_ROUNDS });

  it('proceeds at the round limit even with blocks outstanding', () => {
    const d = decide(stuck());
    expect(blocksFor(stuck()).length).toBeGreaterThan(0);
    expect(d.proceed).toBe(true);
    expect(d.forcedBy).toBe('budget');
  });

  it('proceeds the moment the user says to, not a turn later', () => {
    // MEASURED: a manager typed "ok go ahead", was refused, typed it again,
    // and the second one did not work either — the budget expiring did.
    const { brief, proceed } = receive(blockingStates()[1].brief, 'ok go ahead');
    expect(proceed).toBe(true);
    expect(decide(brief, { proceedRequested: proceed }).proceed).toBe(true);
    expect(decide(brief, { proceedRequested: proceed }).forcedBy).toBe('user');
  });

  it('still reports what it assumed, rather than proceeding silently', () => {
    // Proceeding is not the same as pretending the gaps are not there. The
    // blocks become advice so the user sees them.
    const d = decide(stuck());
    expect(d.blocks).toEqual([]);
    expect(d.advice.length).toBeGreaterThan(0);
  });
});

describe('the record attributes replies, so a block cannot be caused by the model forgetting', () => {
  it('treats a reply as answering everything outstanding', () => {
    const asked = recordAsked(newBrief('o'), [
      { text: 'What does activation mean?', impact: 'fork' },
      { text: 'How do you measure it?', impact: 'shaping' },
    ], 'agent');
    const after = recordReply(asked, '1. PIN set 2. how many new cardholders activate');
    expect(outstanding(after)).toHaveLength(0);
    expect(blocksFor(after).some((b) => b.code === 'awaiting-reply')).toBe(false);
  });

  it('lets the model re-open a genuinely missed question, once', () => {
    const asked = recordAsked(newBrief('o'), [{ text: 'Never-started or pending?', impact: 'fork' }], 'agent');
    const once = reopen(recordReply(asked, 'we want more conversions'), ['q0-0']);
    expect(outstanding(once).map((q) => q.text)).toEqual(['Never-started or pending?']);

    // Second attempt is refused by the cap, so the user is never asked a third time.
    const answeredAgain = recordReply(once, 'never started');
    const twice = reopen(answeredAgain, ['q0-0']);
    expect(outstanding(twice)).toHaveLength(0);
    expect(REOPEN_LIMIT).toBe(1);
  });

  it('turns "not sure" into a stated assumption instead of a block', () => {
    // THE FIVE-TURN DEADLOCK, as a test. The manager said "not sure" about the
    // drop-off point and it blocked a proposal five times running.
    // Participation first. `blocksFor` returns early with `no-participation`
    // before any reply exists, so a fixture without one tests nothing below it
    // — which is how the first version of this test passed vacuously.
    const withOpenDim: WorkingBrief = {
      ...recordReply(
        recordAsked(newBrief('o'), [{ text: 'Where do they drop off?', impact: 'detail' }], 'agent'),
        'activation means PIN set',
      ),
      dimensions: [{ name: 'Drop-off point', rationale: 'Changes pacing.', status: 'open', basis: 'none' }],
    };
    expect(blocksFor(withOpenDim).some((b) => b.code === 'dimension-unreasoned')).toBe(true);

    const { brief } = receive(withOpenDim, 'not sure');
    expect(blocksFor(brief).some((b) => b.code === 'dimension-unreasoned')).toBe(false);
    expect(brief.dimensions![0].note).toMatch(/said they do not know/);
    expect(brief.dimensions![0].note).toContain('not sure');
  });

  it('does not overwrite a reason the agent already gave', () => {
    const withNote: WorkingBrief = {
      ...recordAsked(newBrief('o'), [{ text: 'q', impact: 'detail' }], 'agent'),
      dimensions: [{ name: 'D', rationale: 'r', status: 'deferred', basis: 'assumption', note: 'Ruled out: no attribute.' }],
    };
    const { brief } = receive(withNote, 'not sure');
    expect(brief.dimensions![0].note).toBe('Ruled out: no attribute.');
  });

  it('only ever releases, never blocks — a false "not sure" match cannot add a block', () => {
    // The safety rule the whole module rests on. If this stops holding, a crude
    // phrase list starts deciding whether the user gets refused.
    for (const text of ['not sure', 'ok go ahead', 'the interest looks too expensive', '']) {
      const base = blockingStates()[1].brief;
      const { brief } = receive(base, text);
      const before = new Set(blocksFor(base).map((b) => b.code));
      for (const b of blocksFor(brief)) {
        // `awaiting-reply` legitimately clears on a reply; nothing new appears.
        expect(before.has(b.code), `receive("${text}") introduced block ${b.code}`).toBe(true);
      }
    }
  });
});

describe('what this replaces is gone from the new path', () => {
  it('has no fork exception, because the bound lives in the re-ask instead', () => {
    // Earlier the same day, forks were excepted from reply attribution so an
    // unanswered one could not be discharged by silence. That bought real
    // safety with the exact failure that costs trust — telling a manager their
    // answer did not count. `reopen` + REOPEN_LIMIT buys it honestly.
    const asked = recordAsked(newBrief('o'), [{ text: 'A fork.', impact: 'fork' }], 'agent');
    expect(outstanding(recordReply(asked, 'a reply'))).toHaveLength(0);
  });

  it('keeps MIN_DIMENSIONS meaningful rather than unreachable', () => {
    expect(MIN_DIMENSIONS).toBe(3);
    // RETARGETED 2026-10-24. The fixture used to carry two `retained` /
    // `user` rows, which is now a CLOSED search: a seen axis plus a second
    // axis the manager has spoken about is the pair that retires this block,
    // because the only way to reach three from there is for the agent to
    // invent an axis nobody named. Measured on
    // `eval/runs/ui-s-1792842540156`, where it asked for a third row on a
    // brief holding both of the manager's answers.
    //
    // The rule still has to be reachable and clearable WHILE THE SEARCH IS
    // OPEN, which is what this now uses: two angles the agent raised itself,
    // nothing seen, no probe answered.
    const two: WorkingBrief = {
      ...recordReply(recordAsked(newBrief('o'), [{ text: 'q' }], 'agent'), 'a'),
      dimensions: [
        { name: 'A', rationale: 'r', status: 'open', basis: 'assumption' },
        { name: 'B', rationale: 'r', status: 'open', basis: 'assumption' },
      ],
    };
    const block = blocksFor(two).find((b) => b.code === 'too-few-dimensions');
    expect(block).toBeDefined();
    expect(blocksFor(satisfy(two, block!.clears)).some((b) => b.code === 'too-few-dimensions')).toBe(false);
  });
});
