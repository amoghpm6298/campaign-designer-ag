// The proposed path, as a manager would scan it.
//
// WHY THIS EXISTS. On the propose turn the agent described a journey in prose
// and the left pane showed a grey wireframe captioned "The journey appears
// here once you approve a plan". So the one moment the manager has to make a
// real decision — approve this or say what to change — was the moment they
// had the least to look at. The picture arrived only after they had already
// said yes.
//
// `pendingBlueprint` was on the response all along, used solely as the
// Confirm payload. This turns it into something readable.
//
// WHAT THIS IS NOT. Not a journey engine, not an editor, not React Flow.
// `DripCanvas` renders a BUILT campaign — real nodes, real edges, a node
// drawer, live validation — and none of that exists yet on a proposal.
// Mounting it would also mean claiming the journey exists. This is a picture
// of a proposal, and it is read-only by construction: a pure function to
// rows, and a component that maps them.
//
// THE CLIENT VIEW IS NARROW AND LOCAL, the same decision as `BriefView`.
// `server/blueprint.ts` carries the compiler, the validators and the whole
// `BpStep` union with its documentation; importing it would pull the server's
// campaign machinery into the browser bundle to read six fields. So the
// fields this UI actually reads are declared here, and anything else on the
// object is ignored rather than typed.

/** Only what the preview reads. Everything else on the blueprint is ignored. */
export interface BlueprintView {
  campaignName?: string;
  description?: string;
  controlPct?: number;
  goal?: { eventCategory?: string; eventType?: string } | null;
  entry?:
    | { kind?: 'event'; eventCategory?: string; eventType?: string; conditions?: ViewCondition[] }
    | {
        kind?: 'audience';
        entity?: string;
        conditions?: ViewCondition[];
        groups?: { entity?: string; conditions?: ViewCondition[] }[];
      };
  steps?: ViewStep[];
}

export interface ViewCondition {
  attribute?: string;
  operator?: string;
  value?: string;
}

/**
 * A step, as the preview reads it.
 *
 * One optional-everything shape rather than a discriminated union, because
 * this is parsing a payload rather than constructing one: a blueprint from an
 * older run, or one the model wrote slightly wrong, must still draw. Missing
 * fields become a quieter row, never a crash and never a dropped fork.
 */
export interface ViewStep {
  kind?: string;
  name?: string;
  describe?: string;
  channelPreference?: string[];
  durationHours?: number;
  why?: string;
  eventType?: string;
  timeoutDays?: number;
  reason?: string;
  label?: string;
  outcomes?: string[];
  on?: { entity?: string; attribute?: string; operator?: string; value?: string };
  yes?: ViewStep[];
  no?: ViewStep[];
  arms?: { label?: string; pct?: number; steps?: ViewStep[] }[];
  entity?: string;
  attribute?: string;
  paths?: { label?: string; operator?: string; value?: string; steps?: ViewStep[] }[];
}

/** One row of the schematic. A fork carries its own paths, so forks nest. */
export type PreviewRow =
  | { kind: 'send'; channel: string; fallback?: string; text: string }
  | { kind: 'wait'; text: string }
  | { kind: 'await'; text: string }
  | { kind: 'exit'; text: string }
  | { kind: 'fork'; text: string; paths: PreviewPath[] }
  | { kind: 'step'; text: string };

export interface PreviewPath {
  label: string;
  /** Said when a path has no steps of its own, so a rest path is never blank. */
  note?: string;
  rows: PreviewRow[];
}

export interface JourneyPreview {
  name: string;
  /** Who comes in, in words. */
  entry: string;
  /** The holdout, when there is one. Never left to be inferred from a gap. */
  entryNote?: string;
  /** What ends the journey early, when a goal is set. */
  stops?: string;
  rows: PreviewRow[];
}

/** WHATSAPP -> WhatsApp. An enum is not a word a manager uses. */
const CHANNEL_WORDS: Record<string, string> = {
  WHATSAPP: 'WhatsApp',
  SMS: 'SMS',
  EMAIL: 'Email',
  RCS: 'RCS',
  IN_APP: 'In-app',
  PUSH: 'Push',
};
const channelWord = (c: string | undefined): string =>
  !c ? 'Message' : (CHANNEL_WORDS[c.toUpperCase()] ?? sentence(c));

/** CARD_ACTIVATED -> Card activated. */
function sentence(raw: string | undefined): string {
  const s = (raw ?? '').replace(/[._-]+/g, ' ').trim();
  if (!s) return '';
  const lower = s === s.toUpperCase() ? s.toLowerCase() : s;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** "48 hours" / "3 days", because 72 hours is not how anyone says it. */
function duration(hours: number | undefined): string {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return 'a moment';
  if (h % 24 === 0) {
    const d = h / 24;
    return `${d} day${d === 1 ? '' : 's'}`;
  }
  return `${h} hour${h === 1 ? '' : 's'}`;
}

const conditionWords = (cs: ViewCondition[] | undefined): string =>
  (cs ?? [])
    .filter((c) => c?.attribute)
    .map((c) => [sentence(c.attribute), (c.operator ?? '').toLowerCase(), c.value].filter(Boolean).join(' '))
    .join(', ');

/** Who comes in, from either entry kind. */
function entryWords(entry: BlueprintView['entry']): string {
  if (!entry) return 'Everyone eligible';
  if (entry.kind === 'event') {
    const e = entry as Extract<BlueprintView['entry'], { kind?: 'event' }>;
    const when = sentence(e.eventType) || sentence(e.eventCategory) || 'an event';
    const narrowed = conditionWords(e.conditions);
    return narrowed ? `When ${when.toLowerCase()} — ${narrowed}` : `When ${when.toLowerCase()}`;
  }
  const a = entry as Extract<BlueprintView['entry'], { kind?: 'audience' }>;
  const blocks = [
    { entity: a.entity, conditions: a.conditions },
    ...(a.groups ?? []),
  ]
    .map((g) => {
      const words = conditionWords(g.conditions);
      const who = sentence(g.entity);
      return words ? `${who ? `${who}: ` : ''}${words}` : who;
    })
    .filter(Boolean);
  return blocks.length ? blocks.join(' and ') : 'Everyone eligible';
}

/**
 * Every path of a fork is drawn, including the one with nothing in it.
 *
 * THE FAILURE THIS PREVENTS is the whole reason the preview exists: a
 * schematic that renders the treated arm and silently omits the rest path
 * shows the manager a campaign that reaches everyone when it does not. So an
 * empty path becomes a path with a note rather than no path.
 */
const pathOf = (label: string, steps: ViewStep[] | undefined): PreviewPath => {
  const rows = rowsFrom(steps);
  return rows.length ? { label, rows } : { label, note: 'No further messages on this path.', rows: [] };
};

function rowFrom(step: ViewStep): PreviewRow {
  switch (step.kind) {
    case 'send': {
      const [first, second] = step.channelPreference ?? [];
      return {
        kind: 'send',
        channel: channelWord(first),
        ...(second ? { fallback: channelWord(second) } : {}),
        text: step.describe?.trim() || step.name?.trim() || 'A message',
      };
    }
    case 'wait':
      return { kind: 'wait', text: `Wait ${duration(step.durationHours)}${step.why ? ` — ${step.why}` : ''}` };
    case 'waitForEvent':
      return {
        kind: 'await',
        text: `Wait up to ${step.timeoutDays ?? 0} day${step.timeoutDays === 1 ? '' : 's'} for ${
          sentence(step.eventType).toLowerCase() || 'the next event'
        }`,
      };
    case 'exit':
      return { kind: 'exit', text: step.reason?.trim() || 'Journey ends' };
    case 'condition':
      return {
        kind: 'fork',
        text: step.label?.trim() || questionFrom(step),
        paths: [pathOf('Yes', step.yes), pathOf('No', step.no)],
      };
    case 'experiment':
      return {
        kind: 'fork',
        text: step.label?.trim() || 'Split test',
        paths: (step.arms ?? []).map((a) =>
          pathOf([a.label?.trim() || 'Arm', typeof a.pct === 'number' ? `${a.pct}%` : ''].filter(Boolean).join(' · '), a.steps),
        ),
      };
    case 'branch':
      return {
        kind: 'fork',
        text: [step.label?.trim(), sentence(step.attribute)].filter(Boolean).join(' — ') || 'Split',
        paths: (step.paths ?? []).map((p) =>
          pathOf(
            [p.label?.trim() || 'Path', [p.operator?.toLowerCase(), p.value].filter(Boolean).join(' ')].filter(Boolean).join(' · '),
            p.steps,
          ),
        ),
      };
    default:
      return { kind: 'step', text: step.label?.trim() || step.name?.trim() || sentence(step.kind) || 'A step' };
  }
}

/** A condition with no label still has to read as a question. */
const questionFrom = (step: ViewStep): string => {
  if (step.on?.attribute) {
    return `${sentence(step.on.attribute)} ${(step.on.operator ?? 'is').toLowerCase()} ${step.on.value ?? ''}?`.trim();
  }
  if (step.outcomes?.length) return `Message ${step.outcomes.map((o) => sentence(o).toLowerCase()).join(' or ')}?`;
  return 'A condition';
};

const rowsFrom = (steps: ViewStep[] | undefined): PreviewRow[] => (steps ?? []).filter(Boolean).map(rowFrom);

/**
 * The proposal, as rows. Pure, so it can be tested without a browser.
 *
 * Returns null when there is nothing to draw, which is what keeps the caller
 * from rendering an empty frame with a heading over it.
 */
export function previewFromBlueprint(bp: unknown): JourneyPreview | null {
  if (!bp || typeof bp !== 'object') return null;
  const v = bp as BlueprintView;
  const rows = rowsFrom(v.steps);
  if (!rows.length) return null;
  const control = Number(v.controlPct);
  return {
    name: v.campaignName?.trim() || 'Proposed journey',
    entry: entryWords(v.entry),
    // A holdout is a real part of the design and must be stated. Silently
    // dropping the people who get nothing is how a comparison disappears.
    ...(Number.isFinite(control) && control > 0
      ? { entryNote: `${control}% are held back with no messages, as a comparison.` }
      : {}),
    ...(v.goal?.eventType ? { stops: `Stops as soon as ${sentence(v.goal.eventType).toLowerCase()}` } : {}),
    rows,
  };
}
