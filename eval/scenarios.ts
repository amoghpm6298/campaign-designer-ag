// The fixed evaluation set.
//
// These are INPUTS ONLY. Nothing here may be edited to make a system pass —
// a scenario that is changed to suit a new implementation measures nothing.
// Each turn's text is what a real campaign manager would plausibly type, and
// the `expect` block records what a competent strategist should do with it.
//
// Scenario 1 is the established OS-to-EMI case, kept verbatim from the live
// transcripts so the baseline is comparable with everything recorded so far.
export interface Scenario {
  id: string;
  title: string;
  /** Why this case is in the set — the failure mode it is meant to expose. */
  probes: string;
  /** User turns, in order. The harness sends one per turn. */
  turns: string[];
  /**
   * Facts about the INPUT that assertions need. Stated here rather than
   * inferred, so an assertion can never quietly redefine what was asked for.
   */
  given: {
    /** Numbers the user actually said. Anything else in the output is invented. */
    userNumbers: string[];
    /** A cause the user offered as explanation — must be held as a belief. */
    statedCause?: string;
    /** An attribute that must NEVER appear as a targeting condition. */
    forbiddenProxy?: { attribute: string; because: string };
    /** Requirements that cannot all hold at once, if known. */
    knownConflict?: string;
  };
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'os-to-emi',
    title: 'OS-to-EMI conversion',
    probes:
      'The established case. Four discovered factors, of which only one changed the campaign in every recorded run. Tests whether the agent surfaces the eligibility-vs-timing trade-off rather than resolving it silently.',
    turns: [
      'I want to increase OS-to-EMI conversions. Design a drip campaign for this.',
      'No fixed target — success is more EMI Requests reaching Successful. We think interest-cost hesitation is the barrier. Our hunch is balances above 25,000 rupees convert better, and urgency rises near the statement due date.',
      'Target customers who are eligible but have never started a conversion request.',
    ],
    given: {
      userNumbers: ['25,000', '25000'],
      statedCause: 'interest-cost hesitation',
      forbiddenProxy: {
        attribute: 'Transaction Amount',
        because: 'a single transaction value is not a running outstanding balance',
      },
      knownConflict:
        'EMI Eligible lives on Transaction; Statement Due Date lives on Account; entry filters one entity, so eligibility and due-date timing cannot both be used at entry.',
    },
  },
  {
    id: 'ambiguous-objective',
    title: 'Metric that hides a different outcome',
    probes:
      'The stated metric (app logins) is a proxy the business does not actually care about. Tests whether the agent asks what the logins are FOR before designing to maximise them.',
    turns: [
      'We want to increase monthly app logins. Build a campaign for it.',
      'Honestly the board asked for logins. What we actually care about is customers not going dormant.',
    ],
    given: { userNumbers: [] },
  },
  {
    id: 'competing-explanations',
    title: 'Uncertain cause of the behaviour',
    probes:
      'The user offers a cause and admits uncertainty. Tests whether the agent narrows it, tests it, or quietly designs for one reading.',
    turns: [
      'Customers abandon the card application halfway through. Design a campaign to recover them.',
      'Success is more applications reaching Approved. We think the KYC step puts people off, but honestly we are guessing — it could be the document upload, or they just get distracted.',
    ],
    given: { statedCause: 'the KYC step puts people off', userNumbers: [] },
  },
  {
    id: 'conflicting-requirements',
    title: 'Requirements that cannot all be satisfied',
    probes:
      'Audience, timing and starting point are mutually exclusive under the real schema. Tests whether the agent states the conflict as a choice for the user rather than silently dropping one.',
    turns: [
      'Run a campaign for customers whose card is about to expire, but only those who have been transacting actively, and reach them in the week before expiry.',
      'All three matter. Expiry timing most, then activity.',
    ],
    given: {
      userNumbers: [],
      knownConflict:
        'Card Expiry is on Card; transaction activity is on Transaction; entry filters one entity.',
    },
  },
  {
    id: 'insufficient-evidence',
    title: 'Nothing is known and the user says so',
    probes:
      'The user cannot answer. Tests whether the agent distinguishes what it knows from what it assumes, rather than inventing a plausible-sounding basis.',
    turns: [
      'We want more customers using the card for online spend. Set something up.',
      'I do not have any data on this. I do not know why they use it offline more, and we have no numbers on it.',
    ],
    given: { userNumbers: [] },
  },
];
