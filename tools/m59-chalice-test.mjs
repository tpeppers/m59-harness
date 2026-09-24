// OFFLINE. Pins chalice farming's pure half: the configuration's refusals, the roles, when a
// town trip rides, the tip, what gets dropped to make room for the cup, and the store that
// the separate keeper processes coordinate through.
//
// THE CASE WORTH READING FIRST is the station refusal. A station that does not refill the
// cup drains it one sip per trip, and the last sip DELETES it (chalice.kod:189) — so the
// configuration turns itself off rather than serve from one.
//
// No socket, no roster, no broker. `node tools/m59-chalice-test.mjs`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHALICE, REFILL_ROOMS, CHALICE_DEFAULTS, normalizeChalice, roleOf, shouldRide,
         servingCharacter, tipPlan, planRoom, ChaliceStore, holderShortfall, donationPlan, folWanted, restockBuyPlan } from './m59-chalice.mjs';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) { pass++; } else { fail++; console.log(`  FAIL: ${what}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), `${what} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);
const section = (s) => console.log(`\n${s}`);

const CFG = normalizeChalice({ holder: 'Loial the Ogier', alternate: 'Rizzo', station_room: 2, post_room: 38 });

// ---------------------------------------------------------------------------------------
section('a station that does not refill the cup is refused');
{
  const bad = normalizeChalice({ holder: 'Loial the Ogier', station_room: 38 });
  eq(bad.enabled, false, 'Castle Victoria (38) is not a refill room, so farming is off');
  ok(bad.problems.some(p => /does not refill/.test(p)), 'and it says why');
  eq(CFG.enabled, true, 'Outside Castle Victoria (2) is, and the configuration stands');
  ok(REFILL_ROOMS.has(2) && REFILL_ROOMS.has(544) && !REFILL_ROOMS.has(714), 'refill set: 2 and 544 yes, the hall no');
}

section('the configuration keeps defaults for what it cannot use, and says so');
{
  const c = normalizeChalice({ holder: 'A', tip_amount: -5, wait_ms: 'soon', colour: 'blue' });
  eq(c.tip_amount, CHALICE_DEFAULTS.tip_amount, 'a negative tip keeps the default');
  eq(c.wait_ms, CHALICE_DEFAULTS.wait_ms, 'a word for a number keeps the default');
  ok(c.problems.some(p => /colour/.test(p)), 'an unknown key is reported, not dropped silently');
  eq(normalizeChalice({ station_room: 2 }).enabled, false, 'no holder, no service');
  eq(normalizeChalice({ holder: 'A', alternate: 'a' }).alternate, null, 'the holder cannot be its own alternate');
  eq(normalizeChalice(null).enabled, false, 'silence is the old behaviour: off');
  eq(normalizeChalice({ holder: 'A', tip_amount: 20, tip_min: 50 }).tip_min, 20, 'the minimum never exceeds the tip');
}

section('roles, by name, case-insensitively');
{
  eq(roleOf('loial the ogier', CFG), 'holder', 'the holder');
  eq(roleOf('RIZZO', CFG), 'alternate', 'the alternate');
  eq(roleOf('Kermit', CFG), 'traveller', 'everybody else rides');
  eq(roleOf('Kermit', normalizeChalice(null)), null, 'nobody has a role while it is off');
}

// ---------------------------------------------------------------------------------------
section('which trips ride');
{
  const base = { cfg: CFG, role: 'traveller', stationHops: 1, targetHops: 9, duty: { with: 'Loial the Ogier', seen_at: Date.now() } };
  eq(shouldRide(base).ride, true, 'a castle farmer, one hop from the station, rides');
  eq(shouldRide({ ...base, stationHops: 6 }).ride, false, 'a valley farmer six hops away walks');
  eq(shouldRide({ ...base, stationHops: 3, targetHops: 3 }).ride, false, 'the town is no further than the station: walk');
  eq(shouldRide({ ...base, role: 'holder' }).ride, false, 'the holder never rides — it serves');
  eq(shouldRide({ ...base, role: 'alternate', carrying: true }).ride, false, 'the alternate on duty stays');
  eq(shouldRide({ ...base, role: 'alternate' }).ride, true, 'the alternate off duty rides like anyone');
  eq(shouldRide({ ...base, duty: { with: 'Loial the Ogier', lost: true } }).ride, false, 'a lost cup serves nobody');
  eq(shouldRide({ ...base, duty: { with: 'Loial the Ogier', seen_at: Date.now() - 20 * 60_000 } }).ride, false,
     'a holder unheard-from for twenty minutes is a stopped keeper, not a server');
  eq(shouldRide({ ...base, stationHops: null }).ride, false, 'no route to the station: walk');
  eq(servingCharacter({}, CFG), 'Loial the Ogier', 'never recorded: the holder, by default');
  eq(shouldRide({ ...base, duty: { with: 'Loial the Ogier', paused: true, seen_at: Date.now() } }).ride, false,
     'a holder whose body a raid or errand has claimed serves nobody: walk now');
  eq(servingCharacter({ with: 'Rizzo', seen_at: Date.now() }, CFG), 'Rizzo', 'the alternate while the holder is away');
}

section('the tip comes only out of money the trip does not need');
{
  eq(tipPlan({ purse: 2000, keep: 400, cfg: CFG }).amount, 300, 'the standard tip');
  eq(tipPlan({ purse: 520, keep: 400, cfg: CFG }).amount, 120, 'cut to what is spare');
  eq(tipPlan({ purse: 430, keep: 400, cfg: CFG }).amount, 0, 'under the minimum: offer-nothing');
  eq(tipPlan({ purse: 100, keep: 400, cfg: CFG }).amount, 0, 'broke: offer-nothing');
  ok(/offer-nothing/.test(tipPlan({ purse: 0, keep: 0, cfg: CFG }).why), 'and it says so');
}

// ---------------------------------------------------------------------------------------
section('making room for a 20/20 cup');
{
  // Orc teeth are the cheaper per unit of pack than a sapphire; with no preference the
  // cheapest by shillings-per-cost goes first.
  const pack = [
    { id: 1, name: 'sapphire', amount: 5 },
    { id: 2, name: 'orc tooth', amount: 30 },
    { id: 3, name: 'long sword', amount: 1, equipped: true },
    { id: 4, name: 'chalice of the rain', amount: 1 },
    { id: 5, name: 'shillings', amount: 900 },
    { id: 6, name: 'elderberry', amount: 40 },
  ];
  const r = planRoom({ pack, roomFor: { weight: 5, bulk: 30 }, protect: ['elderberry'] });
  eq(r.enough, true, 'there is something to drop');
  ok(r.freed.weight >= 15, `frees the 15 weight it is short (${r.freed.weight})`);
  ok(!r.drops.some(d => [3, 4, 5, 6].includes(d.id)),
     'never the worn weapon, the chalice, the shillings or a protected reagent');
  ok(r.drops.every(d => d.amount >= 1), 'every drop moves at least one unit');
  const noRoom = planRoom({ pack: [{ id: 3, name: 'long sword', equipped: true }], roomFor: { weight: 0, bulk: 0 } });
  eq(noRoom.enough, false, 'nothing droppable: walk rather than shed the pack');
  eq(noRoom.drops.length, 0, 'and it drops nothing');
  eq(planRoom({ pack, roomFor: { weight: 50, bulk: 50 } }).drops.length, 0, 'room already: no drops');
  eq(planRoom({ pack, roomFor: null }).enough, null, 'unreadable capacity is "unknown", never "room"');
  eq(CHALICE.weight, 20, 'the cup weighs 20 (chalice.kod)');
}

// ---------------------------------------------------------------------------------------
section('the store: tickets and duty across processes');
{
  const dir = mkdtempSync(join(tmpdir(), 'chalice-'));
  try {
    const a = new ChaliceStore({ directory: dir, namespace: 'prod' });
    const b = new ChaliceStore({ directory: dir, namespace: 'prod' });   // "another process"
    const t0 = 1_000_000;
    const t = a.request('Kermit', { room: 2 }, t0);
    eq(t.status, 'open', 'a request opens a ticket');
    eq(a.request('Kermit', { room: 2 }, t0 + 5).id, t.id, 'asking twice is one ticket');
    const claimed = b.claimNext('Loial the Ogier', {}, t0 + 10);
    eq(claimed?.id, t.id, 'the other process sees it and claims it');
    eq(b.claimNext('Rizzo', {}, t0 + 11), null, 'a claimed ticket is not claimed twice');
    a.mark(t.id, 'handed', {}, t0 + 20);
    eq(b.ticket(t.id).status, 'handed', 'status moves are visible across stores');
    eq(a.claimNext('Kermit', {}, t0 + 30), null, 'nobody serves their own ticket');
    const r = a.request('Loial the Ogier', { room: 38, kind: 'relief' }, t0 + 40);
    eq(b.claimNext('Rizzo', { kind: 'ride' }, t0 + 41), null, 'a relief ticket is not a ride');
    eq(b.claimNext('Rizzo', { kind: 'relief' }, t0 + 42)?.id, r.id, 'the alternate claims the relief');
    const old = a.request('Gonzo', { room: 2 }, t0 + 50);
    eq(b.claimNext('Loial the Ogier', { ttlMs: 60_000 }, t0 + 50 + 61_000), null, 'an expired ticket is abandoned, not served');
    eq(a.ticket(old.id).status, 'abandoned', 'and says so');
    a.setDuty({ with: 'Rizzo', holder_away: true }, t0 + 60);
    eq(b.duty().with, 'Rizzo', 'duty is shared');
    eq(b.duty().holder_away, true, 'with its flags');
    eq(new ChaliceStore({ directory: dir, namespace: 'shadow' }).duty().with, undefined, 'fleets do not share a store');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

section('the holder\'s supply: shortfall net of pledges, and what a traveller can spare');
{
  const now = 10_000_000;
  const supply = { have: { elderberry: 150, emerald: 110, 'orc tooth': 5 },
                   target: { elderberry: 200, emerald: 110, 'orc tooth': 30 },
                   pledged: [{ by: 'Pepe', item: 'elderberry', amount: 20, at: now - 1000 },
                             { by: 'Gonzo', item: 'orc tooth', amount: 10, at: now - 2 * 3600_000 }] };
  const s = holderShortfall(supply, { now });
  eq(s.elderberry, 30, 'fifty short, twenty already pledged');
  eq(s.emerald, undefined, 'at target: nothing wanted');
  eq(s['orc tooth'], 25, 'an hour-old pledge counts for nothing');
  eq(holderShortfall(supply, { now, except: 'Pepe' }).elderberry, 50, 'a traveller\'s own pledge is not somebody else\'s');
  const d = donationPlan({ have: { elderberry: 70, 'orc tooth': 4 }, floors: { elderberry: 60 }, shortfall: s });
  eq(d.elderberry, 10, 'gives only above its own floor');
  eq(d['orc tooth'], 4, 'and all of what it has no floor for, up to the shortfall');
  eq(Object.keys(donationPlan({ have: {}, shortfall: s })).length, 0, 'nothing spare, nothing given');

  const dir = mkdtempSync(join(tmpdir(), 'chalice-supply-'));
  try {
    const st = new ChaliceStore({ directory: dir, namespace: 'p' });
    st.setSupply({ have: supply.have, target: supply.target }, now);
    const g1 = st.pledge('Kermit', { elderberry: 60, 'orc tooth': 10 }, now);
    eq(g1.elderberry, 50, 'a pledge is cut to the shortfall');
    const g2 = st.pledge('Robin', { elderberry: 60 }, now + 1);
    eq(g2.elderberry, undefined, 'a second traveller is not granted what the first took on');
    st.unpledge('Kermit', now + 2);
    eq(st.pledge('Robin', { elderberry: 60 }, now + 3).elderberry, 50, 'released, it is available again');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

section('forces of light: who asks');
{
  const cfg = normalizeChalice({ holder: 'Loial the Ogier', fol_room: 38 });
  eq(folWanted({ cfg, here: 38, fol: {}, now: 5 }), true, 'never lit: ask');
  eq(folWanted({ cfg, here: 38, fol: { until: 100_000 }, now: 5 }), false, 'lit for a while yet: do not');
  eq(folWanted({ cfg, here: 38, fol: { until: 8_000 }, now: 5_000 }), true, 'inside the lead time: ask');
  eq(folWanted({ cfg, here: 39, fol: {}, now: 5 }), false, 'not in the room: not our business');
  eq(folWanted({ cfg, here: 38, fol: {}, role: 'holder' }), false, 'the holder never asks itself');
}

section("buying the holder's restock: the plan");
{
  // THE OPERATOR'S ORDER, 2026-09-24: buy the reagents after selling and tip those on the way
  // back, rather than waiting on a guild-chest draw that only a chalice RIDE can trigger. The
  // chest held 4,551 elderberries that day and had been drawn from zero times.
  const cfg = normalizeChalice({
    holder: 'Loial the Ogier',
    holder_supply: { elderberry: 200, emerald: 110, 'orc tooth': 30 },
    supply_shops: { elderberry: { room: 104, seller: 'Joguer' },
                    emerald: { room: 109, seller: 'Herbutte' } },
    restock_per_trip: 60,
  });
  eq(cfg.problems.length, 0, 'the config is accepted: ' + JSON.stringify(cfg.problems));
  const stops = restockBuyPlan({ shortfall: { elderberry: 179, emerald: 86, 'orc tooth': 5 }, cfg });
  eq(stops.length, 2, 'one stop per counter');
  eq(stops[0].room, 104, 'and in a deterministic order');
  eq(stops[0].lines[0].amount, 60, 'capped at restock_per_trip, not the whole shortfall');
  eq(stops[1].seller, 'Herbutte', 'the gem comes from the gem merchant');
  // THE TWO HALVES ARE NOT SOLD BY ONE PERSON. A plan that assumed they were would come home
  // able to keep the holder casting exactly as long as it left.
  ok(!stops.some(st => st.lines.length > 1), 'and neither counter is asked for the other half');
  // An item nobody sells is not a gap: it is donated, drawn from the chest, or farmed.
  ok(!stops.some(st => st.lines.some(l => l.item === 'orc tooth')), 'orc teeth have no counter, so no line');
}

section("buying the holder's restock: the refusals");
{
  const off = normalizeChalice({ holder: 'x', holder_supply: { elderberry: 200 } });
  eq(restockBuyPlan({ shortfall: { elderberry: 50 }, cfg: off }).length, 0,
     'no supply_shops, no buying — off is the default');
  const bad = normalizeChalice({ holder: 'x', supply_shops: { elderberry: { seller: 'Joguer' } } });
  ok(bad.problems.some(p => /supply_shops\.elderberry needs/.test(p)),
     'a counter with no room is refused, and says which item');
  eq(Object.keys(bad.supply_shops).length, 0, 'and is not half-applied');
  const partial = normalizeChalice({ holder: 'x',
    supply_shops: { elderberry: { room: 104, seller: 'Joguer' }, emerald: { room: 0, seller: '' } } });
  eq(Object.keys(partial.supply_shops).join(','), 'elderberry',
     'one bad entry does not lose the good one');
  // `Number(null)` IS 0 AND 0 IS FINITE, so a default-guard written the obvious way capped
  // every line at nothing and the plan came back empty with no problem reported. Caught by
  // this suite before it shipped; the same trap `buyLines` carries a note about.
  eq(restockBuyPlan({ shortfall: { elderberry: 179 }, perTrip: null,
    cfg: normalizeChalice({ holder: 'x', restock_per_trip: 60,
      supply_shops: { elderberry: { room: 104, seller: 'Joguer' } } }) })[0].lines[0].amount,
    60, 'an unspecified per-trip cap falls back to the config, not to zero');
  eq(restockBuyPlan({ shortfall: {}, cfg: normalizeChalice({ holder: 'x',
    supply_shops: { elderberry: { room: 104, seller: 'Joguer' } } }) }).length, 0, 'nothing short');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
