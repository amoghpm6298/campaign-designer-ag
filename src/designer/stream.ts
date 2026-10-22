// SSE consumer.
//
// Uses fetch + a stream reader rather than EventSource, because the run needs
// a POST body. Events are delivered in the order the server emitted them, and
// a partial frame at a chunk boundary is held back until it completes.
import type { DesignerResponse, RunEvent } from './types';

export interface StreamHandlers {
  onEvent: (e: RunEvent) => void;
  onResult: (r: DesignerResponse) => void;
  onError: (message: string) => void;
}

export interface StreamRequest {
  sessionId: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  knowledge: unknown;
  discoveryRounds: number;
  tenantId: string;
  currentCampaign?: unknown;
  resolvedSends?: Record<string, { account?: string; templateId?: string }>;
  forceProposal?: boolean;
  intent?: 'converse' | 'confirm';
  confirmedBlueprint?: unknown;
  confirmedStrategy?: unknown;
  /** Round-tripped so the server's state machine survives every turn. */
  brief?: unknown;
  session?: unknown;
}

export async function runDesignerStream(
  body: StreamRequest,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/designer/stream', {
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
  /**
   * Did the run END, by either door?
   *
   * This was `sawResult`, set only by a result frame — so an `error` frame
   * called `onError` and left it false, and the fallback below then fired a
   * SECOND time when the socket closed. Measured on a live Confirm: the
   * manager got "Illegal state transition…" and, underneath it, "The
   * connection closed before the run finished." Two failures reported, one
   * of them invented, and the invented one is the less useful of the two to
   * read last.
   *
   * An error IS a terminal frame. The fallback exists for the case where
   * neither arrives.
   */
  let sawTerminal = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (frame.startsWith(':')) continue; // comment / keep-alive

        const evLine = frame.split('\n').find((l) => l.startsWith('event:'));
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        let payload: unknown;
        try {
          payload = JSON.parse(dataLine.slice(5).trim());
        } catch {
          continue; // a malformed frame must not abort the run
        }
        const kind = evLine?.slice(6).trim();
        if (kind === 'event') handlers.onEvent(payload as RunEvent);
        else if (kind === 'result') {
          sawTerminal = true;
          handlers.onResult(payload as DesignerResponse);
        } else if (kind === 'error') {
          sawTerminal = true;
          handlers.onError((payload as { error: string }).error);
        }
      }
    }
    // A stream that ends without a terminal frame is a failure, not a
    // success — otherwise the UI would sit in "running" forever.
    if (!sawTerminal) handlers.onError('The connection closed before the run finished.');
  } catch (e) {
    handlers.onError((e as Error).name === 'AbortError' ? 'Cancelled.' : (e as Error).message);
  }
}
