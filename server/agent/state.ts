// Pure state transitions for the agent: flags, timeline, plan file (brief,
// campaign shell, buckets), questions and sign-offs. No I/O, no model calls,
// so every rule here is unit-testable.

import type { BpAudienceGroup, BpStep } from '../blueprint';
import {
  AGENT_FLAGS,
  FLAG_LABELS,
  FLAG_ORDER,
  type AgentQuestion,
  type AgentState,
  type AnswerType,
  type Bucket,
  type BriefFinding,
  type CampaignShell,
  type Evidence,
  type FlagName,
  type Flags,
  type TimelineActor,
  type TimelineEntry,
  type TimelineType,
} from './types';

export const MAX_QUESTIONS_PER_CALL = 12;
const MAX_OPTIONS = 6;
const MAX_SUGGESTIONS = 3;

export function initialFlags(): Flags {
  return Object.fromEntries(FLAG_ORDER.map((f) => [f, false])) as Flags;
}

export function initialState(): AgentState {
  return {
    planFile: { brief: { findings: [] }, campaign: null, buckets: [] },
    flags: initialFlags(),
    timeline: [],
    questions: [],
    questionSeq: 0,
  };
}

/** Accepts whatever the client sent back and returns a complete, well-formed state. */
export function normaliseState(raw: unknown): AgentState {
  const base = initialState();
  if (!raw || typeof raw !== 'object') return base;
  const s = raw as Partial<AgentState>;
  const flags = { ...base.flags };
  for (const f of FLAG_ORDER) if (typeof s.flags?.[f] === 'boolean') flags[f] = s.flags[f];
  const pf = s.planFile;
  return {
    planFile: {
      brief: { findings: Array.isArray(pf?.brief?.findings) ? pf!.brief.findings : [], summary: pf?.brief?.summary, updatedAt: pf?.brief?.updatedAt },
      campaign: pf?.campaign ?? null,
      buckets: Array.isArray(pf?.buckets) ? pf!.buckets : [],
    },
    flags,
    timeline: Array.isArray(s.timeline) ? s.timeline : [],
    questions: Array.isArray(s.questions) ? s.questions : [],
    questionSeq: Number.isFinite(s.questionSeq) ? Number(s.questionSeq) : 0,
  };
}

const now = () => new Date().toISOString();

export function log(state: AgentState, actor: TimelineActor, type: TimelineType, note: string, extra: Partial<TimelineEntry> = {}): AgentState {
  return { ...state, timeline: [...state.timeline, { at: now(), actor, type, note, ...extra }] };
}

/** Sets one flag. A no-op (and no log line) when the value does not change. */
export function setFlag(state: AgentState, flag: FlagName, value: boolean, actor: TimelineActor, reason: string, silent = false): AgentState {
  if (state.flags[flag] === value) return state;
  const next = { ...state, flags: { ...state.flags, [flag]: value } };
  if (silent) return next;
  return log(next, actor, 'flag_changed', `${FLAG_LABELS[flag]} → ${value ? 'yes' : 'no'}${reason ? `: ${reason}` : ''}`, { flag, value });
}

export function isAgentFlag(name: string): name is FlagName {
  return (AGENT_FLAGS as string[]).includes(name);
}

/** App-owned: true exactly when every question asked so far has an answer. */
export function syncQuestionsAnswered(state: AgentState): AgentState {
  const all = state.questions.length > 0 && state.questions.every((q) => q.answer && q.answer.trim());
  return setFlag(state, 'questionsAnswered', all, 'app', all ? 'every question has an answer' : 'a question is still open');
}

/** App-owned: any change to the campaign after a build means the canvas is out of date until rebuilt. */
export function markStale(state: AgentState, what: string): AgentState {
  return setFlag(state, 'campaignBuilt', false, 'app', `${what} changed since the last build`);
}

const titleCase = (s: string) =>
  s
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

// --- questions ------------------------------------------------------------

const cleanList = (v: unknown, max: number): string[] => {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const t = item.trim().replace(/\s+/g, ' ');
    if (!t || /^other\b[\s:.…-]*$/i.test(t)) continue; // the UI adds its own "Other"
    if (out.some((o) => o.toLowerCase() === t.toLowerCase())) continue;
    out.push(t.slice(0, 120));
    if (out.length >= max) break;
  }
  return out;
};

export interface RawQuestion {
  aspect?: unknown;
  text?: unknown;
  answerType?: unknown;
  options?: unknown;
  suggestions?: unknown;
}

/**
 * Turns the model's `ask_questions` payload into stored questions.
 * - Aspect labels are free text, trimmed and title-cased; near-duplicates merge onto the first spelling.
 * - A choice question with fewer than two options becomes open, its options kept as examples.
 * - An agent-written "Other" is dropped; the form always offers one.
 */
export function normaliseQuestions(raw: unknown, existingAspects: string[], seqStart: number): { questions: AgentQuestion[]; dropped: number; seq: number } {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const aspects = [...existingAspects];
  const canonical = (label: string) => {
    const key = label.toLowerCase().replace(/[^a-z0-9]/g, '');
    const hit = aspects.find((a) => a.toLowerCase().replace(/[^a-z0-9]/g, '') === key);
    if (hit) return hit;
    aspects.push(label);
    return label;
  };
  const out: AgentQuestion[] = [];
  let dropped = 0;
  let seq = seqStart;
  for (const item of list.slice(0, MAX_QUESTIONS_PER_CALL)) {
    const q = (item ?? {}) as RawQuestion;
    const text = typeof q.text === 'string' ? q.text.trim() : '';
    if (!text) {
      dropped++;
      continue;
    }
    const aspect = canonical(typeof q.aspect === 'string' && q.aspect.trim() ? titleCase(q.aspect).slice(0, 40) : 'General');
    let answerType: AnswerType = q.answerType === 'single' || q.answerType === 'multi' || q.answerType === 'open' ? q.answerType : 'open';
    let options = cleanList(q.options, MAX_OPTIONS);
    let suggestions = cleanList(q.suggestions, MAX_SUGGESTIONS);
    if (answerType !== 'open' && options.length < 2) {
      suggestions = cleanList([...options, ...suggestions], MAX_SUGGESTIONS);
      options = [];
      answerType = 'open';
    }
    if (answerType === 'open') options = [];
    else suggestions = [];
    seq++;
    out.push({
      id: `q${seq}`,
      aspect,
      text,
      answerType,
      ...(options.length ? { options } : {}),
      ...(suggestions.length ? { suggestions } : {}),
      askedAt: now(),
    });
  }
  dropped += Math.max(0, list.length - MAX_QUESTIONS_PER_CALL);
  return { questions: out, dropped, seq };
}

export function addQuestions(state: AgentState, raw: unknown): { state: AgentState; added: AgentQuestion[]; dropped: number } {
  const existingAspects = [...new Set(state.questions.map((q) => q.aspect))];
  const { questions, dropped, seq } = normaliseQuestions(raw, existingAspects, state.questionSeq);
  if (!questions.length) return { state, added: [], dropped };
  let next: AgentState = { ...state, questions: [...state.questions, ...questions], questionSeq: seq };
  const aspects = [...new Set(questions.map((q) => q.aspect))];
  next = log(next, 'agent', 'questions_asked', `Asked ${questions.length} question${questions.length === 1 ? '' : 's'} (${aspects.join(', ')})`);
  next = syncQuestionsAnswered(next);
  return { state: next, added: questions, dropped };
}

/**
 * Records the manager's reply.
 * - With a per-question `answers` map (the form), only those ids are answered; blanks stay open.
 * - With free text only, the reply is taken as answering every open question; the agent reads it
 *   and can re-ask anything it did not cover.
 */
export function recordAnswers(state: AgentState, answers: Record<string, string> | undefined, freeText: string): AgentState {
  const open = state.questions.filter((q) => !q.answer?.trim());
  if (!open.length) return state;
  const at = now();
  const answeredIds: string[] = [];
  let questions = state.questions;
  if (answers && Object.keys(answers).length) {
    questions = state.questions.map((q) => {
      const a = answers[q.id];
      if (typeof a === 'string' && a.trim() && !q.answer?.trim()) {
        answeredIds.push(q.id);
        return { ...q, answer: a.trim(), answeredAt: at };
      }
      return q;
    });
  } else if (freeText.trim()) {
    questions = state.questions.map((q) => {
      if (q.answer?.trim()) return q;
      answeredIds.push(q.id);
      return { ...q, answer: `(answered in their message) ${freeText.trim().slice(0, 400)}`, answeredAt: at };
    });
  }
  if (!answeredIds.length) return state;
  let next: AgentState = { ...state, questions };
  const stillOpen = questions.filter((q) => !q.answer?.trim()).length;
  next = log(next, 'user', 'answers_received', `Answered ${answeredIds.length} question${answeredIds.length === 1 ? '' : 's'}${stillOpen ? `; ${stillOpen} still open` : ''}`);
  return syncQuestionsAnswered(next);
}

/**
 * The manager skipped questions (Skip, or blank on Send). They count as dealt
 * with — the agent makes its best assumption for each and states it — so the
 * conversation never stalls waiting for an answer that is not coming.
 */
export function recordSkips(state: AgentState, ids: string[] | undefined): AgentState {
  const want = new Set(ids ?? []);
  if (!want.size) return state;
  let n = 0;
  const at = now();
  const questions = state.questions.map((q) => {
    if (!want.has(q.id) || q.answer?.trim()) return q;
    n++;
    return { ...q, skipped: true, answer: '(skipped by the manager: make your best assumption and state it)', answeredAt: at };
  });
  if (!n) return state;
  let next: AgentState = { ...state, questions };
  next = log(next, 'user', 'answers_received', `Skipped ${n} question${n === 1 ? '' : 's'}: the agent will assume and say so`);
  return syncQuestionsAnswered(next);
}

// --- brief ------------------------------------------------------------------

const cleanFindings = (v: unknown): BriefFinding[] => {
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
  return list
    .map((f) => (f ?? {}) as Record<string, unknown>)
    .filter((f) => typeof f.text === 'string' && f.text.trim())
    .map((f) => ({
      aspect: typeof f.aspect === 'string' && f.aspect.trim() ? titleCase(f.aspect).slice(0, 40) : 'General',
      text: String(f.text).trim(),
      source: f.source === 'assumption' ? 'assumption' : f.source === 'data' ? 'data' : 'manager',
    }));
};

export function updateBrief(state: AgentState, input: { findings?: unknown; replaceFindings?: unknown; summary?: unknown }): { state: AgentState; said: string; error?: string } {
  const incoming = cleanFindings(input.findings);
  const summary = str(input.summary) ?? state.planFile.brief.summary;
  if (!incoming.length && summary === state.planFile.brief.summary) return { state, said: '', error: 'Send at least one finding ({aspect, text, source}) or a summary.' };
  let findings: BriefFinding[];
  if (input.replaceFindings === true) findings = incoming;
  else {
    const byAspect = new Map(state.planFile.brief.findings.map((f) => [f.aspect.toLowerCase(), f]));
    for (const f of incoming) byAspect.set(f.aspect.toLowerCase(), f);
    findings = [...byAspect.values()];
  }
  let next: AgentState = { ...state, planFile: { ...state.planFile, brief: { findings, summary, updatedAt: now() } } };
  next = log(next, 'agent', 'plan_section_updated', `Updated the brief (${incoming.map((f) => f.aspect).join(', ') || 'summary'})`);
  return { state: next, said: `Brief: ${findings.length} finding${findings.length === 1 ? '' : 's'} on file.` };
}

// --- campaign shell -------------------------------------------------------------

export function updateCampaign(state: AgentState, input: Record<string, unknown>): { state: AgentState; said: string; error?: string } {
  const prev: CampaignShell = state.planFile.campaign ?? { goal: null, entry: null, membership: null };
  const next: CampaignShell = { ...prev, updatedAt: now() };
  const changed: string[] = [];
  for (const k of ['name', 'description', 'segmentationLogic', 'guardrails', 'measurement'] as const) {
    const v = str(input[k]);
    if (v !== undefined) {
      next[k] = v;
      changed.push(k);
    }
  }
  if (input.goal === null) {
    next.goal = null;
    changed.push('goal');
  } else if (input.goal && typeof input.goal === 'object') {
    const g = input.goal as Record<string, unknown>;
    if (str(g.eventCategory) && str(g.eventType)) {
      next.goal = { eventCategory: str(g.eventCategory)!, eventType: str(g.eventType)!, ...(Array.isArray(g.conditions) ? { conditions: g.conditions as never } : {}) };
      changed.push('goal');
    }
  }
  if (input.entry && typeof input.entry === 'object') {
    const e = input.entry as Record<string, unknown>;
    if (str(e.entity)) {
      next.entry = {
        kind: 'audience',
        entity: str(e.entity)!,
        ...(Array.isArray(e.conditions) ? { conditions: e.conditions as never } : {}),
        ...(Array.isArray(e.groups) ? { groups: e.groups as BpAudienceGroup[] } : {}),
      };
      changed.push('entry');
    }
  }
  if (input.membership && typeof input.membership === 'object') {
    const m = input.membership as Record<string, unknown>;
    if (m.type === 'locked' || m.type === 'open') {
      const refresh = m.refresh === 'daily' || m.refresh === 'weekly' || m.refresh === 'monthly' ? m.refresh : 'weekly';
      next.membership = m.type === 'open' ? { type: 'open', refresh } : { type: 'locked' };
      changed.push('membership');
    }
  }
  if (input.everyoneElse && typeof input.everyoneElse === 'object') {
    const ee = input.everyoneElse as Record<string, unknown>;
    if (ee.approach === 'journey' || ee.approach === 'none') {
      next.everyoneElse = {
        approach: ee.approach,
        ...(str(ee.why) ? { why: str(ee.why) } : {}),
        ...(ee.approach === 'journey' && Array.isArray(ee.journey) ? { journey: normaliseSteps(ee.journey as BpStep[]) } : {}),
      };
      changed.push('everyoneElse');
    }
  }
  if (!changed.length) return { state, said: '', error: 'Nothing to update. Send any of: name, description, goal, entry, membership, segmentationLogic, guardrails, measurement, everyoneElse.' };
  let out: AgentState = { ...state, planFile: { ...state.planFile, campaign: next } };
  out = log(out, 'agent', 'plan_section_updated', `Updated the campaign (${changed.join(', ')})`);
  if (state.flags.campaignBuilt && changed.some((c) => ['goal', 'entry', 'membership', 'everyoneElse', 'name'].includes(c))) out = markStale(out, 'The campaign');
  return { state: out, said: `Campaign updated: ${changed.join(', ')}.` };
}

// --- step normalisation -------------------------------------------------------------

/**
 * Small, safe repairs to model-written steps, applied wherever a journey is
 * saved. A wait written with days (delayDays / durationDays) instead of
 * durationHours is converted, rather than reaching the builder with no
 * duration at all.
 */
export function normaliseSteps(steps: BpStep[] | null | undefined): BpStep[] {
  return (steps ?? []).map((st) => {
    const s = { ...(st as unknown as Record<string, unknown>) };
    if (s.kind === 'wait' && !Number.isFinite(Number(s.durationHours))) {
      const days = Number(s.durationDays ?? s.delayDays ?? s.days);
      const hours = Number(s.hours);
      if (Number.isFinite(days)) s.durationHours = days * 24;
      else if (Number.isFinite(hours)) s.durationHours = hours;
      delete s.durationDays;
      delete s.delayDays;
      delete s.days;
      delete s.hours;
    }
    for (const k of ['yes', 'no']) if (Array.isArray(s[k])) s[k] = normaliseSteps(s[k] as BpStep[]);
    for (const k of ['arms', 'paths']) {
      if (Array.isArray(s[k])) s[k] = (s[k] as { steps?: BpStep[] }[]).map((a) => ({ ...a, steps: normaliseSteps(a.steps) }));
    }
    return s as unknown as BpStep;
  });
}

// --- buckets ---------------------------------------------------------------------

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'bucket';

export interface BucketInput {
  id?: unknown;
  name?: unknown;
  priority?: unknown;
  behaviour?: unknown;
  rule?: unknown;
  sql?: unknown;
  evidence?: unknown;
  evidenceNotes?: unknown;
  thesis?: unknown;
  metric?: unknown;
  holdoutPct?: unknown;
  journey?: unknown;
}

const DEFINITION_KEYS = ['name', 'behaviour', 'rule', 'sql', 'evidence', 'priority'] as const;

/**
 * Creates or updates one bucket. Any change after a build marks the campaign
 * out of date until it is rebuilt.
 */
export function upsertBucket(state: AgentState, input: BucketInput): { state: AgentState; bucket?: Bucket; said: string; error?: string; definitionChanged: boolean } {
  const buckets = state.planFile.buckets;
  const id = str(input.id) ?? (str(input.name) ? slug(String(input.name)) : undefined);
  if (!id) return { state, said: '', error: 'A bucket needs an id or a name.', definitionChanged: false };
  const prev = buckets.find((b) => b.id === id);
  if (!prev && (!str(input.name) || !str(input.behaviour))) {
    return { state, said: '', error: 'A new bucket needs at least name and behaviour (and normally rule, evidence, thesis, metric).', definitionChanged: false };
  }
  const evidence: Evidence | undefined = input.evidence === 'measured' || input.evidence === 'manager' || input.evidence === 'hypothesis' ? input.evidence : undefined;
  const rule = Array.isArray(input.rule) ? (input.rule as BpAudienceGroup[]).filter((g) => g && typeof g.entity === 'string') : undefined;
  const journey = Array.isArray(input.journey) ? normaliseSteps(input.journey as BpStep[]) : input.journey === null ? null : undefined;
  const holdout = typeof input.holdoutPct === 'number' && input.holdoutPct >= 0 && input.holdoutPct < 50 ? Math.round(input.holdoutPct) : undefined;

  const merged: Bucket = {
    id,
    name: str(input.name) ?? prev?.name ?? id,
    priority: typeof input.priority === 'number' ? input.priority : prev?.priority ?? (buckets.length ? Math.max(...buckets.map((b) => b.priority)) + 1 : 1),
    behaviour: str(input.behaviour) ?? prev?.behaviour ?? '',
    rule: rule ?? prev?.rule ?? [],
    ...(str(input.sql) ? { sql: str(input.sql) } : prev?.sql ? { sql: prev.sql } : {}),
    evidence: evidence ?? prev?.evidence ?? 'hypothesis',
    evidenceNotes: str(input.evidenceNotes) ?? prev?.evidenceNotes ?? '',
    ...(prev?.size !== undefined ? { size: prev.size } : {}),
    thesis: str(input.thesis) ?? prev?.thesis ?? '',
    metric: str(input.metric) ?? prev?.metric ?? '',
    ...(holdout !== undefined ? { holdoutPct: holdout } : prev?.holdoutPct !== undefined ? { holdoutPct: prev.holdoutPct } : {}),
    journey: journey !== undefined ? journey : prev?.journey ?? null,
    updatedAt: now(),
  };
  const sameAs = (k: (typeof DEFINITION_KEYS)[number]) =>
    JSON.stringify((prev as unknown as Record<string, unknown> | undefined)?.[k]) === JSON.stringify((merged as unknown as Record<string, unknown>)[k]);
  const definitionChanged = !prev || DEFINITION_KEYS.some((k) => !sameAs(k));
  const journeyChanged = journey !== undefined && JSON.stringify(prev?.journey ?? null) !== JSON.stringify(journey);
  const anyChange = !prev || definitionChanged || journeyChanged || JSON.stringify({ ...prev, updatedAt: '' }) !== JSON.stringify({ ...merged, updatedAt: '' });
  if (str(input.sql) && str(input.sql) !== prev?.sql) {
    delete merged.size;
    delete merged.sizeError;
  }

  const list = prev ? buckets.map((b) => (b.id === id ? merged : b)) : [...buckets, merged];
  list.sort((a, b) => a.priority - b.priority);
  let next: AgentState = { ...state, planFile: { ...state.planFile, buckets: list } };
  const what = !prev ? 'added' : [journeyChanged ? 'journey updated' : '', definitionChanged ? 'definition updated' : ''].filter(Boolean).join(', ') || 'updated';
  next = log(next, 'agent', 'bucket_updated', `Bucket "${merged.name}" ${what}`);
  if (anyChange && state.flags.campaignBuilt) next = markStale(next, `Bucket "${merged.name}"`);
  return { state: next, bucket: merged, said: `Bucket "${merged.name}" ${what}.`, definitionChanged };
}

export function setBucketSize(state: AgentState, id: string, size: number | null, error?: string): AgentState {
  const list = state.planFile.buckets.map((b) => {
    if (b.id !== id) return b;
    if (size !== null) {
      const { sizeError: _drop, ...rest } = b;
      void _drop;
      return { ...rest, size };
    }
    return { ...b, sizeError: error };
  });
  const b = list.find((x) => x.id === id);
  let next: AgentState = { ...state, planFile: { ...state.planFile, buckets: list } };
  if (b) next = log(next, 'app', 'bucket_sized', size !== null ? `"${b.name}": ${size.toLocaleString('en-IN')} customers` : `"${b.name}" could not be sized: ${error}`);
  return next;
}

export function removeBucket(state: AgentState, id: string, reason: string): { state: AgentState; error?: string } {
  const b = state.planFile.buckets.find((x) => x.id === id);
  if (!b) return { state, error: `No bucket "${id}".` };
  let next: AgentState = { ...state, planFile: { ...state.planFile, buckets: state.planFile.buckets.filter((x) => x.id !== id) } };
  next = log(next, 'agent', 'bucket_removed', `Removed bucket "${b.name}"${reason ? `: ${reason}` : ''}`);
  if (state.flags.campaignBuilt) next = markStale(next, `Bucket "${b.name}" (removed)`);
  return { state: next };
}

// --- precise journey edits ------------------------------------------------------

/**
 * A step's address inside a journey, e.g. "2", "1.arms.0.steps.3",
 * "4.paths.1.steps.0", "3.yes.0". The outline in the status block prints
 * these, so the agent can change one step without rewriting the journey.
 */
type Container = BpStep[];

function resolve(journey: BpStep[], path: string): { list: Container; index: number } | null {
  const parts = path.split('.').filter((p) => p !== '');
  if (!parts.length) return null;
  let list: Container = journey;
  for (let i = 0; i < parts.length; i++) {
    const idx = Number(parts[i]);
    if (!Number.isInteger(idx)) return null;
    if (i === parts.length - 1) return { list, index: idx };
    const step = list[idx] as unknown as Record<string, unknown> | undefined;
    if (!step) return null;
    const key = parts[++i];
    if (key === 'yes' || key === 'no') {
      const arr = step[key];
      if (!Array.isArray(arr)) return null;
      list = arr as Container;
    } else if (key === 'arms' || key === 'paths') {
      const arms = step[key] as { steps?: BpStep[] }[] | undefined;
      const armIdx = Number(parts[++i]);
      if (!Array.isArray(arms) || !arms[armIdx] || parts[++i] !== 'steps') return null;
      arms[armIdx].steps = arms[armIdx].steps ?? [];
      list = arms[armIdx].steps!;
    } else return null;
  }
  return null;
}

export interface JourneyOp {
  op?: unknown;
  path?: unknown;
  step?: unknown;
}

/** Applies replace / insert_after / insert_before / remove to a copy of the journey. */
export function applyJourneyOps(journey: BpStep[], ops: JourneyOp[]): { journey: BpStep[]; applied: string[]; errors: string[] } {
  const copy = JSON.parse(JSON.stringify(journey)) as BpStep[];
  ops = ops.map((o) => (o.step && typeof o.step === 'object' ? { ...o, step: normaliseSteps([o.step as BpStep])[0] } : o));
  const applied: string[] = [];
  const errors: string[] = [];
  for (const o of ops) {
    const op = String(o.op ?? '');
    const path = String(o.path ?? '');
    const at = resolve(copy, path);
    if (!at) {
      errors.push(`${op} ${path}: no step at that address`);
      continue;
    }
    const needsStep = op !== 'remove';
    if (needsStep && (!o.step || typeof o.step !== 'object' || typeof (o.step as { kind?: unknown }).kind !== 'string')) {
      errors.push(`${op} ${path}: needs a step with a kind`);
      continue;
    }
    if (op === 'replace') {
      if (!at.list[at.index]) { errors.push(`replace ${path}: no step there`); continue; }
      at.list[at.index] = o.step as BpStep;
    } else if (op === 'insert_after') at.list.splice(at.index + 1, 0, o.step as BpStep);
    else if (op === 'insert_before') at.list.splice(at.index, 0, o.step as BpStep);
    else if (op === 'remove') {
      if (!at.list[at.index]) { errors.push(`remove ${path}: no step there`); continue; }
      at.list.splice(at.index, 1);
    } else {
      errors.push(`${op}: op must be replace, insert_after, insert_before or remove`);
      continue;
    }
    applied.push(`${op} ${path}`);
  }
  return { journey: copy, applied, errors };
}

export function editJourney(state: AgentState, target: string, ops: JourneyOp[]): { state: AgentState; said: string; error?: string } {
  const isEveryone = target === 'everyone_else';
  const bucket = isEveryone ? null : state.planFile.buckets.find((b) => b.id === target);
  const journey = isEveryone ? state.planFile.campaign?.everyoneElse?.journey : bucket?.journey;
  if (!isEveryone && !bucket) return { state, said: '', error: `No bucket "${target}".` };
  if (!journey?.length) return { state, said: '', error: 'That journey is empty; write it with upsert_bucket (or update_campaign for everyone else) first.' };
  const res = applyJourneyOps(journey, ops);
  if (!res.applied.length) return { state, said: '', error: res.errors.join('; ') || 'No operations applied.' };
  let next: AgentState;
  if (isEveryone) {
    const c = state.planFile.campaign!;
    next = { ...state, planFile: { ...state.planFile, campaign: { ...c, everyoneElse: { ...c.everyoneElse!, journey: res.journey } } } };
  } else {
    next = { ...state, planFile: { ...state.planFile, buckets: state.planFile.buckets.map((b) => (b.id === target ? { ...b, journey: res.journey, updatedAt: now() } : b)) } };
  }
  const name = isEveryone ? 'Everyone else' : bucket!.name;
  next = log(next, 'agent', 'journey_edited', `Edited "${name}" journey: ${res.applied.join(', ')}`);
  if (state.flags.campaignBuilt) next = markStale(next, `"${name}" journey`);
  return { state: next, said: `Edited "${name}": ${res.applied.join(', ')}${res.errors.length ? `. Not applied: ${res.errors.join('; ')}` : ''}.` };
}

/** One line per step with its address, so a step can be edited precisely. */
export function outline(steps: BpStep[] | null | undefined, prefix = ''): string[] {
  const out: string[] = [];
  (steps ?? []).forEach((st, i) => {
    const at = `${prefix}${i}`;
    const s = st as unknown as Record<string, unknown>;
    const k = String(s.kind);
    if (k === 'send') out.push(`${at} send ${(s.channelPreference as string[] | undefined)?.join('/') ?? ''}${s.fallbackChannel ? ` (fallback ${s.fallbackChannel})` : ''}${s.delayDays ? ` day ${s.delayDays}` : ''}${s.atTime ? ` ${s.atTime}` : ''}: "${String(s.copy ?? s.describe ?? '').slice(0, 90)}"${s.cta ? ` [${s.cta}]` : ''}`);
    else if (k === 'wait') out.push(`${at} wait ${s.durationHours}h`);
    else if (k === 'waitForEvent') out.push(`${at} waitForEvent ${s.eventType} up to ${s.timeoutDays}d`);
    else if (k === 'exit') out.push(`${at} exit "${s.reason}"`);
    else if (k === 'experiment') {
      out.push(`${at} experiment "${s.label ?? ''}" tests ${s.tests}`);
      ((s.arms as { label: string; pct: number; steps: BpStep[] }[]) ?? []).forEach((a, ai) => {
        out.push(`${at}.arms.${ai} arm "${a.label}" ${a.pct}%`);
        out.push(...outline(a.steps, `${at}.arms.${ai}.steps.`));
      });
    } else if (k === 'branch') {
      out.push(`${at} branch "${s.label ?? ''}"`);
      ((s.paths as { label: string; steps: BpStep[] }[]) ?? []).forEach((p, pi) => {
        out.push(`${at}.paths.${pi} path "${p.label}"`);
        out.push(...outline(p.steps, `${at}.paths.${pi}.steps.`));
      });
    } else if (k === 'condition') {
      out.push(`${at} condition "${s.label ?? ''}"`);
      out.push(...outline(s.yes as BpStep[], `${at}.yes.`));
      out.push(...outline(s.no as BpStep[], `${at}.no.`));
    } else out.push(`${at} ${k}`);
  });
  return out;
}
