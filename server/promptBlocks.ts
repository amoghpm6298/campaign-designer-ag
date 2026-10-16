// What the agent was actually told, on a given turn.
//
// The system prompt is a fixed set of sections. The working brief is NOT: it is
// assembled per turn from what the conversation has established, so on any one
// turn roughly a third of its blocks are present and the rest are silent. That
// makes "why did it behave like that?" very hard to answer from the code alone
// — the answer is usually a block that did or did not fire.
//
// This module names those blocks so a run log can show them. It is read-only
// and changes no behaviour.
//
// HOW IT AVOIDS LYING: a block is detected by finding its marker in the REAL
// assembled brief text, never by re-evaluating the condition that produced it.
// A second copy of those conditions would drift from the first the next time
// one of them changed, and then the log would confidently report a prompt that
// was never sent. `tests/unit/promptBlocks.test.ts` asserts every marker below
// still appears for a brief state that should trigger it.

export interface PromptBlock {
  id: string;
  /** Plain label, for a reader who has not seen the code. */
  name: string;
  /** What it makes the agent do, in one sentence. */
  purpose: string;
  /** A substring that appears only when this block is included. */
  marker: string;
  /** Grouping for display. */
  group: 'record' | 'questions' | 'objective' | 'evidence';
}

/**
 * Blocks of the per-turn working brief, in the order they are assembled.
 *
 * Deliberately not exhaustive: this lists the blocks that CHANGE BEHAVIOUR and
 * so explain a turn. Headers and counts that are always present are covered by
 * the two always-on entries rather than itemised.
 */
export const BRIEF_BLOCKS: PromptBlock[] = [
  {
    id: 'facts',
    name: 'Settled facts',
    purpose: 'Lists what is already established so the agent does not ask for it again.',
    marker: 'Established (do NOT ask about these again):',
    group: 'record',
  },
  {
    id: 'dimensions',
    name: 'Dimension record',
    purpose: 'Replays what the agent itself recorded, so it stops restating the same factor in new words.',
    marker: 'Dimensions you have already recorded',
    group: 'record',
  },
  {
    id: 'limitations',
    name: 'Platform limitations',
    purpose: 'Carries forward what the platform cannot do, so the design stops proposing it.',
    marker: 'Limitations to carry into the strategy:',
    group: 'record',
  },
  {
    id: 'answered',
    name: 'Questions already answered',
    purpose: 'Names the questions the user genuinely answered, so they are not re-asked.',
    marker: 'Already asked and ANSWERED. Do not ask these again:',
    group: 'questions',
  },
  {
    id: 'pending',
    name: 'Questions still open',
    purpose: 'Names questions a reply arrived for but did not actually address.',
    marker: 'Asked, but the reply did NOT appear to answer these',
    group: 'questions',
  },
  {
    id: 'unclassified-impact',
    name: 'Unclassified question impact',
    purpose: 'Demands the agent say how much rides on a question before it can set it aside.',
    marker: 'no "impact" — I do not know what rides on',
    group: 'questions',
  },
  {
    id: 'fork-guard',
    name: 'Fork guard',
    purpose: 'Forbids proposing past a question the agent itself said would change the campaign.',
    marker: 'you yourself said would change the campaign',
    group: 'questions',
  },
  {
    id: 'fork-fallback',
    name: 'Fork fallback, not repetition',
    purpose: 'Tells the agent to apply a stated default when a fork goes unanswered instead of asking a third time.',
    marker: 'Repeating the question is not a fallback',
    group: 'questions',
  },
  {
    id: 'fork-declined',
    name: 'Declined fork claims',
    purpose: 'Reports which "this changes the campaign" claims the application refused, and why.',
    marker: 'but I am not treating',
    group: 'questions',
  },
  {
    id: 'resolutions',
    name: 'Resolve or carry',
    purpose: 'Requires every unanswered question to be carried or deferred by name, never dropped.',
    marker: 'naming the question id in "questionResolutions"',
    group: 'questions',
  },
  {
    id: 'beliefs',
    name: 'Untreated user beliefs',
    purpose: 'Forces a choice on a cause the user offered: test it, or carry it as a hypothesis.',
    marker: 'For each, take ONE of two exits',
    group: 'evidence',
  },
  {
    id: 'decide-before-propose',
    name: 'Decide before you propose',
    purpose: 'Stops the agent designing for one explanation without saying it chose.',
    marker: 'DECIDE BEFORE YOU PROPOSE',
    group: 'evidence',
  },
  {
    id: 'conflicts',
    name: 'Unresolved conflicts',
    purpose: 'Surfaces where what the user asked for and what the platform defines disagree.',
    marker: 'UNRESOLVED CONFLICTS between what the user said',
    group: 'evidence',
  },
  {
    id: 'evidence-requested',
    name: 'Data already requested',
    purpose: 'Stops the agent asking twice for data it has already requested or been refused.',
    marker: 'Data already requested:',
    group: 'evidence',
  },
  {
    id: 'sources-checked',
    name: 'Sources already checked',
    purpose: 'Records what was actually consulted, so retrieval is auditable rather than claimed.',
    marker: 'Sources already checked:',
    group: 'evidence',
  },
  {
    id: 'app-verdict',
    name: 'What the application found last time',
    purpose: 'Replays the verdicts the application reached on the previous proposal, so the agent can correct a design it has already been told is flawed.',
    marker: 'WHAT THE APPLICATION FOUND IN YOUR LAST PROPOSAL',
    group: 'evidence',
  },
  {
    id: 'objective-first',
    name: 'Objective round only',
    purpose: 'Reserves the opening round for what success means, because that answer decides which other questions are worth asking.',
    marker: 'THIS ROUND IS FOR THE OBJECTIVE AND NOTHING ELSE',
    group: 'objective',
  },
  {
    id: 'objective-record',
    name: 'Record the objective now',
    purpose: 'Says the user has already answered, so record it rather than asking again.',
    marker: 'How success is to be judged: NOT YET RECORDED',
    group: 'objective',
  },
  {
    id: 'objective-settled',
    name: 'Objective settled',
    purpose: 'Replays the agreed definition of success so the design is measured against it.',
    marker: 'How success is to be judged, already settled:',
    group: 'objective',
  },
];

/** Blocks present in an assembled brief. Order follows BRIEF_BLOCKS. */
export const blocksIn = (briefText: string): PromptBlock[] =>
  BRIEF_BLOCKS.filter((b) => briefText.includes(b.marker));

/** Blocks absent, so a reader can see what did NOT apply and why that matters. */
export const blocksAbsent = (briefText: string): PromptBlock[] =>
  BRIEF_BLOCKS.filter((b) => !briefText.includes(b.marker));

/**
 * The fixed sections of the system prompt.
 *
 * Unlike the brief, these are present on every turn, so the useful thing to
 * show is what each one is responsible for.
 */
export const SYSTEM_SECTIONS: { name: string; purpose: string }[] = [
  {
    name: 'Role and boundary',
    purpose: 'The agent does the business reasoning; application code builds the graph and owns every id.',
  },
  {
    name: 'GROUND RULES',
    purpose: 'No invented performance numbers, no asserted causes, mock data treated as unverified, hard constraints respected.',
  },
  {
    name: 'HOW TO DESIGN A CAMPAIGN',
    purpose: 'The method: settle the objective, investigate what could change it, compare candidate architectures, then choose and justify.',
  },
  {
    name: 'QUESTIONS AND OPEN ITEMS',
    purpose: 'How to ask, what to declare about each question, and what may not be assumed away.',
  },
  {
    name: 'Response contract',
    purpose: 'The exact JSON shape for ask, request_evidence and propose, including the fields the application later verifies.',
  },
];
