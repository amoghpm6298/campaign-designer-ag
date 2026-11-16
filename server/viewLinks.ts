// Signed view links: a link that opens ONE campaign, read-only, with no
// password, for 24 hours. Made for the MCP, so a teammate's human can
// open what their agent built without the app password.
//
// The link carries `view=<expiry>.<signature>`; the signature is an HMAC of
// the campaign id and the expiry with LINK_SECRET (server .env). On the first
// request the gate checks it and sets a cookie scoped to that one campaign.
// That cookie allows the page, its modules, and only the read requests the
// page makes for that campaign. Nothing that writes is allowed.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const VIEW_COOKIE = 'cda_view';
/** A view link works for a day; the caller's agent asks for a fresh one after that. */
export const VIEW_HOURS = 24;

const sign = (secret: string, sessionId: string, exp: number) => createHmac('sha256', secret).update(`view:${sessionId}:${exp}`).digest('base64url');

/** The `view` value for a link to this campaign, valid for `hours`. */
export function makeViewToken(secret: string, sessionId: string, hours = VIEW_HOURS, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + hours * 3600;
  return `${exp}.${sign(secret, sessionId, exp)}`;
}

/** True when `token` is a valid, unexpired view of this campaign. */
export function checkViewToken(secret: string, sessionId: string, token: string, now = Date.now()): boolean {
  const [expRaw, sig] = (token ?? '').split('.');
  const exp = Number(expRaw);
  if (!sig || !Number.isFinite(exp) || exp * 1000 < now) return false;
  const want = sign(secret, sessionId, exp);
  return want.length === sig.length && timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}

/** Cookie value: `<sessionId>.<exp>.<sig>`. */
export function parseViewCookie(secret: string, value: string | undefined, now = Date.now()): { sessionId: string; exp: number } | null {
  if (!value) return null;
  const i = value.indexOf('.');
  if (i < 1) return null;
  const sessionId = value.slice(0, i);
  const token = value.slice(i + 1);
  return checkViewToken(secret, sessionId, token, now) ? { sessionId, exp: Number(token.split('.')[0]) } : null;
}

/** Read-only requests a view may make, for its own campaign only. */
const READS_FOR_CAMPAIGN = new Set(['/api/campaign', '/api/campaign/chat', '/api/campaign/versions', '/api/campaign/version', '/api/campaign/problems']);
const READS_ANY_GET = new Set(['/api/version', '/api/bank-settings', '/api/links', '/api/health']);
/** Called with POST by the app, but they only read. */
const READS_POST = new Set(['/api/tenants', '/api/knowledge/seed', '/api/health']);

/** Whether a view of `sessionId` may make this request. `path` is without the base; `query` the search params. */
export function viewAllows(sessionId: string, method: string, path: string, query: URLSearchParams): boolean {
  if (!path.startsWith('/api/')) return method === 'GET' || method === 'HEAD';
  if (method === 'GET' && READS_ANY_GET.has(path)) return true;
  if (method === 'POST' && READS_POST.has(path)) return true;
  if (method === 'GET' && READS_FOR_CAMPAIGN.has(path)) return query.get('sessionId') === sessionId;
  return false;
}
