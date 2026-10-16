// Template selection. Previously the planner took the first template whose
// channelType matched — which picked "Festive Offer Email" for an EMI
// consent ask: right channel, wrong message entirely.
//
// This scores real template CONTENT (name + the actual message/body copy in
// COMMS_TEMPLATES) against what the step is trying to say. It never invents
// a template id: when nothing suitable exists it returns a PROPOSAL the
// caller must handle explicitly.
import { COMMS_TEMPLATES, type Channel, type CommsTemplate } from '../src/data/sharedConstants';

/** What this particular message needs to say, and where it sits. */
export interface TemplateNeed {
  /** Short objective keywords, e.g. ['emi', 'convert']. */
  objective: string[];
  /** Where in the journey this message sits. */
  stage: 'first-touch' | 'reminder' | 'outcome';
  /** Plain description used in a proposal when nothing fits. */
  describe: string;
}

export interface ExistingTemplateChoice {
  kind: 'existing';
  template: CommsTemplate;
  channel: Channel;
  score: number;
  reason: string;
  /** True when the template matches the objective but NOT the journey stage —
   *  e.g. an offer template reused as a reminder, so the copy would read
   *  identically. Usable, but worth a reviewer's attention. */
  weakStageFit: boolean;
  /** A template elsewhere that does fit the stage, if one exists. Reported,
   *  not auto-selected: switching channel would override the bank's stated
   *  cost preference, which is not this function's call to make. */
  betterStageFitElsewhere?: { id: string; name: string; channel: Channel };
}

export interface TemplateProposal {
  kind: 'proposal';
  channel: Channel;
  reason: string;
  messagingDirection: string;
  sampleCopy: string;
  cta: string;
  personalisationFields: string[];
  /** Deliberately explicit: there is no id, and one must not be invented. */
  templateId: null;
}

export type TemplateChoice = ExistingTemplateChoice | TemplateProposal;

const text = (t: CommsTemplate) => `${t.name} ${t.message ?? ''} ${t.body ?? ''}`.toLowerCase();

/** Signals that a template belongs to a DIFFERENT journey than the one asked
 *  for. Presence of these is what makes a same-channel template unsuitable
 *  rather than merely weaker.
 *
 *  Judged RELATIVE to the request, not absolutely. "activation" marks a
 *  template as off-topic for an EMI ask, but it is exactly the point of an
 *  activation ask — an absolute list disqualified every real activation
 *  template for an activation campaign, which a live run exposed the moment
 *  a second objective was tried. A signal only disqualifies when the caller
 *  did not ask for it. */
const OFF_TOPIC: { signal: string; meaning: string }[] = [
  { signal: 'activate', meaning: 'card activation' },
  { signal: 'activation', meaning: 'card activation' },
  { signal: 'pin', meaning: 'PIN setup' },
  { signal: 'festive', meaning: 'festive marketing' },
];

const STAGE_SIGNALS: Record<TemplateNeed['stage'], string[]> = {
  'first-touch': ['consent', 'offer', 'convert', 'eligible'],
  reminder: ['reminder', 'still deciding', 'limited time'],
  outcome: ['outcome', 'update', 'status', 'notification'],
};

export interface Scored {
  template: CommsTemplate;
  score: number;
  matched: string[];
  offTopic: string[];
}

/** Scores every template on `channel` against the need. Exported so tests
 *  (and a future reviewer) can see why one beat another. */
export function scoreTemplates(need: TemplateNeed, channel: Channel): Scored[] {
  return COMMS_TEMPLATES.filter((t) => t.channelType === channel)
    .map((t) => {
      const body = text(t);
      const matched: string[] = [];
      let score = 0;

      for (const kw of need.objective) {
        if (body.includes(kw.toLowerCase())) {
          score += 2; // objective match carries the most weight
          matched.push(`objective:${kw}`);
        }
      }
      for (const kw of STAGE_SIGNALS[need.stage]) {
        if (body.includes(kw)) {
          score += 1;
          matched.push(`stage:${kw}`);
        }
      }

      // An off-topic signal doesn't just lower the score — it disqualifies,
      // because a template about a different journey is wrong no matter how
      // many other words happen to line up. Unless the caller asked for that
      // very thing, in which case it is the topic, not an off-topic one.
      const asked = need.objective.map((k) => k.toLowerCase());
      const offTopic = OFF_TOPIC.filter(
        (o) => body.includes(o.signal) && !asked.some((k) => k.includes(o.signal) || o.signal.includes(k)),
      ).map((o) => o.meaning);
      if (offTopic.length) score = -1;

      return { template: t, score, matched, offTopic: [...new Set(offTopic)] };
    })
    .sort((a, b) => b.score - a.score);
}

/** A template is only usable if it matches the objective at all. A stage-only
 *  match (e.g. the word "offer" in a festive email) is not enough. */
function isSuitable(s: Scored): boolean {
  return s.score > 0 && s.matched.some((m) => m.startsWith('objective:'));
}

/** Personalisation tokens actually used by existing templates — reused so a
 *  proposal follows the real convention instead of inventing variables. */
export function knownPersonalisationFields(): string[] {
  const found = new Set<string>();
  for (const t of COMMS_TEMPLATES) {
    for (const m of `${t.message ?? ''} ${t.body ?? ''}`.matchAll(/\$\{(\w+)\}/g)) found.add(m[1]);
  }
  return [...found].sort();
}

/**
 * Picks the best (channel, template) pair.
 *
 * `channelsByPreference` is the caller's preferred order — typically cheapest
 * first. Suitability can override that order, because sending the wrong
 * message on a cheaper channel is not a saving. When it does, the reason says
 * so, so the trade-off is visible rather than silent.
 */
export function selectTemplate(need: TemplateNeed, channelsByPreference: Channel[]): TemplateChoice {
  const considered: string[] = [];

  for (const channel of channelsByPreference) {
    const ranked = scoreTemplates(need, channel);
    const best = ranked.find(isSuitable);
    if (best) {
      const weakStageFit = !best.matched.some((m) => m.startsWith('stage:'));
      let betterStageFitElsewhere: ExistingTemplateChoice['betterStageFitElsewhere'];
      if (weakStageFit) {
        for (const other of channelsByPreference) {
          if (other === channel) continue;
          const alt = scoreTemplates(need, other).find(
            (r) => isSuitable(r) && r.matched.some((m) => m.startsWith('stage:')),
          );
          if (alt) {
            betterStageFitElsewhere = { id: alt.template.id, name: alt.template.name, channel: other };
            break;
          }
        }
      }
      const demoted = channelsByPreference.slice(0, channelsByPreference.indexOf(channel));
      const tradeOff = demoted.length
        ? ` Preferred channel${demoted.length > 1 ? 's' : ''} ${demoted.join(', ')} skipped: no template there matches this message (${considered.join('; ')}).`
        : '';
      const stageNote = weakStageFit
        ? ` Matches the objective but not the "${need.stage}" stage, so its copy is not stage-specific.` +
          (betterStageFitElsewhere
            ? ` ${betterStageFitElsewhere.name} (${betterStageFitElsewhere.id}) on ${betterStageFitElsewhere.channel} would fit the stage better, at that channel's cost.`
            : ' No stage-specific alternative exists on any available channel.')
        : '';
      return {
        kind: 'existing',
        template: best.template,
        channel,
        score: best.score,
        weakStageFit,
        betterStageFitElsewhere,
        reason:
          `"${best.template.name}" (${best.template.id}) matches on ${best.matched.join(', ')}.` +
          (ranked.length > 1 ? ` Beat ${ranked.length - 1} other ${channel} template(s).` : '') +
          tradeOff +
          stageNote,
      };
    }
    const why = ranked.length
      ? ranked
          .map((r) => `${r.template.id} ${r.offTopic.length ? `is about ${r.offTopic.join('/')}` : 'has no objective match'}`)
          .join(', ')
      : 'no templates exist for this channel';
    considered.push(`${channel}: ${why}`);
  }

  // Nothing suitable anywhere. Propose, never fabricate.
  return {
    ...proposeMessaging(need, channelsByPreference[0]),
    reason: `No existing template is suitable. Considered — ${considered.join(' | ')}.`,
  };
}

/**
 * Writes a messaging proposal for a step, with no template library involved.
 *
 * Used both when a search found nothing AND when the bank's catalogue is not
 * reachable at all — the agent can still say what the message should do.
 * This is a PROPOSAL: it is not registered with the bank and must never be
 * presented as an approved template.
 */
export function proposeMessaging(need: TemplateNeed, channel: Channel): TemplateProposal {
  const cta =
    need.stage === 'reminder' ? 'Complete now' : need.stage === 'outcome' ? 'View details' : 'Get started';
  return {
    kind: 'proposal',
    channel,
    templateId: null,
    reason: 'Proposed by the agent. Not a bank-registered template.',
    messagingDirection: need.describe,
    sampleCopy: `Hi \${customerFirstName}, ${need.describe.replace(/^./, (c) => c.toLowerCase())} \${shortUrl}`,
    cta,
    personalisationFields: knownPersonalisationFields().filter((f) =>
      ['customerFirstName', 'shortUrl'].includes(f),
    ),
  };
}
