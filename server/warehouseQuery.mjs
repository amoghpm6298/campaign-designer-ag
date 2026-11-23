// Runs ONE warehouse query in its own process (see runInProcess in warehouse.ts).
// A query written by the agent can run for ever, and node:sqlite cannot be
// interrupted; a process can be killed outright when it runs over its limit,
// so nothing is left burning CPU. Plain JavaScript: Node runs it directly.
import { DatabaseSync } from 'node:sqlite';

try {
  const { path, sql, mode } = JSON.parse(process.argv[2]);
  const db = new DatabaseSync(path, { readOnly: true });
  const stmt = db.prepare(sql);
  process.stdout.write(JSON.stringify(mode === 'get' ? stmt.get() : stmt.all()));
} catch (e) {
  process.stderr.write(e instanceof Error ? e.message : String(e));
  process.exit(2);
}
