// Campaign object (+ its context, for the bucket cards' text) → canvas nodes
// and edges, laid out as bucket columns.
//
// The built campaign is one graph: entry → bucket 1 rule? → … (first match
// wins). Drawn as a plain top-to-bottom graph that chain becomes a deepening
// staircase, so the canvas draws it the way a manager thinks about it: the
// entry on top, then one column per bucket (checked left to right), each with
// its own flow below. It draws exactly what the builder builds: a step that
// follows a fork with several open paths appears once on each path.
// Pure: no React, unit-tested.

import dagre from '@dagrejs/dagre';
import { bucketContext, noteText, type BucketView } from './contextView';
import type { CampaignBucket, CampaignContext, CampaignObject } from './types';

export type CNodeKind =
  | 'entry'
  | 'bucket'
  | 'everyone'
  | 'holdout'
  | 'send'
  | 'goalcheck'
  | 'wait'
  | 'waitForEvent'
  | 'branch'
  | 'experiment'
  | 'condition'
  | 'exit';

/** A journey step as the canvas reads it: optional-everything, it parses a payload. */
export interface CStep {
  kind?: string;
  name?: string;
  describe?: string;
  copy?: string;
  cta?: string;
  stage?: string;
  channelPreference?: string[];
  fallbackChannel?: string;
  delayDays?: number;
  atTime?: string;
  durationHours?: number;
  eventType?: string;
  timeoutDays?: number;
  reason?: string;
  label?: string;
  tests?: string;
  arms?: { label?: string; pct?: number; steps?: CStep[] }[];
  paths?: { label?: string; statuses?: string[]; steps?: CStep[] }[];
  yes?: CStep[];
  no?: CStep[];
}

export interface CNodeData extends Record<string, unknown> {
  kind: CNodeKind;
  /** Bucket id the node belongs to ('' for entry, 'everyone_else' for everyone else). */
  lane: string;
  /** The step's address inside its bucket journey, e.g. "2.paths.1.steps.0". */
  path?: string;
  step?: CStep;
  bucket?: CampaignBucket;
  /** The bucket's reasoning and size, from the context. */
  info?: BucketView;
  bucketIndex?: number;
  campaign?: CampaignObject;
  /** Everyone else: why, from the context. */
  why?: string;
  holdoutPct?: number;
  changed?: boolean;
  /** Short text for exits and the everyone-else card. */
  text?: string;
}

export interface CNode {
  id: string;
  data: CNodeData;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  /** Bucket-to-bucket "not matched" edges run sideways. */
  sideways?: boolean;
}

export const NODE_W: Record<CNodeKind, number> = {
  entry: 420,
  bucket: 340,
  everyone: 280,
  holdout: 250,
  send: 300,
  goalcheck: 220,
  wait: 150,
  waitForEvent: 250,
  branch: 260,
  experiment: 280,
  condition: 260,
  exit: 230,
};

/** Heights: fallbacks for cards until measured; the drawn shapes are fixed. */
export const NODE_H: Record<CNodeKind, number> = {
  entry: 84,
  bucket: 230,
  everyone: 120,
  holdout: 58,
  send: 190,
  goalcheck: 104,
  wait: 38,
  waitForEvent: 42,
  branch: 136,
  experiment: 72,
  condition: 130,
  exit: 38,
};

/** Kinds drawn as fixed shapes (their height never comes from measuring). */
export const FIXED_SHAPES: CNodeKind[] = ['holdout', 'goalcheck', 'wait', 'waitForEvent', 'branch', 'experiment', 'condition', 'exit'];

const LANE_GAP = 90;
const ENTRY_GAP = 110;

interface LaneBuild {
  nodes: { id: string; data: CNodeData }[];
  edges: CEdge[];
}

type Tail = { id: string; label?: string };

/**
 * Adds a sequence of steps; returns the ids the next step should connect from.
 * `copy` marks a duplicate made because the sequence follows a fork: the
 * builder cannot join paths back together, so it puts the rest of the
 * sequence on each open path, and so does the canvas.
 */
function addSeq(lane: string, steps: CStep[] | undefined, from: Tail[], prefix: string, out: LaneBuild, changed: Set<string>, copy = '', start = 0): Tail[] {
  let tails = from;
  const list = steps ?? [];
  for (let i = start; i < list.length; i++) {
    if (tails.length > 1) return tails.flatMap((t, k) => addSeq(lane, list, [t], prefix, out, changed, `${copy}#${k + 1}`, i));
    const st = list[i];
    const path = `${prefix}${i}`;
    const id = `${lane}:${path}${copy}`;
    const kind = (['send', 'wait', 'waitForEvent', 'branch', 'experiment', 'condition', 'exit'].includes(String(st.kind)) ? st.kind : 'exit') as CNodeKind;
    out.nodes.push({ id, data: { kind, lane, path, step: st, changed: changed.has(`${lane}:${path}`), ...(kind === 'exit' ? { text: st.reason ?? '' } : {}) } });
    for (const t of tails) out.edges.push({ id: `e:${t.id}->${id}`, source: t.id, target: id, ...(t.label ? { label: t.label } : {}) });

    if (kind === 'send') {
      const gc = `${id}:gc`;
      out.nodes.push({ id: gc, data: { kind: 'goalcheck', lane, path } });
      out.edges.push({ id: `e:${id}->${gc}`, source: id, target: gc });
      tails = [{ id: gc }];
    } else if (kind === 'exit') {
      tails = [];
    } else if (kind === 'experiment') {
      tails = (st.arms ?? []).flatMap((a, ai) => {
        const label = `${a.label ?? `Arm ${ai + 1}`}${typeof a.pct === 'number' ? ` · ${a.pct}%` : ''}`;
        if (!a.steps?.length) return [{ id, label }];
        return addSeq(lane, a.steps, [{ id, label }], `${path}.arms.${ai}.steps.`, out, changed, copy);
      });
    } else if (kind === 'branch') {
      const armTails = (st.paths ?? []).flatMap((p, pi) => {
        const label = p.label ?? `Path ${pi + 1}`;
        if (!p.steps?.length) return [{ id, label }];
        return addSeq(lane, p.steps, [{ id, label }], `${path}.paths.${pi}.steps.`, out, changed, copy);
      });
      // The builder's catch-all arm: anyone whose status matched no path.
      const ex = `${id}:else`;
      out.nodes.push({ id: ex, data: { kind: 'exit', lane, text: 'Did not reach the goal in this window' } });
      out.edges.push({ id: `e:${id}->${ex}`, source: id, target: ex, label: 'Anything else' });
      tails = armTails;
    } else if (kind === 'condition') {
      const y = st.yes?.length ? addSeq(lane, st.yes, [{ id, label: 'Yes' }], `${path}.yes.`, out, changed, copy) : [{ id, label: 'Yes' }];
      const n = st.no?.length ? addSeq(lane, st.no, [{ id, label: 'No' }], `${path}.no.`, out, changed, copy) : [{ id, label: 'No' }];
      tails = [...y, ...n];
    } else {
      tails = [{ id }];
    }
  }
  return tails;
}

function layoutLane(lane: LaneBuild, measured: Record<string, number>): { pos: Record<string, { x: number; y: number }>; width: number; height: number } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 64, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of lane.nodes) g.setNode(n.id, { width: NODE_W[n.data.kind], height: (measured[n.id] ?? NODE_H[n.data.kind]) + 6 });
  for (const e of lane.edges) if (!e.sideways) g.setEdge(e.source, e.target);
  dagre.layout(g);
  const pos: Record<string, { x: number; y: number }> = {};
  let minX = Infinity;
  let maxX = -Infinity;
  let maxY = 0;
  for (const n of lane.nodes) {
    const p = g.node(n.id);
    const w = NODE_W[n.data.kind];
    const h = measured[n.id] ?? NODE_H[n.data.kind];
    pos[n.id] = { x: p.x - w / 2, y: p.y - h / 2 };
    minX = Math.min(minX, p.x - w / 2);
    maxX = Math.max(maxX, p.x + w / 2);
    maxY = Math.max(maxY, p.y + h / 2);
  }
  for (const id of Object.keys(pos)) pos[id].x -= minX;
  return { pos, width: maxX - minX, height: maxY };
}

/** Builds the whole canvas. `measured` are real card heights once the browser has drawn them. */
export function buildCanvasModel(
  campaign: CampaignObject | null | undefined,
  context: CampaignContext | null | undefined = null,
  changed: Set<string> = new Set(),
  measured: Record<string, number> = {},
): { nodes: CNode[]; edges: CEdge[] } {
  if (!campaign || (!campaign.buckets.length && !campaign.goal && !campaign.entry && !campaign.membership && !campaign.everyoneElse)) return { nodes: [], edges: [] };
  const info = bucketContext(context?.entries ?? []);
  const buckets = [...campaign.buckets].sort((a, b) => a.priority - b.priority);
  const lanes: LaneBuild[] = [];

  buckets.forEach((b, i) => {
    const lane: LaneBuild = { nodes: [], edges: [] };
    const head = `${b.id}:head`;
    lane.nodes.push({ id: head, data: { kind: 'bucket', lane: b.id, bucket: b, info: info[b.id] ?? {}, bucketIndex: i } });
    let from: { id: string; label?: string }[] = [{ id: head }];
    if (b.holdoutPct && b.holdoutPct > 0 && b.journey?.length) {
      const h = `${b.id}:holdout`;
      lane.nodes.push({ id: h, data: { kind: 'holdout', lane: b.id, holdoutPct: b.holdoutPct } });
      lane.edges.push({ id: `e:${head}->${h}`, source: head, target: h });
      from = [{ id: h, label: `${100 - b.holdoutPct}% get the journey` }];
    }
    if (b.journey?.length) {
      const tails = addSeq(b.id, b.journey as CStep[], from, '', lane, changed);
      if (tails.length) {
        const end = `${b.id}:end`;
        lane.nodes.push({ id: end, data: { kind: 'exit', lane: b.id, text: 'Journey ends' } });
        for (const t of tails) lane.edges.push({ id: `e:${t.id}->${end}`, source: t.id, target: end, ...(t.label ? { label: t.label } : {}) });
      }
    }
    lanes.push(lane);
  });

  const ee = campaign.everyoneElse;
  {
    const lane: LaneBuild = { nodes: [], edges: [] };
    lane.nodes.push({ id: 'everyone_else:head', data: { kind: 'everyone', lane: 'everyone_else', campaign, why: noteText(context?.entries ?? [], 'everyone_else') } });
    if (ee?.approach === 'journey' && ee.journey?.length) {
      const tails = addSeq('everyone_else', ee.journey as CStep[], [{ id: 'everyone_else:head' }], '', lane, changed);
      if (tails.length) {
        lane.nodes.push({ id: 'everyone_else:end', data: { kind: 'exit', lane: 'everyone_else', text: 'Journey ends' } });
        for (const t of tails) lane.edges.push({ id: `e:${t.id}->everyone_else:end`, source: t.id, target: 'everyone_else:end', ...(t.label ? { label: t.label } : {}) });
      }
    }
    lanes.push(lane);
  }

  // Place lanes side by side under the entry.
  const entryH = measured.entry ?? NODE_H.entry;
  const laneTop = entryH + ENTRY_GAP;
  const nodes: CNode[] = [];
  const edges: CEdge[] = [];
  let x = 0;
  for (const lane of lanes) {
    const l = layoutLane(lane, measured);
    for (const n of lane.nodes) {
      const p = l.pos[n.id];
      nodes.push({ id: n.id, data: n.data, x: x + p.x, y: laneTop + p.y, width: NODE_W[n.data.kind], height: measured[n.id] ?? NODE_H[n.data.kind] });
    }
    edges.push(...lane.edges);
    x += l.width + LANE_GAP;
  }
  const totalW = Math.max(0, x - LANE_GAP);
  nodes.unshift({ id: 'entry', data: { kind: 'entry', lane: '', campaign }, x: totalW / 2 - NODE_W.entry / 2, y: 0, width: NODE_W.entry, height: entryH });
  // The entry branches straight into every column. The order (first match
  // wins, left to right) is said on the cards, not drawn as a chain of
  // "not matched" hops.
  for (const b of buckets) edges.push({ id: `e:entry->${b.id}:head`, source: 'entry', target: `${b.id}:head` });
  edges.push({ id: 'e:entry->everyone_else:head', source: 'entry', target: 'everyone_else:head' });
  return { nodes, edges };
}

/**
 * Which steps changed between two versions of the campaign object, as
 * "<lane>:<path>" (a step drawn twice after a fork lights up in both places).
 * Only buckets that already had a journey count — a first build is not a
 * "change".
 */
export function diffChangedSteps(prev: CampaignObject | null | undefined, next: CampaignObject | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!prev || !next) return out;
  const index = (lane: string, steps: CStep[] | undefined, prefix: string, m: Map<string, string>) => {
    (steps ?? []).forEach((st, i) => {
      const path = `${prefix}${i}`;
      const { arms, paths, yes, no, ...own } = st;
      m.set(`${lane}:${path}`, JSON.stringify(own));
      (arms ?? []).forEach((a, ai) => index(lane, a.steps, `${path}.arms.${ai}.steps.`, m));
      (paths ?? []).forEach((p, pi) => index(lane, p.steps, `${path}.paths.${pi}.steps.`, m));
      index(lane, yes, `${path}.yes.`, m);
      index(lane, no, `${path}.no.`, m);
    });
  };
  const lanesOf = (c: CampaignObject) => [
    ...c.buckets.map((b) => ({ lane: b.id, journey: b.journey as CStep[] | null })),
    { lane: 'everyone_else', journey: (c.everyoneElse?.journey as CStep[] | undefined) ?? null },
  ];
  const before = new Map(lanesOf(prev).map((l) => [l.lane, l.journey]));
  for (const l of lanesOf(next)) {
    const old = before.get(l.lane);
    if (!old?.length || !l.journey?.length) continue;
    const a = new Map<string, string>();
    const b = new Map<string, string>();
    index(l.lane, old, '', a);
    index(l.lane, l.journey, '', b);
    for (const [id, v] of b) if (a.get(id) !== v) out.add(id);
  }
  return out;
}

/** Plain-language helpers shared by the node components and the drawer. */
export const CHANNEL_LABEL: Record<string, string> = { WHATSAPP: 'WhatsApp', SMS: 'SMS', EMAIL: 'Email', RCS: 'RCS', PUSH: 'Push' };

export function waitHours(st: CStep): number | null {
  const h = Number(st.durationHours);
  if (Number.isFinite(h)) return h;
  const d = Number((st as { delayDays?: unknown }).delayDays);
  return Number.isFinite(d) ? d * 24 : null;
}

export function fmtWait(h: number | null): string {
  if (h === null) return 'Wait';
  if (h >= 24) {
    const d = Math.round((h / 24) * 10) / 10;
    return `Wait ${d} day${d === 1 ? '' : 's'}`;
  }
  return `Wait ${h} hour${h === 1 ? '' : 's'}`;
}

export function fmtTime(t: string | undefined): string {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  if (Number.isNaN(h)) return t;
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

export function sendTitle(st: CStep): string {
  if (st.name) return st.name;
  const base = st.stage === 'reminder' ? 'Reminder' : st.stage === 'outcome' ? 'Final message' : 'First message';
  return st.cta ? `${base} · “${st.cta}”` : base;
}

export function sendWhen(st: CStep): string {
  return `${st.delayDays ? `Day ${st.delayDays}` : 'On entry'}${st.atTime ? ` · ${fmtTime(st.atTime)}` : ''}`;
}
