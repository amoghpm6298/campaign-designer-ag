// Client-side mirror of server/agent/types.ts. Kept separate so the browser
// bundle never imports server modules.

export type FlagName = 'goalClear' | 'successClear' | 'membershipClear' | 'questionsAnswered' | 'readyToDesign' | 'campaignBuilt';

export const FLAG_ORDER: FlagName[] = ['goalClear', 'successClear', 'membershipClear', 'questionsAnswered', 'readyToDesign', 'campaignBuilt'];

export const FLAG_LABELS: Record<FlagName, string> = {
  goalClear: 'Goal',
  successClear: 'Success measure',
  membershipClear: 'Locked / open',
  questionsAnswered: 'Questions answered',
  readyToDesign: 'Ready to design',
  campaignBuilt: 'Built & up to date',
};

export type AnswerType = 'single' | 'multi' | 'open';

export interface AgentQuestion {
  id: string;
  aspect: string;
  text: string;
  answerType: AnswerType;
  options?: string[];
  suggestions?: string[];
  answer?: string;
}

export interface AudienceGroup {
  entity: string;
  conditions?: { attribute: string; operator: string; value?: string }[];
  lookbackDays?: number;
  existence?: 'exists' | 'none';
}

/** One bucket in the campaign object: execution fields only. */
export interface CampaignBucket {
  id: string;
  name: string;
  priority: number;
  rule: AudienceGroup[];
  holdoutPct?: number;
  journey: unknown[] | null;
}

/** What the core engine executes. Saved on the server, per chat. */
export interface CampaignObject {
  name?: string;
  description?: string;
  goal: { eventCategory: string; eventType: string } | null;
  entry: { kind: 'audience'; entity: string; conditions?: unknown[]; groups?: AudienceGroup[] } | null;
  membership: { type: 'locked' | 'open'; refresh?: 'daily' | 'weekly' | 'monthly' } | null;
  buckets: CampaignBucket[];
  everyoneElse: { approach: 'journey' | 'none'; journey?: unknown[] } | null;
}

export interface ContextEntry {
  id: string;
  at: string;
  kind: 'answer' | 'brief' | 'bucket' | 'research' | 'sizing' | 'note' | 'metric';
  topic: string;
  bucketId?: string;
  text: string;
  source: 'manager' | 'data' | 'assumption' | 'agent';
  data?: Record<string, unknown>;
}

/** Everything that supports the campaign. Append-only, saved on the server, per chat. */
export interface CampaignContext {
  entries: ContextEntry[];
}

export interface TimelineEntry {
  at: string;
  actor: 'agent' | 'user' | 'app';
  type: string;
  note: string;
}

export interface AgentState {
  campaign: CampaignObject;
  context: CampaignContext;
  flags: Record<FlagName, boolean>;
  timeline: TimelineEntry[];
  questions: AgentQuestion[];
  questionSeq: number;
}

export interface V2Event {
  runId: string;
  seq: number;
  at: string;
  type: string;
  status: 'running' | 'ok' | 'failed';
  title: string;
  detail?: string;
  durationMs?: number;
  data?: { tool?: string; input?: unknown; result?: unknown; text?: string; round?: number } & Record<string, unknown>;
  correlationId?: string;
}

export interface AgentResponse {
  sessionId: string;
  runId: string;
  reply: string;
  error?: string;
  errorDetail?: string;
  state: AgentState;
  questionItems: AgentQuestion[];
  graph: unknown | null;
  campaign: unknown | null;
  buildNotes: string[];
  events: V2Event[];
  warehouseAccess: boolean;
  version?: VersionEntry;
}

export interface V2Turn {
  role: 'user' | 'assistant';
  content: string;
  /** Assistant turns: the questions asked on that turn, for the form. */
  questions?: AgentQuestion[];
  /** Assistant turns: the ordered trace of what the agent did. */
  events?: V2Event[];
  error?: string;
  /** User turns sent from the question form: each question and what was picked (or skipped). */
  answerSet?: AnswerItem[];
  /** User turns sent from a block on the canvas: which block, and its label for the chat tag. */
  focus?: Focus;
  focusLabel?: string;
  /** Written by the app (an automatic-fix request), not the manager. */
  auto?: boolean;
}

/** A block on the canvas the manager pointed at. Ids are the backend's. */
export interface Focus {
  kind: 'step' | 'bucket' | 'entry' | 'goal' | 'everyone_else';
  bucketId?: string;
  stepId?: string;
}

export interface VersionEntry {
  n: number;
  at: string;
  source: 'chat' | 'direct' | 'rollback' | 'migration' | 'repair';
  request: string;
  summary: string;
  counts: { added: number; changed: number; removed: number };
}

export interface AnswerItem {
  aspect: string;
  question: string;
  answer?: string;
  skipped?: boolean;
}

