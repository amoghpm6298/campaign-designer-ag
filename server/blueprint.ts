// The boundary between model reasoning and deterministic construction.
//
// The model returns a BLUEPRINT: a small, closed vocabulary describing what
// the campaign should do. It never returns graph nodes, edge ids, field
// names, template ids or connections. Everything structural is built here by
// calling the application's own dcConfirmAddNode, so the app's wiring rules
// (auto Goal Check after Send/Wait, Yes -> Goal Reached, branch arms) apply
// exactly as they would in the real builder.
//
// Anything the model proposes that is not in the real vocabulary is rejected
// with a reason rather than coerced — a silently corrected blueprint would
// produce a campaign nobody chose.
import { dcConfirmAddNode, type DcAddingAt } from '../src/reducer/campaignReducer';
import { dcDefaultConfig } from '../src/reducer/defaultConfig';
import { dcResetIdCounters } from '../src/reducer/idGen';
import { COMMS_TEMPLATES, EVENT_CATEGORIES, ELIGIBILITY_META, DC_EVENT_ENTITY, type AttrMeta, type Channel } from '../src/data/sharedConstants';
import {
  validateEventConditions,
  validateAudienceConditions,
  eventConditionTarget,
  normaliseCondition,
  describeIssue,
  type ConditionCheck,
  type ConditionLimitation,
} from '../src/data/conditionValidation';
import { selectTemplate, proposeMessaging, type TemplateNeed } from '../agent-proto/templateSelect';
import type { DripGraph, DripGoal, DripGoalCondition } from '../src/data/graphTypes';

// --- the closed vocabulary the model may use -------------------------

export interface BpCondition {
  attribute: string;
  operator: string;
  value?: string;
}

/**
 * What an experiment is capable of settling, in a closed vocabulary.
 *
 * Every value is checkable against the built arms, which is the whole point:
 * "does this experiment test a cause?" is not a judgement the application can
 * make about prose, but it IS a judgement it can make about structure.
 */
export const EXPERIMENT_CLAIMS = [
  /** Which message performs better. Arms may differ only in copy. */
  'wording',
  /** Which underlying customer barrier is real. Arms must differ in experience. */
  'explanation',
  /** When to make contact. Arms must differ in timing. */
  'timing',
  /** Who responds. Arms must differ in who they reach. */
  'audience',
] as const;

export type ExperimentClaim = (typeof EXPERIMENT_CLAIMS)[number];

export const isExperimentClaim = (v: unknown): v is ExperimentClaim =>
  typeof v === 'string' && (EXPERIMENT_CLAIMS as readonly string[]).includes(v);

export type BpStep =
  | {
      kind: 'send';
      name: string;
      /** Objective keywords used to resolve a REAL template. Never an id. */
      objective: string[];
      stage: 'first-touch' | 'reminder' | 'outcome';
      /** What the message is FOR, written for the campaign manager. */
      describe: string;
      /**
       * The message as the CUSTOMER would read it, when the agent writes one.
       *
       * Optional. Without it the application falls back to proposeMessaging,
       * which interpolates `describe` — and `describe` is written in the third
       * person about the customer, so the result reads as an instruction to a
       * marketer rather than as a message ("Hi ${customerFirstName}, tell the
       * customer their purchase qualifies…"). That fallback is a placeholder,
       * not copy, which is why the agent is asked for the real thing.
       */
      copy?: string;
      cta?: string;
      channelPreference?: string[];
      /**
       * The id of the barrier this message attacks.
       *
       * WHY A MESSAGE HAS TO NAME ONE. Every send is a reason the campaign
       * believes a customer will act differently afterwards. A send that
       * attacks no stated reason is decoration: it adds contact, cost and
       * fatigue, and nobody can say what it was for or whether it worked.
       * Making the citation part of the step turns "does this campaign
       * address what we learned?" into something the application can check,
       * rather than something the prompt asks for and nobody verifies.
       *
       * Optional in the type so an older blueprint still parses. The check
       * lives in `checkBarrierCoverage`, which refuses a proposal rather than
       * silently accepting an uncited one.
       */
      barrier?: string;
    }
  | { kind: 'wait'; durationHours: number; why?: string }
  | {
      kind: 'waitForEvent';
      eventCategory: string;
      eventType: string;
      timeoutDays: number;
      conditions?: BpCondition[];
    }
  | { kind: 'exit'; reason: string }
  | {
      /** A/B split. Arms are built as real EXPERIMENT_SPLIT branches. */
      kind: 'experiment';
      label: string;
      /**
       * What this experiment can actually settle. REQUIRED.
       *
       * MEASURED, three proposals running on one conversation: the agent built
       * an experiment whose arms were the identical journey with different
       * copy, and described it as testing which customer barrier was real. The
       * application said so underneath, the agent reworded the experiment's
       * name and rebuilt the same thing, twice.
       *
       * A copy test is a perfectly good experiment — it just cannot establish
       * a cause. So the application does not ban them. It checks the CLAIM
       * against the DESIGN: declare 'explanation' and your arms had better
       * differ in something a customer experiences. Declaring 'wording' is
       * always available and always legal, which is what stops this being a
       * trap with no way out.
       *
       * There is no default. Silence used to buy permission here; now it does
       * not, because the field is required.
       */
      tests: ExperimentClaim;
      arms: { label: string; pct: number; steps: BpStep[] }[];
    }
  | {
      /**
       * A Yes/No fork.
       *
       * Either on a previous step's DELIVERY OUTCOME (`outcomes`), or on a
       * customer ATTRIBUTE read at that point in the journey (`on`).
       *
       * THE GAP THIS CLOSES: until now only `outcomes` existed, so the one
       * fork the agent could express was "was the last message delivered".
       * The builder has always supported conditions on entity attributes —
       * the vocabulary the agent writes in simply had no words for it. The
       * consequence was that cohorting could only ever happen at entry, and
       * a balance-tiered journey was unbuildable no matter how well discovery
       * went. The agent proposed exactly that as a candidate architecture in
       * a live run and could not have built it.
       */
      kind: 'condition';
      label: string;
      /** Delivery outcomes of the preceding Send. Requires a preceding Send. */
      outcomes?: string[];
      /** A customer attribute checked at this point. Needs no preceding Send. */
      on?: { entity: string; attribute: string; operator: string; value?: string };
      yes: BpStep[];
      no: BpStep[];
    }
  | {
      /**
       * N-way routing on one attribute — the step that makes cohorts
       * expressible at all.
       *
       * A Yes/No condition can separate two groups. Three balance bands, or
       * four tenure cohorts, need this. The builder has had it all along as
       * DECISION_SPLIT; the agent had no way to ask for it.
       */
      kind: 'branch';
      label: string;
      entity: string;
      attribute: string;
      /** Each path routes on its own comparison against that one attribute. */
      paths: { label: string; operator: string; value: string; steps: BpStep[] }[];
    };

export interface CampaignBlueprint {
  campaignName: string;
  description: string;
  controlPct?: number;
  goal: { eventCategory: string; eventType: string; conditions?: BpCondition[] } | null;
  entry:
    | { kind: 'event'; eventCategory: string; eventType: string; conditions?: BpCondition[] }
    | {
        kind: 'audience';
        entity: string;
        conditions?: BpCondition[];
        /**
         * Further entity blocks, ANDed with the primary one.
         *
         * THE DEFECT THIS FIXES. The agent's entry vocabulary was one entity
         * and one flat condition list, while Entry · Audience has supported
         * several ANDed entity blocks since 2026-10-09 (`extraEntityGroups`,
         * src/wizard/NodeForms.tsx). Reasoning correctly from an incomplete
         * description, the agent told a campaign manager that switching to an
         * Account entry "still couldn't add KYC completeness in the same
         * entry (that lives on Customer)" — and offered that as a trade-off
         * to accept. The platform does exactly this, and has done all along.
         */
        groups?: {
          entity: string;
          conditions?: BpCondition[];
          /** Transaction-only: how far back to look. */
          lookbackDays?: number;
          /**
           * Transaction-only: whether a matching record must exist, or must NOT.
           *
           * 'none' is the other claim the agent got wrong — it told the
           * manager the platform "can only test the value of an existing
           * record, never the absence of one", and turned that into a
           * question about holding the campaign for a suppression list.
           * Absence over a window is a real, built capability
           * (`existence: 'none'`, src/data/graphTypes.ts). The honest caveat
           * is that it is a WINDOW, not "ever".
           */
          existence?: 'exists' | 'none';
        }[];
      };
  steps: BpStep[];
}

export interface BuildIssue {
  path: string;
  problem: string;
}

/**
 * Why a Send's template is not filled in. Three genuinely different states,
 * kept apart because reporting "no template exists" when we simply cannot
 * see the bank's catalogue would be a false claim about their library.
 */
export type UnresolvedReason =
  /** The bank's catalogue is not reachable from Hyperface. We cannot confirm or deny. */
  | 'template-library-unavailable'
  /** We DID search an accessible library and nothing suitable was there. */
  | 'no-suitable-template'
  /** The user has been asked and has not supplied it yet. */
  | 'awaiting-user-input';

/**
 * A communication step whose account/template the agent cannot supply.
 *
 * The step is still built into the graph — dropping it would throw away the
 * campaign design over a field only the bank can fill. The Send carries the
 * application's own unset values (account: '', templateId: ''), so the app's
 * existing dcAddFormValid marks it invalid and export stays blocked until a
 * person supplies the real values. No fabricated ids anywhere.
 */
export interface SendProposal {
  nodeId: string;
  stepName: string;
  channel: string;
  timing: string;
  reason: UnresolvedReason;
  explanation: string;
  /** Agent-written. NOT a bank-registered template. */
  messagingDirection: string;
  sampleCopy: string;
  cta: string;
  personalisationFields: string[];
  accountResolved: boolean;
  templateResolved: boolean;
}

export interface BuildResult {
  ok: boolean;
  graph: DripGraph;
  goal: DripGoal | null;
  issues: BuildIssue[];
  /**
   * Conditions the platform cannot check either way (a Smart Tag's real
   * values are issuer-configured). Reported rather than passed silently,
   * because an absent error would otherwise read as "verified".
   */
  limitations: ConditionLimitation[];
  /** Template decisions actually taken, for the run log. */
  templateChoices: { step: string; templateId: string | null; channel: string; reason: string }[];
  /** Communication steps still needing a real account and template id. */
  sendProposals: SendProposal[];
}

// --- vocabulary checks ------------------------------------------------

const knownEventType = (cat: string, type: string) =>
  Boolean(EVENT_CATEGORIES[cat]?.events.includes(type));

/**
 * Template objectives are matched by SUBSTRING against template copy, so a
 * whole phrase like "prompt EMI conversion" matches nothing while "emi" and
 * "convert" match exactly. A live run showed the model returning phrases and
 * every real EMI template being reported as a gap as a result.
 *
 * The prompt now asks for single words, but relying on that alone would make
 * template resolution depend on the model's obedience. Splitting here makes
 * it robust either way: phrases become their own words, stopwords and short
 * fragments are dropped, and 'conversion' is stemmed to 'convert' so it
 * matches copy that uses the verb.
 */
const STOPWORDS = new Set([
  'the','a','an','and','or','to','of','for','with','customer','customers','message','their','this','that','them',
  'inform','prompt','remind','tell','send','about','before','after','create','give','make','get','let','know',
]);

function objectiveKeywords(raw: string[] | undefined): string[] {
  const out = new Set<string>();
  for (const entry of raw ?? []) {
    for (const word of String(entry).toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length < 3 || STOPWORDS.has(word)) continue;
      out.add(word);
      // 'conversion' -> 'convert', 'activation' -> 'activate', etc.
      if (word.endsWith('ion') && word.length > 6) out.add(word.slice(0, -3).replace(/at$/, 'ate'));
    }
  }
  return [...out];
}

/**
 * Conditions, in the shape the application's own reducer expects.
 *
 * `meta` lets a multiSelect's values land in `values[]` where dcAddFormValid
 * and the canvas labels look for them. No VALUE is changed by this — only
 * which field holds it. Values themselves are validated, never corrected.
 */
function conditions(raw: BpCondition[] | undefined, entity?: string | null): DripGoalCondition[] {
  const attrs = entity ? (ELIGIBILITY_META as Record<string, Record<string, AttrMeta>>)[entity] : undefined;
  return (raw ?? []).map((c) => {
    const real = attrs ? Object.keys(attrs).find((n) => n.toLowerCase() === String(c.attribute ?? '').toLowerCase()) : undefined;
    return normaliseCondition(
      { attribute: c.attribute, operator: c.operator, value: c.value ?? '' } as DripGoalCondition,
      real ? attrs![real] : null,
    );
  });
}

/** Turns condition issues into build issues, with the alternatives attached. */
function conditionIssues(check: ConditionCheck, path: string): BuildIssue[] {
  return check.issues.map((i) => ({ path, problem: describeIssue(i) }));
}

/**
 * Builds the campaign graph from a blueprint using the application's reducer.
 *
 * Append targets follow the same rule the deterministic planner established:
 * continue into the single open slot (an edge with to:null, e.g. a Goal
 * Check's No arm), else the single childless leaf. Ambiguity is an error, not
 * a guess — the earlier `?? rootId` fallback silently produced parallel sends.
 */
export interface BuildOptions {
  availableChannels: Channel[];
  /**
   * Whether the bank's template catalogue is reachable. 'unavailable' is the
   * honest default: templates belong to the bank's ecosystem and Hyperface
   * does not mirror them.
   */
  templateLibraryAccess: 'unavailable' | 'synthetic-demo';
  /** Values a user has already supplied, keyed by step name. */
  resolvedSends?: Record<string, { account?: string; templateId?: string }>;
}

export function buildFromBlueprint(bp: CampaignBlueprint, options: BuildOptions | Channel[]): BuildResult {
  // Array form kept for the existing tests and callers that only care about
  // channels; it means the realistic 'unavailable' default applies.
  const opts: BuildOptions = Array.isArray(options)
    ? { availableChannels: options, templateLibraryAccess: 'synthetic-demo' }
    : options;
  const availableChannels = opts.availableChannels;
  dcResetIdCounters();
  const issues: BuildIssue[] = [];
  const limitations: ConditionLimitation[] = [];
  const templateChoices: BuildResult['templateChoices'] = [];
  const sendProposals: SendProposal[] = [];
  let graph: DripGraph = { nodes: {}, edges: [], rootId: null };

  // --- goal -----------------------------------------------------------
  let goal: DripGoal | null = null;
  if (bp.goal) {
    if (!knownEventType(bp.goal.eventCategory, bp.goal.eventType)) {
      issues.push({
        path: 'goal',
        problem: `"${bp.goal.eventCategory} / ${bp.goal.eventType}" is not a real event. Known: ${Object.entries(
          EVENT_CATEGORIES,
        )
          .map(([c, m]) => `${c}: ${m.events.join('/')}`)
          .join('; ')}`,
      });
    } else {
      // A goal's conditions filter the goal event's own entity. They were
      // never checked: a goal on New Status = "Converted" (not one of the
      // five real values) built and validated cleanly.
      const check = validateEventConditions(bp.goal.eventCategory, bp.goal.eventType, conditions(bp.goal.conditions));
      issues.push(...conditionIssues(check, 'goal.conditions'));
      limitations.push(...check.limitations);
      goal = {
        eventCategory: bp.goal.eventCategory,
        eventType: bp.goal.eventType,
        conditions: conditions(bp.goal.conditions, eventConditionTarget(bp.goal.eventCategory).entity),
      };
    }
  }

  // --- entry ----------------------------------------------------------
  if (bp.entry.kind === 'event') {
    if (!knownEventType(bp.entry.eventCategory, bp.entry.eventType)) {
      issues.push({ path: 'entry', problem: `"${bp.entry.eventCategory} / ${bp.entry.eventType}" is not a real event.` });
      return { ok: false, graph, goal, issues, limitations, templateChoices, sendProposals };
    }
    // The gap that let the EMI campaign through: an event entry validated its
    // EVENT and nothing else, so any attribute and any value could ride along.
    const target = eventConditionTarget(bp.entry.eventCategory, bp.entry.eventType);
    const check = validateEventConditions(bp.entry.eventCategory, bp.entry.eventType, conditions(bp.entry.conditions));
    issues.push(...conditionIssues(check, 'entry.conditions'));
    limitations.push(...check.limitations);
    const cfg = {
      ...dcDefaultConfig('ENTRY_EVENT', goal),
      eventCategory: bp.entry.eventCategory,
      eventType: bp.entry.eventType,
      conditions: conditions(bp.entry.conditions, target.entity),
    };
    graph = dcConfirmAddNode(graph, 'ENTRY_EVENT', cfg, { kind: 'root' }, goal);
  } else {
    if (!ELIGIBILITY_META[bp.entry.entity as keyof typeof ELIGIBILITY_META]) {
      issues.push({ path: 'entry', problem: `"${bp.entry.entity}" is not a real entity. Known: ${Object.keys(ELIGIBILITY_META).join(', ')}` });
      return { ok: false, graph, goal, issues, limitations, templateChoices, sendProposals };
    }
    // Was a name-only check. Now the operator and the value are checked too.
    const check = validateAudienceConditions(bp.entry.entity, conditions(bp.entry.conditions));
    issues.push(...conditionIssues(check, 'entry.conditions'));
    limitations.push(...check.limitations);
    // Further ANDed entity blocks, mapped onto the node's own
    // `extraEntityGroups`. Each is validated like the primary block, so an
    // unknown entity or a bad operator is reported rather than built.
    const extraEntityGroups = (bp.entry.groups ?? [])
      .filter((g) => g && typeof g.entity === 'string' && ELIGIBILITY_META[g.entity as keyof typeof ELIGIBILITY_META])
      .map((g, i) => {
        const gc = validateAudienceConditions(g.entity, conditions(g.conditions));
        issues.push(...conditionIssues(gc, `entry.groups[${i}].conditions`));
        limitations.push(...gc.limitations);
        const base: Record<string, unknown> = { entity: g.entity, conditions: conditions(g.conditions, g.entity) };
        // Lookback and existence are meaningful only on Transaction, which is
        // how the real form behaves: the fields appear for that entity and
        // are silently unused otherwise.
        if (g.entity === 'Transaction') {
          base.lookbackDuration = typeof g.lookbackDays === 'number' && g.lookbackDays > 0 ? g.lookbackDays : 30;
          base.lookbackUnit = 'days';
          base.existence = g.existence === 'none' ? 'none' : 'exists';
          if (g.existence === 'none') {
            // Said out loud rather than left implicit. "No matching
            // transaction in 180 days" is not "never", and a campaign that
            // treats it as never will reach someone who converted 200 days
            // ago.
            limitations.push({
              attribute: `${g.entity} (absence over ${base.lookbackDuration} days)`,
              note: `Entry excludes anyone with a matching transaction in the last ${base.lookbackDuration} days. That is a window, not "ever" — someone who qualified earlier than that will still enter.`,
            });
          }
        }
        return base;
      });
    for (const g of bp.entry.groups ?? []) {
      if (g && typeof g.entity === 'string' && !ELIGIBILITY_META[g.entity as keyof typeof ELIGIBILITY_META]) {
        issues.push({ path: 'entry.groups', problem: `"${g.entity}" is not a real entity. Known: ${Object.keys(ELIGIBILITY_META).join(', ')}` });
      }
    }

    const cfg = {
      ...dcDefaultConfig('ENTRY_SEGMENT', goal),
      entity: bp.entry.entity,
      conditions: conditions(bp.entry.conditions, bp.entry.entity),
      extraEntityGroups,
    };
    graph = dcConfirmAddNode(graph, 'ENTRY_SEGMENT', cfg, { kind: 'root' }, goal);
  }

  // --- append helpers -------------------------------------------------
  const openSlots = () => graph.edges.filter((e) => e.to === null);
  const childlessLeaves = () =>
    Object.values(graph.nodes).filter(
      (n) => !graph.edges.some((e) => e.from === n.id) && n.type !== 'EXIT' && n.type !== 'GOAL_EXIT',
    );

  const nextInChain = (what: string): DcAddingAt | null => {
    const slots = openSlots();
    if (slots.length === 1) return { kind: 'edge', edgeId: slots[0].id };
    if (slots.length > 1) {
      issues.push({ path: what, problem: `${slots.length} open slots exist; the continuation is ambiguous.` });
      return null;
    }
    const leaves = childlessLeaves();
    if (leaves.length === 1) return { kind: 'growLeaf', nodeId: leaves[0].id };
    if (leaves.length > 1) {
      issues.push({ path: what, problem: `${leaves.length} childless leaves exist; the continuation is ambiguous.` });
      return null;
    }
    issues.push({ path: what, problem: 'Every path already terminates; there is nowhere to continue.' });
    return null;
  };

  let lastSend: { channel: string; fallbackChannel: string } | null = null;

  const addSteps = (steps: BpStep[], pathPrefix: string, at?: DcAddingAt) => {
    let target = at;
    steps.forEach((step, i) => {
      const path = `${pathPrefix}[${i}].${step.kind}`;
      const where = target ?? nextInChain(path);
      target = undefined; // only the first step of an arm uses the explicit target
      if (!where) return;

      if (step.kind === 'send') {
        // Validate model output BEFORE it reaches the selector. An
        // unrecognised stage used to index STAGE_SIGNALS with undefined and
        // crash the whole request — a malformed field must be a reported
        // issue, not a 500.
        const STAGES = ['first-touch', 'reminder', 'outcome'] as const;
        type Stage = (typeof STAGES)[number];
        const isStage = (x: unknown): x is Stage => STAGES.includes(x as Stage);
        if (!isStage(step.stage)) {
          issues.push({
            path: `${path}.stage`,
            problem: `"${String(step.stage)}" is not a valid stage. Use one of: ${STAGES.join(', ')}.`,
          });
          return;
        }
        if (!Array.isArray(step.objective) || !step.objective.length) {
          issues.push({ path: `${path}.objective`, problem: 'A send needs at least one objective keyword.' });
          return;
        }
        const keywords = objectiveKeywords(step.objective);
        const prefer = (step.channelPreference ?? availableChannels).filter((c) =>
          availableChannels.includes(c as Channel),
        ) as Channel[];
        const channels = prefer.length ? prefer : availableChannels;
        const need: TemplateNeed = { objective: keywords, stage: step.stage, describe: step.describe ?? step.name };

        // Has a person already supplied the real values for this step?
        const supplied = opts.resolvedSends?.[step.name] ?? {};

        // Only search a catalogue we can actually see. With access
        // 'unavailable' we do NOT claim a template is missing — we cannot
        // tell, and saying otherwise would be a false statement about the
        // bank's library.
        const choice =
          opts.templateLibraryAccess === 'synthetic-demo' ? selectTemplate(need, channels) : null;

        const resolvedChannel = (choice?.kind === 'existing' ? choice.channel : channels[0]) ?? 'SMS';
        const timingLabel = i === 0 && pathPrefix === 'steps' ? 'immediately after entry' : 'after the previous step';

        if (choice?.kind === 'existing' && !supplied.templateId) {
          templateChoices.push({
            step: step.name,
            templateId: choice.template.id,
            channel: choice.channel,
            reason: `${choice.reason} [synthetic demo library — not a real bank catalogue]`,
          });
        }

        // The account and template id the Send will actually carry. Either a
        // user-supplied value, or a demo-library match, or the application's
        // own unset value ''. Never an invented id.
        const account = supplied.account ?? (choice?.kind === 'existing' ? choice.template.accountName : '');
        const templateId = supplied.templateId ?? (choice?.kind === 'existing' ? choice.template.id : '');

        // The agent's own messaging intent, produced whether or not a
        // template resolved. It used to live only on sendProposals — a
        // transient field on the HTTP response — so it never reached the
        // node, the campaign or the export, and the campaign manager who has
        // to write the real message never saw what the agent had in mind.
        const proposal =
          choice?.kind === 'proposal' ? choice : proposeMessaging(need, resolvedChannel as Channel);
        const templateResolved = Boolean(account && templateId);
        const agentMessaging = {
          objective: step.describe || step.name,
          stage: step.stage,
          recommendedChannel: resolvedChannel,
          // Copy and CTA are only offered where nobody else is supplying the
          // message. With a real template matched, the bank's own content
          // governs and a suggested draft alongside it would just be noise.
          ...(templateResolved
            ? {}
            : {
                // The agent's own words win. The generated string is a
                // fallback so the field is never simply missing, and it is
                // labelled as a placeholder rather than passed off as copy.
                suggestedCopy: step.copy?.trim() || proposal.sampleCopy,
                cta: step.cta?.trim() || proposal.cta,
                personalisationTokens: proposal.personalisationFields,
                copySource: step.copy?.trim() ? ('agent-written' as const) : ('generated-placeholder' as const),
              }),
          source: 'agent-suggested' as const,
          status: 'draft — written by the agent, not reviewed or approved by the bank, and not a registered template',
        };

        if (!account || !templateId) {
          const reason: UnresolvedReason = supplied.account || supplied.templateId
            ? 'awaiting-user-input'
            : opts.templateLibraryAccess === 'unavailable'
              ? 'template-library-unavailable'
              : 'no-suitable-template';
          const explanation =
            reason === 'template-library-unavailable'
              ? 'The bank\'s communication templates live in the bank\'s own ecosystem and are not readable from here, so no template could be verified either way. Enter the real account and template id to complete this step.'
              : reason === 'no-suitable-template'
                ? 'The sample demo library was searched and nothing matched this message. Enter the real account and template id from the bank\'s ecosystem.'
                : 'Waiting for the remaining account or template id.';
          sendProposals.push({
            nodeId: '(pending)',
            stepName: step.name,
            channel: resolvedChannel,
            timing: timingLabel,
            reason,
            explanation,
            messagingDirection: proposal.messagingDirection,
            sampleCopy: proposal.sampleCopy,
            cta: proposal.cta,
            personalisationFields: proposal.personalisationFields,
            accountResolved: Boolean(account),
            templateResolved: Boolean(templateId),
          });
        }

        const cfg = {
          ...dcDefaultConfig('SEND', goal),
          name: step.name,
          channel: resolvedChannel,
          // '' is the application's OWN unset value (dcDefaultConfig), not a
          // placeholder this code invented. dcAddFormValid treats a Send with
          // either field empty as invalid, which is exactly what should
          // happen until a person fills them in.
          account,
          templateId,
          // Namespaced so it cannot collide with a real configuration field,
          // and ignored by dcAddFormValid, so a suggestion can never make an
          // incomplete Send look complete.
          agentMessaging,
          timing: 'Relative',
          relativeAnchor: i === 0 && pathPrefix === 'steps' ? 'Entry' : 'Previous Step',
          relativeDuration: 0,
          relativeUnit: 'hours',
          fallbackChannel: '',
        };
                lastSend = { channel: resolvedChannel, fallbackChannel: '' };
        const before = new Set(Object.keys(graph.nodes));
        graph = dcConfirmAddNode(graph, 'SEND', cfg, where, goal);
        // Bind any proposal for this step to the node that was just created,
        // so the UI can show the unresolved fields on the right card.
        const newId = Object.keys(graph.nodes).find((id) => !before.has(id));
        const pending = sendProposals.find((p) => p.stepName === step.name && p.nodeId === '(pending)');
        if (pending && newId) pending.nodeId = newId;
        return;
      }

      if (step.kind === 'wait') {
        const hours = Math.max(0, Math.round(step.durationHours));
        graph = dcConfirmAddNode(graph, 'PAUSE', { duration: hours, unit: 'hours' }, where, goal);
        return;
      }

      if (step.kind === 'waitForEvent') {
        if (!knownEventType(step.eventCategory, step.eventType)) {
          issues.push({ path, problem: `"${step.eventCategory} / ${step.eventType}" is not a real event.` });
          return;
        }
        const waitTarget = eventConditionTarget(step.eventCategory, step.eventType);
        const waitCheck = validateEventConditions(step.eventCategory, step.eventType, conditions(step.conditions));
        issues.push(...conditionIssues(waitCheck, `${path}.conditions`));
        limitations.push(...waitCheck.limitations);
        const cfg = {
          ...dcDefaultConfig('WAIT_UNTIL', goal),
          eventCategory: step.eventCategory,
          eventType: step.eventType,
          duration: Math.max(1, Math.round(step.timeoutDays)),
          unit: 'days',
          conditions: conditions(step.conditions, waitTarget.entity),
        };
        graph = dcConfirmAddNode(graph, 'WAIT_UNTIL', cfg, where, goal);
        return;
      }

      if (step.kind === 'exit') {
        graph = dcConfirmAddNode(graph, 'EXIT', { reason: step.reason }, where, goal);
        return;
      }

      if (step.kind === 'experiment') {
        const total = step.arms.reduce((s, a) => s + a.pct, 0);
        if (step.arms.length < 2) {
          issues.push({ path, problem: 'An experiment needs at least two arms.' });
          return;
        }
        if (Math.abs(total - 100) > 0.5) {
          issues.push({ path, problem: `Experiment arm percentages sum to ${total}, not 100.` });
          return;
        }
        // The application's experiment node is RANDOM_SPLIT. Its branch
        // shape (id/label/pct) comes from dcDefaultConfig, and ids are
        // minted by the app's own dcNewBranchId via that default.
        const defaults = dcDefaultConfig('RANDOM_SPLIT', goal) as { branches: { id: string }[] };
        const cfg = {
          ...defaults,
          name: step.label,
          branches: step.arms.map((a, bi) => ({
            id: defaults.branches[bi]?.id ?? `bp-${bi}`,
            label: a.label,
            pct: a.pct,
          })),
        };
        const beforeIds = new Set(Object.keys(graph.nodes));
        graph = dcConfirmAddNode(graph, 'RANDOM_SPLIT', cfg, where, goal);
        const splitId = Object.keys(graph.nodes).find((id) => !beforeIds.has(id));
        // Each arm continues from its own edge off the split.
        step.arms.forEach((arm, ai) => {
          const edge = graph.edges.filter((e) => e.from === splitId)[ai];
          if (!edge) {
            issues.push({ path: `${path}.arms[${ai}]`, problem: 'The reducer did not create an arm for this branch.' });
            return;
          }
          addSteps(arm.steps, `${path}.arms[${ai}]`, { kind: 'edge', edgeId: edge.id });
        });
        return;
      }

      if (step.kind === 'branch') {
        // N-way routing on one attribute, built as the app's own
        // DECISION_SPLIT. Same reducer call the builder's UI makes.
        if (!step.paths?.length) {
          issues.push({ path, problem: 'A branch needs at least one path.' });
          return;
        }
        const owns = ELIGIBILITY_META[step.entity as keyof typeof ELIGIBILITY_META];
        if (!owns || !Object.keys(owns).includes(step.attribute)) {
          issues.push({ path, problem: `${step.entity} has no attribute "${step.attribute}".` });
          return;
        }
        const cfg = {
          ...dcDefaultConfig('DECISION_SPLIT', goal),
          name: step.label,
          source: `${step.entity} attribute`,
          attribute: step.attribute,
          branches: step.paths.map((b, i) => ({
            id: `bp${i}`,
            label: b.label,
            operator: b.operator,
            value: b.value,
            value2: '',
          })),
        };
        const before = new Set(Object.keys(graph.nodes));
        graph = dcConfirmAddNode(graph, 'DECISION_SPLIT', cfg, where, goal);
        const nodeId = Object.keys(graph.nodes).find((id) => !before.has(id));
        const outs = graph.edges.filter((e) => e.from === nodeId);
        step.paths.forEach((b, i) => {
          // Match the reducer's own arm by its label, falling back to order.
          const edge = outs.find((e) => e.branchLabel === b.label) ?? outs[i];
          if (edge) addSteps(b.steps, `${path}.paths[${i}]`, { kind: 'edge', edgeId: edge.id });
        });
        return;
      }

      if (step.kind === 'condition') {
        // Two kinds of fork now. An ATTRIBUTE condition reads a customer
        // value at this point in the journey and needs no preceding Send — it
        // is how a cohort split happens anywhere other than at entry.
        const onAttr = step.on;
        if (!onAttr && !step.outcomes?.length) {
          issues.push({ path, problem: 'A condition needs either delivery outcomes or an attribute to check.' });
          return;
        }
        if (!onAttr && !lastSend) {
          issues.push({ path, problem: 'A delivery-outcome condition needs a preceding Send.' });
          return;
        }
        if (onAttr) {
          const owns = ELIGIBILITY_META[onAttr.entity as keyof typeof ELIGIBILITY_META];
          if (!owns || !Object.keys(owns).includes(onAttr.attribute)) {
            issues.push({ path, problem: `${onAttr.entity} has no attribute "${onAttr.attribute}".` });
            return;
          }
        }
        const cfg = onAttr
          ? {
              ...dcDefaultConfig('SPLIT', goal),
              customSource: `${onAttr.entity} attribute`,
              customConditions: [
                { attribute: onAttr.attribute, operator: onAttr.operator, value: onAttr.value ?? '' },
              ],
            }
          : {
              ...dcDefaultConfig('SPLIT', goal),
              customSource: 'Previous step outcome',
              outcomes: step.outcomes,
            };
        const beforeIds = new Set(Object.keys(graph.nodes));
        graph = dcConfirmAddNode(graph, 'SPLIT', cfg, where, goal);
        const splitId = Object.keys(graph.nodes).find((id) => !beforeIds.has(id));
        const arms = graph.edges.filter((e) => e.from === splitId);
        const yesEdge = arms.find((e) => e.branchLabel === 'Yes') ?? arms[0];
        const noEdge = arms.find((e) => e.branchLabel === 'No') ?? arms[1];
        if (yesEdge) addSteps(step.yes, `${path}.yes`, { kind: 'edge', edgeId: yesEdge.id });
        if (noEdge) addSteps(step.no, `${path}.no`, { kind: 'edge', edgeId: noEdge.id });
        return;
      }

      issues.push({ path, problem: `Unknown step kind "${(step as { kind: string }).kind}".` });
    });
  };

  addSteps(bp.steps, 'steps');

  // --- close every remaining open path with an Exit -------------------
  let guard = 0;
  while (openSlots().length > 0 && guard++ < 40) {
    graph = dcConfirmAddNode(
      graph,
      'EXIT',
      { reason: 'Did not reach the goal in this window' },
      { kind: 'edge', edgeId: openSlots()[0].id },
      goal,
    );
  }
  guard = 0;
  while (guard++ < 40) {
    const leaf = childlessLeaves()[0];
    if (!leaf) break;
    graph = dcConfirmAddNode(graph, 'EXIT', { reason: 'Sequence complete' }, { kind: 'growLeaf', nodeId: leaf.id }, goal);
  }

  // Unresolved sends are NOT build issues: the design succeeded, the bank
  // simply has to supply ids only they hold. Export is blocked by the app's
  // own node-config validator instead.
  return { ok: issues.length === 0, graph, goal, issues, limitations, templateChoices, sendProposals };
}

/**
 * The vocabulary summary handed to the model, so it proposes only real things.
 *
 * `templateLibraryAccess` is REQUIRED, not defaulted: this block used to list
 * every template under "templates that exist" for every tenant, including the
 * ones whose library Hyperface cannot read at all. The model was then told the
 * library both exists and is unreachable, in the same prompt.
 *
 * Allowed attribute VALUES are deliberately not inlined here — one attribute
 * alone carries 34 of them. They come from list_audience_attributes instead,
 * which is pulled only when the model is actually writing a condition.
 */
/**
 * What this ISSUER can do. Bank context, not builder vocabulary.
 *
 * Kept apart from `builderVocabulary` because the two belong to different
 * phases. Which channels exist and what they cost is a business input: it
 * shapes a strategy honestly, and a campaign manager would tell you the same
 * thing. The builder's event names, attribute lists and step kinds are not —
 * they describe how the thing gets assembled, and knowing them before the
 * problem is understood is how a conversation about why customers do not
 * convert turns into a conversation about which fields are filterable.
 */
export function issuerContext(
  availableChannels: string[],
  templateLibraryAccess: 'unavailable' | 'synthetic-demo',
): string {
  return [
    '### Channels available to this issuer',
    `- ${availableChannels.join(', ')}`,
    '',
    ...(templateLibraryAccess === 'synthetic-demo'
      ? [
          '### Message templates in this tenant\'s SYNTHETIC demo library (you pick by OBJECTIVE, never by id)',
          ...COMMS_TEMPLATES.map((t) => `- ${t.name} [${t.channelType}]`),
        ]
      : [
          '### Message templates',
          '- This tenant\'s template library is NOT readable from here, so no template list exists for you to pick from. Design the message anyway: give its objective, copy, CTA and tokens. The campaign manager supplies the real account and template id.',
        ]),
  ].join('\n');
}

/**
 * How the builder assembles a journey.
 *
 * Withheld until discovery is finished. See `issuerContext` above for the
 * split, and server/CLAUDE.md for why: the agent reasoned in platform terms
 * because platform terms were the only ones it had been given, and this block
 * arriving in the opening message is most of how that happened.
 */
export function blueprintVocabulary(
  availableChannels: string[],
  templateLibraryAccess: 'unavailable' | 'synthetic-demo',
): string {
  return [
    '### Event categories and their event types',
    '(conditions on a category filter that category\'s ENTITY — call list_event_types for the full detail)',
    ...Object.entries(EVENT_CATEGORIES).map(([c, m]) => {
      const entity = DC_EVENT_ENTITY[c];
      const parts = [
        entity ? `conditions filter ${entity}` : 'no entity-based conditions',
        m.isNew ? 'MARKED NEW: proposed, not confirmed built in production' : null,
      ].filter(Boolean);
      return `- ${c}: ${m.events.join(', ')} — ${parts.join('; ')}`;
    }),
    '',
    '### Entities and attributes usable in conditions',
    '(names only. Call list_audience_attributes for each attribute\'s type, operators and ALLOWED VALUES before you write a condition — a value outside the allowed set matches nobody)',
    ...Object.entries(ELIGIBILITY_META).map(([e, attrs]) => `- ${e}: ${Object.keys(attrs).join(', ')}`),
    '',
    '### Channels available to this issuer',
    `- ${availableChannels.join(', ')}`,
    '',
    ...(templateLibraryAccess === 'synthetic-demo'
      ? [
          '### Message templates in this tenant\'s SYNTHETIC demo library (you pick by OBJECTIVE, never by id)',
          ...COMMS_TEMPLATES.map((t) => `- ${t.name} [${t.channelType}]`),
        ]
      : [
          '### Message templates',
          '- This tenant\'s template library is NOT readable from here, so no template list exists for you to pick from. Design the message anyway: give its objective, copy, CTA and tokens. The campaign manager supplies the real account and template id.',
        ]),
    '',
    '### Step kinds you may use',
    '- send, wait, waitForEvent, exit, experiment (A/B arms), condition (Yes/No on a previous send outcome)',
    '',
    '### What the application builds FOR you — do not ask for these',
    '- After every send and every wait, if a Goal is set, the application automatically inserts a Goal Check and a "Goal Reached" exit on its Yes arm. Anyone who reaches the goal leaves the journey there.',
    '- So do NOT add an exit step meaning "they already converted" or "goal reached" — it exists already, and adding one ends the journey early and drops every later step.',
    '- Use "exit" ONLY for the single final terminal state, or for the end of a branch arm.',
    '- Every remaining open path is closed with an exit automatically, so a trailing exit is optional.',
    '',
    '### Send "stage" — EXACTLY one of these three strings, nothing else',
    '- "first-touch" — the opening message',
    '- "reminder" — any follow-up or reinforcement message',
    '- "outcome" — a message about a result (approved, failed, expired)',
    '',
    // This used to list all eleven node types "for context". Four of them —
    // Branch, Goal Check, Goal Reached and the entry types — cannot be
    // produced from a blueprint at all, so the list read as an offer the
    // builder could not honour. list_step_types now reports those same types
    // with their wiring, which made the problem worse: two sources said
    // Branch exists and nothing said it was unreachable from here.
    '### Builder capabilities this blueprint CANNOT express',
    'If a design genuinely needs one of these, do not pretend you built it and do not quietly design around it. Raise it as an "operational-limitation" open item, say what you built instead, and let the campaign manager decide.',
    '- A branch with more than two outcomes (the builder calls it Branch). You have the two-way "condition" only. Closest supported: nest conditions, or pick the single split that matters most.',
    '- A condition on anything except the previous send\'s delivery outcome. Account attributes, entry-event attributes, transaction history and milestones are all real in the builder and unreachable from here. Closest supported: filter at entry instead, where conditions DO work.',
    '- A per-message delay. Every send fires immediately after the step before it. Closest supported: an explicit "wait" step between sends, which is how you space a sequence.',
    '- A fallback channel on a send. Closest supported: none — say so if delivery failure matters.',
    '- Two or more parallel paths from one step. Every journey here is a single line, branching only at a condition or an experiment.',
    '- Extra audience filters beyond one entity and its conditions, and Milestone as an audience entity. Milestone is NOT an entity this blueprint accepts and will be rejected.',
  ].join('\n');
}
