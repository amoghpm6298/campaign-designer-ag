// ask_data: the main agent asks the bank's data a question, or puts a
// hypothesis to it, in plain English. A separate data-analyst model with
// read-only SQL works it out and answers with the numbers behind it.
//
// Why a helper: an investigation takes several queries and some trial and
// error. Doing it here keeps that out of the main agent's context, and every
// query the helper runs is recorded by code (not by the helper's say-so) and
// filed in the notebook, so nothing is hidden. It only reads; it never touches
// the campaign. Exact checks (e.g. who qualifies for an offer) stay in code.
import { callClaude, extractJson } from '../anthropic';
import { countCustomers, runWarehouseQuery, warehouseSchema } from '../warehouse';
import { signalsFor } from '../signals';
import { bucketContext } from '../../src/designer/v2/contextView';
import { addContext, log } from './state';
import type { AgentState } from './types';
import type { ToolEnv, ToolOutcome } from './tools';

/** Hidden caps: the helper isn't told the exact numbers in advance. */
const MAX_QUERIES = 8;
const MAX_ROUNDS = 12;
const MAX_MS = 150_000;
const ROWS_BACK = 40;

export interface QueryRecord {
  purpose: string;
  sql: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
  truncated?: boolean;
  error?: string;
}

export interface AskDataAnswer {
  /** Plain words: the bottom line first, the numbers behind it, then what the data can't tell (if anything). */
  answer: string;
  queries: QueryRecord[];
  /** When asked to size a bucket: one SELECT returning its customer_id values. */
  sizingSql?: string;
}

type Call = (system: string, messages: { role: 'user' | 'assistant'; content: string }[]) => Promise<string>;

const SYSTEM = `You are the bank's data analyst. Another agent, designing a card campaign, asks you a question or puts a hypothesis to you. Answer it from the bank's data, read-only.

How you work: reply with ONE JSON object and nothing else.
- To run a query: {"action":"query","purpose":"what you want to learn","sql":"ONE read-only SQLite SELECT or WITH … SELECT"}. You get the rows back (up to ${ROWS_BACK}). Aggregate in SQL; never pull raw customer rows.
- When you have enough: {"action":"answer","answer":"…"} (and, ONLY when asked to size a bucket, "sizingSql": ONE SELECT returning the customer_id values of that bucket: its rule, within the eligible population, excluding customers of every earlier bucket in priority order; test it with a query first). The answer is a few plain sentences: start with the bottom line (for a hypothesis, say plainly whether the data backs it); then the numbers behind it; end with what this data can't tell, only if that matters.

Rules:
- Treat the latest transaction date in the data as "today".
- Every number in your answer must be exactly what a query returned: same figures, same order; never round a ranking away or leave items out of a "top N".
- If part of the question can't be answered from these tables (e.g. no UPI data, no message history), say so, and answer only what the data can test.
- Prefer the bank's named signal definitions (given below) when the question uses those ideas, so your numbers match the rest of the campaign.
- Money arithmetic (cost of an offer) is a rough figure only: label it "rough, before the cost calculator".
- Be efficient: usually 2-6 queries.`;

function contextFor(state: AgentState, env: ToolEnv): string {
  const c = state.campaign;
  const views = bucketContext(state.context.entries);
  const buckets = [...c.buckets]
    .sort((a, b) => a.priority - b.priority)
    .map((b) => `- ${b.id} "${b.name}" (priority ${b.priority}): ${views[b.id]?.behaviour ?? '(no description yet)'}\n  rule: ${JSON.stringify(b.rule)}${views[b.id]?.sql ? `\n  sizing SQL: ${views[b.id]!.sql}` : ''}`);
  const sigs = signalsFor(env.tenant)
    .filter((s) => s.sql)
    .map((s) => `- ${s.key} (${s.label}): ${s.definition}\n  SQL: ${s.sql}`);
  const schema = warehouseSchema(env.warehouseBank!);
  const tables = schema.tables.map((t) => `- ${t.table} (${t.rows} rows): ${t.columns.map((col) => `${col.name}${col.examples ? ` [${col.examples.join('|')}]` : ''}`).join(', ')}`);
  return [
    `# The campaign`,
    `Goal: ${c.goal ? `${c.goal.eventType} (${c.goal.eventCategory})` : 'not set'}. Dates: ${c.schedule ? `${c.schedule.startDate} to ${c.schedule.endDate}` : 'not set'}.`,
    buckets.length ? `Buckets (checked in this order, first match wins):\n${buckets.join('\n')}` : 'No buckets yet.',
    `# The data (as of ${schema.dataAsOf ?? 'unknown'})`,
    tables.join('\n'),
    sigs.length ? `# The bank's named signals\n${sigs.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

const defaultCall: Call = async (system, messages) => (await callClaude({ system, messages, maxTokens: 2000, timeoutMs: 60_000 })).text;

/** Runs the analyst on one question. Code records every query it runs. */
export async function investigate(question: string, state: AgentState, env: ToolEnv, call: Call = defaultCall): Promise<AskDataAnswer> {
  const queries: QueryRecord[] = [];
  const messages: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: `${contextFor(state, env)}\n\n# The question\n${question}` }];
  const started = Date.now();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const outOfBudget = queries.length >= MAX_QUERIES || Date.now() - started > MAX_MS;
    if (outOfBudget) messages.push({ role: 'user', content: 'Limit reached: no more queries. Answer now with what you have, and say what you could not check.' });
    const text = await call(SYSTEM, messages);
    messages.push({ role: 'assistant', content: text });
    const parsed = extractJson<Record<string, unknown>>(text);
    if (!parsed.ok) {
      messages.push({ role: 'user', content: 'Reply with ONE JSON object only, as described.' });
      continue;
    }
    const v = parsed.value;
    if (v.action === 'answer' || outOfBudget) {
      return { answer: String(v.answer ?? '').trim() || 'No answer.', queries, ...(typeof v.sizingSql === 'string' && v.sizingSql.trim() ? { sizingSql: v.sizingSql.trim() } : {}) };
    }
    if (v.action === 'query' && typeof v.sql === 'string') {
      const rec: QueryRecord = { purpose: String(v.purpose ?? ''), sql: v.sql };
      try {
        const r = runWarehouseQuery(env.warehouseBank!, v.sql);
        rec.columns = r.columns;
        rec.rows = r.rows.slice(0, ROWS_BACK);
        rec.truncated = r.truncated || r.rows.length > ROWS_BACK;
      } catch (e) {
        rec.error = (e as Error).message;
      }
      queries.push(rec);
      messages.push({ role: 'user', content: rec.error ? `Query failed: ${rec.error}` : JSON.stringify({ columns: rec.columns, rows: rec.rows, truncated: rec.truncated }) });
      continue;
    }
    messages.push({ role: 'user', content: 'Use action "query" or "answer".' });
  }
  return { answer: 'The analysis did not finish: it ran out of rounds before answering.', queries };
}

/** Rows per query and characters in all, sent back to the main agent with the answer. */
const WORKBOOK_ROWS = 20;
const WORKBOOK_CHARS = 16_000;

/** The workbook as the main agent sees it: each query's purpose, SQL and the rows it returned (capped). */
export function workbookFor(queries: QueryRecord[]): { purpose: string; sql: string; columns?: string[]; rows?: Record<string, unknown>[]; moreRows?: boolean; error?: string }[] {
  let rows = WORKBOOK_ROWS;
  for (;;) {
    const wb = queries.map((q) => ({
      purpose: q.purpose,
      sql: q.sql,
      ...(q.error ? { error: q.error } : { columns: q.columns, rows: q.rows?.slice(0, rows), ...((q.rows?.length ?? 0) > rows || q.truncated ? { moreRows: true } : {}) }),
    }));
    if (JSON.stringify(wb).length <= WORKBOOK_CHARS || rows <= 3) return wb;
    rows = Math.max(3, Math.floor(rows / 2));
  }
}

/** The ask_data tool: investigate, file the answer and its queries in the notebook, report back with the workbook. */
export async function runAskData(input: Record<string, unknown>, state: AgentState, env: ToolEnv, call?: Call): Promise<ToolOutcome> {
  let question = typeof input.question === 'string' ? input.question.trim() : '';
  const sizeBucket = typeof input.sizeBucket === 'string' ? input.sizeBucket.trim() : '';
  if (!question) return { state, ok: false, summary: 'No question', forModel: 'Give question: a question or a hypothesis, in plain English.' };
  if (!env.warehouseBank) return { state, ok: false, summary: 'No data access', forModel: 'This bank has no data access, so there is no data to ask. Work from the manager and your judgement, and say so.' };
  const bucket = sizeBucket ? state.campaign.buckets.find((b) => b.id === sizeBucket) : undefined;
  if (sizeBucket && !bucket) return { state, ok: false, summary: 'Unknown bucket', forModel: `There is no bucket "${sizeBucket}".` };
  if (bucket) question += `\n\nAlso SIZE bucket "${bucket.id}" ("${bucket.name}", priority ${bucket.priority}): give sizingSql.`;
  let a: AskDataAnswer;
  try {
    a = await investigate(question, state, env, call);
  } catch (e) {
    return { state, ok: false, summary: 'Analysis failed', forModel: `The data analysis failed: ${(e as Error).message}. Try again once, or ask a simpler question.` };
  }
  const ok = a.queries.filter((q) => !q.error);
  const topic = `ask: ${question.replace(/\s+/g, ' ').slice(0, 60)}`;
  // Filed in the notebook as research, with every query (re-runnable), so the reasoning is visible.
  const entries: Record<string, unknown>[] = [
    {
      kind: 'research',
      topic,
      text: a.answer,
      source: 'data',
      data: { question, queries: a.queries.map((q) => ({ purpose: q.purpose, sql: q.sql, columns: q.columns, rows: q.rows?.slice(0, 10), error: q.error })) },
    },
  ];
  let sized: { bucket: string; customers?: number; error?: string } | undefined;
  if (bucket) {
    if (!a.sizingSql) sized = { bucket: bucket.id, error: 'The analyst did not give a sizing query.' };
    else
      try {
        const n = countCustomers(env.warehouseBank, a.sizingSql);
        entries.push({ kind: 'sizing', bucketId: bucket.id, topic: 'size', text: `Sized by the data analyst: ${bucket.name}.`, source: 'data', data: { sql: a.sizingSql, size: n } });
        sized = { bucket: bucket.id, customers: n };
      } catch (e) {
        sized = { bucket: bucket.id, error: `The sizing query failed: ${(e as Error).message}` };
      }
  }
  const filed = addContext(state, entries);
  const next = log(filed.state, 'agent', 'context_added', `Asked the data: ${question.slice(0, 120)}`);
  return {
    state: next,
    ok: true,
    doneTitle: 'Asked the data',
    summary: `${ok.length} quer${ok.length === 1 ? 'y' : 'ies'}${sized?.customers != null ? ` · sized ${sized.customers.toLocaleString('en-IN')}` : ''}`,
    result: { answer: a.answer, queries: a.queries.map((q) => ({ purpose: q.purpose, sql: q.sql, error: q.error })), ...(sized ? { sized } : {}) },
    forModel: JSON.stringify({
      answer: a.answer,
      workbook: workbookFor(a.queries),
      ...(sized ? { sized } : {}),
      filedAs: `research note "${topic}" in the notebook`,
    }),
  };
}
