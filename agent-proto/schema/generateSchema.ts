// Generates the versioned campaign schema artefact FROM the application's
// own definitions. Nothing here restates a rule — every value is read out
// of the modules the app itself uses at runtime, so the artefact cannot
// describe a schema the app doesn't actually have.
//
// The one thing deliberately NOT exported as data: the validation rules.
// `dcAddFormValid` and `dcGraphHasOpenBranches` are logic, not a table,
// and flattening them into JSON would be exactly the second source of
// truth this file exists to prevent. The agent calls those functions
// directly (see ../validate.ts) instead.
import {
  DC_NODE_META,
  DC_STEP_TYPES,
  DC_TYPE_CATEGORIES,
  DC_ROUTING_TYPES,
  DC_TERMINAL_TYPES,
  dcCanFanOut,
  type DcNodeType,
} from '../../src/data/nodeMeta';
import { DC_ENTRY_TYPES, DC_TYPE_SUB } from '../../src/data/typeSub';
import { dripCampaignFields, dripCampaignStatuses } from '../campaignFields';
import { dcDefaultConfig } from '../../src/reducer/defaultConfig';
import {
  CHANNEL_CONFIG_LABELS,
  COMMS_TEMPLATES,
  PROGRAM_OPTIONS,
  EVENT_CATEGORIES,
  ELIGIBILITY_META,
  MILESTONE_BENEFITS,
  MILESTONE_OPERATORS,
  DELIVERY_STATUS_COMMON,
  DELIVERY_STATUS_BY_CHANNEL,
  EVENT_ATTR_BY_TYPE,
  LOCKED_ATTR_OPERATORS,
  JOURNEY_OPTIONS,
  BATCH_OPTIONS,
  OFFER_TYPE_OPTIONS,
  TRANSACTION_SUBTYPE_OPTIONS,
  DC_EVENT_ENTITY,
  DC_PROMOTED_ATTR,
} from '../../src/data/sharedConstants';

// Bump deliberately when the generated shape changes in a way a consumer
// must react to. The content hash below catches drift in the underlying
// app definitions; this version catches changes to the artefact's own
// structure. The two are not interchangeable: the hash, never this number,
// is what detects drift.
//
// 1.1.0 — added the top-level `campaignFields` key (DripCampaign's field list
// and status union). Additive and backward-compatible for any consumer that
// reads the keys it already knew, hence a minor bump rather than major.
export const SCHEMA_ARTEFACT_VERSION = '1.1.0';

export interface CampaignSchemaArtefact {
  schemaArtefactVersion: string;
  generatedAt: string;
  // Hash over the app-derived content only (excludes generatedAt), so a
  // regenerated artefact is byte-comparable run to run unless the app
  // actually changed. This is what a run record stamps.
  contentHash: string;
  source: {
    note: string;
    modules: string[];
    validatorsNotSerialised: string[];
  };
  nodeTypes: Record<
    string,
    {
      category: string;
      label: string;
      size: string;
      subLabel: string;
      addableFromPicker: boolean;
      usableAsEntry: boolean;
      routesOneWay: boolean;
      canFanOut: boolean;
      terminal: boolean;
      defaultConfig: unknown;
    }
  >;
  pickerCategories: { label: string; types: string[] }[];
  // Campaign-LEVEL fields, parsed from src/data/graphTypes.ts. Previously
  // absent, which meant the drift gate covered the graph vocabulary only: a
  // field added to or removed from DripCampaign moved nothing and failed no
  // run. Included in `content` below, so it is hashed like everything else.
  campaignFields: { fields: { name: string; optional: boolean }[]; statuses: string[] };
  vocabulary: {
    channels: Record<string, string>;
    commsTemplates: { id: string; name: string; channelType: string; accountName: string; partnerName: string }[];
    programsByIssuer: Record<string, string[]>;
    eventCategories: Record<string, { events: string[]; isNew?: boolean }>;
    eventEntityByCategory: Record<string, string>;
    promotedAttrByEntity: Record<string, string>;
    lockedAttrByEventType: Record<string, string>;
    lockedAttrOperators: string[];
    eligibilityAttributes: Record<string, Record<string, { type: string; options?: string[] }>>;
    milestoneBenefits: { id: string; name: string }[];
    milestoneOperators: { value: string; label: string }[];
    deliveryStatuses: { common: string[]; byChannel: Record<string, string[]> };
    journeys: string[];
    batches: string[];
    offerTypes: string[];
    transactionSubtypes: string[];
  };
}

// Small, dependency-free stable hash. Not cryptographic — its only job is
// to make "did the app's definitions change?" cheap to answer.
/**
 * Deterministic JSON with keys sorted at EVERY level.
 *
 * This replaces `JSON.stringify(value, Object.keys(value).sort())`, which was
 * a real bug rather than a style choice: an array second argument to
 * JSON.stringify is an allowlist replacer applied recursively, so only
 * top-level key names survived and every nested value was stripped. The hash
 * was therefore near-constant — it would detect a corrupted committed hash
 * (which is all the original verification proved) but NOT an actual change to
 * the app's definitions, which is the entire point of the gate.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/**
 * Replaces generated ids inside a default config with a fixed placeholder.
 *
 * dcDefaultConfig mints branch ids from a global counter (DECISION_SPLIT and
 * RANDOM_SPLIT get `dcb25`, `dcb26`, …), so two calls in the same process
 * produce different values. That made the artefact non-deterministic and the
 * contentHash unstable — a second defect the old stringify bug was masking.
 *
 * A branch id is instance identity, not schema: that a Branch starts with two
 * branches is a schema fact, that one of them is `dcb25` is not. Normalising
 * keeps the artefact byte-comparable run to run without dropping the
 * structure, and without resetting a counter the rest of the run depends on.
 */
function stripGeneratedIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripGeneratedIds);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = k === 'id' && typeof v === 'string' ? '<generated>' : stripGeneratedIds(v);
  }
  return out;
}

export function stableHash(value: unknown): string {
  const json = stableStringify(value);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 16);
}

export function generateSchemaArtefact(): CampaignSchemaArtefact {
  const allTypes = Object.keys(DC_NODE_META) as DcNodeType[];

  const nodeTypes: CampaignSchemaArtefact['nodeTypes'] = {};
  for (const t of allTypes) {
    const meta = DC_NODE_META[t];
    nodeTypes[t] = {
      category: meta.cat,
      label: meta.type,
      size: meta.size,
      subLabel: DC_TYPE_SUB[t],
      addableFromPicker: DC_STEP_TYPES.includes(t),
      usableAsEntry: DC_ENTRY_TYPES.includes(t),
      routesOneWay: DC_ROUTING_TYPES.includes(t),
      canFanOut: dcCanFanOut(t),
      terminal: DC_TERMINAL_TYPES.includes(t),
      // The real starting config the app itself would create. Passing a
      // null goal keeps this deterministic — a goal-derived default (e.g.
      // Goal Reached's reason) is campaign-specific, not schema.
      // Generated branch ids normalised out — see stripGeneratedIds.
      defaultConfig: stripGeneratedIds(dcDefaultConfig(t, null)),
    };
  }

  const vocabulary: CampaignSchemaArtefact['vocabulary'] = {
    channels: CHANNEL_CONFIG_LABELS,
    commsTemplates: COMMS_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      channelType: t.channelType,
      accountName: t.accountName,
      partnerName: t.partnerName,
    })),
    programsByIssuer: PROGRAM_OPTIONS,
    eventCategories: EVENT_CATEGORIES,
    eventEntityByCategory: DC_EVENT_ENTITY,
    promotedAttrByEntity: DC_PROMOTED_ATTR,
    lockedAttrByEventType: EVENT_ATTR_BY_TYPE,
    lockedAttrOperators: LOCKED_ATTR_OPERATORS,
    eligibilityAttributes: ELIGIBILITY_META,
    milestoneBenefits: MILESTONE_BENEFITS,
    milestoneOperators: MILESTONE_OPERATORS,
    deliveryStatuses: { common: DELIVERY_STATUS_COMMON, byChannel: DELIVERY_STATUS_BY_CHANNEL },
    journeys: JOURNEY_OPTIONS,
    batches: BATCH_OPTIONS,
    offerTypes: OFFER_TYPE_OPTIONS,
    transactionSubtypes: TRANSACTION_SUBTYPE_OPTIONS,
  };

  const pickerCategories = DC_TYPE_CATEGORIES.map((c) => ({ label: c.label, types: [...c.types] }));

  const campaignFields = { fields: dripCampaignFields(), statuses: dripCampaignStatuses() };

  const content = { campaignFields, nodeTypes, pickerCategories, vocabulary };

  return {
    schemaArtefactVersion: SCHEMA_ARTEFACT_VERSION,
    generatedAt: new Date().toISOString(),
    contentHash: stableHash(content),
    source: {
      note:
        'Generated from the application source. Do not edit by hand — regenerate with `npm run agent:schema` after changing node definitions, default configs or shared vocabulary.',
      modules: [
        'src/data/nodeMeta.ts',
        'src/data/typeSub.ts',
        'src/reducer/defaultConfig.ts (dcDefaultConfig)',
        'src/data/sharedConstants.ts',
        'src/data/graphTypes.ts (DripCampaign fields, DripCampaignStatus)',
      ],
      validatorsNotSerialised: [
        'dcAddFormValid (src/reducer/defaultConfig.ts) — per-node required-field rules',
        'dcGraphHasOpenBranches (src/reducer/graphOps.ts) — submit gate',
        'dcConfirmAddNode (src/reducer/campaignReducer.ts) — wiring/auto-child rules',
      ],
      ...({} as Record<string, never>),
    },
    ...content,
  } as CampaignSchemaArtefact;
}
