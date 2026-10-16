// Server-side Anthropic client. The ONLY place an API key is read.
//
// Deliberately plain fetch rather than an SDK dependency: the whole surface
// is one POST and one GET, Node 24 has global fetch, and the repo has no
// runtime deps beyond React/dagre/xyflow. Nothing here is bundled for the
// browser — this module is imported only by the Vite dev-server middleware.
//
// Provider: Anthropic only. Model: Sonnet only, from ANTHROPIC_MODEL.
// There is no fallback to another provider, another model family, or a mock.

const API = 'https://api.anthropic.com/v1';
const API_VERSION = '2023-06-01';

/** The default is the current Sonnet identifier; override with ANTHROPIC_MODEL. */
export const DEFAULT_MODEL = 'claude-sonnet-5';

export class AnthropicConfigError extends Error {
  readonly kind = 'config';
}
export class AnthropicCallError extends Error {
  readonly kind = 'call';
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export function resolveModel(): string {
  const m = (process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL).trim();
  if (!m) throw new AnthropicConfigError('ANTHROPIC_MODEL is set but empty.');
  // Sonnet only. A Haiku/Opus id here is a configuration mistake, not
  // something to silently accept.
  if (!/sonnet/i.test(m)) {
    throw new AnthropicConfigError(
      `ANTHROPIC_MODEL="${m}" is not a Sonnet model. This prototype uses Claude Sonnet exclusively.`,
    );
  }
  return m;
}

function apiKey(): string {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k || !k.trim()) {
    throw new AnthropicConfigError(
      'ANTHROPIC_API_KEY is not set on the server. Copy .env.example to .env and add your key, then restart the dev server.',
    );
  }
  return k.trim();
}

/** True when a key is present. Never returns or logs the key itself. */
export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/**
 * Checks the configured model against the ids the API actually reports.
 * Returns a structured result rather than throwing, so the UI can show a
 * precise configuration error.
 */
export async function verifyModel(): Promise<{
  ok: boolean;
  model: string;
  available?: string[];
  error?: string;
}> {
  let model: string;
  try {
    model = resolveModel();
  } catch (e) {
    return { ok: false, model: process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL, error: (e as Error).message };
  }
  try {
    const res = await fetch(`${API}/models?limit=100`, {
      headers: { 'x-api-key': apiKey(), 'anthropic-version': API_VERSION },
    });
    if (!res.ok) {
      return { ok: false, model, error: `Anthropic /models returned ${res.status}. Check ANTHROPIC_API_KEY.` };
    }
    const body = (await res.json()) as { data?: { id: string }[] };
    const ids = (body.data ?? []).map((m) => m.id);
    const sonnets = ids.filter((i) => /sonnet/i.test(i));
    if (!ids.includes(model)) {
      return {
        ok: false,
        model,
        available: sonnets,
        error: `ANTHROPIC_MODEL="${model}" is not in the list of models this key can access. Available Sonnet ids: ${sonnets.join(', ') || 'none'}.`,
      };
    }
    return { ok: true, model, available: sonnets };
  } catch (e) {
    return { ok: false, model, error: `Could not reach the Anthropic API: ${(e as Error).message}` };
  }
}

export interface LlmCallResult {
  text: string;
  model: string;
  durationMs: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  stopReason?: string;
}

/**
 * One Messages API call. `system` is a plain instruction string; `messages`
 * is the conversation. Caller parses the text — this layer stays transport.
 */
export async function callClaude(opts: {
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<LlmCallResult> {
  const model = resolveModel();
  const key = apiKey();
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 90_000);

  try {
    const res = await fetch(`${API}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 4096,
        system: opts.system,
        messages: opts.messages,
      }),
      signal: controller.signal,
    });

    const durationMs = Date.now() - started;
    if (!res.ok) {
      // The error body can echo request content but never the key (it is a
      // header). Truncated so a long body cannot flood a log.
      const body = await res.text().catch(() => '');
      throw new AnthropicCallError(`Anthropic API error ${res.status}: ${body.slice(0, 400)}`, res.status);
    }
    const json = (await res.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string;
    };
    const text = (json.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
    return { text, model, durationMs, usage: json.usage, stopReason: json.stop_reason };
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new AnthropicCallError(`Anthropic API call timed out after ${opts.timeoutMs ?? 90_000}ms.`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extracts the first JSON object from a model response. Models sometimes wrap
 * JSON in prose or a fenced block even when asked not to, and a malformed
 * payload must be a clean, reportable failure rather than a crash deep in the
 * campaign builder.
 */
export function extractJson<T>(
  text: string,
  stopReason?: string,
): { ok: true; value: T } | { ok: false; error: string; raw: string } {
  // Truncation is a different failure from malformed output, and conflating
  // the two sends you looking for a prompt bug when the real fix is a bigger
  // token budget. Diagnosed first, and named.
  if (stopReason === 'max_tokens') {
    return {
      ok: false,
      error:
        'The model ran out of output tokens mid-response, so the JSON is incomplete. This is a truncation, not a formatting problem — raise maxTokens or ask for a smaller campaign.',
      raw: text.slice(-600),
    };
  }
  // An empty turn is a THIRD failure, and it was being reported as the second.
  // A real run ended with stop_reason 'end_turn' and not one character of
  // text, and the user was told the JSON was unparseable — which sent the
  // diagnosis towards the prompt when nothing had been written at all.
  if (!text.trim()) {
    return {
      ok: false,
      error: `The model returned no text at all (stop reason: ${stopReason ?? 'unknown'}), so there was nothing to read. This is an empty response, not a formatting problem.`,
      raw: '',
    };
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text].filter((s): s is string => Boolean(s));
  for (const c of candidates) {
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      return { ok: true, value: JSON.parse(c.slice(start, end + 1)) as T };
    } catch {
      /* try the next candidate */
    }
  }
  return { ok: false, error: 'The model did not return parseable JSON.', raw: text.slice(0, 600) };
}

// --- streaming + tool use -------------------------------------------

export interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface StreamChunk {
  /** Incremental assistant text, as the API emits it. Never re-chunked locally. */
  text?: string;
  /** A completed tool_use block the model is requesting. */
  toolUse?: ToolUseBlock;
  done?: {
    stopReason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    /** Full assistant content, for appending to the conversation. */
    content: unknown[];
    /**
     * The turn's complete visible text, assembled from the finished content
     * blocks rather than from the deltas.
     *
     * The caller used to reconstruct this by concatenating `text` chunks,
     * which silently assumes every text block arrives as deltas. A block that
     * arrives complete on content_block_start carries its text there and
     * emits no delta at all, so that text existed in `content` and was
     * invisible to the caller — which reads downstream as "the model returned
     * nothing".
     */
    text: string;
  };
  /**
   * Metadata about the finished turn, for diagnosis. Block TYPES only — never
   * block contents, so thinking never leaves this module.
   */
  diagnostics?: {
    blockTypes: string[];
    textChars: number;
    textFromDeltas: number;
    toolUses: number;
  };
}

export type ApiMessage = { role: 'user' | 'assistant'; content: unknown };

/**
 * Streams one Messages API call, yielding deltas as the provider sends them.
 *
 * This uses Anthropic's real SSE stream. Text is forwarded exactly as it
 * arrives — nothing is buffered to completion and then split up, which would
 * only look like streaming.
 */
export async function* streamClaude(opts: {
  system: string;
  messages: ApiMessage[];
  tools?: unknown[];
  /**
   * Anthropic's tool_choice. `{ type: 'none' }` stops the model calling a
   * tool WITHOUT removing the definitions — which matters, because a
   * conversation that already contains tool_use and tool_result blocks has to
   * keep carrying its tools to stay coherent.
   */
  toolChoice?: unknown;
  maxTokens?: number;
  /**
   * Turn extended thinking off for this call.
   *
   * MEASURED, not guessed. Replaying the exact withdrawal round — history
   * containing tool_use/tool_result blocks, tool_choice 'none', the
   * "STOP CALLING TOOLS" system suffix — the model returned `stop_reason:
   * end_turn` with a single `thinking` block and NO text, 3 times out of 3,
   * burning 1,719-3,841 output tokens on reasoning it then never spoke.
   * Appending an explicit instruction to the final user turn moved that to
   * only 1 in 3.
   *
   * Disabling thinking on that one round: 4 of 4 produced text, in 1.9-14.7s
   * against 20-47s. The round has nothing left to reason about — every lookup
   * is already in the history and the task is to write down the answer.
   */
  disableThinking?: boolean;
  timeoutMs?: number;
  /** Abort if no chunk arrives for this long, once streaming has started. */
  idleMs?: number;
  signal?: AbortSignal;
}): AsyncGenerator<StreamChunk> {
  const model = resolveModel();
  const key = apiKey();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort);
  // Diagnosis, not behaviour. The abort below is a TOTAL budget for the whole
  // stream, so "timed out" currently cannot distinguish a long response being
  // killed while it streams healthily from a connection that opened and went
  // silent. Those need opposite fixes — an idle timeout for the first, nothing
  // at all for the second — and I have twice guessed which it was. These three
  // numbers settle it from one real failure.
  const started = Date.now();
  let chunks = 0;
  let lastChunkAt = 0;
  // TOTAL budget. Raised from 180s once the idle watchdog below existed.
  //
  // MEASURED, twice: "8 chunks received, 27927ms since the last one" and
  // "6 chunks received, 29001ms since the last one", both at the 180s mark.
  // Read it carefully and it is not a stall: chunks were still arriving at
  // ~150s, and the budget cut off a stream that was alive. A propose turn
  // writes a whole campaign, and that takes longer than three minutes.
  //
  // Safe to raise ONLY because the watchdog below kills a genuinely dead
  // connection in its own time regardless of this number. Raising the total
  // budget without an idle check would have meant waiting seven minutes on a
  // connection that died in thirty seconds.
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 420_000);

  // IDLE WATCHDOG, added after the diagnosis above paid off.
  //
  // The measured failure is always the same shape: several chunks arrive, then
  // the connection goes quiet and never recovers. The total budget above still
  // has to run all the way down before the attempt gives up, so a stall that
  // is obvious after thirty seconds costs a hundred and eighty. One turn burned
  // four attempts and twelve minutes that way, all of it spent waiting on a
  // connection that was already dead.
  //
  // This does not make calls succeed more often. It makes a dead one fail fast
  // so the retry starts sooner, which is the whole gain.
  //
  // Armed only AFTER the first chunk. Time to first token is legitimately long
  // and varies with load, so an idle timer running before then would abort
  // healthy requests.
  //
  // 90s, not the 45s this started at. That first number rested on my claim
  // that "between chunks of a live stream the gap is well under a second",
  // which the logs then contradicted: gaps of 27.9s and 29.0s both showed up
  // in healthy streams. 45s was a far thinner margin than I described, and
  // would have started killing long generations that were working. 90s is
  // three times the largest gap actually observed, and still kills a dead
  // connection in well under a quarter of the total budget.
  const idleMs = opts.idleMs ?? 90_000;
  const idleWatch = setInterval(() => {
    if (lastChunkAt && Date.now() - lastChunkAt > idleMs) controller.abort();
  }, 5_000);

  try {
    const res = await fetch(`${API}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model,
        // Default raised with the call sites. A truncated answer is reported
        // honestly below, but the honest report is still a failed turn.
        max_tokens: opts.maxTokens ?? 32000,
        system: opts.system,
        messages: opts.messages,
        ...(opts.disableThinking ? { thinking: { type: 'disabled' } } : {}),
        ...(opts.tools?.length ? { tools: opts.tools } : {}),
        ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new AnthropicCallError(`Anthropic API error ${res.status}: ${body.slice(0, 400)}`, res.status);
    }

    // Assembled as blocks arrive, so the caller gets a complete assistant
    // turn to append to the conversation for the next tool round.
    const content: Record<string, unknown>[] = [];
    const partialJson: Record<number, string> = {};
    let deltaChars = 0;
    let stopReason: string | undefined;
    let usage: { input_tokens?: number; output_tokens?: number } | undefined;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks++;
      lastChunkAt = Date.now();
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        let ev: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        try {
          ev = JSON.parse(dataLine.slice(5).trim());
        } catch {
          continue; // a malformed frame must not kill the run
        }

        if (ev.type === 'content_block_start') {
          content[ev.index] = { ...ev.content_block };
          if (ev.content_block?.type === 'tool_use') partialJson[ev.index] = '';
          // A text block can arrive COMPLETE here, with no delta to follow.
          // Forward it, or it would stream to nobody.
          const opening = ev.content_block;
          if (opening?.type === 'text' && typeof opening.text === 'string' && opening.text.length) {
            yield { text: opening.text };
          }
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta?.type === 'text_delta') {
            const block = content[ev.index] ?? (content[ev.index] = { type: 'text', text: '' });
            block.text = String(block.text ?? '') + ev.delta.text;
            deltaChars += String(ev.delta.text).length;
            yield { text: ev.delta.text };
          } else if (ev.delta?.type === 'input_json_delta') {
            partialJson[ev.index] = (partialJson[ev.index] ?? '') + (ev.delta.partial_json ?? '');
          } else if (ev.delta?.type === 'thinking_delta') {
            // Accumulated but NEVER yielded: this is the model's private
            // reasoning. It goes back to the API in the next request and
            // nowhere else — not to the browser, not to an event, not to the
            // run record. Only `text_delta` above is ever surfaced.
            const block = content[ev.index] ?? (content[ev.index] = { type: 'thinking', thinking: '' });
            block.thinking = String(block.thinking ?? '') + (ev.delta.thinking ?? '');
          } else if (ev.delta?.type === 'signature_delta') {
            const block = content[ev.index] ?? (content[ev.index] = { type: 'thinking', thinking: '' });
            block.signature = String(block.signature ?? '') + (ev.delta.signature ?? '');
          }
        } else if (ev.type === 'content_block_stop') {
          const block = content[ev.index];
          if (block?.type === 'tool_use') {
            let input: Record<string, unknown> = {};
            try {
              input = partialJson[ev.index] ? JSON.parse(partialJson[ev.index]) : {};
            } catch {
              input = {};
            }
            block.input = input;
            yield { toolUse: { id: String(block.id), name: String(block.name), input } };
          }
        } else if (ev.type === 'message_delta') {
          stopReason = ev.delta?.stop_reason ?? stopReason;
          usage = { ...usage, ...ev.usage };
        } else if (ev.type === 'message_start') {
          usage = { ...usage, ...ev.message?.usage };
        } else if (ev.type === 'error') {
          throw new AnthropicCallError(`Anthropic stream error: ${JSON.stringify(ev.error).slice(0, 300)}`);
        }
      }
    }

    // The assistant turn goes back COMPLETE, thinking blocks included.
    //
    // They used to be stripped here, to fix a 400 that read "each thinking
    // block must contain thinking". The 400 was real but the diagnosis was
    // not: the block was empty because `thinking_delta` and `signature_delta`
    // were never handled above, so it was reassembled as {type:'thinking',
    // thinking:''}. Dropping the blocks hid that and created a worse failure
    // — a conversation whose assistant turns were missing content the model
    // had produced, after which it would answer a later round with an empty
    // turn. Three of the first four evaluation scenarios died that way, and
    // the same cause had been surfacing for two phases as an intermittent
    // "unparseable JSON" in the e2e suite.
    //
    // This does NOT expose the model's reasoning. Thinking text is never
    // yielded as `text`, never emitted as an event, never written to the run
    // record and never sent to the browser; it travels from one API request
    // to the next and nowhere else.
    const visible = content.filter(Boolean);
    // Assembled from the finished blocks, which is the authoritative record
    // of what the model said. Deltas are for live rendering only.
    const text = visible
      .filter((b) => b.type === 'text')
      .map((b) => String(b.text ?? ''))
      .join('');
    yield {
      diagnostics: {
        blockTypes: visible.map((b) => String(b.type)),
        textChars: text.length,
        textFromDeltas: deltaChars,
        toolUses: visible.filter((b) => b.type === 'tool_use').length,
      },
    };
    yield { done: { stopReason, usage, content: visible, text } };
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      if (opts.signal?.aborted) throw new AnthropicCallError('Run cancelled.');
      // Say WHICH failure this was. The abort is a total budget for the whole
      // stream, so "timed out" on its own cannot tell a long response that was
      // killed while streaming healthily from a connection that opened and
      // went quiet. The two need opposite fixes, and the message now carries
      // enough to decide: how long we waited, how many chunks arrived, and how
      // long since the last one.
      //
      // THE THRESHOLD BELOW WAS WRONG, and it mattered. It read any gap over
      // ten seconds as "the connection died partway through". Two real
      // failures then reported gaps of 27.9s and 29.0s and were both labelled
      // dead connections, so an idle watchdog got built for a problem that was
      // not happening while the actual cause, a long answer hitting the total
      // budget, went unaddressed through several attempts.
      //
      // Gaps of around thirty seconds are NORMAL in a healthy stream here.
      // "Died" has to mean quiet for longer than this stream ever
      // legitimately goes quiet, so the line is drawn at 60s with margin.
      const waited = Date.now() - started;
      const idle = lastChunkAt ? Date.now() - lastChunkAt : waited;
      throw new AnthropicCallError(
        `Anthropic call timed out after ${waited}ms — ${chunks} chunk(s) received, ${idle}ms since the last one. ` +
          (chunks === 0
            ? 'Nothing ever arrived: the connection stalled, and a longer timeout would not have helped.'
            : idle < 60_000
              ? 'It was still streaming when the budget ran out: this was a long answer being cut off, not a stall. Gaps of around thirty seconds are normal here.'
              : 'It went quiet for over a minute: the connection died partway through.'),
      );
    }
    throw e;
  } finally {
    clearTimeout(timeout);
    clearInterval(idleWatch);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
