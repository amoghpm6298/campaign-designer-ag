// Phase 1 of the designer redesign: the agent is grounded in the platform's
// OWN metadata instead of guessing.
//
// The defect these lock down, demonstrated on a real EMI conversation: every
// capability tool returned names only — attribute names with no allowed
// values, event names with no entity mapping, no indication that a whole event
// category is flagged "proposed, not built". The agent therefore had to invent
// every condition value it wrote, and nothing downstream could tell.
//
// Each test asserts the exposed value is READ FROM the application definition,
// never that it equals a literal copied into this file. A hardcoded expectation
// here would drift from the builder exactly the way the old tool did.
// `availableCheapestFirst` became `available`, 2026-10-21. The list is no
// longer ordered by price by default: the issuer's own preference decides,
// and with cheaper-first off it is ordered by how Indian retail cardholders
// actually read. A field name asserting "cheapest" was telling the model the
// opposite of what the bank context says.
import { describe, it, expect } from 'vitest';
import { AGENT_TOOLS, runTool } from '../../server/agentTools';
import { blueprintVocabulary } from '../../server/blueprint';
import { resolveTenant } from '../../server/tenants';
import { DC_NODE_META, DC_STEP_TYPES, DC_ROUTING_TYPES, DC_TERMINAL_TYPES } from '../../src/data/nodeMeta';
import { DC_ENTRY_TYPES } from '../../src/data/typeSub';
import {
  EVENT_CATEGORIES,
  ELIGIBILITY_META,
  COMMS_TEMPLATES,
  DC_EVENT_ENTITY,
  DC_PROMOTED_ATTR,
  EVENT_ATTR_BY_TYPE,
  LOCKED_ATTR_OPERATORS,
  DELIVERY_STATUS_BY_CHANNEL,
  dcOperatorsForAttribute,
  type AttrMeta,
  type Channel,
} from '../../src/data/sharedConstants';

const tenant = resolveTenant('TEN-IBL')!;
const demoTenant = resolveTenant('TEN-DEMO')!;
const CHANNELS: Channel[] = ['EMAIL', 'SMS', 'WHATSAPP'];

type AttrReport = { type: string; operators: string[]; allowedValues?: string[]; valuesNote?: string };
type EntityReport = { attributes: Record<string, AttrReport>; promotedAttribute?: string };
type AttrResult = { entities: Record<string, EntityReport>; note: string };
type EventReport = {
  events: string[];
  conditionEntity: string | null;
  status: 'supported' | 'new-proposed';
  statusNote?: string;
  promotedAttribute?: string;
  lockedAttributeByEventType?: Record<string, string>;
  lockedAttributeOperators?: string[];
  conditionsNote?: string;
};

const attributes = (entity?: string) =>
  (runTool('list_audience_attributes', entity ? { entity } : {}, { tenant }).result as AttrResult).entities;
const events = () => runTool('list_event_types', {}, { tenant }).result as Record<string, EventReport>;

describe('audience attributes expose what a condition actually needs', () => {
  it('reports the allowed values for every fixed-list attribute, from ELIGIBILITY_META', () => {
    const reported = attributes();
    let checked = 0;
    for (const [entity, attrs] of Object.entries(ELIGIBILITY_META)) {
      for (const [name, meta] of Object.entries(attrs as Record<string, AttrMeta>)) {
        if (!meta.options?.length) continue;
        expect(reported[entity].attributes[name].allowedValues, `${entity}.${name}`).toEqual(meta.options);
        checked++;
      }
    }
    // Guards the assertion itself: a bug that reported zero fixed-list
    // attributes would otherwise pass the loop above vacuously.
    expect(checked).toBeGreaterThan(5);
  });

  it('carries the exact values the EMI case needed, which the agent previously had to invent', () => {
    const txn = attributes('Transaction').Transaction.attributes;
    // Not a literal list: asserted against the source, then spot-checked for
    // the three values the user had to dictate by hand.
    expect(txn['Transaction Status'].allowedValues).toEqual(
      ELIGIBILITY_META.Transaction['Transaction Status'].options,
    );
    expect(txn['Transaction Status'].allowedValues).toContain('APPROVED');
    expect(txn['Transaction Type'].allowedValues).toContain('AUTHORIZE');
    expect(txn['Initiated By'].allowedValues).toContain('CUSTOMER_INITIATED');
  });

  it('reports the same operators the builder drawer offers', () => {
    const reported = attributes();
    for (const [entity, attrs] of Object.entries(ELIGIBILITY_META)) {
      for (const [name, meta] of Object.entries(attrs as Record<string, AttrMeta>)) {
        expect(reported[entity].attributes[name].operators, `${entity}.${name}`).toEqual(
          dcOperatorsForAttribute(meta),
        );
      }
    }
    // The rule is type-driven, so a multiSelect and a number must differ.
    expect(reported.Transaction.attributes['Transaction Type'].operators).toEqual(['Any of']);
    expect(reported.Transaction.attributes['Transaction Amount'].operators).toContain('Between');
  });

  it('reports each attribute\'s type', () => {
    const reported = attributes();
    for (const [entity, attrs] of Object.entries(ELIGIBILITY_META)) {
      for (const [name, meta] of Object.entries(attrs as Record<string, AttrMeta>)) {
        expect(reported[entity].attributes[name].type, `${entity}.${name}`).toBe(meta.type);
      }
    }
  });

  it('says WHY an attribute has no fixed list instead of staying silent', () => {
    const reported = attributes();
    for (const [entity, attrs] of Object.entries(ELIGIBILITY_META)) {
      for (const [name, meta] of Object.entries(attrs as Record<string, AttrMeta>)) {
        const got = reported[entity].attributes[name];
        if (meta.options?.length) continue;
        // An absent allowedValues key reads as "anything goes". It must not.
        expect(got.allowedValues, `${entity}.${name}`).toBeUndefined();
        expect(got.valuesNote, `${entity}.${name}`).toBeTruthy();
      }
    }
    // A Smart Tag's real values are issuer-configured and not modelled here.
    // That limitation must be stated, not implied by omission.
    expect(reported.Account.attributes['Smart Tag'].valuesNote).toMatch(/cannot be verified/i);
  });

  it('surfaces the promoted attribute from the application\'s own map', () => {
    const reported = attributes();
    for (const [entity, promoted] of Object.entries(DC_PROMOTED_ATTR)) {
      expect(reported[entity]?.promotedAttribute, entity).toBe(promoted);
    }
  });

  it('still fails loudly on an unknown entity rather than inventing one', () => {
    const out = runTool('list_audience_attributes', { entity: 'Spaceship' }, { tenant });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out.result)).toMatch(/Unknown entity/);
    expect(JSON.stringify(out.result)).not.toMatch(/allowedValues/);
  });

  it('cannot be called per entity, so it cannot be called repeatedly', () => {
    // A live run spent six of its eight tool rounds fetching one entity at a
    // time and never produced an answer. The narrowing parameter is gone: one
    // call always returns everything, whatever the model asks for.
    const tool = AGENT_TOOLS.find((t) => t.name === 'list_audience_attributes')!;
    expect(Object.keys(tool.input_schema.properties)).toEqual([]);
    const all = Object.keys(ELIGIBILITY_META);
    for (const call of [{}, { entity: 'Account' }]) {
      const out = runTool('list_audience_attributes', call, { tenant });
      expect(Object.keys((out.result as AttrResult).entities), JSON.stringify(call)).toEqual(all);
    }
  });
});

describe('event discovery exposes the entity mapping and the isNew flag', () => {
  it('maps every category to the entity its conditions filter, from DC_EVENT_ENTITY', () => {
    const reported = events();
    for (const category of Object.keys(EVENT_CATEGORIES)) {
      expect(reported[category].conditionEntity, category).toBe(DC_EVENT_ENTITY[category] ?? null);
    }
    // The specific mapping the EMI failure turned on.
    expect(reported['Transaction Events'].conditionEntity).toBe('Transaction');
    expect(reported['EMI Events'].conditionEntity).toBe('EMI Request');
  });

  it('marks a category with no entity-based conditions instead of leaving it ambiguous', () => {
    const reported = events();
    // Card Events resolves neither an entity nor a locked attribute — a real
    // gap in the source, not something to paper over.
    expect(reported['Card Events'].conditionEntity).toBeNull();
    expect(reported['Card Events'].conditionsNote).toBeTruthy();
  });

  it('reports isNew exactly as the application records it', () => {
    const reported = events();
    for (const [category, meta] of Object.entries(EVENT_CATEGORIES)) {
      expect(reported[category].status, category).toBe(meta.isNew ? 'new-proposed' : 'supported');
      if (meta.isNew) expect(reported[category].statusNote, category).toMatch(/not confirmed as built/i);
      else expect(reported[category].statusNote, category).toBeUndefined();
    }
    // Guards against a change that quietly marks everything supported.
    expect(Object.values(reported).filter((r) => r.status === 'new-proposed').length).toBeGreaterThan(0);
  });

  it('carries the locked attribute for the categories that use one', () => {
    const reported = events();
    const journey = reported['Journey Events'];
    expect(journey.lockedAttributeByEventType).toEqual(
      Object.fromEntries(EVENT_CATEGORIES['Journey Events'].events.map((e) => [e, EVENT_ATTR_BY_TYPE[e]])),
    );
    expect(journey.lockedAttributeOperators).toEqual(LOCKED_ATTR_OPERATORS);
    // Entity-based categories have no locked attribute, and must not claim one.
    expect(reported['Transaction Events'].lockedAttributeByEventType).toBeUndefined();
  });
});

describe('channel discovery carries the delivery-status vocabulary', () => {
  it('reports statuses only for channels this tenant may actually send on', () => {
    const result = runTool('list_channels', {}, { tenant }).result as {
      available: string[];
      notAvailable: string[];
      deliveryStatusesByChannel: Record<string, string[]>;
    };
    expect(Object.keys(result.deliveryStatusesByChannel).sort()).toEqual([...result.available].sort());
    for (const ch of result.notAvailable) {
      expect(result.deliveryStatusesByChannel[ch]).toBeUndefined();
    }
  });

  it('takes the statuses from the application\'s own per-channel vocabulary', () => {
    const result = runTool('list_channels', {}, { tenant }).result as {
      deliveryStatusesByChannel: Record<string, string[]>;
    };
    for (const [channel, statuses] of Object.entries(result.deliveryStatusesByChannel)) {
      for (const real of DELIVERY_STATUS_BY_CHANNEL[channel as Channel]) {
        expect(statuses, channel).toContain(real);
      }
    }
  });
});

describe('template availability never contradicts the tenant', () => {
  it('does not list templates for a tenant whose library is unreachable', () => {
    expect(tenant.templateLibraryAccess).toBe('unavailable');
    const v = blueprintVocabulary(CHANNELS, tenant.templateLibraryAccess);
    // The exact contradiction being removed: the prompt used to assert these
    // templates "exist" while the tool said the library could not be read.
    expect(v).not.toContain('templates that exist');
    for (const t of COMMS_TEMPLATES) expect(v).not.toContain(t.name);
    expect(v).toMatch(/NOT readable from here/i);
  });

  it('still lists the demo tenant\'s library, labelled synthetic', () => {
    expect(demoTenant.templateLibraryAccess).toBe('synthetic-demo');
    const v = blueprintVocabulary(CHANNELS, demoTenant.templateLibraryAccess);
    expect(v).toContain(COMMS_TEMPLATES[0].name);
    expect(v).toMatch(/SYNTHETIC demo library/i);
    expect(v).not.toMatch(/CT-\d{4}/);
  });

  it('agrees with what check_template_availability reports, per tenant', () => {
    for (const t of [tenant, demoTenant]) {
      const tool = runTool('check_template_availability', {}, { tenant: t }).result as { reachable: boolean };
      const vocabLists = COMMS_TEMPLATES.some((tpl) =>
        blueprintVocabulary(CHANNELS, t.templateLibraryAccess).includes(tpl.name),
      );
      expect(vocabLists, t.tenantId).toBe(tool.reachable);
    }
  });
});

describe('the vocabulary block points at the metadata rather than duplicating it', () => {
  it('names each category\'s entity and flags the new ones', () => {
    const v = blueprintVocabulary(CHANNELS, 'unavailable');
    expect(v).toContain('Transaction Events: Transaction — conditions filter Transaction');
    expect(v).toContain('MARKED NEW');
  });

  it('tells the model to fetch allowed values instead of inlining 34 of them', () => {
    const v = blueprintVocabulary(CHANNELS, 'unavailable');
    expect(v).toContain('list_audience_attributes');
    // Inlining the full value catalogue is what this deliberately avoids.
    expect(v).not.toContain('AUTHORIZATION_REVERSAL');
  });
});

describe('step types report how they may be wired', () => {
  type StepReport = {
    type: string;
    label: string;
    usableAsEntry: boolean;
    terminal: boolean;
    routesOneWay: boolean;
    addableFromPicker: boolean;
  };
  // `.nodeTypes`, since 2026-10-23. The tool also reports what a branch may
  // ROUTE ON, which the four flags could not say: `routesOneWay` is true of a
  // Decision Split whichever source it uses, so the agent could see that a
  // step routes and not that it can route on the last message's delivery
  // status.
  const steps = () => (runTool('list_step_types', {}, { tenant }).result as { nodeTypes: StepReport[] }).nodeTypes;
  const branchesOn = () =>
    (runTool('list_step_types', {}, { tenant }).result as { branchesOn: Record<string, unknown> }).branchesOn;

  it('still returns every step type the builder defines', () => {
    const reported = steps();
    expect(reported.map((s) => s.type).sort()).toEqual(Object.keys(DC_NODE_META).sort());
    expect(reported).toHaveLength(Object.keys(DC_NODE_META).length);
    for (const s of reported) expect(s.label, s.type).toBe(DC_NODE_META[s.type as keyof typeof DC_NODE_META].type);
  });

  it('matches the application\'s own type lists for every flag', () => {
    // Compared against the lists the reducer and validators use, never
    // against a list written out here — a second copy is how the tool and
    // the builder would drift apart.
    for (const s of steps()) {
      const t = s.type as never;
      expect(s.usableAsEntry, `${s.type}.usableAsEntry`).toBe(DC_ENTRY_TYPES.includes(t));
      expect(s.terminal, `${s.type}.terminal`).toBe(DC_TERMINAL_TYPES.includes(t));
      expect(s.routesOneWay, `${s.type}.routesOneWay`).toBe(DC_ROUTING_TYPES.includes(t));
      expect(s.addableFromPicker, `${s.type}.addableFromPicker`).toBe(DC_STEP_TYPES.includes(t));
    }
  });

  it('says what a branch may route on, from the application\'s own status table', () => {
    // Without this the agent knows a Decision Split exists and not that it
    // can read the last message's delivery status — which is the one signal
    // the journey is supposed to move on. Compared against the real
    // per-channel table, never a list written out here.
    const on = branchesOn() as {
      attribute: string;
      previousStepOutcome: string;
      engagementByChannel: Record<string, string[]>;
      neverBranchOn: { inFlight: string[]; undelivered: string };
    };
    expect(on.engagementByChannel.WHATSAPP).toEqual(['DELIVERED', 'READ', 'DELETED']);
    // WhatsApp and SMS report neither opens nor clicks.
    expect(on.engagementByChannel.WHATSAPP).not.toContain('CLICKED');
    expect(on.engagementByChannel.SMS).toEqual(['DELIVERED']);
    expect(on.engagementByChannel.EMAIL).toContain('CLICKED');
    expect(on.engagementByChannel.RCS).toContain('READ');
    // Nothing in flight is offered as a branch.
    for (const s of ['QUEUED', 'SENT', 'PENDING']) expect(on.neverBranchOn.inFlight).toContain(s);
    for (const list of Object.values(on.engagementByChannel)) {
      for (const s of ['QUEUED', 'SENT', 'PENDING', 'FAILED']) expect(list).not.toContain(s);
    }
    expect(on.neverBranchOn.undelivered).toMatch(/fallbackChannel/);
    expect(on.attribute).toMatch(/Not a reaction/);
    expect(on.previousStepOutcome).toMatch(/statuses/);
  });

  it('distinguishes the three kinds of wiring the agent has to respect', () => {
    // Guards the assertion above: a bug that returned the same value for
    // every type would satisfy a per-type comparison only if the lists were
    // also uniform. They are not.
    const by = Object.fromEntries(steps().map((s) => [s.type, s]));
    expect(by.ENTRY_EVENT.usableAsEntry).toBe(true);
    expect(by.SEND.usableAsEntry).toBe(false);
    expect(by.EXIT.terminal).toBe(true);
    expect(by.SEND.terminal).toBe(false);
    expect(by.SPLIT.routesOneWay).toBe(true);
    expect(by.PAUSE.routesOneWay).toBe(false);
    // Entry steps are not offered in the mid-journey picker.
    expect(by.ENTRY_EVENT.addableFromPicker).toBe(false);
    expect(by.SEND.addableFromPicker).toBe(true);
  });
});
