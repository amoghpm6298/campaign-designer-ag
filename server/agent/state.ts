// Pure state transitions for the v2 agent: flags, timeline, plan file, questions.
// No I/O and no model calls, so every rule here is unit-testable.

import {
  AGENT_FLAGS,
  FLAG_LABELS,
  FLAG_ORDER,
  type AgentQuestion,
  type AgentState,
  type AnswerType,
  type BriefFinding,
  type FlagName,
  type Flags,
  type PlanFile,
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
    planFile: { brief: { findings: [] }, strategy: null, journey: null },
    flags: initialFlags(),
    timeline: [],
    questions: [],
    pendingSignoff: null,
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
  return {
    planFile: {
      brief: { findings: Array.isArray(s.planFile?.brief?.findings) ? s.planFile!.brief.findings : [], summary: s.planFile?.brief?.summary, updatedAt: s.planFile?.brief?.updatedAt },
      strategy: s.planFile?.strategy ?? null,
      journey: s.planFile?.journey ?? null,
    },
    flags,
    timeline: Array.isArray(s.timeline) ? s.timeline : [],
    questions: Array.isArray(s.questions) ? s.questions : [],
    pendingSignoff: s.pendingSignoff === 'brief' || s.pendingSignoff === 'plan' ? s.pendingSignoff : null,
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

/** The app-owned flag: true exactly when every question asked so far has an answer. */
export function syncQuestionsAnswered(state: AgentState): AgentState {
  const all = state.questions.length > 0 && state.questions.every((q) => q.answer && q.answer.trim());
  return setFlag(state, 'questionsAnswered', all, 'app', all ? 'every question has an answer' : 'a question is still open');
}

// --- questions ------------------------------------------------------------

const titleCase = (s: string) =>
  s
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');

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
 * - With free text only, the reply is taken as answering every open question — the agent reads it
 *   and can re-ask anything it did not cover.
 */
export function recordAnswers(state: AgentState, answers: Record<string, string> | undefined, freeText: string): AgentState {
  const open = state.questions.filter((q) => !q.answer?.trim());
  if (!open.length) return state;
  const at = now();
  let answeredIds: string[] = [];
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
  answeredIds = [...new Set(answeredIds)];
  if (!answeredIds.length) return state;
  let next: AgentState = { ...state, questions };
  const stillOpen = questions.filter((q) => !q.answer?.trim()).length;
  next = log(next, 'user', 'answers_received', `Answered ${answeredIds.length} question${answeredIds.length === 1 ? '' : 's'}${stillOpen ? `; ${stillOpen} still open` : ''}`);
  return syncQuestionsAnswered(next);
}

// --- plan file ------------------------------------------------------------

/**
 * Editing a signed-off section re-opens it: the manager agreed to the old version, not this one.
 * Brief edits clear both sign-offs; plan edits clear the plan's.
 */
function reopenAfterEdit(state: AgentState, section: 'brief' | 'strategy' | 'journey'): AgentState {
  let next = state;
  if (section === 'brief') {
    next = setFlag(next, 'briefSignedOff', false, 'app', 'the brief changed after sign-off');
    next = setFlag(next, 'planSignedOff', false, 'app', 'the brief it rests on changed');
  } else {
    next = setFlag(next, 'planSignedOff', false, 'app', 'the plan changed after sign-off');
  }
  return next;
}

const cleanFindings = (v: unknown): BriefFinding[] => {
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
  return list
    .map((f) => (f ?? {}) as Record<string, unknown>)
    .filter((f) => typeof f.text === 'string' && f.text.trim())
    .map((f) => ({
      aspect: typeof f.aspect === 'string' && f.aspect.trim() ? titleCase(f.aspect).slice(0, 40) : 'General',
      text: String(f.text).trim(),
      source: f.source === 'assumption' ? 'assumption' : 'manager',
    }));
};

export interface PlanUpdate {
  section?: unknown;
  findings?: unknown;
  replaceFindings?: unknown;
  summary?: unknown;
  strategy?: unknown;
  journey?: unknown;
}

export function updatePlanFile(state: AgentState, input: PlanUpdate): { state: AgentState; said: string; error?: string } {
  const section = input.section;
  const at = now();
  const wasSigned = (s: 'brief' | 'plan') => (s === 'brief' ? state.flags.briefSignedOff : state.flags.planSignedOff);

  if (section === 'brief') {
    const incoming = cleanFindings(input.findings);
    const summary = typeof input.summary === 'string' && input.summary.trim() ? input.summary.trim() : state.planFile.brief.summary;
    if (!incoming.length && summary === state.planFile.brief.summary) return { state, said: '', error: 'Send at least one finding ({aspect, text, source}) or a summary.' };
    let findings: BriefFinding[];
    if (input.replaceFindings === true) findings = incoming;
    else {
      // Merge by aspect: a new finding for an aspect replaces the old one for that aspect.
      const byAspect = new Map(state.planFile.brief.findings.map((f) => [f.aspect.toLowerCase(), f]));
      for (const f of incoming) byAspect.set(f.aspect.toLowerCase(), f);
      findings = [...byAspect.values()];
    }
    const planFile: PlanFile = { ...state.planFile, brief: { findings, summary, updatedAt: at } };
    let next: AgentState = { ...state, planFile };
    next = log(next, 'agent', 'plan_section_updated', `Updated the brief (${incoming.map((f) => f.aspect).join(', ') || 'summary'})`);
    if (wasSigned('brief')) next = reopenAfterEdit(next, 'brief');
    return { state: next, said: `Updated the brief: ${findings.length} finding${findings.length === 1 ? '' : 's'} on file.` };
  }

  if (section === 'strategy') {
    const s = (input.strategy ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof s[k] === 'string' && (s[k] as string).trim() ? (s[k] as string).trim() : undefined);
    const strategy = {
      ...(state.planFile.strategy ?? {}),
      ...Object.fromEntries(
        (['hypothesis', 'approach', 'alternative', 'whyNotAlternative', 'measurement'] as const).map((k) => [k, str(k)]).filter(([, v]) => v),
      ),
      ...(Array.isArray(s.risks) ? { risks: s.risks.filter((r): r is string => typeof r === 'string' && !!r.trim()) } : {}),
      updatedAt: at,
    };
    let next: AgentState = { ...state, planFile: { ...state.planFile, strategy } };
    next = log(next, 'agent', 'plan_section_updated', 'Updated the strategy');
    if (wasSigned('plan')) next = reopenAfterEdit(next, 'strategy');
    return { state: next, said: 'Updated the strategy.' };
  }

  if (section === 'journey') {
    const bp = input.journey as Record<string, unknown> | undefined;
    if (!bp || typeof bp !== 'object' || !bp.entry || !Array.isArray(bp.steps) || !bp.steps.length) {
      return { state, said: '', error: 'journey needs {campaignName, description, entry, steps[]} with at least one step.' };
    }
    const blueprint = { campaignName: '', description: '', goal: null, ...bp } as unknown as NonNullable<PlanFile['journey']>['blueprint'];
    let next: AgentState = { ...state, planFile: { ...state.planFile, journey: { blueprint, updatedAt: at } } };
    next = log(next, 'agent', 'plan_section_updated', `Updated the journey (${countSteps(bp.steps)} steps)`);
    if (wasSigned('plan')) next = reopenAfterEdit(next, 'journey');
    return { state: next, said: `Updated the journey: ${countSteps(bp.steps)} steps.` };
  }

  return { state, said: '', error: 'section must be "brief", "strategy" or "journey".' };
}

function countSteps(steps: unknown): number {
  if (!Array.isArray(steps)) return 0;
  let n = 0;
  for (const s of steps) {
    n++;
    const o = (s ?? {}) as Record<string, unknown>;
    for (const key of ['arms', 'branches', 'paths']) {
      const list = o[key];
      if (Array.isArray(list)) for (const arm of list) n += countSteps((arm as Record<string, unknown>)?.steps);
    }
    for (const key of ['yes', 'no']) if (Array.isArray(o[key])) n += countSteps(o[key]);
  }
  return n;
}

// --- sign-off ---------------------------------------------------------------

export function requestSignoff(state: AgentState, section: 'brief' | 'plan', note: string): AgentState {
  let next = setFlag(state, section === 'brief' ? 'briefReady' : 'planReady', true, 'agent', 'ready for sign-off');
  next = { ...next, pendingSignoff: section };
  return log(next, 'agent', 'signoff_requested', `Asked the manager to sign off the ${section}${note ? `: ${note}` : ''}`);
}

export function signOff(state: AgentState, section: 'brief' | 'plan', actor: 'user' | 'agent', note: string): AgentState {
  // One timeline line for a sign-off, not one per flag it touches.
  let next = setFlag(state, section === 'brief' ? 'briefSignedOff' : 'planSignedOff', true, actor, note, true);
  next = setFlag(next, section === 'brief' ? 'briefReady' : 'planReady', true, 'app', '', true);
  next = { ...next, pendingSignoff: next.pendingSignoff === section ? null : next.pendingSignoff };
  return log(next, actor, 'signed_off', `${section === 'brief' ? 'Brief' : 'Plan'} signed off${actor === 'agent' ? ' in chat' : ''}${note ? `: ${note}` : ''}`);
}

export function requestChanges(state: AgentState, section: 'brief' | 'plan', note: string): AgentState {
  let next: AgentState = { ...state, pendingSignoff: null };
  next = setFlag(next, section === 'brief' ? 'briefReady' : 'planReady', false, 'user', 'changes requested');
  return log(next, 'user', 'changes_requested', `Asked for changes to the ${section}${note ? `: ${note}` : ''}`);
}

/**
 * The guidance the prompt gives, checked after the fact. Never blocks: it only
 * writes a visible line when the agent moved ahead of the flags.
 */
export function aheadOfFlags(state: AgentState, action: 'plan' | 'build'): string | null {
  if (action === 'plan' && !state.flags.briefSignedOff) return 'Wrote the plan before the brief was signed off';
  if (action === 'build' && !state.flags.planSignedOff) return 'Built the campaign before the plan was signed off';
  return null;
}

export function flagSummary(flags: Flags): string {
  return FLAG_ORDER.map((f) => `${f}: ${flags[f] ? 'true' : 'false'}`).join('\n');
}
