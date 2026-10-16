// The round that has to produce the answer.
//
// ROOT CAUSE, measured by replaying the exact withdrawal round against the
// real API rather than by reading the code. History containing tool_use and
// tool_result blocks, `tool_choice: {type:'none'}`, the "STOP CALLING TOOLS"
// system suffix — the shape the orchestrator actually sends:
//
//   A (as shipped)                    0/3 produced text
//     stop=end_turn, blocks=[thinking], out=1719..3841 tokens, textChars=0
//   B (+ an instruction appended to the final user turn)   1/3
//   C (A, with thinking disabled)     4/4, in 1.9-14.7s vs 20-47s
//   D (C, tools also removed)         4/4
//
// The model was spending the whole turn thinking and then stopping without
// speaking. It was not a prompt-wording problem — B barely moved it — and it
// was not the provider: minimal probes returned 200 in under a second
// throughout. The round has nothing left to reason about; every lookup is
// already in the history and the job is to write the answer down.
//
// Tool withdrawal was never the bug. It is what EXPOSED the bug, by creating
// the one round where the model must answer from history alone.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
const anth = readFileSync(new URL('../../server/anthropic.ts', import.meta.url), 'utf8');

describe('the answering round runs without extended thinking', () => {
  it('the transport can turn thinking off for one call', () => {
    expect(anth).toMatch(/disableThinking\?: boolean;/);
    expect(anth).toMatch(/\.\.\.\(opts\.disableThinking \? \{ thinking: \{ type: 'disabled' \} \} : \{\}\)/);
  });

  it('is off exactly when tools are withdrawn, and on otherwise', () => {
    // Tied to the same condition, so the two can never drift apart: the round
    // that may not call a tool is the round that must answer.
    expect(orch).toMatch(/disableThinking: stopLookingUp,/);
    expect(orch).toMatch(/toolChoice: stopLookingUp \? \{ type: 'none' \} : undefined,/);
  });

  it('records the measurement next to the switch', () => {
    // So the next person does not "simplify" it away. The numbers are the
    // reason this line exists.
    expect(anth).toMatch(/MEASURED, not guessed/);
    expect(anth).toMatch(/3 times out of 3/);
    expect(anth).toMatch(/4 of 4 produced text/);
  });
});

describe('an empty terminal round is recovered, not reported', () => {
  it('retries once when a round ends with no text and no tool call', () => {
    // Bounded by a counter now rather than a one-shot flag: the product
    // retried once while the eval harness retried six times, so the failure
    // that ends a session was invisible in every measurement of it.
    expect(orch).toMatch(/if \(!toolUses\.length && unusable && emptyRecoveries < MAX_EMPTY_RECOVERIES\)/);
    // Unusable covers BOTH failure shapes: nothing at all, and text that is
    // not the JSON the application has to parse. Measured after the thinking
    // fix: the empty turns became short prose, which fails the user just the
    // same.
    // Widened: prose that is not JSON is only unusable when the model ALSO
    // failed to write to the record through tools. A turn that called
    // record_findings and then wrote its message as text is the shape we now
    // ask for, and the old condition called it a failure.
    expect(orch).toMatch(
      /const unusable =\s*\n?\s*!assistantText\.trim\(\) \|\| \(!extractJson\(assistantText, stopReason\)\.ok && !recordedViaTools\);/,
    );
    expect(orch).toMatch(/const MAX_EMPTY_RECOVERIES = 2;/);
    expect(orch).toMatch(/let emptyRecoveries = 0;/);
  });

  it('retries with thinking off and tools forbidden', () => {
    const block = orch.slice(orch.indexOf('emptyRecoveries++;'), orch.indexOf('if (!toolUses.length) break;'));
    expect(block).toMatch(/disableThinking: true,/);
    expect(block).toMatch(/toolChoice: \{ type: 'none' \},/);
    expect(block).toMatch(/Your previous turn did not produce a usable answer/);
    expect(block).toMatch(/the single JSON object described in OUTPUT, complete/);
  });

  it('is bounded to a single attempt, so it cannot become a loop', () => {
    // The flag is set BEFORE the call, so a retry that also comes back empty
    // falls through to the honest error rather than retrying again.
    const block = orch.slice(orch.indexOf('if (!toolUses.length && unusable'), orch.indexOf('if (!toolUses.length) break;'));
    expect(block.indexOf('emptyRecoveries++;')).toBeLessThan(block.indexOf('streamClaude({'));
    expect([...orch.matchAll(/emptyRecoveries\+\+;/g)]).toHaveLength(1);
  });

  it('never fires on a round that produced text or asked for a tool', () => {
    // Guards the obvious regression: a recovery that runs on every round
    // would double the cost of a healthy conversation.
    expect(orch).toMatch(/!toolUses\.length && unusable/);
  });

  it('breaks out of the tool loop rather than continuing it', () => {
    // A recovery that fell through would run the normal tool-result handling
    // against a turn that produced none.
    //
    // The slice now ends at `if (!toolUses.length) {` rather than the old
    // one-line `... break;`: that branch gained the design step, which runs a
    // second model round before the loop may end. The recovery block itself is
    // unchanged and must still end by breaking.
    const block = orch.slice(
      orch.indexOf('emptyRecoveries++;'),
      orch.indexOf('if (!toolUses.length) {'),
    );
    expect(block).toMatch(/yield\* drain\(\);\s*break;\s*\}\s*$/);
  });

  it('reports the retry in the run record', () => {
    expect(orch).toMatch(/retryOfEmptyRound: true/);
    expect(orch).toMatch(/Agent answer unusable, asking again/);
  });
});

describe('the existing limits are untouched', () => {
  it('keeps both safety ceilings at their measured values', () => {
    expect(orch).toMatch(/const MAX_TOOL_ROUNDS = 8;/);
    expect(orch).toMatch(/const MAX_REPEAT_ROUNDS = 2;/);
  });

  it('keeps repeat detection consecutive, and budget separate from repeats', () => {
    // Counts LOOKUPS, not every tool call. A second `record_findings` is the
    // model doing as instructed, not a wasted re-read of the event catalogue,
    // and counting it as a repeat escalated against correct behaviour.
    expect(orch).toMatch(/repeatRounds = lookups > 0 && repeats === lookups \? repeatRounds \+ 1 : 0;/);
    expect(orch).toMatch(/const budgetSpent = round === MAX_TOOL_ROUNDS - 1;/);
    expect(orch).toMatch(/const stopLookingUp = budgetSpent \|\| repeatRounds >= MAX_REPEAT_ROUNDS/);
  });

  it('still serves a repeated lookup from cache and says so', () => {
    expect(orch).toMatch(/const cached = toolCache\.get\(key\)/);
    expect(orch).toMatch(/Calling it again cannot return anything different/);
    // The payload itself is NOT resent — only a pointer to where it already is.
    expect(orch).not.toMatch(/\$\{payload\}\\n\\nYou already called/);
  });

  it('still sends the tool DEFINITIONS when it forbids their use', () => {
    // Removing them was the first attempt at this class of bug and it caused
    // empty turns of its own: a history full of tool_use blocks with no tools
    // attached is incoherent.
    expect(orch).not.toMatch(/tools: stopLookingUp/);
    // Phase-filtered now, but still SENT, which is what this protects: the
    // builder's vocabulary is withheld until an intervention is stated, and
    // within a turn the tool list only ever grows, so history can never cite
    // a tool that is missing from the current list.
    expect(orch).toMatch(/tools: \[\.\.\.toolsForPhase\(designSeen\), \.\.\.OUTPUT_TOOLS\]\.map/);
  });

  it('still fails explicitly when the budget is genuinely spent', () => {
    expect(orch).toMatch(/The agent spent all of its lookups without reaching an answer/);
  });
});

describe('a failure that survives recovery stays honest and recoverable', () => {
  it('still says plainly that the response was empty', () => {
    // The wording lives in the transport, which is what detects it.
    expect(anth).toMatch(/The model returned no text at all/);
    expect(anth).toMatch(/This is an empty response, not a formatting problem/);
  });

  it('returns the accumulated brief and session on every error path', () => {
    // Discovery state must survive a recoverable failure: answers, dimensions
    // and question ids are what a retry builds on.
    // Sliced from each index rather than matched greedily: two of these sit
    // close enough together that one window swallows the next.
    const starts = [...orch.matchAll(/phase: 'error'/g)].map((m) => m.index!);
    const errorReturns = starts.map((i) => orch.slice(i, i + 420));
    expect(errorReturns.length).toBe(7);
    for (const r of errorReturns) {
      // Single-line returns end "brief, session }", multi-line use "session,".
      expect(r, r.slice(0, 100)).toMatch(/\bbrief\b/);
      expect(r, r.slice(0, 100)).toMatch(/\bsession\b/);
    }
  });
});
