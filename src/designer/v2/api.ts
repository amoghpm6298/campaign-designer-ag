// SSE client for the v2 agent endpoint.
import { apiUrl } from '../api';
import type { AgentResponse, AgentState, CampaignContext, CampaignObject, Focus, TimelineEntry, V2Event, VersionEntry } from './types';
import type { DirectOp } from './EditPopover';

export interface AgentStreamBody {
  sessionId: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  tenantId: string;
  knowledge?: unknown;
  state: AgentState | null;
  answers?: Record<string, string>;
  /** Question ids the manager skipped: the agent assumes and says so. */
  skipped?: string[];
  /** The block on the canvas this message is about. */
  focus?: Focus | null;
  /** An app-started repair turn. */
  repair?: boolean;
}

export async function runAgentStream(
  body: AgentStreamBody,
  handlers: { onEvent: (e: V2Event) => void; onResult: (r: AgentResponse) => void; onError: (m: string) => void },
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(apiUrl('/api/agent/stream'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    handlers.onError((e as Error).name === 'AbortError' ? 'Cancelled.' : (e as Error).message);
    return;
  }
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => '');
    handlers.onError(`Request failed (${res.status}). ${txt.slice(0, 200)}`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (frame.startsWith(':')) continue;
        const ev = frame.split('\n').find((l) => l.startsWith('event:'))?.slice(6).trim();
        const data = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!data) continue;
        let payload: unknown;
        try {
          payload = JSON.parse(data.slice(5).trim());
        } catch {
          continue;
        }
        if (ev === 'event') handlers.onEvent(payload as V2Event);
        else if (ev === 'result') {
          terminal = true;
          handlers.onResult(payload as AgentResponse);
        } else if (ev === 'error') {
          terminal = true;
          handlers.onError((payload as { error: string }).error);
        }
      }
    }
    if (!terminal) handlers.onError('The connection closed before the run finished.');
  } catch (e) {
    handlers.onError((e as Error).name === 'AbortError' ? 'Cancelled.' : (e as Error).message);
  }
}

export interface Stores {
  campaign: CampaignObject | null;
  context: CampaignContext | null;
}

/** Submitted for execution: who and when. A submitted campaign is locked. */
export interface Submission {
  at: string;
  by: string;
  startDate?: string;
  endDate?: string;
}

/** A submission taken back (also how a campaign is paused). */
export interface Withdrawal {
  at: string;
  by: string;
}

export async function submitCampaignApi(sessionId: string, tenantId: string, startDate: string, endDate: string): Promise<{ ok: boolean; submission?: Submission; error?: string }> {
  const res = await fetch(apiUrl('/api/campaign/submit'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, tenantId, startDate, endDate }) });
  return (await res.json().catch(() => ({ ok: false, error: 'Could not reach the server.' }))) as { ok: boolean; submission?: Submission; error?: string };
}

export async function copyCampaign(sessionId: string, tenantId: string): Promise<{ ok: boolean; sessionId?: string; name?: string; error?: string }> {
  const res = await fetch(apiUrl('/api/campaign/copy'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, tenantId }) });
  return (await res.json().catch(() => ({ ok: false, error: 'Could not reach the server.' }))) as { ok: boolean; sessionId?: string; name?: string; error?: string };
}

export async function withdrawCampaign(sessionId: string, tenantId: string): Promise<{ ok: boolean; withdrawal?: Withdrawal; error?: string }> {
  const res = await fetch(apiUrl('/api/campaign/withdraw'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, tenantId }) });
  return (await res.json().catch(() => ({ ok: false, error: 'Could not reach the server.' }))) as { ok: boolean; withdrawal?: Withdrawal; error?: string };
}

/** The campaign object and its context, as this chat has them on file on the server. */
export async function fetchStores(sessionId: string): Promise<Stores & { submission: Submission | null; lastWithdrawal: Withdrawal | null }> {
  const res = await fetch(apiUrl(`/api/campaign?sessionId=${encodeURIComponent(sessionId)}`));
  if (!res.ok) return { campaign: null, context: null, submission: null, lastWithdrawal: null };
  const body = (await res.json()) as Partial<Stores> & { submission?: Submission | null; lastWithdrawal?: Withdrawal | null };
  return { campaign: body.campaign ?? null, context: body.context ?? null, submission: body.submission ?? null, lastWithdrawal: body.lastWithdrawal ?? null };
}

export interface EditResult {
  ok: boolean;
  error?: string;
  campaign?: CampaignObject;
  context?: CampaignContext;
  version?: VersionEntry;
  timeline?: TimelineEntry;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await res.json().catch(() => ({ ok: false, error: `Request failed (${res.status})` }))) as T;
}

/** A direct edit from the canvas: saved and rebuilt by code, no agent. */
export const directEdit = (sessionId: string, tenantId: string, op: DirectOp) => postJson<EditResult>('/api/campaign/edit', { sessionId, tenantId, op });

/** Restores an old version as a new one. */
export const restoreVersion = (sessionId: string, tenantId: string, n: number) => postJson<EditResult>('/api/campaign/restore', { sessionId, tenantId, n });

export async function listVersions(sessionId: string): Promise<VersionEntry[]> {
  const res = await fetch(apiUrl(`/api/campaign/versions?sessionId=${encodeURIComponent(sessionId)}`));
  if (!res.ok) return [];
  return ((await res.json()) as { versions?: VersionEntry[] }).versions ?? [];
}

export async function getVersion(sessionId: string, n: number): Promise<(VersionEntry & { campaign: CampaignObject }) | null> {
  const res = await fetch(apiUrl(`/api/campaign/version?sessionId=${encodeURIComponent(sessionId)}&n=${n}`));
  if (!res.ok) return null;
  return ((await res.json()) as { version?: VersionEntry & { campaign: CampaignObject } }).version ?? null;
}

/** Hard problems in the saved campaign (unusable links, broken splits, …). */
export async function fetchProblems(sessionId: string, tenantId: string): Promise<string[]> {
  const res = await fetch(apiUrl(`/api/campaign/problems?sessionId=${encodeURIComponent(sessionId)}&tenantId=${encodeURIComponent(tenantId)}`));
  if (!res.ok) return [];
  return ((await res.json()) as { problems?: string[] }).problems ?? [];
}
