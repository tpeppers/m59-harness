#!/usr/bin/env node
// MOVE REAGENTS FROM THE RICH TO THE STARVING, THEN TURN THEM INTO VIGOR.
// AND MOVE SIGNET RINGS DOWNWARD, WHICH IS WORTH TEN TIMES MORE THAN ANY OF IT.
//
//   node tools/m59-almoner.mjs --dry-run
//   node tools/m59-almoner.mjs                    # hand out and set the vigor floor
//   node tools/m59-almoner.mjs --amount 10        # per reagent kind, default 10
//   node tools/m59-almoner.mjs --floor 140        # vigor to fight above afterwards
//   node tools/m59-almoner.mjs --max-hops 2       # locality cap for reagent handovers
//   node tools/m59-almoner.mjs --max-deliveries 2 # per donor in one pass
//   node tools/m59-almoner.mjs --signets-only     # just the rings
//   node tools/m59-almoner.mjs --no-signets       # just the reagents, as it used to be
//
// THE RINGS COME FIRST AND THEY ARE NOT A SIDE ERRAND. A signet ring pays its value TEN
// TIMES OVER to a character the server considers a newbie, and plain value to everyone
// else — and "newbie" is not a choice anybody here made: EvaluatePKStatus enables
// player-killing for you the moment base max health reaches 30 (player.kod:11047). Max
// health is the level here. So the same ring is worth up to 1500 shillings in the hands
// of a level-24 character and up to 150 in the hands of a level-31 one, and which of them
// is holding it is decided by whichever happened to loot it.
//
// That is exactly the almoner's job. The fleet's small characters are the ones with no
// money, no food and no floor under them, and this is the one mechanism in the game that
// pays them ten times what it pays anyone else. Redistributing rings downward and then
// sending them to be cashed is the single largest transfer available to this tool — one
// ring is worth more than every elderberry it will ever move — so it runs FIRST and it
// runs even on the passes where there is no reagent work to do.
//
// WHY THIS IS THE HIGHEST-VALUE ERRAND AVAILABLE. The fleet's food supply is not
// bought, it is CAST: `create food` turns 2 ElderBerry and 2 Herbs into a meal, and
// both drop free in the rooms these characters already hunt. A character with no
// reagents cannot cast, so it cannot eat; resting alone tops out at 80 vigor of 200,
// and everything above 80 has to come from food. So an empty pack is not a small
// inconvenience — it caps a character at the resting floor for ever.
//
// And vigor is not a comfort stat. It sets the HEALTH REGENERATION RATE:
// ((200-vigor)^2/6 + 1000) ms a point, which is 1.0 hp/s at 200 and 0.29 hp/s at 80.
// A character stuck at 80 recovers three and a half times slower than one at 200,
// between every fight, for ever. That is most of the difference between a fleet that
// grinds upward and one that dies in the same room all night.
//
// The distribution in this fleet was extreme when this was written: three characters
// held 329 ElderBerry and 670 Herbs between them, while seven had none at all — and
// every one of the seven was standing in the two rooms where the fleet was dying.
// Nothing was wrong with any of them individually. Nothing was moving the surplus.
//
// It does NOT do the trade itself: `supply` already drives both ends of a two-sided
// protocol between characters this broker holds, and verifies the receiver actually
// ended up with the goods. A half-finished trade is silent, which is exactly why that
// tool exists and why this one calls it rather than reimplementing it.
import { findPath, loadMap } from './m59-map.mjs';
import { takeRunLock } from './m59-runlock.mjs';
import { fleetName } from './m59-fleetpath.mjs';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const PORT = Number(arg('port', 8901));
const RPC = `http://127.0.0.1:${PORT}/`;
const DRY = !!arg('dry-run', false);
const AMOUNT = Number(arg('amount', 10));
const FLOOR = Number(arg('floor', 140));
// A meal is not worth turning the best farmer into a global courier. Piggy's three-hour
// travel outlier included one pass that assigned her five recipients across Castle
// Victoria, Tos and Marion. Keep this the local redistribution layer; the keeper's
// farm-delivery strategy already moves stock opportunistically within two rooms.
const MAX_HOPS = Math.max(0, Number(arg('max-hops', 2)) || 0);
const MAX_DELIVERIES = Math.max(1, Number(arg('max-deliveries', 2)) || 2);
const WORLD_MAP = loadMap();
export const deliveryHops = (from, to, map = WORLD_MAP) => {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return Infinity;
  const route = findPath(map, from, to);
  return route.found ? route.hops.length : Infinity;
};
// Keep the giver able to feed itself: handing away the last of it just moves the
// problem. One casting is 2 of each, so this is several meals of margin.
const KEEP_BACK = Number(arg('keep', 20));

let id = 0;
async function call(name, args = {}) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
                           params: { name, arguments: args } }) });
  const j = await r.json();
  if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
  const t = j.result?.content?.[0]?.text;
  if (j.result?.isError) throw new Error(`${name}: ${t}`);
  try { return JSON.parse(t); } catch { return t; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const countOf = (items, re) => (items || []).filter(i => re.test(i.name || ''))
                                            .reduce((t, i) => t + (i.amount || 1), 0);

// `fleet` throws "Cannot read properties of null (reading 'inventory')" while a
// character is between logging out and being rejoined — the session exists and its
// client does not. It is transient and clears within a rejoin cycle, but it takes the
// whole call down with it, so a run that happens to start during one gets nothing.
// (It also killed a supervisor round. Worth fixing in the fleet tool itself; retried
// here so this errand does not depend on that.)
const LOCK_FLEET = fleetName();
const FORCE = process.argv.includes('--force');

// ONE THING DRIVING THE FLEET AT A TIME, AND SAY WHO HAS IT.
//
// The almoner walks givers to receivers, so it collides with anything else moving the same
// characters. Two runs do not halve the work, they fight for the bodies: each re-issues
// travel at a character the other is already walking, and every collision lands in the
// transit book as "movement cancelled by a newer command" - the same sentence a genuine
// survival interrupt produces, which is what makes it expensive to diagnose.
//
// Measured here 2026-09-02: a supply run covering t17,t12,t8 was still alive ninety minutes
// after it started, having delivered nothing, when a second run covering t3,t17,t6 was
// launched over the top of it. Zoot was in both. Earlier the same day three runs were live
// at once because a kill had silently failed and nobody checked.
//
// FLEET-WIDE RATHER THAN PER-AGENT, deliberately: this tool is fleet-scoped by nature, and
// 'these two name different characters' is not 'these two cannot collide' - the roads and
// the counters are shared. m59-runlock already makes exactly this argument and corroborates
// a pid against its start time, so a dead holder is taken over rather than refused forever.
const runClaim = takeRunLock(LOCK_FLEET, {
  label: `almoner, amount ${AMOUNT} keep ${KEEP_BACK} floor ${FLOOR}`, force: FORCE });
if (!runClaim.ok) {
  const h = runClaim.holder ?? {};
  console.error(`REFUSING - fleet "${LOCK_FLEET}" is already being driven by another run.`);
  console.error(`  pid    ${h.pid ?? '?'}`);
  console.error(`  what   ${h.label ?? '?'}`);
  console.error(`  since  ${h.at ? new Date(h.at).toISOString() : '?'}` +
                (h.at ? `  (${Math.round((Date.now() - h.at) / 1000)}s ago)` : ''));
  console.error(`  argv   ${h.argv ?? '?'}`);
  console.error('');
  console.error('Wait for it, stop that pid, or re-run with --force if you know it is dead.');
  process.exit(3);
}
if (runClaim.tookOverFrom)
  console.error(`note: took over a stale lock - ${runClaim.tookOverFrom.why}`);

let f = null;
for (let i = 0; i < 4 && !f; i++) {
  f = await call('fleet', {}).catch(async (e) => {
    if (i === 3) throw e;
    console.log(`  fleet unreadable (${String(e.message).slice(0, 60)}) — retrying`);
    await sleep(4000);
    return null;
  });
}
// A HANDOVER HOLDS BOTH ENDS INERT, AND AN INERT KEEPER CANNOT FLEE OR REST.
//
// This filtered on `in_game` alone, so a character was eligible for an exchange at any
// health at all. Measured on prod the morning this was added: Fozzie was held inert for a
// supply exchange at 4 of 52 in a battered-skeleton room and Piggy at 3 of 49, and both
// were still LOSING health while held — Piggy went 9 -> 3 -> 1 before an operator took it
// back and rested it to 31. Nothing was wrong with the exchange; it simply has no opinion
// about whether the character can afford to stand still for it.
//
// Survival decides at one second and belongs to this repository, always — a reagent
// delivery is minutes of work that can wait for the next round, and the next round is
// sixty seconds away. So anyone under half health sits this one out, on both ends: a
// donor because it has to walk, and a recipient because it is held just the same.
//
// Deliberately NOT the keeper's flee threshold (0.35). That one asks "should I run from
// this fight"; this asks "can I afford to be unable to run at all", and the honest answer
// is a wider margin — the whole point is that the character has no way to react while the
// exchange is in flight.
const HURT_BELOW = Number(arg('hurt-below', 0.5));
const pctOf = (r) => {
  const m = /^(\d+)\s*\/\s*(\d+)/.exec(String(r.health ?? ''));
  return m ? Number(m[1]) / Number(m[2]) : null;
};
const inGame = (f.fleet || []).filter(x => x.in_game !== false);
const hurt = inGame.filter(x => { const p = pctOf(x); return p !== null && p < HURT_BELOW; });
const live = inGame.filter(x => !hurt.includes(x));
if (hurt.length)
  console.log(`  ${hurt.length} sitting this round out below ${Math.round(HURT_BELOW * 100)}% health ` +
              `(a handover holds them inert, and an inert keeper cannot flee): ` +
              hurt.map(h => `${h.character} ${h.health}`).join(', '));

// ------------------------------------------------------------------ the rings, first
//
// Three steps and each is refused cleanly when it has nothing to do, so this costs a
// single survey call on the passes — most of them — where the fleet is carrying none.
if (!arg('no-signets', false)) {
  const survey = await call('signets', { action: 'survey' }).catch(e => ({ __err: e.message }));
  if (survey.__err) {
    // A broker predating the signets tool answers "no such tool", and that must not take
    // the reagent run down with it — this errand has been the fleet's food supply for
    // months and the rings are the new part.
    console.log(`signets: ${survey.__err}`);
  } else if (!survey.rings) {
    console.log('signet rings: none in the fleet');
  } else {
    console.log(`signet rings: ${survey.rings} carried, ${survey.in_the_wrong_hands} in hands that ` +
                `would be paid a tenth`);
    for (const cr of survey.carriers)
      console.log(`  ${cr.character} (${cr.level}, ${cr.paid}) ` +
                  cr.holding.map(h => `${h.owner} -> ${h.go_to}`).join('; ') +
                  (cr.committed ? `  [busy: ${cr.committed}]` : ''));
    if (DRY) console.log('  dry run — no rings moved and nobody dispatched');
    else {
      if (survey.in_the_wrong_hands) {
        const moved = await call('signets', { action: 'redistribute' })
                            .catch(e => ({ moved: 0, __err: e.message }));
        console.log(`  redistributed ${moved.moved ?? 0}` +
                    (moved.__err ? ` (${moved.__err})` : ''));
        for (const m of moved.moved_detail ?? []) console.log(`    ${m}`);
        for (const m of moved.failed ?? []) console.log(`    could not: ${m}`);
      }
      const sent = await call('signets', { action: 'return' })
                        .catch(e => ({ dispatched: 0, __err: e.message }));
      console.log(`  dispatched ${sent.dispatched ?? 0} return errand(s)` +
                  (sent.__err ? ` (${sent.__err})` : ''));
      for (const e of sent.errands ?? [])
        console.log(`    ${e.carrier} -> ${e.to} at ${e.where} (${e.town}), paid ${e.paid}`);
      for (const s of sent.skipped ?? []) console.log(`    skipped: ${s}`);
    }
  }
  console.log('');
}
if (arg('signets-only', false)) process.exit(0);

// ------------------------------------------------------------------ then the reagents

const held = [];
for (const r of live) {
  const inv = await call('inventory', { agent: r.agent }).catch(() => ({ items: [] }));
  held.push({ agent: r.agent, character: r.character, room: r.room_num, level: r.level,
              has_food: r.has_food,
              eb: countOf(inv.items, /elder\s?berry/i), hb: countOf(inv.items, /^herbs?$/i) });
}

// A recipient is someone who cannot cast their way out: no food AND not enough
// reagents to make any. Having no food but a full pack is not a problem, it is a
// character that has not got round to cooking yet.
const CASTABLE = 2;
const needy = held.filter(h => !h.has_food && (h.eb < CASTABLE || h.hb < CASTABLE))
                  .sort((a, b) => (a.eb + a.hb) - (b.eb + b.hb));
// A DONOR IS A DONOR OF ONE REAGENT, NOT OF BOTH — AND REQUIRING BOTH MEANT NOBODY WAS.
//
// This used to ask for a full share of elderberry AND herbs from the same character. That
// reads as prudence and is actually the bug: what the fleet holds is not a shortage of
// reagents, it is a SEGREGATION of them. Measured across twenty-one characters: 374
// elderberries and 499 herbs in the packs — 187 castings' worth — and eleven characters
// held only elderberry, nine only herbs, one both. So the both-hands test found zero
// donors and this printed "the fleet is genuinely short" while standing on the surplus.
//
// Nothing about the hand-over needs one character to carry both. Two deliveries from two
// donors leave the recipient exactly as able to cast as one delivery would, and a fleet
// that splits its reagents by where it hunts will always look like this.
// AND THE KEEP-BACK HAS TO BE PAIRABLE, FOR EXACTLY THE SAME REASON.
//
// The comment above fixed "a donor must hold both halves". The identical mistake was
// still one level down in the threshold: `AMOUNT + KEEP_BACK` is a FLAT 20 per reagent,
// and a reagent you cannot pair buys you nothing. Measured the morning this was found —
// every one of twenty-one characters unable to cast, and the tool printing "nobody has a
// surplus, the fleet is genuinely short" over it:
//
//   Statler   1 elderberry, 26 herbs   ->  0 castings, withholding 20 herbs
//   Sweetums  1 elderberry, 23 herbs   ->  0 castings, withholding 20 herbs
//   Piggy    15 elderberry,  1 herb    ->  0 castings, withholding 15 elderberry
//
// A character's own castings are bounded by min(eb, hb), so what it can USE of one half is
// capped by how much it holds of the other. Everything above that is dead weight it is
// guarding from a fleet that cannot cook. So the keep-back is capped by the pair.
//
// The honest counter-argument is that a character might loot the missing half later and
// want the buffer back. Under the prey this fleet actually farms it will not — skeleton,
// battered skeleton and zombie drop NEITHER half (see m59-reagents.mjs) — and the almoner
// runs every supervisor round, so herbs can move back the moment elderberry appears.
// Guarding against a drop that cannot happen, at the cost of a fleet pinned at the resting
// cap, is the wrong side of that trade.
const KINDS = [{ kind: 'elderberry', field: 'eb', pair: 'hb' },
               { kind: 'herbs',      field: 'hb', pair: 'eb' }];
const keepFor = (h, k) => Math.min(KEEP_BACK, h[k.pair] ?? 0);
const donorsOf = k => held.filter(h => h[k.field] >= AMOUNT + keepFor(h, k))
                          .sort((a, b) => b[k.field] - a[k.field]);
const pool = new Map(KINDS.map(k => [k.kind, donorsOf(k)]));
const anyDonor = [...new Set([...pool.values()].flat())];

console.log(`${needy.length} character(s) cannot cast create food; ` +
  KINDS.map(k => `${pool.get(k.kind).length} can spare ${k.kind}`).join(', '));
if (!needy.length) { console.log('nothing to do'); process.exit(0); }
if (!anyDonor.length) { console.log('nobody has a surplus — the fleet is genuinely short'); process.exit(0); }

// Give each donor a fair number of recipients rather than draining the richest one,
// and PREFER A DONOR ALREADY IN THE RECIPIENT'S ROOM — the giver travels, and a walk
// across the world through monster rooms is the expensive and failure-prone part of
// this. Somebody standing next to the person who needs it should be the one to give.
// Capacity is counted per reagent, because that is now what a share is.
const capacity = new Map();
for (const k of KINDS)
  for (const d of pool.get(k.kind))
    // Same pairable keep-back the donor test uses. A flat KEEP_BACK here would let a
    // character qualify as a donor and then be credited with zero shares to give.
    capacity.set(`${d.agent}/${k.kind}`,
                 Math.max(1, Math.floor((d[k.field] - keepFor(d, k)) / AMOUNT)));
const cap = (d, kind) => capacity.get(`${d.agent}/${kind}`) || 0;
const deliveries = new Map();
const tripsBy = donor => deliveries.get(donor.agent) || 0;
const canDeliver = (donor, recipient, kinds) => donor.agent !== recipient.agent &&
  tripsBy(donor) < MAX_DELIVERIES && kinds.every(kind => cap(donor, kind) > 0) &&
  deliveryHops(donor.room, recipient.room) <= MAX_HOPS;
const spendDelivery = (donor, kinds) => {
  for (const kind of kinds)
    capacity.set(`${donor.agent}/${kind}`, cap(donor, kind) - 1);
  deliveries.set(donor.agent, tripsBy(donor) + 1);
};

const plan = [];
for (const n of needy) {
  // What this one is actually short of. A character with plenty of herbs and no
  // elderberry needs one delivery, not two.
  const short = KINDS.filter(k => n[k.field] < CASTABLE);
  // ONE DONOR IF ONE WILL DO. `supply what=reagents` hands over both kinds in a single
  // trip, so a donor holding both closes the whole gap with one walk — which is the case
  // this tool was originally written for and is still the cheapest when it exists.
  const both = short.length > 1
    ? held.filter(d => canDeliver(d, n, short.map(k => k.kind)))
    : [];
  const pickFrom = (list, kinds) => list.filter(d => canDeliver(d, n, kinds))
    .sort((a, b) => deliveryHops(a.room, n.room) - deliveryHops(b.room, n.room) ||
      (b.eb + b.hb) - (a.eb + a.hb))[0];
  const one = pickFrom(both, short.map(k => k.kind));
  if (one) {
    const kinds = short.map(k => k.kind);
    spendDelivery(one, kinds);
    plan.push({ from: one, to: n, kinds, sameRoom: one.room === n.room,
      hops: deliveryHops(one.room, n.room) });
    continue;
  }
  for (const k of short) {
    const pick = pickFrom(pool.get(k.kind), [k.kind]);
    if (!pick) {
      console.log(`  ${n.character}: nobody within ${MAX_HOPS} hops can spare ${k.kind}`);
      continue;
    }
    spendDelivery(pick, [k.kind]);
    plan.push({ from: pick, to: n, kinds: [k.kind], sameRoom: pick.room === n.room,
      hops: deliveryHops(pick.room, n.room) });
  }
}

for (const p of plan)
  console.log(`  ${p.from.character} -> ${p.to.character} (${AMOUNT} ${p.kinds.join(' + ')})` +
              (p.sameRoom ? '  [same room — no walk]' : `  [walk: ${p.from.room} -> ${p.to.room}]`));
if (DRY) { console.log('\ndry run — nothing handed over'); process.exit(0); }

// COOK ONCE, AFTER THE LAST DELIVERY THIS ONE IS WAITING ON. A recipient short of both
// reagents now gets two hand-overs from two donors, and casting after the first spends an
// errand on a spell that fails silently for want of the other half. Count down instead,
// and only cast for a recipient whose deliveries all landed — a partial resupply is a
// character to leave stocked for the next pass, not one to make cast and fail.
const owed = new Map();
for (const p of plan) owed.set(p.to.agent, (owed.get(p.to.agent) || 0) + 1);
const missed = new Set();

for (const p of plan) {
  try {
    // THE GIVER WALKS BY DEFAULT — but if it cannot, send the receiver instead.
    //
    // The surplus pools where the good farmers are, and they are good farmers partly
    // because they stay put. When every donor sits in one room whose exit is refused
    // ("no floor anywhere on the west boundary"), giver-walks fails for the whole
    // fleet at once and nothing moves — which is exactly what happened: seven of seven
    // deliveries, one error, one room.
    //
    // Swapping who walks costs nothing and fails independently: a blocked edge is
    // directional and about the room being LEFT, so the reverse trip is a different
    // question with a different answer. It is also the better trip on its own terms —
    // the starving character has an empty pack and nothing to lose by moving, while
    // the donor is mid-hunt with a full one.
    let r = await call('supply', { from: p.from.agent, to: p.to.agent,
                                   what: 'reagents', amount: AMOUNT, who_travels: 'from' });
    if (r?.supplied !== true && /could not get there|no floor|boundary/i.test(JSON.stringify(r))) {
      console.log(`    ${p.from.character} is walled in — sending ${p.to.character} to fetch instead`);
      r = await call('supply', { from: p.from.agent, to: p.to.agent,
                                 what: 'reagents', amount: AMOUNT, who_travels: 'to' })
                .catch(e => ({ supplied: false, reason: e.message }));
    }
    // `supplied` is the field the tool actually returns — not `delivered`, `ok` or
    // `received`, all of which I guessed and none of which exist. Guessing read a
    // successful hand-over as a failure and skipped the cast that was the whole point,
    // while the goods sat in the recipient's pack. Verify against the response, and
    // against `receiver_carrying`, which is the tool's own proof it landed.
    const ok = r.supplied === true && (r.receiver_carrying ?? 0) > 0;
    console.log(`  ${p.from.character} -> ${p.to.character}: ` +
                (ok ? 'delivered' : 'NOT delivered') + ' ' + JSON.stringify(r).slice(0, 160));
    owed.set(p.to.agent, (owed.get(p.to.agent) || 1) - 1);
    if (!ok) { missed.add(p.to.agent); continue; }
    if (owed.get(p.to.agent) > 0) {
      console.log(`    ${p.to.character}: still waiting on another reagent — cooking after that one`);
      continue;
    }
    if (missed.has(p.to.agent)) {
      console.log(`    ${p.to.character}: one of its deliveries failed, so not asking it to cast yet`);
      continue;
    }

    // COOK, EAT, THEN AIM HIGHER. Handing over reagents changes nothing on its own —
    // the character has to spend them, and then be told that 80 vigor is no longer
    // good enough to set out at. provision() climbs to the floor by eating, which it
    // can only do now that it has something to cook.
    await call('cast', { agent: p.to.agent, spell: 'create food' }).catch(() => {});
    await sleep(1200);
    await call('autopilot', { agent: p.to.agent, fight_above_vigor: FLOOR }).catch(() => {});
    console.log(`    ${p.to.character}: cast create food, now fighting above ${FLOOR} vigor`);
  } catch (e) {
    console.log(`  ${p.from.character} -> ${p.to.character}: FAILED ${e.message}`);
  }
}
process.exit(0);
