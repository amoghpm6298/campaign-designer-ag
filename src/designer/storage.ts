// localStorage persistence. The simplest mechanism this stack supports —
// no database, no server state, and it survives navigation and reloads,
// which is what the Knowledge Base and Run Logs actually need.
import type { KnowledgeBase, RunLog, ChatTurn } from './types';
import type { DripCampaign } from '../data/graphTypes';

const KB_KEY = 'dc-agent-knowledge-v1';
const LOGS_KEY = 'dc-agent-runlogs-v1';
const SESSION_KEY = 'dc-agent-session-v1';
const TENANT_KEY = 'dc-agent-tenant-v1';

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
/**
 * Returns whether the write actually landed.
 *
 * It used to return void and swallow the failure. That is right for the
 * "private mode, nothing persists" case and wrong for a full quota: the app
 * carried on as though it had saved, and every chat and log from that point
 * on was silently discarded. A caller that can prune and retry needs to be
 * told.
 */
function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    /* quota or private mode — the prototype still works, just unpersisted */
    return false;
  }
}

export const loadKnowledge = () => read<KnowledgeBase>(KB_KEY);

/**
 * Formats whose text can actually be extracted in the browser. Anything else
 * is rejected at selection rather than accepted and silently not read — a
 * document the agent cannot read must never look like one it can.
 */
export const SUPPORTED_DOC_TYPES = ['.md', '.txt', '.csv', '.json'] as const;
/** localStorage is the only store here, so a document has to fit in it. */
export const MAX_DOC_BYTES = 400_000;

export function isSupportedDoc(filename: string): boolean {
  return SUPPORTED_DOC_TYPES.some((ext) => filename.toLowerCase().endsWith(ext));
}
export const saveKnowledge = (kb: KnowledgeBase) => write(KB_KEY, kb);
export const clearKnowledge = () => localStorage.removeItem(KB_KEY);

export function loadRunLogs(): RunLog[] {
  return read<RunLog[]>(LOGS_KEY) ?? [];
}

/**
 * How many CHATS keep their detailed logs.
 *
 * THE DEFECT THIS FIXES, measured in a browser with sixteen chats of five
 * turns each. Logs were capped at 60 TURNS globally — `slice(0, 60)` — while
 * sessions are capped at 40 CHATS. A turn budget divided by turns-per-chat is
 * a chat budget, so the log store covered only the newest twelve chats: four
 * chats listed, opened, and showed an empty Logs tab reading "No run has
 * completed in this chat yet" about five runs that had all completed. The
 * transcript went with them, because the Conversation tab is built from the
 * logs too.
 *
 * The two caps have to be aligned in UNITS or the mismatch comes back at a
 * different ratio. Eviction is per chat and oldest first, so a chat's logs
 * are either all there or all gone — a half-logged conversation is a worse
 * record than an absent one, because nothing says which turns are missing.
 *
 * Lower than `MAX_SESSIONS` deliberately, and that asymmetry is now a
 * decision rather than an accident: a real log measures ~40 KB against a
 * ~5 MB origin quota, so 40 chats of logs would not fit beside the sessions
 * themselves. The SESSION is what matters — it lists, it resumes, it holds
 * the transcript — and the log is diagnostic detail. So detail is what gets
 * dropped first, and a chat whose logs have gone still opens, still resumes,
 * and says plainly that the detail was discarded.
 */
export const MAX_LOG_CHATS = 12;
/** A hard byte-ish backstop, in case one chat runs very long. */
export const MAX_LOG_TURNS = 120;

/** Session ids in the order their newest log was written. */
const chatOrder = (logs: RunLog[]): string[] => {
  const seen: string[] = [];
  for (const l of logs) if (!seen.includes(l.sessionId)) seen.push(l.sessionId);
  return seen;
};

/**
 * Keep whole chats, newest first, within both budgets.
 *
 * `logs` must already be newest-first, which is how `appendRunLog` holds
 * them.
 */
export function pruneRunLogs(logs: RunLog[], maxChats = MAX_LOG_CHATS): RunLog[] {
  const keep = new Set(chatOrder(logs).slice(0, maxChats));
  return logs.filter((l) => keep.has(l.sessionId)).slice(0, MAX_LOG_TURNS);
}

export function appendRunLog(log: RunLog): RunLog[] {
  let next = pruneRunLogs([log, ...loadRunLogs()]);
  // A full quota is not a reason to lose THIS turn. Drop the oldest chat and
  // try again, down to the newest chat alone, before giving up.
  for (let chats = MAX_LOG_CHATS; chats >= 1; chats--) {
    next = pruneRunLogs([log, ...loadRunLogs()], chats);
    if (write(LOGS_KEY, next)) return next;
  }
  return next;
}
export function clearRunLogs(): void {
  localStorage.removeItem(LOGS_KEY);
}

/** The live designer session, so navigating away and back keeps it intact. */
/** Survives reloads so the header selection is sticky. */
export const loadTenantId = (): string | null => {
  try {
    return localStorage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
};
export const saveTenantId = (id: string): void => {
  try {
    localStorage.setItem(TENANT_KEY, id);
  } catch {
    /* ignore */
  }
};

export interface DesignerSession {
  sessionId: string;
  /** The tenant this session was designed for. Used to detect a switch. */
  tenantId?: string;
  messages: ChatTurn[];
  discoveryRounds: number;
  campaign: DripCampaign | null;
  /**
   * The whole last `DesignerResponse`.
   *
   * It already carries `phase`, `brief`, `session`, `pendingBlueprint`,
   * `pendingStrategy` and `graph` — everything resuming a conversation needs.
   * For a long time only four of those were read back on mount, so a plain
   * RELOAD dropped the brief and the confirm gate while the data sat in
   * storage untouched. Resume is mostly a matter of reading what was always
   * being written.
   */
  lastResponse: unknown;
  /** Set on every save, so the chat list can order by most recent. */
  updatedAt?: string;
  /**
   * A monotonic write counter, purely to break ties on `updatedAt`.
   *
   * Two saves inside the same millisecond are ordinary here — React can flush
   * two effects together — and with a timestamp alone the sort was then
   * decided by object key order, so "the chat you were last in" could open
   * the wrong one. Measured by a test before it reached anyone.
   */
  seq?: number;
}

/**
 * EVERY CHAT, NOT JUST THE OPEN ONE.
 *
 * There used to be one slot. `clearSession()` emptied it, so "Start over" was
 * a single unconfirmed click that destroyed the conversation — no history, no
 * undo, nothing to go back to. The fix is not a confirmation dialog: it is
 * that starting a new chat should never have been destructive. Keeping every
 * session means Start over just mints a new id and leaves the old one on the
 * list.
 *
 * Capped, because localStorage is the only store here and a long demo must
 * not exhaust the quota. Oldest goes first, which is also the one least
 * likely to be wanted.
 */
const SESSIONS_KEY = 'dc-agent-sessions-v1';
export const MAX_SESSIONS = 40;

type SessionStore = Record<string, DesignerSession>;

/**
 * Read the store, folding in the single-slot session if one is still there.
 *
 * Runs on every read rather than once, and removes the old key as soon as it
 * has been carried across. Anyone mid-conversation when this ships keeps that
 * conversation — an upgrade that loses the chat it was built to preserve
 * would be a poor advertisement for it.
 */
function readSessions(): SessionStore {
  const store = read<SessionStore>(SESSIONS_KEY) ?? {};
  const legacy = read<DesignerSession>(SESSION_KEY);
  if (legacy?.sessionId && !store[legacy.sessionId]) {
    store[legacy.sessionId] = { ...legacy, updatedAt: legacy.updatedAt ?? new Date().toISOString() };
    write(SESSIONS_KEY, store);
  }
  if (legacy) localStorage.removeItem(SESSION_KEY);
  return store;
}

/** Most recently touched first — the order a chat list is read in. */
const byRecency = (a: DesignerSession, b: DesignerSession) =>
  (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || (b.seq ?? 0) - (a.seq ?? 0);

export function listSessions(): DesignerSession[] {
  return Object.values(readSessions()).sort(byRecency);
}

export const loadSessionById = (id: string): DesignerSession | null => readSessions()[id] ?? null;

/** The chat that was open last, so a reload lands where it left off. */
export const loadSession = (): DesignerSession | null => listSessions()[0] ?? null;

let writes = 0;
export function saveSession(s: DesignerSession): void {
  const store = readSessions();
  const highest = Math.max(0, ...Object.values(store).map((v) => v.seq ?? 0));
  writes = Math.max(writes + 1, highest + 1);
  store[s.sessionId] = { ...s, updatedAt: new Date().toISOString(), seq: writes };
  // A chat nobody ever spoke in is not worth a row, and an empty session is
  // written on every mount. Dropped rather than listed, so starting the app
  // and closing it does not fill the list with blanks.
  for (const [id, v] of Object.entries(store)) {
    if (!v.messages?.length && id !== s.sessionId) delete store[id];
  }
  const ordered = Object.values(store).sort(byRecency);
  write(SESSIONS_KEY, Object.fromEntries(ordered.slice(0, MAX_SESSIONS).map((v) => [v.sessionId, v])));
}

export function deleteSession(id: string): void {
  const store = readSessions();
  delete store[id];
  write(SESSIONS_KEY, store);
}

/**
 * Kept for the tenant-switch path, which genuinely wants the open chat gone.
 *
 * It no longer deletes anything: the session stays in the store and simply
 * stops being the open one. Nothing in this app should destroy a
 * conversation as a side effect of a settings change.
 */
export const clearSession = () => localStorage.removeItem(SESSION_KEY);
