// The execution event contract.
//
// One typed stream used by three consumers: the live activity timeline, the
// persisted run record, and Run Logs. They are the same events, so what you
// watch happening is exactly what you can inspect afterwards.
//
// An event is emitted only when the thing it names actually happened. There
// is no event for work that was skipped, and none carries a secret or model
// reasoning — only decisions, durations and structured results.

export type RunEventType =
  | 'run.started'
  | 'stage.started'
  | 'stage.completed'
  | 'context.retrieval.started'
  | 'context.retrieval.completed'
  | 'model.started'
  | 'model.text.delta'
  | 'model.completed'
  | 'model.failed'
  | 'model.tool_call.requested'
  | 'model.tool_call.started'
  | 'model.tool_call.completed'
  | 'model.tool_call.failed'
  | 'discovery.questions'
  | 'strategy.proposed'
  | 'strategy.confirmed'
  | 'graph.generation.started'
  | 'graph.step.created'
  | 'graph.generation.completed'
  | 'validation.started'
  | 'validation.completed'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled';

export type RunStage = 'understanding' | 'discovery' | 'strategy' | 'generating' | 'validating' | 'review';

export interface RunEvent {
  runId: string;
  seq: number;
  at: string;
  type: RunEventType;
  stage: RunStage;
  status: 'running' | 'ok' | 'failed';
  /** Shown directly in the UI. Plain language, no internals. */
  title: string;
  /** One extra line of context, when useful. */
  detail?: string;
  durationMs?: number;
  /** Structured payload, expandable in the UI. Never secrets. */
  data?: unknown;
  /** Correlates a tool request with its execution and result. */
  correlationId?: string;
}

export class EventEmitterSeq {
  private seq = 0;
  private readonly runId: string;
  private readonly sink: (e: RunEvent) => void;

  constructor(runId: string, sink: (e: RunEvent) => void) {
    this.runId = runId;
    this.sink = sink;
  }

  emit(
    type: RunEventType,
    stage: RunStage,
    title: string,
    opts: { status?: RunEvent['status']; detail?: string; data?: unknown; durationMs?: number; correlationId?: string } = {},
  ): RunEvent {
    const e: RunEvent = {
      runId: this.runId,
      seq: ++this.seq,
      at: new Date().toISOString(),
      type,
      stage,
      status: opts.status ?? 'ok',
      title,
      ...(opts.detail ? { detail: opts.detail } : {}),
      ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
      ...(opts.data !== undefined ? { data: opts.data } : {}),
      ...(opts.correlationId ? { correlationId: opts.correlationId } : {}),
    };
    this.sink(e);
    return e;
  }
}
