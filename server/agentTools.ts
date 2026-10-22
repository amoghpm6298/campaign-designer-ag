// Tools the model can actually call, executed server-side.
//
// Every tool here returns REAL data from the application's own source or the
// resolved tenant. None of them is a stub, and the orchestrator never
// fabricates a call or a result: a tool event is emitted only when the model
// genuinely requested it and the function below genuinely ran.
import {
  EVENT_CATEGORIES,
  ELIGIBILITY_META,
  COMMS_TEMPLATES,
  DC_EVENT_ENTITY,
  DC_PROMOTED_ATTR,
  EVENT_ATTR_BY_TYPE,
  LOCKED_ATTR_OPERATORS,
  DELIVERY_STATUS_COMMON,
  DELIVERY_STATUS_BY_CHANNEL,
  dcOperatorsForAttribute,
  type AttrMeta,
  type Channel,
} from '../src/data/sharedConstants';
import { generateSchemaArtefact } from '../agent-proto/schema/generateSchema';
import type { TenantConfig } from './tenants';
import { bankContext } from './knowledge';

export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    /**
     * Shared sub-schemas, referenced by `$ref`. Needed by the journey grammar,
     * whose step shape is recursive: an experiment arm, a condition branch and
     * a branch path each contain steps. The prompt version of this grammar had
     * to describe that recursion in prose and hope; here the API checks it.
     */
    $defs?: Record<string, unknown>;
  };
  /** Shown in the UI while it runs. */
  title: string;
}

export const AGENT_TOOLS: ToolDef[] = [
  {
    name: 'list_event_types',
    title: 'Checking available trigger events',
    description:
      'Lists the event categories and event types this platform supports, for entry triggers, waits and goals. Each category also reports which entity its conditions filter on, and whether the category is marked new (proposed, not yet built). Call this before choosing an entry trigger or goal so you only use real events.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_audience_attributes',
    title: 'Checking audience attributes',
    description:
      'Returns EVERY entity in one response, and for each attribute its type, the operators that attribute accepts, and the exact allowed values where the attribute is a fixed list. Call this once before writing any condition — a value outside the allowed list will not match anyone. It takes no arguments and there is nothing further to narrow.',
    // No narrowing parameter, deliberately. With one, a live run spent six of
    // its eight tool rounds fetching one entity at a time and never reached an
    // answer. The whole catalogue is ~5kB; there is nothing to save by
    // splitting it, and a tool that CAN be called per entity will be.
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_channels',
    title: 'Checking channel availability',
    description:
      'Lists the communication channels this tenant has available, with their relative cost order, and the delivery statuses each channel can report. Use it before recommending a channel, or before branching on a previous message\'s delivery outcome.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'check_template_availability',
    title: 'Checking message template availability',
    description:
      'Reports whether this tenant\'s message template library is reachable, and if so what it contains. Use it before assuming a template can be referenced.',
    input_schema: {
      type: 'object',
      properties: { objective: { type: 'string', description: 'Optional. What the message needs to say.' } },
    },
  },
  {
    name: 'list_step_types',
    title: 'Checking available journey steps',
    description:
      'Lists the journey step types the campaign builder supports, and for each one how it may be wired: whether a journey can start on it, whether it ends a path, and whether it routes a customer down one arm. Use it so you only propose steps that exist and only connect them in ways the builder allows.',
    input_schema: { type: 'object', properties: {} },
  },
];

export interface ToolContext {
  tenant: TenantConfig;
}

export interface ToolRun {
  ok: boolean;
  /** JSON-serialisable result handed back to the model and shown in the UI. */
  result: unknown;
  /** One line describing what came back, for the activity timeline. */
  summary: string;
}

/**
 * Why an attribute has no fixed list of values.
 *
 * Stated explicitly rather than omitted: "no allowedValues key" reads as
 * "any value is fine", which is wrong for a Smart Tag whose real values are
 * issuer-configured and simply not modelled here. The agent must be able to
 * tell "free text by design" from "we cannot see the list".
 */
function valuesNote(type: AttrMeta['type']): string {
  switch (type) {
    case 'smartTag':
      return 'Issuer-configured Smart Tag. The application models the input type only — no list of real tag values exists in this prototype, so a value here cannot be verified.';
    case 'list':
      return 'Free-form list. The application does not constrain the entries.';
    case 'number':
      return 'Numeric value.';
    case 'date':
      return 'Date value.';
    case 'bool':
      return 'true or false.';
    case 'highestTxnEMI':
    case 'none':
      return 'Specialised input handled by the builder. Not a plain value.';
    default:
      return 'No fixed list of values is defined for this attribute.';
  }
}

/** One attribute, described exactly as the builder's own drawer would offer it. */
function describeAttribute(meta: AttrMeta) {
  return {
    type: meta.type,
    operators: dcOperatorsForAttribute(meta),
    ...(meta.options?.length ? { allowedValues: meta.options } : { valuesNote: valuesNote(meta.type) }),
  };
}

function describeEntity(entity: string) {
  const attrs = (ELIGIBILITY_META as Record<string, Record<string, AttrMeta>>)[entity];
  const described = Object.fromEntries(Object.entries(attrs).map(([name, meta]) => [name, describeAttribute(meta)]));
  const promoted = DC_PROMOTED_ATTR[entity];
  return { attributes: described, ...(promoted ? { promotedAttribute: promoted } : {}) };
}

/** Executes a tool. Unknown names fail loudly rather than returning nothing. */
/**
 * Which tools the agent may use before it has stated an intervention.
 *
 * THE DISTINCTION, and it is the campaign manager's own: channel
 * availability is BANK CONTEXT — what this issuer can send on and what it
 * costs — and that legitimately shapes a strategy. Event types, audience
 * attributes and step types are the BUILDER'S VOCABULARY, and they are a
 * build-time concern.
 *
 * WHY THIS GATE EXISTS. Measured on every recorded run: the agent fired four
 * platform lookups before asking its first question, and its opening reply
 * then quoted the EMI Request status vocabulary back at a manager who had not
 * yet said a word about customers. Knowing the field list before knowing the
 * problem is how a conversation about why people do not convert turns into a
 * conversation about which attributes are filterable. The campaign gets
 * designed around what is expressible rather than around what is wrong.
 *
 * Nothing is removed. The builder's vocabulary becomes available at the
 * design step, where the agent states its intervention and the capability
 * check already runs — which is the point at which "what can this platform
 * express?" is the right question instead of a distraction.
 */
/**
 * Tools withheld until a plan has been approved.
 *
 * `list_channels` and `check_template_availability` joined this set on
 * 2026-10-21, which leaves discovery with NO lookup tools at all. That is the
 * intent, not an oversight: with only those two available, turn one could
 * only ever be a channel inventory, and a live run opened with "I checked the
 * channels and template availability" before asking the manager anything.
 *
 * Nothing is lost. `issuerContext` already names the available channels in
 * the prompt on every turn, and which templates exist is a build-time
 * question — it cannot change what the campaign should be, only how it gets
 * assembled afterwards.
 */
const BUILD_TIME_TOOLS = new Set([
  'list_event_types',
  'list_audience_attributes',
  'list_step_types',
  'list_channels',
  'check_template_availability',
]);

export const toolsForPhase = (designStated: boolean) =>
  designStated ? AGENT_TOOLS : AGENT_TOOLS.filter((t) => !BUILD_TIME_TOOLS.has(t.name));

export function runTool(name: string, input: Record<string, unknown>, ctx: ToolContext): ToolRun {
  switch (name) {
    case 'list_event_types': {
      // Event names alone are not enough to write a valid entry: a condition
      // on a category filters the attributes of that category's ENTITY, and
      // that mapping (DC_EVENT_ENTITY) used to live only in the builder. An
      // agent that cannot see it has to guess which attribute set applies —
      // which is how an EMI objective ended up filtering EMI Request
      // attributes on an entry that should have been a Transaction.
      const result = Object.fromEntries(
        Object.entries(EVENT_CATEGORIES).map(([category, meta]) => {
          const conditionEntity = DC_EVENT_ENTITY[category] ?? null;
          const lockedAttributeByEventType = Object.fromEntries(
            meta.events.filter((e) => EVENT_ATTR_BY_TYPE[e]).map((e) => [e, EVENT_ATTR_BY_TYPE[e]]),
          );
          const hasLocked = Object.keys(lockedAttributeByEventType).length > 0;
          return [
            category,
            {
              events: meta.events,
              /** Whose attributes a condition on this category filters. */
              conditionEntity,
              ...(hasLocked
                ? { lockedAttributeByEventType, lockedAttributeOperators: LOCKED_ATTR_OPERATORS }
                : {}),
              ...(conditionEntity && DC_PROMOTED_ATTR[conditionEntity]
                ? { promotedAttribute: DC_PROMOTED_ATTR[conditionEntity] }
                : {}),
              // isNew is the application's own flag. The builder shows it as
              // "(New)"; the agent was not being told at all.
              status: meta.isNew ? 'new-proposed' : 'supported',
              ...(meta.isNew
                ? {
                    statusNote:
                      'Marked new in the platform metadata: proposed, not confirmed as built in production today. You may design with it, but say so as a limitation rather than presenting it as a verified capability.',
                  }
                : {}),
              ...(!conditionEntity && !hasLocked
                ? {
                    conditionsNote:
                      'This category resolves no entity and no locked attribute, so its conditions cannot be narrowed by attribute today.',
                  }
                : {}),
            },
          ];
        }),
      );
      const total = Object.values(EVENT_CATEGORIES).reduce((n, m) => n + m.events.length, 0);
      const newOnes = Object.entries(EVENT_CATEGORIES).filter(([, m]) => m.isNew).map(([c]) => c);
      return {
        ok: true,
        result,
        summary:
          `${total} event types across ${Object.keys(result).length} categories` +
          (newOnes.length ? `; marked new: ${newOnes.join(', ')}` : ''),
      };
    }
    case 'list_audience_attributes': {
      const known = Object.keys(ELIGIBILITY_META);
      // The schema declares no parameters, but a model may still send one. An
      // entity nobody has ever heard of is still answered loudly rather than
      // with something plausible — that check is the point, not the narrowing.
      const entity = typeof input.entity === 'string' ? input.entity : undefined;
      if (entity && !known.includes(entity)) {
        return {
          ok: false,
          result: { error: `Unknown entity "${entity}". Known: ${known.join(', ')}` },
          summary: `Unknown entity "${entity}"`,
        };
      }
      const result = {
        entities: Object.fromEntries(known.map((e) => [e, describeEntity(e)])),
        note: 'Every entity is here. allowedValues is the complete set the application accepts for that attribute — a condition value outside it matches nobody. Where allowedValues is absent, valuesNote says why. There is nothing more to fetch, so do not call this again.',
      };
      const attrCount = known.reduce(
        (n, e) => n + Object.keys((ELIGIBILITY_META as Record<string, object>)[e]).length,
        0,
      );
      return {
        ok: true,
        result,
        summary: `${known.length} entities, ${attrCount} attributes, with types, operators and allowed values`,
      };
    }
    case 'list_channels': {
      // ORDERED THE WAY THE ISSUER PREFERS, not always by price.
      //
      // This tool returned `availableCheapestFirst` unconditionally, with a
      // summary that said "cheapest first" out loud. That taught the model to
      // open on email at the same moment the bank context was telling it not
      // to, and the tool won because it looked like data.
      const cheapestFirst = Boolean(bankContext().softPreferences?.preferLowerCostChannelFirst?.value);
      const reachOrder = ['WHATSAPP', 'SMS', 'EMAIL', 'RCS'];
      const available = ctx.tenant.availableChannels
        .filter((c) => c.available)
        .sort((a, b) =>
          cheapestFirst
            ? a.relativeCost - b.relativeCost
            : reachOrder.indexOf(a.channel) - reachOrder.indexOf(b.channel),
        );
      const unavailable = ctx.tenant.availableChannels.filter((c) => !c.available).map((c) => c.channel);
      // Delivery statuses are the vocabulary a "condition" step branches on.
      // Scoped to the channels this tenant can actually send on, so the agent
      // cannot branch on a status from a channel it may not use.
      const deliveryStatusesByChannel = Object.fromEntries(
        available.map((c) => [
          c.channel,
          [...(DELIVERY_STATUS_BY_CHANNEL[c.channel as Channel] ?? []), ...DELIVERY_STATUS_COMMON],
        ]),
      );
      return {
        ok: true,
        result: {
          available: available.map((c) => c.channel),
          notAvailable: unavailable,
          note: cheapestFirst
            ? 'Listed cheapest first. The relative costs are prototype values, not a real rate card.'
            : 'Listed by how Indian retail cardholders actually read, not by price. Cost breaks a tie between channels that would both work; it never picks the first one. The relative costs are prototype values, not a real rate card.',
          deliveryStatusesByChannel,
          deliveryStatusNote:
            'These are the only values a condition on a previous send\'s outcome may use, and they depend on the channel that send actually used.',
        },
        summary: `${available.length} available: ${available.map((c) => c.channel).join(', ')}`,
      };
    }
    case 'check_template_availability': {
      if (ctx.tenant.templateLibraryAccess === 'unavailable') {
        return {
          ok: true,
          result: {
            reachable: false,
            meaning:
              'This tenant\'s template library lives in the bank\'s own ecosystem and cannot be read from here. You cannot confirm OR deny that a suitable template exists. Design the message anyway: propose the copy, CTA and tokens, and the user will supply the real account and template ID.',
          },
          summary: 'Not reachable — the user will supply template IDs',
        };
      }
      return {
        ok: true,
        result: {
          reachable: true,
          scope: 'SYNTHETIC demo library, not a real bank catalogue',
          templates: COMMS_TEMPLATES.map((t) => ({ name: t.name, channel: t.channelType })),
        },
        summary: `Sample demo library reachable (${COMMS_TEMPLATES.length} templates)`,
      };
    }
    case 'list_step_types': {
      // The names alone said nothing about how a step may be WIRED, so the
      // agent could not tell a step that ends a path from one that routes.
      //
      // The four flags come from generateSchemaArtefact, which already
      // derives them from the application's own DC_STEP_TYPES /
      // DC_ENTRY_TYPES / DC_ROUTING_TYPES / DC_TERMINAL_TYPES. Nothing is
      // re-derived here: a second copy of that logic is exactly how the tool
      // and the builder would drift apart.
      const artefact = generateSchemaArtefact();
      const result = Object.entries(artefact.nodeTypes).map(([type, m]) => ({
        type,
        label: m.label,
        /** May a journey start on this step? */
        usableAsEntry: m.usableAsEntry,
        /** Does this step end a path, so nothing can follow it? */
        terminal: m.terminal,
        /** Does it route a customer down exactly one of its arms? */
        routesOneWay: m.routesOneWay,
        /** Can a person add it from the builder's own step picker? */
        addableFromPicker: m.addableFromPicker,
      }));
      return { ok: true, result, summary: `${result.length} step types, with how each may be wired` };
    }
    default:
      return { ok: false, result: { error: `Unknown tool "${name}"` }, summary: `Unknown tool "${name}"` };
  }
}

/**
 * Titles for every tool, including the ones the model WRITES through.
 *
 * MEASURED: the activity timeline read "Running record_findings" — a raw
 * internal name shown to a campaign manager, which is exactly what the prompt
 * forbids the agent from doing. The lookup only knew AGENT_TOOLS, so the
 * output tools fell through to the `Running ${name}` default.
 *
 * Registered rather than imported, because outputTools.ts imports ToolDef from
 * here and a direct import would be circular.
 */
const extraTitles = new Map<string, string>();
export const registerToolTitles = (defs: { name: string; title: string }[]) => {
  for (const d of defs) extraTitles.set(d.name, d.title);
};
export const toolTitle = (name: string) =>
  AGENT_TOOLS.find((t) => t.name === name)?.title ?? extraTitles.get(name) ?? `Running ${name}`;
