// A tenant's data warehouse, read-only. Only tenants with `warehouse` set in
// tenants.ts have one; the agent gets SQL tools only for those tenants.
//
// The prototype warehouse is a local SQLite file per bank, built from CSV
// exports by scripts/build-warehouse.mjs and found in WAREHOUSE_DIR
// (default <repo>/data/warehouse).
import { DatabaseSync } from 'node:sqlite';
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MAX_ROWS = 200;

/**
 * Every query that can be slow runs in a worker thread, with a hard time limit.
 * node:sqlite is synchronous and cannot interrupt a query, so one slow query used
 * to freeze the whole server (every chat, the MCP) until it finished, and a
 * frozen process even ignored a normal stop. Now the main thread waits at most
 * QUERY_TIMEOUT_MS; on timeout it abandons the worker (a fresh one takes the next
 * query) and the caller gets a plain error it can act on.
 */
export const queryTimeoutMs = () => (Number(process.env.WAREHOUSE_QUERY_TIMEOUT_MS) > 0 ? Number(process.env.WAREHOUSE_QUERY_TIMEOUT_MS) : 30_000);

export class QueryTimeoutError extends Error {}

let worker: { w: Worker; flag: Int32Array; port: MessagePort } | null = null;

function startWorker() {
  const signal = new SharedArrayBuffer(4);
  const { port1, port2 } = new MessageChannel();
  const w = new Worker(new URL('./warehouseWorker.mjs', import.meta.url), { workerData: { signal, reply: port2 }, transferList: [port2] });
  w.unref();
  port1.unref();
  worker = { w, flag: new Int32Array(signal), port: port1 };
  return worker;
}

/**
 * Runs one statement in its own process, killed outright at the limit. For SQL the agent (or the
 * analyst) wrote: such a query can run for ever, and an abandoned worker thread would keep burning
 * CPU (it did: a stuck query held the server at 99% CPU). ~36 ms start-up per query.
 */
function runInProcess<T>(path: string, sql: string, mode: 'all' | 'get', timeoutMs = queryTimeoutMs()): T {
  const r = spawnSync(process.execPath, ['--no-warnings', fileURLToPath(new URL('./warehouseQuery.mjs', import.meta.url)), JSON.stringify({ path, sql, mode })], {
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 32 * 1024 * 1024,
  });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || r.signal === 'SIGKILL') {
    throw new QueryTimeoutError(
      `The query took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped. Narrow it: filter early, aggregate in SQL, and avoid joining transactions to themselves across every customer.`,
    );
  }
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || 'The query failed.').trim().split('\n').pop());
  return JSON.parse(r.stdout) as T;
}

/** Runs one statement in the worker and waits for it, at most `timeoutMs`. For code-built queries. */
function runOffThread<T>(path: string, sql: string, mode: 'all' | 'get', timeoutMs = queryTimeoutMs()): T {
  const wk = worker ?? startWorker();
  Atomics.store(wk.flag, 0, 0);
  wk.w.postMessage({ path, sql, mode });
  const woke = Atomics.wait(wk.flag, 0, 0, timeoutMs);
  if (woke === 'timed-out') {
    // Abandon it: it may keep running in its own thread, but the server is free.
    void wk.w.terminate();
    worker = null;
    throw new QueryTimeoutError(
      `The query took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped. Narrow it: filter early, aggregate in SQL, and avoid joining transactions to themselves across every customer.`,
    );
  }
  const msg = receiveMessageOnPort(wk.port)?.message as { ok: boolean; value?: unknown; error?: string } | undefined;
  if (!msg) throw new Error('The query returned no result.');
  if (!msg.ok) throw new Error(msg.error);
  return msg.value as T;
}
const dbs = new Map<string, DatabaseSync>();

export function warehouseDir(): string {
  return process.env.WAREHOUSE_DIR || resolve(here, '../data/warehouse');
}

export function warehousePath(bank: string): string {
  return join(warehouseDir(), `${bank}.db`);
}

export function warehouseAvailable(bank: string | undefined): boolean {
  return !!bank && existsSync(warehousePath(bank));
}

function open(bank: string): DatabaseSync {
  let db = dbs.get(bank);
  if (!db) {
    const path = warehousePath(bank);
    if (!existsSync(path)) throw new Error(`The ${bank} warehouse is not available on this server.`);
    db = new DatabaseSync(path, { readOnly: true });
    dbs.set(bank, db);
  }
  return db;
}

export interface TableInfo {
  table: string;
  rows: number;
  columns: { name: string; type: string; examples?: string[] }[];
}

const schemaCache = new Map<string, { tables: TableInfo[]; dataAsOf: string | null }>();

/** Tables, columns, row counts, and example values for low-cardinality text columns. */
export function warehouseSchema(bank: string): { tables: TableInfo[]; dataAsOf: string | null } {
  const hit = schemaCache.get(bank);
  if (hit) return hit;
  const db = open(bank);
  // SQLite's own bookkeeping tables (sqlite_stat1, …) mean nothing to anyone: left out.
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  const tables: TableInfo[] = names.map((t) => {
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string; type: string }[];
    const rows = Number((db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n);
    return {
      table: t,
      rows,
      columns: cols.map((c) => {
        if (c.type !== 'TEXT' || /_id$|phone|email|name$|date/.test(c.name)) return { name: c.name, type: c.type };
        const distinct = db.prepare(`SELECT "${c.name}" AS v, COUNT(*) AS n FROM "${t}" GROUP BY 1 ORDER BY 2 DESC LIMIT 13`).all() as { v: string }[];
        return distinct.length <= 12 ? { name: c.name, type: c.type, examples: distinct.map((d) => String(d.v)) } : { name: c.name, type: c.type };
      }),
    };
  });
  let dataAsOf: string | null = null;
  if (names.includes('transactions')) {
    dataAsOf = String((db.prepare('SELECT MAX(transaction_date) AS d FROM transactions').get() as { d: string }).d ?? '') || null;
  }
  const out = { tables, dataAsOf };
  schemaCache.set(bank, out);
  return out;
}

/** Only one read statement: SELECT or WITH … SELECT. */
export function checkReadOnly(sql: string): string | null {
  const s = sql.trim().replace(/;+\s*$/, '');
  if (!/^(select|with)\b/i.test(s)) return 'Only SELECT (or WITH … SELECT) queries are allowed.';
  if (s.includes(';')) return 'One statement at a time.';
  if (/\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|replace)\b/i.test(s.replace(/'[^']*'/g, ''))) {
    return 'Only read queries are allowed.';
  }
  return null;
}

export function runWarehouseQuery(bank: string, sql: string): { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean; ms: number } {
  const bad = checkReadOnly(sql);
  if (bad) throw new Error(bad);
  open(bank);
  const t0 = Date.now();
  const rows = runInProcess<Record<string, unknown>[]>(warehousePath(bank), `SELECT * FROM (${sql.trim().replace(/;+\s*$/, '')}) LIMIT ${MAX_ROWS + 1}`, 'all');
  const truncated = rows.length > MAX_ROWS;
  const kept = rows.slice(0, MAX_ROWS);
  return { columns: kept.length ? Object.keys(kept[0]) : [], rows: kept, truncated, ms: Date.now() - t0 };
}

/** How many distinct customers a bucket's SQL selects. */
export function countCustomers(bank: string, sql: string): number {
  const bad = checkReadOnly(sql);
  if (bad) throw new Error(bad);
  open(bank);
  const inner = sql.trim().replace(/;+\s*$/, '');
  const row = runInProcess<{ n: number }>(warehousePath(bank), `SELECT COUNT(DISTINCT customer_id) AS n FROM (${inner})`, 'get');
  return Number(row.n);
}

const idCache = new Map<string, Set<string>>();

/**
 * Every customer_id a query selects (no row cap), cached by query. For route
 * arithmetic in code: a signal's customers are loaded once, then routes are
 * set intersections, not ever-longer nested SQL.
 */
export function customerIds(bank: string, sql: string): Set<string> {
  const bad = checkReadOnly(sql);
  if (bad) throw new Error(bad);
  const key = `${bank}\n${sql}`;
  const hit = idCache.get(key);
  if (hit) return hit;
  open(bank);
  const rows = runOffThread<{ id: unknown }[]>(warehousePath(bank), `SELECT DISTINCT customer_id AS id FROM (${sql.trim().replace(/;+\s*$/, '')})`, 'all');
  const set = new Set(rows.map((r) => String(r.id)));
  if (idCache.size > 300) idCache.delete(idCache.keys().next().value!);
  idCache.set(key, set);
  return set;
}

/** What each table holds, in plain words, for the main agent (which never sees columns or SQL). */
const TABLE_WORDS: Record<string, string> = {
  customers: 'customer profiles: age, city, card variant, credit limit and balance, account opening date, last app login, preferred language, whether active',
  transactions: 'every card transaction: date, amount, merchant, spend category, and whether it was converted to EMI',
  emi_eligibility: "EMI eligibility per customer (the bank's credit policy): eligible or not, the largest EMI amount, preferred tenure, existing EMIs",
  npa_list: 'customers in NPA / overdue (never messaged)',
  dnc_list: 'customers on a do-not-contact list (never messaged)',
  fraud_list: 'customers flagged for fraud cases',
  complaint_list: 'customer complaints and their status',
  cooling_off_list: 'customers in a cooling-off period (closure or downgrade requests)',
};

/** The bank's data in plain words: what exists, how much, and the date it runs to. No columns, no SQL. */
export function dataOverview(bank: string): string {
  const { tables, dataAsOf } = warehouseSchema(bank);
  const lines = tables.map((t) => `- ${TABLE_WORDS[t.table] ?? t.table.replace(/_/g, ' ')} (${t.rows.toLocaleString('en-IN')} rows)`);
  return `The bank's data runs to ${dataAsOf ?? 'an unknown date'} (treat that as "today" for recency). It holds:\n${lines.join('\n')}\nAsk about any of it with ask_data.`;
}
