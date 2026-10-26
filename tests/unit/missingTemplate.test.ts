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
import { proposeMessaging } from '../../agent-proto/templateSelect';
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
      // Channel and clock time ARE recommended — those the agent can judge.
      // Timing used to be zeroed to Relative/0h, which hid the builder default.
      expect(CHANNELS).toContain(c.channel as Channel);
      expect(c.timing).toBe('Absolute');
      expect(c.absTime).toBe('11:00');
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
  it('every tenant is FLAGGED synthetic, whatever it is called', () => {
    // The flag stays true and the record stays honest: nothing downstream
    // should be able to mistake this data for a real issuer configuration.
    //
    // The DISPLAY NAME no longer says so. It used to read "IndusInd Bank
    // (IBL) — Synthetic", which appeared in the tenant picker and the campaign
    // header and made every screen read as a prototype. The provenance of demo
    // data is said out loud when the product is shown; it does not need to be
    // printed on the chrome. Asserting the label here would re-couple an
    // internal truth to a piece of presentation.
    for (const t of listTenants()) {
      expect(t.synthetic).toBe(true);
      expect(t.displayName.trim().length).toBeGreaterThan(0);
      expect(t.displayName).not.toMatch(/synthetic/i);
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

// One missing field took the whole Confirm down.
//
// THE LIVE FAILURE. The manager sent "Confirmed. Build this campaign." and
// got "Cannot read properties of undefined (reading 'replace')". No canvas,
// a raw TypeError in the transcript, and no way forward.
//
// The chain: `build_campaign` requires neither `name` nor `describe`; the
// model omitted both; on a real tenant `templateLibraryAccess` is
// 'unavailable' so no template is ever matched and EVERY send falls through
// to `proposeMessaging`, which read `need.describe.replace(...)`.
//
// `describe: string` on `TemplateNeed` is a statement about what callers
// should pass. It is not a guarantee about what arrives from a model, and
// the compiler is the one place where an unbounded amount of
// model-authored data meets application code.
//
// The `stage` field already had this guard — "a malformed field must be a
// reported issue, not a 500". These two did not.
describe('a send with no name and no description still builds', () => {
  const need = (over: Record<string, unknown> = {}) =>
    ({ objective: ['activate'], stage: 'first-touch', ...over }) as never;

  it('does not throw when describe is missing entirely', () => {
    const out = proposeMessaging(need(), 'WHATSAPP');
    expect(out.sampleCopy).toBeDefined();
    expect(out.sampleCopy).toContain('${customerFirstName}');
    expect(out.sampleCopy).not.toContain('undefined');
  });

  it('does not throw when describe is empty', () => {
    const out = proposeMessaging(need({ describe: '' }), 'SMS');
    expect(out.sampleCopy).toBeDefined();
    expect(out.sampleCopy).not.toContain('undefined');
  });

  it('says nothing rather than inventing a purpose', () => {
    // The placeholder is a greeting and a link. With nothing stated about
    // what the message is for, making something up would be worse than a
    // blank: it would read as the agent's intent.
    expect(proposeMessaging(need(), 'WHATSAPP').sampleCopy).toBe('Hi ${customerFirstName}, ${shortUrl}');
    expect(proposeMessaging(need(), 'WHATSAPP').messagingDirection).toBe('');
  });

  it('still uses the description when there is one', () => {
    const out = proposeMessaging(need({ describe: 'Remind them to set the PIN.' }), 'WHATSAPP');
    expect(out.sampleCopy).toContain('remind them to set the PIN.');
  });

  it('compiles the live payload instead of throwing', () => {
    // The real shape: copy, stage and a channel, no name, no describe, and a
    // tenant whose template library cannot be read.
    const bp = {
      campaignName: 'PIN activation',
      description: 'Fourteen days.',
      goal: null,
      entry: { kind: 'audience', entity: 'Card', conditions: [] },
      steps: [
        { kind: 'send', objective: ['activate'], stage: 'first-touch', copy: 'Set your PIN in two minutes.', channelPreference: ['WHATSAPP'] },
        { kind: 'exit', reason: 'Window closed.' },
      ],
    } as never;
    const r = buildFromBlueprint(bp, { availableChannels: ['WHATSAPP', 'SMS'], templateLibraryAccess: 'unavailable' });
    const sends = Object.values(r.graph.nodes).filter((n) => n.type === 'SEND');
    expect(sends).toHaveLength(1);
    // Named from what the agent DID write, so the canvas card is not blank.
    expect((sends[0]._config as { name?: string }).name).toBeTruthy();
    // Copy is the description. Do not also report a missing name/describe
    // when the agent already wrote the words — that blocked EMI export on
    // twelve labelled sends (`ui-s-1792770967470`).
    const said = r.issues.map((i) => i.problem).join(' ');
    expect(said).not.toMatch(/needs a name/);
    expect(said).not.toMatch(/needs a describe/);
  });

  it('treats label and copy as name and describe', () => {
    const bp = {
      campaignName: 'EMI',
      description: 'Seven days.',
      goal: null,
      entry: { kind: 'audience', entity: 'Card', conditions: [] },
      steps: [
        {
          kind: 'send',
          label: 'Day 0 WhatsApp - eligibility',
          stage: 'first-touch',
          copy: 'Hi ${customerFirstName}, your purchase qualifies for EMI.',
          channelPreference: ['WHATSAPP'],
        },
        { kind: 'exit', reason: 'Window closed.' },
      ],
    } as never;
    const r = buildFromBlueprint(bp, { availableChannels: ['WHATSAPP', 'SMS'], templateLibraryAccess: 'unavailable' });
    const sends = Object.values(r.graph.nodes).filter((n) => n.type === 'SEND');
    expect((sends[0]._config as { name?: string }).name).toBe('Day 0 WhatsApp - eligibility');
    expect(r.issues.map((i) => i.problem).join(' ')).not.toMatch(/needs a (name|describe|objective)/);
  });
});

describe('a labelled send is not a blank send', () => {
  // MEASURED, `eval/runs/ui-s-1792770967470` turn 8. The Confirm's sends
  // carried `label`, `copy` and `cta` — real messages, named in the
  // manager's own words — and the compiler raised "needs an objective",
  // "needs a name" and "needs a describe" on each one: twelve issues across
  // four distinct sends, `designGenerated` false, export blocked on a journey
  // that already had everything a person needs to read it.
  //
  // `describe` was the leftover: the other two already read `name || label`
  // and `describe || copy`, and this one looked at `describe || copy` alone.
  // The issue has to match what actually fills the step, which is
  // `givenDescribe || givenName`.
  const build = (step: Record<string, unknown>) =>
    buildFromBlueprint(
      {
        campaignName: 'Authorisation to EMI',
        description: 'Prompt conversion inside the open window.',
        goal: null,
        entry: { kind: 'audience', entity: 'Card', conditions: [] },
        steps: [step],
      } as never,
      { availableChannels: ['WHATSAPP', 'SMS'] as never, templateLibraryAccess: 'unavailable' },
    );

  it('reports nothing for the live shape: a label, a stage and a channel', () => {
    const out = build({
      kind: 'send',
      label: 'Day 0 WhatsApp - eligibility',
      stage: 'first-touch',
      channelPreference: ['WHATSAPP'],
    });
    expect(out.issues).toEqual([]);
    // And the step is really there, carrying the label as its name.
    const sends = Object.values(out.graph.nodes).filter((n) => n.type === 'SEND');
    expect(sends).toHaveLength(1);
    expect((sends[0]._config as { name?: string }).name).toContain('Day 0 WhatsApp');
  });

  it('still reports all three when the send says nothing at all', () => {
    const out = build({ kind: 'send', stage: 'first-touch', channelPreference: ['WHATSAPP'] });
    expect(out.issues.map((i) => i.path.split('.').pop()).sort()).toEqual(['describe', 'name', 'objective']);
    // Reported, never deleted: the step is built either way.
    expect(Object.values(out.graph.nodes).filter((n) => n.type === 'SEND')).toHaveLength(1);
  });

  it('accepts copy alone, or a name alone', () => {
    expect(build({ kind: 'send', copy: 'Split this purchase from ₹2,100 a month.', stage: 'first-touch' }).issues).toEqual([]);
    expect(build({ kind: 'send', name: 'Opening nudge', stage: 'first-touch' }).issues).toEqual([]);
  });
});
