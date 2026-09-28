// BORROW A CHARACTER FROM ITS TRAINING RUNNER, by the training-yield protocol (m59-keep-training.mjs
// honourYield): write <dir>/<agent>, wait for <agent>.yielded, delete the request to give it back.
//
//   import { borrow } from './m59-yield.mjs';
//   const loan = await borrow({ dir, agent: 't3', why: 'chest eviction' });   // throws on timeout
//   ...                                                                         // loan.refresh() inside 30 min
//   loan.release();
//
// A STALE ACKNOWLEDGEMENT IS NOT A YIELD. The runner deletes its `.yielded` only while it is running
// and sees the request gone, so an ack can outlive its request (a runner killed or restarted, a
// request deleted between its checks). On prod 2026-09-28 two chest-eviction runs waited for the ack
// to EXIST, found last time's, and drove Statler while his drill still owned him: every travel row
// read "busy: fleetscript disciple-drill" and the routes failed. So: any old ack is deleted before the
// request is written, and only an ack written after the request counts.
import { existsSync, writeFileSync, unlinkSync, statSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

export async function borrow({ dir, agent, why = 'borrowed', timeoutMs = 15 * 60_000, pollMs = 5_000,
                               sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now } = {}) {
  mkdirSync(dir, { recursive: true });
  const req = join(dir, agent), ack = join(dir, `${agent}.yielded`);
  try { unlinkSync(ack); } catch {}
  const asked = now();
  writeFileSync(req, `${why}\n`);
  const fresh = () => { try { return statSync(ack).mtimeMs >= asked - 1_000; } catch { return false; } };
  while (!fresh()) {
    if (now() - asked > timeoutMs) { try { unlinkSync(req); } catch {} throw new Error(`${agent}: no fresh yield in ${Math.round(timeoutMs / 60000)} min`); }
    await sleep(pollMs);
  }
  return {
    agent,
    refresh() { try { utimesSync(req, new Date(), new Date()); } catch {} },
    release() { try { unlinkSync(req); } catch {} },
  };
}
