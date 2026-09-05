#!/usr/bin/env node
// ALL HANDS: call the whole fleet into one room, pool what it is carrying, and send it
// back out full.
//
//   node tools/m59-allhands.mjs --dry-run     # who would come, what would move
//   node tools/m59-allhands.mjs               # do it
//   node tools/m59-allhands.mjs --room 153    # somewhere other than the Cibilo Creek Inn
//
// WHY THIS EXISTS. The fleet's resources are not scarce, they are in the wrong pockets,
// and the correction has been one hand-over at a time on every pass: Sweetums sitting on
// a 412-vigor larder while Animal carried nothing, Janice with 400 shillings and no food,
// Zoot at 78 vigor next to a character at 200. Each fix needs both keepers held AND the
// pair to be in the same room, and two keepers driving means they usually are not — half
// the attempts fail with "the offer never reached them". Bringing everyone to one room
// first makes every transfer a local one.
//
// COR NOTH IS THE MEETING POINT because it is roughly central: Barloque, Jasper, Tos and
// the Ilerian woods are all reachable from it, and Solomon's Edibles next door at 151 is
// the only shop in the world that sells food AND elderberry (apple 45, bread 108,
// elderberry 36).
//
// THREE THINGS MOVE, in this order, because each one unblocks the next:
//
//   1. REAGENTS. `create food` needs 2 elderberry + 2 herbs in the CASTER's pack, and
//      relay needs an edible mushroom. A character with neither can neither cook nor
//      share, so reagents go first.
//   2. FOOD. Straight redistribution from the fullest larder to the emptiest.
//   3. RELAY. Kraanan lv1, 5 mana, one edible mushroom — whose kod class is "Snack", so
//      the `spells` tool reports the requirement under that name; see readAll — and it
//      hands the CASTER's OWN VIGOR to someone else
//      (relay.kod) — it is not a mana transfer. It refuses a target
//      already at 150 (MAX_TOTAL_AMOUNT) and a caster at or under 15 vigor, and it moves
//      spellpower's worth, capped at the caster's vigor minus 10. So it is the one way to
//      move vigor itself rather than the means to make it.
//
// THE EAT RATE LIMIT IS THE BINDING CONSTRAINT. "You are too full to eat that right now"
// arrives after two or three items and does not lift for a while, so nobody goes from 80
// to 200 in one sitting however much food is in the room. This runs several eat rounds
// with the relays in between and reports where it actually got to; the rest is the
// keeper's job once everyone is home.
//
// IT PUTS EVERYONE BACK. Each character's hunt and assigned room are recorded before it
// is pulled and restored afterwards, so the muster does not quietly undo a deployment.

import { readFileSync } from 'node:fs';
import { foodValue } from './m59-items.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const PORT = process.env.M59_BROKER_PORT || '8901';
const RPC = `http://127.0.0.1:${PORT}/`;
const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
// A MOOT HAPPENS IN AN INN AND NOWHERE ELSE. Standing a dozen characters still in the
// open to eat is standing them still somewhere things can hit them — the first accidental
// moot here ran in Deep Woods of Ileria, which spawns living trees, and every character
// in it was a target that was not fighting back. Inns are safe rooms; the muster only
// ever assembles in one.
const INNS = new Map([
  [153, 'Cibilo Creek Inn, Cor Noth'], [106, 'Brownestone Inn, Barloque'],
  [103, 'The Bhrama & Falcon, Barloque'], [52, 'Familiars, Tos'],
  [202, 'The Limping Toad Inn and Tavern, Marion'], [2001, 'The Aerie Guest House, Kocatan'],
  [1017, 'Raza Pub'], [1007, "Eric's Stout Spirits"],
]);

const DRY = !!arg('dry-run', false);
const ROOM = Number(arg('room', 153));            // Cibilo Creek Inn, Cor Noth
const SHOP = Number(arg('shop', 151));            // Solomon's Edibles, next door
const TARGET = Number(arg('target', 150));        // relay refuses above this anyway
const EAT_ROUNDS = Number(arg('eat-rounds', 3));

let id = 0;
async function call(name, args = {}, ms = 300000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: c.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
    });
    const j = await r.json();
    const txt = j?.result?.content?.[0]?.text;
    if (txt === undefined) return { _raw: j };
    try { return JSON.parse(txt); } catch { return { _text: txt }; }
  } catch (e) { return { _err: String(e) }; } finally { clearTimeout(t); }
}

// NUTRITION IS VIGOR ONE FOR ONE (player.kod:1277), AND THE NUMBERS COME FROM THE GAME.
//
// This was a hand-written table of eight foods and it was wrong twice. The comment it
// replaces recorded the first time — edible mushrooms assumed to be 3 when they are 5 — and
// the second was still here: `turkey leg` was listed at 20 against the game's 15.
//
// The list was also short. It knew eight foods of the twenty-two that exist, and none of the
// seven the Duke's tables hand out, so a fleet holding 1,177 slices of pork and 77 spider
// eyes reported a larder of nearly nothing. That is not a rounding error in a report; it is
// the report saying the fleet is starving while it eats.
//
// `foodValue` reads the table built from the game's own Food class tree. It cannot be short
// and it cannot disagree.
const nut = n => foodValue(n)?.nutrition ?? 0;
const EDIBLE = n => !!foodValue(n);
// Eat the weakest first so the dense meals survive for the road. Ranking by the real
// nutrition does that for every food rather than for the four this file used to name — and
// an Inky-cap at 50 now correctly outranks everything instead of falling in the `3` bucket
// with the cheese.
const RANK = n => nut(n);

const pad = (s, n) => String(s ?? '').padEnd(n);
const pr = (s, n) => String(s ?? '').padStart(n);
const log = (...m) => console.log(...m);

// `status` reports room as {id, name} where id is the OBJECT id, not the room number —
// 1419 for The Great Ocean, not 552. Only `fleet` and `travel` speak room numbers, so the
// room is read from the fleet listing and everything else from status.
async function rooms() {
  const f = await call('fleet', {}, 120000);
  return new Map((f.fleet || []).map(r => [r.agent, r.room_num]));
}

async function readAll(agents) {
  const where = await rooms();
  const out = [];
  for (const a of agents) {
    const st = await call('status', { agent: a, brief: true }, 60000);
    const inv = await call('inventory', { agent: a }, 60000);
    const items = inv.items || [];
    out.push({
      agent: a, character: st.character ?? a,
      room: where.get(a) ?? null,
      vigor: st.vitals?.vigor?.value ?? null,
      mana: st.vitals?.mana?.value ?? 0,
      health: st.vitals?.health,
      stacks: items.length,
      purse: items.filter(i => /shilling/i.test(i.name)).reduce((t, i) => t + (i.amount || 1), 0),
      larder: items.reduce((t, i) => t + nut(i.name) * (i.amount || 1), 0),
      shrooms: items.filter(i => /edible mushroom/i.test(i.name)).reduce((t, i) => t + (i.amount || 1), 0),
      // THE CLASS IS `Snack`; THE DISPLAY NAME IS "edible mushroom". They are one item,
      // and confusing them wasted a shopping trip and nearly a working tool.
      //
      // `spells` reports relay as `blocked_by: ["needs 1 x Snack, carrying 0"]` — that is
      // the KOD CLASS. Every inventory name on the wire is the display name, so a scan for
      // /snack/ over `items` matches nothing even while the character is holding a stack of
      // them, and reads as "the fleet has none" rather than "this scan cannot see them".
      // `shrooms` above is the count relay actually needs; there is no separate field.
      //
      // Buying them: the shop lists the class, `Mushroom`, so `who-sells mushroom` finds it
      // (104 Barloque, 53 Tos, 373 Jasper) while `who-sells snack` finds nothing at all.
      elder: items.filter(i => /elder\s?berry/i.test(i.name)).reduce((t, i) => t + (i.amount || 1), 0),
      herbs: items.filter(i => /^herbs?$/i.test(i.name)).reduce((t, i) => t + (i.amount || 1), 0),
      items,
    });
  }
  return out;
}

async function eatDown(a, want = 200) {
  let now = (await call('status', { agent: a, brief: true }, 60000)).vitals?.vigor?.value ?? 0;
  const ate = [];
  for (let i = 0; i < 8 && now < want; i++) {
    const inv = await call('inventory', { agent: a }, 60000);
    const f = (inv.items || []).filter(x => EDIBLE(x.name))
      .sort((x, y) => RANK(x.name) - RANK(y.name))[0];
    if (!f) break;
    const r = await call('act', { agent: a, verb: 'eat', target: f.id }, 60000);
    if (/too full/i.test(JSON.stringify(r.messages || []))) break;
    const v = (await call('status', { agent: a, brief: true }, 60000)).vitals?.vigor?.value ?? now;
    if (v <= now) break;
    ate.push(`${f.name} +${v - now}`); now = v;
    await new Promise(x => setTimeout(x, 800));
  }
  return { vigor: now, ate };
}

const main = async () => {
  if (!INNS.has(ROOM)) {
    console.error(`room ${ROOM} is not an inn — a moot only assembles somewhere safe.`);
    console.error('inns: ' + [...INNS].map(([n, s]) => `${n} ${s}`).join('\n       '));
    process.exit(1);
  }
  // A HOLD EXPIRES AFTER FIFTEEN MINUTES. `autopilot stop` sets inert with
  // gives_up_after_s = 900, so a keeper put down at the start of a muster is driving
  // again long before a slow straggler arrives — the first run had thirteen characters
  // assemble and then wander off while the script was still fetching the fourteenth.
  // Anything that needs the fleet stationary has to finish inside that window, which is
  // why the pooling below starts on whoever is present rather than waiting for everyone.
  console.log(`meeting at ${ROOM} — ${INNS.get(ROOM)}`);
  const list = await call('autopilot', { agent: 'any', action: 'list' }, 60000);
  if (!Array.isArray(list?.autopilots)) {
    console.error('the broker is not answering a keeper list:', JSON.stringify(list).slice(0, 200));
    process.exit(1);
  }
  const agents = list.autopilots.map(a => a.name);
  log(`all hands: ${agents.length} character(s) -> room ${ROOM}${DRY ? '  (dry run)' : ''}\n`);

  // ORDERS FIRST. If this throws halfway we still know where everyone belonged.
  const orders = new Map();
  for (const a of agents) {
    const s = await call('autopilot', { agent: a, action: 'status' }, 60000);
    orders.set(a, { mode: s.mode || 'farm', hunt: s.policy?.hunt, room: s.policy?.assignedRoom,
                    strategy: s.policy?.strategy, fight_above_vigor: s.policy?.fightAboveVigor });
  }

  let before = await readAll(agents);
  log(pad('ag', 5), pad('char', 10), pr('vigor', 6), pr('larder', 7), pr('shroom', 7), pr('eld', 4), pr('herb', 5), pr('purse', 6), pr('room', 6));
  for (const r of before.sort((x, y) => (x.vigor ?? 0) - (y.vigor ?? 0)))
    log(pad(r.agent, 5), pad(r.character, 10), pr(r.vigor, 6), pr(r.larder, 7), pr(r.shrooms, 7), pr(r.elder, 4), pr(r.herbs, 5), pr(r.purse, 6), pr(r.room, 6));
  const total = before.reduce((t, r) => t + r.larder, 0);
  log(`\nfleet larder ${total} vigor of food, ${before.reduce((t, r) => t + r.shrooms, 0)} edible mushrooms, ` +
      `${before.reduce((t, r) => t + r.elder, 0)} elderberry, ${before.reduce((t, r) => t + r.herbs, 0)} herbs`);
  if (DRY) { log('\ndry run — nothing was moved'); return; }

  // ---- muster -----------------------------------------------------------------
  log(`\n-- mustering at ${ROOM} --`);
  for (const a of agents) await call('autopilot', { agent: a, action: 'stop', why: 'all hands — mustering at Cor Noth' }, 60000);
  const here = [], missing = [];
  const at0 = await rooms();
  for (const a of agents) {
    let at = at0.get(a);
    for (let i = 0; i < 3 && at !== ROOM; i++) {
      const t = await call('travel', { agent: a, to: ROOM }, 300000);
      at = t.room?.num ?? (await rooms()).get(a);
    }
    (at === ROOM ? here : missing).push(a);
    log('  ', pad(a, 5), at === ROOM ? 'arrived' : `could not get there (in ${at})`);
  }
  log(`\n${here.length} of ${agents.length} made it${missing.length ? '; absent: ' + missing.join(' ') : ''}`);

  // ---- pool -------------------------------------------------------------------
  const move = async (kind, pick, need) => {
    let moved = 0;
    for (let round = 0; round < 3; round++) {
      const now = await readAll(here);
      const givers = now.filter(r => pick(r) > need * 3).sort((a, b) => pick(b) - pick(a));
      const takers = now.filter(r => pick(r) < need).sort((a, b) => pick(a) - pick(b));
      if (!givers.length || !takers.length) break;
      for (const t of takers) {
        const g = givers.find(x => x.agent !== t.agent && pick(x) > need * 3);
        if (!g) break;
        const r = await call('supply', { from: g.agent, to: t.agent, what: kind, amount: 6, who_travels: 'neither' }, 180000);
        log('  ', pad(`${g.character}->${t.character}`, 22), kind,
          r.supplied ? 'ok ' + JSON.stringify(r.amounts ?? '').slice(0, 70)
                     : 'no — ' + String(r.reason ?? r._err ?? '').slice(0, 70));
        if (r.supplied) moved++;
      }
    }
    return moved;
  };
  log('\n-- reagents --');   await move('reagents', r => r.elder, 4);
  log('\n-- food --');       await move('food', r => r.larder, 60);

  // ---- eat, relay, eat --------------------------------------------------------
  for (let round = 1; round <= EAT_ROUNDS; round++) {
    log(`\n-- eating, round ${round} --`);
    for (const a of here) {
      const e = await eatDown(a);
      if (e.ate.length) log('  ', pad(a, 5), '->', e.vigor, ':', e.ate.join(', '));
    }
    // RELAY IS FOR THE GAP FOOD CANNOT CLOSE. Anyone still under the cap gets vigor
    // handed to them by whoever is over it — the spell refuses a target at 150 and a
    // caster at 15, so both ends are checked before spending the mushroom.
    log(`-- relaying vigor to anyone under ${TARGET} --`);
    const now = await readAll(here);
    const poor = now.filter(r => (r.vigor ?? 0) < TARGET).sort((a, b) => a.vigor - b.vigor);
    const rich = now.filter(r => (r.vigor ?? 0) > TARGET + 20 && r.mana >= 5 && r.shrooms >= 1)
                    .sort((a, b) => b.vigor - a.vigor);
    if (!poor.length) { log('   everyone is at the cap'); break; }
    // SAY HOW MANY, not just that nobody can. "Nobody has spare vigor, mana and a mushroom"
    // is three conditions in one sentence and hides which one failed — and the commonest
    // cause is the eating step above, which ranks edible mushrooms FIRST and will happily
    // eat the entire relay reagent before this line is reached.
    if (!rich.length) {
      const held = now.reduce((t, r) => t + (r.shrooms ?? 0), 0);
      const spare = now.filter(r => (r.vigor ?? 0) > TARGET + 20).length;
      log(`   no relay: ${spare} character(s) have vigor to spare and the fleet holds ` +
          `${held} edible mushroom(s) — relay needs one per cast, and the eat rounds above ` +
          `consume them first`);
      continue;
    }
    for (const t of poor) {
      const g = rich.find(x => x.agent !== t.agent);
      if (!g) break;
      // `target`, singular — the cast tool takes one, not a list.
      const r = await call('cast', { agent: g.agent, spell: 'relay', target: t.character }, 90000);
      const v = (await call('status', { agent: t.agent, brief: true }, 60000)).vitals?.vigor?.value;
      log('  ', pad(`${g.character}->${t.character}`, 22), 'mana', pr(r.mana_spent, 3),
        '| target now', pr(v, 4), JSON.stringify(r.messages || []).slice(0, 90));
      g.vigor -= 20; g.mana -= 5; g.shrooms -= 1;
      if (g.vigor < TARGET + 20) rich.splice(rich.indexOf(g), 1);
    }
  }

  // ---- disperse ---------------------------------------------------------------
  log('\n-- back to work --');
  const after = await readAll(agents);
  for (const a of agents) {
    const o = orders.get(a) || {};
    const r = await call('autopilot', {
      agent: a, action: 'start', mode: o.mode || 'farm', hunt: o.hunt,
      ...(o.room != null ? { assigned_room: o.room } : {}),
      ...(o.strategy ? { strategy: o.strategy } : {}),
      partner: null,
    }, 120000);
    const b = before.find(x => x.agent === a), f = after.find(x => x.agent === a);
    log('  ', pad(a, 5), pad(f?.character, 10), 'vigor', pr(b?.vigor, 4), '->', pr(f?.vigor, 4),
      '| back to', pad(o.hunt, 15), 'in', pr(o.room, 5), '|', String(r.activity ?? r.running).slice(0, 28));
  }
  const gained = after.reduce((t, r) => t + (r.vigor ?? 0), 0) - before.reduce((t, r) => t + (r.vigor ?? 0), 0);
  const under = after.filter(r => (r.vigor ?? 0) < TARGET);
  log(`\nfleet vigor ${gained >= 0 ? '+' : ''}${gained} overall; ${after.length - under.length} of ${after.length} at ${TARGET} or better`);
  if (under.length) log('still short:', under.map(r => `${r.character} ${r.vigor}`).join('  '));
};

// ONLY WHEN THIS FILE IS THE COMMAND, NEVER ON IMPORT.
//
// `main()` at module scope means `import` RUNS IT — and this one musters twenty-one live
// characters across the world, feeds them, and re-issues their orders. It was imported once
// to check a pure helper, and it mustered the fleet.
//
// The same trap is already written down for m59-broker ("importing runs it: it tries to take
// the fleet lock and start rejoin timers") and m59-supervise was guarded for exactly this
// reason. This file is more dangerous than either, because nothing about it fails — it works
// perfectly, on a fleet nobody asked it to touch.
//
// Everything above this line is now importable: `nut`, `EDIBLE` and the report builders are
// pure and worth reading from a test or another tool.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
  main().catch(e => { console.error('all hands failed:', e); process.exit(1); });
