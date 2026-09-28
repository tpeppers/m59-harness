#!/usr/bin/env node
// KEEP ONE CHARACTER STOCKED FROM THE GUILD CHEST, ON SOMEBODY ELSE'S LEGS.
//
//   node tools/m59-keep-stocked.mjs --target hk3 --room 2 \
//        --want "elderberry:300,orc tooth:100" --low "elderberry:60,orc tooth:25" \
//        --money 5000 --exclude hk1,t19 --cwd C:/code/m59-lab/prod-deploy
//
// Operator, 2026-09-27: "just have other characters that are idling (or already making trips!)
// ... take 5k of 10k from the guild chest and ship out the 300 elders + 100 orc tooth from the
// chest when Raphael needs a full restock". The stage-room dedicator is a 25-health caster who
// died three times in one morning walking to the shops, so the stock comes to him instead.
//
// WHAT IT DOES, EACH ROUND. Asks the broker's `fleet` for the target. If the target is standing in
// its room and ANY wanted item is under its low mark, it picks a rider — an idle, takeable,
// full-sized character in the same room with the most free pack — and runs the public `provision`
// fleetscript for it: ride the chalice to the guild hall, draw `money` shillings and the shortfall
// from the chests, buy what the chests lacked at the apothecary with that money, walk home. Then it
// hands the goods to the target with `supply`, which verifies by what the receiver holds.
//
// IT HOLDS NOTHING. provision takes and returns its own leases, the one-driver-per-fleet lock
// refuses it while another script runs (it then waits and tries again), and stopping this is
// Ctrl-C. The decisions are pure functions below; m59-keep-stocked-test.mjs pins them.
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** "elderberry:300,orc tooth:100" -> { elderberry: 300, 'orc tooth': 100 } */
export function parseCounts(s = '') {
  const out = {};
  for (const part of String(s).split(',').map(x => x.trim()).filter(Boolean)) {
    const i = part.lastIndexOf(':');
    const name = part.slice(0, i).trim(), n = Number(part.slice(i + 1));
    if (!name || !(n >= 0)) throw new Error(`bad count "${part}" — want "name:number"`);
    out[name] = n;
  }
  return out;
}

const norm = s => String(s ?? '').trim().toLowerCase();

/** How many of each wanted item a fleet row carries, from its pack summary. */
export function carriedCounts(row, names) {
  const items = Array.isArray(row?.pack_items) ? row.pack_items : [];
  return Object.fromEntries(names.map(n => [n, items.filter(i => norm(i.name) === norm(n))
    .reduce((t, i) => t + (Number(i.amount) || 0), 0)]));
}

/**
 * The restock to fetch, or null. Nothing is fetched until some item is under its LOW mark; then
 * every item is filled back to its WANT, so one trip covers the lot. Money comes along only when
 * something has to be bought.
 */
export function restockPlan(have, want, low, money = 0) {
  const short = Object.keys(want).filter(k => (have[k] ?? 0) < (low[k] ?? 0));
  if (!short.length) return null;
  const wants = Object.entries(want)
    .map(([item, target]) => ({ item, amount: Math.max(0, target - (have[item] ?? 0)) }))
    .filter(w => w.amount > 0);
  if (!wants.length) return null;
  return { short, wants: money > 0 ? [{ item: 'shilling', amount: money }, ...wants] : wants };
}

/**
 * What a rider still carries that the target wants: per item, min(carried, want - have). Empty when
 * the rider has nothing left for it. Pure.
 */
export function pendingDelivery(riderRow, want, have) {
  const carried = carriedCounts(riderRow, Object.keys(want));
  const out = {};
  for (const [item, target] of Object.entries(want)) {
    const n = Math.min(carried[item] ?? 0, Math.max(0, target - (have[item] ?? 0)));
    if (n > 0) out[item] = n;
  }
  return out;
}

/** An idle, takeable, full-sized character in the room, with the most free pack. */
export function pickRider(rows, { room, target, exclude = [], minMaxHealth = 75, minHealth = 0.9 } = {}) {
  const maxOf = r => Number(String(r?.health ?? '').split('/')[1]) || Number(r?.max_health) || 0;
  const pctOf = r => { const [v, m] = String(r?.health ?? '').split('/').map(Number); return m ? v / m : 0; };
  return (rows ?? []).filter(r => r?.agent && r.agent !== target && !exclude.includes(r.agent) &&
      r.room_num === room && r.piloted !== true && r.connected !== false &&
      (r.committed == null || r.committed.takeable !== false) &&
      maxOf(r) >= minMaxHealth && pctOf(r) >= minHealth &&
      (r.policy?.mode ?? r.autopilot?.mode ?? r.mode) !== 'farm')
    .sort((a, b) => (Number(a.pack?.percent ?? 100) - Number(b.pack?.percent ?? 100)) ||
                    String(a.agent).localeCompare(String(b.agent)))[0] ?? null;
}

// ------------------------------------------------------------------------------ the loop
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const die = m => { console.error(m); process.exit(2); };
  const TARGET = arg('target') || die('--target <agent> is required');
  const ROOM = Number(arg('room') || die('--room <stage room> is required'));
  const WANT = parseCounts(arg('want') || die('--want "item:n,..." is required'));
  const LOW = parseCounts(arg('low') || '');
  const MONEY = Number(arg('money') || 0);
  const EXCLUDE = String(arg('exclude') || '').split(',').map(s => s.trim()).filter(Boolean);
  const HOLDERS = String(arg('holders') || arg('exclude') || '').split(',').map(s => s.trim()).filter(Boolean);
  const CWD = arg('cwd') || process.cwd();
  const BROKER = `http://127.0.0.1:${Number(arg('broker') || 8901)}/`;
  const POLL_MS = Math.max(60, Number(arg('poll') || 180)) * 1000;
  const COOL_MS = Math.max(0, Number(arg('cooldown') || 600)) * 1000;
  const say = (...a) => console.log(new Date().toISOString().slice(11, 19), '[keep-stocked]', ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const call = async (tool, args, timeoutMs = 120_000) => {
    const r = await fetch(BROKER, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs) });
    const t = (await r.json())?.result?.content?.[0]?.text;
    if (typeof t !== 'string' || t.startsWith('error:')) throw new Error(t ?? 'no answer');
    return JSON.parse(t);
  };
  // IN-PROCESS, through the same runNamed the fleet REPL uses: the REPL takes key=value with no
  // quoting, and "orc tooth" has a space in it. `wants` goes over as a real array.
  const { loadFleetScripts, runNamed } = await import('./m59-fleetlib.mjs');
  const { fleetScript } = await import('./m59-fleetscript.mjs');
  // ONLY THE HOLDER THAT ACTUALLY CARRIES THE CUP. Passing every possible holder held one that had
  // nothing to do, and the lease fight over it (a DUM re-claiming the troll crew every 30 s) was noise
  // for the whole run. No cup anywhere: the rider walks, as provision already knows how to.
  // WHO IS ON THE DESK IS THE BROKER'S DUTY RECORD, NOT A PACK SCAN (operator, 2026-09-28: "who's
  // on [x]-duty is a broker/roster question"). servingDesk names the serving character — the
  // registered holder or an acting one — and we still check that its pack holds the cup, because a
  // record can lag a grab. No record, or a record that disagrees with the packs: the pack scan.
  const { chaliceStoreFor, servingDesk } = await import('./m59-chalice.mjs');
  const FLEET = arg('fleet', 'prod');
  const carriesCup = r => (r?.pack_items ?? []).some(i => /chalice/i.test(String(i.name)));
  const cupHolders = rows => {
    try {
      const server = servingDesk(chaliceStoreFor({ fleet: FLEET }).duty(), {})?.server;
      const row = server && rows.find(r => r.character === server || r.agent === server);
      if (row && carriesCup(row)) return [row.agent];
    } catch { /* fall back to the packs */ }
    return HOLDERS.filter(a => carriesCup(rows.find(r => r.agent === a)));
  };
  // THE CUP HOLDER EATS BEFORE IT IS HELD AGAIN. A provision run holds the holder for its whole
  // length, and two of these runners take turns, so the holder's keeper — whose eating rung sits
  // behind the hold — never got a turn: Rizzo stood at vigor 80 with ten loaves aboard all evening
  // (2026-09-27). One sitting per run, until the server says the stomach is full.
  const FOODS = ['Inky-cap mushroom', 'meat pie', 'loaf of bread'];
  const feedHolders = async (holders, rows) => {
    for (const a of holders) {
      const r = rows.find(x => x.agent === a);
      const vigor = Number(r?.vigor?.value ?? r?.vigor);
      if (!(vigor < 160)) continue;
      for (const food of FOODS.filter(f => (r?.pack_items ?? []).some(i => i.name === f))) {
        for (let n = 0; n < 6; n++) {
          const ate = await call('act', { agent: a, verb: 'eat', target: food }).catch(() => null);
          if ((ate?.messages ?? []).some(m => /too full/i.test(m))) return say(`  ${a} ate to full before the run`);
          if (!ate) break;
        }
      }
    }
  };
  const provision = async (rider, wants, rows = []) => {
    await feedHolders(cupHolders(rows), rows).catch(() => {});
    const out = [];
    const { scripts } = await loadFleetScripts();
    const r = await runNamed('provision', { agents: [...new Set([...cupHolders(rows), rider])].join(','),
      rider_names: rider, wants, buy_gear: false, stage: ROOM,
      // A failed ride is retried after the cooldown; a WALK from the stage room to the hall crosses
      // 599 and has stranded a hunter off station for over an hour, three times in one day.
      walk_if_no_ride: false },
      { scripts, fleetScript, onLog: (...a) => out.push(a.join(' ')) }).catch(e => ({ ok: false, why: e.message }));
    return { r, out: out.join('\n') };
  };

  say(`keeping ${TARGET} stocked in room ${ROOM}: want ${JSON.stringify(WANT)}, restock under ` +
      `${JSON.stringify(LOW)}, ${MONEY} shillings per trip`);
  let lastTrip = 0;
  // A RIDER STILL CARRYING UNDELIVERED STOCK IS DELIVERED FROM BEFORE ANYBODY FETCHES MORE.
  // 2026-09-28: a hand-over refused "receiver full" left Floyd holding 71 elderberry, and the next
  // round sent Floyd for 119 more — an hour on the road with ~190 elderberry and 10k shillings.
  let pending = arg("pending") || null;   // --pending <agent>: a rider carrying stock from before a restart
  const handOver = async (riderAgent, have) => {
    const rr = (await call('fleet', {})).fleet.find(r => r.agent === riderAgent);
    const todo = pendingDelivery(rr, WANT, have);
    for (const [item, n] of Object.entries(todo)) {
      const r = await call('supply', { from: riderAgent, to: TARGET, what: item, amount: n,
                                       who_travels: 'neither' }, 200_000).catch(e => ({ reason: e.message }));
      say(`  ${riderAgent} -> ${TARGET}: ${n} ${item}: ${r.supplied ? 'delivered' : r.reason}`);
    }
    const after = pendingDelivery((await call('fleet', {})).fleet.find(r => r.agent === riderAgent), WANT,
      carriedCounts((await call('fleet', {})).fleet.find(r => r.agent === TARGET), Object.keys(WANT)));
    return Object.keys(after).length ? riderAgent : null;
  };
  for (;;) {
    try {
      const rows = (await call('fleet', {})).fleet ?? [];
      const t = rows.find(r => r.agent === TARGET);
      if (!t) say(`${TARGET} is not in the fleet reading`);
      else if (t.room_num !== ROOM) say(`${TARGET} is in ${t.room_num}, not ${ROOM}: waiting for it`);
      else if (pending) {
        const pr = rows.find(r => r.agent === pending);
        const have = carriedCounts(t, Object.keys(WANT));
        if (!Object.keys(pendingDelivery(pr, WANT, have)).length) { say(`  ${pending} holds nothing more for ${TARGET}`); pending = null; }
        else if (pr?.room_num !== ROOM) say(`  ${pending} still carries stock for ${TARGET} and is in ${pr?.room_num}: waiting for it`);
        else pending = await handOver(pending, have);
      }
      else {
        const have = carriedCounts(t, Object.keys(WANT));
        const plan = restockPlan(have, WANT, LOW, MONEY);
        if (!plan) { /* stocked */ }
        else if (Date.now() - lastTrip < COOL_MS) say(`short of ${plan.short.join(', ')}; cooling down`);
        else {
          const rider = pickRider(rows, { room: ROOM, target: TARGET, exclude: EXCLUDE });
          if (!rider) say(`short of ${plan.short.join(', ')} (${JSON.stringify(have)}); no idle rider in ${ROOM}`);
          else {
            lastTrip = Date.now();
            say(`short of ${plan.short.join(', ')} (${JSON.stringify(have)}); ${rider.agent} fetches ${JSON.stringify(plan.wants)}`);
            const run = await provision(rider.agent, plan.wants, rows);
            const tail = run.out.split('\n').filter(l => /provision|took|bought|SHORT|refus|lock/i.test(l)).slice(-6);
            for (const l of tail) say('  ', l.trim());
            // THE RIDER HAS TO BE HOME BEFORE IT HANDS OVER. provision can finish with the rider a
            // room short and still walking (Rowlf, 2026-09-28: 597, one room out), and a supply sent
            // then fails "not in the room" with the stock stuck in the rider's pack.
            for (let w = 0; w < 30; w++) {
              const rr = (await call('fleet', {})).fleet.find(r => r.agent === rider.agent);
              if (rr?.room_num === ROOM) break;
              if (w === 0) say(`  ${rider.agent} is in ${rr?.room_num}, not ${ROOM}: waiting for it before the hand-over`);
              await sleep(20_000);
            }
            pending = await handOver(rider.agent, have);
            if (pending) say(`  ${pending} keeps undelivered stock; it is delivered before anybody fetches more`);
          }
        }
      }
    } catch (e) { say(`round failed: ${e.message}`); }
    await sleep(POLL_MS);
  }
}
