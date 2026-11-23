// Data-anchored writing. Everything the agent writes carries inline sources,
// like Perplexity: "1.76 lifetime transactions vs 6.1-17.6 for the rest [Q4]".
// [Q4] is a query the agent ran (every query is filed with a short id and its
// rows), [M] the manager's answers, [O] the offer menu. The app builds the
// "Sources" footer from the markers, so it can never drift.
//
// Research behind the design: citations raise coverage but not precision (a
// citation is easy to attach and often doesn't support its sentence), so every
// marker is CHECKED by code, with arithmetic, never by another model: each
// number in a cited sentence must be in that source's rows (allowing the
// rounding, percentages and simple derivations people actually write).
//
//   errors   → a marker that points at nothing, or a number its source doesn't
//              contain. Sent back to the agent.
//   warnings → a data number with no marker. Logged only (for now).
import type { CampaignContext, CampaignObject } from './types';
import type { TenantConfig } from '../tenants';
import { bucketContext, currentEntries } from '../../src/designer/v2/contextView';
import { incentivesFor } from '../incentives';
import { campaignCost, type CostReport } from '../costModel';
import { getBankSettings } from '../bankSettings';

type Entry = CampaignContext['entries'][number];

export const MARKER = /\[(Q\d+|M|O)\]/g;

/** The rows a notebook entry holds: a query's own rows, or an analyst answer's workbook rows. */
export function rowsOf(data: unknown): unknown[] {
  const d = (data ?? {}) as { rows?: unknown[]; queries?: { rows?: unknown[] }[] };
  if (Array.isArray(d.rows)) return d.rows;
  return (d.queries ?? []).flatMap((x) => (Array.isArray(x.rows) ? x.rows : []));
}

/** The next free query id for this campaign: Q1, Q2, … (never reused). */
export function nextQid(context: CampaignContext | null): string {
  let max = 0;
  for (const e of context?.entries ?? []) {
    const m = /^Q(\d+)$/.exec(String((e.data as { qid?: unknown } | undefined)?.qid ?? ''));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Q${max + 1}`;
}

/** The notebook entry for a query id (the latest, if somehow filed twice). */
export function queryById(context: CampaignContext | null, qid: string): Entry | undefined {
  const all = (context?.entries ?? []).filter((e) => (e.data as { qid?: unknown } | undefined)?.qid === qid);
  return all[all.length - 1];
}

// --- numbers in text ------------------------------------------------------------

export interface WrittenNumber {
  raw: string;
  value: number;
  /** Decimal places written ("45.3" → 1). */
  decimals: number;
  /** For whole numbers: the rounding step the writer used ("6,600" → 100). */
  step: number;
  pct: boolean;
  approx: boolean;
}

const NUM = /(~|≈|about |around |roughly |nearly |approx\.? |almost )?(₹\s?)?(\d{1,3}(?:,\d{2,3})+|\d+)(\.\d+)?\s?(%|k\b|K\b|L\b|lakhs?\b|crores?\b|cr\b|Cr\b)?/gi;

/** Every number written in a sentence (markers and dates removed first). */
export function extractNumbers(sentence: string): WrittenNumber[] {
  const s = sentence
    .replace(MARKER, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ') // ISO dates
    .replace(/\b\d{1,2}\s?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi, ' '); // "1 Jan"
  const out: WrittenNumber[] = [];
  for (const m of s.matchAll(NUM)) {
    const [raw, approxWord, , intPart, frac, unit] = m;
    // Part of a word or id ("Q4", "x2", "v1"): skip.
    const before = s[(m.index ?? 0) - 1] ?? ' ';
    if (/[A-Za-z_]/.test(before) && !approxWord) continue;
    const digits = intPart.replace(/,/g, '');
    let value = Number(`${digits}${frac ?? ''}`);
    const decimals = frac ? frac.length - 1 : 0;
    const u = (unit ?? '').toLowerCase();
    let scale = 1;
    if (u === 'k') scale = 1e3;
    else if (u === 'l' || u.startsWith('lakh')) scale = 1e5;
    else if (u.startsWith('crore') || u === 'cr') scale = 1e7;
    value *= scale;
    const trailing = decimals ? 0 : (/(0+)$/.exec(digits)?.[1].length ?? 0);
    const step = decimals ? 0 : Math.max(1, 10 ** Math.min(trailing, digits.length - 1)) * scale;
    if (!Number.isFinite(value)) continue;
    // Years are not data claims.
    if (!frac && !unit && !intPart.includes(',') && value >= 1990 && value <= 2040) continue;
    out.push({ raw: raw.trim(), value, decimals, step, pct: u === '%', approx: !!approxWord || scale > 1 });
  }
  return out;
}

/** All numbers in a set of rows (numeric values and numeric strings). */
export function rowNumbers(rows: unknown[]): number[] {
  const out: number[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) out.push(Number(v));
  };
  for (const r of rows) {
    if (r && typeof r === 'object') for (const v of Object.values(r as Record<string, unknown>)) add(v);
    else add(r);
  }
  return out;
}

/** Does a written number equal this source value, at the precision it was written? */
function equalsAsWritten(n: WrittenNumber, v: number): boolean {
  const tries = n.pct ? [v, v * 100] : [v];
  for (const c of tries) {
    if (n.decimals) {
      const f = 10 ** n.decimals;
      if (Math.abs(Math.round(c * f) / f - n.value) < 1e-9) return true;
    } else if (Math.abs(Math.round(c) - n.value) < 1e-9) return true;
    // Rounded figures ("~6,600" for 6,634) count only when close: 1% plain, 5% with "about"/"~".
    const tol = n.approx ? 0.05 : n.step > 1 ? 0.01 : 0.005;
    if (c !== 0 && Math.abs(c - n.value) / Math.abs(c) <= tol) return true;
  }
  return false;
}

/** Does a written number match a source: directly, or as a simple derivation of two of its numbers? */
export function matchesSource(n: WrittenNumber, source: number[]): boolean {
  if (source.some((v) => equalsAsWritten(n, v))) return true;
  const base = [...new Set(source)].slice(0, 150);
  for (const a of base)
    for (const b of base) {
      if (a === b) continue;
      // Magnitudes: people write "28% lower", not "-28%".
      const derived = [Math.abs(a - b), ...(b !== 0 ? [a / b, (a / b) * 100, Math.abs(((a - b) / b) * 100)] : [])];
      if (derived.some((d) => Number.isFinite(d) && equalsAsWritten({ ...n, pct: false }, d))) return true;
    }
  return false;
}

/** Sentences of a text; a marker written just after a full stop belongs to the sentence before it. */
export function sentences(text: string): string[] {
  const parts = (text ?? '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (out.length && /^(\[(?:Q\d+|M|O)\]\s*)+\.?$/.test(p)) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out;
}

// --- the check -----------------------------------------------------------------

export interface WrittenText {
  where: string;
  text: string;
}

/** Everything the agent wrote: its notes and bucket notes, and the reasoning on every step. */
export function agentTexts(campaign: CampaignObject, context: CampaignContext | null): WrittenText[] {
  const out: WrittenText[] = [];
  const names = new Map(campaign.buckets.map((b) => [b.id, b.name]));
  for (const e of currentEntries(context?.entries ?? [])) {
    if (!['note', 'bucket', 'research', 'brief'].includes(e.kind)) continue;
    if (e.source && !['agent', 'assumption'].includes(e.source)) continue; // app, data, manager
    if ((e.data as { qid?: unknown } | undefined)?.qid) continue; // a query record itself
    if (!e.text?.trim()) continue;
    const owner = e.bucketId ? `Bucket "${names.get(e.bucketId) ?? e.bucketId}" › ` : '';
    out.push({ where: `${owner}${e.kind} "${e.topic}"`, text: e.text });
  }
  const walk = (list: unknown, owner: string) => {
    for (const s of (Array.isArray(list) ? list : []) as Record<string, unknown>[]) {
      const label = `${owner} › step "${String(s.name ?? s.label ?? s.kind ?? '')}"`;
      for (const k of ['rationale', 'hypothesis', 'successMetric']) if (typeof s[k] === 'string' && (s[k] as string).trim()) out.push({ where: `${label} ${k}`, text: s[k] as string });
      const fu = s.funnel as Record<string, { why?: unknown }> | undefined;
      for (const k of ['opens', 'converts']) if (typeof fu?.[k]?.why === 'string') out.push({ where: `${label} ${k} estimate`, text: fu[k].why as string });
      const idea = s.splitIdea as { hypothesis?: unknown } | undefined;
      if (typeof idea?.hypothesis === 'string') out.push({ where: `${label} split idea`, text: idea.hypothesis });
      for (const k of ['yes', 'no', 'otherwise']) walk(s[k], owner);
      for (const k of ['paths', 'arms']) for (const p of (Array.isArray(s[k]) ? s[k] : []) as Record<string, unknown>[]) walk(p.steps, owner);
    }
  };
  for (const b of campaign.buckets) walk(b.journey, `Bucket "${b.name}"`);
  if (campaign.everyoneElse?.approach === 'journey') walk(campaign.everyoneElse.journey, 'Everyone else');
  return out;
}

/** Numbers that are facts of the campaign itself, never data claims needing a source. */
export function systemNumbers(campaign: CampaignObject, context: CampaignContext | null, tenant: Pick<TenantConfig, 'tenantId' | 'incentives' | 'warehouse'> | null, knownCost?: CostReport): number[] {
  const out: number[] = [];
  const grab = (v: unknown) => {
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    else if (typeof v === 'string') for (const n of extractNumbers(v)) out.push(n.value);
    else if (Array.isArray(v)) v.forEach(grab);
    else if (v && typeof v === 'object') Object.values(v).forEach(grab);
  };
  // The campaign's own settings and rules (bucket bounds like "31-60 days" sit within ±1 of a rule value).
  grab({ rules: campaign.buckets.map((b) => b.rule), entry: campaign.entry, budgetCap: campaign.budgetCap, maxAttempts: campaign.maxAttempts, afterJourney: campaign.afterJourney });
  for (const b of campaign.buckets) if (typeof b.holdoutPct === 'number') out.push(b.holdoutPct);
  const waits = (list: unknown) => {
    for (const s of (Array.isArray(list) ? list : []) as Record<string, unknown>[]) {
      if (typeof s.durationHours === 'number') out.push(s.durationHours, s.durationHours / 24);
      for (const k of ['yes', 'no', 'otherwise']) waits(s[k]);
      for (const k of ['paths', 'arms']) for (const p of (Array.isArray(s[k]) ? s[k] : []) as Record<string, unknown>[]) {
        if (typeof p.weight === 'number') out.push(p.weight as number);
        waits(p.steps);
      }
      const fu = s.funnel as Record<string, Record<string, unknown>> | undefined;
      for (const k of ['opens', 'converts']) if (typeof fu?.[k]?.rate === 'number') out.push(fu[k].rate as number);
    }
  };
  campaign.buckets.forEach((b) => waits(b.journey));
  // Bucket sizes, the cost calculator's figures, the offer menu, and the manager's answers.
  for (const v of Object.values(bucketContext(context?.entries ?? []))) if (typeof v.size === 'number') out.push(v.size);
  try {
    const cost = knownCost ?? campaignCost(campaign, context, tenant);
    grab(cost.total);
    for (const l of cost.lines) grab([l.customers, l.qualified, l.avgReward, l.maxPerCustomer, l.expected, l.max, ...l.steps.map((x) => x.count)]);
    for (const b of cost.buckets) grab([b.expected, b.max]);
    // The funnel the build reports: who reaches, opens and converts on each message.
    for (const m of cost.messages) grab([m.arrivingCount, m.delivered, m.opened, m.converted]);
    grab(Object.values(getBankSettings(tenant?.tenantId ?? '').deliveryRates));
    for (const r of cost.routes) if (typeof r.size === 'number') out.push(r.size);
  } catch {
    /* no cost: nothing to add */
  }
  for (const n of offerNumbers(tenant)) out.push(n);
  for (const n of managerNumbers(context)) out.push(n);
  return out.flatMap((v) => [v, v - 1, v + 1]);
}

function offerNumbers(tenant: Pick<TenantConfig, 'tenantId' | 'incentives' | 'warehouse'> | null): number[] {
  const out: number[] = [];
  const grab = (v: unknown): void => {
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    else if (typeof v === 'string') for (const n of extractNumbers(v)) out.push(n.value);
    else if (Array.isArray(v)) v.forEach(grab);
    else if (v && typeof v === 'object') Object.values(v).forEach(grab);
  };
  try {
    grab(incentivesFor(tenant));
  } catch {
    /* no menu */
  }
  return out;
}

/** [M]: everything the manager said: the opening brief and chat messages, and their answers. */
function managerNumbers(context: CampaignContext | null, said: string[] = []): number[] {
  return [...currentEntries(context?.entries ?? [], { kind: 'answer' }).map((e) => `${e.topic} ${e.text}`), ...said].flatMap((t) => extractNumbers(t).map((n) => n.value));
}

export interface CitationReport {
  errors: string[];
  warnings: string[];
  stats: { texts: number; cited: number; matched: number; mismatched: number; uncited: number; unknownSources: number };
}

const short = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Checks every marker and every number in everything the agent wrote. */
export function citationProblems(
  campaign: CampaignObject,
  context: CampaignContext | null,
  tenant: Pick<TenantConfig, 'tenantId' | 'incentives' | 'warehouse'> | null,
  hasData = !!tenant?.warehouse,
  managerSaid: string[] = [],
  knownCost?: CostReport,
): CitationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const stats = { texts: 0, cited: 0, matched: 0, mismatched: 0, uncited: 0, unknownSources: 0 };
  const system = [...systemNumbers(campaign, context, tenant, knownCost), ...managerNumbers(null, managerSaid)];
  const isSystem = (n: WrittenNumber) => (!n.decimals && !n.pct && n.value <= 10) || system.some((v) => Math.abs(v - n.value) < 1e-9) || matchesSourceDirect(n, system);
  const sourceCache = new Map<string, number[] | null>();
  const sourceNumbers = (id: string): number[] | null => {
    if (sourceCache.has(id)) return sourceCache.get(id)!;
    let nums: number[] | null = null;
    if (id === 'M') nums = managerNumbers(context, managerSaid);
    else if (id === 'O') nums = offerNumbers(tenant);
    else {
      const e = queryById(context, id);
      const rows = e ? rowsOf(e.data) : [];
      nums = e && rows.length ? rowNumbers(rows) : null;
    }
    sourceCache.set(id, nums);
    return nums;
  };
  for (const t of agentTexts(campaign, context)) {
    stats.texts++;
    for (const sentence of sentences(t.text)) {
      const marks = [...sentence.matchAll(MARKER)].map((m) => m[1]);
      const numbers = extractNumbers(sentence);
      if (marks.length) {
        const pools: number[] = [];
        for (const id of [...new Set(marks)]) {
          const nums = sourceNumbers(id);
          if (nums == null) {
            stats.unknownSources++;
            errors.push(`${t.where}: cites [${id}], but ${id.startsWith('Q') ? `there is no query ${id} with results in the notebook` : 'that source has no figures'}. Cite the query the figure came from. Sentence: "${short(sentence)}"`);
          } else pools.push(...nums);
        }
        if (!pools.length) continue;
        for (const n of numbers) {
          stats.cited++;
          if (matchesSource(n, pools) || isSystem(n)) stats.matched++;
          else {
            stats.mismatched++;
            errors.push(`${t.where}: "${n.raw}" is not in ${marks.map((m) => `[${m}]`).join(' ')} (or derivable from it). Its figures include: ${short(pools.slice(0, 12).map((v) => +v.toFixed(2)).join(', '), 120)}. Correct the number or cite the right query. Sentence: "${short(sentence)}"`);
          }
        }
      } else if (hasData) {
        for (const n of numbers) {
          if (isSystem(n)) continue;
          stats.uncited++;
          if (warnings.length < 25) warnings.push(`${t.where}: "${n.raw}" has no source. Sentence: "${short(sentence, 120)}"`);
        }
      }
    }
  }
  return { errors: errors.slice(0, 20), warnings, stats };
}

function matchesSourceDirect(n: WrittenNumber, source: number[]): boolean {
  return source.some((v) => equalsAsWritten(n, v));
}
