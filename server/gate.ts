// One decision: may the agent propose, and if not, what exactly would change
// that?
//
// WHAT THIS COLLAPSES. Sixteen independent places could block the agent: nine
// checks inside `evaluateDiscovery`, four vetoes computed separately in the
// orchestrator and ORed with the gate's own outcome, five refusals in the
// architecture audits, and seven MAX_/MIN_ constants spread across two files.
// No single function could answer "why is this stuck", and on 2026-10-16 three
// of them turned out to be unclearable — the gate demanded a field the
// response template had no slot for, held out for a `note` nobody had been
// told to write, and kept refusing after the round budget was spent because
// the escape hatch was overridden by vetoes that never read it.
//
// THE INVARIANT, and the reason this file exists at all:
//
//   every Block names the mutation that clears it, and applying that mutation
//   clears it.
//
// `clears` is a REQUIRED field, so a block that cannot say what would fix it
// is not merely discouraged — it cannot be constructed. `satisfy()` below is
// the executable definition of each mutation, which is what lets the property
// test check the invariant instead of trusting it. Anything worth telling the
// agent that does NOT have a clearing mutation is advice, and advice does not
// block.
import type { WorkingBrief } from './discovery';
import { designableBarriers, convertersSettled, type Barrier, type Converters } from './findings';
import { outstanding, exhausted } from './record';

/** Lines of enquiry to weigh before designing. Being sure of one is not the same as having considered the alternatives. */
export const MIN_DIMENSIONS = 3;

/** Rounds of questions before the agent must work with what it has. */
export const MAX_ROUNDS = 8;

/**
 * A change to the record that would unblock the agent.
 *
 * Every variant is something the model can emit in one turn, or the
 * application can apply on the user's behalf. That is the test of whether a
 * block is fair: if nothing in this union would clear it, it should not be
 * blocking.
 */
export type Mutation =
  | { field: 'successCriteria'; how: string }
  | { field: 'converters'; how: string }
  | { field: 'barriers'; how: string }
  | { field: 'dimensions'; how: string }
  | { field: 'dimensionNote'; name: string; how: string }
  | { field: 'reply'; questionId: string; how: string };

export interface Block {
  /** Stable identity, so two turns can be compared and only the DELTA shown. */
  code:
    | 'no-participation'
    | 'success-unsettled'
    | 'converters-unknown'
    | 'converters-unreacted'
    | 'no-barrier'
    | 'too-few-dimensions'
    | 'dimension-unreasoned'
    | 'awaiting-reply';
  /** Said to the user, in their terms. Never names a field or an id. */
  reason: string;
  /** What would clear it. Required by construction. */
  clears: Mutation;
}

export interface Decision {
  proceed: boolean;
  blocks: Block[];
  /** Worth saying, but never a reason to refuse. */
  advice: string[];
  /** Why the agent is proceeding despite open blocks, when that applies. */
  forcedBy?: 'budget' | 'user';
}

/**
 * May the agent propose?
 *
 * THE BUDGET IS CHECKED FIRST AND NOTHING OVERRIDES IT. This is the shape of
 * the third deadlock: `evaluateDiscovery` already returned `ready_for_strategy`
 * at the round limit, and four vetoes computed elsewhere were ORed with it, so
 * the escape existed and was ignored. Here the escape is the first branch and
 * the blocks are reported as advice, so the agent proceeds AND the user still
 * sees what was assumed.
 */
export function decide(brief: WorkingBrief, opts: { proceedRequested?: boolean } = {}): Decision {
  const blocks = blocksFor(brief);
  const advice = adviceFor(brief);

  if (opts.proceedRequested) {
    return { proceed: true, blocks: [], advice: [...advice, ...blocks.map((b) => b.reason)], forcedBy: 'user' };
  }
  if (brief.rounds >= MAX_ROUNDS) {
    return { proceed: true, blocks: [], advice: [...advice, ...blocks.map((b) => b.reason)], forcedBy: 'budget' };
  }
  return { proceed: blocks.length === 0, blocks, advice };
}

/** Every reason the agent may not propose yet, most actionable first. */
export function blocksFor(brief: WorkingBrief): Block[] {
  const out: Block[] = [];

  // Has the user taken part at all? A record the agent filled in by itself is
  // not discovery, however complete it looks.
  if (brief.answers.length === 0) {
    out.push({
      code: 'no-participation',
      reason: 'I have not asked you anything yet, so a strategy now would be mine rather than yours.',
      clears: { field: 'reply', questionId: '', how: 'The user answers anything at all.' },
    });
    // Nothing below this is meaningful before the first exchange.
    return out;
  }

  const waiting = outstanding(brief);
  if (waiting.length > 0) {
    out.push({
      code: 'awaiting-reply',
      reason: `I am still waiting on this: ${waiting.map((q) => `"${q.text}"`).join(' and ')}`,
      clears: { field: 'reply', questionId: waiting[0].id, how: 'The user replies, or the question is assumed past.' },
    });
  }

  if (!(brief.successCriteria ?? []).length) {
    out.push({
      code: 'success-unsettled',
      reason: 'I still do not know how you would judge whether this worked, and that changes who the campaign goes after.',
      clears: { field: 'successCriteria', how: 'Record how the business would judge success, in their words.' },
    });
  }

  // TWO blocks, not one, and the clearability invariant is what forced the
  // split. `convertersSettled` deliberately requires a second turn when
  // nobody knows who converts: two candidate segments, AND a reply from the
  // manager after they were raised, because the agent treating its own
  // suggestion as agreed is the failure that rule guards against.
  //
  // One block could not describe that honestly. "Record who converts" does
  // not clear it, so the block named a fix that does not work — the exact
  // defect this gate exists to prevent, caught by the property test before it
  // reached a conversation. It also read badly: the agent said "I do not yet
  // know who does this today" on a turn where it had just put two candidates
  // up and was waiting to hear back.
  if (!convertersSettled(brief.converters, brief.answers.map((a) => a.round))) {
    const raised = typeof brief.converters?.raisedInRound === 'number';
    out.push(
      raised
        ? {
            code: 'converters-unreacted',
            reason: 'I have put up two possible groups to go after and I am waiting to hear which one you would back.',
            clears: { field: 'reply', questionId: '', how: 'The user reacts to the candidate segments.' },
          }
        : {
            code: 'converters-unknown',
            reason: 'I do not yet know who does this today, so I cannot say who the campaign should go after.',
            clears: {
              field: 'converters',
              how: 'Record who converts, or that nobody knows plus two candidate segments resting on different things.',
            },
          },
    );
  }

  if (designableBarriers(brief.barriers).length === 0) {
    out.push({
      code: 'no-barrier',
      reason: 'I do not yet know what is stopping them, so there is nothing for the campaign to work on.',
      clears: { field: 'barriers', how: 'Record at least one barrier traceable to something the user said.' },
    });
  }

  const dims = brief.dimensions ?? [];
  if (dims.length < MIN_DIMENSIONS) {
    out.push({
      code: 'too-few-dimensions',
      reason: `I have only weighed ${dims.length} angle${dims.length === 1 ? '' : 's'} so far, and being confident about one is not the same as having considered the alternatives.`,
      clears: { field: 'dimensions', how: `Raise at least ${MIN_DIMENSIONS} lines of enquiry.` },
    });
  }

  // A line of enquiry raised and then dropped with no reason. Ruling
  // something out is a decision, so it needs one.
  //
  // NOTE the narrowed condition. This used to also fire on
  // `basis: 'assumption'` with no note, which is what blocked a real session
  // for five turns: the agent's own assumption, about a thing the manager had
  // already said they could not settle. `settleUnknowns` in record.ts now
  // writes that note from the user's own "not sure", so by the time this runs
  // the only cases left are genuinely unexplained drops.
  for (const d of dims) {
    if (d.basis !== 'none') continue;
    if ((d.note ?? '').trim().length > 0) continue;
    out.push({
      code: 'dimension-unreasoned',
      reason: `I raised "${d.name}" and then let it go without saying why.`,
      clears: { field: 'dimensionNote', name: d.name, how: 'Say what was concluded or why it was ruled out.' },
    });
  }

  return out;
}

/**
 * True of the record, worth saying, and never a reason to refuse.
 *
 * This is where things go that the old gate turned into blocks it could not
 * clear. A question that has used up its one re-ask is the clearest case:
 * there is nothing the agent can do about it, so refusing on it can only
 * loop — but silently designing past it would hide a real gap.
 */
export function adviceFor(brief: WorkingBrief): string[] {
  const out: string[] = [];
  for (const q of exhausted(brief)) {
    out.push(`I asked "${q.text}" twice and will proceed on an assumption rather than ask a third time.`);
  }
  const unverified = (brief.barriers ?? []).filter((b: Barrier) => b.basis === 'assumption');
  if (unverified.length > 0 && designableBarriers(brief.barriers).length === unverified.length) {
    out.push('Every reason I have for their behaviour is my own inference, so the campaign should test it rather than assume it.');
  }
  return out;
}

/**
 * Apply a mutation, minimally, as the model or the application would.
 *
 * This is the executable definition of "what clears this block", and it exists
 * so the invariant can be TESTED rather than asserted in a comment. It is
 * deliberately the laziest possible satisfaction of each mutation: if the
 * smallest valid change does not clear the block, the block was not honestly
 * described.
 *
 * Not a product path. The real record is filled by the agent and the user.
 */
export function satisfy(brief: WorkingBrief, m: Mutation): WorkingBrief {
  switch (m.field) {
    case 'reply':
      return {
        ...brief,
        rounds: brief.rounds + 1,
        answers: [...brief.answers, { round: brief.rounds + 1, text: 'answered' }],
        questions: (brief.questions ?? []).map((q) =>
          q.addressedInRound === undefined
            ? { ...q, answeredInRound: brief.rounds + 1, addressedInRound: brief.rounds + 1 }
            : q,
        ),
      };
    case 'successCriteria':
      return { ...brief, successCriteria: ['More of the behaviour, counted.'] };
    case 'converters': {
      const converters: Converters = {
        shape: 'Nobody can say yet.',
        basis: 'user',
        knowledge: 'none-yet',
        // Raised NOW, so the next reply is what settles it. Setting this in
        // the past would fake the manager's reaction.
        raisedInRound: brief.rounds,
        candidates: [
          { segment: 'A', restsOn: 'existing relationship', why: 'already onboarded' },
          { segment: 'B', restsOn: 'acquisition channel', why: 'already self-served once' },
        ],
      };
      return { ...brief, converters };
    }
    case 'barriers': {
      const barrier: Barrier = {
        id: 'stated',
        statement: 'They are not being told to act.',
        basis: 'user',
        lever: 'message',
      };
      return { ...brief, barriers: [...(brief.barriers ?? []), barrier] };
    }
    case 'dimensions': {
      const dims = brief.dimensions ?? [];
      const add = Array.from({ length: Math.max(0, MIN_DIMENSIONS - dims.length) }, (_, i) => ({
        name: `Angle ${dims.length + i + 1}`,
        rationale: 'Could change who this reaches.',
        status: 'retained' as const,
        basis: 'user' as const,
      }));
      return { ...brief, dimensions: [...dims, ...add] };
    }
    case 'dimensionNote':
      return {
        ...brief,
        dimensions: (brief.dimensions ?? []).map((d) =>
          d.name.toLowerCase() === m.name.toLowerCase() ? { ...d, note: 'Ruled out, and here is why.' } : d,
        ),
      };
  }
}
