// The server surface, as a Vite plugin.
//
// This repo is a static SPA with no backend, so there was nowhere to put a
// server-side call. A Vite middleware plugin is the smallest thing that gives
// one: it runs in Node during `npm run dev` and `npm run preview`, so the API
// key is read from process.env and never reaches the browser bundle.
//
// The client bundle imports NOTHING from this directory — the only transport
// is fetch('/api/...').
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

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
        break;
      }
      write('event', next.value);
    }
  } catch (e) {
    write('error', { error: (e as Error).message });
  } finally {
    if (!res.writableEnded) res.end();
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
  const orch = await loadModule('orchestrator.ts');
  const anth = await loadModule('anthropic.ts');
  const know = await loadModule('knowledge.ts');
  const ten = await loadModule('tenants.ts');

  const orchestrateStream = orch.orchestrateStream as (req: unknown) => AsyncGenerator<unknown, unknown>;
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
    // Non-streaming kept for tests and any caller that just wants the result.
    '/api/designer': async (body) => {
      const b = body as Record<string, unknown>;
      if (!b || typeof b !== 'object' || !Array.isArray(b.messages)) {
        return { status: 400, json: { error: 'messages[] is required' } };
      }
      const gen = orchestrateStream(toRequest(b, seedKnowledgeBase));
      let out = await gen.next();
      while (!out.done) out = await gen.next();
      return { status: 200, json: out.value };
    },
  };
}

/** Shared request shaping, so both routes interpret a body identically. */
function toRequest(b: Record<string, unknown>, seed: () => unknown) {
  return {
    sessionId: String(b.sessionId ?? `s-${Date.now()}`),
    messages: b.messages,
    knowledge: b.knowledge ?? seed(),
    discoveryRounds: Number(b.discoveryRounds ?? 0),
    currentCampaign: b.currentCampaign ?? null,
    tenantId: b.tenantId,
    resolvedSends: b.resolvedSends,
    forceProposal: Boolean(b.forceProposal),
    intent: b.intent ?? 'converse',
    confirmedBlueprint: b.confirmedBlueprint ?? null,
    confirmedStrategy: b.confirmedStrategy ?? null,
    // The accumulated brief and state machine, carried between turns.
    brief: b.brief ?? null,
    session: b.session ?? null,
  };
}

export function agentApiPlugin(): Plugin {
  return {
    name: 'drip-agent-api',
    configureServer(server: ViteDevServer) {
      const load = viteLoader(server);
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (!url.startsWith('/api/')) return next();
        try {
          // The streaming route owns its own response lifecycle.
          if (url === '/api/designer/stream' && req.method === 'POST') {
            const orch = await load('orchestrator.ts');
            const know = await load('knowledge.ts');
            const body = (await readBody(req)) as Record<string, unknown>;
            if (!Array.isArray(body?.messages)) return send(res, 400, { error: 'messages[] is required' });
            const gen = (orch.orchestrateStream as (r: unknown) => AsyncGenerator<unknown, unknown>)(
              toRequest(body, know.seedKnowledgeBase as () => unknown),
            );
            return void (await streamSse(res, gen));
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
