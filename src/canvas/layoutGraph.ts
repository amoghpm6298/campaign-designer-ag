// Dagre layout adapter — ported in spirit from dcComputeLayout, but using
// @dagrejs/dagre (the actively-maintained fork, per the migration plan)
// and REAL measured node heights (via React Flow's own ResizeObserver-
// based node.measured, read after first render) rather than a fixed or
// estimated constant. The original's "floating connector" bug came
// specifically from feeding dagre a hardcoded height that didn't match
// real card content — this two-pass measure-then-layout approach is the
// direct, structural fix for that bug class, not just a port of the old
// hidden-DOM-probe workaround.
import dagre from '@dagrejs/dagre';
import type { DripGraph } from '../data/graphTypes';

// Every real node uses this same width regardless of type or size class
// (node-design refinement pass) — size classes (compact/standard, see
// dripCanvas.css) control height/padding only. One fixed width keeps
// every node's left/right boundaries aligned down the canvas, so
// connectors stay straight and the whole taxonomy reads as one node
// system rather than differently-sized shapes.
export const DC_CARD_W = 400;
export const DC_CARD_H_FALLBACK = 74; // used only before real measurement is available (first paint)
export const DC_SLOT_SIZE = 26;
// Slot nodes only need DC_SLOT_SIZE of visual room, but every edge gets a
// branch-label chip centered on its midpoint — without extra width
// reserved here, 2+ open branches sitting close together produce
// overlapping chips (the other real bug this migration exists to fix).
// A flat constant here only worked for short labels like "Yes"/"No" —
// Decision Split branches ("Branch 1 (some condition)", "Anything
// else") run far longer and overlapped at the same fixed width. A
// character-count estimate was tried first and measured ~30% too narrow
// against the real rendered chip (font metrics don't reduce to a single
// average glyph width reliably) — real canvas text measurement, against
// the exact font the chip itself uses, is used instead and is exact
// regardless of what the label string contains.
const DC_SLOT_LAYOUT_W = 132; // floor — matches a short label like "Yes"/"No"
const DC_SLOT_LABEL_FONT = "700 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
// Chip padding (6px each side) + border (1px each side) + the remove
// "✕" icon that's always present on an editable (open, in-builder) chip.
const DC_SLOT_LABEL_CHROME = 40;

let measureCtx: CanvasRenderingContext2D | null | undefined;
function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx !== undefined) return measureCtx;
  try {
    const canvas = document.createElement('canvas');
    measureCtx = canvas.getContext('2d');
    if (measureCtx) measureCtx.font = DC_SLOT_LABEL_FONT;
  } catch {
    measureCtx = null;
  }
  return measureCtx;
}

function estimateSlotWidth(branchLabel: string): number {
  if (!branchLabel) return DC_SLOT_LAYOUT_W;
  const ctx = getMeasureCtx();
  // Falls back to the floor (never narrower than a short label needs) if
  // canvas measurement genuinely isn't available in this environment —
  // better to under-reserve gracefully than throw.
  const textWidth = ctx ? ctx.measureText(branchLabel).width : 0;
  return Math.max(DC_SLOT_LAYOUT_W, Math.ceil(textWidth) + DC_SLOT_LABEL_CHROME);
}

export interface LayoutResult {
  positions: Record<string, { x: number; y: number; width: number; height: number }>;
  slotIds: Record<string, string>; // edgeId -> synthetic slot node id, for edges with to===null
  growSlotIds: Record<string, string>; // nodeId -> synthetic slot node id, for a leaf with 0 outgoing edges (not GOAL_EXIT/EXIT)
}

export function computeDagreLayout(graph: DripGraph, measuredHeights: Record<string, number>): LayoutResult {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 36, ranksep: 56, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  // Dagre vertically centers every node within its own rank — a node
  // taller than its rank-siblings (e.g. one with 3 lines of content plus
  // an auto-badge) extends further past the shared rank boundary than a
  // shorter sibling does, which can bite into the next rank's nodes by a
  // few pixels even though ranksep is satisfied for the rank's "typical"
  // height. A small fixed padding on every node's height, fed to dagre
  // (not rendered — purely a layout-spacing buffer), absorbs that
  // variance regardless of how tall any one node in a rank happens to be.
  const HEIGHT_PAD = 10;
  const trueHeights: Record<string, number> = {};
  Object.keys(graph.nodes).forEach((id) => {
    const h = measuredHeights[id] || DC_CARD_H_FALLBACK;
    trueHeights[id] = h;
    g.setNode(id, { width: DC_CARD_W, height: h + HEIGHT_PAD });
  });

  const slotIds: Record<string, string> = {};
  graph.edges.forEach((e) => {
    if (e.to === null) {
      const slotId = '__slot_' + e.id;
      slotIds[e.id] = slotId;
      g.setNode(slotId, { width: estimateSlotWidth(e.branchLabel), height: DC_SLOT_SIZE });
      g.setEdge(e.from, slotId);
    } else {
      g.setEdge(e.from, e.to);
    }
  });

  // A "grow leaf" slot — a linear leaf (0 outgoing edges, not a terminal
  // GOAL_EXIT/EXIT) still needs a "+" to add its own next step, same as an
  // open branch slot, just with no existing edge to hang it off. Give it
  // the same virtual-node treatment so it takes its rightful place in the
  // layout instead of floating outside what dagre computed.
  const growSlotIds: Record<string, string> = {};
  Object.values(graph.nodes).forEach((nd) => {
    const outCount = graph.edges.filter((e) => e.from === nd.id).length;
    if (outCount === 0 && nd.type !== 'GOAL_EXIT' && nd.type !== 'EXIT') {
      const slotId = '__growslot_' + nd.id;
      growSlotIds[nd.id] = slotId;
      g.setNode(slotId, { width: DC_SLOT_LAYOUT_W, height: DC_SLOT_SIZE });
      g.setEdge(nd.id, slotId);
    }
  });

  dagre.layout(g);

  // Position the REAL (unpadded) box around dagre's computed center — the
  // padding above only influenced dagre's own rank-spacing decision, it
  // should never make the rendered card itself bigger than its true
  // content size. Using the true height here means the padding surfaces
  // as genuine extra breathing room around the real box, not hidden slack
  // dagre silently accounted for without it ever being visible.
  const positions: LayoutResult['positions'] = {};
  g.nodes().forEach((id) => {
    const n = g.node(id);
    const trueHeight = trueHeights[id] ?? n.height;
    positions[id] = { x: n.x - n.width / 2, y: n.y - trueHeight / 2, width: n.width, height: trueHeight };
  });

  return { positions, slotIds, growSlotIds };
}
