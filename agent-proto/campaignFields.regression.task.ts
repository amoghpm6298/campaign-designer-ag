// Regression tests for campaign-level configuration, provenance and validation.
//
// The defects this closes, all of them "a value that looks decided but was
// not": run.task.ts hardcoded `issuer` to a FICTIONAL bank that is not even a
// valid issuer, a fabricated one-item program list, `guardrails: {dnc:true,
// npa:true}` and `allowReEntry:false` (both UI defaults asserted as though a
// user had chosen them), and controlPct sourced from an INVENTED bank
// preference. None of it was validated, because the campaign payload was
// never passed to the validator at all.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan } from './planner';
import { validateCampaignGraph } from './validate';
import {
  buildCampaignProposal,
  dripCampaignFields,
  dripCampaignStatuses,
  knownIssuers,
  type CampaignFieldProvenance,
  type TenantContext,
} from './campaignFields';
import { generateSchemaArtefact, stableHash, SCHEMA_ARTEFACT_VERSION } from './schema/generateSchema';
import { dcResetIdCounters } from '../src/reducer/idGen';
import { PROGRAM_OPTIONS } from '../src/data/sharedConstants';
import type { DripCampaign } from '../src/data/graphTypes';

const here = dirname(fileURLToPath(import.meta.url));
const readJson = (p: string) => JSON.parse(readFileSync(resolve(here, p), 'utf8'));

/** A real application issuer, read from the app rather than hardcoded. */
const REAL_ISSUER = knownIssuers()[0];
const REAL_TENANT = { tenantId: 'TEN-7741', issuer: REAL_ISSUER };

/** The real scenario, planned through the app's own reducer. */
function proposal(tenantContext?: TenantContext) {
  const bank = readJson('context/bank-context.json');
  dcResetIdCounters();
  const result = plan(readJson('scenarios/auth-txn-to-emi.json'), bank);
  const built = buildCampaignProposal({
    scenarioId: 'auth-txn-to-emi',
    goalStatement: 'test',
    goal: result.goal,
    graph: result.graph,
    tenantContext,
  });
  return { ...built, result, bank };
}

/** A proposal with a verified tenant, narrowed to the usable branch. */
function usable(tenantContext: TenantContext = REAL_TENANT) {
  const p = proposal(tenantContext);
  if (!p.usable) throw new Error(`expected a usable proposal, blocked: ${p.blockers.join('; ')}`);
  return p;
}

/** Validates a proposal, reusing its own graph. */
function check(campaign: DripCampaign, provenance: CampaignFieldProvenance) {
  const report = validateCampaignGraph(campaign.root!, undefined, undefined, { campaign, provenance });
  return { report, cfg: report.checks.find((c) => c.id === 'campaign-config')! };
}

describe('the field list is derived from the application model', () => {
  it('parses DripCampaign from src/data/graphTypes.ts, with optionality', () => {
    const fields = dripCampaignFields();
    const byName = new Map(fields.map((f) => [f.name, f.optional]));

    // Required by the model — cannot be omitted.
    for (const f of ['id', 'name', 'issuer', 'programs', 'goal', 'controlPct', 'status', 'root']) {
      expect(byName.get(f), `${f} should be required`).toBe(false);
    }
    // Optional — can honestly be omitted.
    for (const f of ['description', 'applyToAllPrograms', 'startDate', 'endDate', 'allowReEntry', 'guardrails']) {
      expect(byName.get(f), `${f} should be optional`).toBe(true);
    }
    // guardrails' inner members are not campaign fields.
    expect(byName.has('dnc')).toBe(false);
    expect(byName.has('npa')).toBe(false);
  });

  it('parses the status union from source rather than copying it', () => {
    expect(dripCampaignStatuses()).toContain('DRAFT');
    expect(dripCampaignStatuses()).toContain('PENDING_REVIEW');
  });
});

describe('tenant context is mandatory', () => {
  it('populates issuer from a verified platform mapping and records platform-context', () => {
    const { campaign, provenance } = usable();
    expect(campaign.issuer).toBe(REAL_ISSUER);
    expect(provenance.issuer.basis).toBe('platform-context');
    expect(provenance.issuer.reference).toMatch(/TEN-7741/);
    // The tenant id is what the platform selected; issuer is what it maps to.
    expect(provenance.issuer.reference).toMatch(new RegExp(REAL_ISSUER.replace(/[()]/g, '\\$&')));
    expect(provenance.issuer.reason).toBeUndefined();
  });

  it('produces NO usable campaign configuration when tenant context is missing', () => {
    const { usable: ok, campaign, blockers, provenance } = proposal();
    expect(ok).toBe(false);
    // Not an empty issuer dressed up as valid — no campaign at all.
    expect(campaign).toBeNull();
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers[0]).toMatch(/No tenant context was supplied/);
    expect(blockers[0]).toMatch(/must not ask again or infer one/);
    expect(provenance.issuer.basis).toBe('unresolved');
  });

  it('blocks the run structurally, not as a hard-constraint violation', () => {
    const { campaign, provenance, blockers, result } = proposal();
    const report = validateCampaignGraph(result.graph, undefined, undefined, { campaign, provenance, blockers });
    const cfg = report.checks.find((c) => c.id === 'campaign-config')!;

    expect(cfg.status).toBe('fail');
    expect(cfg.detail).toMatch(/No usable campaign configuration was produced/);
    expect(cfg.detail).toMatch(/not a defective campaign/);
    expect(report.outcome).toBe('failed');
    // The distinction that matters: this is structural.
    expect(cfg.hardConstraint).toBeUndefined();
    expect(report.unverifiedHardConstraints).not.toContain('campaign-config');
    expect(report.unverifiedHardConstraints).not.toContain('issuer');
  });

  it('never invents an issuer, and never equates tenantId with issuer', () => {
    const { campaign, blockers, provenance, bank } = proposal({ tenantId: 'TEN-9999', issuer: 'Bank Of Nowhere' });

    // An unrecognised asserted issuer is an unreliable mapping, not a cue to
    // guess. The tenantId must not be substituted for the issuer either.
    expect(campaign).toBeNull();
    expect(blockers[0]).toMatch(/which the application does not know/);
    expect(provenance.issuer.reason).toMatch(/Not inferred from tenantId/);
    expect(provenance.issuer.reason).toMatch(/tenant identity and issuer are distinct/);

    // And the fictional bank is never used as a fallback.
    expect(bank.bank.displayName).toMatch(/FICTIONAL/);
    expect(JSON.stringify({ blockers, provenance })).not.toContain('Meridian Bank (FICTIONAL)');
  });

  it('a tenant whose issuer IS known passes structural validation', () => {
    const { campaign, provenance } = usable();
    const { report, cfg } = check(campaign, provenance);
    expect(cfg.status).toBe('pass');
    expect(cfg.detail).not.toMatch(/REQUIRED but unresolved/);
    expect(report.outcome).not.toBe('failed');
  });
});

describe('program scope', () => {
  it('uses the model\'s all-programs flag, not a fabricated list', () => {
    const { campaign, provenance } = usable();
    expect(campaign.applyToAllPrograms).toBe(true);
    expect(campaign.programs).toEqual([]);

    // The scenario names a fictional program; it must not leak into the payload.
    const scenario = readJson('scenarios/auth-txn-to-emi.json');
    expect(scenario.simulatedAnswers.which_programs.answer).toMatch(/Meridian Platinum/);
    expect(campaign.programs).not.toContain('Meridian Platinum');

    // Recorded as a deliberate prototype default — NOT evidence-backed, and
    // NOT the application's own default, which is false.
    expect(provenance.applyToAllPrograms.basis).toBe('prototype-default');
    expect(provenance.applyToAllPrograms.basis).not.toBe('supported-recommendation');
    expect(provenance.applyToAllPrograms.basis).not.toBe('application-default');
    expect(provenance.applyToAllPrograms.reference).toMatch(/the application defaults this to false/);
    expect(provenance.programs.basis).toBe('prototype-default');
  });

  it('records that the user can change program scope before going live', () => {
    const { provenance } = usable();
    for (const f of ['applyToAllPrograms', 'programs']) {
      expect(provenance[f].reference, f).toMatch(/before the campaign goes live/);
    }
    expect(provenance.applyToAllPrograms.reference).toMatch(/STARTING configuration/);
  });

  it('fails when all-programs is combined with a program list', () => {
    const { campaign, provenance } = usable();
    const inconsistent = { ...campaign, programs: ['Platinum Aura'] };
    const { report, cfg } = check(inconsistent, provenance);
    expect(cfg.status).toBe('fail');
    expect(cfg.detail).toMatch(/applyToAllPrograms is true but programs is non-empty/);
    expect(report.outcome).toBe('failed');
  });

  it('fails a program that is not available for the chosen issuer', () => {
    const issuer = knownIssuers()[0];
    const { campaign, provenance } = usable({ tenantId: 'TEN-1', issuer });
    const wrong = { ...campaign, applyToAllPrograms: false, programs: ['Prosperity Card'] };
    expect(PROGRAM_OPTIONS[issuer]).not.toContain('Prosperity Card'); // premise
    const { cfg } = check(wrong, provenance);
    expect(cfg.status).toBe('fail');
    expect(cfg.detail).toMatch(/is not available for issuer/);
  });
});

describe('user-owned fields are omitted, not defaulted', () => {
  it('stamps DNC/NPA from the builder default rather than asking the agent', () => {
    const { campaign, provenance } = usable();
    expect(campaign.guardrails).toEqual({ dnc: true, npa: true });
    expect(provenance.guardrails.basis).toBe('application-default');
    expect(provenance.guardrails.reference).toMatch(/DripBuilder\.tsx:95-96/);
  });

  it('omits re-entry and never invents a cool-off', () => {
    const { campaign, provenance } = usable();
    expect('allowReEntry' in campaign).toBe(false);
    expect('reEntryCooloffDuration' in campaign).toBe(false);
    expect('reEntryCooloffUnit' in campaign).toBe(false);
    expect(provenance.allowReEntry.basis).toBe('unresolved');
    expect(provenance.reEntryCooloffDuration.reason).toMatch(/No cool-off is invented/);
  });

  it('fails if a field recorded as omitted is actually populated', () => {
    // Guards the guard: this is what would catch a future edit silently
    // re-asserting a UI default as though it were a user choice.
    const { campaign, provenance } = usable();
    const sneaky = { ...campaign, startDate: '2026-01-01' };
    const { report, cfg } = check(sneaky, provenance);
    expect(cfg.status).toBe('fail');
    expect(cfg.detail).toMatch(/"startDate" is recorded unresolved and omitted, but the payload populates it/);
    expect(report.outcome).toBe('failed');
  });
});

describe('dates and control group', () => {
  it('omits dates and states the missing inputs', () => {
    const { campaign, provenance } = usable();
    expect('startDate' in campaign).toBe(false);
    expect('endDate' in campaign).toBe(false);
    expect(provenance.startDate.reason).toMatch(/no real event calendar/i);
    expect(provenance.startDate.reason).toMatch(/INVENTED/);
    expect(provenance.startDate.reason).toMatch(/objective window/);
  });

  it('unresolved dates do not alter the hard-constraint outcome', () => {
    // A VERIFIED tenant, so the only unresolved things left are optional —
    // dates and re-entry. Otherwise this would be measuring the tenant block
    // rather than the dates.
    const { campaign, provenance, result, bank } = usable();
    const limits = {
      quietHours: bank.hardConstraints.quietHours,
      availableChannels: bank.channels.available,
    };

    const withConfig = validateCampaignGraph(result.graph, result.routingIntent, limits, { campaign, provenance });
    const withoutConfig = validateCampaignGraph(result.graph, result.routingIntent, limits);

    // The campaign-config check passes, so dates changed nothing at all.
    expect(withConfig.checks.find((c) => c.id === 'campaign-config')?.status).toBe('pass');
    // Identical hard-constraint outcome, with and without the campaign.
    expect(withConfig.unverifiedHardConstraints).toEqual(withoutConfig.unverifiedHardConstraints);
    expect(withConfig.outcome).toBe(withoutConfig.outcome);
    // And no unresolved campaign field leaked into the hard-constraint list.
    for (const f of ['startDate', 'endDate', 'guardrails', 'allowReEntry']) {
      expect(withConfig.unverifiedHardConstraints).not.toContain(f);
    }
  });

  it('sources controlPct from the application default, not the invented bank preference', () => {
    const { campaign, provenance, bank } = usable();
    expect(campaign.controlPct).toBe(10);
    expect(provenance.controlPct.basis).toBe('application-default');
    expect(provenance.controlPct.reference).toMatch(/DripBuilder\.tsx:91/);
    // The invented preference holds the same number; the record says so
    // rather than letting the coincidence read as evidence.
    expect(bank.softPreferences.preferredControlGroupPct.assumption).toBe('INVENTED');
    expect(provenance.controlPct.reference).toMatch(/INVENTED/);
    expect(provenance.controlPct.reference).toMatch(/quality question/);
  });

  it('fails an out-of-range controlPct', () => {
    const { campaign, provenance } = usable();
    for (const bad of [-1, 101, Number.NaN]) {
      const { report, cfg } = check({ ...campaign, controlPct: bad }, provenance);
      expect(cfg.status, `controlPct ${bad}`).toBe('fail');
      expect(cfg.detail).toMatch(/outside the supported 0-100 range/);
      expect(report.outcome).toBe('failed');
    }
  });
});

describe('structural validation of the payload', () => {
  it('rejects a field that is not on DripCampaign', () => {
    const { campaign, provenance } = usable();
    const extra = { ...campaign, tenantId: 'TEN-1' } as DripCampaign;
    const { report, cfg } = check(extra, { ...provenance, tenantId: { basis: 'platform-context' } });
    expect(cfg.status).toBe('fail');
    expect(cfg.detail).toMatch(/"tenantId" is not a field on DripCampaign/);
    expect(report.outcome).toBe('failed');
  });

  it('requires provenance for every emitted field', () => {
    const { campaign, provenance } = usable();
    const { description, ...withoutOne } = provenance;
    void description;
    const { report, cfg } = check(campaign, withoutOne);
    expect(cfg.status).toBe('fail');
    expect(cfg.detail).toMatch(/"description" is emitted with no provenance entry/);
    expect(report.outcome).toBe('failed');
  });

  it('every emitted field has provenance in the real proposal', () => {
    const { campaign, provenance } = usable();
    for (const key of Object.keys(campaign)) {
      expect(provenance[key], `${key} has no provenance`).toBeDefined();
    }
    // Every non-unresolved entry cites a source.
    for (const [field, p] of Object.entries(provenance)) {
      if (p.basis === 'unresolved') expect(p.reason, `${field}`).toBeTruthy();
      else expect(p.reference, `${field}`).toBeTruthy();
    }
  });

  it('rejects a status outside the model\'s own union', () => {
    const { campaign, provenance } = usable();
    const { cfg } = check({ ...campaign, status: 'LAUNCHED' as never }, provenance);
    expect(cfg.status).toBe('fail');
    expect(cfg.detail).toMatch(/is not a DripCampaignStatus/);
  });

  it('keeps provenance out of the campaign payload', () => {
    const { campaign } = usable();
    expect('campaignFieldProvenance' in campaign).toBe(false);
    expect('provenance' in campaign).toBe(false);
    // Nothing but real DripCampaign fields.
    const known = new Set(dripCampaignFields().map((f) => f.name));
    for (const k of Object.keys(campaign)) expect(known.has(k), k).toBe(true);
  });

  it('a campaign-config failure does not touch unverifiedHardConstraints', () => {
    // Structural and hard-constraint concerns stay separate.
    const { campaign, provenance } = usable();
    const broken = { ...campaign, controlPct: 999 };
    const { report } = check(broken, provenance);
    expect(report.outcome).toBe('failed');
    expect(report.unverifiedHardConstraints).not.toContain('campaign-config');
    expect(report.hardConstraints.map((c) => c.id)).not.toContain('campaign-config');
  });
});

describe('the schema-drift gate covers campaign fields', () => {
  it('includes the DripCampaign field list in the artefact', () => {
    const artefact = generateSchemaArtefact();
    expect(artefact.campaignFields.fields.map((f) => f.name)).toEqual(dripCampaignFields().map((f) => f.name));
    expect(artefact.campaignFields.statuses).toEqual(dripCampaignStatuses());
    expect(artefact.source.modules).toContain('src/data/graphTypes.ts (DripCampaign fields, DripCampaignStatus)');
  });

  it('the committed artefact is in sync with the source', () => {
    const committed = readJson('schema/campaign-schema.json');
    expect(committed.contentHash).toBe(generateSchemaArtefact().contentHash);
    expect(committed.campaignFields.fields.length).toBe(dripCampaignFields().length);
  });

  it('the artefact version follows the repo convention, and is not the drift mechanism', () => {
    // Convention, stated in generateSchema.ts: this number tracks the
    // ARTEFACT'S OWN STRUCTURE, while the content hash tracks drift in the
    // app's definitions. Adding the top-level `campaignFields` key is an
    // additive, backward-compatible structural change -> minor bump.
    expect(SCHEMA_ARTEFACT_VERSION).toBe('1.1.0');
    const a = generateSchemaArtefact();
    expect(a.schemaArtefactVersion).toBe('1.1.0');
    expect(readJson('schema/campaign-schema.json').schemaArtefactVersion).toBe('1.1.0');

    // The version must NOT be part of the hashed content: bumping it must not
    // masquerade as drift detection, and drift must not depend on it.
    expect(stableHash({
      campaignFields: a.campaignFields,
      nodeTypes: a.nodeTypes,
      pickerCategories: a.pickerCategories,
      vocabulary: a.vocabulary,
    })).toBe(a.contentHash);
  });

  it('a change to the campaign field list changes the hash', () => {
    // Drift detection proven by recomputing the real hash, using the same
    // function the gate uses, over content with one campaign field dropped —
    // exactly what a change to DripCampaign would produce.
    const a = generateSchemaArtefact();
    const content = (fields: typeof a.campaignFields.fields) => ({
      campaignFields: { fields, statuses: a.campaignFields.statuses },
      nodeTypes: a.nodeTypes,
      pickerCategories: a.pickerCategories,
      vocabulary: a.vocabulary,
    });

    const asGenerated = stableHash(content(a.campaignFields.fields));
    const withFieldDropped = stableHash(content(a.campaignFields.fields.slice(0, -1)));

    // The generated hash must match the artefact's own, proving `content` here
    // is the same object the gate hashes...
    expect(asGenerated).toBe(a.contentHash);
    // ...and dropping a campaign field must move it, which is what makes the
    // run fail instead of planning against a stale model.
    expect(withFieldDropped).not.toBe(asGenerated);
  });
});
