// Runs the production-like sample scenario end to end and writes a run
// record. Run: npm run agent:run
//
// This scenario deliberately carries NO tenant context, because the prototype
// has no platform integration to supply one. The expected result is therefore
// a BLOCKED campaign configuration — that is the honest outcome, not a gap.
// The usable path is covered separately, with an explicitly synthetic tenant
// fixture: see endToEnd.regression.task.ts.
//
// The pipeline itself lives in runScenario.ts so the end-to-end tests exercise
// the same code this does, rather than a copy of it.
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario, reportScenarioRun } from './runScenario';

const here = dirname(fileURLToPath(import.meta.url));

describe('agent prototype — sample scenario, no tenant context', () => {
  it('plans, builds, validates and records a run', () => {
    const run = runScenario({ scenarioPath: 'scenarios/auth-txn-to-emi.json' });
    const { runRecord, campaign, provenance, unresolvedCampaignFields, blockers, validation } = run;

    const outDir = resolve(here, 'runs');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, `${runRecord.runId}.json`), JSON.stringify(runRecord, null, 2) + '\n');
    writeFileSync(resolve(outDir, 'latest.json'), JSON.stringify(runRecord, null, 2) + '\n');

    reportScenarioRun(run);

    // The plumbing must work. Campaign *quality* is not asserted here — a
    // schema-valid campaign is not necessarily a good one, and conflating the
    // two is exactly what the design warns about.
    expect(runRecord.runId).toBeTruthy();
    expect(validation.unverified.length).toBeGreaterThan(0);

    // Every check EXCEPT campaign-config passes; the blocked configuration is
    // the one failure, and it is a missing input rather than a bad campaign.
    expect(validation.checks.filter((c) => c.id !== 'campaign-config').every((c) => c.status === 'pass')).toBe(true);

    // Six known hard constraints: DNC and NPA are campaign-level USER choices
    // (GuardrailsStep.tsx), not issuer-level constraints. Three remain
    // unverified, and that is unchanged by the campaign block below.
    expect(validation.hardConstraints).toHaveLength(6);
    expect(validation.hardConstraints.map((c) => c.id)).not.toContain('dnc');
    expect(validation.hardConstraints.map((c) => c.id)).not.toContain('npa');
    expect(validation.hardConstraints.find((c) => c.id === 'message-cap')?.status).toBe('pass');
    expect(validation.hardConstraints.find((c) => c.id === 'channel-availability')?.status).toBe('pass');
    expect(validation.hardConstraints.find((c) => c.id === 'maker-checker')?.status).toBe('not-applicable');
    expect(validation.unverifiedHardConstraints).toEqual(['message-spacing', 'quiet-hours', 'event-freeze']);

    // Campaign configuration: BLOCKED, deliberately. No campaign is emitted
    // rather than one carrying an empty required issuer.
    expect(run.usable).toBe(false);
    expect(campaign).toBeNull();
    expect(runRecord.tenantContext).toBeNull();
    expect(blockers[0]).toMatch(/No tenant context was supplied/);

    const cfg = validation.checks.find((c) => c.id === 'campaign-config')!;
    expect(cfg.status).toBe('fail');
    expect(cfg.detail).toMatch(/No usable campaign configuration was produced/);
    expect(validation.outcome).toBe('failed');
    expect(validation.unverifiedHardConstraints).not.toContain('campaign-config');
    expect(validation.hardConstraints.map((c) => c.id)).not.toContain('campaign-config');

    // Provenance is still produced, so the record explains why.
    expect(provenance.issuer.basis).toBe('unresolved');
    expect(provenance.applyToAllPrograms.basis).toBe('prototype-default');
    expect(provenance.id.basis).toBe('provisional');
    expect(unresolvedCampaignFields).toContain('issuer');
    expect(unresolvedCampaignFields).toContain('startDate');
    expect(unresolvedCampaignFields).not.toContain('guardrails');

    expect(runRecord.claim).toMatch(/NO USABLE CAMPAIGN CONFIGURATION/);
    expect(runRecord.claim).toMatch(/NOT IMPORT-READY/);
    expect(runRecord.claim).toMatch(/not an issuer-level hard-constraint violation/);
  });
});
