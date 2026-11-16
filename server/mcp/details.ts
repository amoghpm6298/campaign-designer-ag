// The full design of a campaign, for a caller's agent that wants to inspect it
// in depth: every setting, every bucket's rule and reasoning, and every step
// of every journey. Read straight from the files the canvas draws from, so it
// matches the canvas. Internal step ids are left out.
import type { CampaignContext, CampaignObject } from '../agent/types';
import { stripJourneyIds } from '../agent/stepIds';
import { listVersions } from '../campaignVersions';
import { bucketContext, currentEntries, noteText } from '../../src/designer/v2/contextView';

/** Where a note came from, in words. */
const SOURCE: Record<string, string> = { manager: 'you said', assumption: 'assumption', data: 'from data', agent: 'designer' };

export function campaignDetails(sessionId: string, c: CampaignObject, context: CampaignContext | null) {
  const views = bucketContext(context?.entries ?? []);
  const ee = c.everyoneElse;
  return {
    name: c.name ?? null,
    description: c.description ?? null,
    goal: c.goal,
    entry: c.entry,
    membership: c.membership,
    schedule: c.schedule ?? null,
    maxAttempts: c.maxAttempts ?? null,
    afterJourney: c.afterJourney ?? null,
    howBucketsWork: 'Each customer goes into the first bucket they match, in priority order.',
    buckets: [...c.buckets]
      .sort((a, b) => a.priority - b.priority)
      .map((b) => {
        const v = views[b.id] ?? {};
        return {
          id: b.id,
          name: b.name,
          priority: b.priority,
          rule: b.rule,
          holdoutPct: b.holdoutPct ?? 0,
          reasoning: {
            who: v.behaviour ?? null,
            whyStuck: v.thesis ?? null,
            evidence: v.evidence ?? 'hypothesis',
            evidenceNotes: v.evidenceNotes ?? null,
            metric: v.metric ?? null,
            size: typeof v.size === 'number' ? v.size : null,
          },
          journey: stripJourneyIds(b.journey) ?? [],
        };
      }),
    everyoneElse: ee ? { approach: ee.approach, journey: ee.approach === 'journey' ? stripJourneyIds(ee.journey) ?? [] : [], why: noteText(context?.entries ?? [], 'everyone_else') ?? null } : null,
    // The designer's notebook (context.json): the current version of every
    // note, with where it came from. Left out: sizing queries (internal SQL)
    // and older versions of notes.
    context: currentEntries(context?.entries ?? [])
      .filter((e) => e.kind !== 'sizing')
      .map((e) => ({
        kind: e.kind,
        topic: e.topic,
        ...(e.bucketId ? { bucketId: e.bucketId } : {}),
        text: e.text,
        source: SOURCE[e.source] ?? e.source,
        ...(typeof e.data?.level === 'string' ? { evidence: e.data.level } : {}),
        at: e.at,
      })),
    versions: listVersions(sessionId).map((v) => ({ version: v.n, at: v.at, source: v.source, summary: v.summary, request: v.request })),
  };
}
