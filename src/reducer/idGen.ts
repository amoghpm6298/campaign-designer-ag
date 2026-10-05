// Ported from journeysnudgesemi/emi-conversions-prototype.html (dcNewNodeId
// / dcNewEdgeId / dcNewBranchId / dcSeedIdCountersFrom). Module-level
// counters, same as the original — this is a single-user prototype with no
// concurrent-editor concern, and keeping this exact pattern (rather than
// switching to crypto.randomUUID or similar) matches the original's id
// format (`dcn1`, `dce1`, `dcb1`) that CLAUDE.md's history/tests reference.
import type { DripGraph } from '../data/graphTypes';

let dcNodeIdSeq = 1;
let dcEdgeIdSeq = 1;
let dcBranchIdSeq = 1;

export function dcNewNodeId(): string {
  return 'dcn' + dcNodeIdSeq++;
}
export function dcNewEdgeId(): string {
  return 'dce' + dcEdgeIdSeq++;
}
// Random Split / Decision Split branches need a stable identity of their
// own, independent of array position — without one, inserting a branch in
// the middle has no way to tell "this is a new branch" apart from "these
// are the same branches, just shifted over."
export function dcNewBranchId(): string {
  return 'dcb' + dcBranchIdSeq++;
}

// Reseeds the id counters past whatever a cloned-in campaign already uses,
// so any new node/edge/branch created while continuing to edit it can
// never collide with an id that graph already has.
export function dcSeedIdCountersFrom(graph: DripGraph): void {
  let maxN = 0;
  let maxE = 0;
  let maxB = 0;
  Object.keys(graph.nodes).forEach((id) => {
    const m = +String(id).replace('dcn', '');
    if (m > maxN) maxN = m;
  });
  graph.edges.forEach((e) => {
    const m = +String(e.id).replace('dce', '');
    if (m > maxE) maxE = m;
    if (e.branchId) {
      const mb = +String(e.branchId).replace('dcb', '');
      if (mb > maxB) maxB = mb;
    }
  });
  dcNodeIdSeq = maxN + 1;
  dcEdgeIdSeq = maxE + 1;
  dcBranchIdSeq = maxB + 1;
}

// Resets counters for a brand-new campaign — mirrors openDripCreate()'s
// own reset.
export function dcResetIdCounters(): void {
  dcNodeIdSeq = 1;
  dcEdgeIdSeq = 1;
  dcBranchIdSeq = 1;
}
