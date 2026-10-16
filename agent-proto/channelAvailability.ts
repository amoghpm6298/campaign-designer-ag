// Channel availability, checked against the GENERATED GRAPH.
//
// The planner already filters unavailable channels when it picks one
// (planner.ts sorts `channels.available.filter(c => c.available)`), but that
// is construction-time only. Nothing verified the finished campaign, so the
// guarantee rested entirely on the planner being correct — and the audit's
// probe confirmed a hand-built RCS campaign sailed through as PRE-VALIDATED.
// This checks the artefact, not the process that produced it.
//
// Two channels per Send, not one. Channel Failover was folded into SEND as an
// optional `fallbackChannel`, and the fallback is a real delivery route — it
// is the channel that actually delivers when the primary fails. A check that
// read only `channel` would miss an unavailable fallback entirely. An empty
// string means no fallback configured, which is the app's own convention
// (see dcDefaultConfig and dcAddFormValid's `if (!p.fallbackChannel) return true`).
//
// Ownership is unchanged: the available-channel list is issuer configuration
// read from the existing bank context. Nothing here defines it.
import { CHANNEL_CONFIG_LABELS } from '../src/data/sharedConstants';
import type { DripGraph } from '../src/data/graphTypes';

/** One entry of the issuer's `channels.available` list. */
export interface ChannelAvailability {
  channel: string;
  available: boolean;
}

export type ChannelVerdict =
  /** Listed by the issuer and marked available. */
  | 'available'
  /** Listed by the issuer and marked NOT available. */
  | 'unavailable'
  /** A real app channel the issuer's list does not mention — not known to be available. */
  | 'not-listed'
  /** Not a channel this application recognises at all. */
  | 'unrecognised';

export interface ChannelFinding {
  nodeId: string;
  label: string;
  /** Primary send channel, or the fallback that would deliver if it fails. */
  role: 'primary' | 'fallback';
  channel: string;
  verdict: ChannelVerdict;
}

/** The app's own channel vocabulary — the authority on what a channel even is. */
const APP_CHANNELS = Object.keys(CHANNEL_CONFIG_LABELS);

/**
 * Is the issuer's list usable at all? Returns a reason when it is not, so the
 * caller can record `not-run` instead of guessing. An unusable list must never
 * produce a pass: that would be claiming compliance against nothing.
 */
export function availabilityConfigProblem(list: unknown): string | null {
  if (!Array.isArray(list)) return 'the issuer\'s channels.available configuration is missing or is not a list';
  if (list.length === 0) return 'the issuer\'s channels.available list is empty, so no channel can be confirmed available';
  for (const [i, entry] of list.entries()) {
    if (typeof entry !== 'object' || entry === null) return `entry ${i} of channels.available is not an object`;
    const e = entry as Record<string, unknown>;
    if (typeof e.channel !== 'string' || e.channel.trim() === '') {
      return `entry ${i} of channels.available has no readable "channel" name`;
    }
    // A missing or non-boolean flag is ambiguous, and resolving it either way
    // would be inventing issuer policy.
    if (typeof e.available !== 'boolean') {
      return `channels.available entry "${e.channel}" has a non-boolean "available" flag (${JSON.stringify(e.available)}), which cannot be interpreted reliably`;
    }
  }
  return null;
}

/** Every channel the campaign would actually deliver on, primary and fallback. */
export function collectChannelUses(graph: DripGraph): Omit<ChannelFinding, 'verdict'>[] {
  const uses: Omit<ChannelFinding, 'verdict'>[] = [];
  for (const node of Object.values(graph.nodes)) {
    if (node.type !== 'SEND') continue;
    const cfg = (node._config ?? {}) as Record<string, unknown>;
    const base = { nodeId: node.id, label: node.label };

    uses.push({ ...base, role: 'primary', channel: typeof cfg.channel === 'string' ? cfg.channel : String(cfg.channel) });

    // '' / absent means no fallback configured — not an unavailable one.
    const fallback = cfg.fallbackChannel;
    if (typeof fallback === 'string' && fallback.trim() !== '') {
      uses.push({ ...base, role: 'fallback', channel: fallback });
    }
  }
  return uses;
}

export function assessChannels(graph: DripGraph, list: ChannelAvailability[]): ChannelFinding[] {
  const byName = new Map(list.map((c) => [c.channel, c.available]));

  return collectChannelUses(graph).map((use) => {
    let verdict: ChannelVerdict;
    if (!APP_CHANNELS.includes(use.channel)) verdict = 'unrecognised';
    else if (!byName.has(use.channel)) verdict = 'not-listed';
    else verdict = byName.get(use.channel) ? 'available' : 'unavailable';
    return { ...use, verdict };
  });
}

/** Anything that is not a confirmed `available` is a violation, not a doubt. */
export const isChannelViolation = (f: ChannelFinding) => f.verdict !== 'available';

export function describeViolation(f: ChannelFinding): string {
  const where = `${f.nodeId} "${f.label}" (${f.role}: ${f.channel})`;
  switch (f.verdict) {
    case 'unavailable':
      return `${where} — the issuer marks this channel available: false`;
    case 'not-listed':
      return `${where} — not present in the issuer's channels.available list, so it is not known to be available`;
    case 'unrecognised':
      return `${where} — not a channel this application recognises (known: ${APP_CHANNELS.join(', ')})`;
    default:
      return where;
  }
}
