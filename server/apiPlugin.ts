// The server surface, as a Vite plugin.
//
// This repo is a static SPA with no backend, so there was nowhere to put a
// server-side call. A Vite middleware plugin is the smallest thing that gives
// one: it runs in Node during `npm run dev` and `npm run preview`, so the API
// key is read from process.env and never reaches the browser bundle.
//
// The client bundle imports NOTHING from this directory — the only transport
// is fetch('/api/...').
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

/** This file's own directory, so run records land next to the scripted ones. */
const here = dirname(fileURLToPath(import.meta.url));
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
      const gate = passwordGate(process.env.APP_PASSWORD, server.config.base);
      if (gate) server.middlewares.use(gate);
      // Hosted under a sub-path (`vite --base /x/`), requests arrive as
      // /x/api/...; this middleware runs before Vite strips the base.
      const base = server.config.base.replace(/\/$/, '');
      server.middlewares.use(async (req, res, next) => {
        let url = (req.url ?? '').split('?')[0];
        if (base && url.startsWith(base + '/')) url = url.slice(base.length);
        if (!url.startsWith('/api/')) return next();
        try {
          // v2: one agent, one prompt, every tool. See server/agent/.
          if (url === '/api/agent/stream' && req.method === 'POST') {
            const agent = await load('agent/loop.ts');
            const body = (await readBody(req)) as Record<string, unknown>;
            if (!Array.isArray(body?.messages)) return send(res, 400, { error: 'messages[] is required' });
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
            });
            return void (await streamSse(res, gen));
          }
          // The campaign object and context this chat has on file, so the canvas survives a reload.
          if (url === '/api/campaign' && req.method === 'GET') {
            const files = await load('campaignFiles.ts');
            const sessionId = new URL(req.url ?? '', 'http://x').searchParams.get('sessionId') ?? '';
            try {
              const stores = (files.loadStores as (id: string) => { campaign: unknown; context: unknown })(sessionId);
              return send(res, 200, { campaign: stores.campaign ?? null, context: stores.context ?? null });
            } catch {
              return send(res, 400, { error: 'Not a valid session id.' });
            }
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
          const problems = stores.campaign ? (compile.checkJourneys as (c: unknown, l: unknown, f: boolean) => string[])(stores.campaign, (L.listLinks as (t: string) => unknown)(tid), (B.getBankSettings as (t: string) => { smsFallback: boolean })(tid).smsFallback) : [];
              return send(res, 200, { problems });
            } catch (e) {
              return send(res, 400, { error: (e as Error).message });
            }
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
