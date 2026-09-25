#!/usr/bin/env node
// AM I STILL BLOCKING THE FLEET? The human desk, from the ledger alone.
//
//   node tools/m59-desk-report.mjs --fleet prod                 the last 24 hours
//   node tools/m59-desk-report.mjs --fleet prod --hours 6
//   node tools/m59-desk-report.mjs --fleet prod --json
//   node tools/m59-desk-report.mjs --dir <ledger dir>           read another checkout's ledger
//
// Operator, 2026-09-25: playing Loial used to take his services off the fleet, silently. The
// human desk (m59-research design/research-spec-human-service-bot.md) keeps them listed and sends
// requests to the person as tells — and this is how to find out whether that is working, or
// whether a person at the controls still costs the fleet rides.
//
// WHAT COUNTS AS BLOCKED. A request that reached a person and ended without service: the
// traveller gave up waiting (`ride_skipped` with `human`, after the wait) or a person's own
// request went unserved by a bot. A "not now" is NOT blocked — it is the person releasing
// the traveller at once, which is the fast path the operator asked for, and it is counted
// apart. And "nobody is on chalice duty" while a person was playing the holder is the OLD
// failure: the mark did not reach the traveller. It should be zero; if it is not, that is the
// first thing to look at.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fleetName, ledgerDirFor } from './m59-fleetpath.mjs';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const hours = Number(flag('hours', 24));
const dir = flag('dir') ?? ledgerDirFor(fleetName(argv));
const asJson = argv.includes('--json');
const now = Date.now();
const since = now - hours * 3_600_000;

function rows() {
  const out = [];
  for (let d = new Date(since); d.getTime() <= now + 86_400_000; d = new Date(d.getTime() + 86_400_000)) {
    const f = join(dir, `fleet-${d.toISOString().slice(0, 10)}.jsonl`);
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.includes('"kind":"chalice"')) continue;
      try { const r = JSON.parse(line); if (r.t >= since && r.kind === 'chalice') out.push(r); } catch {}
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

export function summarise(all, { at = now } = {}) {
  // SESSIONS: a person at a character's controls, from the broker's marks.
  const open = new Map(), sessions = [];
  for (const r of all) {
    if (r.what === 'desk_human_on') open.set(r.character, r.t);
    if (r.what === 'desk_human_off') {
      sessions.push({ character: r.character, from: open.get(r.character) ?? (r.t - (r.played_ms ?? 0)), to: r.t,
                      why: r.why ?? null });
      open.delete(r.character);
    }
  }
  for (const [character, from] of open) sessions.push({ character, from, to: null, why: 'still playing' });
  const during = (r) => sessions.some(s => r.t >= s.from && r.t <= (s.to ?? at));

  const count = (pred) => all.filter(pred).length;
  const waits = all.filter(r => r.what === 'received' && r.human).map(r => r.waited_ms).filter(Number.isFinite)
    .sort((a, b) => a - b);
  const pct = (p) => (waits.length ? waits[Math.min(waits.length - 1, Math.floor(p * waits.length))] : null);
  const timedOut = all.filter(r => r.what === 'ride_skipped' && r.human && !r.declined);
  const unserved = all.filter(r => r.what === 'desk_unserved');
  const oldFailure = all.filter(r => r.what === 'ride_declined' && /nobody is on chalice duty/.test(r.why ?? '') && during(r));

  return {
    hours: Math.round((at - (all[0]?.t ?? at)) / 36e5 * 10) / 10,
    sessions: sessions.map(s => ({ ...s, minutes: Math.round(((s.to ?? at) - s.from) / 60_000) })),
    bots_asking_a_person: {
      rides_requested: count(r => r.what === 'requested' && r.human),
      handed_over: count(r => r.what === 'received' && r.human),
      wait_ms: { median: pct(0.5), p90: pct(0.9), max: waits.at(-1) ?? null },
      held: count(r => r.what === 'desk_hold'),
      declined_fast: count(r => r.what === 'ride_skipped' && r.human && r.declined),
      timed_out: timedOut.length,
      services_asked: count(r => r.what === 'desk_tell' && r.service === 'services'),
      fol_tells: count(r => r.what === 'desk_tell' && r.service === 'fol'),
      tells_not_delivered: count(r => r.what === 'desk_tell' && r.sent === false),
      cargo_held: count(r => r.what === 'cargo_held'),
      items_left_on_floor: count(r => r.what === 'services_items_left'),
    },
    // THE RETURN-TRIP RESTOCK, whoever is serving: drawn or bought, delivered, or why not.
    restock: {
      drawn: count(r => r.what === 'cargo_taken'),
      bought: count(r => r.what === 'cargo_bought'),
      delivered: count(r => r.what === 'cargo_delivered'),
      draw_failed: count(r => r.what === 'cargo_draw_failed'),
      draw_empty: count(r => r.what === 'cargo_none'),
      buy_skipped: count(r => r.what === 'cargo_buy_skipped' || r.what === 'cargo_buy_failed'),
      donated_at_station: count(r => r.what === 'donated' && r.gave && Object.keys(r.gave).length),
    },
    a_person_asking_bots: {
      menus: count(r => r.what === 'desk_menu'),
      requests: count(r => r.what === 'desk_request'),
      refused: count(r => r.what === 'desk_refused'),
      served: count(r => r.what === 'desk_served' || ((r.what === 'uncurse' || r.what === 'revealed') && r.human)),
      handed: count(r => r.what === 'handed' && r.human),
      unserved: unserved.length,
      cancelled: count(r => r.what === 'desk_cancel'),
    },
    old_failure_while_playing: oldFailure.length,
    // AT ANY TIME, for comparison: before the desk shipped, every one of these was a person
    // playing the holder or a keeper that had stopped, and the ledger could not say which.
    nobody_on_duty_any: count(r => r.what === 'ride_declined' && /nobody is on chalice duty/.test(r.why ?? '')),
    blocked: timedOut.length + unserved.length + oldFailure.length,
    blocked_rows: [...timedOut, ...unserved, ...oldFailure].map(r => ({ iso: r.iso, character: r.character,
      what: r.what, why: r.why ?? null })),
  };
}

if (process.argv[1]?.endsWith('m59-desk-report.mjs')) {
  const s = summarise(rows());
  if (asJson) { console.log(JSON.stringify(s, null, 1)); process.exit(0); }
  const sec = (ms) => (ms == null ? '-' : `${Math.round(ms / 1000)}s`);
  console.log(`human desk, last ${hours}h  (${dir})\n`);
  console.log('sessions at the controls:');
  if (!s.sessions.length) console.log('  none');
  for (const x of s.sessions)
    console.log(`  ${x.character.padEnd(18)} ${new Date(x.from).toISOString().slice(5, 16)}  ${String(x.minutes).padStart(4)}m  ${x.to ? '' : '(still playing)'}`);
  const b = s.bots_asking_a_person, p = s.a_person_asking_bots;
  console.log('\nbots asking a person:');
  console.log(`  rides requested ${b.rides_requested}, handed over ${b.handed_over}` +
              `  (wait median ${sec(b.wait_ms.median)}, p90 ${sec(b.wait_ms.p90)}, max ${sec(b.wait_ms.max)})`);
  console.log(`  held ${b.held}, declined fast ${b.declined_fast}, TIMED OUT ${b.timed_out}`);
  console.log(`  service tells ${b.services_asked}, forces-of-light tells ${b.fol_tells}, tells not delivered ${b.tells_not_delivered}`);
  if (b.cargo_held) console.log(`  restock deliveries held for the keeper: ${b.cargo_held}`);
  if (b.items_left_on_floor) console.log(`  ITEMS LEFT ON THE STATION FLOOR: ${b.items_left_on_floor} time(s)`);
  const k = s.restock;
  console.log('\nreturn-trip restock for the holder:');
  console.log(`  drawn ${k.drawn}, bought ${k.bought}, DELIVERED ${k.delivered}, donated at the station ${k.donated_at_station}`);
  console.log(`  draws failed ${k.draw_failed}, draws empty ${k.draw_empty}, buys skipped ${k.buy_skipped}`);
  console.log('\na person asking bots:');
  console.log(`  menus ${p.menus}, requests ${p.requests} (refused ${p.refused}, cancelled ${p.cancelled}), ` +
              `served ${p.served + p.handed}, UNSERVED ${p.unserved}`);
  console.log(`\n"nobody is on chalice duty": ${s.nobody_on_duty_any} in all, ${s.old_failure_while_playing} while a person played` +
              (s.old_failure_while_playing ? '   <-- the mark is not reaching the travellers' : ''));
  console.log(`\nBLOCKED: ${s.blocked}${s.blocked ? '' : ' — nobody was left without service'}`);
  for (const r of s.blocked_rows.slice(-15)) console.log(`  ${r.iso?.slice(5, 19)}  ${r.character.padEnd(12)} ${r.what}  ${r.why ?? ''}`);
}
