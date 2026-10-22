// The agent's Knowledge Base.
//
// Two kinds of knowledge, kept apart on purpose:
//
//  1. AUTHORITATIVE CAPABILITIES — node types, templates, event categories,
//     eligibility attributes, channels. Read from the application's own
//     source via the existing schema artefact generator. These are facts
//     about the product and are NOT user-editable: the user should never be
//     asked to confirm something the code already knows.
//
//  2. CURATED CONTEXT — bank/tenant guidance, costs, principles, brand
//     notes. Seeded from agent-proto's JSON files, user-editable, and every
//     entry carries a verification status. Much of it is INVENTED mock data
//     and is labelled as such; nothing here is a real bank policy.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSchemaArtefact } from '../agent-proto/schema/generateSchema';
import { COMMS_TEMPLATES, ELIGIBILITY_META, PROGRAM_OPTIONS } from '../src/data/sharedConstants';

const here = dirname(fileURLToPath(import.meta.url));
import { groupKnowledge, docsForAgent } from '../src/data/knowledgeShape';

const readJson = (p: string) => JSON.parse(readFileSync(resolve(here, p), 'utf8'));

/**
 * The issuer's bank context, for callers that need a preference rather than
 * the whole rendered knowledge base.
 *
 * Exported because `agentTools.ts` has to order the channel list the same way
 * the build does, and the two disagreeing is what taught the model to open on
 * email while the context told it not to. One source, read twice.
 */
export const bankContext = () => readJson('../agent-proto/context/bank-context.json');

export type VerificationStatus = 'verified' | 'observation' | 'hypothesis' | 'invented' | 'authoritative';

export interface KnowledgeEntry {
  id: string;
  category: string;
  label: string;
  /** Plain-text value the agent reads. Editable in the Knowledge Base view. */
  value: string;
  /** Where it came from — a file path, an app module, or 'user edit'. */
  source: string;
  status: VerificationStatus;
  /** Which campaigns/issuers it applies to. */
  scope?: string;
  /** Set when a user has edited the seeded value. */
  editedAt?: string;
}

export interface KnowledgeDocument {
  id: string;
  filename: string;
  scope: 'shared' | string;
  sizeBytes: number;
  uploadedAt: string;
  status: 'ready' | 'failed';
  error?: string;
  text?: string;
}

export interface KnowledgeBase {
  version: string;
  entries: KnowledgeEntry[];
  documents?: KnowledgeDocument[];
}

/** Capabilities the agent may use. Derived from app source; not editable. */
export interface Capabilities {
  nodeTypes: { type: string; label: string; category: string; addableFromPicker: boolean; usableAsEntry: boolean; terminal: boolean; routesOneWay: boolean }[];
  channels: string[];
  templates: { id: string; name: string; channelType: string; accountName: string }[];
  eventCategories: Record<string, string[]>;
  eligibilityAttributes: Record<string, string[]>;
  issuers: Record<string, string[]>;
  smartTagAttributes: string[];
  schemaContentHash: string;
  schemaArtefactVersion: string;
}

export function loadCapabilities(): Capabilities {
  const a = generateSchemaArtefact();
  return {
    nodeTypes: Object.entries(a.nodeTypes).map(([type, m]) => ({
      type,
      label: m.label,
      category: m.category,
      addableFromPicker: m.addableFromPicker,
      usableAsEntry: m.usableAsEntry,
      terminal: m.terminal,
      routesOneWay: m.routesOneWay,
    })),
    channels: Object.keys(a.vocabulary.channels),
    templates: COMMS_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      channelType: t.channelType,
      accountName: t.accountName,
    })),
    eventCategories: Object.fromEntries(Object.entries(a.vocabulary.eventCategories).map(([k, v]) => [k, v.events])),
    eligibilityAttributes: Object.fromEntries(
      Object.entries(ELIGIBILITY_META).map(([entity, attrs]) => [entity, Object.keys(attrs)]),
    ),
    issuers: PROGRAM_OPTIONS,
    // Smart Tags are issuer-dependent in the product, but the application
    // models them only as an input TYPE — there is no issuer keying in
    // src/. Listed so the agent knows they exist; not presented as resolved.
    smartTagAttributes: Object.entries(ELIGIBILITY_META).flatMap(([entity, attrs]) =>
      Object.entries(attrs)
        .filter(([, meta]) => (meta as { type: string }).type === 'smartTag')
        .map(([name]) => `${entity}.${name}`),
    ),
    schemaContentHash: a.contentHash,
    schemaArtefactVersion: a.schemaArtefactVersion,
  };
}

/**
 * The seed Knowledge Base, built from agent-proto's existing JSON files so
 * the prototype starts with the context that already exists rather than a
 * fresh invention. Every INVENTED value keeps that label.
 */
export function seedKnowledgeBase(): KnowledgeBase {
  const bank = readJson('../agent-proto/context/bank-context.json');
  const principles = readJson('../agent-proto/context/principles.json');
  const entries: KnowledgeEntry[] = [];

  const push = (e: Omit<KnowledgeEntry, 'id'> & { id?: string }) =>
    entries.push({ id: e.id ?? `${e.category}:${e.label}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'), ...e } as KnowledgeEntry);

  // THE TENANT IS NOT A KNOWLEDGE ENTRY. It used to be, reading
  // `bank.bank.displayName` — which is the fictional Meridian Bank, while the
  // resolved tenant is IndusInd. So the screen showed two different banks at
  // once and the agent was told both. The real tenant already reaches the
  // model in its own section of the context, and the user already has it in
  // the rail, so this said nothing true that was not already said.

  for (const c of bank.channels.available) {
    push({
      category: 'Channel costs & availability',
      label: `${c.channel}`,
      value: `relativeCost ${c.relativeCost}; available: ${c.available}`,
      source: 'agent-proto/context/bank-context.json → channels.available',
      status: 'invented',
      scope: bank.bank.displayName,
    });
  }

  const hc = bank.hardConstraints;
  // A PREFERENCE, not a hard constraint, and the scope says so.
  //
  // It was dumped as a hard constraint, and the agent read it the way anyone
  // would: every campaign came out as a fixed 48-hour clock. The guard is
  // against nagging, not a rhythm to design to — the same day is fine when
  // someone has just opened or clicked. The night window is the real limit.
  push({
    category: 'Preferences',
    label: 'Minimum hours between messages',
    value: `${hc.minHoursBetweenMessages.value} hours is a guard against nagging, not a fixed rhythm. Same day is fine when they have just opened or clicked. The night window below is the real limit.`,
    source: 'agent-proto/context/bank-context.json → hardConstraints',
    status: 'invented',
    scope: 'preference, may be traded off',
  });
  push({ category: 'Operational constraints', label: 'Quiet hours', value: `${hc.quietHours.from}–${hc.quietHours.to}`, source: 'agent-proto/context/bank-context.json → hardConstraints', status: 'invented', scope: 'hard constraint (issuer-owned)' });
  push({ category: 'Operational constraints', label: 'DNC required', value: String(hc.dncRequired.value), source: 'agent-proto/context/bank-context.json', status: 'invented', scope: 'campaign-level user choice' });
  push({ category: 'Operational constraints', label: 'NPA exclusion required', value: String(hc.npaExclusionRequired.value), source: 'agent-proto/context/bank-context.json', status: 'invented', scope: 'campaign-level user choice' });

  // THE MARKET, which the agent was previously designing without.
  //
  // It had no idea which country, currency, regulator or messaging regime it
  // was writing for — so it could not reason about a regulatory activation
  // clock, could not know WhatsApp outranks email for reach here, and would
  // have written "$" or "₹120,000" without noticing either was wrong.
  //
  // Marked 'verified' rather than 'invented', because unlike the fictional
  // bank above these are facts about India.
  //
  // NO REGULATORY OBLIGATIONS LIVE HERE, deliberately. A first version of this
  // block carried an RBI activation rule and the TRAI messaging regime. Both
  // came out: what a regulator requires is issuer-specific compliance context
  // that the bank supplies in its own constraints, it varies between issuers
  // and over time, and a prototype asserting it would have the agent telling a
  // campaign manager what the law says on our authority. The regulator is
  // NAMED so the agent knows the regime; nothing about what it demands.
  const market = bank.market as Record<string, { confidence?: string; note?: string; claim?: string; whyItMatters?: string; name?: string; symbol?: string }> | undefined;
  if (market) {
    push({
      category: 'Market',
      label: 'Country and customers',
      value: `${String(bank.market.country)}. ${String(bank.market.whoTheCustomersAre)}`,
      source: 'agent-proto/context/bank-context.json → market',
      status: 'verified',
      scope: 'market fact',
    });
    for (const [key, v] of Object.entries(market)) {
      if (!v || typeof v !== 'object' || (!v.note && !v.claim)) continue;
      const body = v.claim ? `${v.claim} ${v.whyItMatters ?? ''}`.trim() : String(v.note);
      push({
        category: 'Market',
        label: key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()),
        value: body,
        source: 'agent-proto/context/bank-context.json → market',
        status: 'verified',
        scope: 'market fact',
      });
    }
  }

  // Dumped as a SENTENCE, not a bare boolean. "false" on its own tells the
  // model nothing about what to do instead.
  push({
    category: 'Preferences',
    label: 'Channel order',
    value: bank.softPreferences.preferLowerCostChannelFirst.value
      ? 'Lead with the lower-cost channel and keep costlier ones for reinforcement.'
      : 'Do not lead with email because it is cheapest. Choose the first touch on reach and on where the customer can act. For Indian retail cardholders that is usually WhatsApp or in-app. Cost breaks a tie between channels that would both work; it never picks the first one.',
    source: 'agent-proto/context/bank-context.json → softPreferences',
    status: 'invented',
    scope: 'preference, may be traded off',
  });
  push({ category: 'Preferences', label: 'Preferred control group %', value: String(bank.softPreferences.preferredControlGroupPct.value), source: 'agent-proto/context/bank-context.json → softPreferences', status: 'invented', scope: 'preference' });
  // UNSPECIFIED MEANS DESIGN THE FULL PLAN.
  //
  // The level used to read "conservative", and the agent treated that as an
  // instruction to propose fewer messages and drop tests. A missing appetite
  // is missing information, not a request for restraint.
  push({
    category: 'Preferences',
    label: 'Risk appetite',
    value: `${bank.riskAppetite.level}. ${bank.riskAppetite.notes.join(' ')}`,
    source: 'agent-proto/context/bank-context.json → riskAppetite',
    status: 'invented',
    scope: 'guidance',
  });

  for (const e of bank.eventsCalendar.entries) {
    push({
      category: 'Events calendar',
      label: `${e.date} — ${e.label}`,
      value: `type: ${e.type}`,
      source: 'agent-proto/context/bank-context.json → eventsCalendar',
      status: 'invented',
      scope: 'bake these dates into the timing of the plan',
    });
  }

  for (const p of principles.principles) {
    push({
      id: `principle-${p.id}`,
      category: 'Campaign principles',
      label: p.id,
      value: p.statement,
      source: p.source,
      status: p.classification === 'verified' ? 'verified' : p.classification === 'observation' ? 'observation' : 'hypothesis',
      scope: p.appliesTo,
    });
  }

  push({
    category: 'Brand guidance',
    label: 'Tone of voice',
    value:
      'Short, plain sentences. No em-dash compound sentences. Never promise an outcome the data does not support. Lead with what the customer gets.',
    source: 'seeded for this prototype (editable)',
    status: 'hypothesis',
    scope: 'all messaging',
  });

  push({
    category: 'Historical learnings',
    label: 'Campaign performance history',
    value:
      'NONE AVAILABLE. No performance data exists for this bank anywhere in the prototype. Do not claim conversion lift or cost savings.',
    source: 'agent-proto/context/bank-context.json → knownGaps',
    status: 'verified',
    scope: 'all campaigns',
  });

  return { version: `seed-${bank.contextVersion}`, entries };
}

/**
 * Renders the KB for the model: grouped, with status so it can weigh it.
 *
 * `tenantId` scopes documents: a document uploaded for one tenant is never
 * shown to another. Only 'ready' documents are included — a failed upload
 * contributes nothing, which is why the UI must not call it available.
 */
/**
 * Grouped and scoped the way the agent reads it.
 *
 * Both are thin wrappers over `src/data/knowledgeShape.ts`, which the
 * Knowledge Base screen imports too. One definition, so the page and the
 * prompt cannot disagree about what the agent has.
 */
export const groupedKnowledge = (kb: KnowledgeBase) => groupKnowledge(kb.entries);
export const documentsForAgent = (kb: KnowledgeBase, tenantId?: string) => docsForAgent(kb.documents, tenantId);

export function knowledgeForPrompt(kb: KnowledgeBase, tenantId?: string): string {
  const lines: string[] = [];
  for (const { category: cat, entries: items } of groupedKnowledge(kb)) {
    lines.push(`## ${cat}`);
    for (const e of items) {
      const edited = e.editedAt ? ' [USER-EDITED]' : '';
      lines.push(`- ${e.label}: ${e.value} [status: ${e.status}]${edited}`);
    }
  }
  const docs = documentsForAgent(kb, tenantId);
  if (docs.length) {
    lines.push('');
    lines.push('## Uploaded documents');
    lines.push(
      'Supplied by the product team as context. They are NOT verified bank policy unless the document itself says so — weigh them accordingly.',
    );
    for (const d of docs) {
      lines.push(`\n### ${d.filename} (${d.scope === 'shared' ? 'shared' : `tenant ${d.scope}`})`);
      // Capped so one large upload cannot crowd out the rest of the context.
      lines.push(d.text!.slice(0, 20_000));
    }
  }
  return lines.join('\n');
}
