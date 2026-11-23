// Password-only gate for the hosted copy. Same shape as the Offer Creation
// Agent's (cvp-offer-chatbot server/index.js): one password field, a 30-day
// HttpOnly cookie, nothing to configure but APP_PASSWORD in the server's .env.
// Unset = no gate, which is what `npm run dev:designer` on a laptop gets.
//
// It runs as the first middleware, so it covers the page, every module Vite
// serves and /api. Paths honour the Vite base, because the hosted copy runs
// under /campaigndesigneragent/.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEW_COOKIE, checkViewToken, parseViewCookie, viewAllows } from './viewLinks.ts';

const COOKIE = 'cda_auth';
const MAX_AGE = 30 * 24 * 3600;

const digest = (password: string) => createHash('sha256').update(`campaigndesigneragent:${password}`).digest('hex');

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const page = (action: string, error = '', next = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Smart Engage 2.0</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;font:15px/1.4 system-ui,-apple-system,sans-serif;color:#1d2433}
form{background:#fff;padding:28px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);width:min(320px,calc(100vw - 32px));display:grid;gap:12px}
h1{font-size:18px;margin:0 0 4px}input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #cfd5df}
button{background:#1d2433;color:#fff;border:0;cursor:pointer}.err{color:#b42318;font-size:13px;margin:0}</style></head>
<body><form method="post" action="${escape(action)}"><h1>Smart Engage 2.0</h1>
<input type="password" name="password" placeholder="Password" autofocus required>${next ? `<input type="hidden" name="next" value="${escape(next)}">` : ''}
${error ? `<p class="err">${escape(error)}</p>` : ''}<button>Enter</button></form></body></html>`;

function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((res, rej) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8');
      if (raw.length > 10_000) rej(new Error('Form too large'));
    });
    req.on('end', () => res(new URLSearchParams(raw)));
    req.on('error', rej);
  });
}

type Next = (err?: unknown) => void;

/** Returns null when APP_PASSWORD is unset, so callers register nothing. */
/** `linkSecret` (LINK_SECRET) turns on signed view links: one campaign, read-only, no password. See viewLinks.ts. */
export function passwordGate(password: string | undefined, base: string, linkSecret?: string) {
  if (!password) return null;
  const token = digest(password);
  const prefix = base.endsWith('/') ? base : `${base}/`;
  const loginPath = `${prefix}login`;
  const home = `${prefix}designer.html`;

  const cookie = (req: IncomingMessage, name: string) =>
    (req.headers.cookie ?? '')
      .split(/;\s*/)
      .find((c) => c.startsWith(`${name}=`))
      ?.slice(name.length + 1);
  const authed = (req: IncomingMessage) => {
    const got = cookie(req, COOKIE);
    return !!got && got.length === token.length && timingSafeEqual(Buffer.from(got), Buffer.from(token));
  };

  const html = (res: ServerResponse, status: number, body: string) => {
    res.statusCode = status;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(body);
  };

  return async (req: IncomingMessage, res: ServerResponse, next: Next) => {
    const url = (req.url ?? '').split('?')[0];

    // "Log in to edit" from a view link: back to the same campaign afterwards (only ever a page of this app).
    const safeNext = (n: string | null | undefined) => (n && n.startsWith(prefix) && !n.startsWith('//') && !/[\\\r\n]/.test(n) ? n : home);
    if (url === loginPath && req.method === 'GET') {
      const next = safeNext(new URL(req.url ?? '', 'http://x').searchParams.get('next'));
      if (authed(req)) {
        res.statusCode = 303;
        res.setHeader('location', next);
        return res.end();
      }
      return html(res, 200, page(loginPath, '', next));
    }

    if (url === loginPath && req.method === 'POST') {
      try {
        const form = await readForm(req);
        const next = safeNext(form.get('next'));
        const given = digest(form.get('password') ?? '');
        if (given !== token) return html(res, 401, page(loginPath, 'Wrong password', next));
        const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        res.statusCode = 303;
        res.setHeader('set-cookie', `${COOKIE}=${token}; Path=${prefix}; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure}`);
        res.setHeader('location', next);
        return res.end();
      } catch (e) {
        return next(e);
      }
    }

    // Left open for the deploy's health check, like the Offer Creation
    // Agent's /healthz. It says only whether a key is set and which model.
    if (url === '/api/health' || url === `${prefix}api/health`) return next();
    // The MCP checks its own bearer token (server/mcp/handler.ts).
    if (url === '/mcp' || url === `${prefix}mcp`) return next();
    // Its setup guide, for a teammate's AI to read: public, no secrets in it.
    if (url === '/mcp/guide' || url === `${prefix}mcp/guide`) return next();

    if (authed(req)) return next();

    // A signed view link: one campaign, read-only, no password.
    if (linkSecret) {
      const q = new URL(req.url ?? '', 'http://x').searchParams;
      const path = url.startsWith(prefix) ? `/${url.slice(prefix.length)}` : url;
      const sid = q.get('c') ?? '';
      const token = q.get('view') ?? '';
      if (url === home && sid && token && checkViewToken(linkSecret, sid, token)) {
        const exp = Number(token.split('.')[0]);
        const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        res.setHeader('set-cookie', `${VIEW_COOKIE}=${sid}.${token}; Path=${prefix}; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, exp - Math.floor(Date.now() / 1000))}${secure}`);
        return next();
      }
      const view = parseViewCookie(linkSecret, cookie(req, VIEW_COOKIE));
      if (view) {
        if (viewAllows(view.sessionId, req.method ?? 'GET', path, q)) return next();
        res.statusCode = 403;
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ error: 'This link is view-only.' }));
      }
    }

    if (url.includes('/api/')) {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ error: 'Not signed in - reload the page' }));
    }
    return html(res, 401, page(loginPath));
  };
}
