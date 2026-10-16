// Counterfactual pairs: change the business problem, demand a different answer.
//
// Every other check in this harness asks whether ONE run was internally sound.
// None of them can detect the failure that actually matters — that the agent
// produces the same conventional campaign regardless of what it was told. A
// pair catches it directly: two runs, one material difference in the business
// problem, and a declared expectation of what must change as a result.
//
// INPUTS AND EXPECTATIONS ONLY. The `mustDiffer` list on each pair is written
// BEFORE the pair is ever run, and may not be edited to match an observed
// result — a counterfactual whose expectation is tuned to the output measures
// nothing at all. If an expectation turns out to be wrong about what a good
// strategist would do, the fix is to argue that in review and retire the pair,
// not to quietly relax it.
import type { Aspect } from './divergence';

export interface Arm {
  /** Short tag for the report. */
  label: string;
  turns: string[];
}

export interface CounterfactualPair {
  id: string;
  title: string;
  /** The single material thing that changes between the arms. */
  varies: string;
  a: Arm;
  b: Arm;
  /**
   * Aspects that MUST differ between the two resulting campaigns. Declared in
   * advance, from what a competent strategist would have to change.
   */
  mustDiffer: Aspect[];
  /** Why those aspects and not others. The argument, recorded. */
  because: string;
  /**
   * Set when "a drip campaign is the wrong instrument here" is a CORRECT
   * answer for arm B. Then B refusing to build, and explaining the commercial
   * or operational intervention instead, counts as a pass — otherwise the
   * harness would penalise the agent for being right.
   */
  passIfNotExecutable?: boolean;
  /**
   * Set when a known platform gap could cause a failure here for reasons that
   * have nothing to do with reasoning quality. Printed with the result so a
   * failure is never read as a reasoning failure by default.
   */
  knownPlatformLimit?: string;
  /** The question a human must answer that no signature can. */
  humanMustJudge: string;
}

const OS_EMI_OPEN = 'I want to increase OS-to-EMI conversions. Design a drip campaign for this.';

// Every arm ends with these two, and the reason is a measured defect in the
// FIRST version of these pairs, which gave each arm only three turns.
//
// All six arms ran out of turns still in discovery, so not one produced a
// campaign and the comparison measured nothing. The cause was not the agent
// stalling: it asked whether success meant the COUNT or the VALUE of
// conversions, asked it again when the scripted reply did not address it, and
// asked a third time saying it would not choose that trade-off on the user's
// behalf. It was right to refuse. The script was simply not answering.
//
// So each arm now answers the goal question explicitly, then says it has
// nothing further, then asks for the proposal — which is what the live
// happy-path simulation does and what a real campaign manager does. Without a
// blueprint at the end there is nothing to compare, and a pair that cannot
// reach a proposal tests the harness rather than the agent.
const EXHAUSTED = 'That is everything I have. I do not have any further breakdown or data on this.';
const PROPOSE = 'Go ahead and propose the campaign.';

export const PAIRS: CounterfactualPair[] = [
  {
    id: 'barrier-comprehension-vs-price',
    title: 'The cost is misunderstood vs the cost is genuinely uncompetitive',
    varies:
      'Whether interest-cost hesitation means customers misread the cost, or correctly read it and find it worse than their alternatives.',
    a: {
      label: 'misunderstood',
      turns: [
        OS_EMI_OPEN,
        'Success is the NUMBER of EMI Requests reaching Successful — count, not value. On why they do not convert: we think people hesitate because they do not realise what converting actually costs them. They assume it is worse than it is.',
        'Target customers who are eligible but have never started a conversion request.',
        EXHAUSTED,
        PROPOSE,
      ],
    },
    b: {
      label: 'uncompetitive',
      turns: [
        OS_EMI_OPEN,
        'Success is the NUMBER of EMI Requests reaching Successful — count, not value. On why they do not convert: we surveyed the ones who drop off. They understand the cost perfectly well. Our EMI rate is just higher than the other credit they can get, so they use that instead.',
        'Target customers who are eligible but have never started a conversion request.',
        EXHAUSTED,
        PROPOSE,
      ],
    },
    mustDiffer: ['audience'],
    because:
      'If the cost is misread, a message that corrects the misreading can plausibly work on the whole eligible base. If the cost is genuinely uncompetitive, no message changes the price — the only honest campaign-shaped move is to narrow to the sub-segment for whom this rate IS the better option, which is a different audience. Designing the same broad campaign for both means the survey finding changed nothing.',
    passIfNotExecutable: true,
    humanMustJudge:
      'In arm B, did it recognise that messaging cannot fix a price, and say what would?',
  },

  {
    id: 'goal-count-vs-value',
    title: 'Maximise the number of conversions vs the value converted',
    varies: 'Whether success is counted in conversions or measured in rupees of balance converted.',
    a: {
      label: 'count',
      turns: [
        OS_EMI_OPEN,
        'Success is the NUMBER of EMI Requests reaching Successful. We want as many customers converting as possible, the size does not matter to us. We think interest-cost hesitation is the barrier, though we are not certain.',
        'Target customers who are eligible but have never started a conversion request.',
        EXHAUSTED,
        PROPOSE,
      ],
    },
    b: {
      label: 'value',
      turns: [
        OS_EMI_OPEN,
        'Success is the total VALUE of balance converted. Ten large conversions are worth more to us than a hundred small ones. We think interest-cost hesitation is the barrier, though we are not certain.',
        'Target customers who are eligible but have never started a conversion request.',
        EXHAUSTED,
        PROPOSE,
      ],
    },
    mustDiffer: ['audience'],
    because:
      'A count goal rewards reach and argues for the broadest eligible audience. A value goal rewards concentration and argues for narrowing to customers whose balances are large enough to matter. Those are different audiences. Identical targeting under both goals means the stated objective had no influence on the design.',
    knownPlatformLimit:
      'No attribute anywhere carries a running outstanding balance, so the axis the value goal actually wants cannot be filtered directly. A failure here may be this gap rather than weak reasoning — but the agent can still narrow on a stated proxy, or state plainly that the value goal is untargetable and why. Doing neither is a reasoning failure.',
    humanMustJudge:
      'Under the value goal, did it either narrow on a defensible proxy or say outright that value cannot be targeted here — or did it quietly design for count anyway?',
  },

  {
    id: 'cause-customer-vs-operational',
    title: 'The customer stalls vs the bank stalls',
    varies:
      'Whether the drop-off is something the customer does inside the flow, or something the bank does after the customer has finished.',
    a: {
      label: 'customer-stalls',
      turns: [
        'Customers abandon the card application halfway through. Design a campaign to recover them.',
        'Success is the NUMBER of applications reaching Approved, not the value. We are fairly confident it is the KYC step — people get to it and stop.',
        'Target anyone who started an application in the last 30 days and has not been approved.',
        EXHAUSTED,
        PROPOSE,
      ],
    },
    b: {
      label: 'bank-stalls',
      turns: [
        'Customers abandon the card application halfway through. Design a campaign to recover them.',
        'Success is the NUMBER of applications reaching Approved, not the value. Actually we looked properly — they finish the whole application. Then our underwriting takes three days, and by the time we approve they have taken a card from someone else.',
        'Target anyone who started an application in the last 30 days and has not been approved.',
        EXHAUSTED,
        PROPOSE,
      ],
    },
    mustDiffer: ['timing', 'shape'],
    because:
      'An in-flow stall is addressed where the customer stopped, before they finish. A post-submission delay cannot be addressed there at all — the customer has already done everything asked of them. Any honest intervention for B sits in the waiting window and can only hold attention or set expectations, which is a different moment and a different journey. If both arms produce the same journey, the agent did not register that the problem moved from the customer to the bank.',
    passIfNotExecutable: true,
    humanMustJudge:
      'In arm B, did it say that the real fix is the three-day underwriting turnaround and that a campaign can at best buy time — or did it design a recovery sequence as if the customer were the problem?',
  },
];
