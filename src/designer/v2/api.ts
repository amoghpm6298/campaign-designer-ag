// SSE client for the v2 agent endpoint.
import { apiUrl } from '../api';
import type { AgentResponse, AgentState, CampaignContext, CampaignObject, V2Event } from './types';

export interface AgentStreamBody {
  sessionId: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  tenantId: string;
  knowledge?: unknown;
  state: AgentState | null;
  answers?: Record<string, string>;
  /** Question ids the manager skipped: the agent assumes and says so. */
  skipped?: string[];
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

/** The campaign object and its context, as this chat has them on file on the server. */
export async function fetchStores(sessionId: string): Promise<Stores> {
  const res = await fetch(apiUrl(`/api/campaign?sessionId=${encodeURIComponent(sessionId)}`));
  if (!res.ok) return { campaign: null, context: null };
  const body = (await res.json()) as Partial<Stores>;
  return { campaign: body.campaign ?? null, context: body.context ?? null };
}
