// Pure state transitions for the agent: the campaign object (what executes),
// the campaign context (what supports it), flags, timeline and questions.
// No I/O, no model calls, so every rule here is unit-testable.

import { EXIT_OUTCOMES, type BpAudienceGroup, type BpStep } from '../blueprint';
import { carryIds, idsIn } from './stepIds';
import {
  AGENT_FLAGS,
  FLAG_LABELS,
  FLAG_ORDER,
  type AgentQuestion,
  AFTER_OUTCOMES,
  type AfterJourney,
  type AfterOutcome,
  type AgentState,
  type AnswerType,
  type CampaignBucket,
  type CampaignContext,
  type CampaignObject,
  type ContextEntry,
  type ContextKind,
  type ContextSource,
  type FlagName,
  type Flags,
  type TimelineActor,
  type TimelineEntry,
  type TimelineType,
} from './types';

export const MAX_QUESTIONS_PER_CALL = 12;
const MAX_OPTIONS = 4;

export function initialFlags(): Flags {
  return Object.fromEntries(FLAG_ORDER.map((f) => [f, false])) as Flags;
}

export function emptyCampaign(): CampaignObject {
  return { goal: null, entry: null, membership: null, buckets: [], everyoneElse: null };
}

export function emptyContext(): CampaignContext {
  return { entries: [] };
}

export function initialState(): AgentState {
  return {
    campaign: emptyCampaign(),
    context: emptyContext(),
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
  const c = s.campaign;
  return {
    campaign: c && typeof c === 'object' ? { ...emptyCampaign(), ...c, buckets: Array.isArray(c.buckets) ? c.buckets : [] } : emptyCampaign(),
    context: { entries: Array.isArray(s.context?.entries) ? s.context.entries : [] },
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

/** App-owned: any change to the campaign object after a build means it is out of date until rebuilt. Context never does this. */
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
 * - Every question has tappable answers: yesno stores Yes/No; single/multi keep 1-4 options.
 * - A choice question with no options becomes yesno; a legacy "open" question becomes multi, its suggestions as options.
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
    let options = cleanList([...(Array.isArray(q.options) ? q.options : []), ...(Array.isArray(q.suggestions) ? q.suggestions : [])], MAX_OPTIONS);
    let answerType: AnswerType =
      q.answerType === 'yesno' || q.answerType === 'single' || q.answerType === 'multi' ? q.answerType : q.answerType === 'open' ? 'multi' : options.length ? 'single' : 'yesno';
    if (answerType !== 'yesno' && !options.length) answerType = 'yesno';
    if (answerType === 'yesno') options = ['Yes', 'No'];
    seq++;
    out.push({
      id: `q${seq}`,
      aspect,
      text,
      answerType,
      options,
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
  next = fileAnswers(next, answeredIds);
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
  next = fileAnswers(next, questions.filter((q) => q.skipped && want.has(q.id)).map((q) => q.id));
  next = log(next, 'user', 'answers_received', `Skipped ${n} question${n === 1 ? '' : 's'}: the agent will assume and say so`);
  return syncQuestionsAnswered(next);
}

// --- context ------------------------------------------------------------------

const KINDS: ContextKind[] = ['answer', 'brief', 'bucket', 'research', 'sizing', 'note', 'metric'];
const SOURCES: ContextSource[] = ['manager', 'data', 'assumption', 'agent'];

export interface RawContextEntry {
  kind?: unknown;
  topic?: unknown;
  bucketId?: unknown;
  text?: unknown;
  source?: unknown;
  data?: unknown;
}

/**
 * Adds entries to the context. Nothing is ever overwritten: a newer entry on
 * the same (kind, bucket, topic) becomes the current one, and the older one
 * stays as history. Never marks the campaign stale — context is not execution.
 */
export function addContext(state: AgentState, raw: unknown, actor: TimelineActor = 'agent'): { state: AgentState; added: ContextEntry[]; dropped: number } {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const at = now();
  const added: ContextEntry[] = [];
  let dropped = 0;
  let seq = state.context.entries.length;
  for (const item of list) {
    const r = (item ?? {}) as RawContextEntry;
    const kind = KINDS.includes(r.kind as ContextKind) ? (r.kind as ContextKind) : undefined;
    const topic = str(r.topic);
    const text = typeof r.text === 'string' ? r.text.trim() : '';
    if (!kind || !topic || (!text && !(r.data && typeof r.data === 'object'))) {
      dropped++;
      continue;
    }
    seq++;
    added.push({
      id: `c${seq}`,
      at,
      kind,
      topic: kind === 'brief' ? titleCase(topic).slice(0, 40) : topic.slice(0, 80),
      ...(str(r.bucketId) ? { bucketId: str(r.bucketId) } : {}),
      text,
      source: SOURCES.includes(r.source as ContextSource) ? (r.source as ContextSource) : 'agent',
      ...(r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? { data: r.data as Record<string, unknown> } : {}),
    });
  }
  if (!added.length) return { state, added, dropped };
  let next: AgentState = { ...state, context: { entries: [...state.context.entries, ...added] } };
  const kinds = [...new Set(added.map((e) => e.kind))];
  next = log(next, actor, 'context_added', `Context: ${added.length} entr${added.length === 1 ? 'y' : 'ies'} (${kinds.join(', ')})`);
  return { state: next, added, dropped };
}

/** The app files every answer (or skip) in the context itself, so nothing the manager said depends on the agent remembering to. */
function fileAnswers(state: AgentState, ids: string[]): AgentState {
  const qs = state.questions.filter((q) => ids.includes(q.id));
  if (!qs.length) return state;
  return addContext(
    state,
    qs.map((q) => ({
      kind: 'answer',
      topic: `${q.aspect}: ${q.text.replace(/\*\*/g, '')}`,
      text: q.skipped ? '(skipped)' : q.answer ?? '',
      source: 'manager',
      data: { questionId: q.id, ...(q.skipped ? { skipped: true } : {}) },
    })),
    'user',
  ).state;
}

// --- campaign shell -------------------------------------------------------------

export function updateCampaign(state: AgentState, input: Record<string, unknown>): { state: AgentState; said: string; error?: string } {
  const prev: CampaignObject = state.campaign;
  const next: CampaignObject = { ...prev };
  const changed: string[] = [];
  for (const k of ['name', 'description'] as const) {
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
        ...(ee.approach === 'journey' && Array.isArray(ee.journey)
          ? { journey: carryIds(prev.everyoneElse?.journey, normaliseSteps(ee.journey as BpStep[]), idsOutside(prev, 'everyone_else'))! }
          : {}),
      };
      changed.push('everyoneElse');
    }
  }
  if (input.maxAttempts === null) {
    next.maxAttempts = null;
    changed.push('maxAttempts');
  } else if (input.maxAttempts !== undefined) {
    const n = Number(input.maxAttempts);
    if (!Number.isInteger(n) || n < 1 || n > 10) return { state, said: '', error: 'maxAttempts is the most times one customer goes through this campaign: a whole number from 1 to 10. Nothing was changed.' };
    next.maxAttempts = n;
    changed.push('maxAttempts');
  }
  if (input.afterJourney === null) {
    next.afterJourney = null;
    changed.push('afterJourney');
  } else if (input.afterJourney && typeof input.afterJourney === 'object') {
    const res = parseAfterJourney(input.afterJourney as Record<string, unknown>, prev.afterJourney);
    if (res.error) return { state, said: '', error: res.error };
    next.afterJourney = res.value;
    changed.push('afterJourney');
  }
  if (!changed.length)
    return { state, said: '', error: 'Nothing to update. The campaign takes: name, description, goal, entry, membership, everyoneElse, afterJourney, maxAttempts. Reasoning (why, guardrails, measurement) goes in the context with add_context.' };
  let out: AgentState = { ...state, campaign: next };
  out = log(out, 'agent', 'plan_section_updated', `Updated the campaign (${changed.join(', ')})`);
  if (state.flags.campaignBuilt && changed.some((c) => ['goal', 'entry', 'membership', 'everyoneElse', 'afterJourney', 'maxAttempts', 'name'].includes(c))) out = markStale(out, 'The campaign');
  return { state: out, said: `Campaign updated: ${changed.join(', ')}.` };
}

/**
 * Reads an afterJourney: per outcome, days before the customer may come back,
 * or "leave". Merged over the previous value. Opted out is refused: those
 * customers never come back, by system rule.
 */
export function parseAfterJourney(input: Record<string, unknown>, prev?: AfterJourney | null): { value?: AfterJourney; error?: string } {
  const out: AfterJourney = { ...(prev ?? {}) };
  for (const [k, v] of Object.entries(input)) {
    if (/opt/i.test(k))
      return { error: 'Opted-out customers never come back into any campaign: that is a system rule, not a campaign setting. Nothing was changed.' };
    if (!(AFTER_OUTCOMES as string[]).includes(k))
      return { error: `afterJourney takes ${AFTER_OUTCOMES.join(', ')}; "${k}" is not one of them. Nothing was changed.` };
    if (v === 'leave' || v === null) out[k as AfterOutcome] = 'leave';
    else if (Number.isFinite(Number(v)) && Number(v) >= 0) out[k as AfterOutcome] = Math.round(Number(v));
    else return { error: `afterJourney.${k} must be a number of days (0 or more) or "leave". Nothing was changed.` };
  }
  return { value: out };
}

/**
 * Hard rules a journey must meet before it is saved, whoever writes it. The
 * agent gets the reason and must ask the manager rather than guess.
 */
/** Anything that looks like a web address: the agent must never write one. */
const URL_LIKE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|in|co|net|org|bank|app|ly|me|io)(?:\/|\b)/i;

/** Anything that names opted-out customers: never targeted, never designed for. */
const OPTED_OUT = /opt(?:ed)?[\s_-]*out|unsubscrib/i;
const OPTED_OUT_ERROR =
  'Opted-out customers (STOP, unsubscribe) are handled by the system: they leave every campaign immediately and are never messaged again. A campaign never targets, waits for or designs around them. Nothing was saved.';

export function journeyErrors(steps: BpStep[] | null | undefined): string[] {
  const out: string[] = [];
  const visit = (list: BpStep[] | null | undefined, before: string | null = null) => {
    let channel = before;
    (list ?? []).forEach((st) => {
      const s = st as unknown as { kind?: string; label?: string; link?: string; outcome?: unknown; reason?: string; eventType?: string; channelPreference?: string[]; entity?: string; attribute?: string; on?: { attribute?: string; value?: string }; arms?: { pct?: number; label?: string; steps?: BpStep[] }[]; paths?: { statuses?: string[]; steps?: BpStep[] }[]; otherwise?: BpStep[]; yes?: BpStep[]; no?: BpStep[] };
      if (s.kind === 'exit' && s.outcome !== undefined && !(EXIT_OUTCOMES as unknown[]).includes(s.outcome)) {
        out.push(
          /convert|goal/i.test(String(s.outcome))
            ? 'an exit cannot have outcome "converted": the goal check already takes converted customers out. Use no_response, not_reachable or declined. Nothing was saved.'
            : OPTED_OUT.test(String(s.outcome))
              ? OPTED_OUT_ERROR
              : /held|holdout/i.test(String(s.outcome))
                ? 'an exit cannot have outcome "held_back": the holdout is the system\'s, added from the bucket\'s holdout %. Use no_response, not_reachable or declined. Nothing was saved.'
              : `the exit "${s.reason ?? ''}" has outcome "${String(s.outcome)}"; it must be one of ${EXIT_OUTCOMES.join(', ')}. Nothing was saved.`,
        );
      }
      if ((s.kind === 'waitForEvent' && OPTED_OUT.test(String(s.eventType ?? ''))) || OPTED_OUT.test(`${s.on?.attribute ?? ''} ${s.on?.value ?? ''}`)) out.push(OPTED_OUT_ERROR);
      if (s.kind === 'branch' && s.otherwise?.length && channel && s.paths?.some((p) => p.statuses?.length)) {
        // A delivery branch's "Anything else" is the people that channel did
        // not reach: sending them the same channel again reaches no one.
        const firstSend = (s.otherwise as unknown as { kind?: string; channelPreference?: string[] }[]).find((x) => x.kind === 'send');
        if (firstSend && (firstSend.channelPreference ?? [])[0] === channel)
          out.push(`the "Anything else" route of "${s.label ?? 'the branch'}" sends ${channel} again, but those are the people ${channel} just failed to reach. Use a different channel there, or end it. Nothing was saved.`);
      }
      if (s.kind === 'send') channel = (s.channelPreference ?? [])[0] ?? channel;
      if (s.kind === 'send') {
        const send = st as unknown as { name?: string; label?: string; copy?: string; cta?: string };
        for (const [field, text] of [['copy', send.copy], ['CTA', send.cta]] as const)
          if (text && URL_LIKE.test(text))
            out.push(`the message "${send.name ?? send.label ?? ''}" has a web address in its ${field}. Nothing was saved: never write a URL, web address or short link; attach a link reference from list_links instead (the system adds the real link).`);
      }
      if (s.kind === 'experiment' && s.arms?.length) {
        const total = s.arms.reduce((n, a) => n + (Number(a.pct) || 0), 0);
        if (Math.round(total) !== 100)
          out.push(`the A/B test${s.label ? ` "${s.label}"` : ''} would split ${s.arms.map((a) => `${a.pct}%`).join(' + ')} = ${total}%. A split must total 100%. Nothing was changed: ask the manager how they want the split before changing it.`);
      }
      s.arms?.forEach((a) => visit(a.steps, channel));
      s.paths?.forEach((p) => visit(p.steps, channel));
      visit(s.otherwise, channel);
      visit(s.yes, channel);
      visit(s.no, channel);
    });
  };
  visit(steps);
  return [...new Set(out)];
}

/**
 * A bucket on Campaign History must target ONE attempt ("Times Through This
 * Campaign" Equals N). An open-ended rule ("more than 0") catches the same
 * customer every time they come back, which is a loop with no stopping point.
 */
export function returningRuleError(groups: BpAudienceGroup[] | null | undefined): string | null {
  const hist = (groups ?? []).filter((g) => g.entity === 'Campaign History');
  if (!hist.length) return null;
  const times = hist.flatMap((g) => g.conditions ?? []).filter((c) => /times through/i.test(c.attribute ?? ''));
  if (times.length === 1 && times[0].operator === 'Equals' && Number.isInteger(Number(times[0].value)) && Number(times[0].value) >= 1) return null;
  return 'A returning-customer bucket must target one specific attempt: "Times Through This Campaign" Equals a number (1 = their second time through). An open-ended rule such as "more than 0" would catch the same customer every time they come back, with no stopping point. Nothing was saved.';
}

/** A bucket rule (or entry) that targets opted-out customers. */
export function ruleTargetsOptedOut(groups: BpAudienceGroup[] | null | undefined): boolean {
  return (groups ?? []).some((g) => (g.conditions ?? []).some((c) => OPTED_OUT.test(`${c.attribute ?? ''} ${c.value ?? ''}`)));
}

/** Step ids used everywhere in the campaign except one lane (a bucket id, or 'everyone_else'). */
function idsOutside(c: CampaignObject, lane: string): Set<string> {
  return idsIn(...c.buckets.filter((b) => b.id !== lane).map((b) => b.journey), lane === 'everyone_else' ? null : c.everyoneElse?.journey);
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
    for (const k of ['yes', 'no', 'otherwise']) if (Array.isArray(s[k])) s[k] = normaliseSteps(s[k] as BpStep[]);
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
  rule?: unknown;
  holdoutPct?: unknown;
  journey?: unknown;
}

const DEFINITION_KEYS = ['name', 'rule', 'priority'] as const;

/**
 * Creates or updates one bucket. Any change after a build marks the campaign
 * out of date until it is rebuilt.
 */
export function upsertBucket(state: AgentState, input: BucketInput): { state: AgentState; bucket?: CampaignBucket; said: string; error?: string; definitionChanged: boolean } {
  const buckets = state.campaign.buckets;
  const id = str(input.id) ?? (str(input.name) ? slug(String(input.name)) : undefined);
  if (!id) return { state, said: '', error: 'A bucket needs an id or a name.', definitionChanged: false };
  const prev = buckets.find((b) => b.id === id);
  if (!prev && !str(input.name)) return { state, said: '', error: 'A new bucket needs at least a name (and normally a rule and a journey).', definitionChanged: false };
  const rule = Array.isArray(input.rule) ? (input.rule as BpAudienceGroup[]).filter((g) => g && typeof g.entity === 'string') : undefined;
  if (ruleTargetsOptedOut(rule)) return { state, said: '', error: OPTED_OUT_ERROR, definitionChanged: false };
  const loop = returningRuleError(rule);
  if (loop) return { state, said: '', error: loop, definitionChanged: false };
  const journey = Array.isArray(input.journey)
    ? carryIds(prev?.journey, normaliseSteps(input.journey as BpStep[]), idsOutside(state.campaign, id))
    : input.journey === null
      ? null
      : undefined;
  const holdout = typeof input.holdoutPct === 'number' && input.holdoutPct >= 0 && input.holdoutPct < 50 ? Math.round(input.holdoutPct) : undefined;
  const bad = journey ? journeyErrors(journey) : [];
  if (bad.length) return { state, said: '', error: `Not saved: ${bad.join(' ')}`, definitionChanged: false };

  const merged: CampaignBucket = {
    id,
    name: str(input.name) ?? prev?.name ?? id,
    priority: typeof input.priority === 'number' ? input.priority : prev?.priority ?? (buckets.length ? Math.max(...buckets.map((b) => b.priority)) + 1 : 1),
    rule: rule ?? prev?.rule ?? [],
    ...(holdout !== undefined ? { holdoutPct: holdout } : prev?.holdoutPct !== undefined ? { holdoutPct: prev.holdoutPct } : {}),
    journey: journey !== undefined ? journey : prev?.journey ?? null,
  };
  const sameAs = (k: (typeof DEFINITION_KEYS)[number]) => JSON.stringify(prev?.[k]) === JSON.stringify(merged[k]);
  const definitionChanged = !prev || DEFINITION_KEYS.some((k) => !sameAs(k));
  const journeyChanged = journey !== undefined && JSON.stringify(prev?.journey ?? null) !== JSON.stringify(journey);
  const anyChange = !prev || JSON.stringify(prev) !== JSON.stringify(merged);

  const list = prev ? buckets.map((b) => (b.id === id ? merged : b)) : [...buckets, merged];
  list.sort((a, b) => a.priority - b.priority);
  let next: AgentState = { ...state, campaign: { ...state.campaign, buckets: list } };
  const what = !prev ? 'added' : [journeyChanged ? 'journey updated' : '', definitionChanged ? 'definition updated' : ''].filter(Boolean).join(', ') || (anyChange ? 'updated' : 'unchanged');
  next = log(next, 'agent', 'bucket_updated', `Bucket "${merged.name}" ${what}`);
  if (anyChange && state.flags.campaignBuilt) next = markStale(next, `Bucket "${merged.name}"`);
  return { state: next, bucket: merged, said: `Bucket "${merged.name}" ${what}.`, definitionChanged };
}

export function removeBucket(state: AgentState, id: string, reason: string): { state: AgentState; error?: string } {
  const b = state.campaign.buckets.find((x) => x.id === id);
  if (!b) return { state, error: `No bucket "${id}".` };
  let next: AgentState = { ...state, campaign: { ...state.campaign, buckets: state.campaign.buckets.filter((x) => x.id !== id) } };
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
    if (key === 'yes' || key === 'no' || key === 'otherwise') {
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
  const bucket = isEveryone ? null : state.campaign.buckets.find((b) => b.id === target);
  const journey = isEveryone ? state.campaign.everyoneElse?.journey : bucket?.journey;
  if (!isEveryone && !bucket) return { state, said: '', error: `No bucket "${target}".` };
  if (!journey?.length) return { state, said: '', error: 'That journey is empty; write it with edit_bucket (or edit_campaign for everyone else) first.' };
  const res = applyJourneyOps(journey, ops);
  if (!res.applied.length) return { state, said: '', error: res.errors.join('; ') || 'No operations applied.' };
  const bad = journeyErrors(res.journey);
  if (bad.length) return { state, said: '', error: bad.join(' ') };
  res.journey = carryIds(journey, res.journey, idsOutside(state.campaign, isEveryone ? 'everyone_else' : target))!;
  let next: AgentState;
  if (isEveryone) {
    next = { ...state, campaign: { ...state.campaign, everyoneElse: { ...state.campaign.everyoneElse!, journey: res.journey } } };
  } else {
    next = { ...state, campaign: { ...state.campaign, buckets: state.campaign.buckets.map((b) => (b.id === target ? { ...b, journey: res.journey } : b)) } };
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
    else if (k === 'exit') out.push(`${at} exit "${s.reason}"${s.outcome ? ` → ${s.outcome}` : ' (no outcome yet)'}`);
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
      const other = s.otherwise as BpStep[] | undefined;
      out.push(`${at}.otherwise "Anything else"${other?.length ? '' : ' (nothing decided yet)'}`);
      out.push(...outline(other, `${at}.otherwise.`));
    } else if (k === 'condition') {
      out.push(`${at} condition "${s.label ?? ''}"`);
      out.push(...outline(s.yes as BpStep[], `${at}.yes.`));
      out.push(...outline(s.no as BpStep[], `${at}.no.`));
    } else out.push(`${at} ${k}`);
  });
  return out;
}
