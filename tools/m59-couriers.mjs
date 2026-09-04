#!/usr/bin/env node
// COURIERS, CONTINUOUSLY — a rolling supply line rather than a convoy.
//
//   node tools/m59-couriers.mjs --in-flight 3 --each 120 --buy-only
//   node tools/m59-couriers.mjs --in-flight 2 --until-castings 400
//   node tools/m59-couriers.mjs --dry
//
// WHY A PIPELINE AND NOT WAVES. Waves wait for their slowest member. Six of them ran on
// 2026-09-03 and the fleet spent most of that time with nobody on the road at all, because a
// wave that has one courier wedged in the Cragged Mountains is a wave that dispatches nothing
// for twenty minutes. The road is the bottleneck and it does not care how many are on it, so
// the right shape is a fixed number IN FLIGHT with a new one leaving as soon as a slot opens.
//
// THE ASYMMETRY THE OPERATOR NAMED, and it is what makes this safe to run hot: a courier that
// comes home with reagents nobody needed yet has cost one trip. A fleet that runs dry has cost
// every character's vigor ceiling until the next delivery lands. So over-supply is cheap and
// under-supply is not, and the correct bias is to keep sending. If it gets ahead, stop
// dispatching — the surplus keeps.
//
// WHAT IT WILL NOT DO. It never sends a character that is dead, in the Underworld, already
// committed to something, or that came back from its last trip having bought nothing — that
// last one is the money test, and it is the only reliable one, because a bank balance cannot
// be read without standing in front of a teller.
import { fleetScript, holdKeeper } from './m59-fleetscript.mjs';
import { loadFleetScripts, runNamed } from './m59-fleetlib.mjs';
import { takeRunLock } from './m59-runlock.mjs';

const argv = process.argv.slice(2);
// No `= null` default: a default parameter fires on an explicitly passed `undefined`, which is
// how `--home` became null and compiled a walk to nowhere. See m59-resupply.mjs.
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const num = (n, d) => { const v = arg(n); return v === undefined ? d : Number(v); };

const IN_FLIGHT = num('in-flight', 3);
const EACH = num('each', 120);
const HOME = num('home', 39);
const STAGGER_MS = num('stagger', 45) * 1000;
const COOLDOWN_MS = num('cooldown', 120) * 1000;
const UNTIL_CASTINGS = num('until-castings', 0);
const SHARE = num('share', 40);        // reagents of each kind handed to one character
const KEEP = num('keep', 40);          // what the courier keeps for itself
const NO_SPREAD = argv.includes('--no-spread');
const SWEEP_MS = num('sweep', 180) * 1000;   // how often to re-spread the whole room
const CARRY_MAX_CASTS = num('carry-max', 8); // a courier holding more stock than this stays home
const MAX_TRIPS = num('max-trips', 0);
const BUY_ONLY = argv.includes('--buy-only');
const FLEET = process.env.M59_FLEET || 'prod';
const CONTROL = process.env.M59_CONTROL_URL || 'http://127.0.0.1:8901/';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function call(name, args = {}, timeout = 60_000) {
  const r = await fetch(CONTROL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.random(), method: 'tools/call',
                           params: { name, arguments: args } }),
    signal: AbortSignal.timeout(timeout),
  });
  const d = await r.json();
  try { return JSON.parse(d.result.content[0].text); } catch { return d.result ?? {}; }
}

// THE REAGENT KEYS ARE `herbs` (PLURAL) AND `elderberry` (SINGULAR) and they do not match each
// other. A singular `herb` reads undefined on every row at once and looks exactly like an empty
// fleet — it cost an hour on 2026-09-03. Rows older than a minute are dropped because a ghost
// keeper keeps serving stale non-zero counts as though they were live.
const FRESH_MS = 60_000;
function readFleet(rows) {
  const fresh = rows.filter(r => (r.snapshot_age_ms ?? 0) < FRESH_MS);
  let herbs = 0, elder = 0, castings = 0;
  for (const r of fresh) {
    const h = r.reagents?.herbs ?? 0, e = r.reagents?.elderberry ?? 0;
    herbs += h; elder += e;
    castings += Math.floor(Math.min(h, e) / 2);   // create food is 2 of EACH
  }
  return { fresh, herbs, elder, castings };
}

const state = {
  inFlight: new Map(),        // agent -> started at
  cooldown: new Map(),        // agent -> not before
  // WHY each courier came home empty, not merely THAT it did. See the dispatch site: the
  // reason was printed and then thrown away, and every empty trip was reported as poverty
  // regardless of what had actually happened.
  broke: new Map(),           // agent -> the reason it bought nothing at the counter
  trips: 0, bought: 0, deaths: 0, empty: 0,
  stopping: false,
};

function eligible(rows) {
  const now = Date.now();
  return rows
    .filter(r => (r.snapshot_age_ms ?? 0) < FRESH_MS)
    .filter(r => !state.inFlight.has(r.agent))
    .filter(r => !state.broke.has(r.agent))
    .filter(r => (state.cooldown.get(r.agent) ?? 0) < now)
    // Not dead, not in the Underworld, and not already spoken for by anything else.
    .filter(r => (r.health?.value ?? 1) > 0 && !/underworld/i.test(r.room ?? ''))
    .filter(r => !r.committed || r.committed.kind === 'bot')
    // NEVER SEND THE LARDER DOWN THE ROAD. Rowlf died in the Twisted Wood at 08:57Z carrying
    // the fleet's last 50 herbs, and they are on that floor now — three courier deaths in
    // thirty minutes, all on the same road. What a character carries drops where it falls, so
    // a courier holding stock is betting the fleet's reagents on a crossing that is running at
    // about one body per two. Anyone holding real stock stays home and casts with it.
    .filter(r => Math.floor(Math.min(r.reagents?.herbs ?? 0,
                                     r.reagents?.elderberry ?? 0) / 2) < CARRY_MAX_CASTS)
    // Richest first: the bank step can top up, but only against a balance, and a purse is the
    // one part of a character's money that can actually be read from here.
    .sort((a, b) => (b.purse ?? 0) - (a.purse ?? 0));
}


// HAND IT OUT WHERE IT LANDS, OR IT IS NOT SUPPLY — IT IS A PILE.
//
// 2026-09-03, mid-run: 348 herbs, 298 elderberry and 149 castings on the fleet, and EIGHTEEN OF
// TWENTY characters could cast nothing, because every reagent was on the three bodies that had
// fetched it. A supply line that ends at the courier has not delivered anything; the reagents
// are as useless in room 39 in one pack as they were in Frisconar's shop.
//
// `supply` rather than `trade`: trade is a two-sided protocol and a half-finished one is SILENT —
// the goods sit on the table looking handed over. supply drives both ends and then reads the
// receiver's pack to prove it landed. Nobody walks, because everyone involved is already here.
async function spread(from, rows) {
  const me = rows.find(r => r.agent === from);
  if (!me) return 0;
  const room = me.room_num;
  const stock = () => {
    const r = (rows.find(x => x.agent === from) ?? {}).reagents ?? {};
    return Math.min(r.herbs ?? 0, r.elderberry ?? 0);
  };
  // Neediest first, measured in CASTINGS rather than in reagents: a character with 50 herbs and
  // no elderberry can cast exactly as much as one with nothing, which is nothing.
  const needy = rows
    .filter(r => r.agent !== from && r.room_num === room && (r.snapshot_age_ms ?? 0) < FRESH_MS)
    .map(r => ({ r, casts: Math.floor(Math.min(r.reagents?.herbs ?? 0,
                                               r.reagents?.elderberry ?? 0) / 2) }))
    .filter(x => x.casts < 10)
    .sort((a, b) => a.casts - b.casts);
  if (!needy.length) return 0;

  let handed = 0, left = stock();
  for (const { r, casts } of needy) {
    if (left - SHARE < KEEP) break;
    const out = await call('supply', { from, to: r.agent, what: 'reagents', amount: SHARE,
                                       who_travels: 'neither' }, 120_000).catch(e => ({ error: e.message }));
    // Judged on the RECEIVER'S pack, which is what supply verifies — a hand-over that completes
    // the handshake and moves nothing looks like success on the wire.
    const landed = Number(out?.delivered ?? out?.moved ?? 0) || (out?.ok && !out?.error ? SHARE : 0);
    if (landed > 0) { handed++; left -= SHARE; }
    else log(`  spread ${from} -> ${r.agent} moved nothing (${out?.error ?? 'no reason given'})`);
  }
  if (handed) log(`  ${from} handed ${SHARE} of each to ${handed} character(s), keeping ${left}`);
  return handed;
}


// THE BACKLOG SWEEP — SPREADING WHAT IS ALREADY ON THE FLEET, NOT JUST WHAT JUST LANDED.
//
// A courier spreading its own load only ever reaches what it fetched. Everything banked up
// before that step existed sits where it is: on 2026-09-03 that was 16 of 20 characters at 0/0
// while three bodies held 290 of each. So this walks the whole room, not the courier.
//
// AND IT TAKES THE MOVEMENT LEASE ON BOTH ENDS FIRST, which is the difference between this and
// running m59-almoner over the same characters. Three of eight hand-overs in the almoner's pass
// failed for one reason wearing three hats — "already held: travelling to 2 (resumed)", "not in
// the room", "t20 is busy: walk to Upstairs in Castle Victoria" — all of them a keeper walking a
// donor or a receiver away mid-hand-over. A hand-over is a two-body operation and both bodies
// have to stand still for it. Survival stays with the keeper throughout, as always.
let lastSweep = 0;
async function sweepSpread() {
  if (NO_SPREAD || Date.now() - lastSweep < SWEEP_MS) return 0;
  lastSweep = Date.now();
  const rows = ((await call('fleet', {}).catch(() => ({}))).fleet ?? [])
    .filter(r => (r.snapshot_age_ms ?? 0) < FRESH_MS);
  const casts = r => Math.floor(Math.min(r.reagents?.herbs ?? 0, r.reagents?.elderberry ?? 0) / 2);
  // Only within one room: `supply` can make somebody walk, and a walk here is a keeper fight we
  // do not need. Co-located pairs only; anyone out of position gets swept on a later pass.
  const byRoom = new Map();
  for (const r of rows) {
    if (r.room_num == null) continue;
    if (!byRoom.has(r.room_num)) byRoom.set(r.room_num, []);
    byRoom.get(r.room_num).push(r);
  }
  let handed = 0;
  for (const [room, here] of byRoom) {
    const donors = here.filter(r => casts(r) >= (SHARE + KEEP) / 2).sort((a, b) => casts(b) - casts(a));
    const needy = here.filter(r => casts(r) < 5).sort((a, b) => casts(a) - casts(b));
    if (!donors.length || !needy.length) continue;
    for (const d of donors) {
      let left = Math.min(d.reagents?.herbs ?? 0, d.reagents?.elderberry ?? 0);
      const hold = await holdKeeper({ log: (a, ...m) => log(' ', a, ...m), name: 'spread', pollMs: 2000 },
                                    d.agent, FLEET).catch(() => null);
      try {
        for (const n of needy) {
          if (left - SHARE < KEEP) break;
          if (state.inFlight.has(n.agent) || state.inFlight.has(d.agent)) continue;
          const nHold = await holdKeeper({ log: () => {}, name: 'spread', pollMs: 2000 },
                                         n.agent, FLEET).catch(() => null);
          try {
            const out = await call('supply', { from: d.agent, to: n.agent, what: 'reagents',
                                               amount: SHARE, who_travels: 'neither' }, 120_000)
              .catch(e => ({ error: e.message }));
            if (out?.error) log(`  spread ${d.agent} -> ${n.agent}: ${String(out.error).slice(0, 90)}`);
            else { handed++; left -= SHARE; }
          } finally { await nHold?.release().catch(() => {}); }
        }
      } finally { await hold?.release().catch(() => {}); }
    }
    if (handed) log(`  swept room ${room}: ${handed} hand-over(s) of ${SHARE} of each`);
  }
  return handed;
}

async function dispatch(agent, scripts, scarce = null) {
  state.inFlight.set(agent, Date.now());
  state.trips++;
  log(`-> ${agent} leaving (${state.inFlight.size} on the road, trip ${state.trips})`);
  let r;
  try {
    r = await runNamed('resupply', {
      agents: agent, each: EACH, home: HOME, scarce,
      ...(BUY_ONLY ? { buyOnly: true } : {}),
    }, { scripts, fleetScript, onLog: (...a) => log(' ', ...a) });
  } catch (e) {
    r = { results: { [agent]: { ok: false, why: e.message } } };
  }
  state.inFlight.delete(agent);
  const one = r?.results?.[agent] ?? {};
  // DID ANYTHING ENTER THE PACK? That is the only question worth asking of a supply trip, and
  // the shop step answers it by counting the pack rather than by trusting the merchant.
  const shop = Object.entries(one.state ?? {}).find(([k]) => k.endsWith(':shop'))?.[1];
  const got = (shop?.gained ?? []).reduce((n, g) => n + Math.max(0, g.got), 0);
  if (one.dead) state.deaths++;
  if (got > 0) {
    state.bought += got;
    state.cooldown.set(agent, Date.now() + COOLDOWN_MS);
    log(`<- ${agent} home with ${got} reagents` + (one.dead ? ' (died on the way and finished anyway)' : ''));
    if (!NO_SPREAD) {
      const rows = (await call('fleet', {}).catch(() => ({}))).fleet ?? [];
      await spread(agent, rows).catch(e => log('  spread failed', e.message));
    }
  } else {
    // AN EMPTY TRIP IS NOT PROOF OF AN EMPTY PURSE, and treating it as one ended a run
    // while the fleet was holding twenty thousand shillings.
    //
    // This dropped the courier and counted it toward a total reported as "dropped for
    // having no money". The real reason was right here in `one.why`, printed, and
    // discarded. Measured 2026-09-04: of the two couriers whose failure ended the run, one
    // had `did not reach 53 in three attempts` and the other `could not reach the health
    // floor (32/49)`. Neither was broke — one character alone was carrying 5,573 shillings
    // — and both were transient failures the next pass would likely have got past.
    //
    // So the reason is kept, a courier that never reached the counter is asked again after
    // the ordinary cooldown, and only a trip that GOT there and still bought nothing is
    // treated as poverty. A merchant selling you nothing while you stand in front of it is
    // the one thing an empty pack really does prove.
    const why = one.why ?? 'no reason given';
    state.empty++;
    if (shop != null) {
      state.broke.set(agent, why);
      log(`<- ${agent} home with NOTHING from the counter — dropping it from the pool (${why})`);
    } else {
      state.cooldown.set(agent, Date.now() + COOLDOWN_MS);
      state.transient = (state.transient ?? 0) + 1;
      log(`<- ${agent} home with NOTHING, never reached the counter — will be asked again (${why})`);
    }
  }
}

const { scripts, problems } = await loadFleetScripts();
for (const p of problems) console.error(`script would not load: ${p.file}: ${p.why}`);
if (!scripts.get('resupply')) { console.error('no `resupply` script found'); process.exit(2); }

const rows0 = (await call('fleet', {})).fleet ?? [];
const seen0 = readFleet(rows0);
log(`fleet: ${seen0.fresh.length} fresh rows | herbs ${seen0.herbs} | elderberry ${seen0.elder} | ` +
    `castings ${seen0.castings}`);
log(`plan: ${IN_FLIGHT} on the road at once, ${EACH} of each per trip, ` +
    `${BUY_ONLY ? 'buy-only' : 'sell then buy'}, home ${HOME}, ` +
    `${NO_SPREAD ? 'no spread' : `spreading ${SHARE} of each on arrival, keeping ${KEEP}`}` +
    (UNTIL_CASTINGS ? `, until ${UNTIL_CASTINGS} castings` : '') +
    (MAX_TRIPS ? `, at most ${MAX_TRIPS} trips` : ''));

if (argv.includes('--dry')) {
  const pool = eligible(rows0);
  log(`would send, richest first: ${pool.slice(0, 8).map(r => `${r.agent}(${r.purse ?? 0}sh)`).join(', ')}`);
  log('(nothing was sent)');
  process.exitCode = 0;
} else {
  // ONE LOCK FOR THE WHOLE PIPELINE. The inner errands re-enter it because they are this same
  // pid, which the lock allows on purpose; holding it out here is what stops a second tool
  // starting a convoy into the middle of this one.
  const claim = takeRunLock(FLEET, { label: `couriers x${IN_FLIGHT}`,
                                     force: argv.includes('--force') });
  if (!claim.ok) {
    const h = claim.holder ?? {};
    log(`REFUSING — fleet "${FLEET}" is already being driven by pid ${h.pid}: ${h.label}`);
    process.exit(3);
  }
  const stop = () => { if (!state.stopping) { state.stopping = true; log('stopping — no new couriers; letting the ones on the road finish'); } };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const running = new Set();
  try {
    while (!state.stopping) {
      const rows = (await call('fleet', {})).fleet ?? [];
      const seen = readFleet(rows);
      if (UNTIL_CASTINGS && seen.castings >= UNTIL_CASTINGS) {
        log(`castings ${seen.castings} >= ${UNTIL_CASTINGS} — that is enough, stopping dispatch`);
        break;
      }
      if (MAX_TRIPS && state.trips >= MAX_TRIPS) { log(`${state.trips} trips sent — stopping dispatch`); break; }

      await sweepSpread().catch(e => log('sweep failed', e.message));

      if (state.inFlight.size < IN_FLIGHT) {
        const next = eligible(rows)[0];
        if (next) {
          // Recomputed per dispatch: the scarce half flips as deliveries land.
          const scarce = seen.herbs <= seen.elder ? 'herb' : 'elder';
          const p = dispatch(next.agent, scripts, scarce)
            .catch(e => log('dispatch failed', e.message));
          running.add(p); p.finally(() => running.delete(p));
          await new Promise(r => setTimeout(r, STAGGER_MS));
          continue;
        }
        if (!state.inFlight.size) {
          // SAY WHAT ACTUALLY HAPPENED. "no money" was a guess wearing a finding's clothes,
          // and it sent an operator looking for shillings the fleet already had.
          const reasons = [...state.broke.values()]
            .reduce((m, w) => m.set(w, (m.get(w) ?? 0) + 1), new Map());
          log(`nobody eligible — ${state.broke.size} dropped at the counter` +
              (reasons.size ? `: ${[...reasons].map(([w, n]) => `${n}x ${w}`).join('; ')}` : '') +
              (state.transient ? `, ${state.transient} empty trip(s) never reached it` : '') +
              ' — stopping');
          break;
        }
      }
      await new Promise(r => setTimeout(r, 20_000));
    }
  } finally {
    log('waiting for couriers still on the road…');
    await Promise.allSettled([...running]);
    claim.release();
    const rows = (await call('fleet', {})).fleet ?? [];
    const seen = readFleet(rows);
    log(`done: ${state.trips} trips, ${state.bought} reagents delivered, ${state.empty} empty, ` +
        `${state.deaths} died en route`);
    log(`fleet now: herbs ${seen.herbs} | elderberry ${seen.elder} | castings ${seen.castings}`);
    log('spread it, or it sits on the couriers:');
    log('  node tools/m59-almoner.mjs --amount 40 --keep 40 --max-deliveries 20 --max-hops 1');
  }
}
