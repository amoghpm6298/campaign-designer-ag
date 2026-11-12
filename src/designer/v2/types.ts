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

export interface BriefFinding {
  aspect: string;
  text: string;
  source: 'manager' | 'assumption' | 'data';
}

export interface AudienceGroup {
  entity: string;
  conditions?: { attribute: string; operator: string; value?: string }[];
  lookbackDays?: number;
  existence?: 'exists' | 'none';
}

export interface Bucket {
  id: string;
  name: string;
  priority: number;
  behaviour: string;
  rule: AudienceGroup[];
  sql?: string;
  evidence: 'measured' | 'manager' | 'hypothesis';
  evidenceNotes: string;
  size?: number;
  sizeError?: string;
  thesis: string;
  metric: string;
  holdoutPct?: number;
  journey: unknown[] | null;
}

export interface CampaignShell {
  name?: string;
  description?: string;
  goal: { eventCategory: string; eventType: string } | null;
  entry: { kind: 'audience'; entity: string; conditions?: unknown[]; groups?: AudienceGroup[] } | null;
  membership: { type: 'locked' | 'open'; refresh?: 'daily' | 'weekly' | 'monthly' } | null;
  segmentationLogic?: string;
  guardrails?: string;
  measurement?: string;
  everyoneElse?: { approach: 'journey' | 'none'; why?: string; journey?: unknown[] } | null;
}

export interface PlanFile {
  brief: { findings: BriefFinding[]; summary?: string };
  campaign: CampaignShell | null;
  buckets: Bucket[];
}

export interface TimelineEntry {
  at: string;
  actor: 'agent' | 'user' | 'app';
  type: string;
  note: string;
}

export interface AgentState {
  planFile: PlanFile;
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
}

export interface V2Turn {
  role: 'user' | 'assistant';
  content: string;
  /** Assistant turns: the questions asked on that turn, for the form. */
  questions?: AgentQuestion[];
  /** Assistant turns: the ordered trace of what the agent did. */
  events?: V2Event[];
  error?: string;
}

