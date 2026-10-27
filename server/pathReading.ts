/**
 * ONE READING OF A PATH. The compiler, `propose_strategy` and the gate all use
 * it, so they cannot disagree about what the model sent.
 *
 * WHY THIS EXISTS. The same three questions — does this plan cut people, how
 * many messages does it have, does the next step depend on the last one — were
 * answered by four separate tree-walks in four files, and they disagreed:
 *
 *  - `cadenceBlocks` read the steps for who-groups while `trendBlocks` counted
 *    the NAMES in `touches`, so a read-versus-unread fork was an interior to
 *    one and an illegal who-split to the other
 *    (`eval/runs/ui-s-1793016334376`).
 *  - `outputTools` counted send objects while the compiler counted nodes, so a
 *    path with five of six sends attached was filed and Confirm built a
 *    campaign missing a message (`eval/runs/ui-s-1793009889177`).
 *  - the compiler classified a fork by the ABSENCE of `entity`/`attribute`, so
 *    a ticket-size split written as `branch` + `on` was taken for a delivery
 *    fork and its whole tree dropped — seven nested sends compiled to none,
 *    twice, in `eval/runs/ui-s-1793077922155` turn 3.
 *
 * Each of those was fixed where it was found. This is the shape they share.
 *
 * ONE READING ON THE SERVER, and that qualifier is honest rather than
 * decorative: `src/designer/preview.ts` cannot import this — it would pull the
 * compiler and the reducer into the browser bundle — so the client keeps its
 * own fork-title logic. That is tolerable only because the preview decides
 * nothing: it draws a path, and who-cuts, holds and Confirm are all decided
 * here.
 */

/** What a fork is splitting on, read from either place the model may put it. */
export interface ForkAttribute {
  entity?: string;
  attribute: string;
  operator?: string;
  value?: string;
}

/** A step with the fields any reader of a path needs. Deliberately loose: this
 *  PARSES model output rather than constructing it, so a payload from an older
 *  run or one written slightly wrong still reads. */
interface LooseStep {
  kind?: string;
  label?: string;
  name?: string;
  entity?: unknown;
  attribute?: unknown;
  on?: { entity?: unknown; attribute?: unknown; operator?: unknown; value?: unknown } | null;
  outcomes?: unknown[];
  statuses?: unknown[];
  steps?: unknown[];
  yes?: unknown[];
  no?: unknown[];
  paths?: { label?: string; statuses?: unknown; steps?: unknown[] }[];
  arms?: { label?: string; steps?: unknown[] }[];
}

const asStep = (raw: unknown): LooseStep | null =>
  raw && typeof raw === 'object' ? (raw as LooseStep) : null;

const text = (x: unknown): string => String(x ?? '').trim();

/**
 * What this fork splits on, or null if it does not split on a customer value.
 *
 * TWO PLACES, ONE MEANING. The step schema carries `entity`/`attribute` at the
 * top level and also a nested `on` object, and the model uses both — the live
 * run sent `branch` with `on` and nothing at the top. Reading only the top
 * level is what made a ticket-size split look like a delivery fork.
 */
export function forkAttribute(raw: unknown): ForkAttribute | null {
  const step = asStep(raw);
  if (!step) return null;
  const attribute = text(step.attribute) || text(step.on?.attribute);
  if (!attribute) return null;
  return {
    entity: text(step.entity) || text(step.on?.entity) || undefined,
    attribute,
    operator: text(step.on?.operator) || undefined,
    value: text(step.on?.value) || undefined,
  };
}

/**
 * What kind of fork a step is, if any. THE one classification.
 *
 *  - `attribute` — it splits on a customer or transaction value. A guest list.
 *  - `outcome`   — it splits on what happened to the last message. The same
 *                  person, later.
 *  - `experiment`— randomly assigned arms. One group, two treatments.
 *
 * An attribute beats a status: a step carrying both is a cohort split that has
 * also named statuses, and treating it as a delivery fork is the defect above.
 */
export function forkKind(raw: unknown): 'attribute' | 'outcome' | 'experiment' | null {
  const step = asStep(raw);
  if (!step) return null;
  if (step.kind === 'experiment') return 'experiment';
  if (step.kind !== 'branch' && step.kind !== 'condition') return null;
  if (forkAttribute(step)) return 'attribute';
  const hasStatuses = (step.paths ?? []).some((p) => Array.isArray(p?.statuses) && p.statuses.length);
  if (hasStatuses || (step.outcomes ?? []).length) return 'outcome';
  return null;
}

/** The arms of a fork, whichever shape it is written in. */
function armsOf(step: LooseStep): { label: string; steps: unknown[] }[] {
  if (step.paths?.length) {
    return step.paths.map((p) => ({ label: text(p?.label) || 'a group', steps: p?.steps ?? [] }));
  }
  if (step.arms?.length) {
    return step.arms.map((a) => ({ label: text(a?.label) || 'an arm', steps: a?.steps ?? [] }));
  }
  // A CONDITION HAS NO `paths`, AND THAT WAS THE WHOLE BUG. `whoGroups` only
  // ever iterated `step.paths`, so a ticket-size condition — the shape the
  // live run finally got accepted — produced no groups at all and the plan was
  // held for testing nothing.
  if (step.yes || step.no) {
    return [
      { label: text(step.label) || 'the group that matches', steps: step.yes ?? [] },
      { label: 'everyone else', steps: step.no ?? [] },
    ];
  }
  return [];
}

/**
 * Every branch of a step, for walking into — each one ONCE.
 *
 * `armsOf` reads `yes`/`no` when a condition has no `paths`, so listing both
 * that and the raw fields walked them twice. MEASURED: the condition the live
 * run finally filed counted 10 sends against 5 on the canvas, and
 * `outputTools` refuses on exactly that mismatch — so the consolidation that
 * was meant to stop a correct plan being rejected would have rejected the one
 * plan that got through. The arms are listed, and `yes`/`no` are added only
 * when `armsOf` did not already take them (a step carrying `paths` AND `yes`,
 * which the schema does not promise but the model may send).
 */
function children(step: LooseStep): unknown[][] {
  const arms = armsOf(step);
  const kids: unknown[][] = [step.steps ?? [], ...arms.map((a) => a.steps)];
  if (step.yes && !arms.some((a) => a.steps === step.yes)) kids.push(step.yes);
  if (step.no && !arms.some((a) => a.steps === step.no)) kids.push(step.no);
  return kids;
}

/**
 * The most sends any one customer would receive, walking the JSON.
 *
 * `sendSteps` is a TOTAL: every send in every arm. A two-arm experiment with
 * four messages each is eight, and comparing that to the longest route through
 * the compiled graph reports a shortfall that is not there. What a customer
 * experiences is one route, so that is the number.
 *
 * MEASURED, `eval/runs/ui-s-1793086620956` turn 4. The approved plan's
 * `touches` named the nested low-ticket arms as separate path labels, so the
 * fullest *row-group* was 2 (the high-ticket band). The journey built 3 on
 * the low-ticket route. The banner said the plan and the canvas disagreed.
 * They did not: the steps already had the three-message arm. Touch labels
 * are not a guest list — the same mistake `whoGroups` was written to kill.
 */
export function longestSendSteps(steps: unknown[] | undefined): number {
  let onThisPath = 0;
  let throughFork = 0;
  let forked = false;
  for (const raw of steps ?? []) {
    const step = asStep(raw);
    if (!step) continue;
    if (step.kind === 'send') {
      // A send AFTER a fork in the same list has no single arm. The compiler
      // drops it; counting it here would inflate the plan against a graph
      // that honestly does not have it.
      if (!forked) onThisPath += 1;
      continue;
    }
    if (step.kind === 'branch' || step.kind === 'condition' || step.kind === 'experiment') {
      forked = true;
      const arms = armsOf(step).map((a) => longestSendSteps(a.steps));
      throughFork = Math.max(throughFork, 0, ...arms);
    }
  }
  return onThisPath + throughFork;
}

/** How many send steps are in this JSON, at any depth. */
export function sendSteps(steps: unknown[] | undefined): number {
  let n = 0;
  for (const raw of steps ?? []) {
    const step = asStep(raw);
    if (!step) continue;
    if (step.kind === 'send') n += 1;
    for (const kids of children(step)) n += sendSteps(kids);
  }
  return n;
}

/**
 * The GUEST LISTS this path creates: one entry per arm of an attribute fork,
 * with how many sends that arm gets.
 *
 * Engagement arms and experiment arms are interiors and never join the list.
 * An attribute fork nested under either is still found, because the walk
 * descends through anything that is not itself a guest list.
 */
export function whoGroups(steps: unknown[] | undefined): { label: string; sends: number }[] {
  const out: { label: string; sends: number }[] = [];
  for (const raw of steps ?? []) {
    const step = asStep(raw);
    if (!step) continue;
    if (forkKind(step) === 'attribute') {
      for (const arm of armsOf(step)) out.push({ label: arm.label, sends: sendSteps(arm.steps) });
      continue;
    }
    for (const kids of children(step)) out.push(...whoGroups(kids));
  }
  return out;
}

/**
 * EVERY CHANNEL THE STEPS GIVE A JOB TO, at any depth.
 *
 * A send's `channelPreference` is the order it tries, and `fallbackChannel` is
 * what carries it when the first does not land — both are jobs, and both are in
 * the STEPS.
 *
 * MEASURED, `eval/runs/ui-s-1793084077571` turn 4. Every send carried
 * `channelPreference: ['WHATSAPP','SMS']` AND `fallbackChannel: 'SMS'`, and the
 * plan was held `single-channel-habit` — because that check read
 * `touches[].channel`, where the model had written one string per row:
 * "WhatsApp (SMS fallback on delivery failure)". One distinct string, so one
 * channel, so habit. The prose said SMS twice and the steps gave it a job on
 * every message; only the field being counted said otherwise.
 */
export function sendChannels(steps: unknown[] | undefined): Set<string> {
  const out = new Set<string>();
  const add = (x: unknown) => {
    const v = text(x).toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (v) out.add(v);
  };
  for (const raw of steps ?? []) {
    const step = asStep(raw);
    if (!step) continue;
    if (step.kind === 'send') {
      const prefs = (step as { channelPreference?: unknown }).channelPreference;
      if (Array.isArray(prefs)) prefs.forEach(add);
      else add(prefs);
      add((step as { fallbackChannel?: unknown }).fallbackChannel);
    }
    for (const kids of children(step)) for (const c of sendChannels(kids)) out.add(c);
  }
  return out;
}

/**
 * THE SENDS ONE CUSTOMER RECEIVES TOGETHER, as pairs of channel sets.
 *
 * Two messages to the same person at the same point is fatigue. Two messages
 * on two ARMS of a fork is coverage — nobody receives both — and that
 * difference is structural, not something to be read off a sentence.
 *
 * WHY THIS EXISTS. `channel-spray` keyed on `touches[].path` + `day`, with an
 * escape that looked for two different landed cases in the
 * `ifStillUnconverted` PROSE. That is the same defect `single-channel-habit`
 * had: it accuses from the table. Two exclusive arms written under one path
 * NAME are two rows, one path, one day — so the check fires, and the escape
 * only clears it if the model happened to describe each arm's landed case in
 * the right field. It releases on a sentence and accuses on a silence.
 *
 * TOGETHER MEANS ONE OF TWO THINGS THE STEPS ACTUALLY SAY, and no day
 * arithmetic is invented:
 *
 *  - adjacent on one chain with nothing between them that passes time, so
 *    they fire at the same point; or
 *  - both DECLARING the same `delayDays`, which is the plan saying it.
 *
 * A send before a fork and a send on one of its arms are on the same chain, so
 * they are compared. Sends on SIBLING arms never are.
 */
export function coSentPairs(steps: unknown[] | undefined): { a: Set<string>; b: Set<string> }[] {
  const pairs: { a: Set<string>; b: Set<string> }[] = [];
  /** One send as this walk needs it: when it fires, and on what. */
  type Point = { delay?: number; afterTime: boolean; channels: Set<string> };

  const num = (x: unknown): number | undefined => {
    const n = Number(x);
    return Number.isFinite(n) ? n : undefined;
  };
  const channelsOf = (step: LooseStep): Set<string> => {
    const out = new Set<string>();
    const add = (x: unknown) => {
      const v = text(x).toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (v) out.add(v);
    };
    const prefs = (step as { channelPreference?: unknown }).channelPreference;
    if (Array.isArray(prefs)) prefs.forEach(add);
    else add(prefs);
    return out;
  };
  // A wait is the only thing that moves the clock. A fork does not, which is
  // why a send on an arm can still be same-day with one before it.
  const passesTime = (step: LooseStep) =>
    step.kind === 'wait' || step.kind === 'waitForEvent' || step.kind === 'pause';

  const compare = (chain: Point[]) => {
    for (let i = 0; i < chain.length; i += 1) {
      for (let j = i + 1; j < chain.length; j += 1) {
        const [x, y] = [chain[i], chain[j]];
        // WHAT THE PLAN SAYS BEATS WHERE THE STEP SITS. When both sends
        // declare a day, that is the answer — equal is together, different is
        // not, however adjacent they look. Measured on the first version of
        // this: a send at day 0 followed by a fork whose arms send on day 2
        // read as "adjacent, nothing between them passes time", so two
        // exclusive arms two days later were reported as spray. The arms were
        // not the problem; the adjacency rule overruled their own `delayDays`.
        //
        // Adjacency is the FALLBACK, for the plan that did not say.
        if (x.delay !== undefined && y.delay !== undefined) {
          if (x.delay === y.delay) pairs.push({ a: x.channels, b: y.channels });
          continue;
        }
        if (j === i + 1 && !y.afterTime) pairs.push({ a: x.channels, b: y.channels });
      }
    }
  };

  const walkChain = (list: unknown[] | undefined, chain: Point[]) => {
    let afterTime = false;
    let forked = false;
    for (const raw of list ?? []) {
      const step = asStep(raw);
      if (!step) continue;
      if (step.kind === 'send') {
        chain.push({ delay: num((step as { delayDays?: unknown }).delayDays), afterTime, channels: channelsOf(step) });
        afterTime = false;
        continue;
      }
      if (passesTime(step)) {
        afterTime = true;
        continue;
      }
      const arms = armsOf(step);
      const branches = arms.length ? arms.map((a) => a.steps) : [step.steps ?? []].filter((s) => s.length);
      if (branches.length) {
        forked = true;
        // EACH ARM IS ITS OWN CHAIN, carrying what came before it. Siblings
        // are never compared with each other, which is the whole point.
        for (const b of branches) walkChain(b, [...chain]);
      }
    }
    if (!forked) compare(chain);
  };

  walkChain(steps, []);
  return pairs;
}

/** Does this path run a randomly assigned comparison anywhere in it? */
export function hasExperiment(steps: unknown[] | undefined): boolean {
  for (const raw of steps ?? []) {
    const step = asStep(raw);
    if (!step) continue;
    if (step.kind === 'experiment') return true;
    for (const kids of children(step)) if (hasExperiment(kids)) return true;
  }
  return false;
}
