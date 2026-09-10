#!/usr/bin/env node
// TRAIN A SHAL'ILLE CASTER BY HEALING SOMEBODY WHO HURTS HIMSELF ON PURPOSE.
//
//   node tools/m59-karmapump.mjs --healer hk1 --patient t6 --room 48        # plans, sends nothing
//   node tools/m59-karmapump.mjs --healer hk1 --patient t6 --room 48 --apply
//   node tools/m59-karmapump.mjs ... --apply --until-karma 50 --max-casts 200
//
// THE MECHANIC, from the operator: karma comes from HEALING a high-karma character, not
// from killing evil things — which is far slower. So a character with karma to spare
// (Beaker, 70) carries an Amulet of Shadows and toggles it: putting it ON curses him,
// trying to take it OFF hurts him. Either way he becomes something to heal, and each heal
// moves the healer's karma. That is the whole loop, and it is the shortest road to the
// karma gates on the Shal'ille ladder — 30 for hospice and rescue, 40 for forces of light,
// 50 for the one we actually want, Reveal.
//
// THE THREE THINGS THAT CAN GO WRONG, AND WHAT EACH ONE COSTS.
//
// 1. KILLING THE PATIENT. He is hurting himself on a timer and the healer is not always
//    able to answer — 25 mana buys eight minor heals and then nothing until he rests. So
//    the floor is checked BEFORE each self-harm and it is checked against the worst case,
//    not the current one: if the healer could not heal right now, the patient does not take
//    another hit. A dead farmer costs a point of maximum health for ever (m59-combat.md).
//
// 2. THE PATIENT WALKING AWAY MID-LOOP. He is a farming character with `mode: farm`,
//    `hunt: [battered skeleton, zombie]` and an assigned room, and a DUM bot re-decides him
//    about every thirty seconds. `busy` will not stop either of them — it is broker-side
//    only, which this repository has already paid to learn. The only thing that holds him
//    is a commander lease on WORK and MOVEMENT, heartbeated for the whole run, and it is
//    released on the way out so he goes back to farming.
//
// 3. THE HEALER DYING. He is a level-1 caster with twenty hit points. Nothing in this loop
//    hurts him, but the room might, so the run refuses to start anywhere the fleet fights
//    and stops if his health moves at all.
//
// IDENTITY, MORTALITY, SURVIVAL AND RECOVERY STAY WITH BOTH KEEPERS. The lease takes work,
// movement and economy and nothing else, so a patient held here still runs from something
// that wanders in — the protected-faculty rule, which is not this tool's to switch off.

import process from 'node:process';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = n => argv.includes(`--${n}`);
const die = (m, c = 1) => { console.error(m); process.exit(c); };

const HEALER = arg('healer') || die('--healer is required (the agent learning Shal’ille)');
const PATIENT = arg('patient') || die('--patient is required (the agent carrying the amulet)');
const ROOM = Number(arg('room') || 0) || null;
const APPLY = has('apply');
const UNTIL_KARMA = Number(arg('until-karma') || 0) || null;
const MAX_CASTS = Number(arg('max-casts') || 200);
const EVERY_MS = Math.max(1500, Number(arg('every') || 3) * 1000);

// The patient never takes a hit below this much of his maximum. 0.6 leaves room for one
// amulet hit plus the gap before a heal lands, on a 60-health character.
const FLOOR = Math.min(0.95, Math.max(0.25, Number(arg('floor') || 0.6)));
// Below this the run STOPS rather than continuing to heal — something other than the
// amulet is hurting him, and this loop is not equipped to win that argument.
const ABORT = Math.min(FLOOR - 0.05, Number(arg('abort') || 0.35));

const BROKER = `http://127.0.0.1:${Number(arg('broker') || 8901)}/`;
const CURSED = /amulet of shadows/i;

// TWO MODES, AND THE FIRST ONE CANNOT KILL ANYBODY.
//
//   curse  the patient PUTS THE AMULET ON, which curses him and does no damage; the healer
//          casts remove curse; repeat. Nothing here can hurt the patient, so the whole
//          health-floor apparatus is inert - it stays armed anyway, because the room can
//          still hurt him and a floor that is only present in the dangerous mode is a floor
//          somebody removes.
//
//   heal   the patient TRIES TO TAKE IT OFF, which hurts him, and the healer heals. This is
//          the mode for practising hospice, and the one the floors exist for. It also needs
//          the patient to be BELOW full health before a heal will land at all - the server
//          refuses a heal on somebody who has nothing to heal.
//
// The operator's ladder runs curse first: remove curse is the level-2 spell whose ability
// unlocks the level-3 tier, and practising it costs one emerald and nine mana with no risk
// to a 60-health farmer at all.
const MODE = (arg('mode') || 'curse').toLowerCase();

// STOP THE MOMENT THE THING YOU ARE GRINDING FOR BECOMES BUYABLE.
//
// Practice has a cliff, not a slope: `PlayerCanLearn` is a threshold, so the ability point
// that crosses it is worth everything and the next hundred are worth nothing until the
// spell is actually bought. A loop that keeps grinding past the gate is burning reagents
// and an operator's evening to raise a number that has stopped mattering.
//
// So this polls the broker's own PlayerCanLearn reproduction — never a local guess at the
// formula, which is per-character and moves with RawIntellect — and exits cleanly when the
// named ability turns learnable. The exit is the signal: whatever is supervising this gets
// told by the process ending, rather than by having to poll it.
const STOP_WHEN = arg('stop-when-learnable') || null;

async function learnable(name) {
  const r = await call('remaining_required_to_learn_new_skills', { agent: HEALER, name }, 45_000)
    .catch(() => null);
  const row = (r?.candidates ?? [])[0];
  if (!row) return { known: false };
  return { known: true, can: row.can_learn === true, need: row.need, have: row.have,
           gap: row.remaining_required };
}

let seq = 0;
async function call(tool, args = {}, timeoutMs = 45_000) {
  const r = await fetch(BROKER, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call',
                           params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json();
  if (j?.error) throw new Error(j.error.message ?? JSON.stringify(j.error));
  const t = j?.result?.content?.[0]?.text;
  if (typeof t !== 'string') return j?.result ?? null;
  if (t.startsWith('error:')) throw new Error(t.slice(7).trim());
  try { return JSON.parse(t); } catch { return t; }
}

// A KEEPER ACTION, because equipping an item is not a broker verb. Reached on the keeper's
// own port, which is DISCOVERED rather than computed: a port is not a name, and this
// repository has already had one broker read another fleet's keeper because the arithmetic
// happened to agree.
async function findKeeper(agent) {
  const ports = Array.from({ length: 100 }, (_, i) => 9011 + i);
  for (const group of Array.from({ length: 10 }, (_, g) => ports.slice(g * 10, g * 10 + 10))) {
    const hits = await Promise.all(group.map(async p => {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(1200) });
        const j = await r.json();
        return j?.agent === agent ? { port: p, agent: j.agent, character: j.character, pid: j.pid } : null;
      } catch { return null; }
    }));
    const hit = hits.find(Boolean);
    if (hit) return hit;
  }
  return null;
}

// A WRITE TO A KEEPER MUST NAME ALL THREE PARTS OF ITS IDENTITY.
//
// `addressedToUs` (m59-keeper-process.mjs:1270) requires agent AND character AND
// keeper_pid, and refuses unless every one is present and the pid is its own. Sending only
// the agent produced the memorably useless refusal `this keeper is "t6", not "t6"` — the
// agent matched, and the OTHER TWO were missing, which the message does not say.
//
// The check exists because a broker that lost a keeper's port will guess one and command
// whoever answers; the pid is the part that makes a guess fail. So this passes the identity
// the keeper reported about ITSELF, never one computed here.
async function keeperAct(k, action, args = {}, timeoutMs = 20_000) {
  const r = await fetch(`http://127.0.0.1:${k.port}/action`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-m59-agent': k.agent,
      'x-m59-character': k.character,
      'x-m59-keeper-pid': String(k.pid),
    },
    // `name` and `args`, NOT `action` plus inline fields. The keeper reads `ask.name` and
    // `ask.args` (m59-keeper-process.mjs:1398), and anything else arrives as
    // `unknown action: ` with an empty name — which says nothing about which key was wrong.
    body: JSON.stringify({ agent: k.agent, character: k.character, keeper_pid: k.pid,
                           name: action, args }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return await r.json().catch(() => ({}));
}

const pct = v => (v?.max > 0 ? v.value / v.max : null);

// A SLOW KEEPER IS NOT A MISSING CHARACTER.
//
// A keeper mid-fight answers `keeper state refresh failed; cached snapshot is 4778ms old`
// or simply times out, and the first version of this treated either as fatal. Beaker is a
// farming character being pulled off a fight, so that is the NORMAL state at the moment the
// loop starts, not an exception. Two tries with a longer window, and only then give up.
async function read(agent, tries = 2) {
  let s = null;
  for (let i = 0; i < tries; i++) {
    s = await call('status', { agent }, 45_000).catch(e => ({ _err: e.message }));
    if (!s?._err) break;
    if (i + 1 < tries) await new Promise(r => setTimeout(r, 3000));
  }
  if (s?._err) return { ok: false, why: s._err };
  return {
    ok: true,
    room: Number(s?.where?.num ?? NaN),
    roomName: s?.where?.name ?? '',
    health: pct(s?.vitals?.health), hp: s?.vitals?.health,
    mana: s?.vitals?.mana, karma: s?.karma?.value ?? null,
    spells: (s?.spells ?? []).map(x => String(x.name ?? x).toLowerCase()),
    busy: String(s?.job?.busy ?? ''),
  };
}

// THE INVENTORY TOOL RETURNS TWO DIFFERENT SHAPES AND BOTH ARE REAL.
//
// A keeper-backed character answers `{items: [...]}`; one the broker holds directly answers
// a BARE ARRAY. Reading only `.items` gave `herbs 0  emerald 0` for a character standing
// there with 249 herbs and 178 emeralds — and because the loop stops when it runs out of
// reagents, that reads as "supply exhausted" rather than "I looked in the wrong place".
//
// Third time tonight: `status.hp` vs `status.vitals.health`, `where.room_id` vs
// `where.num`, and now this. The rule this repository keeps re-learning is that a field's
// ABSENCE means "ask somewhere else", never "the answer is zero".
async function packOf(agent) {
  const inv = await call('inventory', { agent }, 30_000).catch(() => null);
  if (Array.isArray(inv)) return inv;
  if (Array.isArray(inv?.items)) return inv.items;
  if (Array.isArray(inv?.inventory)) return inv.inventory;
  return [];
}
const countOf = (items, rx) => items.filter(i => rx.test(i.name || ''))
  .reduce((n, i) => n + (i.amount || 1), 0);

// WHICH HEAL TO CAST. Cheapest that fits the situation and the mana, because the pool is
// the rate limiter and a wasted 10-mana cast is three minor heals that did not happen.
// PRACTISE AT THE HIGHEST LEVEL YOU KNOW, NOT THE CHEAPEST SPELL YOU HAVE.
//
// This is the thing that decides whether the loop is worth running at all, and the obvious
// version gets it backwards. `PlayerCanLearn` gates a level-N spell on the combined ability
// percentage of the best THREE abilities at level N-1 — so what unlocks hospice (level 3) is
// practice of LEVEL 2 spells. Loial measured at need 101, have 60: forty-one points short,
// with karma already past its gate at 32/30.
//
// Minor heal is level 1. Casting it is nearly free and raises an ability that no longer
// gates anything — an hour of it moves the karma and leaves the ladder exactly where it was.
// So the list is ordered by LEVEL DESCENDING, and the cheapest-that-fits rule applies only
// among spells of the same level.
//
// Reagent costs are per cast and he is carrying 178 emeralds and 250 herbs, so the binding
// constraint is mana (25) and not supply: two level-2 casts per pool, then a rest.
const HEALS = [
  // level 2 — what actually unlocks hospice and rescue
  { name: 'holy touch', level: 2, mana: 12, reagent: /emerald/i, need: 2 },
  // level 3, once he has it: practising THIS is what unlocks forces of light
  { name: 'hospice', level: 3, mana: 10, reagent: /herb/i, need: 3 },
  // level 1 — the fallback, and only when nothing better is affordable
  { name: 'minor heal', level: 1, mana: 3, reagent: /herb/i, need: 1 },
].sort((x, y) => y.level - x.level);
const CURE = { name: 'remove curse', level: 2, mana: 9, reagent: /emerald/i, need: 1 };

function chooseSpell({ healer, patientCursed, pack }) {
  const mana = healer.mana?.value ?? 0;
  // REMOVE CURSE IS THE CURSE MODE'S SPELL, NOT THE HEAL MODE'S.
  //
  // Offering it in heal mode deadlocks the loop and looks like it is working: the amulet
  // goes on, the patient is cursed, remove curse strips it, the amulet goes on again — and
  // the patient never takes a single point of damage, so the heal being practised is never
  // castable. Eight rounds of "ok" and zero hospice. The two modes want opposite things
  // from the same amulet: curse mode wants him wearing it, heal mode wants him pulling
  // at it.
  if (MODE === 'curse' && patientCursed && healer.spells.includes('remove curse') &&
      mana >= CURE.mana && countOf(pack, CURE.reagent) >= CURE.need) return CURE;
  const hurt = (healer.patientHealth ?? 1) < 1;
  if (!hurt) return null;
  // HEALS is level-descending, so the first affordable entry is the most useful practice
  // rather than the cheapest cast.
  for (const h of HEALS) {
    if (!healer.spells.includes(h.name)) continue;
    if (mana < h.mana) continue;
    if (countOf(pack, h.reagent) < h.need) continue;
    return h;
  }
  return null;
}

// ------------------------------------------------------------------ preflight

const healer0 = await read(HEALER);
const patient0 = await read(PATIENT);
if (!healer0.ok) die(`healer ${HEALER}: ${healer0.why}`);
if (!patient0.ok) die(`patient ${PATIENT}: ${patient0.why}`);

const pack0 = await packOf(HEALER);
const ppack0 = await packOf(PATIENT);
const amulet = ppack0.find(i => CURSED.test(i.name || ''));

console.log(`healer   ${HEALER}  room ${healer0.room} ${healer0.roomName}`);
console.log(`         karma ${healer0.karma}  mana ${healer0.mana?.value}/${healer0.mana?.max}  hp ${healer0.hp?.value}/${healer0.hp?.max}`);
console.log(`         spells: ${healer0.spells.join(', ')}`);
console.log(`         herbs ${countOf(pack0, /herb/i)}  emerald ${countOf(pack0, /emerald/i)}`);
console.log(`patient  ${PATIENT}  room ${patient0.room} ${patient0.roomName}`);
console.log(`         karma ${patient0.karma}  hp ${patient0.hp?.value}/${patient0.hp?.max}`);
console.log(`         amulet: ${amulet ? `#${amulet.id} ${amulet.name}` : 'NOT IN HIS PACK'}`);
console.log(`floors   patient never takes a hit below ${Math.round(FLOOR * 100)}%; run aborts below ${Math.round(ABORT * 100)}%`);

const problems = [];
if (!amulet) problems.push(`${PATIENT} is not carrying an Amulet of Shadows — the loop has no engine`);
if (!healer0.spells.some(s => HEALS.some(h => h.name === s) || s === CURE.name))
  problems.push(`${HEALER} knows none of: ${[...HEALS.map(h => h.name), CURE.name].join(', ')}`);
// BRINGING THEM TOGETHER IS PART OF THE JOB, not a precondition to complain about. Without
// --gather the run still refuses, because walking two characters across a live server is a
// thing the caller should have to ask for rather than get by surprise.
const GATHER = has('gather');
if (!GATHER) {
  if (ROOM && healer0.room !== ROOM) problems.push(`${HEALER} is in ${healer0.room}, not ${ROOM} (pass --gather to walk them)`);
  if (ROOM && patient0.room !== ROOM) problems.push(`${PATIENT} is in ${patient0.room}, not ${ROOM} (pass --gather to walk them)`);
  if (healer0.room !== patient0.room)
    problems.push(`they are in different rooms (${healer0.room} vs ${patient0.room}) — a heal needs the same room`);
}
if ((patient0.karma ?? 0) < 30)
  problems.push(`${PATIENT} karma is ${patient0.karma}; healing a LOW-karma character is not the pump`);
for (const p of problems) console.log(`  ! ${p}`);

if (problems.length) die('\nrefusing: fix the above.', 2);
if (!APPLY) { console.log('\n(plan only — pass --apply to run it)'); process.exit(0); }

// ------------------------------------------------------------------ hold the patient

const kport = await findKeeper(PATIENT);
// The healer needs one too, only so he can be told to STAND before a cast.
const healerKeeper = await findKeeper(HEALER);
if (!kport) die(`no keeper answered for ${PATIENT} — the amulet is toggled through its keeper`);
console.log(`\npatient keeper on ${kport.port} (pid ${kport.pid}, ${kport.character})`);

const health = await (await fetch(`${BROKER}health`)).json();
const owner = `karmapump:${process.pid}`;
let lease = null;
async function claim() {
  const out = await call('commander_lease', {
    action: 'acquire', fleet: health.fleet, broker_pid: health.pid,
    server_host: (await read(PATIENT)).host ?? '76.214.42.186', server_port: 5959,
    agents: [{ agent: PATIENT, character: 'Beaker' }], owner, lease_ms: 30_000,
  }, 30_000).catch(e => ({ error: e.message }));
  // `lease_id` is what commander_lease actually returns; the other two spellings are
  // what it looked like it should return. Measured, not assumed.
  lease = out?.lease_id ?? out?.lease_token ?? out?.token ?? null;
  return out;
}
async function heartbeat() {
  if (!lease) return;
  await call('commander_lease', { action: 'heartbeat', fleet: health.fleet, broker_pid: health.pid,
    server_host: '76.214.42.186', server_port: 5959, lease_token: lease, owner, lease_ms: 30_000 }, 20_000)
    .catch(() => { lease = null; });
}
async function release() {
  if (!lease) return;
  await call('commander_lease', { action: 'release', fleet: health.fleet, broker_pid: health.pid,
    server_host: '76.214.42.186', server_port: 5959, lease_token: lease, owner }, 20_000).catch(() => {});
  lease = null;
}

const claimed = await claim();
console.log(`lease    ${lease ? 'held' : 'NOT HELD — ' + JSON.stringify(claimed).slice(0, 160)}`);
if (!lease)
  console.log('  WARNING: without a lease the DUM bot re-decides him in about 30s and he walks back to farming.');

// ---------------------------------------------------------------- gather

if (GATHER && ROOM) {
  console.log(`gathering both into room ${ROOM}`);
  const sent = new Set();
  for (let i = 0; i < 60; i++) {
    if (i % 3 === 0) await heartbeat();
    const h2 = await read(HEALER), p2 = await read(PATIENT);
    if (h2.room === ROOM && p2.room === ROOM) { console.log('  both there'); break; }
    for (const [ag, st] of [[HEALER, h2], [PATIENT, p2]]) {
      if (st.room === ROOM) { sent.delete(ag); continue; }
      // TRAVEL IS ISSUED ONCE. Re-issuing into a journey already running is one of the
      // three silent failures that broke m59-outfit.mjs; a journey takes minutes and this
      // loop ticks in seconds.
      if (sent.has(ag)) continue;
      await call('travel', { agent: ag, to: ROOM, background: true }, 25_000).catch(() => {});
      sent.add(ag);
      console.log(`  ${ag}: walking from ${st.room} to ${ROOM}`);
    }
    await new Promise(r => setTimeout(r, 15_000));
  }
  const h3 = await read(HEALER), p3 = await read(PATIENT);
  if (h3.room !== p3.room) {
    console.log(`could not get them together (${h3.room} vs ${p3.room}) — not starting the loop`);
    await release(); process.exit(1);
  }
  console.log(`both in room ${h3.room} ${h3.roomName}`);
}

let stop = false;
const finish = async (why) => {
  if (stop) return; stop = true;
  console.log(`\nstopping: ${why}`);
  await release();
  console.log('lease released — he goes back to farming.');
  process.exit(0);
};
process.on('SIGINT', () => { finish('interrupted').catch(() => process.exit(1)); });

// ------------------------------------------------------------------ the loop

let casts = 0, hits = 0, hb = 0, misses = 0, landed = 0, apartFor = 0;
const startKarma = healer0.karma;

for (let round = 1; !stop && casts < MAX_CASTS; round++) {
  if (++hb % 3 === 0) await heartbeat();

  const h = await read(HEALER);
  const p = await read(PATIENT);
  if (!h.ok || !p.ok) {
    // Tolerate a bad read; give up only if it keeps happening. A keeper that is briefly
    // unreadable is the ordinary state of a character being pulled off a fight.
    misses++;
    console.log(`[${round}] unreadable (${misses}/5): ${h.why ?? p.why}`);
    if (misses >= 5) { await finish('five consecutive unreadable rounds'); break; }
    await new Promise(r2 => setTimeout(r2, EVERY_MS));
    continue;
  }
  misses = 0;

  // Every twentieth round: cheap enough to be invisible against a loop that rests between
  // casts, frequent enough that the gate is never crossed by more than a minute.
  if (STOP_WHEN && round % 20 === 0) {
    const g = await learnable(STOP_WHEN);
    if (g.known) {
      console.log(`    gate ${STOP_WHEN}: have ${g.have}/${g.need}, gap ${g.gap}`);
      if (g.can) { await finish(`${STOP_WHEN} IS NOW LEARNABLE — buy it before grinding further`); break; }
    }
  }
  if (UNTIL_KARMA && (h.karma ?? 0) >= UNTIL_KARMA)
    { await finish(`healer reached karma ${h.karma} (target ${UNTIL_KARMA})`); break; }
  if (p.health != null && p.health < ABORT)
    { await finish(`PATIENT AT ${Math.round(p.health * 100)}% — below the abort floor`); break; }
  // A ROOM MISMATCH IS A THING TO FIX, NOT A REASON TO STOP.
  //
  // This ended the run the moment the two were apart, and it fired on a character that was
  // ALREADY WALKING BACK on its own — `last_action: "walk to The Limping Toad Inn", ok:
  // true`. Twenty-three hospice casts in, at 4am, because something nudged Loial out of the
  // inn for six minutes. An overnight loop has to survive that: the fleet is shared, other
  // drivers exist, and a character being briefly elsewhere is the ordinary weather here.
  //
  // So: say it, walk him back if nothing already is, and carry on. Only give up if they
  // stay apart — `apartFor` counts consecutive rounds, and twenty of them (about two
  // minutes) means something is holding them apart rather than a journey in flight.
  if (h.room !== p.room) {
    apartFor++;
    const busy = /^walk to /i.test(h.busy);
    if (apartFor >= 20) { await finish(`apart for ${apartFor} rounds (${h.room} vs ${p.room})`); break; }
    if (!busy && apartFor % 5 === 1) {
      await call('travel', { agent: HEALER, to: ROOM ?? p.room, background: true }, 25_000).catch(() => {});
      console.log(`[${round}] apart (${h.room} vs ${p.room}) — walking the healer back`);
    } else {
      console.log(`[${round}] apart (${h.room} vs ${p.room}), round ${apartFor}/20 — waiting`);
    }
    await new Promise(r2 => setTimeout(r2, EVERY_MS));
    continue;
  }
  apartFor = 0;

  const hpack = await packOf(HEALER);
  const ppack = await packOf(PATIENT);
  const am = ppack.find(i => CURSED.test(i.name || ''));
  const wearing = (await call('equipment', { agent: PATIENT }, 20_000).catch(() => null))
    ?.equipped?.some(e => CURSED.test(e.name || '')) ?? false;

  // 1. HEAL FIRST, ALWAYS. The patient is only allowed to hurt himself when there is
  //    nothing left to put right — so a round can never end with him damaged and the
  //    healer idle, which is the state that turns into a death.
  const spell = chooseSpell({
    healer: { ...h, patientHealth: p.health, spells: h.spells },
    patientCursed: wearing, pack: hpack,
  });
  if (spell) {
    // TARGET BY CHARACTER NAME, NOT AGENT HANDLE. `cast` resolves a target against what is
    // in the room, and the room contains "Beaker" — never "t6". Passing the agent gave
    // `nothing here matches "t6"`, which is the same identifier confusion m59-agent-name.mjs
    // exists for, one layer out: the fleet page prints both and only one is a thing that
    // exists in the world.
    // STAND UP FIRST. `rest_up` SITS HIM DOWN, and a seated character cannot cast - the
    // keeper's own equip handler stands before using an item for exactly this reason. This
    // loop rests whenever it runs dry, so from the first rest onward every cast was a
    // silent no-op: `cast: true`, no error, and `mana_spent: 0`.
    if (healerKeeper) await keeperAct(healerKeeper, 'stand').catch(() => {});
    // CAST THROUGH THE KEEPER, NOT THE BROKER TOOL.
    //
    // For a keeper-backed character the broker holds a SNAPSHOT rather than a live client,
    // so its `cast` reports `cast: true` and sends nothing — and computes `mana_spent` by
    // diffing two reads of the same stale snapshot, which is why it also says 0. The keeper
    // owns the socket, so the keeper is what can actually cast.
    //
    // Verified 2026-09-09: identical call, broker path 140 emeralds -> 140, keeper path
    // 140 -> 139.
    const r = healerKeeper
      ? await keeperAct(healerKeeper, 'cast', { spell: spell.name, target: kport.character }, 40_000)
          .catch(e => ({ error: e.message }))
      : await call('cast', { agent: HEALER, spell: spell.name, target: kport.character }, 40_000)
          .catch(e => ({ error: e.message }));
    casts++;
    // A CAST THAT SPENT NO MANA DID NOT HAPPEN. The broker says so in the reply and I was
    // not reading it: `what_the_mana_says` is "NOTHING was spent - the cast did not happen
    // at all". Counting those as successes is how a loop reports three hundred casts and
    // moves an ability by nothing.
    // THE KEEPER'S REPLY CARRIES NO mana_spent, so success is measured the way it was
    // proved: by the REAGENT LEAVING THE PACK. That is the harder evidence anyway — it is
    // what settled whether any of this was working at all.
    // WHAT COUNTS AS A REAL CAST, measured rather than asserted — but measured on the right
    // thing. The keeper's reply carries no `mana_spent`, and diffing the pack immediately
    // after the send races the server's own update, so both of those report a false NO-OP on
    // a cast that plainly worked (mana falling 21 -> 18 -> 15 and the ability climbing while
    // the log said nothing happened).
    //
    // The keeper echoes `targets`, and a non-empty target list with no error means the
    // packet went out with everything the server needs. The HARD evidence stays the gate
    // poll every twentieth round, which reads the ability itself — so this line is a
    // progress report and that one is the proof.
    const spent = Number(r?.mana_spent ?? 0);
    const aimed = Array.isArray(r?.targets) ? r.targets.length : 0;
    const real = !r?.error && (spent > 0 || aimed > 0);
    if (real) landed++;
    console.log(`[${round}] cast ${spell.name} -> ` +
      (r?.error ? 'FAILED ' + String(r.error).slice(0, 70)
        : real ? `ok (aimed at ${aimed} target)`
        : `NO-OP, 0 mana - ${String(r?.what_the_mana_says ?? '').slice(0, 60)}`) +
      `  (patient ${p.hp?.value}/${p.hp?.max}, healer mana ${h.mana?.value}, karma ${h.karma})`);
    await new Promise(r2 => setTimeout(r2, EVERY_MS));
    continue;
  }

  // 2. NOTHING TO HEAL. Either he is whole, or we cannot answer — and those are different.
  const mana = h.mana?.value ?? 0;
  // THE CHEAPEST SPELL THAT IS ANY USE RIGHT NOW, not the cheapest one he knows.
  //
  // With the patient CURSED the only spell that does anything is remove curse (9). Comparing
  // against the global cheapest (minor heal, 3) left him sitting at 5 mana "not dry" and
  // unable to act, waiting for natural regeneration instead of resting for it — a stall that
  // reads as working, on a loop meant to run for hours.
  const usable = wearing
    ? [CURE]
    : HEALS.filter(x => h.spells.includes(x.name));
  const cheapest = usable.length ? Math.min(...usable.map(x => x.mana)) : CURE.mana;
  if (mana < cheapest) {
    console.log(`[${round}] healer is dry (${mana} mana) — resting, patient holds at ${p.hp?.value}/${p.hp?.max}`);
    await call('rest_up', { agent: HEALER }, 60_000).catch(() => {});
    await new Promise(r2 => setTimeout(r2, EVERY_MS));
    continue;
  }
  if (countOf(hpack, /herb/i) < 1 && countOf(hpack, /emerald/i) < 1)
    { await finish('healer is out of both herbs and emeralds'); break; }

  // 3. ONLY NOW does the patient take a hit, and only above the floor.
  if (p.health != null && p.health < FLOOR) {
    console.log(`[${round}] patient at ${Math.round(p.health * 100)}% — under the floor, waiting rather than hitting him again`);
    await new Promise(r2 => setTimeout(r2, EVERY_MS));
    continue;
  }
  if (!am) { await finish('the amulet left the patient’s pack'); break; }

  // IN CURSE MODE THE AMULET ONLY EVER GOES ON. Taking it off is what does the damage,
  // and this mode has no reason to accept that risk: a cursed patient is already a
  // castable target for remove curse.
  if (MODE === 'curse' && wearing) {
    console.log(`[${round}] patient is cursed and the healer cannot cast — waiting rather than hurting him`);
    await new Promise(r2 => setTimeout(r2, EVERY_MS));
    continue;
  }
  const act = wearing ? 'unuse' : 'equip';
  const r = await keeperAct(kport, act, { id: am.id });
  hits++;
  console.log(`[${round}] patient ${act === 'equip' ? 'puts the amulet ON' : 'tries to take it OFF'}` +
    ` -> ${r?.error ? 'FAILED ' + String(r.error).slice(0, 60) : (r?.serverSaid ?? 'sent')}`);
  await new Promise(r2 => setTimeout(r2, EVERY_MS));
}

const end = await read(HEALER);
console.log(`\n${casts} cast(s), ${hits} amulet toggle(s). karma ${startKarma} -> ${end.karma}`);
await finish(casts >= MAX_CASTS ? `reached --max-casts ${MAX_CASTS}` : 'done');
