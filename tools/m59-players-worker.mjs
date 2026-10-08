// THE /players PAGE, RENDERED OFF THE BROKER'S EVENT LOOP.
//
//   import { renderPlayersOffThread } from './m59-players-worker.mjs';
//   const html = await renderPlayersOffThread(query);      // in the broker's /players route
//
// renderPlayers (m59-players-page.mjs) reads the player-history files synchronously, and it reads a
// lot of them: on prod, 2026-10-08, 456 MB of history and one render blocking the broker's event loop
// for ~100 s, every two minutes while somebody had the page open in a browser. Every tool call, every
// keeper reply and every DUM pass timed out behind a web page. m59-intel.mjs now reads each file once
// and only its tail after that, which makes a render cheap; THIS makes it harmless however long it
// takes, because the work happens in a worker thread and the broker only awaits a message.
//
// ONE RENDER AT A TIME, SHARED: a second request while one is running waits for the same result, and
// a finished page is reused for CACHE_MS -- a dashboard tab refreshing does not queue renders. A render
// that runs past DEADLINE_MS terminates the worker (its caches go with it) and answers with an error;
// the next request starts a fresh one. The worker holds the incremental history caches between renders,
// which is the point of keeping it alive rather than spawning one per request.
//
// When this file is the worker (isMainThread false) it renders on request; otherwise it is the client.
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

export const CACHE_MS = 30_000;
export const DEADLINE_MS = 180_000;

if (!isMainThread && parentPort) {
  const { renderPlayers } = await import('./m59-players-page.mjs');
  parentPort.on('message', ({ id, query }) => {
    try { parentPort.postMessage({ id, html: renderPlayers(query ?? '') }); }
    catch (e) { parentPort.postMessage({ id, error: e?.message ?? String(e) }); }
  });
}

let worker = null, seq = 0;
const inflight = new Map();                          // query -> promise
const cache = new Map();                             // query -> { at, html }

// EACH WORKER OWNS ITS PENDING REQUESTS. A worker terminated for a slow render exits later, and that
// exit must neither clear the reference to its replacement nor reject the replacement's requests.
function ensureWorker() {
  if (worker) return worker;
  // The broker's own argv and env, so fleetName() resolves the same fleet in here (--fleet prod) and
  // the page reads the same conflicts file the broker writes.
  const w = new Worker(fileURLToPath(import.meta.url), { argv: process.argv.slice(2), env: process.env });
  w.pending = new Map();                             // id -> { resolve, reject }
  w.unref();
  const dead = (why) => {
    if (worker === w) worker = null;
    for (const [, r] of w.pending) r.reject(new Error(why));
    w.pending.clear();
  };
  w.on('error', e => dead(`players worker failed: ${e?.message ?? e}`));
  w.on('exit', code => dead(`players worker exited (${code})`));
  w.on('message', ({ id, html, error }) => {
    const r = w.pending.get(id);
    if (!r) return;
    w.pending.delete(id);
    if (error) r.reject(new Error(error)); else r.resolve(html);
  });
  worker = w;
  return w;
}

/** The /players HTML, rendered in the worker. Never blocks the caller's event loop. */
export function renderPlayersOffThread(query = '') {
  const key = String(query ?? '');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.html);
  if (inflight.has(key)) return inflight.get(key);
  const id = ++seq;
  const p = new Promise((resolve, reject) => {
    const w = ensureWorker();
    const timer = setTimeout(() => {
      w.pending.delete(id);
      // A render this slow is a render that is not coming back in time: drop the worker, so the next
      // request does not queue behind it.
      if (worker === w) worker = null;
      w.terminate().catch(() => {});
      reject(new Error(`/players render passed ${Math.round(DEADLINE_MS / 1000)} s; worker restarted`));
    }, DEADLINE_MS);
    timer.unref?.();
    w.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    w.postMessage({ id, query: key });
  }).then(html => { cache.set(key, { at: Date.now(), html }); return html; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
