/**
 * How the knowledge base is ordered and grouped — one definition, used by the
 * prompt builder and by the screen that shows it.
 *
 * WHY IT LIVES HERE. `server/knowledge.ts` reads files and cannot be imported
 * into the browser bundle; `src/designer/` cannot be imported by the server
 * without dragging React in. This module is pure and depends on neither, so
 * both sides can share it.
 *
 * WHY IT IS SHARED AT ALL. The Knowledge Base page is the only way anyone can
 * check what the agent has been given. If the page groups and orders entries
 * independently of the prompt builder, the two can diverge and the page
 * quietly becomes a nicer version of the truth rather than the truth.
 */

/** The minimum an entry needs for grouping. Both sides' fuller types satisfy it. */
export interface GroupableEntry {
  category: string;
}

/**
 * Grouped by category, in insertion order.
 *
 * Insertion order is deliberate and load-bearing: it is the order
 * `seedKnowledgeBase` builds the entries in, which is the order they reach the
 * model. Sorting alphabetically here would make the screen disagree with the
 * prompt about what the agent reads first.
 */
export function groupKnowledge<T extends GroupableEntry>(entries: T[]): { category: string; entries: T[] }[] {
  const byCat = new Map<string, T[]>();
  for (const e of entries) {
    if (!byCat.has(e.category)) byCat.set(e.category, []);
    byCat.get(e.category)!.push(e);
  }
  return [...byCat].map(([category, items]) => ({ category, entries: items }));
}

/** A document the agent will actually read: processed, and in scope. */
export interface ScopedDoc {
  status: string;
  text?: string;
  scope: string;
}

export const docsForAgent = <T extends ScopedDoc>(docs: T[] | undefined, tenantId?: string): T[] =>
  (docs ?? []).filter((d) => d.status === 'ready' && d.text && (d.scope === 'shared' || d.scope === tenantId));
