// Missing-template behaviour.
//
// Bank communication templates live in the BANK's ecosystem. Hyperface does
// not mirror them, so the normal case is that we cannot see the catalogue at
// all. The agent must still design the campaign: the communication step stays
// in the journey, the account and template id are left at the application's
// own unset value, and the app's existing validator blocks export until a
// person supplies the real ids. Nothing is ever invented.
import { describe, it, expect } from 'vitest';
import { buildFromBlueprint, type CampaignBlueprint } from '../../server/blueprint';
import { validateCampaignGraph } from '../../agent-proto/validate';
import { resolveTenant, listTenants } from '../../server/tenants';
import { COMMS_TEMPLATES, type Channel } from '../../src/data/sharedConstants';

const CHANNELS: Channel[] = ['EMAIL', 'SMS', 'WHATSAPP'];

const bp: CampaignBlueprint = {
  campaignName: 'Auth txn to EMI',
  description: 'Convert an eligible purchase to EMI.',
  goal: {
    eventCategory: 'EMI Events',
    eventType: 'EMI_STATUS_CHANGED',
    conditions: [{ attribute: 'New Status', operator: 'Equals', value: 'Successful' }],
  },
  entry: { kind: 'event', eventCategory: 'Transaction Events', eventType: 'Transaction' },
  steps: [
    { kind: 'send', name: 'EMI offer', objective: ['emi', 'convert'], stage: 'first-touch', describe: 'Convert to EMI.' },
    { kind: 'wait', durationHours: 48 },
    { kind: 'send', name: 'EMI reminder', objective: ['emi', 'convert'], stage: 'reminder', describe: 'Still open.' },
  ],
};

const unreachable = { availableChannels: CHANNELS, templateLibraryAccess: 'unavailable' as const };

describe('no reachable bank template catalogue', () => {
  it('still designs the campaign and keeps every communication step', () => {
    const r = buildFromBlueprint(bp, unreachable);
    const sends = Object.values(r.graph.nodes).filter((n) => n.type === 'SEND');

    // The step survives — it is not dropped over a field only the bank holds.
    expect(sends).toHaveLength(2);
    expect(r.graph.rootId).toBeTruthy();
    // And it is not reported as a build failure: the design succeeded.
    expect(r.issues).toEqual([]);
  });

  it('leaves account and template id at the application\'s own unset value', () => {
    const r = buildFromBlueprint(bp, unreachable);
    for (const n of Object.values(r.graph.nodes).filter((x) => x.type === 'SEND')) {
      const c = n._config as Record<string, string>;
      expect(c.account).toBe('');
      expect(c.templateId).toBe('');
      // Channel and timing ARE recommended — those the agent can judge.
      expect(CHANNELS).toContain(c.channel as Channel);
      expect(c.timing).toBe('Relative');
    }
  });

  it('never invents an account id or a template id', () => {
    const r = buildFromBlueprint(bp, unreachable);
    const serialised = JSON.stringify(r.graph);
    // No seeded demo-library id leaked in...
    for (const t of COMMS_TEMPLATES) expect(serialised).not.toContain(t.id);
    // ...and nothing that merely looks like an id either.
    expect(serialised).not.toMatch(/"templateId":"[^"]+"/);
    expect(r.sendProposals.every((p) => !p.templateResolved && !p.accountResolved)).toBe(true);
  });

  it('reports "cannot verify", not "no template exists"', () => {
    const r = buildFromBlueprint(bp, unreachable);
    expect(r.sendProposals).toHaveLength(2);
    for (const p of r.sendProposals) {
      expect(p.reason).toBe('template-library-unavailable');
      expect(p.explanation).toMatch(/not readable from here/);
      // The distinction that matters: we did not claim their library is empty.
      expect(p.explanation).not.toMatch(/no template exists|none exists/i);
    }
  });

  it('still produces messaging direction, copy, CTA and personalisation tokens', () => {
    const r = buildFromBlueprint(bp, unreachable);
    for (const p of r.sendProposals) {
      expect(p.messagingDirection.length).toBeGreaterThan(0);
      expect(p.sampleCopy).toContain('${customerFirstName}');
      expect(p.cta.length).toBeGreaterThan(0);
      expect(p.personalisationFields.length).toBeGreaterThan(0);
      expect(p.channel.length).toBeGreaterThan(0);
      expect(p.timing.length).toBeGreaterThan(0);
    }
  });

  it('binds each proposal to the real node it belongs to', () => {
    const r = buildFromBlueprint(bp, unreachable);
    for (const p of r.sendProposals) {
      expect(p.nodeId).not.toBe('(pending)');
      expect(r.graph.nodes[p.nodeId]?.type).toBe('SEND');
    }
  });

  it('is blocked by the application\'s OWN validator, not a weakened one', () => {
    const r = buildFromBlueprint(bp, unreachable);
    const report = validateCampaignGraph(r.graph, { fanOut: [] });
    const nodeConfig = report.checks.find((c) => c.id === 'node-config')!;

    expect(nodeConfig.status).toBe('fail');
    expect(nodeConfig.executedBy).toMatch(/dcAddFormValid/);
    expect(report.outcome).toBe('failed');
    // The graph is otherwise structurally sound — only configuration is missing.
    expect(report.checks.find((c) => c.id === 'no-open-branches')?.status).toBe('pass');
    expect(report.checks.find((c) => c.id === 'referential-integrity')?.status).toBe('pass');
  });
});

describe('after the user supplies the real ids', () => {
  const resolved = {
    ...unreachable,
    resolvedSends: {
      'EMI offer': { account: 'IBL-Karix-Txns', templateId: 'BANK-TPL-900' },
      'EMI reminder': { account: 'IBL-Karix-Txns', templateId: 'BANK-TPL-901' },
    },
  };

  it('uses them verbatim and clears the unresolved steps', () => {
    const r = buildFromBlueprint(bp, resolved);
    const sends = Object.values(r.graph.nodes).filter((n) => n.type === 'SEND');
    expect(sends.map((n) => (n._config as Record<string, string>).templateId).sort()).toEqual([
      'BANK-TPL-900',
      'BANK-TPL-901',
    ]);
    expect(r.sendProposals).toEqual([]);
  });

  it('passes the application\'s node-config check, so export can proceed', () => {
    const r = buildFromBlueprint(bp, resolved);
    const report = validateCampaignGraph(r.graph, { fanOut: [] });
    expect(report.checks.find((c) => c.id === 'node-config')?.status).toBe('pass');
    expect(report.checks.every((c) => c.status === 'pass')).toBe(true);
  });

  it('a partially supplied step stays unresolved and awaits input', () => {
    const r = buildFromBlueprint(bp, {
      ...unreachable,
      resolvedSends: { 'EMI offer': { account: 'IBL-Karix-Txns' } }, // no template id
    });
    const offer = r.sendProposals.find((p) => p.stepName === 'EMI offer')!;
    expect(offer.reason).toBe('awaiting-user-input');
    expect(offer.accountResolved).toBe(true);
    expect(offer.templateResolved).toBe(false);
    expect(validateCampaignGraph(r.graph, { fanOut: [] }).outcome).toBe('failed');
  });
});

describe('the synthetic demo library is still usable, and labelled', () => {
  it('matches a template only when a library is explicitly configured', () => {
    const demo = buildFromBlueprint(bp, { availableChannels: CHANNELS, templateLibraryAccess: 'synthetic-demo' });
    expect(demo.templateChoices.length).toBeGreaterThan(0);
    expect(demo.sendProposals).toEqual([]);
    for (const c of demo.templateChoices) {
      expect(COMMS_TEMPLATES.map((t) => t.id)).toContain(c.templateId);
      // Never presented as a real bank catalogue.
      expect(c.reason).toMatch(/synthetic demo library/);
    }
  });

  it('reports a genuine miss as "no suitable template", not as unverifiable', () => {
    const r = buildFromBlueprint(
      {
        ...bp,
        steps: [{ kind: 'send', name: 'Mortgage', objective: ['mortgage'], stage: 'first-touch', describe: 'Refinance.' }],
      },
      { availableChannels: CHANNELS, templateLibraryAccess: 'synthetic-demo' },
    );
    expect(r.sendProposals[0].reason).toBe('no-suitable-template');
    expect(r.sendProposals[0].explanation).toMatch(/sample demo library was searched/);
  });
});

describe('tenant registry is server-side and honest', () => {
  it('every tenant is labelled synthetic', () => {
    for (const t of listTenants()) {
      expect(t.synthetic).toBe(true);
      expect(t.displayName).toMatch(/Synthetic/);
    }
  });

  it('refuses an unknown tenant rather than falling back to a default', () => {
    expect(resolveTenant('TEN-NOPE')).toBeNull();
    expect(resolveTenant(undefined)).toBeNull();
    expect(resolveTenant('TEN-IBL')?.issuer).toBe('IndusInd Bank (IBL)');
  });

  it('scopes channel availability per tenant', () => {
    const ibl = resolveTenant('TEN-IBL')!;
    const yes = resolveTenant('TEN-YES')!;
    const avail = (t: typeof ibl) => t.availableChannels.filter((c) => c.available).map((c) => c.channel);
    expect(avail(ibl)).toContain('EMAIL');
    expect(avail(yes)).not.toContain('EMAIL'); // one tenant's config is not the other's
  });

  it('defaults to an unreachable bank catalogue, not a mirrored one', () => {
    expect(resolveTenant('TEN-IBL')!.templateLibraryAccess).toBe('unavailable');
    expect(resolveTenant('TEN-DEMO')!.templateLibraryAccess).toBe('synthetic-demo');
  });
});
