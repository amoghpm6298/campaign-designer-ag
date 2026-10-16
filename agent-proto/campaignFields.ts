// Campaign-level configuration: the authoritative field list, and the
// provenance of every field the agent emits.
//
// Two things live here, and they are related on purpose.
//
// 1. The FIELD LIST, parsed out of src/data/graphTypes.ts. A TypeScript
//    interface is erased at runtime, so it cannot be reflected on — but it
//    can be read from the source that defines it. A hand-maintained copy
//    would be exactly the drift the schema gate exists to catch, so the list
//    is derived instead. One derivation, two readers: the schema artefact
//    (for drift) and the validator (for unknown fields).
//
// 2. The PROVENANCE of each emitted field. The campaign payload stays a
//    plain DripCampaign — provenance is agent metadata and never goes inside
//    it. What this adds is the basis for each value, because the risk is not
//    a wrong field but a field that looks decided when it was defaulted,
//    guessed, or simply never supplied.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROGRAM_OPTIONS } from '../src/data/sharedConstants';
import type { DripCampaign, DripGoal, DripGraph } from '../src/data/graphTypes';

const here = dirname(fileURLToPath(import.meta.url));
const GRAPH_TYPES = resolve(here, '../src/data/graphTypes.ts');

export interface CampaignFieldSpec {
  name: string;
  optional: boolean;
}

/** Extracts a named interface/type block's body from the source text. */
function blockBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`Could not find "${declaration}" in ${GRAPH_TYPES}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`Unbalanced braces reading "${declaration}"`);
}

/**
 * The DripCampaign field list, read from the application source.
 *
 * Only top-level fields are collected. The indentation anchor matters: it
 * keeps inline object members (guardrails' own `dnc` / `npa`) out of the
 * list, since those are not campaign fields.
 */
export function dripCampaignFields(): CampaignFieldSpec[] {
  const body = blockBody(readFileSync(GRAPH_TYPES, 'utf8'), 'export interface DripCampaign');
  const fields: CampaignFieldSpec[] = [];
  for (const line of body.split('\n')) {
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue; // comment
    const m = /^ {2}(\w+)(\??):/.exec(line);
    if (m) fields.push({ name: m[1], optional: m[2] === '?' });
  }
  if (fields.length === 0) throw new Error('Parsed zero DripCampaign fields — the parser or the interface changed.');
  return fields;
}

/** The DripCampaignStatus union, also read from source rather than copied. */
export function dripCampaignStatuses(): string[] {
  const src = readFileSync(GRAPH_TYPES, 'utf8');
  const start = src.indexOf('export type DripCampaignStatus');
  if (start === -1) throw new Error('Could not find DripCampaignStatus');
  const decl = src.slice(start, src.indexOf(';', start));
  return [...decl.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
}

// --- Provenance --------------------------------------------------------

/**
 * Deliberately five categories, no more. The distinctions that matter are
 * "a person decided this", "the platform supplied it", "the application's
 * own default", "the agent proposes it", and "nobody has decided yet".
 */
export type ProvenanceBasis =
  /** A person answered this. */
  | 'user-answer'
  /** Supplied by the platform/host, e.g. the globally selected tenant. */
  | 'platform-context'
  /** The application's own default for a new campaign, cited to its source. */
  | 'application-default'
  /** The agent proposes this; a reviewer should confirm it. */
  | 'supported-recommendation'
  /**
   * A deliberate starting value chosen for this prototype. NOT the
   * application's own default and NOT evidence-backed — a decision about
   * where the user begins, which they can change before going live.
   */
  | 'prototype-default'
  /**
   * A temporary identifier or placeholder, not a recommendation. It exists so
   * the object is well-formed and must never be mistaken for a value the
   * Drip Campaign system issued or persisted.
   */
  | 'provisional'
  /** Nobody has decided, and the agent must not. Names the missing input. */
  | 'unresolved';

export interface FieldProvenance {
  basis: ProvenanceBasis;
  /** Where the value came from. Required for everything except 'unresolved'. */
  reference?: string;
  /** The missing input or decision. Required for 'unresolved'. */
  reason?: string;
  /** True when the field is deliberately absent from the campaign payload. */
  omitted?: true;
}

export type CampaignFieldProvenance = Record<string, FieldProvenance>;

/**
 * Either a usable proposal or an explicitly blocked one.
 *
 * A union rather than a `usable` flag on one shape, so "no campaign without a
 * verified tenant" is enforced by the type: there is no way to read
 * `.campaign` on a blocked proposal and get an object with an empty issuer.
 * Provenance is still produced when blocked, so the record explains why.
 */
export type CampaignProposal =
  | {
      usable: true;
      /** A plain DripCampaign. No wrapper, no extra keys, no provenance inside. */
      campaign: DripCampaign;
      provenance: CampaignFieldProvenance;
      unresolvedCampaignFields: string[];
      blockers: [];
    }
  | {
      usable: false;
      /** Deliberately null: an unusable configuration is not emitted at all. */
      campaign: null;
      provenance: CampaignFieldProvenance;
      unresolvedCampaignFields: string[];
      /** What must be supplied before a campaign configuration can exist. */
      blockers: string[];
    };

/**
 * The tenant context the platform passes in. The user selects a tenant before
 * the conversation starts and is never asked again inside the agent.
 *
 * Tenant identity and the application's `issuer` field are kept DISTINCT on
 * purpose. `issuer` is not derived from `tenantId` here: the mapping is a
 * platform fact, so the platform must assert it. The agent never guesses one
 * from the other.
 */
export interface TenantContext {
  /** Tenant identity as the platform knows it. */
  tenantId: string;
  /**
   * The application issuer this tenant resolves to, asserted by the platform.
   * Validated against PROGRAM_OPTIONS — an issuer the application does not
   * know is treated as an unreliable mapping and blocks the proposal.
   */
  issuer: string;
}

export interface ProposalInputs {
  scenarioId: string;
  goalStatement: string;
  goal: DripGoal | null;
  graph: DripGraph;
  /**
   * Absent in this prototype: no platform integration exists, and no scenario
   * or context file carries a tenant. Its absence BLOCKS the proposal rather
   * than producing a campaign with an empty issuer.
   */
  tenantContext?: TenantContext;
}

/**
 * Builds the proposed campaign configuration.
 *
 * The decisions, stated once:
 *
 *  - TENANT is MANDATORY. The user picks a tenant before the conversation
 *    starts and is never asked again, so the platform must pass it in. The
 *    application models no `tenant` field (zero occurrences in src/), so
 *    tenant identity and `issuer` stay distinct here and the platform asserts
 *    the mapping; this code never derives one from the other. Without a
 *    tenant — or with one whose issuer the application does not recognise —
 *    the proposal is BLOCKED and no campaign is emitted. Emitting
 *    `issuer: ''` would be a campaign that looks configured and is not, and
 *    issuer-dependent functionality (Smart Tags among others) would resolve
 *    against nothing.
 *
 *  - PROGRAM SCOPE starts at all programs, expressed the way the model
 *    expresses it: applyToAllPrograms = true with `programs` left empty,
 *    because the model states `programs` is ignored in that case. This is a
 *    `prototype-default` — a deliberate starting point, not evidence and not
 *    the application's own default (which is false). The user can change it
 *    before the campaign goes live.
 *
 *  - GUARDRAILS and RE-ENTRY. Both have UI defaults (dnc/npa `?? true`,
 *    allowReEntry `?? false`), but a UI default is not a user choice. The
 *    optional fields are omitted so the existing system's own defaults apply
 *    rather than being overwritten by a value the agent invented consent for.
 *
 *  - DATES. Omitted. No objective window, no preparation lead time, and the
 *    only calendar in the prototype is tagged INVENTED.
 *
 *  - CONTROL GROUP. Required by the model, so it cannot be omitted. The
 *    application's own default for a new campaign is 10 (DripBuilder.tsx:91),
 *    which is a real source-backed basis — notably NOT the invented bank
 *    preference that happens to hold the same number.
 */
export function buildCampaignProposal(input: ProposalInputs): CampaignProposal {
  const provenance: CampaignFieldProvenance = {};
  const set = (field: string, p: FieldProvenance) => {
    provenance[field] = p;
  };
  const blockers: string[] = [];

  // --- Tenant / issuer: mandatory, never inferred ----------------------
  const tenant = input.tenantContext;
  const issuers = knownIssuers();
  let issuer: string | null = null;

  if (!tenant) {
    blockers.push(
      'No tenant context was supplied. The platform must pass the tenant the user selected before the conversation started; the agent must not ask again or infer one.',
    );
    set('issuer', {
      basis: 'unresolved',
      reason:
        'No tenant context was supplied, so there is nothing to map to DripCampaign.issuer. The application models no "tenant" field (zero occurrences in src/), so the tenant -> issuer mapping is a platform fact the platform must assert — the agent does not derive it. issuer is REQUIRED by the model and by the application\'s own submit gate (DripBuilder.tsx:269), so rather than emit an empty value that would look configured, the whole campaign configuration is blocked.',
    });
  } else if (!issuers.includes(tenant.issuer)) {
    // A tenant was supplied but its asserted issuer is not one the
    // application knows. Guessing a nearby issuer, or falling back to the
    // tenantId, would be inventing the mapping.
    blockers.push(
      `Tenant "${tenant.tenantId}" asserts issuer "${tenant.issuer}", which the application does not know (PROGRAM_OPTIONS: ${issuers.join(', ')}). The mapping cannot be relied on, and the agent will not substitute an issuer of its own.`,
    );
    set('issuer', {
      basis: 'unresolved',
      reason: `Tenant "${tenant.tenantId}" maps to issuer "${tenant.issuer}", which is not a known application issuer. Not inferred from tenantId: tenant identity and issuer are distinct, and only the platform can establish the mapping.`,
    });
  } else {
    issuer = tenant.issuer;
    set('issuer', {
      basis: 'platform-context',
      reference: `tenant "${tenant.tenantId}" selected in the UI before the conversation; the platform asserts it maps to issuer "${tenant.issuer}", which is a known application issuer. Issuer-dependent functionality (e.g. Smart Tags) resolves against this.`,
    });
  }

  // --- Provenance for everything else, blocked or not ------------------
  set('id', {
    basis: 'provisional',
    reference:
      'Agent-namespaced temporary identifier, not a value the Drip Campaign system issued or persisted. The real campaign id is owned by the application and is minted when the campaign is actually created. There is no import path, so nothing here has been persisted anywhere.',
  });
  set('name', { basis: 'supported-recommendation', reference: 'derived from scenario.goalStatement' });
  set('description', {
    basis: 'supported-recommendation',
    reference: 'agent-written summary; states that fields may be unresolved',
  });
  set('applyToAllPrograms', {
    basis: 'prototype-default',
    reference:
      'Deliberate STARTING configuration for this prototype: all current and future programs are in scope. Expressed with the model\'s own applyToAllPrograms flag rather than a program list. Not evidence-backed, and not the application\'s own default — the application defaults this to false (DripBuilder.tsx:89). The user can review and change the program scope before the campaign goes live.',
  });
  set('programs', {
    basis: 'prototype-default',
    reference:
      'Empty as part of the same all-programs starting configuration: the model ignores `programs` when applyToAllPrograms is true (DripCampaign comment, graphTypes.ts), so no program list is fabricated. The user can narrow the scope to specific programs before the campaign goes live. Note: scenario.simulatedAnswers.which_programs names a fictional program and is not used.',
  });
  set('goal', { basis: 'user-answer', reference: 'scenario.simulatedAnswers.goal_event' });
  set('root', {
    basis: 'supported-recommendation',
    reference: 'journey graph built by the planner through the application\'s own dcConfirmAddNode',
  });
  set('controlPct', {
    basis: 'application-default',
    reference:
      'The application\'s own default for a new campaign is 10 (DripBuilder.tsx:91 `useState(initial?.controlPct ?? 10)`). Required by the model, so it cannot be omitted. Deliberately NOT presented as a bank-backed recommendation: softPreferences.preferredControlGroupPct is INVENTED and holds the same number by coincidence. Whether 10 is right for this campaign is a quality question for a reviewer.',
  });
  set('status', {
    basis: 'application-default',
    reference: 'DRAFT — the only honest status while no import path exists. Activation is not the agent\'s to decide.',
  });

  // Unresolved, and omitted from the payload.
  set('startDate', {
    basis: 'unresolved',
    omitted: true,
    reason:
      'No campaign objective window, no preparation lead time, and no real event calendar. The prototype\'s eventsCalendar is tagged INVENTED and is not evidence. Dates are left for a person to set.',
  });
  set('endDate', { basis: 'unresolved', omitted: true, reason: 'As startDate.' });
  set('guardrails', {
    basis: 'unresolved',
    omitted: true,
    reason:
      'DNC and NPA are campaign-level user choices owned by the existing system (GuardrailsStep.tsx). Both default to true in the UI (DripBuilder.tsx:95-96), but a UI default is not a confirmed choice. Omitted so the application\'s own default applies instead of the agent asserting consent.',
  });
  set('allowReEntry', {
    basis: 'unresolved',
    omitted: true,
    reason:
      'A campaign-level user choice. The UI defaults it to false (DripBuilder.tsx:92), but no user input or explicitly adopted default supports emitting it here. Omitted rather than hardcoded.',
  });
  set('reEntryCooloffDuration', {
    basis: 'unresolved',
    omitted: true,
    reason: 'Only meaningful when allowReEntry is true, which is itself unresolved. No cool-off is invented.',
  });
  set('reEntryCooloffUnit', { basis: 'unresolved', omitted: true, reason: 'As reEntryCooloffDuration.' });

  const unresolvedCampaignFields = Object.entries(provenance)
    .filter(([, p]) => p.basis === 'unresolved')
    .map(([field]) => field);

  // No verified tenant means no campaign configuration at all. The run still
  // completes and reports the missing context — that is a different thing
  // from having produced a valid configuration.
  if (issuer === null) {
    return { usable: false, campaign: null, provenance, unresolvedCampaignFields, blockers };
  }

  const campaign: DripCampaign = {
    id: `AGENT-${input.scenarioId}`,
    name: 'Auth Txn to EMI — Consent & Resolution (proposed)',
    description: `Proposed by the agent prototype from scenario ${input.scenarioId}. Campaign-level fields may be unresolved; see campaignFieldProvenance.`,
    issuer,
    applyToAllPrograms: true,
    programs: [],
    goal: input.goal,
    controlPct: 10,
    status: 'DRAFT',
    root: input.graph,
    // startDate, endDate, allowReEntry, reEntryCooloff*, guardrails and
    // versionOf are deliberately ABSENT. See the provenance entries above.
  };

  return { usable: true, campaign, provenance, unresolvedCampaignFields, blockers: [] };
}

/** Issuers the application actually knows about. */
export const knownIssuers = () => Object.keys(PROGRAM_OPTIONS);
