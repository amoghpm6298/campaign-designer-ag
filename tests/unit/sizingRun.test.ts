// Running a bucket's saved sizing query again from the canvas.
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { saveChat, saveContext } from '../../server/campaignFiles';
import { runBucketSizing } from '../../server/sizingRun';
import { bucketContext } from '../../src/designer/v2/contextView';

const SQL = 'SELECT customer_id FROM transactions GROUP BY customer_id HAVING MAX(transaction_date) < \'2026-04-01\'';

beforeAll(() => {
  process.env.CAMPAIGN_DIR = mkdtempSync(join(tmpdir(), 'cd-sizing-'));
  const wh = mkdtempSync(join(tmpdir(), 'cd-wh-'));
  process.env.WAREHOUSE_DIR = wh;
  const db = new DatabaseSync(join(wh, 'yesbank.db'));
  db.exec(`CREATE TABLE customers (customer_id TEXT, first_name TEXT, city TEXT, is_active INTEGER);
    CREATE TABLE transactions (customer_id TEXT, transaction_date TEXT);
    INSERT INTO customers VALUES ('c1','Asha','Pune',1),('c2','Ravi','Delhi',1),('c3','Meena','Goa',1);
    INSERT INTO transactions VALUES ('c1','2026-03-01'),('c2','2026-03-10'),('c3','2026-05-01');`);
  db.close();
  saveChat('cv-sz', 'TEN-YES', { tenantId: 'TEN-YES' });
  const at = new Date().toISOString();
  saveContext('cv-sz', 'TEN-YES', {
    entries: [
      { kind: 'sizing', bucketId: 'lapsed', topic: 'size', text: 'Lapsed', source: 'agent', at, data: { sql: SQL, size: 2 } },
      { kind: 'bucket', bucketId: 'lapsed', topic: 'thesis', text: 'Old campaigns call it thesis', source: 'agent', at },
    ],
  } as never);
});

describe('running a bucket query again', () => {
  it('runs the saved SQL now: count, the saved size, and who it picks', () => {
    const r = runBucketSizing('cv-sz', 'TEN-YES', 'lapsed');
    expect(r).toMatchObject({ ok: true, sql: SQL, size: 2, savedSize: 2 });
    if (!r.ok) throw new Error();
    expect(r.columns).toEqual(['customer_id', 'first_name', 'city']);
    expect(r.rows.map((x) => x.first_name).sort()).toEqual(['Asha', 'Ravi']);
  });
  it('refuses another bank, a bucket with no query, and a bank with no warehouse', () => {
    expect(runBucketSizing('cv-sz', 'TEN-IBL', 'lapsed')).toMatchObject({ ok: false, error: /another bank/ });
    expect(runBucketSizing('cv-sz', 'TEN-YES', 'nope')).toMatchObject({ ok: false, error: /no saved query/ });
  });
  it('reads the AI rationale, including from campaigns saved before the rename', () => {
    const at = new Date().toISOString();
    expect(bucketContext([{ kind: 'bucket', bucketId: 'b', topic: 'thesis', text: 'old', source: 'agent', at }]).b.rationale).toBe('old');
    expect(bucketContext([{ kind: 'bucket', bucketId: 'b', topic: 'rationale', text: 'new', source: 'agent', at }]).b.rationale).toBe('new');
  });
});
