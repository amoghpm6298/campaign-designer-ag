// What the campaign actually does, written out before anyone approves it.
//
// THE DEFECT THIS FIXES, in the user's own words: "I can't really understand
// the final design before the graph execution." A proposal carries the
// summary, two candidate architectures with eight fields each, seven option
// verdicts, assumptions, hypotheses and open items — and nowhere does it say
// who gets what, when. The journey has to be reconstructed from fragments
// spread across "Timing:", "Why it should work:" and the approach bullets.
//
// The blueprint has all of it. It was simply never rendered. So this is not
// new information, it is the information that was already there, put in front
// of the person being asked to approve it.
//
// Timing is cumulative and real: a wait of 48 hours moves the next message to
// day 2, and a branch continues from the day its condition was reached rather
// than restarting at zero.
import type { CampaignBlueprint, BpStep, BpCondition } from './blueprint';

const dayLabel = (hours: number) => `Day ${Math.round((hours / 24) * 10) / 10}`.replace('.0', '');

const conditionWords = (cs: BpCondition[] | undefined): string =>
  !cs?.length
    ? ''
    : cs.map((c) => `${c.attribute} ${c.operator.toLowerCase()}${c.value ? ` ${c.value}` : ''}`).join(' and ');

/** Who enters, in a sentence. */
export function entryLine(bp: CampaignBlueprint): string {
  const e = bp.entry;
  if (!e) return 'No entry defined.';
  const where = conditionWords(e.conditions);
  if (e.kind === 'event')
    return `Enters when **${e.eventType}** happens${where ? `, for ${where}` : ''}.`;
  return `Enters anyone on **${e.entity}**${where ? ` where ${where}` : ''}.`;
}

/** What the campaign is trying to make happen. */
export function goalLine(bp: CampaignBlueprint): string {
  if (!bp.goal) return 'No goal set, so nobody exits early for succeeding.';
  const where = conditionWords(bp.goal.conditions);
  return `Succeeds when **${bp.goal.eventType}** happens${where ? ` with ${where}` : ''}. Anyone who does leaves immediately.`;
}

/**
 * The steps, in order, with the day each one lands on.
 *
 * Branches are indented under the point they diverge and carry their own
 * running clock, because "day 4" inside a branch means four days from entry,
 * not four days from the branch.
 */
export function stepLines(steps: BpStep[] | undefined, hours = 0, depth = 0): string[] {
  const out: string[] = [];
  const pad = '  '.repeat(depth);
  let clock = hours;

  for (const s of steps ?? []) {
    switch (s.kind) {
      case 'wait':
        clock += s.durationHours;
        break;
      case 'send': {
        const ch = (s.channelPreference ?? [])[0];
        out.push(`${pad}- **${dayLabel(clock)}** — ${ch ? `${ch}: ` : ''}${s.name}`);
        break;
      }
      case 'waitForEvent':
        out.push(`${pad}- **${dayLabel(clock)}** — waits up to ${s.timeoutDays} days for ${s.eventType}`);
        clock += s.timeoutDays * 24;
        break;
      case 'exit':
        out.push(`${pad}- **${dayLabel(clock)}** — ends here. ${s.reason}`);
        break;
      case 'condition':
        out.push(`${pad}- **${dayLabel(clock)}** — splits on whether the last message was ${(s.outcomes ?? []).join(' or ').toLowerCase() || 'delivered'}:`);
        out.push(`${pad}  **If it was:**`);
        out.push(...stepLines(s.yes, clock, depth + 2));
        out.push(`${pad}  **If it was not:**`);
        out.push(...stepLines(s.no, clock, depth + 2));
        break;
      case 'experiment':
        out.push(`${pad}- **${dayLabel(clock)}** — splits the audience to test ${(s as { tests?: string }).tests ?? 'something'}:`);
        for (const a of s.arms ?? []) {
          out.push(`${pad}  **${a.pct}% — ${a.label}**`);
          out.push(...stepLines(a.steps, clock, depth + 2));
        }
        break;
    }
  }
  return out;
}

/**
 * The whole campaign, as the person approving it needs to see it.
 *
 * Returns '' when there is no blueprint, so a discovery turn renders nothing
 * rather than an empty heading.
 */
export function journeySummary(bp: CampaignBlueprint | null | undefined): string {
  if (!bp?.entry) return '';
  const steps = stepLines(bp.steps);
  const control =
    typeof bp.controlPct === 'number' && bp.controlPct > 0
      ? `\n${bp.controlPct}% are held back and receive nothing, so you can tell the campaign apart from what would have happened anyway.`
      : '';
  return [
    '\n\n**The campaign**',
    entryLine(bp),
    goalLine(bp) + control,
    '',
    ...(steps.length ? steps : ['- No steps defined.']),
  ].join('\n');
}

// ------------------------------------------------------- readable blockers

/**
 * Turn a path into the data structure into a sentence.
 *
 * MEASURED: blockers reach the user as
 * `steps[0].experiment.arms[0][1].wait: 2 open slots exist; the continuation
 * is ambiguous.` That is shown at the exact moment someone is trying to work
 * out what is stopping them shipping, which is the worst possible place to
 * hand them a path into a data structure.
 */
export function readableBlocker(raw: string): string {
  const [path, ...rest] = raw.split(':');
  const problem = rest.join(':').trim();

  // Only rewrite things that are actually paths. Without this guard an
  // ordinary sentence gets parsed as one — "Something went wrong" came back as
  // "(a Something)", which is a worse failure than the one being fixed, since
  // it corrupts messages that were already readable.
  if (!/\[\d+\]/.test(path)) return raw;

  const where: string[] = [];

  // Parsed segment by segment rather than by one regex over the whole path.
  // The single-regex version split `arms[0]` into a bare `arms` and a loose
  // `[0]`, and produced "of the experiment, (a arms), step 1" — which is worse
  // than the path it was replacing.
  for (const seg of path.split('.')) {
    const name = /^[a-zA-Z]+/.exec(seg)?.[0] ?? '';
    const indices = [...seg.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    if (name === 'steps') where.push(`step ${(indices[0] ?? 0) + 1}`);
    else if (name === 'arms') {
      where.push(`arm ${(indices[0] ?? 0) + 1}`);
      // A second index on the same segment is the position inside that arm.
      if (indices[1] !== undefined) where.push(`step ${indices[1] + 1}`);
    } else if (name === 'experiment') where.push('of the experiment');
    else if (name === 'condition') where.push('(a branch)');
    else if (name) where.push(`(a ${name})`);
  }

  const plainProblem = /open slots?/.test(problem)
    ? 'the journey does not say what happens next, so it cannot be built'
    : problem || 'is incomplete';

  return where.length ? `${where.join(', ')} — ${plainProblem}` : raw;
}

/**
 * How many messages one customer actually receives, at most.
 *
 * WHY NOT JUST COUNT THE SEND NODES. The build summary compared the number of
 * touches the manager approved against every SEND node in the graph, and the
 * two are not the same measure. A two-arm wording experiment built from four
 * approved touches produces eight SEND nodes — the same skeleton twice — and
 * the old comparison called that a four-message shortfall. A banner that
 * cries drift on a correct build teaches people to ignore it, which is worse
 * than having no banner.
 *
 * What a customer experiences is the DENSITY of one path, so that is what is
 * compared: the most sends on any single route through the journey.
 *
 * MEMOISED, AND SHARED TAILS ARE NOT RECOUNTED. The builder allows fan-in —
 * two branches can rejoin, and the canvas has a "Reused in N places" badge
 * for exactly that — so a plain walk would count a shared ending once per
 * route that reaches it, and would spin for ever on a cycle. `best` caches
 * the answer per node and `visiting` breaks any loop, which makes this linear
 * in the graph and safe on a shape nobody anticipated.
 *
 * GOAL_EXIT is ignored because it is the application's own terminal marker,
 * not a message. A SEND counts once, as one message.
 */
export function longestSendPath(graph: {
  rootId?: string | null;
  nodes: Record<string, { type: string }>;
  edges: { from: string; to: string | null }[];
}): number {
  const out = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!e.to) continue;
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  }
  const best = new Map<string, number>();
  const visiting = new Set<string>();

  const from = (id: string): number => {
    const node = graph.nodes[id];
    if (!node || node.type === 'GOAL_EXIT') return 0;
    const cached = best.get(id);
    if (cached !== undefined) return cached;
    // A cycle contributes nothing beyond the node itself rather than hanging
    // the turn. The builder should not produce one; this is not the place to
    // find out that it did.
    if (visiting.has(id)) return node.type === 'SEND' ? 1 : 0;
    visiting.add(id);
    const deepest = Math.max(0, ...(out.get(id) ?? []).map(from));
    visiting.delete(id);
    const total = (node.type === 'SEND' ? 1 : 0) + deepest;
    best.set(id, total);
    return total;
  };

  const roots = graph.rootId && graph.nodes[graph.rootId] ? [graph.rootId] : Object.keys(graph.nodes);
  return Math.max(0, ...roots.map(from));
}
