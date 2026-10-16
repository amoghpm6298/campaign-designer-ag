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
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or private mode — the prototype still works, just unpersisted */
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
export function appendRunLog(log: RunLog): RunLog[] {
  // Newest first, capped so a long demo cannot exhaust the quota.
  const next = [log, ...loadRunLogs()].slice(0, 60);
  write(LOGS_KEY, next);
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
  lastResponse: unknown;
}
export const loadSession = () => read<DesignerSession>(SESSION_KEY);
export const saveSession = (s: DesignerSession) => write(SESSION_KEY, s);
export const clearSession = () => localStorage.removeItem(SESSION_KEY);
