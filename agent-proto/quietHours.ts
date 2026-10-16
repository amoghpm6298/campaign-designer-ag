// Quiet-hours assessment, at DESIGN TIME only.
//
// Ownership, deliberately: the agent does NOT own a quiet-hours policy and
// does not define one. The window is issuer-level configuration belonging to
// the Drip Campaign system; this module only reads a window it is handed and
// compares the campaign's own configured send times against it. The window
// used in the prototype comes from agent-proto/context/bank-context.json and
// is labelled INVENTED — it is not a verified issuer policy.
//
// Equally deliberate: passing this check does NOT mean quiet hours will be
// honoured. It means the campaign's configured send time does not violate
// them as designed. Runtime enforcement at send time belongs to the Drip
// Campaign system, which today holds no quiet-hours field at all.
//
// What can actually be determined, from the app's own timing model:
//   - timing 'Absolute' → absTime, an <input type="time"> (NodeForms.tsx),
//     i.e. a time of day with no date. Comparable to a window. DETERMINABLE.
//   - timing 'Relative' → "Delay after previous step": a duration from an
//     anchor (Entry / Previous Step) whose wall-clock time is set by when
//     the trigger actually fires. NOT determinable at design time.
import type { DripGraph } from '../src/data/graphTypes';

/** 'HH:MM' strings, as stored by the app's time input. */
export interface QuietHoursWindow {
  from: string;
  to: string;
}

export type SendTimeFinding =
  | { nodeId: string; label: string; verdict: 'inside' | 'outside'; at: string }
  | { nodeId: string; label: string; verdict: 'undetermined'; reason: string };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes since midnight, or null if the value is not a usable time. */
export function parseTimeOfDay(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = HHMM.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Half-open window `[from, to)`: a window of 21:00–09:00 means 21:00 is quiet
 * and 09:00 is not, which is how "quiet until 9am" normally reads.
 *
 * Wrap-around across midnight is the common case and is handled explicitly.
 * A window where from === to is treated as zero-length (nothing is inside) —
 * the literal reading of the two values. It is not a configuration this
 * prototype produces.
 */
export function isInsideWindow(timeOfDay: number, window: QuietHoursWindow): boolean | null {
  const from = parseTimeOfDay(window.from);
  const to = parseTimeOfDay(window.to);
  if (from === null || to === null) return null; // unusable window; caller must not claim compliance
  if (from === to) return false;
  return from > to
    ? timeOfDay >= from || timeOfDay < to // crosses midnight
    : timeOfDay >= from && timeOfDay < to;
}

/**
 * One finding per Send node. `undetermined` is a first-class result, not an
 * error: for a relative send the honest answer is that the send time is not
 * knowable from the graph, and that must not be rounded to "compliant".
 */
export function assessSendTimes(graph: DripGraph, window: QuietHoursWindow): SendTimeFinding[] {
  const findings: SendTimeFinding[] = [];

  for (const node of Object.values(graph.nodes)) {
    if (node.type !== 'SEND') continue;
    const cfg = (node._config ?? {}) as Record<string, unknown>;
    const timing = cfg.timing;
    const base = { nodeId: node.id, label: node.label };

    // Gated on timing, NOT on the presence of absTime. dcDefaultConfig ships
    // absTime: '11:00' on every Send, so a relative send still carries a
    // stale, unused value — reading it here would manufacture a false pass.
    if (timing !== 'Absolute') {
      const anchor = typeof cfg.relativeAnchor === 'string' ? cfg.relativeAnchor : 'its anchor';
      const delay =
        cfg.relativeDuration !== undefined && cfg.relativeUnit !== undefined
          ? `${cfg.relativeDuration} ${cfg.relativeUnit}`
          : 'an unspecified delay';
      findings.push({
        ...base,
        verdict: 'undetermined',
        reason:
          timing === 'Relative'
            ? `relative timing — fires ${delay} after ${anchor}, whose wall-clock time is set by when the trigger occurs, so the send time is not knowable from the graph`
            : `timing is ${timing === undefined ? 'not set' : `"${String(timing)}"`}, so no send time can be read`,
      });
      continue;
    }

    const at = parseTimeOfDay(cfg.absTime);
    if (at === null) {
      findings.push({
        ...base,
        verdict: 'undetermined',
        reason: `absolute timing, but absTime is ${JSON.stringify(cfg.absTime)}, which is not a usable time of day`,
      });
      continue;
    }

    const inside = isInsideWindow(at, window);
    if (inside === null) {
      findings.push({
        ...base,
        verdict: 'undetermined',
        reason: `the quiet-hours window ${window.from}–${window.to} is not a usable time range`,
      });
      continue;
    }
    findings.push({ ...base, verdict: inside ? 'inside' : 'outside', at: String(cfg.absTime) });
  }

  return findings;
}
