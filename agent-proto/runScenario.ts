// The agent-generation pipeline: schema-drift gate → plan → campaign
// proposal → validation → run record.
//
// Extracted from run.task.ts without behaviour change, for one reason: the
// end-to-end tests have to exercise the REAL pipeline. A test that rebuilt
// these steps itself would be asserting against a copy, and the copy would
// drift from what `npm run agent:run` actually does — which is exactly the
// class of defect this prototype keeps finding. One pipeline, three callers:
// the sample run and both end-to-end scenarios.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan } from './planner';
import { validateCampaignGraph, type ValidationReport } from './validate';
import { generateSchemaArtefact } from './schema/generateSchema';
import { buildCampaignProposal, type CampaignFieldProvenance, type TenantContext } from './campaignFields';
import { dcResetIdCounters } from '../src/reducer/idGen';
import type { DripCampaign } from '../src/data/graphTypes';

const here = dirname(fileURLToPath(import.meta.url));
export const readAgentJson = (p: string) => JSON.parse(readFileSync(resolve(here, p), 'utf8'));

export interface RunScenarioInput {
  /** Path, relative to agent-proto/, of the scenario to run. */
  scenarioPath: string;
  /** Path, relative to agent-proto/, of the bank context. */
  bankContextPath?: string;
  /**
   * Tenant context, when the caller has it. Omitted for the production-like
   * sample run, which has no platform integration — that run is expected to
   * come back blocked, and that is the honest result rather than a gap in the
   * test.
   */
  tenantContext?: TenantContext;
}

export interface ScenarioRun {
  runRecord: Record<string, unknown> & {
    runId: string;
    campaign: DripCampaign | null;
    campaignConfigurationUsable: boolean;
    campaignConfigurationBlockers: string[];
    campaignFieldProvenance: CampaignFieldProvenance;
    unresolvedCampaignFields: string[];
    validation: ValidationReport;
    claim: string;
  };
  campaign: DripCampaign | null;
  provenance: CampaignFieldProvenance;
  unresolvedCampaignFields: string[];
  blockers: string[];
  usable: boolean;
  validation: ValidationReport;
  schema: ReturnType<typeof generateSchemaArtefact>;
  scenario: { scenarioId: string; scenarioVersion?: string; goalStatement: string };
  bank: Record<string, never> | Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export function runScenario(input: RunScenarioInput): ScenarioRun {
  // Deterministic node/edge ids, so two runs of an unchanged scenario
  // produce comparable records rather than differing by id noise.
  dcResetIdCounters();

  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const scenario = readAgentJson(input.scenarioPath);
  const bank = readAgentJson(input.bankContextPath ?? 'context/bank-context.json');
  const principles = readAgentJson('context/principles.json');
  const schema = generateSchemaArtefact();

  // Schema drift gate. The artefact on disk must match what the app's
  // current definitions generate — otherwise the agent is planning
  // against a stale schema and any output is untrustworthy. Fails the
  // run explicitly rather than generating an incompatible campaign.
  const committed = readAgentJson('schema/campaign-schema.json');
  if (committed.contentHash !== schema.contentHash) {
    throw new Error(
      `Schema drift: committed artefact hash ${committed.contentHash} != generated ${schema.contentHash}. ` +
        'The application definitions changed. Regenerate with `npm run agent:schema` and re-review before running.',
    );
  }

  const result = plan(scenario, bank);

  // Campaign-level fields are not literals: each one has a recorded basis,
  // fields nobody decided are OMITTED, and a missing mandatory input blocks
  // the whole proposal. See campaignFields.ts.
  const proposal = buildCampaignProposal({
    scenarioId: scenario.scenarioId,
    goalStatement: scenario.goalStatement,
    goal: result.goal,
    graph: result.graph,
    tenantContext: input.tenantContext,
  });
  const { campaign, provenance, unresolvedCampaignFields, blockers } = proposal;

  // Limits are passed explicitly rather than handing validate.ts the whole
  // context: these are the bank hard constraints the validator can act on
  // today, and a wider parameter would imply wider coverage.
  //
  // quietHours is ISSUER configuration, read from the context and passed
  // through. The agent does not own or define it. In this prototype the
  // window is INVENTED mock data (see bank-context.json).
  const validation = validateCampaignGraph(
    result.graph,
    result.routingIntent,
    {
      quietHours: bank.hardConstraints.quietHours,
      availableChannels: bank.channels.available,
    },
    { campaign, provenance, blockers },
  );
  validation.checks.unshift({
    id: 'schema-freshness',
    description: 'Committed schema artefact matches what the app source currently generates',
    status: 'pass',
    executedBy: 'agent-proto/runScenario.ts (contentHash comparison)',
    detail: `hash ${schema.contentHash} matches committed artefact`,
  });

  const runRecord = {
    runId: `run-${startedAt.replace(/[:.]/g, '-')}`,
    startedAt,
    durationMs: Date.now() - t0,
    scenario: { id: scenario.scenarioId, version: scenario.scenarioVersion, goalStatement: scenario.goalStatement },
    versions: {
      schemaArtefactVersion: schema.schemaArtefactVersion,
      schemaContentHash: schema.contentHash,
      bankContextVersion: bank.contextVersion,
      principlesVersion: principles.principlesVersion,
      plannerKind: 'deterministic (no model call in this slice)',
    },
    // Recorded so a reader can tell whether a tenant was supplied at all, and
    // that this prototype has no platform integration to supply one.
    tenantContext: input.tenantContext
      ? { ...input.tenantContext, note: 'Supplied by the caller. No production platform integration exists.' }
      : null,
    conversation: result.conversation,
    routingIntent: result.routingIntent,
    decisions: result.decisions,
    assumptions: result.assumptions,
    // null when the proposal is blocked: an unusable configuration is not
    // emitted at all, rather than emitted with an empty required field.
    campaign,
    campaignConfigurationUsable: proposal.usable,
    campaignConfigurationBlockers: blockers as string[],
    // Agent metadata, deliberately a SIBLING of campaign and never inside
    // it: the campaign payload must stay a plain DripCampaign the app
    // could consume, and provenance is not something it would ever read.
    campaignFieldProvenance: provenance,
    unresolvedCampaignFields,
    validation,
    trace: result.trace,
    // Stated on every record so a reader can never infer more than was
    // actually established.
    claim:
      (proposal.usable
        ? 'PROPOSED CAMPAIGN CONFIGURATION — not a complete campaign, and NOT IMPORT-READY. '
        : 'NO USABLE CAMPAIGN CONFIGURATION. The agent run completed, but a mandatory input was missing, so no campaign was emitted (campaign is null). ' +
          `Blocker(s): ${blockers.join(' | ')} This is a missing input, not an issuer-level hard-constraint violation. NOT IMPORT-READY. `) +
      `OUTCOME: ${validation.outcome.toUpperCase()}. ` +
      (unresolvedCampaignFields.length
        ? `${unresolvedCampaignFields.length} campaign-level field(s) are UNRESOLVED and were left for a person to decide: [${unresolvedCampaignFields.join(', ')}]. ` +
          'See campaignFieldProvenance for the missing input behind each. Fields owned by the user or the existing Drip Campaign system (guardrails, re-entry) are omitted rather than defaulted, so the application\'s own defaults apply. '
        : '') +
      'Checks that ran are listed in validation.checks and were executed by the application\'s own functions. ' +
      (validation.unverifiedHardConstraints.length
        ? `The hard constraint(s) [${validation.unverifiedHardConstraints.join(', ')}] could not be verified and are NOT treated as passed. `
        : '') +
      'Checks that pass are design-time only; enforcing operational restrictions at send time is the Drip Campaign runtime\'s responsibility. ' +
      'The application has no JSON import path, so this run cannot prove the campaign would be accepted by it.',
  };

  return {
    runRecord,
    campaign,
    provenance,
    unresolvedCampaignFields,
    blockers: blockers as string[],
    usable: proposal.usable,
    validation,
    schema,
    scenario,
    bank,
  };
}

/** Console report, shared so both run paths print the same thing. */
export function reportScenarioRun(run: ScenarioRun): void {
  const { runRecord, validation, provenance, blockers, schema, scenario, bank } = run;
  console.log(`\n  RUN ${runRecord.runId}`);
  console.log(`  scenario        : ${scenario.scenarioId}`);
  console.log(`  schema          : v${schema.schemaArtefactVersion} (${schema.contentHash})`);
  console.log(`  bank context    : v${bank.contextVersion} — ${bank.bank.displayName} [${bank.status}]`);
  console.log(`  tenant context  : ${runRecord.tenantContext ? JSON.stringify(runRecord.tenantContext) : 'NOT SUPPLIED'}`);
  console.log(`\n  CAMPAIGN CONFIGURATION: ${run.usable ? 'usable proposal' : 'BLOCKED — no campaign emitted'}`);
  for (const b of blockers) console.log(`    blocker: ${b}`);
  console.log(`\n  CAMPAIGN FIELDS (${Object.keys(provenance).length} with recorded basis):`);
  for (const [field, p] of Object.entries(provenance)) {
    console.log(`    [${p.basis.padEnd(24)}] ${field}${p.omitted ? ' (omitted from payload)' : ''}`);
  }
  console.log(`\n  HARD CONSTRAINTS (${validation.hardConstraints.length} known):`);
  for (const c of validation.hardConstraints) {
    console.log(`    [${c.status.toUpperCase().padEnd(14)}] ${c.id} — ${c.name}`);
  }
  console.log(`\n  CHECKS RUN:`);
  for (const c of validation.checks) console.log(`    [${c.status.toUpperCase().padEnd(4)}] ${c.id} — ${c.detail}`);
  console.log(`\n  NOT RUN (${validation.unverified.length}):`);
  for (const c of validation.unverified) console.log(`    [----] ${c.id} — ${c.unverifiedReason}`);
  if (validation.unverifiedHardConstraints.length) {
    console.log(`\n  UNVERIFIED (applicable, not evaluated): ${validation.unverifiedHardConstraints.join(', ')}`);
    console.log('    -> not treated as passed; outcome is downgraded below.');
  }
  console.log(`\n  OUTCOME: ${validation.outcome.toUpperCase()}`);
  console.log(`  ${runRecord.claim}\n`);
}
