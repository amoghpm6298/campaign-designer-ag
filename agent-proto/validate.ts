// Validation wrapper. Deliberately thin: every rule below is executed by
// the APPLICATION's own function. Nothing here reimplements an app rule —
// that would create the second source of truth this prototype exists to
// avoid. The only logic owned here is walking the graph to decide which
// app function to call on what, and recording the outcome.
import { dcAddFormValid } from '../src/reducer/defaultConfig';
import { dcGraphHasOpenBranches } from '../src/reducer/graphOps';
import { DC_NODE_META, dcIsRoutingNode, dcCanFanOut, type DcNodeType } from '../src/data/nodeMeta';
import { maxSendsOnAnyPath } from './graphPaths';
import { assessSendTimes, type QuietHoursWindow } from './quietHours';
import { initialHardConstraints, isApplicable, type HardConstraintRecord } from './hardConstraints';
import {
  assessChannels,
  availabilityConfigProblem,
  describeViolation,
  isChannelViolation,
  type ChannelAvailability,
} from './channelAvailability';
import { dripCampaignFields, dripCampaignStatuses, knownIssuers, type CampaignFieldProvenance } from './campaignFields';
import { PROGRAM_OPTIONS } from '../src/data/sharedConstants';
import {
  validateAudienceConditions,
  validateEventConditions,
  describeIssue,
} from '../src/data/conditionValidation';
import type { DripCampaign, DripGraph, DripGoalCondition } from '../src/data/graphTypes';
import type { RoutingIntent } from './planner';

export type CheckStatus = 'pass' | 'fail' | 'not-run';

/**
 * The bank hard constraints this validator can act on today. Deliberately NOT
 * the whole BankContext: event freezes and risk appetite are separate,
 * unhandled constraints, and a type that accepted them would imply coverage
 * that does not exist.
 *
 * None of this is configuration the agent owns. These values are read from
 * the issuer's configuration (here: the prototype's INVENTED mock context)
 * and passed in. The agent must never define them.
 */
export interface EnforceableBankLimits {
  /**
   * Optional, because there is no such bank policy.
   *
   * This was modelled as a required hard constraint on invented data, and the
   * orchestrator stopped supplying it once that was recognised — a per-campaign
   * message cap is not something issuers set uniformly, and enforcing an
   * invented one shaped every journey the agent designed. The absent case was
   * always handled: `initialHardConstraints` reports "Not evaluated: no cap was
   * supplied to validateCampaignGraph" and the outcome stays `incomplete`,
   * which is the honest result.
   *
   * It stayed `required` for a while purely because nothing typechecked this
   * directory — see `npm run check:server`.
   */
  maxMessagesPerCustomerPerCampaign?: number;
  /** Issuer-level quiet-hours window, if the issuer configuration supplies one. */
  quietHours?: QuietHoursWindow;
  /**
   * The issuer's `channels.available` list, passed straight through from the
   * bank context. Typed as `unknown` on purpose: this check must be able to
   * report "the configuration cannot be interpreted reliably" rather than
   * crash or assume, so the shape is validated at runtime, not asserted here.
   */
  availableChannels?: unknown;
}

export interface CheckResult {
  id: string;
  description: string;
  status: CheckStatus;
  executedBy: string;
  detail?: string;
  /** Why a check could not run, when status is 'not-run'. */
  unverifiedReason?: string;
  /**
   * Marks a check as covering a bank HARD constraint — one the campaign must
   * not violate. It matters only when the check could not run: an
   * unverifiable hard constraint must not be rounded up to a pass, so it
   * downgrades the run outcome to 'incomplete' (see ValidationReport).
   */
  hardConstraint?: true;
}

export interface ValidationReport {
  /**
   * Three states, none of which is "valid" or "import-ready" — the
   * application has no JSON import path, so nothing here can prove the
   * campaign would be accepted by it.
   *
   *  - 'failed'        a check found a real violation.
   *  - 'incomplete'    nothing failed, but a HARD constraint could not be
   *                    verified. Not the same as compliant, and deliberately
   *                    not reported as pre-validated.
   *  - 'pre-validated' every check that ran passed, and no hard constraint
   *                    was left unverified.
   */
  outcome: 'pre-validated' | 'incomplete' | 'failed';
  checks: CheckResult[];
  unverified: CheckResult[];
  /**
   * Every known hard constraint, always — including the ones with no check
   * implemented yet. This is the list the outcome is derived from, so a
   * constraint cannot influence the verdict by being absent from it.
   */
  hardConstraints: HardConstraintRecord[];
  /** Ids of APPLICABLE hard constraints still at 'not-run'. Non-empty ⇒ 'incomplete'. */
  unverifiedHardConstraints: string[];
}

/**
 * The campaign-level configuration to check, if the caller has one. Optional
 * so every existing call site keeps working unchanged — a graph on its own is
 * still a valid thing to validate.
 */
export interface CampaignConfigInput {
  /** Null when the proposal is blocked — see `blockers`. */
  campaign: DripCampaign | null;
  provenance: CampaignFieldProvenance;
  /** Why no usable configuration could be produced. Required when campaign is null. */
  blockers?: string[];
}

export function validateCampaignGraph(
  graph: DripGraph,
  routingIntent?: RoutingIntent,
  limits?: EnforceableBankLimits,
  config?: CampaignConfigInput,
): ValidationReport {
  const checks: CheckResult[] = [];
  /** Pushed onto `unverified` below, once that list exists. */
  const deferredUnverified: CheckResult[] = [];

  // The registry. Every known hard constraint starts at 'not-run'; a check
  // below can only improve on that. Anything unimplemented therefore stays
  // in the record and keeps the outcome at 'incomplete'.
  const hardConstraints = initialHardConstraints();
  const setHardConstraint = (
    id: string,
    patch: Pick<HardConstraintRecord, 'status' | 'detail' | 'executedBy'>,
  ) => {
    const entry = hardConstraints.find((c) => c.id === id);
    // Throwing beats silently dropping: a typo'd id would otherwise leave the
    // constraint at 'not-run' forever while looking like it had been wired up.
    if (!entry) throw new Error(`Unknown hard-constraint id "${id}" — add it to initialHardConstraints().`);
    Object.assign(entry, patch);
  };

  // 1. Per-node required-field rules — the app's own validator, called
  //    once per node with that node's stored config.
  const nodes = Object.values(graph.nodes);
  const nodeFailures: string[] = [];
  for (const nd of nodes) {
    // GOAL_CHECK carries no config at all (always null) and is never
    // routed through a form, so dcAddFormValid has nothing to assert on
    // it. Skipping is correct, not a gap.
    if (nd.type === 'GOAL_CHECK') continue;
    const ok = dcAddFormValid(nd.type as DcNodeType, nd._config ?? {});
    if (!ok) nodeFailures.push(`${nd.id} (${DC_NODE_META[nd.type as DcNodeType]?.type ?? nd.type}) — "${nd.label}"`);
  }
  checks.push({
    id: 'node-config',
    description: 'Every node satisfies its own required-field rules',
    status: nodeFailures.length === 0 ? 'pass' : 'fail',
    executedBy: 'dcAddFormValid (src/reducer/defaultConfig.ts)',
    detail:
      nodeFailures.length === 0
        ? `${nodes.length} nodes checked (GOAL_CHECK skipped: carries no config)`
        : `failed: ${nodeFailures.join('; ')}`,
  });

  // 2. Submit gate — the same function the builder's own Submit uses.
  const hasOpen = dcGraphHasOpenBranches(graph);
  checks.push({
    id: 'no-open-branches',
    description: 'No dangling slot and no non-terminal leaf (the app\'s Submit gate)',
    status: hasOpen ? 'fail' : 'pass',
    executedBy: 'dcGraphHasOpenBranches (src/reducer/graphOps.ts)',
    detail: hasOpen ? 'graph still has at least one open branch or unterminated leaf' : 'all paths terminate',
  });

  // 3. Structural integrity of the emitted JSON. This is not an app rule —
  //    it checks that the object we produced is internally consistent
  //    before claiming anything about it.
  const danglingRefs: string[] = [];
  for (const e of graph.edges) {
    if (!graph.nodes[e.from]) danglingRefs.push(`edge ${e.id}.from → missing node ${e.from}`);
    if (e.to !== null && !graph.nodes[e.to]) danglingRefs.push(`edge ${e.id}.to → missing node ${e.to}`);
  }
  if (graph.rootId && !graph.nodes[graph.rootId]) danglingRefs.push(`rootId → missing node ${graph.rootId}`);
  // 4. Intent-aware fan-out. The app has two legitimate reasons for a node
  //    to have several outgoing edges, and this distinguishes them:
  //
  //    - a ROUTING node (dcIsRoutingNode) — Condition/Branch/Experiment/
  //      Goal Check/Wait for Event. Its arms ARE its semantics; always fine.
  //    - a FAN-OUT node (dcCanFanOut) — Entry/Send/Wait may hold genuinely
  //      parallel paths, but only when that was the plan. An undeclared one
  //      is the exact defect this check exists for: the reminder attached
  //      straight to the entry node, running in parallel with the first
  //      message instead of after it.
  //
  //    Both predicates come from the app (nodeMeta.ts) — nothing is
  //    re-implemented here, and legitimate fan-out is not prohibited.
  const declared = new Set((routingIntent?.fanOut ?? []).map((f) => f.nodeId));
  const undeclared: string[] = [];
  for (const nd of nodes) {
    const outCount = graph.edges.filter((e) => e.from === nd.id).length;
    if (outCount <= 1) continue;
    const type = nd.type as DcNodeType;
    if (dcIsRoutingNode(type)) continue; // arms are this node's own semantics
    if (declared.has(nd.id)) continue; // deliberate, and recorded
    undeclared.push(
      `${nd.id} (${DC_NODE_META[type]?.type ?? type}) has ${outCount} outgoing paths — ` +
        `${dcCanFanOut(type) ? 'fan-out is permitted for this type but was not declared by the planner' : 'this type should not fan out'}`,
    );
  }
  checks.push({
    id: 'fan-out-intent',
    description: 'Every multi-path node is either a routing node or a fan-out the planner declared',
    status: undeclared.length === 0 ? 'pass' : 'fail',
    executedBy: 'dcIsRoutingNode / dcCanFanOut (src/data/nodeMeta.ts) + planner routingIntent',
    detail:
      undeclared.length === 0
        ? `checked ${nodes.length} nodes; ${declared.size} declared fan-out point(s)`
        : `undeclared fan-out: ${undeclared.join('; ')}`,
  });

  // 3b. Every condition names a real attribute of the right entity, with an
  //     operator it accepts and a value it allows.
  //
  //     This check exists because a graph could satisfy every rule above
  //     while carrying `Transaction Status = "Auth"` — a value the platform
  //     does not define, which would match nobody. dcAddFormValid asks only
  //     whether required FIELDS are filled, never what is in them.
  const conditionFailures: string[] = [];
  const conditionLimits: string[] = [];
  for (const nd of nodes) {
    const cfg = (nd._config ?? {}) as Record<string, unknown>;
    const conds = Array.isArray(cfg.conditions) ? (cfg.conditions as DripGoalCondition[]) : [];
    if (!conds.length) continue;
    const check =
      nd.type === 'ENTRY_SEGMENT'
        ? validateAudienceConditions(String(cfg.entity ?? ''), conds)
        : nd.type === 'ENTRY_EVENT' || nd.type === 'WAIT_UNTIL'
          ? validateEventConditions(String(cfg.eventCategory ?? ''), String(cfg.eventType ?? ''), conds)
          : { issues: [], limitations: [] };
    for (const i of check.issues) conditionFailures.push(`${nd.id} (${nd.label}) — ${describeIssue(i)}`);
    for (const l of check.limitations) conditionLimits.push(`${nd.id} — ${l.note}`);
  }
  checks.push({
    id: 'condition-validity',
    description: 'Every condition uses a real attribute, operator and value for its entity',
    status: conditionFailures.length === 0 ? 'pass' : 'fail',
    executedBy: 'validateCondition (src/data/conditionValidation.ts) over ELIGIBILITY_META',
    detail:
      conditionFailures.length === 0
        ? `checked ${nodes.length} nodes` +
          (conditionLimits.length ? `; ${conditionLimits.length} value(s) the platform cannot verify: ${conditionLimits.join('; ')}` : '')
        : conditionFailures.join('; '),
  });

  checks.push({
    id: 'referential-integrity',
    description: 'Every edge endpoint and rootId refers to a node that exists',
    status: danglingRefs.length === 0 ? 'pass' : 'fail',
    executedBy: 'agent-proto/validate.ts (structural, not an app rule)',
    detail: danglingRefs.length === 0 ? `${graph.edges.length} edges checked` : danglingRefs.join('; '),
  });

  // 4a. Campaign-level configuration. STRUCTURAL, not a hard constraint and
  //     not a quality judgement:
  //
  //       - structural  — does this conform to the application's own model?
  //                       A violation is a confirmed defect, so it fails.
  //       - unresolved  — nobody has decided yet. NOT a failure: a campaign
  //                       with no dates is legal in the app today (ReviewStep
  //                       has no gate on them). Reported, never failed, and
  //                       deliberately kept out of unverifiedHardConstraints
  //                       so 'incomplete' keeps meaning "a hard constraint
  //                       could not be verified".
  //       - quality     — is 10% the right control group? Not validation.
  //
  //     Field names and statuses come from dripCampaignFields() /
  //     dripCampaignStatuses(), which read src/data/graphTypes.ts directly,
  //     so this cannot drift from the model it checks.
  if (config && config.campaign === null) {
    // Blocked, not merely incomplete. A mandatory input is missing, so there
    // is no campaign configuration to check — and none was emitted, rather
    // than one with an empty required field that would look configured.
    //
    // This is STRUCTURAL: it fails the run through `checks`, and never
    // touches unverifiedHardConstraints. Missing tenant context is not an
    // issuer-level hard-constraint violation and must not be reported as one.
    checks.push({
      id: 'campaign-config',
      description: 'Campaign-level configuration conforms to the application\'s DripCampaign model',
      status: 'fail',
      executedBy: 'buildCampaignProposal (agent-proto/campaignFields.ts)',
      detail:
        `No usable campaign configuration was produced. ${(config.blockers ?? []).length} blocker(s): ` +
        ((config.blockers ?? []).join(' | ') || 'not stated') +
        ' The agent run itself completed; this reports a missing mandatory input, not a defective campaign.',
    });
  } else if (config && config.campaign !== null) {
    const { campaign, provenance } = config;
    const spec = dripCampaignFields();
    const known = new Set(spec.map((f) => f.name));
    const present = Object.keys(campaign as unknown as Record<string, unknown>);
    const problems: string[] = [];

    // 1. No field outside the authoritative model.
    for (const key of present) {
      if (!known.has(key)) problems.push(`"${key}" is not a field on DripCampaign (src/data/graphTypes.ts)`);
    }

    // 2. Issuer must be one the application knows — unless it is the app's
    //    own unset value, which is the honest representation of "no tenant
    //    context supplied" and is reported as unresolved instead.
    const issuers = knownIssuers();
    if (campaign.issuer !== '' && !issuers.includes(campaign.issuer)) {
      problems.push(
        `issuer "${campaign.issuer}" is not a known issuer (PROGRAM_OPTIONS: ${issuers.join(', ')})`,
      );
    }

    // 3. Program scope, consistent with how the model expresses it.
    if (campaign.applyToAllPrograms === true) {
      if (campaign.programs.length > 0) {
        problems.push(
          `applyToAllPrograms is true but programs is non-empty (${campaign.programs.join(', ')}) — the model ignores programs in that case, so carrying a list is contradictory`,
        );
      }
    } else if (campaign.issuer !== '') {
      const allowed = PROGRAM_OPTIONS[campaign.issuer] ?? [];
      for (const p of campaign.programs) {
        if (!allowed.includes(p)) {
          problems.push(`program "${p}" is not available for issuer "${campaign.issuer}" (${allowed.join(', ') || 'none'})`);
        }
      }
    }

    // 4. controlPct in range. The app's own input is a percentage.
    const pct = campaign.controlPct;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      problems.push(`controlPct ${JSON.stringify(pct)} is outside the supported 0-100 range`);
    }

    // 5. A valid status from the model's own union.
    const statuses = dripCampaignStatuses();
    if (!statuses.includes(campaign.status)) {
      problems.push(`status "${campaign.status}" is not a DripCampaignStatus (${statuses.join(', ')})`);
    }

    // 6. A field recorded unresolved must actually be absent. This is the
    //    check that stops a UI default being silently re-asserted as though
    //    the user had chosen it.
    const record = campaign as unknown as Record<string, unknown>;
    for (const [field, p] of Object.entries(provenance)) {
      if (p.basis === 'unresolved' && p.omitted && record[field] !== undefined) {
        problems.push(`"${field}" is recorded unresolved and omitted, but the payload populates it with ${JSON.stringify(record[field])}`);
      }
    }

    // 7. Every emitted field must have a basis.
    for (const key of present) {
      if (!provenance[key]) problems.push(`"${key}" is emitted with no provenance entry`);
    }

    // Unresolved-but-required fields are reported, not failed. The agent
    // cannot supply them and must not invent them.
    const unresolvedRequired = spec
      .filter((f) => !f.optional && provenance[f.name]?.basis === 'unresolved')
      .map((f) => f.name);
    const unresolvedAll = Object.entries(provenance)
      .filter(([, p]) => p.basis === 'unresolved')
      .map(([f]) => f);

    checks.push({
      id: 'campaign-config',
      description: 'Campaign-level configuration conforms to the application\'s DripCampaign model',
      status: problems.length === 0 ? 'pass' : 'fail',
      executedBy: 'dripCampaignFields / dripCampaignStatuses (agent-proto/campaignFields.ts, parsed from src/data/graphTypes.ts) + PROGRAM_OPTIONS',
      detail:
        problems.length === 0
          ? `${present.length} field(s) checked against ${spec.length} model field(s); ${unresolvedAll.length} unresolved (${unresolvedAll.join(', ') || 'none'})` +
            (unresolvedRequired.length
              ? `. REQUIRED but unresolved: ${unresolvedRequired.join(', ')} — the application's own submit gate would block this campaign until a person supplies them. Reported, not failed: the agent cannot supply them and must not invent them.`
              : '')
          : `failed: ${problems.join('; ')}`,
    });
  }

  // 4b. Channel availability, checked against the GENERATED GRAPH.
  //
  //     The planner already filters unavailable channels when it picks one,
  //     but that is construction-time only — the guarantee rested entirely on
  //     the planner being right, and the audit's probe proved a hand-built
  //     RCS campaign passed as PRE-VALIDATED. This inspects the artefact.
  //
  //     Both channels on a Send are examined: the primary AND the optional
  //     fallbackChannel, which is a real delivery route. See
  //     channelAvailability.ts.
  const caDescription = 'Every Send delivers only on channels the issuer has available';
  const caExecutedBy = 'assessChannels (agent-proto/channelAvailability.ts) + issuer channels.available configuration';
  const configProblem = availabilityConfigProblem(limits?.availableChannels);
  if (configProblem) {
    // Cannot be interpreted reliably, so it is not evaluated. Never a pass:
    // claiming compliance against an unusable list would be claiming
    // compliance against nothing.
    const reason = `Not evaluated: ${configProblem}. Skipped rather than assumed satisfied.`;
    deferredUnverified.push({
      id: 'channel-availability',
      description: caDescription,
      status: 'not-run',
      hardConstraint: true,
      executedBy: '—',
      unverifiedReason: reason,
    });
    setHardConstraint('channel-availability', { status: 'not-run', detail: reason, executedBy: '—' });
  } else {
    const findings = assessChannels(graph, limits!.availableChannels as ChannelAvailability[]);
    const violations = findings.filter(isChannelViolation);
    const detail =
      violations.length === 0
        ? findings.length === 0
          ? 'no Send nodes in this campaign, so no channel is used'
          : `all ${findings.length} channel use(s) across the campaign's Sends are marked available: ` +
            findings.map((f) => `${f.nodeId}/${f.role}=${f.channel}`).join(', ')
        : `${violations.length} of ${findings.length} channel use(s) are NOT available — ` +
          violations.map(describeViolation).join('; ');
    checks.push({
      id: 'channel-availability',
      description: caDescription,
      status: violations.length === 0 ? 'pass' : 'fail',
      hardConstraint: true,
      executedBy: caExecutedBy,
      detail,
    });
    setHardConstraint('channel-availability', {
      status: violations.length === 0 ? 'pass' : 'fail',
      detail,
      executedBy: caExecutedBy,
    });
  }

  // 5. Bank message cap — the first bank hard constraint this validator
  //    actually ENFORCES rather than reports. Previously the planner wrote
  //    a trace note ("Send count N exceeds the bank cap M") and the run
  //    still came back pre-validated, so a declared violation produced a
  //    passing verdict. A statement in the trace is not compliance.
  //
  //    Measured per customer, not per graph: see graphPaths.ts for why a
  //    global Send-node count is the wrong number on any branching campaign.
  // Gated on the CAP, not merely on `limits` being present.
  //
  // THE BUG THIS FIXES, which this check's own comment above predicted. Once
  // the orchestrator stopped supplying a per-campaign cap (there is no such
  // bank policy), `limits` was still truthy — it carries quiet hours and the
  // channel list — so this block ran with `limit` undefined. `reach.max >
  // undefined` is false, so `over` was false, so it recorded
  // `status: 'pass'`: a passing verdict for a hard constraint that was never
  // evaluated, with "cap undefined" in the detail. The `else` branch below
  // exists to say "Skipped rather than assumed satisfied" and had become
  // unreachable.
  const cap = limits?.maxMessagesPerCustomerPerCampaign;
  if (typeof cap === 'number') {
    const reach = maxSendsOnAnyPath(graph);
    const limit = cap;
    const over = reach.max > limit;
    const where = reach.witnessPath.length
      ? ` Longest messaging path: ${reach.witnessPath.join(' → ')}.`
      : '';
    const executedBy =
      'maxSendsOnAnyPath (agent-proto/graphPaths.ts) + bank-context.hardConstraints.maxMessagesPerCustomerPerCampaign';
    const detail =
      `max ${reach.max} message(s) on any one of ${reach.pathCount} customer path(s), cap ${limit}` +
      (over ? ` — EXCEEDS the cap by ${reach.max - limit}.${where}` : '') +
      // A cycle makes max a lower bound, so a pass would not be proven.
      (reach.cycleDetected ? ' WARNING: a cycle was found in the graph, so this count is a lower bound.' : '');
    checks.push({
      id: 'message-cap',
      description: 'No single customer can receive more messages than the bank\'s per-campaign cap',
      status: over ? 'fail' : 'pass',
      // Marked on EVERY branch. It was previously marked only when not-run,
      // so the record could not answer "which hard constraints were verified?"
      // — the exact question 'pre-validated' claims to have answered.
      hardConstraint: true,
      executedBy,
      detail,
    });
    setHardConstraint('message-cap', { status: over ? 'fail' : 'pass', detail, executedBy });
  } else {
    setHardConstraint('message-cap', {
      status: 'not-run',
      executedBy: '—',
      detail: 'No cap was passed to validateCampaignGraph. Skipped rather than assumed satisfied.',
    });
    deferredUnverified.push({
      id: 'message-cap',
      description: 'No single customer can receive more messages than the bank\'s per-campaign cap',
      status: 'not-run',
      executedBy: '—',
      hardConstraint: true,
      unverifiedReason:
        'No cap was passed to validateCampaignGraph. The check is skipped rather than assumed satisfied — ' +
        'pass the bank context\'s hardConstraints.maxMessagesPerCustomerPerCampaign to enforce it.',
    });
  }

  // 6. Quiet hours, at DESIGN TIME. See quietHours.ts for the ownership
  //    position: the window is the ISSUER's configuration, read from the
  //    Drip Campaign system (here, the prototype's INVENTED mock context).
  //    The agent neither owns nor defines it.
  //
  //    Three outcomes, and the third is the important one. A relative send
  //    fires a delay after an event, so its wall-clock time is not knowable
  //    from the graph at all. That is recorded as not-run with the specific
  //    reason — never as compliant.
  //
  //    A pass here means the configured send time does not violate the
  //    window as designed. It does NOT mean quiet hours will be honoured at
  //    send time: that is the Drip Campaign runtime's responsibility, and
  //    the application holds no quiet-hours field today.
  const quietHoursNote =
    ' Design-time only: this reads the campaign\'s configured send times. Enforcement at send time belongs to the Drip Campaign runtime, which holds no quiet-hours field today.';
  if (limits?.quietHours) {
    const window = limits.quietHours;
    const findings = assessSendTimes(graph, window);
    const violations = findings.filter((f) => f.verdict === 'inside');
    const undetermined = findings.filter((f) => f.verdict === 'undetermined');
    const where = `window ${window.from}–${window.to} (issuer configuration; INVENTED in this prototype)`;
    const qhDescription = 'No Send is configured to fire inside the issuer\'s quiet-hours window';
    const qhExecutedBy = 'assessSendTimes (agent-proto/quietHours.ts) + issuer quietHours configuration';

    if (violations.length > 0) {
      // A known violation outranks an unknown: this is established, not suspected.
      const detail =
        `${violations.length} of ${findings.length} Send(s) fall INSIDE the ${where}: ` +
        violations.map((v) => `${v.nodeId} "${v.label}" at ${'at' in v ? v.at : '?'}`).join('; ') +
        (undetermined.length ? ` (${undetermined.length} further Send(s) could not be determined)` : '') +
        quietHoursNote;
      checks.push({
        id: 'quiet-hours',
        description: qhDescription,
        status: 'fail',
        hardConstraint: true,
        executedBy: qhExecutedBy,
        detail,
      });
      setHardConstraint('quiet-hours', { status: 'fail', detail, executedBy: qhExecutedBy });
    } else if (undetermined.length > 0) {
      const reason =
        `${undetermined.length} of ${findings.length} Send(s) have no determinable send time, so compliance with the ${where} cannot be established either way — not that it is satisfied. ` +
        undetermined.map((u) => `${u.nodeId} "${u.label}": ${'reason' in u ? u.reason : '?'}`).join('; ') +
        '. Determining these would require resolving the trigger\'s wall-clock time, which is a runtime fact, not a design-time one.';
      deferredUnverified.push({
        id: 'quiet-hours',
        description: qhDescription,
        status: 'not-run',
        hardConstraint: true,
        executedBy: '—',
        unverifiedReason: reason,
      });
      setHardConstraint('quiet-hours', { status: 'not-run', detail: reason, executedBy: '—' });
    } else {
      const detail =
        (findings.length === 0
          ? `no Send nodes in this campaign, so nothing can fall inside the ${where}`
          : `all ${findings.length} Send(s) are absolutely timed and fall outside the ${where}: ` +
            findings.map((f) => `${f.nodeId} at ${'at' in f ? f.at : '?'}`).join('; ')) + quietHoursNote;
      checks.push({
        id: 'quiet-hours',
        description: qhDescription,
        status: 'pass',
        hardConstraint: true,
        executedBy: qhExecutedBy,
        detail,
      });
      setHardConstraint('quiet-hours', { status: 'pass', detail, executedBy: qhExecutedBy });
    }
  } else {
    const reason =
      'No quiet-hours window was supplied. The agent does not define one — it is issuer configuration owned by the Drip Campaign system. Skipped rather than assumed satisfied.';
    deferredUnverified.push({
      id: 'quiet-hours',
      description: 'No Send is configured to fire inside the issuer\'s quiet-hours window',
      status: 'not-run',
      hardConstraint: true,
      executedBy: '—',
      unverifiedReason: reason,
    });
    setHardConstraint('quiet-hours', { status: 'not-run', detail: reason, executedBy: '—' });
  }

  // Checks that genuinely cannot run here. Recorded explicitly rather than
  // silently omitted, so the report can never imply more coverage than it
  // actually has.
  const unverified: CheckResult[] = [
    {
      id: 'app-import-accepts',
      description: 'The Drip Campaign application actually accepts this JSON and builds the campaign',
      status: 'not-run',
      executedBy: '—',
      unverifiedReason:
        'The application has no JSON import path. Campaigns are seeded in memory and built through the UI. Until an import exists, no run can prove the output would be accepted.',
    },
    // The bundled 'bank-constraint-enforcement' prose entry that used to sit
    // here is gone. It packed four distinct hard constraints — event freezes,
    // message spacing, DNC, NPA — into one unmarked string, which is how they
    // stayed invisible to the outcome. They are now individual records in the
    // hardConstraints registry, each with its own id, source and reason.
    //
    // Cost ceilings are deliberately NOT in the registry: no such limit
    // exists anywhere in the context. relativeCost is an ordinal preference,
    // not a ceiling, so there is no hard constraint to track.
    //
    // maker-checker has moved to the registry too, where it can be recorded
    // as 'not-applicable' with a reason instead of masquerading as merely
    // unverified.
    {
      id: 'campaign-quality',
      description: 'The campaign is a good campaign for the stated goal',
      status: 'not-run',
      executedBy: '—',
      unverifiedReason:
        'Not mechanically checkable. A schema-valid campaign is not necessarily a good one. Requires human review; deliberately kept separate from validity.',
    },
  ];

  unverified.push(...deferredUnverified);

  // Outcome, derived from the REGISTRY rather than from whichever entries
  // happen to exist. That is the whole point of the change: previously a
  // constraint could influence the verdict by being absent, and the audit
  // proved it — an RCS send, on a channel the context marks unavailable,
  // came back 'pre-validated' with five hard constraints unrepresented.
  //
  // Ordering is deliberate:
  //   1. a confirmed violation always wins — 'failed'.
  //   2. otherwise any APPLICABLE constraint still at 'not-run' — 'incomplete'.
  //      "We could not tell" must never read as "complies".
  //   3. 'pre-validated' only when every applicable constraint passed.
  // 'not-applicable' never downgrades, because there is nothing to satisfy.
  const anyCheckFailed = checks.some((c) => c.status === 'fail');
  const anyConstraintFailed = hardConstraints.some((c) => c.status === 'fail');
  const unverifiedHardConstraints = hardConstraints
    .filter((c) => isApplicable(c) && c.status === 'not-run')
    .map((c) => c.id);

  const outcome =
    anyCheckFailed || anyConstraintFailed
      ? 'failed'
      : unverifiedHardConstraints.length > 0
        ? 'incomplete'
        : 'pre-validated';

  return { outcome, checks, unverified, hardConstraints, unverifiedHardConstraints };
}
