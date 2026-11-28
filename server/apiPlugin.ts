// The server surface, as a Vite plugin.
//
// This repo is a static SPA with no backend, so there was nowhere to put a
// server-side call. A Vite middleware plugin is the smallest thing that gives
// one: it runs in Node during `npm run dev` and `npm run preview`, so the API
// key is read from process.env and never reaches the browser bundle.
//
// The client bundle imports NOTHING from this directory — the only transport
// is fetch('/api/...').
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

/** This file's own directory, so run records land next to the scripted ones. */
const here = dirname(fileURLToPath(import.meta.url));

/** Changes on every deploy (the server restarts), so an open tab can tell it is running old code. */
const SERVER_VERSION = String(Date.now());
import type { Plugin, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { passwordGate } from './passwordGate.ts';

type Handler = (body: unknown) => Promise<{ status: number; json: unknown }>;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      chunks.push(c);
      // 2 MB ceiling: a conversation plus a knowledge base, nothing larger.
      if (chunks.reduce((n, b) => n + b.length, 0) > 2_000_000) rej(new Error('Request body too large'));
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return res({});
      try {
        res(JSON.parse(raw));
      } catch {
        rej(new Error('Request body was not valid JSON'));
      }
    });
    req.on('error', rej);
  });
}

/**
 * Server-Sent Events. Chosen because the stream is one-directional and the
 * stack already speaks plain HTTP — no extra transport or queue needed.
 */
async function streamSse(
  res: ServerResponse,
  run: AsyncGenerator<unknown, unknown>,
): Promise<void> {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  // Flush headers immediately so the browser starts reading.
  res.write(': open\n\n');

  const write = (event: string, data: unknown) => {
    if (res.writableEnded) return false;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  };

  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  // Everything this turn produced, so it can be written to disk alongside the
  // scripted runs when it finishes. See `recordTurn`.
  const collected: unknown[] = [];

  try {
    while (true) {
      const next = await run.next();
      if (closed) {
        // The client went away. Stop pulling rather than leaving the run
        // spinning forever against a socket nobody is reading.
        await run.return?.(undefined);
        break;
      }
      if (next.done) {
        write('result', next.value);
        recordTurn(collected, next.value);
        break;
      }
      collected.push(next.value);
      write('event', next.value);
    }
  } catch (e) {
    write('error', { error: (e as Error).message });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

/**
 * Write a UI turn to disk, next to the scripted runs.
 *
 * WHY THIS EXISTS. A run done by hand in the designer went only to
 * localStorage in that browser; the server wrote nothing. So the runs that
 * matter most — someone actually using the product — were the only ones
 * nobody else could read, could not be attached to a bug report, and never
 * reached the published run log, while scripted runs did. That is backwards.
 *
 * Best effort by design: a failure to write a log must never interrupt a
 * conversation, so everything here is wrapped and silent.
 */
function recordTurn(events: unknown[], result: unknown): void {
  try {
    const r = result as { sessionId?: string; runId?: string; phase?: string } | null;
    if (!r?.sessionId) return;
    const dir = resolve(here, `../eval/runs/ui-${r.sessionId}`);
    mkdirSync(resolve(dir, 'turns'), { recursive: true });
    const n = readdirSync(resolve(dir, 'turns')).length + 1;
    writeFileSync(
      resolve(dir, 'turns', `turn-${n}.json`),
      JSON.stringify({ at: new Date().toISOString(), events, response: result }, null, 1),
    );
    // Rewritten each turn so the folder is readable without opening every
    // file, and so an abandoned session still says where it got to.
    writeFileSync(
      resolve(dir, 'meta.json'),
      JSON.stringify({ sessionId: r.sessionId, source: 'designer UI', turns: n, lastPhase: r.phase ?? null, lastAt: new Date().toISOString() }, null, 1),
    );
  } catch {
    /* a log that cannot be written must not take the conversation with it */
  }
}

const send = (res: ServerResponse, status: number, json: unknown) => {
  const body = JSON.stringify(json);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
};

// Loaded through a variable path on purpose.
//
// vite.config.ts is compiled by the project's `nodenext` tsconfig, which
// requires explicit file extensions. The server modules import the app's own
// `src/` and `agent-proto/` files extensionlessly, so pulling that whole
// graph into the nodenext project makes every one of those imports
// unresolvable. Keeping the import opaque here keeps the two module systems
// apart: Vite resolves these at runtime, and `npm run server:typecheck`
// type-checks them properly under bundler resolution.
// The server modules are loaded through VITE's module runner, not raw Node
// ESM. Two reasons, both load-bearing:
//
//   1. They import the application's own src/ and agent-proto/ modules
//      extensionlessly, which Node cannot resolve but Vite can.
//   2. vite.config.ts is compiled into node_modules/.vite-temp/, so a
//      relative specifier would resolve against that temp directory.
//
// Hence an absolute path from the project root, handed to ssrLoadModule.
const serverDir = resolve(process.cwd(), 'server');

type Mod = Record<string, (...args: never[]) => unknown>;
export type ModuleLoader = (file: string) => Promise<Mod>;

function viteLoader(server: ViteDevServer): ModuleLoader {
  return async (file: string) => {
    const abs = join(serverDir, file);
    if (!existsSync(abs)) {
      throw new Error(`Cannot find ${abs}. Run the dev server from the drip-campaigns directory.`);
    }
    // Vite 7 exposes the runner through environments; ssrLoadModule remains
    // as the stable entry point. Try the modern path, then fall back.
    const env = (server as unknown as { environments?: { ssr?: { runner?: { import: (u: string) => Promise<unknown> } } } })
      .environments?.ssr?.runner;
    if (env) return (await env.import(abs)) as Mod;
    return (await server.ssrLoadModule(pathToFileURL(abs).href)) as Mod;
  };
}

async function routes(loadModule: ModuleLoader): Promise<Record<string, Handler>> {
  // Loaded inside the handler so an edit is picked up without restarting the
  // dev server, and so a load error surfaces as a 500 with a message rather
  // than killing the server at boot.
  const anth = await loadModule('anthropic.ts');
  const know = await loadModule('knowledge.ts');
  const ten = await loadModule('tenants.ts');

  const verifyModel = anth.verifyModel as () => Promise<unknown>;
  const hasApiKey = anth.hasApiKey as () => boolean;
  const resolveModel = anth.resolveModel as () => string;
  const seedKnowledgeBase = know.seedKnowledgeBase as () => unknown;
  const loadCapabilities = know.loadCapabilities as () => unknown;
  const listTenants = ten.listTenants as () => unknown;

  return {
    '/api/health': async () => {
      // Reports whether a key is PRESENT. Never the key, never a prefix.
      let model = 'unresolved';
      let modelError: string | undefined;
      try {
        model = resolveModel();
      } catch (e) {
        modelError = (e as Error).message;
      }
      return { status: 200, json: { ok: hasApiKey() && !modelError, hasApiKey: hasApiKey(), model, modelError } };
    },
    '/api/verify-model': async () => ({ status: 200, json: await verifyModel() }),
    '/api/tenants': async () => ({ status: 200, json: { tenants: listTenants() } }),
    '/api/knowledge/seed': async () => ({
      status: 200,
      json: { knowledge: seedKnowledgeBase(), capabilities: loadCapabilities() },
    }),
  };
}


export function agentApiPlugin(): Plugin {
  return {
    name: 'drip-agent-api',
    configureServer(server: ViteDevServer) {
      const load = viteLoader(server);
      // Hosted copy only (APP_PASSWORD in its .env). First, so it covers
      // the page, every module and /api.
      const gate = passwordGate(process.env.APP_PASSWORD, server.config.base, process.env.LINK_SECRET);
      if (gate) server.middlewares.use(gate);
      // Hosted under a sub-path (`vite --base /x/`), requests arrive as
      // /x/api/...; this middleware runs before Vite strips the base.
      const base = server.config.base.replace(/\/$/, '');
      server.middlewares.use(async (req, res, next) => {
        let url = (req.url ?? '').split('?')[0];
        if (base && url.startsWith(base + '/')) url = url.slice(base.length);
        // The setup and usage guide a teammate's own AI reads (public: it holds no secrets).
        if (url === '/mcp/guide' && (req.method === 'GET' || req.method === 'HEAD')) {
          res.statusCode = 200;
          res.setHeader('content-type', 'text/markdown; charset=utf-8');
          res.setHeader('cache-control', 'no-cache');
          return void res.end(readFileSync(resolve(here, '../docs/mcp-guide.md'), 'utf8'));
        }
        // The MCP for teammates' own agents: token auth, not the app password. See server/mcp/.
        if (url === '/mcp') {
          try {
            const mcp = await load('mcp/handler.ts');
            const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0];
            const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost');
            const out = await (mcp.handleMcpHttp as (i: unknown) => Promise<{ status: number; json?: unknown; headers?: Record<string, string> }>)({
              method: req.method ?? 'GET',
              auth: req.headers.authorization,
              body: req.method === 'POST' ? await readBody(req) : undefined,
              tokens: (mcp.parseTokens as (r: string | undefined) => unknown[])(process.env.MCP_TOKENS),
              // The proxy in front of the hosted copy does not pass the public host on, so it is set there (PUBLIC_APP_URL).
              appUrl: (process.env.PUBLIC_APP_URL ?? `${proto}://${host}${base}`).replace(/\/$/, ''),
            });
            for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
            if (out.json === undefined) {
              res.statusCode = out.status;
              return void res.end();
            }
            return send(res, out.status, out.json);
          } catch (e) {
            return send(res, 500, { error: (e as Error).message });
          }
        }
        if (!url.startsWith('/api/')) return next();
        try {
          if (url === '/api/version') return send(res, 200, { version: SERVER_VERSION });
          // v2: one agent, one prompt, every tool. See server/agent/.
          if (url === '/api/agent/stream' && req.method === 'POST') {
            const agent = await load('agent/loop.ts');
            const body = (await readBody(req)) as Record<string, unknown>;
            if (!Array.isArray(body?.messages)) return send(res, 400, { error: 'messages[] is required' });
            // A submitted campaign is locked; one the MCP is working on takes no second turn.
            if (typeof body.sessionId === 'string') {
              const files = await load('campaignFiles.ts');
              if ((files.loadSubmission as (s: string) => unknown)(body.sessionId)) return send(res, 409, { error: String(files.LOCKED) });
              const runner = await load('mcp/runner.ts');
              if ((runner.isRunning as (s: string) => boolean)(body.sessionId)) return send(res, 409, { error: 'The agent is already working on this campaign (requested from another tool). Reload in a minute.' });
            }
            const gen = (agent.agentStream as (r: unknown) => AsyncGenerator<unknown, unknown>)({
              sessionId: String(body.sessionId ?? `s-${Date.now()}`),
              messages: body.messages,
              tenantId: body.tenantId,
              knowledge: body.knowledge,
              state: body.state ?? null,
              answers: body.answers,
              skipped: body.skipped,
              focus: body.focus ?? null,
              repair: body.repair === true,
              // A new item's intent, product and kind (flow or campaign), chosen when it was created. The loop stores them on the first turn.
              intent: body.intent && typeof body.intent === 'object' ? body.intent : null,
            });
            return void (await streamSse(res, gen));
          }
          // The campaign object and context this chat has on file, so the canvas survives a reload.
          // Submit for execution from the app: the same checks as the MCP's submit_campaign.
          if (url === '/api/campaign/submit' && req.method === 'POST') {
            const sub = await load('submit.ts');
            const body = (await readBody(req)) as { sessionId?: string; tenantId?: string; startDate?: string; endDate?: string };
            try {
              const r = (sub.submitChecked as (s: string, t: string, by: string, d: object) => { ok: boolean; error?: string })(String(body.sessionId ?? ''), String(body.tenantId ?? ''), 'the app', { startDate: body.startDate, endDate: body.endDate });
              return send(res, r.ok ? 200 : 400, r);
            } catch (e) {
              return send(res, 400, { ok: false, error: (e as Error).message });
            }
          }
          // A new editable draft from an existing campaign.
          if (url === '/api/campaign/copy' && req.method === 'POST') {
            const files = await load('campaignFiles.ts');
            const body = (await readBody(req)) as { sessionId?: string; tenantId?: string };
            try {
              return send(res, 200, { ok: true, ...((files.copyCampaign as (s: string, t: string) => object)(String(body.sessionId ?? ''), String(body.tenantId ?? ''))) });
            } catch (e) {
              return send(res, 400, { ok: false, error: (e as Error).message });
            }
          }
          // Convert a campaign that has run into a new always-on flow (the campaign is unchanged).
          // The 90-day trend of the target, for the entry card (cohort for a campaign, weekly inflow for a flow).
          if (url === '/api/campaign/trend' && req.method === 'GET') {
            const tr = await load('trend.ts');
            const q = new URL(req.url ?? '', 'http://x').searchParams;
            const r = (tr.cohortTrend as (s: string, t: string) => object)(q.get('sessionId') ?? '', q.get('tenantId') ?? '');
            return send(res, 200, r);
          }
          // The Analytics tab: the designer's KPI and charts, run on the bank's data within the scope (cached; refresh=1 reruns).
          if (url === '/api/campaign/analytics' && req.method === 'GET') {
            const an = await load('analytics.ts');
            const q = new URL(req.url ?? '', 'http://x').searchParams;
            try {
              return send(res, 200, (an.analyticsFor as (s: string, t: string, f: boolean) => object)(q.get('sessionId') ?? '', q.get('tenantId') ?? '', q.get('refresh') === '1'));
            } catch (e) {
              return send(res, 200, { spec: null, results: {}, error: (e as Error).message });
            }
          }
          // The bank's card logos, with card counts (the Card logos page).
          if (url === '/api/logos' && req.method === 'GET') {
            const lg = await load('logos.ts');
            const tn = await load('tenants.ts');
            const tenantId = new URL(req.url ?? '', 'http://x').searchParams.get('tenantId') ?? '';
            return send(res, 200, { logos: (lg.logosFor as (t: unknown) => unknown[])((tn.resolveTenant as (t: string) => unknown)(tenantId)) });
          }
          if (url === '/api/campaign/convert' && req.method === 'POST') {
            const conv = await load('convertToFlow.ts');
            const body = (await readBody(req)) as { sessionId?: string; tenantId?: string; name?: string; note?: string };
            try {
              const r = (conv.convertToFlow as (s: string, t: string, o: { name: string; note?: string; by: string }) => object)(String(body.sessionId ?? ''), String(body.tenantId ?? ''), {
                name: String(body.name ?? ''),
                note: typeof body.note === 'string' ? body.note : '',
                by: 'Campaign manager',
              });
              return send(res, 200, { ok: true, ...r });
            } catch (e) {
              return send(res, 400, { ok: false, error: (e as Error).message });
            }
          }
          // Stop a submitted campaign: back to Ready, editable; it can be submitted again.
          if (url === '/api/campaign/withdraw' && req.method === 'POST') {
            const files = await load('campaignFiles.ts');
            const body = (await readBody(req)) as { sessionId?: string; tenantId?: string };
            try {
              const w = (files.withdrawCampaign as (s: string, t: string, by: string) => unknown)(String(body.sessionId ?? ''), String(body.tenantId ?? ''), 'the app');
              return send(res, 200, { ok: true, withdrawal: w });
            } catch (e) {
              return send(res, 400, { ok: false, error: (e as Error).message });
            }
          }
          if (url === '/api/campaign' && req.method === 'DELETE') {
            const files = await load('campaignFiles.ts');
            const q = new URL(req.url ?? '', 'http://x').searchParams;
            try {
              (files.deleteCampaign as (s: string, t: string) => void)(q.get('sessionId') ?? '', q.get('tenantId') ?? '');
              return send(res, 200, { ok: true });
            } catch (e) {
              return send(res, 400, { ok: false, error: (e as Error).message });
            }
          }
          if (url === '/api/campaign' && req.method === 'GET') {
            const files = await load('campaignFiles.ts');
            const sessionId = new URL(req.url ?? '', 'http://x').searchParams.get('sessionId') ?? '';
            try {
              const stores = (files.loadStores as (id: string) => { campaign: unknown; context: unknown })(sessionId);
              const ws = (files.loadWithdrawals as (s: string) => unknown[])(sessionId);
              const conv = await load('convertToFlow.ts');
              return send(res, 200, {
                campaign: stores.campaign ?? null,
                context: stores.context ?? null,
                submission: (files.loadSubmission as (s: string) => unknown)(sessionId),
                lastWithdrawal: ws[ws.length - 1] ?? null,
                // The flows this campaign became (Convert to flow).
                conversions: (conv.loadConversions as (s: string) => unknown[])(sessionId),
              });
            } catch {
              return send(res, 400, { error: 'Not a valid session id.' });
            }
          }
          // What the campaign's offers may cost, worked out by code (never stored).
          if (url === '/api/campaign/cost' && req.method === 'GET') {
            const files = await load('campaignFiles.ts');
            const C = await load('costModel.ts');
            const T = await load('tenants.ts');
            const q = new URL(req.url ?? '', 'http://x').searchParams;
            try {
              const st = (files.loadStores as (id: string) => { campaign: unknown; context: unknown })(q.get('sessionId') ?? '');
              if (!st.campaign) return send(res, 200, { mode: 'none', lines: [], buckets: [], total: { expected: 0, max: 0, maxWithCap: 0 }, budgetCap: null, notes: [], routes: [], messages: [] });
              const report = (C.campaignCost as (c: unknown, x: unknown, t: unknown) => Record<string, unknown>)(st.campaign, st.context, (T.resolveTenant as (id: string) => unknown)(q.get('tenantId') ?? ''));
              // A flow runs every month: its cost is per month, from how many people join (server/flowCost.ts).
              const F = await load('flowCost.ts');
              const monthly = (F.flowMonthly as (s: string, t: string, r: unknown) => unknown)(q.get('sessionId') ?? '', q.get('tenantId') ?? '', report);
              return send(res, 200, monthly ? { ...report, monthly } : report);
            } catch (e) {
              return send(res, 400, { error: (e as Error).message });
            }
          }
          // Run a bucket's saved sizing query again, now, against the bank's warehouse.
          if (url.startsWith('/api/campaign/sizing') && req.method === 'GET') {
            const s = await load('sizingRun.ts');
            const q = new URL(req.url ?? '', 'http://x').searchParams;
            const r = (s.runBucketSizing as (a: string, b: string, c: string) => { ok: boolean })(q.get('sessionId') ?? '', q.get('tenantId') ?? '', q.get('bucketId') ?? '');
            return send(res, r.ok ? 200 : 400, r);
          }
          // Bank-wide delivery settings (e.g. SMS when WhatsApp is not delivered).
          if (url === '/api/bank-settings') {
            const B = await load('bankSettings.ts');
            try {
              if (req.method === 'GET') return send(res, 200, { settings: (B.getBankSettings as (t: string) => unknown)(new URL(req.url ?? '', 'http://x').searchParams.get('tenantId') ?? '') });
              const body = (await readBody(req)) as { tenantId?: string; settings?: unknown };
              return send(res, 200, { ok: true, settings: (B.saveBankSettings as (t: string, p: unknown) => unknown)(String(body.tenantId ?? ''), body.settings ?? {}) });
            } catch (e) {
              return send(res, 400, { ok: false, error: (e as Error).message });
            }
          }
          // The Campaigns page, and each campaign's saved chat.
          if (url === '/api/campaigns' && req.method === 'GET') {
            const files = await load('campaignFiles.ts');
            const tenantId = new URL(req.url ?? '', 'http://x').searchParams.get('tenantId') ?? '';
            return send(res, 200, { campaigns: (files.listCampaigns as (t: string) => unknown[])(tenantId) });
          }
          if (url === '/api/campaign/chat') {
            const files = await load('campaignFiles.ts');
            try {
              if (req.method === 'GET') {
                const sessionId = new URL(req.url ?? '', 'http://x').searchParams.get('sessionId') ?? '';
                return send(res, 200, { chat: (files.loadChat as (s: string) => unknown)(sessionId) });
              }
              const body = (await readBody(req)) as { sessionId?: string; tenantId?: string; chat?: unknown };
              (files.saveChat as (s: string, t: string, c: unknown) => void)(String(body.sessionId ?? ''), String(body.tenantId ?? ''), body.chat ?? {});
              return send(res, 200, { ok: true });
            } catch (e) {
              return send(res, 400, { ok: false, error: (e as Error).message });
            }
          }
          // Hard problems in a saved campaign (unusable links, broken splits, …), for repair turns.
          if (url === '/api/campaign/problems' && req.method === 'GET') {
            const files = await load('campaignFiles.ts');
            const compile = await load('agent/compile.ts');
            const L = await load('links.ts');
            const q = new URL(req.url ?? '', 'http://x').searchParams;
            try {
              const stores = (files.loadStores as (id: string) => { campaign: unknown })(q.get('sessionId') ?? '');
              const B = await load('bankSettings.ts');
          const tid = q.get('tenantId') ?? '';
          const problems = stores.campaign ? (compile.checkJourneys as (c: unknown, l: unknown, f: boolean, b: boolean) => string[])(stores.campaign, (L.listLinks as (t: string) => unknown)(tid), (B.getBankSettings as (t: string) => { smsFallback: boolean })(tid).smsFallback, true) : [];
              return send(res, 200, { problems });
            } catch (e) {
              return send(res, 400, { error: (e as Error).message });
            }
          }
          // The bank's incentive menu (ops manage it on the Offers page): offers by id, with the exact line the system puts into a message.
          if (url === '/api/incentives' && req.method === 'GET') {
            const I = await load('incentives.ts');
            const T = await load('tenants.ts');
            const tenantId = new URL(req.url ?? '', 'http://x').searchParams.get('tenantId') ?? '';
            return send(res, 200, { incentives: (I.incentivesFor as (t: unknown) => unknown[])((T.resolveTenant as (id: string) => unknown)(tenantId)) });
          }
          // Ops manage the offer menu: add or change an offer, or pause / resume one. Every save is checked.
          if ((url === '/api/incentives' || url === '/api/incentives/status') && req.method === 'POST') {
            const I = await load('incentives.ts');
            const T = await load('tenants.ts');
            const body = (await readBody(req)) as { tenantId?: string; incentive?: unknown; id?: string; status?: string };
            const tenant = (T.resolveTenant as (id: string) => unknown)(String(body.tenantId ?? ''));
            if (!tenant) return send(res, 400, { ok: false, error: 'Unknown bank.' });
            try {
              const out =
                url === '/api/incentives'
                  ? (I.saveIncentive as (t: unknown, i: unknown) => { ok: boolean })(tenant, body.incentive ?? {})
                  : (I.setIncentiveStatus as (t: unknown, id: string, s: string) => { ok: boolean })(tenant, String(body.id ?? ''), String(body.status ?? ''));
              return send(res, out.ok ? 200 : 400, out);
            } catch (e) {
              return send(res, 400, { ok: false, error: (e as Error).message });
            }
          }
          // An offer described in plain words → its fields, asking for whatever is missing. Nothing is saved.
          if (url === '/api/incentives/draft' && req.method === 'POST') {
            const D = await load('incentiveDraft.ts');
            const T = await load('tenants.ts');
            const body = (await readBody(req)) as { tenantId?: string; turns?: unknown[]; current?: unknown };
            const tenant = (T.resolveTenant as (id: string) => { incentives?: boolean } | null)(String(body.tenantId ?? ''));
            if (!tenant?.incentives) return send(res, 400, { error: 'This bank has no offer menu.' });
            const turns = (Array.isArray(body.turns) ? body.turns : [])
              .filter((t): t is { role: string; text: string } => !!t && typeof (t as { text?: unknown }).text === 'string')
              .slice(-20)
              .map((t) => ({ role: t.role === 'designer' ? 'designer' : 'ops', text: t.text.slice(0, 4000) }));
            if (!turns.some((t) => t.role === 'ops' && t.text.trim())) return send(res, 400, { error: 'Describe the offer first.' });
            try {
              return send(res, 200, await (D.draftIncentive as (t: unknown, turns: unknown, c: unknown) => Promise<unknown>)(tenant, turns, body.current ?? null));
            } catch (e) {
              return send(res, 502, { error: (e as Error).message });
            }
          }
          // The bank's products (Smart Engage 2.0): list, add or change, pause / resume.
          if (url === '/api/products' && req.method === 'GET') {
            const P = await load('products.ts');
            const T = await load('tenants.ts');
            const tenantId = new URL(req.url ?? '', 'http://x').searchParams.get('tenantId') ?? '';
            return send(res, 200, { products: (P.productsFor as (t: unknown) => unknown[])((T.resolveTenant as (id: string) => unknown)(tenantId)) });
          }
          if ((url === '/api/products' || url === '/api/products/status') && req.method === 'POST') {
            const P = await load('products.ts');
            const T = await load('tenants.ts');
            const body = (await readBody(req)) as { tenantId?: string; product?: unknown; id?: string; status?: string };
            const tenant = (T.resolveTenant as (id: string) => unknown)(String(body.tenantId ?? ''));
            if (!tenant) return send(res, 400, { ok: false, error: 'Unknown bank.' });
            try {
              const out =
                url === '/api/products'
                  ? (P.saveProduct as (t: unknown, p: unknown) => { ok: boolean })(tenant, body.product ?? {})
                  : (P.setProductStatus as (t: unknown, id: string, s: string) => { ok: boolean })(tenant, String(body.id ?? ''), String(body.status ?? ''));
              return send(res, out.ok ? 200 : 400, out);
            } catch (e) {
              return send(res, 400, { ok: false, error: (e as Error).message });
            }
          }
          // Comm approvals: every message is approved by the bank before a campaign can run.
          if (url === '/api/approvals' && req.method === 'GET') {
            const A = await load('approvals.ts');
            const T = await load('tenants.ts');
            const files = await load('campaignFiles.ts');
            const q = new URL(req.url ?? '', 'http://x').searchParams;
            const tenantId = q.get('tenantId') ?? '';
            const tenant = (T.resolveTenant as (id: string) => unknown)(tenantId);
            const sync = A.syncApprovals as (id: string, c: unknown, t: unknown) => { status: string }[];
            const summarise = A.summarise as (r: unknown[]) => unknown;
            try {
              const one = q.get('sessionId');
              if (one) {
                const c = (files.loadStores as (id: string) => { campaign: unknown }).call(null, one).campaign;
                const records = c ? sync(one, c, tenant) : [];
                return send(res, 200, { records, summary: summarise(records) });
              }
              // The inbox: every campaign of this bank that has messages, with its queue.
              // Submitted campaigns are locked (and those from before approvals were never queued): only campaigns that can still change.
              const list = (files.listCampaigns as (t: string) => { sessionId: string; name: string; state: string; intent?: string; kind?: string; scope?: unknown; submitted?: unknown }[])(tenantId);
              const campaigns = list
                .filter((cs) => !cs.submitted)
                .map((cs) => {
                  const c = (files.loadStores as (id: string) => { campaign: unknown })(cs.sessionId).campaign;
                  const records = c ? sync(cs.sessionId, c, tenant) : [];
                  return { sessionId: cs.sessionId, name: cs.name, state: cs.state, intent: cs.intent, kind: cs.kind, scope: cs.scope ?? null, records, summary: summarise(records) };
                })
                .filter((x) => x.records.length);
              return send(res, 200, { campaigns });
            } catch (e) {
              return send(res, 400, { error: (e as Error).message });
            }
          }
          if (url === '/api/approvals/decide' && req.method === 'POST') {
            const A = await load('approvals.ts');
            const T = await load('tenants.ts');
            const D = await load('agent/directEdit.ts');
            const files = await load('campaignFiles.ts');
            const body = (await readBody(req)) as { sessionId?: string; tenantId?: string; fp?: string; action?: string; reason?: string; copy?: string; cta?: string; by?: string };
            const sessionId = String(body.sessionId ?? '');
            const tenantId = String(body.tenantId ?? '');
            const tenant = (T.resolveTenant as (id: string) => unknown)(tenantId);
            const by = String(body.by ?? 'approver').slice(0, 60);
            try {
              if (body.action === 'approve' || body.action === 'reject') {
                const out = (A.decide as (s: string, fp: string, a: string, by: string, r?: string) => { ok: boolean })(sessionId, String(body.fp ?? ''), body.action, by, body.reason);
                return send(res, out.ok ? 200 : 400, out);
              }
              if (body.action === 'edit') {
                // Edit & approve: the new wording goes into the campaign (every place this message is used), then it is approved.
                const c = (files.loadStores as (id: string) => { campaign: unknown })(sessionId).campaign;
                const records = (A.syncApprovals as (s: string, c: unknown, t: unknown) => { fp: string; uses: { bucketId: string; stepId: string }[] }[])(sessionId, c, tenant);
                const rec = records.find((r) => r.fp === body.fp);
                if (!rec) return send(res, 400, { ok: false, error: 'That message is no longer in the campaign.' });
                for (const u of rec.uses) {
                  const r = (D.directEdit as (s: string, t: string, op: unknown) => { ok: boolean; error?: string })(sessionId, tenantId, { op: 'copy', bucketId: u.bucketId, stepId: u.stepId, copy: body.copy ?? '', cta: body.cta });
                  if (!r.ok) return send(res, 400, r);
                }
                const after = (files.loadStores as (id: string) => { campaign: unknown })(sessionId).campaign;
                const now = (A.syncApprovals as (s: string, c: unknown, t: unknown) => { fp: string; uses: { stepId: string }[] }[])(sessionId, after, tenant);
                const edited = now.find((r) => r.uses.some((u) => u.stepId === rec.uses[0].stepId));
                if (!edited) return send(res, 400, { ok: false, error: 'The edited message could not be found.' });
                return send(res, 200, (A.decide as (s: string, fp: string, a: string, by: string) => { ok: boolean })(sessionId, edited.fp, 'approve', by));
              }
              return send(res, 400, { ok: false, error: 'Unknown action.' });
            } catch (e) {
              return send(res, 400, { ok: false, error: (e as Error).message });
            }
          }
          // The signals an offer's rules may use (no SQL), for the Offers page.
          if (url === '/api/signals' && req.method === 'GET') {
            const S = await load('signals.ts');
            const T = await load('tenants.ts');
            const tenantId = new URL(req.url ?? '', 'http://x').searchParams.get('tenantId') ?? '';
            const all = (S.signalsForAgent as (s: unknown) => { usableIn: string[] }[])((S.signalsFor as (t: unknown) => unknown)((T.resolveTenant as (id: string) => unknown)(tenantId)));
            return send(res, 200, { signals: all.filter((x) => x.usableIn.includes('eligibility')) });
          }
          // Personal fields usable in messages, with a typical and the longest value (for previews).
          if (url === '/api/fields' && req.method === 'GET') {
            const S = await load('signals.ts');
            const T = await load('tenants.ts');
            const F = await load('../src/designer/v2/personalFields.ts');
            const tenantId = new URL(req.url ?? '', 'http://x').searchParams.get('tenantId') ?? '';
            return send(res, 200, { fields: (S.fieldSamples as (t: unknown, f: unknown) => unknown[])((T.resolveTenant as (id: string) => unknown)(tenantId), F.formatValue) });
          }
          // The bank's link registry (the agent only sees references; URLs live here).
          if (url === '/api/links' && req.method === 'GET') {
            const L = await load('links.ts');
            const tenantId = new URL(req.url ?? '', 'http://x').searchParams.get('tenantId') ?? '';
            try {
              return send(res, 200, { links: (L.listLinks as (t: string) => unknown[])(tenantId) });
            } catch (e) {
              return send(res, 400, { error: (e as Error).message });
            }
          }
          if ((url === '/api/links' || url === '/api/links/retire') && req.method === 'POST') {
            const L = await load('links.ts');
            const body = (await readBody(req)) as { tenantId?: string; link?: unknown; ref?: string };
            try {
              const out =
                url === '/api/links'
                  ? (L.saveLink as (t: string, l: unknown) => { ok: boolean })(String(body.tenantId ?? ''), body.link ?? {})
                  : (L.retireLink as (t: string, r: string) => { ok: boolean })(String(body.tenantId ?? ''), String(body.ref ?? ''));
              return send(res, out.ok ? 200 : 400, out);
            } catch (e) {
              return send(res, 400, { ok: false, error: (e as Error).message });
            }
          }
          // Versions of the campaign object, direct edits from the canvas, and restore.
          if (url === '/api/campaign/versions' && req.method === 'GET') {
            const v = await load('campaignVersions.ts');
            const sessionId = new URL(req.url ?? '', 'http://x').searchParams.get('sessionId') ?? '';
            try {
              return send(res, 200, { versions: (v.listVersions as (id: string) => unknown[])(sessionId) });
            } catch {
              return send(res, 400, { error: 'Not a valid session id.' });
            }
          }
          if (url === '/api/campaign/version' && req.method === 'GET') {
            const v = await load('campaignVersions.ts');
            const q = new URL(req.url ?? '', 'http://x').searchParams;
            try {
              const one = (v.getVersion as (id: string, n: number) => unknown)(q.get('sessionId') ?? '', Number(q.get('n')));
              return one ? send(res, 200, { version: one }) : send(res, 404, { error: 'No such version.' });
            } catch {
              return send(res, 400, { error: 'Not a valid session id.' });
            }
          }
          if ((url === '/api/campaign/edit' || url === '/api/campaign/restore') && req.method === 'POST') {
            const d = await load('agent/directEdit.ts');
            const body = (await readBody(req)) as { sessionId?: string; tenantId?: string; op?: unknown; n?: number };
            try {
              const out =
                url === '/api/campaign/edit'
                  ? (d.directEdit as (s: string, t: string, op: unknown) => { ok: boolean })(String(body.sessionId ?? ''), String(body.tenantId ?? ''), body.op)
                  : (d.restoreVersion as (s: string, t: string, n: number) => { ok: boolean })(String(body.sessionId ?? ''), String(body.tenantId ?? ''), Number(body.n));
              return send(res, out.ok ? 200 : 400, out);
            } catch (e) {
              return send(res, 400, { ok: false, error: (e as Error).message });
            }
          }
          const table = await routes(load);
          const handler = table[url];
          if (!handler) return send(res, 404, { error: `No such endpoint: ${url}` });
          const body = req.method === 'POST' ? await readBody(req) : {};
          const { status, json } = await handler(body);
          send(res, status, json);
        } catch (e) {
          // Message only. Never a stack containing environment contents.
          send(res, 500, { error: (e as Error).message });
        }
      });
    },
    // `vite preview` serves the built static bundle and has no module
    // runner, so the server modules cannot be loaded there. Rather than
    // appear to work and fail per-request, the API says exactly what to do.
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (!url.startsWith('/api/')) return next();
        send(res, 501, {
          error:
            'The agent API is only available under `npm run dev`. `vite preview` serves the static bundle without a module runner.',
        });
      });
    },
  };
}
