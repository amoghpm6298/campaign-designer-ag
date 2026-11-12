// A tenant's data warehouse, read-only. Only tenants with `warehouse` set in
// tenants.ts have one; the agent gets SQL tools only for those tenants.
//
// The prototype warehouse is a local SQLite file per bank, built from CSV
// exports by scripts/build-warehouse.mjs and found in WAREHOUSE_DIR
// (default <repo>/data/warehouse).
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MAX_ROWS = 200;
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
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
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
  const db = open(bank);
  const t0 = Date.now();
  const stmt = db.prepare(`SELECT * FROM (${sql.trim().replace(/;+\s*$/, '')}) LIMIT ${MAX_ROWS + 1}`);
  const rows = stmt.all() as Record<string, unknown>[];
  const truncated = rows.length > MAX_ROWS;
  const kept = rows.slice(0, MAX_ROWS);
  return { columns: kept.length ? Object.keys(kept[0]) : [], rows: kept, truncated, ms: Date.now() - t0 };
}

/** How many distinct customers a bucket's SQL selects. */
export function countCustomers(bank: string, sql: string): number {
  const bad = checkReadOnly(sql);
  if (bad) throw new Error(bad);
  const db = open(bank);
  const inner = sql.trim().replace(/;+\s*$/, '');
  const row = db.prepare(`SELECT COUNT(DISTINCT customer_id) AS n FROM (${inner})`).get() as { n: number };
  return Number(row.n);
}
