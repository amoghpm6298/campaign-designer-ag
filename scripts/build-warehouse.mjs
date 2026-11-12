// Build a tenant's mock data warehouse (SQLite) from CSV exports.
//
//   node scripts/build-warehouse.mjs <csv-dir> <out.db>
//
// The CSVs are the propensity-agent bank exports (customers, transactions,
// emi_eligibility and the compliance lists). The .db is not committed: it is
// built locally and copied to the server once, and WAREHOUSE_DIR points at it.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

const [csvDir, out] = process.argv.slice(2);
if (!csvDir || !out) {
  console.error('usage: node scripts/build-warehouse.mjs <csv-dir> <out.db>');
  process.exit(1);
}
if (existsSync(out)) rmSync(out);
const db = new DatabaseSync(out);
db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;');

const tableName = (file) => basename(file, '.csv').replace(/^customers_.*/, 'customers');
const isInt = (v) => /^-?\d+$/.test(v);
const isNum = (v) => /^-?\d+(\.\d+)?$/.test(v);

for (const file of readdirSync(csvDir).filter((f) => f.endsWith('.csv'))) {
  const lines = readFileSync(join(csvDir, file), 'utf8').split(/\r?\n/).filter(Boolean);
  const cols = lines[0].split(',');
  const sample = lines.slice(1, 2000).map((l) => l.split(','));
  const types = cols.map((c, i) => {
    const vals = sample.map((r) => r[i]).filter((v) => v !== '' && v !== undefined);
    if (/_id$|phone|date/.test(c)) return 'TEXT';
    if (vals.length && vals.every(isInt)) return 'INTEGER';
    if (vals.length && vals.every(isNum)) return 'REAL';
    return 'TEXT';
  });
  const t = tableName(file);
  db.exec(`CREATE TABLE ${t} (${cols.map((c, i) => `"${c}" ${types[i]}`).join(', ')})`);
  const ins = db.prepare(`INSERT INTO ${t} VALUES (${cols.map(() => '?').join(',')})`);
  db.exec('BEGIN');
  for (const line of lines.slice(1)) {
    const r = line.split(',');
    ins.run(...cols.map((_, i) => (r[i] === '' || r[i] === undefined ? null : types[i] === 'TEXT' ? r[i] : Number(r[i]))));
  }
  db.exec('COMMIT');
  if (cols.includes('customer_id')) db.exec(`CREATE INDEX ${t}_cust ON ${t}(customer_id)`);
  console.log(`${t}: ${lines.length - 1} rows`);
}
db.exec('CREATE INDEX IF NOT EXISTS transactions_date ON transactions(transaction_date)');
db.exec('CREATE INDEX IF NOT EXISTS transactions_cat ON transactions(category)');
db.exec('ANALYZE');
db.close();
console.log(`built ${out}`);
