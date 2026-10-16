// Phase 4: the agent's suggested message survives, and "exportable" stops
// meaning "import-ready".
//
// TWO DEFECTS, both verified in source before this phase:
//
//  1. The agent's messaging existed only on `sendProposals`, a transient
//     field of the HTTP response. It never reached the Send node, the
//     campaign, or the export — so the campaign manager who has to write the
//     real message never saw what the agent had in mind. And
//     dcConfirmEditNode replaced `_config` wholesale, so even if it had been
//     stored, the first edit to a channel or template id would have erased it.
//
//  2. `exportable` required every Send to carry a real account and template
//     id. For a tenant whose library Hyperface cannot read — the realistic
//     case, TEN-IBL — that is never true, so a complete valid design could
//     not be downloaded at all. Supplying the bank's ids is part of preparing
//     the upload, not part of producing a design.
import { describe, it, expect } from 'vitest';
import { buildFromBlueprint, type CampaignBlueprint } from '../../server/blueprint';
import { orchestrateStream } from '../../server/orchestrator';
import { seedKnowledgeBase } from '../../server/knowledge';
import { dcConfirmEditNode, dcConfirmAddNode } from '../../src/reducer/campaignReducer';
import { dcDefaultConfig, dcAddFormValid } from '../../src/reducer/defaultConfig';
import { validateCampaignGraph } from '../../agent-proto/validate';
import { resolveTenant } from '../../server/tenants';
import type { DripAgentMessaging, DripGraph } from '../../src/data/graphTypes';
import type { Channel } from '../../src/data/sharedConstants';

const CHANNELS: Channel[] = ['EMAIL', 'SMS', 'WHATSAPP'];

const blueprint: CampaignBlueprint = {
  campaignName: 'Auth to EMI',
  description: 'Prompt conversion inside the open window.',
  goal: null,
  entry: { kind: 'event', eventCategory: 'Transaction Events', eventType: 'Transaction', conditions: [] },
  steps: [
    {
      kind: 'send',
      name: 'Opening nudge',
      objective: ['emi', 'convert'],
      stage: 'first-touch',
      describe: 'Remind them the purchase can still be converted to EMI before the window closes.',
    },
  ],
};

/** The realistic tenant: its template library cannot be read from here. */
const unreachable = { availableChannels: CHANNELS, templateLibraryAccess: 'unavailable' as const };
/** The demo tenant, whose sample library can be searched. */
const demo = { availableChannels: CHANNELS, templateLibraryAccess: 'synthetic-demo' as const };

const sendNode = (graph: DripGraph) => Object.values(graph.nodes).find((n) => n.type === 'SEND')!;
const messagingOf = (graph: DripGraph) => (sendNode(graph)._config as { agentMessaging?: DripAgentMessaging }).agentMessaging;

describe('the suggested message reaches the Send node', () => {
  it('stores the agent\'s purpose, copy, CTA and tokens', () => {
    const r = buildFromBlueprint(blueprint, unreachable);
    const m = messagingOf(r.graph)!;
    expect(m.objective).toBe(blueprint.steps[0].kind === 'send' ? blueprint.steps[0].describe : '');
    expect(m.suggestedCopy).toBeTruthy();
    expect(m.cta).toBeTruthy();
    expect(m.personalisationTokens?.length).toBeGreaterThan(0);
    expect(m.recommendedChannel).toBeTruthy();
    expect(m.stage).toBe('first-touch');
  });

  it('never presents the draft as approved or as a registered template', () => {
    const m = messagingOf(buildFromBlueprint(blueprint, unreachable).graph)!;
    expect(m.source).toBe('agent-suggested');
    expect(m.status).toMatch(/not reviewed or approved/i);
    expect(m.status).toMatch(/not a registered template/i);
  });

  it('keeps the draft out of the bank\'s own configuration fields', () => {
    const cfg = sendNode(buildFromBlueprint(blueprint, unreachable).graph)._config as Record<string, unknown>;
    // The bank's fields stay at the application's own unset value.
    expect(cfg.account).toBe('');
    expect(cfg.templateId).toBe('');
    expect(JSON.stringify(cfg.agentMessaging)).not.toMatch(/CT-\d{4}/);
  });

  it('offers no draft copy where a real template was matched', () => {
    // With a library to search, the bank's own content governs the message.
    // A competing agent draft alongside it would be noise.
    const r = buildFromBlueprint(blueprint, demo);
    const m = messagingOf(r.graph)!;
    expect(m.objective).toBeTruthy();
    expect(m.suggestedCopy).toBeUndefined();
    expect(m.cta).toBeUndefined();
  });

  it('cannot make an incomplete Send look complete', () => {
    const cfg = sendNode(buildFromBlueprint(blueprint, unreachable).graph)._config as Record<string, unknown>;
    // dcAddFormValid still requires the bank's account and template id.
    expect(dcAddFormValid('SEND', cfg)).toBe(false);
  });

  it('does not let a suggestion rescue an invalid graph', () => {
    const r = buildFromBlueprint(
      {
        ...blueprint,
        entry: {
          kind: 'event',
          eventCategory: 'Transaction Events',
          eventType: 'Transaction',
          conditions: [{ attribute: 'Transaction Status', operator: 'Any of', value: 'Auth' }],
        },
      },
      unreachable,
    );
    // Phase 3's condition validation still blocks the build.
    expect(r.ok).toBe(false);
  });
});

describe('an ordinary edit does not erase it', () => {
  const built = () => buildFromBlueprint(blueprint, unreachable).graph;

  it('survives a channel and template-id edit through the drawer', () => {
    const graph = built();
    const node = sendNode(graph);
    const before = messagingOf(graph)!;
    // What the drawer submits: every field the form owns, and nothing else.
    // agentMessaging is read-only there, so it is absent from the patch.
    const formConfig = { ...(node._config as object), agentMessaging: undefined } as Record<string, unknown>;
    delete formConfig.agentMessaging;
    const edited = dcConfirmEditNode(
      graph,
      node.id,
      'SEND',
      { ...formConfig, channel: 'SMS', account: 'REAL-ACCOUNT', templateId: 'REAL-TEMPLATE' },
      null,
    );
    const after = messagingOf(edited)!;
    expect(after).toEqual(before);
    // ...and the real edit still took effect.
    const cfg = sendNode(edited)._config as Record<string, unknown>;
    expect(cfg.channel).toBe('SMS');
    expect(cfg.templateId).toBe('REAL-TEMPLATE');
  });

  it('can still be cleared deliberately', () => {
    const graph = built();
    const node = sendNode(graph);
    const edited = dcConfirmEditNode(graph, node.id, 'SEND', { ...(node._config as object), agentMessaging: null }, null);
    expect(messagingOf(edited)).toBeNull();
  });

  it('preserves nothing else — a field no form owns is a bug, not a feature', () => {
    const graph = built();
    const node = sendNode(graph);
    (node._config as Record<string, unknown>).strayValue = 'should not survive';
    const edited = dcConfirmEditNode(graph, node.id, 'SEND', { name: 'Renamed', channel: 'SMS', account: 'a', templateId: 't' }, null);
    expect((sendNode(edited)._config as Record<string, unknown>).strayValue).toBeUndefined();
  });

  it('leaves other node types exactly as they were', () => {
    let graph: DripGraph = { nodes: {}, edges: [], rootId: null };
    graph = dcConfirmAddNode(graph, 'ENTRY_SEGMENT', { ...dcDefaultConfig('ENTRY_SEGMENT', null), entity: 'Account' }, { kind: 'root' }, null);
    const entry = Object.values(graph.nodes)[0];
    (entry._config as Record<string, unknown>).agentMessaging = { objective: 'should not be carried' };
    const edited = dcConfirmEditNode(graph, entry.id, 'ENTRY_SEGMENT', { ...dcDefaultConfig('ENTRY_SEGMENT', null), entity: 'Card' }, null);
    expect((Object.values(edited.nodes)[0]._config as Record<string, unknown>).agentMessaging).toBeUndefined();
  });

  it('survives a later graph update elsewhere in the journey', () => {
    const graph = built();
    const before = messagingOf(graph)!;
    const leaf = Object.values(graph.nodes).find((n) => n.type === 'EXIT')!;
    const grown = dcConfirmEditNode(graph, leaf.id, 'EXIT', { reason: 'Changed my mind' }, null);
    expect(messagingOf(grown)).toEqual(before);
  });
});

describe('design, export and import are three different states', () => {
  const knowledge = seedKnowledgeBase();
  const run = async (over: Record<string, unknown> = {}) => {
    const gen = orchestrateStream({
      sessionId: 'p4',
      tenantId: 'TEN-IBL',
      knowledge,
      discoveryRounds: 0,
      messages: [{ role: 'user', content: 'Convert authorised EMI-eligible purchases.' }],
      intent: 'confirm',
      confirmedBlueprint: blueprint,
      session: { state: 'AWAITING_STRATEGY_CONFIRMATION', strategyVersion: 1, confirmation: null },
      ...over,
    } as never);
    let out = await gen.next();
    while (!out.done) out = await gen.next();
    return out.value;
  };

  it('a design with no bank template ids is generated AND exportable', async () => {
    const res = await run();
    expect(resolveTenant('TEN-IBL')!.templateLibraryAccess).toBe('unavailable');
    expect(res.designGenerated).toBe(true);
    expect(res.exportable).toBe(true);
    expect(res.exportBlockedReason).toBeUndefined();
  });

  it('is never reported as import-ready, because no import contract exists', async () => {
    const res = await run();
    expect(res.importReadiness?.status).toBe('unverified');
    // Not 'false' either: nothing was checked, so nothing can be concluded.
    expect(res.importReadiness?.reason).toMatch(/no JSON import path/i);
    expect(JSON.stringify(res.importReadiness)).not.toMatch(/"ready"|"import-ready"/);
  });

  it('lists what a person must still prepare, rather than implying nothing is left', async () => {
    const res = await run();
    const outstanding = res.importReadiness!.outstanding.join(' ');
    expect(outstanding).toMatch(/account and template ID/i);
    // Unverified platform capabilities stay visible here too.
    expect(outstanding).toMatch(/marked new in the platform metadata/i);
  });

  it('a syntactically valid design does not become import-ready', async () => {
    const res = await run();
    // Everything needed to serialise is present...
    expect(res.campaign).not.toBeNull();
    expect(res.graph).not.toBeNull();
    expect(() => JSON.stringify(res.campaign)).not.toThrow();
    // ...and it changes nothing about import readiness.
    expect(res.importReadiness?.status).toBe('unverified');
  });

  it('a graph-validation failure still blocks export', async () => {
    const res = await run({
      confirmedBlueprint: { ...blueprint, entry: { kind: 'event', eventCategory: 'Telepathy Events', eventType: 'Hunch' } },
    });
    expect(res.designGenerated).toBe(false);
    expect(res.exportable).toBe(false);
    expect(res.buildIssues.length).toBeGreaterThan(0);
  });

  it('export cannot override a failed validation check', async () => {
    // Structural failure from the application's own validators, not from a
    // build issue: export must still be refused.
    const broken: DripGraph = {
      rootId: 'n1',
      nodes: {
        n1: { id: 'n1', type: 'SEND', label: 'x', meta: '', autoGenerated: false, _config: { name: 'x', channel: 'SMS', account: '', templateId: '' } },
      },
      edges: [{ id: 'e1', from: 'n1', to: null }],
    };
    const report = validateCampaignGraph(broken, { fanOut: [] });
    expect(report.checks.some((c) => c.status === 'fail')).toBe(true);
    expect(report.outcome).toBe('failed');
  });

  it('the authoritative statement about import is recorded, not inferred', () => {
    // The repository's own answer: there is no import path, so the check is
    // permanently 'not-run'. Nothing in Phase 4 may upgrade that.
    const report = validateCampaignGraph(buildFromBlueprint(blueprint, unreachable).graph, { fanOut: [] });
    const importCheck = report.unverified.find((c) => c.id === 'app-import-accepts')!;
    expect(importCheck.status).toBe('not-run');
    expect(importCheck.unverifiedReason).toMatch(/no JSON import path/i);
  });
});

describe('the agent writes the copy; the generator is only a fallback', () => {
  const withCopy: CampaignBlueprint = {
    ...blueprint,
    steps: [
      {
        kind: 'send',
        name: 'Opening nudge',
        objective: ['emi', 'convert'],
        stage: 'first-touch',
        describe: 'Remind them the purchase can still be converted.',
        copy: 'Hi ${customerFirstName}, your recent purchase can still move to EMI. Spread it over months from today. ${shortUrl}',
        cta: 'Convert to EMI',
      },
    ],
  };

  it('uses the agent\'s copy verbatim when it supplies some', () => {
    const m = messagingOf(buildFromBlueprint(withCopy, unreachable).graph)!;
    const step = withCopy.steps[0];
    expect(m.suggestedCopy).toBe(step.kind === 'send' ? step.copy : '');
    expect(m.cta).toBe('Convert to EMI');
    expect(m.copySource).toBe('agent-written');
  });

  it('labels the fallback a placeholder rather than passing it off as copy', () => {
    // The generated string interpolates `describe`, which is written in the
    // third person about the customer — so it reads as an instruction to a
    // marketer. Shipping that as "draft copy" would mislead.
    const m = messagingOf(buildFromBlueprint(blueprint, unreachable).graph)!;
    expect(m.copySource).toBe('generated-placeholder');
    expect(m.suggestedCopy).toContain('${customerFirstName}');
  });

  it('keeps the purpose and the copy as separate fields', () => {
    const m = messagingOf(buildFromBlueprint(withCopy, unreachable).graph)!;
    expect(m.objective).not.toBe(m.suggestedCopy);
  });
});
