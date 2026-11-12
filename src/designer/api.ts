// The only transport to the server. No key, no provider detail, no prompt
// construction happens on the client.
import type { Capabilities, KnowledgeBase, Tenant } from './types';

/**
 * '/api/x' under the app's base path. Base is '/' locally and
 * '/campaigndesigneragent/' when hosted under a sub-path (`vite --base`).
 */
export const apiUrl = (path: string) => import.meta.env.BASE_URL.replace(/\/$/, '') + path;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
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
