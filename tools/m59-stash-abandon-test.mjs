#!/usr/bin/env node
// ABANDONED STASH CARGO RELEASES THE REFILL QUEUE -- offline, no socket, no roster.
//
//   node tools/m59-stash-abandon-test.mjs
//
// Prod 2026-10-27: Kermit's ride dropped a spare chain armor at the East Tower (2013) to pass the guard and never came
// back; his finished ride held refill.lock for ever and Waldorf's ride failed refill_waits_for_unrecovered_stash_t1.
// What this pins (acquireStashLease, m59-island-chalice.mjs):
//   * a dead owner's FRESH drop still holds the queue (it may yet be recovered);
//   * once the newest drop is STASH_ABANDON_MS old the cargo is written off in its receipt and the next rider proceeds;
//   * a LIVE owner is waited for however old its drop is.
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
};
const I = await import('./m59-island-chalice.mjs');
const DEAD_PID = 2 ** 22 + 12345;     // above any pid_max default: not a live process

function setup({ droppedAgo, pid = DEAD_PID }) {
  const dir = mkdtempSync(join(tmpdir(), 'm59-stash-'));
  const t = 10_000_000_000;
  const kermit = join(dir, 't1-pending.json');
  writeFileSync(kermit, JSON.stringify({ agent: 't1', stash: { room: 2013, items: [
    { name: 'chain armor', dropped: true, recovered: false, dropped_at: t - droppedAgo }] } }));
  writeFileSync(join(dir, 'refill.lock'), JSON.stringify({ token: 'old', pid, started_at: null, agent: 't1', receipt: kermit }));
  const waldorf = { receipt: join(dir, 't2-pending.json') };
  return { dir, kermit, waldorf, now: () => t };
}
const ctx = { agent: 't2' };
const opts = (now) => ({ budgetMs: 5000, now, wait: async () => {} });

{
  const { kermit, waldorf, now } = setup({ droppedAgo: 60_000 });
  const e = await I.acquireStashLease(ctx, waldorf, opts(now)).then(() => null, e => e.message);
  ok('a dead owner\'s drop a minute old still holds the queue', e === 'refill_waits_for_unrecovered_stash_t1', e);
  ok('and the receipt is untouched', !JSON.parse(readFileSync(kermit, 'utf8')).stash.abandoned_at);
}
{
  const { dir, kermit, waldorf, now } = setup({ droppedAgo: I.STASH_ABANDON_MS + 1000 });
  const token = await I.acquireStashLease(ctx, waldorf, opts(now)).catch(e => 'ERR ' + e.message);
  const r = JSON.parse(readFileSync(kermit, 'utf8'));
  ok(`older than ${I.STASH_ABANDON_MS / 60000} min: the next rider takes the lease`, typeof token === 'string' && !token.startsWith('ERR'), String(token));
  ok('the cargo is written off in its own receipt, by whom', r.stash.abandoned_at > 0 && r.stash.abandoned_by === 't2' && r.stash.items[0].abandoned === true);
  ok('the lock now names the new rider', JSON.parse(readFileSync(join(dir, 'refill.lock'), 'utf8')).agent === 't2');
  I.releaseStashLease(waldorf, token);
}
{
  const { waldorf, now } = setup({ droppedAgo: I.STASH_ABANDON_MS * 3, pid: process.ppid });
  // A live owner in ANOTHER process (the parent stands in): still mid-errand, waited for until the budget runs out.
  const e = await I.acquireStashLease(ctx, waldorf, { budgetMs: 5000, now: (() => { let t = now(); return () => (t += 1000); })(), wait: async () => {} })
    .then(() => null, e => e.message);
  ok('a LIVE owner is waited for however old its drop (the queue budget ends it, not the write-off)',
     e === 'refill_queue_budget' || e === 'refill_waits_for_unrecovered_stash_t1', e);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
