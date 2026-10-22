/**
 * What the user changed — not a copy of everything.
 *
 * THE BUG THIS REPLACES, and every symptom it caused.
 *
 * `saveKnowledge(kb)` wrote the WHOLE KnowledgeBase to localStorage, and
 * `loadKnowledge()` won over the seed. So the first time anyone edited a
 * single value, all thirty-five entries froze as a snapshot of that instant.
 * Every later seed change — the risk appetite, the channel-order preference,
 * the message-spacing rewording, the India market block — became invisible to
 * that user AND to their agent, with nothing on screen to say so.
 *
 * One blob held two kinds of data: entries WE ship, which change on deploy,
 * and edits THEY make, which change on use. Merging them meant a single edit
 * forked the lot. That one decision produced all of:
 *
 *   - values going stale that the user never touched;
 *   - "Reset to defaults" being the only remedy, which also destroys the edit;
 *   - no way to see what a value was before it was changed;
 *   - no way to tell which entries are the user's and which are ours;
 *   - delete being ambiguous: does a removed seed entry come back on reset?
 *
 * Storing the DIFF fixes all five at once. The seed is recomputed on every
 * load and the user's changes are re-applied on top, so improvements arrive
 * automatically, edits survive them, and reverting is dropping one override
 * rather than discarding the file.
 */
import type { KnowledgeBase, KnowledgeDocument, KnowledgeEntry } from './types';

const KEY = 'hf.kb.overrides.v1';
/** The pre-override key, read once so an existing edit is not lost. */
const LEGACY_KEY = 'drip.designer.knowledge';

export interface EntryOverride {
  value: string;
  editedAt: string;
}

export interface KnowledgeOverrides {
  /** Seeded entries whose value the user replaced, keyed by entry id. */
  overrides: Record<string, EntryOverride>;
  /** Entries the user created. Theirs, and freely deletable. */
  added: KnowledgeEntry[];
  /** Seeded entry ids the user removed. Reversible, because the seed still has them. */
  hidden: string[];
  documents: KnowledgeDocument[];
}

export const emptyOverrides = (): KnowledgeOverrides => ({
  overrides: {},
  added: [],
  hidden: [],
  documents: [],
});

const read = (): KnowledgeOverrides => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...emptyOverrides(), ...(JSON.parse(raw) as KnowledgeOverrides) };
  } catch {
    /* corrupt or unavailable: fall through to the migration, then to empty */
  }
  return migrateLegacy();
};

const write = (o: KnowledgeOverrides): void => {
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch {
    /* quota or private mode — the session still works, just unpersisted */
  }
};

/**
 * Recover what the user changed from the old whole-blob store.
 *
 * Their edits are worth keeping, and the old format cannot tell an edit from a
 * stale seed value by inspection — EXCEPT that an edited entry carries
 * `editedAt`. That is the only reliable signal, so it is the only thing
 * migrated. Everything else in the old blob is a stale copy of a seed we can
 * recompute, and carrying it forward would preserve the exact bug being fixed.
 */
function migrateLegacy(): KnowledgeOverrides {
  const next = emptyOverrides();
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return next;
    const old = JSON.parse(raw) as KnowledgeBase;
    for (const e of old.entries ?? []) {
      if (e.editedAt) next.overrides[e.id] = { value: e.value, editedAt: e.editedAt };
    }
    next.documents = old.documents ?? [];
    write(next);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* unreadable legacy data is not worth failing a page load over */
  }
  return next;
}

export const loadOverrides = (): KnowledgeOverrides => read();

/**
 * The seed with the user's changes applied.
 *
 * `status: 'authoritative'` on anything the user set, and that is not
 * decoration. The seeded values are a prototype's inventions or an author's
 * assertion about the world; a campaign manager stating their own bank's
 * quiet-hours window is the actual authority on it, and the agent is told so.
 */
export function applyOverrides(seed: KnowledgeBase, o: KnowledgeOverrides): KnowledgeBase {
  const hidden = new Set(o.hidden);
  const entries = seed.entries
    .filter((e) => !hidden.has(e.id))
    .map((e) => {
      const ov = o.overrides[e.id];
      return ov
        ? { ...e, value: ov.value, editedAt: ov.editedAt, status: 'authoritative' as const, source: 'your team' }
        : e;
    });
  return { ...seed, entries: [...entries, ...o.added], documents: o.documents };
}

/** What a seeded entry said before the user changed it, for showing alongside. */
export const seedValue = (seed: KnowledgeBase, id: string): string | null =>
  seed.entries.find((e) => e.id === id)?.value ?? null;

export const isUserAdded = (o: KnowledgeOverrides, id: string): boolean =>
  o.added.some((e) => e.id === id);

// --- mutations. Each returns the next overrides and persists it. ---------

export function setEntryValue(o: KnowledgeOverrides, id: string, value: string): KnowledgeOverrides {
  const next: KnowledgeOverrides = {
    ...o,
    // A user-added entry is edited in place; there is no seed underneath it to
    // override, and writing one would leave the original value orphaned.
    added: o.added.map((e) => (e.id === id ? { ...e, value, editedAt: new Date().toISOString() } : e)),
    overrides: isUserAdded(o, id)
      ? o.overrides
      : { ...o.overrides, [id]: { value, editedAt: new Date().toISOString() } },
  };
  write(next);
  return next;
}

/** Drop one override. The seed value returns; nothing else is touched. */
export function revertEntry(o: KnowledgeOverrides, id: string): KnowledgeOverrides {
  const { [id]: _dropped, ...rest } = o.overrides;
  const next = { ...o, overrides: rest, hidden: o.hidden.filter((h) => h !== id) };
  write(next);
  return next;
}

export function addEntry(o: KnowledgeOverrides, entry: Omit<KnowledgeEntry, 'id' | 'status' | 'source'>): KnowledgeOverrides {
  const id = `user:${entry.category}:${entry.label}`.toLowerCase().replace(/[^a-z0-9:]+/g, '-');
  const next: KnowledgeOverrides = {
    ...o,
    added: [
      ...o.added.filter((e) => e.id !== id),
      { ...entry, id, status: 'authoritative', source: 'your team', editedAt: new Date().toISOString() },
    ],
  };
  write(next);
  return next;
}

/**
 * Remove an entry.
 *
 * A user-added entry is deleted outright because it has no seed behind it. A
 * SEEDED entry is hidden rather than destroyed — the seed still holds it, so
 * the action is reversible and "delete" never means "lose something we could
 * have given back".
 */
export function removeEntry(o: KnowledgeOverrides, id: string): KnowledgeOverrides {
  const next: KnowledgeOverrides = isUserAdded(o, id)
    ? { ...o, added: o.added.filter((e) => e.id !== id) }
    : { ...o, hidden: [...new Set([...o.hidden, id])] };
  write(next);
  return next;
}

export function setDocuments(o: KnowledgeOverrides, documents: KnowledgeDocument[]): KnowledgeOverrides {
  const next = { ...o, documents };
  write(next);
  return next;
}

/** Drop every change. The seed is untouched, so this cannot lose seeded data. */
export function resetAll(): KnowledgeOverrides {
  const next = emptyOverrides();
  write(next);
  return next;
}

/** How many of the user's own changes are in play, for the summary. */
export const changeCount = (o: KnowledgeOverrides): number =>
  Object.keys(o.overrides).length + o.added.length + o.hidden.length;
