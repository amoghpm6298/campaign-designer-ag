// Adds card logos and cards to a bank's mock data warehouse (after build-warehouse.mjs).
//
//   node scripts/add-logos.mjs <bank> <warehouse.db>      e.g. yesbank data/warehouse/yesbank.db
//
// A bank has many card logos (card products: MARQUEE, ACE, KLICK…) and a customer can
// hold more than one card. The exports have one `card_type` per customer, so this:
//   - writes `logos` from server/logos.json (the bank's real lineup, researched; fees indicative);
//   - gives every customer a primary card on a logo that fits their credit limit (premium
//     logos to the highest limits, with some noise), and ~20% a second card on another
//     logo (more often a UPI or co-brand card);
//   - links every transaction to one of the customer's cards (never before that card was issued);
//   - marks cards activated if they were ever used, and some never-used cards activated too;
//   - drops customers.card_type, so nothing reads the old single-card field.
// Seeded by the bank's name, so the same input always gives the same data.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [bank, dbPath] = process.argv.slice(2);
if (!bank || !dbPath) {
  console.error('usage: node scripts/add-logos.mjs <bank> <warehouse.db>');
  process.exit(1);
}
const catalogue = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../server/logos.json'), 'utf8'))[bank];
if (!catalogue) throw new Error(`No logos for "${bank}" in server/logos.json`);

// --- a small seeded random ------------------------------------------------------
let seed = [...bank].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0), 2166136261);
const rand = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (items, weight) => {
  const total = items.reduce((s, x) => s + weight(x), 0);
  let r = rand() * total;
  for (const x of items) if ((r -= weight(x)) <= 0) return x;
  return items[items.length - 1];
};
const day = (d) => d.toISOString().slice(0, 10);
const addDays = (iso, n) => day(new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000));
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;');
const hasCardType = db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('customers') WHERE name = 'card_type'").get().n > 0;
if (!hasCardType) {
  console.log(`${dbPath}: logos already added (customers.card_type is gone). Rebuild the warehouse first to redo it.`);
  process.exit(0);
}
const asOf = db.prepare('SELECT MAX(transaction_date) AS d FROM transactions').get().d;

// --- logos ------------------------------------------------------------------------
db.exec('DROP TABLE IF EXISTS logos; DROP TABLE IF EXISTS cards;');
db.exec(`CREATE TABLE logos (logo_id TEXT PRIMARY KEY, name TEXT, tier TEXT, network TEXT, joining_fee INTEGER, annual_fee INTEGER,
  fee_waiver TEXT, rewards_rule TEXT, key_benefits TEXT, launch_date TEXT, status TEXT)`);
const insLogo = db.prepare('INSERT INTO logos VALUES (?,?,?,?,?,?,?,?,?,?,?)');
for (const l of catalogue) insLogo.run(l.logo_id, l.name, l.tier, l.network, l.joining_fee, l.annual_fee, l.fee_waiver, l.rewards_rule, l.key_benefits.join(' | '), l.launch_date, 'live');

// Logos in order of how premium they are: the highest credit limits get the most premium cards.
const RANK = { 'super-premium': 0, premium: 1, rewards: 2, 'entry rewards': 3, 'co-brand': 3, everyday: 4, UPI: 5 };
const ordered = [...catalogue].sort((a, b) => RANK[a.tier] - RANK[b.tier]);
const cum = [];
let acc = 0;
for (const l of ordered) cum.push([(acc += l.share), l]);
const byScore = (s) => (cum.find(([c]) => s <= c) ?? cum[cum.length - 1])[1];

// --- cards ------------------------------------------------------------------------
const customers = db.prepare('SELECT customer_id, credit_limit, account_open_date, is_active FROM customers ORDER BY credit_limit DESC').all();
const firstUse = new Map(db.prepare('SELECT customer_id, MIN(transaction_date) AS d FROM transactions GROUP BY customer_id').all().map((r) => [r.customer_id, r.d]));
db.exec(`CREATE TABLE cards (card_id TEXT PRIMARY KEY, customer_id TEXT, logo_id TEXT, is_primary INTEGER, issued_date TEXT,
  activated INTEGER, activated_date TEXT, credit_limit REAL, status TEXT)`);
const insCard = db.prepare('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?)');
const second = []; // [customer_id, card_id, issued_date, logo]
db.exec('BEGIN');
customers.forEach((c, i) => {
  // Rank by limit, plus noise, so tiers overlap a little as in a real book.
  const score = Math.min(0.999, Math.max(0, i / customers.length + (rand() - 0.5) * 0.25));
  const primary = byScore(score);
  const status = c.is_active ? 'active' : 'inactive';
  const used = firstUse.get(c.customer_id);
  // Used cards are activated just before their first use; of the never-used, about a third were activated anyway.
  const activatedDate = used ? addDays(used, -Math.floor(rand() * 10)) : rand() < 0.35 ? addDays(c.account_open_date, Math.floor(rand() * 20)) : null;
  insCard.run(`${c.customer_id}-1`, c.customer_id, primary.logo_id, 1, c.account_open_date, activatedDate ? 1 : 0, activatedDate, c.credit_limit, status);
  // About one in five holds a second card, issued later, on another logo: often UPI or co-brand.
  if (c.is_active && rand() < 0.2) {
    const others = catalogue.filter((l) => l.logo_id !== primary.logo_id);
    const logo = pick(others, (l) => (l.tier === 'UPI' || l.tier === 'co-brand' ? 3 : 1) * (RANK[l.tier] <= 1 && RANK[primary.tier] > 1 ? 0.3 : 1));
    const from = [c.account_open_date, logo.launch_date].sort().pop();
    // Up to the last day of the data, so a flow for new cardholders has people joining right up to "today".
    const span = Math.max(0, daysBetween(from, asOf));
    if (span > 0) {
      const issued = addDays(from, Math.floor(rand() * span));
      second.push({ customer_id: c.customer_id, card_id: `${c.customer_id}-2`, issued, logo, limit: Math.round(c.credit_limit * (0.3 + rand() * 0.3)), status });
    }
  }
});
db.exec('COMMIT');

// --- transactions → cards -----------------------------------------------------------
db.exec('ALTER TABLE transactions ADD COLUMN card_id TEXT');
db.exec("UPDATE transactions SET card_id = customer_id || '-1'");
const tx = db.prepare('SELECT rowid AS r, transaction_date AS d, category FROM transactions WHERE customer_id = ? AND transaction_date >= ?');
const move = db.prepare('UPDATE transactions SET card_id = ? WHERE rowid = ?');
db.exec('BEGIN');
let moved = 0;
for (const s of second) {
  // Spends after the second card arrived move to it: more of them for a UPI card on everyday categories.
  const upi = s.logo.tier === 'UPI';
  let first = null;
  for (const t of tx.all(s.customer_id, s.issued)) {
    const p = upi && ['grocery', 'dining', 'others', 'utilities'].includes(t.category) ? 0.7 : 0.35;
    if (rand() < p) {
      move.run(s.card_id, t.r);
      moved++;
      if (!first || t.d < first) first = t.d;
    }
  }
  const activatedDate = first ? addDays(first, -Math.floor(rand() * 5)) : rand() < 0.45 ? addDays(s.issued, Math.floor(rand() * 15)) : null;
  insCard.run(s.card_id, s.customer_id, s.logo.logo_id, 0, s.issued, activatedDate ? 1 : 0, activatedDate, s.limit, s.status);
}
db.exec('COMMIT');

db.exec('ALTER TABLE customers DROP COLUMN card_type');
db.exec('CREATE INDEX cards_cust ON cards(customer_id); CREATE INDEX cards_logo ON cards(logo_id); CREATE INDEX transactions_card ON transactions(card_id); ANALYZE;');

const summary = db.prepare('SELECT l.name, COUNT(*) AS cards, SUM(c.activated) AS activated FROM cards c JOIN logos l USING (logo_id) GROUP BY 1 ORDER BY 2 DESC').all();
console.log(`${dbPath}: ${customers.length} customers, ${customers.length + second.length} cards (${second.length} second cards), ${moved} transactions moved to second cards`);
for (const s of summary) console.log(`  ${s.name}: ${s.cards} cards, ${s.activated} activated`);
db.close();
