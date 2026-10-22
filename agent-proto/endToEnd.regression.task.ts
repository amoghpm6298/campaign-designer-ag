// End-to-end coverage for BOTH campaign-generation paths.
//
// Why two scenarios rather than one. Tenant context is mandatory, and the
// production-like sample scenario has none, because this prototype has no
// platform integration. Blocking is the correct result there — but it left the
// usable path with no end-to-end coverage at all. So:
//
//   1. missing tenant  -> the real sample scenario, expected BLOCKED.
//   2. verified tenant -> the same scenario plus an explicitly SYNTHETIC
//                         tenant fixture, expected usable.
//
// Both run the real pipeline (runScenario.ts) — the same code `npm run
// agent:run` executes. Neither constructs a campaign object by hand.
//
// What these tests do NOT establish: that production tenant integration
// exists, or that any tenant-to-issuer mapping has been verified. The fixture
// asserts a mapping for test purposes only. No production mapping exists.
import { describe, it, expect } from 'vitest';
import { runScenario, readAgentJson } from './runScenario';
import { dripCampaignFields, knownIssuers } from './campaignFields';
import type { TenantContext } from './campaignFields';

const SCENARIO = 'scenarios/auth-txn-to-emi.json';

/** The synthetic fixture, loaded from disk so the label travels with it. */
const fixture = readAgentJson('fixtures/synthetic-tenant-context.json');
const SYNTHETIC_TENANT = fixture.tenantContext as TenantContext;

describe('end-to-end 1 — sample scenario with NO tenant context (blocked path)', () => {
  it('completes the run, blocks the configuration, and emits no campaign', () => {
    const run = runScenario({ scenarioPath: SCENARIO });

    // The run itself completed and produced a record.
    expect(run.runRecord.runId).toMatch(/^run-/);
    expect(run.runRecord.validation).toBeDefined();
    expect(run.runRecord.trace).toBeDefined();

    // No campaign payload at all — not one with an empty issuer.
    expect(run.usable).toBe(false);
    expect(run.campaign).toBeNull();
    expect(run.runRecord.campaign).toBeNull();
    expect(run.runRecord.campaignConfigurationUsable).toBe(false);
    expect(run.runRecord.tenantContext).toBeNull();
  });

  it('states that tenant context is missing and must come from the platform', () => {
    const run = runScenario({ scenarioPath: SCENARIO });
    const blocker = run.blockers.join(' ');

    expect(run.blockers.length).toBeGreaterThan(0);
    expect(blocker).toMatch(/No tenant context was supplied/);
    expect(blocker).toMatch(/platform must pass the tenant/);
    // And explicitly: the agent neither re-asks nor infers.
    expect(blocker).toMatch(/must not ask again or infer one/);
  });

  it('never infers an issuer, and never uses the fictional bank as one', () => {
    const run = runScenario({ scenarioPath: SCENARIO });
    expect(run.bank.bank.displayName).toMatch(/FICTIONAL/);

    // The fictional bank name appears nowhere in the campaign-level output.
    const campaignLevel = JSON.stringify({
      campaign: run.campaign,
      provenance: run.provenance,
      blockers: run.blockers,
    });
    expect(campaignLevel).not.toContain('Meridian Bank (FICTIONAL)');
    expect(run.provenance.issuer.basis).toBe('unresolved');
    expect(run.provenance.issuer.reference).toBeUndefined(); // no asserted source
  });

  it('reports the failure through campaign-config, not as a hard constraint', () => {
    const run = runScenario({ scenarioPath: SCENARIO });
    const cfg = run.validation.checks.find((c) => c.id === 'campaign-config')!;

    expect(cfg.status).toBe('fail');
    expect(cfg.detail).toMatch(/No usable campaign configuration was produced/);
    expect(cfg.detail).toMatch(/not a defective campaign/);
    expect(cfg.hardConstraint).toBeUndefined();
    expect(run.validation.outcome).toBe('failed');

    // Nothing campaign-level leaked into the hard-constraint machinery.
    expect(run.validation.hardConstraints.map((c) => c.id)).not.toContain('campaign-config');
    expect(run.validation.unverifiedHardConstraints).not.toContain('campaign-config');
    expect(run.validation.unverifiedHardConstraints).not.toContain('issuer');
  });

  it('leaves unverifiedHardConstraints independent of the missing tenant', () => {
    // The decisive comparison: the hard-constraint result is identical whether
    // the tenant is present or absent. Missing tenant context changes the
    // campaign configuration only.
    const blocked = runScenario({ scenarioPath: SCENARIO });
    const usable = runScenario({ scenarioPath: SCENARIO, tenantContext: SYNTHETIC_TENANT });

    // 'message-cap' belongs in this list. It used to be absent, because the
    // check was recording `status: 'pass'` for a cap that was never supplied
    // — once the per-campaign cap was dropped (no such bank policy exists),
    // `limits` stayed truthy and `reach.max > undefined` was false, so an
    // unevaluated hard constraint reported as satisfied. Now it is correctly
    // reported as unverified.
    expect(blocked.validation.unverifiedHardConstraints).toEqual([
      'message-cap',
      'message-spacing',
      'quiet-hours',
      'event-freeze',
    ]);
    expect(blocked.validation.unverifiedHardConstraints).toEqual(usable.validation.unverifiedHardConstraints);

    // And every hard-constraint status matches, one for one.
    const statuses = (r: typeof blocked) => r.validation.hardConstraints.map((c) => `${c.id}=${c.status}`);
    expect(statuses(blocked)).toEqual(statuses(usable));
  });
});

describe('end-to-end 2 — same scenario with SYNTHETIC verified tenant (usable path)', () => {
  it('the fixture is clearly labelled synthetic and claims no verified mapping', () => {
    // Guards the fixture itself: if this label is ever dropped, the test data
    // could be mistaken for platform output.
    expect(fixture.status).toBe('SYNTHETIC_TEST_FIXTURE');
    expect(fixture.notProductionData).toBe(true);
    expect(fixture.tenantContext.$issuerNote).toMatch(/does NOT mean the tenant-to-issuer mapping has been verified/);
    expect(Array.isArray(fixture.notVerified)).toBe(true);
    expect(fixture.notVerified.length).toBeGreaterThan(0);

    // tenantId and issuer are separate values, neither derived from the other.
    expect(SYNTHETIC_TENANT.tenantId).toBe('SYNTH-TENANT-0001');
    expect(SYNTHETIC_TENANT.issuer).toBe('IndusInd Bank (IBL)');
    expect(SYNTHETIC_TENANT.issuer).not.toContain(SYNTHETIC_TENANT.tenantId);
    expect(SYNTHETIC_TENANT.tenantId).not.toContain(SYNTHETIC_TENANT.issuer);
    // The issuer is real to the application, so the mapping is not rejected.
    expect(knownIssuers()).toContain(SYNTHETIC_TENANT.issuer);
  });

  it('generates a campaign proposal through the real pipeline', () => {
    const run = runScenario({ scenarioPath: SCENARIO, tenantContext: SYNTHETIC_TENANT });

    expect(run.usable).toBe(true);
    expect(run.campaign).not.toBeNull();
    expect(run.blockers).toEqual([]);
    expect(run.runRecord.campaignConfigurationUsable).toBe(true);

    // A real graph came out of the planner, not a stub.
    expect(run.campaign!.root).toBeTruthy();
    expect(Object.keys(run.campaign!.root!.nodes).length).toBeGreaterThan(3);
    expect(Object.values(run.campaign!.root!.nodes).filter((n) => n.type === 'SEND')).toHaveLength(2);
  });

  it('uses the explicitly supplied issuer, with no inference from tenantId', () => {
    const run = runScenario({ scenarioPath: SCENARIO, tenantContext: SYNTHETIC_TENANT });

    expect(run.campaign!.issuer).toBe(SYNTHETIC_TENANT.issuer);
    expect(run.provenance.issuer.basis).toBe('platform-context');
    expect(run.provenance.issuer.reference).toMatch(/SYNTH-TENANT-0001/);
    // The tenant id is recorded as the tenant, never written into issuer.
    expect(run.campaign!.issuer).not.toContain('SYNTH-TENANT');
    expect(run.provenance.issuer.reason).toBeUndefined();
  });

  it('a tenant whose asserted issuer is unknown is blocked, not guessed', () => {
    // The inverse case, proving the issuer really is taken from the assertion
    // rather than resolved by the agent some other way.
    const run = runScenario({
      scenarioPath: SCENARIO,
      tenantContext: { tenantId: 'SYNTH-TENANT-0002', issuer: 'Not A Real Bank' },
    });
    expect(run.usable).toBe(false);
    expect(run.campaign).toBeNull();
    expect(run.blockers.join(' ')).toMatch(/which the application does not know/);
    expect(run.provenance.issuer.reason).toMatch(/Not inferred from tenantId/);
  });

  it('represents all-programs scope with the model\'s own fields', () => {
    const run = runScenario({ scenarioPath: SCENARIO, tenantContext: SYNTHETIC_TENANT });

    expect(run.campaign!.applyToAllPrograms).toBe(true);
    expect(run.campaign!.programs).toEqual([]);
    // No fabricated program list, and nothing from the fictional scenario answer.
    expect(JSON.stringify(run.campaign!.programs)).not.toContain('Meridian');
  });

  it('keeps provenance accurate across every category', () => {
    const run = runScenario({ scenarioPath: SCENARIO, tenantContext: SYNTHETIC_TENANT });
    const p = run.provenance;

    expect(p.issuer.basis).toBe('platform-context');
    expect(p.applyToAllPrograms.basis).toBe('prototype-default');
    expect(p.programs.basis).toBe('prototype-default');
    expect(p.id.basis).toBe('provisional');
    expect(p.goal.basis).toBe('user-answer');
    expect(p.controlPct.basis).toBe('application-default');
    expect(p.guardrails.basis).toBe('application-default');
    expect(p.status.basis).toBe('application-default');
    for (const f of ['startDate', 'endDate', 'allowReEntry']) {
      expect(p[f].basis, f).toBe('unresolved');
      expect(p[f].omitted, f).toBe(true);
    }

    // Every emitted field has a basis; every basis has a source or a reason.
    for (const key of Object.keys(run.campaign!)) expect(p[key], key).toBeDefined();
    for (const [field, entry] of Object.entries(p)) {
      if (entry.basis === 'unresolved') expect(entry.reason, field).toBeTruthy();
      else expect(entry.reference, field).toBeTruthy();
    }
  });

  it('does not invent user-owned or unresolved optional fields', () => {
    const run = runScenario({ scenarioPath: SCENARIO, tenantContext: SYNTHETIC_TENANT });
    const c = run.campaign! as unknown as Record<string, unknown>;

    for (const omitted of [
      'allowReEntry',
      'reEntryCooloffDuration',
      'reEntryCooloffUnit',
      'startDate',
      'endDate',
      'versionOf',
    ]) {
      expect(omitted in c, `${omitted} must be absent`).toBe(false);
    }
    expect(c.guardrails).toEqual({ dnc: true, npa: true });
    expect(run.unresolvedCampaignFields).toEqual(
      expect.arrayContaining(['startDate', 'endDate', 'allowReEntry']),
    );
    expect(run.unresolvedCampaignFields).not.toContain('guardrails');
    // issuer is resolved now, so it must NOT be in the unresolved list.
    expect(run.unresolvedCampaignFields).not.toContain('issuer');
  });

  it('runs structural validation against the generated proposal', () => {
    const run = runScenario({ scenarioPath: SCENARIO, tenantContext: SYNTHETIC_TENANT });
    const cfg = run.validation.checks.find((c) => c.id === 'campaign-config')!;

    expect(cfg.status).toBe('pass');
    expect(cfg.detail).toMatch(/field\(s\) checked against \d+ model field\(s\)/);
    // No required field left unresolved now that the tenant is supplied.
    expect(cfg.detail).not.toMatch(/REQUIRED but unresolved/);

    // The payload really is only DripCampaign fields.
    const known = new Set(dripCampaignFields().map((f) => f.name));
    for (const k of Object.keys(run.campaign!)) expect(known.has(k), k).toBe(true);
  });

  it('keeps the campaign id provisional, never presented as persisted', () => {
    const run = runScenario({ scenarioPath: SCENARIO, tenantContext: SYNTHETIC_TENANT });

    expect(run.provenance.id.basis).toBe('provisional');
    expect(run.campaign!.id).toMatch(/^AGENT-/);
    expect(run.provenance.id.reference).toMatch(/not a value the Drip Campaign system issued or persisted/);
    expect(run.provenance.id.reference).toMatch(/no import path/);
  });

  it('the outcome and claim state usability and unverified hard constraints', () => {
    const run = runScenario({ scenarioPath: SCENARIO, tenantContext: SYNTHETIC_TENANT });

    // Usable configuration, but hard constraints remain unverified — so
    // 'incomplete', not 'pre-validated' and not 'failed'.
    expect(run.validation.outcome).toBe('incomplete');
    expect(run.runRecord.claim).toMatch(/PROPOSED CAMPAIGN CONFIGURATION/);
    expect(run.runRecord.claim).toMatch(/NOT IMPORT-READY/);
    expect(run.runRecord.claim).toMatch(/OUTCOME: INCOMPLETE/);
    expect(run.runRecord.claim).toMatch(/message-spacing, quiet-hours, event-freeze/);
    expect(run.runRecord.claim).toMatch(/could not be verified and are NOT treated as passed/);
    // And it still names the remaining unresolved optional fields.
    expect(run.runRecord.claim).toMatch(/UNRESOLVED/);
    expect(run.runRecord.claim).not.toMatch(/NO USABLE CAMPAIGN CONFIGURATION/);
  });

  it('records the tenant context it was given, marked as non-production', () => {
    const run = runScenario({ scenarioPath: SCENARIO, tenantContext: SYNTHETIC_TENANT });
    const recorded = run.runRecord.tenantContext as Record<string, unknown>;

    expect(recorded.tenantId).toBe('SYNTH-TENANT-0001');
    expect(recorded.issuer).toBe('IndusInd Bank (IBL)');
    expect(String(recorded.note)).toMatch(/No production platform integration exists/);
  });
});

describe('the two scenarios stay distinct', () => {
  it('the sample scenario file contains no tenant context of its own', () => {
    // Guards against the synthetic fixture being folded into the
    // production-like scenario, which would make the default run look
    // production-ready when it is not.
    const scenario = readAgentJson(SCENARIO);
    const blob = JSON.stringify(scenario).toLowerCase();
    expect(blob).not.toContain('tenant');
    expect(blob).not.toContain('synth');
    expect('tenantContext' in scenario).toBe(false);
  });

  it('the two runs differ only in campaign configuration, not in the journey', () => {
    const blocked = runScenario({ scenarioPath: SCENARIO });
    const usable = runScenario({ scenarioPath: SCENARIO, tenantContext: SYNTHETIC_TENANT });

    // Same scenario, same planner, same graph — so the tenant affects the
    // campaign configuration and nothing about the journey.
    expect(blocked.runRecord.decisions).toEqual(usable.runRecord.decisions);
    expect(blocked.validation.checks.filter((c) => c.id !== 'campaign-config').map((c) => c.status)).toEqual(
      usable.validation.checks.filter((c) => c.id !== 'campaign-config').map((c) => c.status),
    );

    // But the outcomes differ, and for exactly the stated reason.
    expect(blocked.validation.outcome).toBe('failed');
    expect(usable.validation.outcome).toBe('incomplete');
  });
});
