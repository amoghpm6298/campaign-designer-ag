// The only transport to the server. No key, no provider detail, no prompt
// construction happens on the client.
import type { Capabilities, DesignerResponse, KnowledgeBase, ChatTurn, Tenant } from './types';
import type { DripCampaign } from '../data/graphTypes';

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

export interface HealthResult {
  ok: boolean;
  hasApiKey: boolean;
  model: string;
  modelError?: string;
}
export const getHealth = () => post<HealthResult>('/api/health', {});

export interface VerifyModelResult {
  ok: boolean;
  model: string;
  available?: string[];
  error?: string;
}
export const verifyModel = () => post<VerifyModelResult>('/api/verify-model', {});

export const listTenants = () => post<{ tenants: Tenant[] }>('/api/tenants', {});

export const seedKnowledge = () =>
  post<{ knowledge: KnowledgeBase; capabilities: Capabilities }>('/api/knowledge/seed', {});

export const runDesigner = (body: {
  sessionId: string;
  messages: ChatTurn[];
  knowledge: KnowledgeBase;
  discoveryRounds: number;
  currentCampaign?: DripCampaign | null;
  /** Only the id is sent; the server resolves the tenant's configuration. */
  tenantId: string;
  /** Real account/template ids the user has supplied, keyed by step name. */
  resolvedSends?: Record<string, { account?: string; templateId?: string }>;
  forceProposal?: boolean;
}) => post<DesignerResponse>('/api/designer', body);
