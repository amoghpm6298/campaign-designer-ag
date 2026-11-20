// Each bucket's insight, checked twice before a campaign counts as finished.
//
// Level 2, "why stuck": what holds this group back, as the data shows it (or,
// without data, as the manager said or as a stated hypothesis). Level 3, "so
// we": what that finding changed in the design.
//
// 1. CODE (insightProblems): both notes exist; a data-bank "why stuck" cites at
//    least one query that is really in the notebook; any step "so we" names is
//    in that bucket's journey. Code cannot judge quality, only that the pieces
//    are real and connected.
// 2. A GRADER (gradeInsights): a fast model reads each bucket's two notes and
//    the ROWS of the queries they cite (never the agent's reasoning) and says
//    whether the finding is backed by those rows, non-obvious, and followed
//    through. A failed bucket sends the agent back (at most twice); after that
//    the grade is shown on the bucket card.
//
// Every check and grade is logged, per campaign (in the notebook) and across
// campaigns (data/logs/insight-checks.jsonl), so the thresholds and the prompt
// can be tuned from what actually happens.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CampaignContext, CampaignObject } from './types';
import type { BpStep } from '../blueprint';
import { bucketContext, currentEntries } from '../../src/designer/v2/contextView';
import { callClaude } from '../anthropic';
import { queryById, rowsOf } from './citations';

/** The grader's model: fast and cheap, for this one check only (the agent itself stays on Sonnet). */
export const GRADER_MODEL = 'claude-haiku-5-5';
/**
 * The per-bucket reviewer is OFF unless INSIGHT_REVIEW=on (2026-11-20). Bucket-by-bucket grading
 * proved risky: inconsistent verdicts, pressure to manufacture differences, and send-backs that
 * cost many rounds. The plan is one review of the whole campaign after it is built. The code
 * check (notes exist and cite real query results) stays on.
 */
export const insightReviewOn = () => (process.env.INSIGHT_REVIEW ?? '').toLowerCase() === 'on';

/** Send-backs per turn for each kind of check. */
export const MAX_INSIGHT_SENDBACKS = 2;

const norm = (s: string) => s.toLowerCase().replace(/^(query|ask):\s*/, '').replace(/\s+/g, ' ').trim();


/** The notebook entry a citation points at: exact topic, or the same query purpose (topics are cut at 80 characters). Query results first. */
function findQuery(context: CampaignContext | null, cite: string) {
  // A query id ("Q7" or "[Q7]") is exact.
  const id = /^\[?(Q\d+)\]?$/.exec(cite.trim());
  if (id) return queryById(context, id[1]);
  const want = norm(cite);
  if (!want) return undefined;
  const matches = currentEntries(context?.entries ?? [], { kind: 'research' }).filter((e) => {
    const have = norm(e.topic);
    return have === want || (have.length >= 20 && want.startsWith(have)) || (want.length >= 20 && have.startsWith(want));
  });
  return matches.find((e) => rowsOf(e.data).length) ?? matches[0];
}

/** The query record whose topic shares the most words with a mistyped citation (a paraphrase from memory). */
function closestQuery(context: CampaignContext | null, cite: string): string | null {
  const words = (s: string) => new Set(norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const want = words(cite);
  let best: { topic: string; score: number } | null = null;
  for (const e of currentEntries(context?.entries ?? [], { kind: 'research' })) {
    if (!rowsOf(e.data).length) continue;
    const have = words(e.topic);
    const score = [...want].filter((w) => have.has(w)).length / Math.max(1, Math.min(want.size, have.size));
    if (!best || score > best.score) best = { topic: e.topic, score };
  }
  return best && best.score >= 0.4 ? best.topic : null;
}

/** Every step's id and name in a journey, lower-cased. */
function stepNames(journey: BpStep[] | null | undefined): Set<string> {
  const out = new Set<string>();
  const walk = (list: unknown) => {
    for (const s of (Array.isArray(list) ? list : []) as Record<string, unknown>[]) {
      for (const k of ['id', 'name', 'label']) if (typeof s[k] === 'string' && s[k]) out.add(String(s[k]).toLowerCase().trim());
      for (const k of ['yes', 'no', 'otherwise']) walk(s[k]);
      for (const k of ['paths', 'arms']) for (const p of (Array.isArray(s[k]) ? s[k] : []) as Record<string, unknown>[]) walk(p.steps);
    }
  };
  walk(journey);
  return out;
}

/** Code check: what is missing or not connected, per bucket. Empty when every bucket is complete. */
export function insightProblems(campaign: CampaignObject, context: CampaignContext | null, hasData: boolean): string[] {
  const views = bucketContext(context?.entries ?? []);
  const out: string[] = [];
  for (const b of campaign.buckets) {
    const v = views[b.id] ?? {};
    const name = `Bucket "${b.name}"`;
    if (!v.whyStuck || v.whyStuck.trim().length < 40)
      out.push(`${name}: no "why stuck" note (add_context kind "bucket", topic "why stuck"): what holds THIS group back, with its numbers.`);
    else if (hasData) {
      const cites = v.whyStuckQueries ?? [];
      if (!cites.length) out.push(`${name}: its "why stuck" cites no query. Give data {queries: [the notebook topics of the queries that show it, e.g. "query: <purpose>"]}; run one if you have none.`);
      else {
        const missing = cites.filter((c) => !findQuery(context, c));
        const noRows = cites.filter((c) => {
          const q = findQuery(context, c);
          return q && !rowsOf(q.data).length;
        });
        if (missing.length) {
          const hints = missing.map((m) => closestQuery(context, m)).filter(Boolean);
          out.push(
            `${name}: "why stuck" cites ${missing.map((m) => `"${m}"`).join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not in the notebook. Cite queries you actually ran, by their exact topic${hints.length ? `; did you mean ${[...new Set(hints)].map((h) => `"${h}"`).join(' or ')}?` : ' ("query: <purpose>").'}`,
          );
        }
        if (noRows.length)
          out.push(`${name}: "why stuck" cites ${noRows.map((m) => `"${m}"`).join(', ')}, which ${noRows.length === 1 ? 'is a written note' : 'are written notes'}, not ${noRows.length === 1 ? 'a query result' : 'query results'}. Cite the query records the numbers came from (topic "query: <purpose>", with rows), so they can be checked.`);
      }
    } else if (!v.whyStuckBasis || !['manager', 'hypothesis'].includes(v.whyStuckBasis)) {
      out.push(`${name}: its "why stuck" must say what it rests on: data {basis: "manager"} if the manager said it, {basis: "hypothesis"} if it is your judgement.`);
    }
    if (!v.soWe || v.soWe.trim().length < 20) out.push(`${name}: no "so we" note (topic "so we"): what that finding changed in this bucket's design, or that the data did not separate this group so the lever is a hypothesis to test.`);
    else if (v.soWeSteps?.length) {
      const names = stepNames(b.journey as BpStep[] | null);
      // Tolerant of a paraphrase like "X experiment" for a step named "X"; still catches a renamed step.
      const known = [...names];
      const gone = v.soWeSteps.filter((s) => {
        const w = s.toLowerCase().trim();
        return !names.has(w) && !known.some((n) => n.length >= 8 && (w.startsWith(n) || n.startsWith(w)));
      });
      if (gone.length) out.push(`${name}: "so we" names ${gone.map((g) => `"${g}"`).join(', ')}, which ${gone.length === 1 ? 'is' : 'are'} not a step in its journey. Name steps as they are (their name), or leave steps out.`);
    }
  }
  return out;
}

export interface BucketGrade {
  bucketId: string;
  bucketName: string;
  pass: boolean;
  backed: 'yes' | 'partly' | 'no' | 'n/a';
  nonObvious: 1 | 2 | 3;
  followsThrough: boolean;
  reason: string;
}

export interface GradeRun {
  grades: BucketGrade[];
  model: string;
  ms: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: string;
}

const GRADER_SYSTEM = `You review the reasoning behind a bank's card campaign before it runs. For each customer bucket you get: who is in it (its rule), its "why stuck" finding (what holds this group back), its "so we" (what that changed in the design), and the actual rows of the data queries the finding cites. You do NOT see how the designer reasoned; judge only the claim against the evidence.

For each bucket decide:
- backed: "yes" if the cited rows show the finding, with matching numbers and a fair reading; "partly" if the numbers are there but the reading goes further than the rows; "no" if the rows don't show it or the numbers don't match. A pattern that is the SAME across all groups (e.g. every group logs in about every 45 days) is NOT a finding about this group: mark it "no". Use "n/a" only when the bucket has no data (its basis is the manager or a hypothesis) and the note says so honestly.
- nonObvious: 1 = generic, true of almost any lapsed group ("they need a reminder", "they may be busy", "they are less engaged"); 2 = specific to this group and these numbers; 3 = a genuinely non-obvious angle a seasoned marketer would not have guessed.
- followsThrough: true if "so we" is a design choice that follows from THIS finding (different offer, timing, channel, message, split, or an honest "the data did not separate them, so we test the lever"); false if it is generic or would be the same without the finding.
- pass: backed is "yes" (or "n/a" honestly stated) AND nonObvious >= 2 AND followsThrough.
- reason: one plain sentence the designer can act on (what is wrong and what to look for instead). If it passes, say in a few words why.

Also compare the buckets: if two buckets give essentially the same finding, the weaker one does not pass.

Reply with JSON only: {"grades":[{"bucketId":"…","backed":"yes|partly|no|n/a","nonObvious":1|2|3,"followsThrough":true|false,"pass":true|false,"reason":"…"}]}`;

/** What the grader is shown: each bucket's rule, notes and the rows of the cited queries (capped). */
export function graderInput(campaign: CampaignObject, context: CampaignContext | null, only?: string[]): string {
  const views = bucketContext(context?.entries ?? []);
  const blocks = [...campaign.buckets]
    .sort((a, b) => a.priority - b.priority)
    .map((b) => {
      const v = views[b.id] ?? {};
      const evidence = (v.whyStuckQueries ?? []).map((c) => {
        const q = findQuery(context, c);
        const d = (q?.data ?? {}) as { purpose?: string };
        const rows = rowsOf(q?.data);
        return `  - ${q?.topic ?? c}${d.purpose ? ` (purpose: ${d.purpose})` : ''}\n    rows: ${JSON.stringify(rows.slice(0, 20))}${rows.length > 20 ? ` … (${rows.length} rows)` : ''}`;
      });
      return [
        `BUCKET ${b.id} "${b.name}" (checked ${b.priority}${typeof v.size === 'number' ? `, ${v.size} customers` : ''})${only && !only.includes(b.id) ? ' [already reviewed: for comparison only, do not grade]' : ''}`,
        `rule: ${JSON.stringify(b.rule).slice(0, 600)}`,
        `why stuck: ${v.whyStuck ?? '(missing)'}${v.whyStuckBasis && v.whyStuckBasis !== 'data' ? ` [basis: ${v.whyStuckBasis}]` : ''}`,
        `so we: ${v.soWe ?? '(missing)'}`,
        evidence.length ? `cited evidence:\n${evidence.join('\n')}` : 'cited evidence: none',
      ].join('\n');
    });
  return blocks.join('\n\n');
}

type GraderCall = (system: string, text: string) => Promise<{ text: string; usage?: { input_tokens?: number; output_tokens?: number } }>;
/** The reply's shape, enforced by the API (structured outputs): the reply can't be malformed or cut off mid-JSON. */
const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    grades: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          bucketId: { type: 'string' },
          backed: { type: 'string', enum: ['yes', 'partly', 'no', 'n/a'] },
          nonObvious: { type: 'integer', enum: [1, 2, 3] },
          followsThrough: { type: 'boolean' },
          pass: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['bucketId', 'backed', 'nonObvious', 'followsThrough', 'pass', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['grades'],
  additionalProperties: false,
};
// Low effort: a fast check, and thinking counts against max_tokens (a long think once cut the reply off).
const defaultCall: GraderCall = async (system, text) => {
  const r = await callClaude({ system, messages: [{ role: 'user', content: text }], maxTokens: 8_000, timeoutMs: 60_000, model: GRADER_MODEL, outputConfig: { effort: 'low', format: { type: 'json_schema', schema: GRADE_SCHEMA } } });
  if (r.stopReason === 'max_tokens') throw new Error('The review ran out of room before finishing.');
  return { text: r.text, usage: r.usage };
};

/** Grades every bucket in one call. Never throws: on failure it returns an error and no grades (the turn goes on). */
export async function gradeInsights(campaign: CampaignObject, context: CampaignContext | null, call: GraderCall = defaultCall, only?: string[]): Promise<GradeRun> {
  const toGrade = only?.length ? campaign.buckets.filter((b) => only.includes(b.id)) : campaign.buckets;
  const t0 = Date.now();
  let attempt = 0;
  for (;;) {
  try {
    attempt++;
    const r = await call(GRADER_SYSTEM, graderInput(campaign, context, only?.length ? only : undefined));
    const json = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1)) as { grades?: Record<string, unknown>[] };
    const byId = new Map(toGrade.map((b) => [b.id, b.name]));
    const grades: BucketGrade[] = (json.grades ?? [])
      .filter((g) => byId.has(String(g.bucketId)))
      .map((g) => {
        const backed = (['yes', 'partly', 'no', 'n/a'].includes(String(g.backed)) ? g.backed : 'no') as BucketGrade['backed'];
        const nonObvious = (Math.min(3, Math.max(1, Number(g.nonObvious) || 1)) as 1 | 2 | 3);
        const followsThrough = g.followsThrough === true;
        // Pass is recomputed from the parts, so the grader can't pass a bucket its own scores fail.
        const pass = (backed === 'yes' || backed === 'n/a') && nonObvious >= 2 && followsThrough;
        return { bucketId: String(g.bucketId), bucketName: byId.get(String(g.bucketId))!, pass, backed, nonObvious, followsThrough, reason: String(g.reason ?? '').trim() || (pass ? 'Passes.' : 'Not explained.') };
      });
    const missing = toGrade.filter((b) => !grades.some((g) => g.bucketId === b.id));
    if (missing.length) return { grades, model: GRADER_MODEL, ms: Date.now() - t0, usage: r.usage, error: `No grade for ${missing.map((b) => b.name).join(', ')}.` };
    return { grades, model: GRADER_MODEL, ms: Date.now() - t0, usage: r.usage };
  } catch (e) {
    // One retry: a network blip or a bad reply should not leave a campaign unreviewed.
    if (attempt < 2) continue;
    return { grades: [], model: GRADER_MODEL, ms: Date.now() - t0, error: `${(e as Error).message} (after ${attempt} tries)` };
  }
  }
}

/** The send-back message for failed buckets. */
export function graderSendBack(grades: BucketGrade[]): string {
  const failed = grades.filter((g) => !g.pass);
  return `AUTOMATIC REVIEW (end of turn): an independent reviewer read each bucket's "why stuck" and "so we" against the rows of the queries they cite. These did not pass:\n${failed
    .map((g) => `- "${g.bucketName}" (backed: ${g.backed}, non-obvious: ${g.nonObvious}/3, follows through: ${g.followsThrough ? 'yes' : 'no'}): ${g.reason}`)
    .join('\n')}\nInvestigate with the data and rewrite those notes (add_context kind "bucket", topics "why stuck" and "so we"); if the finding changes the design, change the journey and rebuild. If the data genuinely does not separate a group, say exactly that in "why stuck", cite the query that shows it, and make "so we" a test of the lever. Do not touch the buckets that passed.`;
}

/** The cross-campaign log: one JSON line per check or grade. Fails silently: logging never breaks a turn. */
export function logInsightEvent(event: Record<string, unknown>, dir?: string): void {
  try {
    const base = dir ?? process.env.INSIGHT_LOG_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../data/logs');
    mkdirSync(base, { recursive: true });
    appendFileSync(resolve(base, 'insight-checks.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  } catch {
    /* never break a turn over a log line */
  }
}
