// In-turn context compaction, after the propensity agent's
// services/context_compaction.py: the same trigger (a cutoff at 75% of the
// model's context window, overridable), the same two tiers (mask old query
// rows oldest-first until under the cutoff; then an AI recap of the older part)
// and the same emergency path (the API refuses the prompt as too long: force
// both tiers once and retry).
//
// One adaptation. The propensity agent compacts at turn boundaries; here the
// context only grows WITHIN a turn (between turns the agent restarts from the
// chat text, the two stores and the status block), so the boundary is "the last
// KEEP_ROUNDS rounds of this turn" instead of "the last 2 user turns". A cut
// never separates a tool_use from its tool_result: the kept tail always starts
// at an assistant message, and the turn's opening messages are never touched.
//
// Nothing is reworded in tier 1, so no number can drift. The agent's own query
// rows are filed in the notebook (see run_sql_query), so a masked result
// points there instead of losing the evidence.

export type ApiMessage = { role: "user" | "assistant"; content: unknown };
type Block = Record<string, unknown>;

/** Rough token estimate, as the propensity agent does it (no tokenizer). */
export const CHARS_PER_TOKEN = 3.7;
export const estimateTokens = (messages: unknown): number =>
  Math.ceil(JSON.stringify(messages).length / CHARS_PER_TOKEN);

/** Context windows (input tokens), checked against the Claude API model list (Nov 2026). */
const WINDOWS: [RegExp, number][] = [
  [/^claude-(sonnet|opus|fable|mythos|haiku)-5/, 1_000_000],
  [/^claude-(sonnet|opus)-4-[678]/, 1_000_000],
];
const DEFAULT_WINDOW = 200_000;
export const contextWindow = (model: string): number =>
  WINDOWS.find(([re]) => re.test(model))?.[1] ?? DEFAULT_WINDOW;

/** The cutoff: COMPACT_CUTOFF_TOKENS if set, else 75% of the model's window (the propensity default). */
export function compactionCutoff(
  model: string,
  env: Record<string, string | undefined> = process.env,
): number {
  const set = Number(env.COMPACT_CUTOFF_TOKENS);
  return Number.isFinite(set) && set > 0
    ? Math.round(set)
    : Math.round(contextWindow(model) * 0.75);
}

/** Rounds of this turn kept verbatim (forced: fewer, as in the propensity agent). */
export const KEEP_ROUNDS = 5;
export const KEEP_ROUNDS_FORCED = 2;
/** Rows kept in a masked result. */
const MASK_ROW_KEEP = 1;
/** Results above this size (characters) that have no rows are cut to their start. */
const LONG_RESULT = 2_000;
const LONG_RESULT_KEEP = 600;

/**
 * Where the kept tail starts: the assistant message that opens the KEEP-th last round.
 * Null when there is nothing older than the tail to compact.
 */
export function tailStart(
  messages: ApiMessage[],
  baseLen: number,
  keep: number,
): number | null {
  const starts: number[] = [];
  for (let i = baseLen; i < messages.length; i++)
    if (messages[i].role === "assistant") starts.push(i);
  if (starts.length <= keep) return null;
  return starts[starts.length - keep];
}

/** tool_use id → tool name, for the messages given. */
function toolNames(messages: ApiMessage[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of messages)
    if (m.role === "assistant" && Array.isArray(m.content))
      for (const b of m.content as Block[])
        if (b.type === "tool_use" && typeof b.id === "string")
          out.set(b.id, String(b.name ?? ""));
  return out;
}

/** One tool result's text, made smaller; null when there is nothing to save. */
export function maskResult(tool: string, text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const o = { ...(parsed as Record<string, unknown>) };
    let changed = false;
    // Query rows: keep the first, say how many went and where they are filed.
    if (Array.isArray(o.rows) && o.rows.length > MASK_ROW_KEEP) {
      const n = o.rows.length;
      o.rows = o.rows.slice(0, MASK_ROW_KEEP);
      o._rows_omitted = n - MASK_ROW_KEEP;
      o._rows_note =
        tool === "run_sql_query"
          ? 'Older result shortened to save space. All rows are filed in the notebook (kind "research", topic "query: <its purpose>"); get_context to re-read them, or re-run the query.'
          : "Older result shortened to save space; call the tool again if you need it.";
      changed = true;
    }
    // ask_data's workbook: each query's rows, the same way.
    if (Array.isArray(o.workbook)) {
      o.workbook = (o.workbook as Block[]).map((q) => {
        if (!Array.isArray(q.rows) || q.rows.length <= MASK_ROW_KEEP) return q;
        changed = true;
        return {
          ...q,
          rows: q.rows.slice(0, MASK_ROW_KEEP),
          _rows_omitted: q.rows.length - MASK_ROW_KEEP,
        };
      });
      if (changed)
        o._rows_note = `Older result shortened to save space. The full workbook is filed in the notebook (${String(o.filedAs ?? "the research note")}).`;
    }
    if (changed) return JSON.stringify(o);
  }
  // Anything else that is large (a whole-campaign read, a long lookup): its start, and a pointer.
  if (text.length > LONG_RESULT)
    return `${text.slice(0, LONG_RESULT_KEEP)}… [older result shortened to save space; call ${tool || "the tool"} again if you need it]`;
  return null;
}

/**
 * Tier 1: masks tool results older than the kept tail, oldest first, stopping as soon as the
 * estimate is under the cutoff (or, when forced, masking everything older). Returns a new array.
 */
export function maskOldResults(
  messages: ApiMessage[],
  baseLen: number,
  cutoff: number,
  force = false,
): { messages: ApiMessage[]; masked: number } {
  const tail = tailStart(
    messages,
    baseLen,
    force ? KEEP_ROUNDS_FORCED : KEEP_ROUNDS,
  );
  if (tail == null) return { messages, masked: 0 };
  const names = toolNames(messages);
  const out = messages.map((m) => ({
    ...m,
    content: Array.isArray(m.content) ? [...(m.content as Block[])] : m.content,
  }));
  let masked = 0;
  for (let i = baseLen; i < tail; i++) {
    const m = out[i];
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    const blocks = m.content as Block[];
    for (let j = 0; j < blocks.length; j++) {
      const b = blocks[j];
      if (b.type !== "tool_result" || typeof b.content !== "string") continue;
      const smaller = maskResult(
        names.get(String(b.tool_use_id)) ?? "",
        b.content,
      );
      if (smaller == null || smaller.length >= b.content.length) continue;
      blocks[j] = { ...b, content: smaller };
      masked++;
    }
    if (!force && estimateTokens(out) <= cutoff) break;
  }
  return { messages: out, masked };
}

/** The recap prompt, adapted from the propensity agent's (context_compaction.py:46-53). */
export const SUMMARY_SYSTEM = `You are compacting a campaign-design agent's working steps so they fit the model's context window. Produce a COMPACT recap (at most about 800 tokens) capturing, in order: (1) what the manager asked for in this turn, (2) key findings, (3) decisions taken and what is already built or edited, (4) open threads and what was about to happen next.
Rules: copy every number EXACTLY as it appears, with its unit, and say where it came from (the query purpose or the notebook topic); never round, never invent a number. If unsure whether a detail matters, keep it. Prefer pointing to the notebook (kind "research", topic "query: …") over restating long results. Output only the recap, no preamble.`;

/** The older part, as text for the recap: results capped, the whole input capped. */
function prefixText(messages: ApiMessage[], from: number, to: number): string {
  const names = toolNames(messages);
  const parts: string[] = [];
  for (let i = from; i < to; i++) {
    const m = messages[i];
    if (typeof m.content === "string") {
      parts.push(`${m.role.toUpperCase()}: ${m.content}`);
      continue;
    }
    for (const b of (m.content as Block[]) ?? []) {
      if (b.type === "text")
        parts.push(`${m.role.toUpperCase()}: ${String(b.text)}`);
      else if (b.type === "tool_use")
        parts.push(
          `TOOL CALL ${String(b.name)}: ${JSON.stringify(b.input).slice(0, 1_500)}`,
        );
      else if (b.type === "tool_result") {
        const tool = names.get(String(b.tool_use_id)) ?? "tool";
        const text =
          typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        parts.push(
          `RESULT ${tool}${b.is_error ? " (failed)" : ""}: ${(maskResultForSummary(text) ?? text).slice(0, 4_000)}`,
        );
      }
    }
  }
  return parts.join("\n").slice(0, 120_000);
}

/** For the recap's input: query results capped at 20 rows (as the propensity agent does). */
function maskResultForSummary(text: string): string | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (o && Array.isArray(o.rows) && o.rows.length > 20)
      return JSON.stringify({
        ...o,
        rows: o.rows.slice(0, 20),
        _rows_omitted: o.rows.length - 20,
      });
  } catch {
    /* not JSON */
  }
  return null;
}

export type Summarise = (system: string, text: string) => Promise<string>;

/**
 * Tier 2: replaces everything between the turn's opening messages and the kept tail with one
 * recap. Fails closed: on an error or an empty recap the input comes back unchanged (when forced,
 * a placeholder stands in, as in the propensity agent).
 */
export async function summariseOldSteps(
  messages: ApiMessage[],
  baseLen: number,
  summarise: Summarise,
  force = false,
): Promise<{ messages: ApiMessage[]; summarised: boolean }> {
  const tail = tailStart(
    messages,
    baseLen,
    force ? KEEP_ROUNDS_FORCED : KEEP_ROUNDS,
  );
  if (tail == null || tail <= baseLen) return { messages, summarised: false };
  let recap = "";
  try {
    recap = (
      await summarise(SUMMARY_SYSTEM, prefixText(messages, baseLen, tail))
    ).trim();
  } catch {
    recap = "";
  }
  if (!recap && !force) return { messages, summarised: false };
  const text = recap
    ? `[Summary of earlier steps in this turn]\n${recap}\n(Full query results are in the notebook: get_context kind "research".)`
    : "[Earlier steps in this turn were omitted to fit the context window. Re-read the campaign (get_campaign) and the notebook (get_context) before continuing.]";
  return {
    messages: [
      ...messages.slice(0, baseLen),
      { role: "user", content: text },
      ...messages.slice(tail),
    ],
    summarised: true,
  };
}

export interface CompactionResult {
  messages: ApiMessage[];
  tier: 0 | 1 | 2;
  before: number;
  after: number;
  masked: number;
}

/**
 * Runs before a model call. Under the cutoff: nothing. Over it: tier 1, then tier 2 if still over.
 * force (the API refused the prompt as too long): both tiers, keeping fewer rounds.
 */
export async function compactIfNeeded(
  messages: ApiMessage[],
  opts: {
    baseLen: number;
    cutoff: number;
    estimate?: number;
    summarise: Summarise;
    force?: boolean;
  },
): Promise<CompactionResult> {
  const before = opts.estimate ?? estimateTokens(messages);
  if (!opts.force && before <= opts.cutoff)
    return { messages, tier: 0, before, after: before, masked: 0 };
  const t1 = maskOldResults(messages, opts.baseLen, opts.cutoff, opts.force);
  let after = estimateTokens(t1.messages);
  if (!opts.force && after <= opts.cutoff)
    return { messages: t1.messages, tier: 1, before, after, masked: t1.masked };
  const t2 = await summariseOldSteps(
    t1.messages,
    opts.baseLen,
    opts.summarise,
    opts.force,
  );
  after = estimateTokens(t2.messages);
  return {
    messages: t2.messages,
    tier: t2.summarised ? 2 : t1.masked ? 1 : 0,
    before,
    after,
    masked: t1.masked,
  };
}

/** The API's refusal of a prompt that is too long for the window. */
export const isTooLong = (e: unknown): boolean => {
  const status = (e as { status?: number })?.status;
  const msg = String((e as Error)?.message ?? "");
  return (
    (status === 400 || status === 413) &&
    /prompt is too long|too many (input )?tokens|context (window|length)|exceeds? .*(context|maximum)/i.test(
      msg,
    )
  );
};
