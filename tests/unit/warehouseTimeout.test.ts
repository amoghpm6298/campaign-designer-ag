// A slow warehouse query must never freeze the server: it runs in a worker with a hard time limit.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { countCustomers, QueryTimeoutError, runWarehouseQuery, warehousePath } from '../../server/warehouse';

const hasYes = existsSync(warehousePath('yesbank'));
afterEach(() => {
  delete process.env.WAREHOUSE_QUERY_TIMEOUT_MS;
});

describe('warehouse query time limit', () => {
  it.runIf(hasYes)('stops a runaway query at the limit, with a plain error, and the next query still works', () => {
    process.env.WAREHOUSE_QUERY_TIMEOUT_MS = '300';
    const t0 = Date.now();
    const runaway = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10000000000) SELECT COUNT(*) AS n FROM c';
    expect(() => runWarehouseQuery('yesbank', runaway)).toThrow(QueryTimeoutError);
    expect(() => runWarehouseQuery('yesbank', runaway)).toThrow(/took longer than 0 seconds and was stopped/);
    expect(Date.now() - t0).toBeLessThan(6_000);
    // The runaway ran in its own process, killed at the limit: nothing is left running.
    delete process.env.WAREHOUSE_QUERY_TIMEOUT_MS;
    expect(runWarehouseQuery('yesbank', 'SELECT COUNT(*) AS n FROM customers').rows[0].n).toBe(50000);
    expect(countCustomers('yesbank', 'SELECT customer_id FROM customers WHERE is_active = 1')).toBeGreaterThan(40000);
  });
  it.runIf(hasYes)('SQL errors still come back as errors', () => {
    expect(() => runWarehouseQuery('yesbank', 'SELECT nope FROM customers')).toThrow(/no such column/);
  });
});
