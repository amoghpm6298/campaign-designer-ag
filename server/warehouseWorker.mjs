// Runs warehouse queries off the server's main thread (see runOffThread in
// warehouse.ts). node:sqlite is synchronous and cannot interrupt a query, so a
// slow one used to freeze the whole server; here it only ties up this worker,
// which the main thread abandons when the query runs past its time limit.
// Plain JavaScript on purpose: Node loads it directly, outside Vite.
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

const dbs = new Map();
const open = (path) => {
  let db = dbs.get(path);
  if (!db) {
    db = new DatabaseSync(path, { readOnly: true });
    dbs.set(path, db);
  }
  return db;
};

// Replies go on a dedicated port the main thread reads synchronously (receiveMessageOnPort),
// then the shared flag wakes it from Atomics.wait.
const { signal, reply: replyPort } = workerData;
const flag = new Int32Array(signal);

parentPort.on('message', ({ path, sql, mode }) => {
  let reply;
  try {
    const stmt = open(path).prepare(sql);
    reply = { ok: true, value: mode === 'get' ? stmt.get() : stmt.all() };
  } catch (e) {
    reply = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  replyPort.postMessage(reply);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});
