// Run a bucket's saved sizing query again, now, so anyone looking at the
// canvas can check the number for themselves. Only the SQL the designer saved
// for that bucket is run (never SQL sent from the browser), read-only.
import { bucketContext } from '../src/designer/v2/contextView';
import { loadChat, loadStores } from './campaignFiles';
import { resolveTenant } from './tenants';
import { countCustomers, runWarehouseQuery, warehouseAvailable, warehouseSchema } from './warehouse';

const SAMPLE = 10;

export interface SizingRun {
  ok: true;
  sql: string;
  /** Customers the query selects now. */
  size: number;
  /** The size the designer recorded when it saved the query. */
  savedSize: number | null;
  /** A few of the customers it selects (customer details where the warehouse has them). */
  columns: string[];
  rows: Record<string, unknown>[];
  ms: number;
  dataAsOf: string | null;
}

export function runBucketSizing(sessionId: string, tenantId: string, bucketId: string): SizingRun | { ok: false; error: string } {
  try {
    const chat = loadChat(sessionId) as { tenantId?: string } | null;
    if (chat?.tenantId && chat.tenantId !== tenantId) return { ok: false, error: 'This campaign belongs to another bank.' };
    const bank = resolveTenant(tenantId)?.warehouse?.bank;
    if (!bank || !warehouseAvailable(bank)) return { ok: false, error: 'This bank has no data warehouse connected, so there is nothing to run.' };
    const view = bucketContext(loadStores(sessionId).context?.entries ?? [])[bucketId];
    if (!view?.sql) return { ok: false, error: 'This bucket has no saved query.' };
    const t0 = Date.now();
    const size = countCustomers(bank, view.sql);
    const inner = view.sql.trim().replace(/;+\s*$/, '');
    // Show who it picks: their customer record if there is a customers table, else the query's own rows.
    const schema = warehouseSchema(bank);
    const customers = schema.tables.find((t) => t.table === 'customers');
    const wanted = ['customer_id', 'first_name', 'city', 'card_type', 'credit_limit', 'account_open_date', 'last_login_date'];
    const cols = customers ? wanted.filter((c) => customers.columns.some((x) => x.name === c)) : [];
    const sample = cols.includes('customer_id')
      ? runWarehouseQuery(bank, `SELECT ${cols.map((c) => `c."${c}"`).join(', ')} FROM customers c WHERE c.customer_id IN (SELECT customer_id FROM (${inner})) LIMIT ${SAMPLE}`)
      : runWarehouseQuery(bank, `SELECT * FROM (${inner}) LIMIT ${SAMPLE}`);
    return { ok: true, sql: view.sql, size, savedSize: typeof view.size === 'number' ? view.size : null, columns: sample.columns, rows: sample.rows, ms: Date.now() - t0, dataAsOf: schema.dataAsOf };
  } catch (e) {
    return { ok: false, error: `The query failed: ${(e as Error).message}` };
  }
}
