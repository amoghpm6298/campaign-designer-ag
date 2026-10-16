// The "agent" for this vertical slice: a DETERMINISTIC planner, not an
// LLM call. That is deliberate — this slice exists to prove the plumbing
// (schema from source → context → plan → build via the app's own reducer →
// validate with the app's own validators → structured run record). Putting
// a model in now would make every failure ambiguous between a plumbing bug
// and a generation bug.
//
// Where a real agent would reason, this records the decision AND its basis
// (user answer / bank constraint / principle / assumption), which is the
// part the architecture actually has to carry. Swapping this for a model
// later means replacing plan() and keeping everything around it.
import { dcConfirmAddNode, type DcAddingAt } from '../src/reducer/campaignReducer';
import { dcDefaultConfig } from '../src/reducer/defaultConfig';
import type { Channel } from '../src/data/sharedConstants';
import { selectTemplate, type TemplateChoice, type TemplateNeed } from './templateSelect';
import { maxSendsOnAnyPath } from './graphPaths';
import type { DripGraph, DripGoal } from '../src/data/graphTypes';

export type DecisionBasis = 'user-answer' | 'bank-hard-constraint' | 'bank-preference' | 'principle' | 'assumption';

export interface Decision {
  step: string;
  decision: string;
  basis: DecisionBasis;
  /** Where this came from — a scenario answer key, a context path, or a principle id. */
  reference: string;
  /** Present only when basis is 'assumption': what we did not know. */
  unknown?: string;
}

export interface TraceEntry {
  seq: number;
  at: string;
  kind: 'context-load' | 'question' | 'decision' | 'build' | 'validate' | 'note';
  message: string;
  data?: unknown;
}

/** A step for which no suitable existing template was found. Carries the
 *  proposal so a reviewer can act on it; never a fabricated template id. */
export type TemplateGap = { step: string } & Extract<TemplateChoice, { kind: 'proposal' }>;

/** Thrown when a campaign cannot be completed because a required template
 *  does not exist. Explicit failure, not a misleading reference. */
export class TemplateGapError extends Error {
  readonly gaps: TemplateGap[];
  constructor(message: string, gaps: TemplateGap[]) {
    super(message);
    this.name = 'TemplateGapError';
    this.gaps = gaps;
  }
}

export interface RoutingIntent {
  /** Nodes the planner deliberately fanned out from, and why. A fan-out
   *  NOT listed here is unintended — see validate.ts's entry-fan-out check. */
  fanOut: { nodeId: string; reason: string }[];
}

export interface PlanResult {
  graph: DripGraph;
  goal: DripGoal | null;
  routingIntent: RoutingIntent;
  /** Empty when every step matched an existing template. */
  templateGaps: TemplateGap[];
  decisions: Decision[];
  assumptions: Decision[];
  conversation: { role: 'agent' | 'user'; text: string }[];
  trace: TraceEntry[];
}

interface BankContext {
  bank: { id: string; displayName: string };
  channels: { available: { channel: string; relativeCost: number; available: boolean }[] };
  hardConstraints: {
    maxMessagesPerCustomerPerCampaign: { value: number };
    minHoursBetweenMessages: { value: number };
  };
  softPreferences: { preferredControlGroupPct: { value: number }; preferLowerCostChannelFirst: { value: boolean } };
}

interface Scenario {
  scenarioId: string;
  goalStatement: string;
  simulatedAnswers: Record<string, { question: string; answer: string; resolved: boolean; note?: string }>;
}

/** The window the opportunity stays open, per P-003 (verified). */
const RESOLUTION_WINDOW_HOURS = 7 * 24;

export function plan(scenario: Scenario, bank: BankContext): PlanResult {
  const decisions: Decision[] = [];
  const routingIntent: RoutingIntent = { fanOut: [] };
  const templateGaps: TemplateGap[] = [];
  const conversation: { role: 'agent' | 'user'; text: string }[] = [];
  const trace: TraceEntry[] = [];
  let seq = 0;
  const t = (kind: TraceEntry['kind'], message: string, data?: unknown) =>
    trace.push({ seq: ++seq, at: new Date().toISOString(), kind, message, data });

  const decide = (step: string, decision: string, basis: DecisionBasis, reference: string, unknown?: string) => {
    const d: Decision = { step, decision, basis, reference, ...(unknown ? { unknown } : {}) };
    decisions.push(d);
    t('decision', `${step}: ${decision}`, { basis, reference });
    return d;
  };

  t('context-load', `Loaded bank context: ${bank.bank.displayName}`);
  t('context-load', `Loaded scenario: ${scenario.scenarioId}`);

  conversation.push({ role: 'user', text: scenario.goalStatement });
  conversation.push({
    role: 'agent',
    text: 'Understood. I have a few questions before I design this, then I will show you the campaign and what I assumed.',
  });

  // Replay the bounded Q&A from the scenario. A real agent would select
  // these; here the selection is fixed so the run is reproducible.
  for (const [key, qa] of Object.entries(scenario.simulatedAnswers)) {
    t('question', `Asked: ${qa.question}`, { key, resolved: qa.resolved });
    conversation.push({ role: 'agent', text: qa.question });
    conversation.push({ role: 'user', text: qa.answer });
  }

  // --- Goal -------------------------------------------------------------
  // The user said success = the EMI request ends Successful. That maps to
  // a real event category/type and a real attribute from the app's own
  // vocabulary (EMI Events / EMI_STATUS_CHANGED / New Status).
  const goal: DripGoal = {
    eventCategory: 'EMI Events',
    eventType: 'EMI_STATUS_CHANGED',
    conditions: [{ attribute: 'New Status', operator: 'Equals', value: 'Successful' }],
  };
  decide('goal', 'EMI_STATUS_CHANGED where New Status = Successful', 'user-answer', 'simulatedAnswers.goal_event');

  // --- Channel ----------------------------------------------------------
  // The user did not answer. Fall back to the bank's stated preference,
  // and record it as an assumption — NOT as an optimisation claim.
  const usable = bank.channels.available.filter((c) => c.available).sort((a, b) => a.relativeCost - b.relativeCost);
  const firstChannel = usable[0]?.channel ?? 'SMS';
  decide(
    'primary-channel',
    `${firstChannel} for the first message (lowest relative cost among available channels)`,
    'assumption',
    'bank-context.softPreferences.preferLowerCostChannelFirst + P-010',
    'User did not state a channel preference (simulatedAnswers.channel_preference). P-010 is classified a hypothesis — this is a reasoned default, not an evidenced optimisation.',
  );

  // --- Message budget ---------------------------------------------------
  // Derived from the campaign's own shape, not from a policy.
  //
  // This used to read a per-campaign message cap out of the bank context and
  // record it as a HARD CONSTRAINT. That cap was invented, and worse, it is
  // not the kind of thing an issuer sets: how many messages a campaign sends
  // differs per campaign, and a two-week nurture and a three-day expiry
  // reminder are not the same number. Citing it as policy is what produced
  // "two sends against a permitted four" — the agent budgeting against a
  // fiction instead of designing for the goal, and reporting the underspend
  // as prudence.
  //
  // What genuinely bounds the count here is the opportunity window and the
  // spacing floor: messages cannot be closer together than the gap, and there
  // is no point sending after the window has closed. That is a reasoned
  // design decision, recorded as an assumption, which is what it is.
  const gapHours = bank.hardConstraints.minHoursBetweenMessages.value;
  const maxMessages = Math.max(1, Math.floor((RESOLUTION_WINDOW_HOURS - 1) / gapHours) + 1);
  decide(
    'message-budget',
    `${maxMessages} messages per customer, spaced ${gapHours}h apart inside the ${RESOLUTION_WINDOW_HOURS / 24}-day window`,
    'assumption',
    'planner: derived from the resolution window and the minimum spacing',
    'User did not state a reminder appetite (simulatedAnswers.reminder_appetite). No issuer sets a per-campaign message cap, so this is a design choice and is recorded as one, not as a bank policy.',
  );

  decide(
    'message-spacing',
    `${gapHours}h minimum between messages`,
    'bank-hard-constraint',
    'bank-context.hardConstraints.minHoursBetweenMessages',
  );

  // --- Wait window ------------------------------------------------------
  decide(
    'resolution-window',
    '7-day timeout awaiting EMI resolution',
    'principle',
    'P-003 (verified — IBL-Auth-Txn-to-EMI-Master-PRD.md:129,226)',
  );

  // --- Templates --------------------------------------------------------
  // Chosen on CONTENT, not just channel. The previous version took the first
  // template whose channelType matched, which selected "Festive Offer Email"
  // for an EMI consent ask. Suitability may override the cost-preference
  // order — a cheaper channel carrying the wrong message is not a saving —
  // and when it does, the recorded reason says so.
  const channelsByPreference = usable.map((c) => c.channel as Channel);

  const needFirst: TemplateNeed = {
    objective: ['emi', 'convert'],
    stage: 'first-touch',
    describe: 'Your recent purchase is eligible for EMI — convert it before the offer expires.',
  };
  const needReminder: TemplateNeed = {
    objective: ['emi', 'convert'],
    stage: 'reminder',
    describe: 'A reminder that your EMI conversion offer is still open, but not for long.',
  };

  const recordChoice = (step: string, choice: TemplateChoice) => {
    if (choice.kind === 'existing') {
      decide(step, `${choice.template.name} (${choice.template.id}) on ${choice.channel}`, 'principle', choice.reason);
      if (choice.weakStageFit) {
        t('note', `Weak stage fit at ${step}: ${choice.template.id} is not ${
          choice.betterStageFitElsewhere ? 'stage-specific' : 'stage-specific and no alternative exists'
        }`, { betterStageFitElsewhere: choice.betterStageFitElsewhere });
      }
    } else {
      // No suitable template exists. Record the gap and the proposal — do
      // NOT fall back to an unrelated template or invent an id.
      templateGaps.push({ step, ...choice });
      decide(
        step,
        `No suitable existing template — new template recommended for ${choice.channel}`,
        'assumption',
        choice.reason,
        `No template in COMMS_TEMPLATES matches this message. Proposed direction: ${choice.messagingDirection}`,
      );
      t('note', `Template gap at ${step}: new template required`, choice);
    }
  };

  const firstChoice = selectTemplate(needFirst, channelsByPreference);
  recordChoice('template-first-touch', firstChoice);
  const reminderChoice = selectTemplate(needReminder, channelsByPreference);
  recordChoice('template-reminder', reminderChoice);

  // A Send cannot be built without a real template id — dcAddFormValid
  // requires one. Rather than emit a misleading reference, stop and report.
  if (firstChoice.kind !== 'existing' || reminderChoice.kind !== 'existing') {
    throw new TemplateGapError(
      'Cannot complete the campaign: at least one step has no suitable existing template. ' +
        'A template must be created first (separate workflow). See templateGaps for the proposals.',
      templateGaps,
    );
  }

  // The chosen template decides the delivery channel and account, so the
  // earlier cost-based pick is superseded when suitability moved it.
  const sendChannel = firstChoice.channel;
  if (sendChannel !== firstChannel) {
    t('note', `Primary channel changed ${firstChannel} -> ${sendChannel} for template suitability`);
  }

  // --- Build the graph through the APPLICATION's own reducer ------------
  // Not hand-assembled JSON: every node and edge below is produced by
  // dcConfirmAddNode, so the app's wiring rules (auto Goal Check after a
  // Send, Yes → Goal Reached, branch arms) apply exactly as they would in
  // the real builder.
  let graph: DripGraph = { nodes: {}, edges: [], rootId: null };

  const entryCfg = {
    ...dcDefaultConfig('ENTRY_EVENT', goal),
    eventCategory: 'Transaction Events',
    eventType: 'Transaction',
    conditions: [{ attribute: 'EMI Eligible', operator: 'Equals', value: 'true' }],
  };
  graph = dcConfirmAddNode(graph, 'ENTRY_EVENT', entryCfg, { kind: 'root' }, goal);
  t('build', 'Entry · Event — Transaction, EMI Eligible = true');

  const openSlots = () => graph.edges.filter((e) => e.to === null);
  const childlessLeaves = () =>
    Object.values(graph.nodes).filter(
      (n) => !graph.edges.some((e) => e.from === n.id) && n.type !== 'EXIT' && n.type !== 'GOAL_EXIT',
    );

  // Where does the chain continue? Two shapes are legitimate in this app
  // and the previous version only recognised one of them:
  //
  //   1. an OPEN SLOT — an edge with to:null, e.g. the No arm of the Goal
  //      Check the app auto-inserts after every Send/Wait. Append with
  //      {kind:'edge'}.
  //   2. a CHILDLESS LEAF — a node with no outgoing edges at all. Append
  //      with {kind:'growLeaf'}.
  //
  // The old helper searched only for (2) and, finding none, silently fell
  // back to `graph.rootId`. That is what attached the reminder directly to
  // the entry node as a parallel path instead of continuing the chain —
  // structurally legal (entry nodes may fan out), semantically wrong, and
  // invisible to dcAddFormValid/dcGraphHasOpenBranches because both still
  // passed. The fallback is removed: an ambiguous or absent continuation
  // now fails loudly rather than inventing a branch.
  const nextInChain = (what: string): DcAddingAt => {
    const slots = openSlots();
    if (slots.length === 1) return { kind: 'edge', edgeId: slots[0].id };
    if (slots.length > 1) {
      throw new Error(
        `Cannot append "${what}": ${slots.length} open slots exist ` +
          `(${slots.map((e) => `${e.id} from ${e.from}:'${e.branchLabel}'`).join(', ')}). ` +
          'The continuation is ambiguous — the planner must choose a branch explicitly.',
      );
    }
    const leaves = childlessLeaves();
    if (leaves.length === 1) return { kind: 'growLeaf', nodeId: leaves[0].id };
    if (leaves.length > 1) {
      throw new Error(
        `Cannot append "${what}": ${leaves.length} childless leaves exist ` +
          `(${leaves.map((n) => `${n.id}/${n.type}`).join(', ')}). The continuation is ambiguous.`,
      );
    }
    throw new Error(
      `Cannot append "${what}": the graph has no open slot and no childless leaf. ` +
        'Every path already terminates, so there is nowhere to continue.',
    );
  };

  // Deliberate fan-out. Not used by this scenario, but kept explicit so
  // that any future parallel path is a recorded decision the validator can
  // check against — rather than something that just happens.
  const fanOutFrom = (nodeId: string, reason: string): DcAddingAt => {
    routingIntent.fanOut.push({ nodeId, reason });
    t('decision', `Intentional fan-out from ${nodeId}: ${reason}`);
    return { kind: 'growLeaf', nodeId };
  };
  void fanOutFrom;

  // Message 1 — consent ask. The app auto-appends a Goal Check + Goal
  // Reached because a Goal is defined.
  const send1 = {
    ...dcDefaultConfig('SEND', goal),
    name: 'EMI conversion offer',
    channel: sendChannel,
    account: firstChoice.template.accountName,
    templateId: firstChoice.template.id,
    timing: 'Relative',
    relativeAnchor: 'Entry',
    relativeDuration: 0,
    relativeUnit: 'hours',
  };
  graph = dcConfirmAddNode(graph, 'SEND', send1, nextInChain('Send 1 (EMI conversion offer)'), goal);
  t('build', `Send 1 — ${sendChannel} / ${firstChoice.template.id}, immediately after entry`);

  // Continue down the Goal Check's "No" arm: they haven't converted yet.
  graph = dcConfirmAddNode(graph, 'PAUSE', { duration: gapHours, unit: 'hours' }, nextInChain(`Wait ${gapHours}h`), goal);
  t('build', `Wait ${gapHours}h — the bank's minimum gap between messages`);

  // Message 2 — reminder.
  const send2 = {
    ...send1,
    name: 'EMI conversion reminder',
    channel: reminderChoice.channel,
    account: reminderChoice.template.accountName,
    templateId: reminderChoice.template.id,
    timing: 'Relative',
    relativeAnchor: 'Previous Step',
    relativeDuration: 0,
  };
  graph = dcConfirmAddNode(graph, 'SEND', send2, nextInChain('Send 2 (EMI conversion reminder)'), goal);
  t('build', `Send 2 — reminder, ${reminderChoice.channel} / ${reminderChoice.template.id}`);

  // Then wait for the EMI outcome itself, with the 7-day window from P-003.
  const waitCfg = {
    ...dcDefaultConfig('WAIT_UNTIL', goal),
    eventCategory: 'EMI Events',
    eventType: 'EMI_STATUS_CHANGED',
    duration: 7,
    unit: 'days',
    conditions: [{ attribute: 'New Status', operator: 'Equals', value: 'Successful' }],
  };
  graph = dcConfirmAddNode(graph, 'WAIT_UNTIL', waitCfg, nextInChain('Wait for Event (EMI resolution)'), goal);
  t('build', 'Wait for Event — EMI_STATUS_CHANGED, 7-day timeout (P-003)');

  // Close every remaining open path with an Exit so the campaign can pass
  // the app's own submit gate.
  // Closing every remaining path is legitimately a many-slot operation,
  // so it uses openSlots() directly rather than nextInChain()'s
  // exactly-one rule.
  let guard = 0;
  while (openSlots().length > 0 && guard++ < 20) {
    const s = openSlots()[0];
    graph = dcConfirmAddNode(graph, 'EXIT', { reason: 'Did not convert in this window' }, { kind: 'edge', edgeId: s.id }, goal);
  }
  // A leaf that is neither terminal nor has children would also fail the
  // gate — close those too.
  guard = 0;
  while (guard++ < 20) {
    const leaf = childlessLeaves()[0];
    if (!leaf) break;
    graph = dcConfirmAddNode(graph, 'EXIT', { reason: 'Sequence complete' }, { kind: 'growLeaf', nodeId: leaf.id }, goal);
  }
  t('build', 'Closed all remaining open paths with Exit nodes');

  // Both Sends are relatively timed (anchored to Entry / Previous Step),
  // because the trigger is a transaction authorisation that can happen at
  // any hour. That is the right design for this campaign AND the reason
  // quiet-hours compliance cannot be established at design time — recorded
  // here so the 'incomplete' outcome has a stated cause, not just a symptom.
  t(
    'note',
    'Sends use relative timing anchored to the entry event, so their wall-clock send time is not knowable at design time. Quiet-hours compliance is therefore unverifiable here and is reported as not-run, not as satisfied.',
  );

  // Per CUSTOMER, not per graph. The earlier version counted Send nodes
  // globally, which over-reports on any branching campaign (a customer takes
  // one arm of a routing node, not all of them). The same helper backs
  // validate.ts's message-cap check, so this note cannot disagree with the
  // verdict — and the verdict, not this note, is what fails a run.
  const reach = maxSendsOnAnyPath(graph);
  const sendCount = reach.max;
  if (sendCount > maxMessages) {
    t('note', `Max messages on a single customer path is ${sendCount}, exceeding the bank cap ${maxMessages}`, {
      violation: true,
    });
  } else {
    t('note', `Max messages on a single customer path is ${sendCount}, within the bank cap of ${maxMessages}`);
  }

  conversation.push({
    role: 'agent',
    text:
      `I have designed a ${sendCount}-message campaign entering on an EMI-eligible transaction, with a 7-day window to see whether the EMI request resolves. ` +
      `Two things I had to assume because you did not have the information: the channel (I used ${sendChannel}) and the message budget (I used your policy cap of ${maxMessages}). ` +
      `I cannot tell you this will improve conversion — there is no performance data for ${bank.bank.displayName}, and the channel-ordering idea behind my choice is an untested hypothesis, not an established result.`,
  });

  return {
    graph,
    goal,
    routingIntent,
    templateGaps,
    decisions,
    assumptions: decisions.filter((d) => d.basis === 'assumption'),
    conversation,
    trace,
  };
}
