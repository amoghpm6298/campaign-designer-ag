// Stable ids for journey steps. A backend concern only: the agent never sees
// or writes them (get_campaign strips them). They let a box the manager points
// at stay the same box across turns, let "what changed" be exact, and give the
// engine and later per-step results a stable key.
import type { BpStep } from '../blueprint';

type Rec = Record<string, unknown>;
const KIDS = ['arms', 'paths'] as const;

export function newStepId(): string {
  return `s${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Calls fn for every step in a journey, depth first, with its address. */
export function walkSteps(steps: BpStep[] | null | undefined, fn: (step: Rec, path: string, list: Rec[], index: number) => void, prefix = ''): void {
  (steps ?? []).forEach((st, i) => {
    const s = st as unknown as Rec;
    const path = `${prefix}${i}`;
    fn(s, path, steps as unknown as Rec[], i);
    for (const k of KIDS) ((s[k] as { steps?: BpStep[] }[] | undefined) ?? []).forEach((a, ai) => walkSteps(a.steps, fn, `${path}.${k}.${ai}.steps.`));
    for (const k of ['yes', 'no', 'otherwise'] as const) walkSteps(s[k] as BpStep[] | undefined, fn, `${path}.${k}.`);
  });
}

/**
 * A step's own content: what "changed" compares. Without its id or the steps
 * nested under it, but WITH its arms' and paths' own settings (labels, split
 * %, statuses) — changing a split is a change to the A/B test itself.
 */
export function ownSignature(s: Rec): string {
  const { id: _id, arms, paths, yes: _y, no: _n, otherwise: _o, ...own } = s;
  void _o;
  void _id;
  void _y;
  void _n;
  const shape = (list: unknown) => (Array.isArray(list) ? list.map(({ steps: _s, ...rest }: Rec) => (void _s, rest)) : undefined);
  return JSON.stringify({ ...own, ...(arms ? { arms: shape(arms) } : {}), ...(paths ? { paths: shape(paths) } : {}) });
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Returns a copy of `next` whose steps carry ids, re-attached from `prev`:
 * 1. an unchanged step at the same address keeps its id;
 * 2. an unchanged step that moved keeps its id (matched by content);
 * 3. a step edited in place (same address, same kind) keeps its id;
 * 4. otherwise a step of the same kind and name keeps it;
 * 5. anything left gets a new id. Ids in `used` are never reused.
 * Same-address matches go first: a journey often holds identical steps (two
 * "wait 3 days"), and content alone would swap their ids.
 */
export function carryIds(prev: BpStep[] | null | undefined, next: BpStep[] | null | undefined, used: Set<string> = new Set()): BpStep[] | null {
  if (!next) return next ?? null;
  const out = clone(next);
  const old: { id: string; sig: string; path: string; kind: string; name: string; taken: boolean }[] = [];
  walkSteps(prev, (s, path) => {
    if (typeof s.id === 'string') old.push({ id: s.id, sig: ownSignature(s), path, kind: String(s.kind), name: String(s.name ?? s.label ?? ''), taken: false });
  });
  const nodes: { s: Rec; path: string }[] = [];
  walkSteps(out, (s, path) => {
    delete s.id; // the model never sets ids; anything it sent is ignored
    nodes.push({ s, path });
  });
  const take = (pred: (o: (typeof old)[number]) => boolean) => {
    const hit = old.find((o) => !o.taken && !used.has(o.id) && pred(o));
    if (hit) hit.taken = true;
    return hit?.id;
  };
  const inPlace = nodes.filter((n) => {
    const id = take((o) => o.path === n.path && o.sig === ownSignature(n.s));
    if (id) {
      n.s.id = id;
      used.add(id);
    }
    return !id;
  });
  const pending = inPlace.filter((n) => {
    const id = take((o) => o.sig === ownSignature(n.s));
    if (id) {
      n.s.id = id;
      used.add(id);
    }
    return !id;
  });
  const still = pending.filter((n) => {
    const id = take((o) => o.path === n.path && o.kind === String(n.s.kind));
    if (id) {
      n.s.id = id;
      used.add(id);
    }
    return !id;
  });
  for (const n of still) {
    const name = String(n.s.name ?? n.s.label ?? '');
    let id = name ? take((o) => o.kind === String(n.s.kind) && o.name === name) : undefined;
    if (!id) {
      do id = newStepId();
      while (used.has(id));
    }
    n.s.id = id;
    used.add(id);
  }
  return out;
}

/** Gives every step an id (keeping existing unique ones). For migration. */
export function ensureIds(steps: BpStep[] | null | undefined, used: Set<string> = new Set()): { steps: BpStep[] | null; changed: boolean } {
  if (!steps) return { steps: steps ?? null, changed: false };
  const out = clone(steps);
  let changed = false;
  walkSteps(out, (s) => {
    if (typeof s.id !== 'string' || used.has(s.id)) {
      let id: string;
      do id = newStepId();
      while (used.has(id));
      s.id = id;
      changed = true;
    }
    used.add(s.id as string);
  });
  return { steps: out, changed };
}

/** A copy of a journey with every step id removed: what the agent is shown. */
export function stripJourneyIds(steps: BpStep[] | null | undefined): BpStep[] | null {
  if (!steps) return steps ?? null;
  const out = clone(steps);
  walkSteps(out, (s) => {
    delete s.id;
  });
  return out;
}

/** Every step id used anywhere in these journeys. */
export function idsIn(...journeys: (BpStep[] | null | undefined)[]): Set<string> {
  const used = new Set<string>();
  for (const j of journeys) walkSteps(j, (s) => typeof s.id === 'string' && used.add(s.id));
  return used;
}

/** Finds a step by id: its current address and the trail of forks above it. */
export function findStep(journey: BpStep[] | null | undefined, id: string): { step: Rec; path: string; trail: string[] } | null {
  let hit: { step: Rec; path: string; trail: string[] } | null = null;
  const visit = (steps: BpStep[] | null | undefined, prefix: string, trail: string[]) => {
    (steps ?? []).forEach((st, i) => {
      if (hit) return;
      const s = st as unknown as Rec;
      const path = `${prefix}${i}`;
      if (s.id === id) {
        hit = { step: s, path, trail };
        return;
      }
      const here = String(s.label ?? s.name ?? s.kind);
      ((s.arms as { label?: string; steps?: BpStep[] }[] | undefined) ?? []).forEach((a, ai) => visit(a.steps, `${path}.arms.${ai}.steps.`, [...trail, `${here} › arm "${a.label ?? ai + 1}"`]));
      ((s.paths as { label?: string; steps?: BpStep[] }[] | undefined) ?? []).forEach((p, pi) => visit(p.steps, `${path}.paths.${pi}.steps.`, [...trail, `${here} › path "${p.label ?? pi + 1}"`]));
      visit(s.yes as BpStep[] | undefined, `${path}.yes.`, [...trail, `${here} › yes`]);
      visit(s.no as BpStep[] | undefined, `${path}.no.`, [...trail, `${here} › no`]);
      visit(s.otherwise as BpStep[] | undefined, `${path}.otherwise.`, [...trail, `${here} › anything else`]);
    });
  };
  visit(journey, '', []);
  return hit;
}
