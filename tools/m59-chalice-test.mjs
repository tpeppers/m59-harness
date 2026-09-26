// OFFLINE. Pins chalice farming's pure half: the configuration's refusals, the roles, when a
// town trip rides, the tip, what gets dropped to make room for the cup, and the store that
// the separate keeper processes coordinate through.
//
// THE CASE WORTH READING FIRST is the station refusal. A station that does not refill the
// cup drains it one sip per trip, and the last sip DELETES it (chalice.kod:189) — so the
// configuration turns itself off rather than serve from one.
//
// No socket, no roster, no broker. `node tools/m59-chalice-test.mjs`.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHALICE, REFILL_ROOMS, CHALICE_DEFAULTS, normalizeChalice, roleOf, shouldRide,
         servingCharacter, tipPlan, planRoom, ChaliceStore, holderShortfall, donationPlan, folWanted, restockBuyPlan, PVP_TELEPORT_BLOCK_MS,
         reagentFloor, castsAbove, servingDesk, humanMark, HUMAN_FRESH_MS, deskMenu, formatDeskMenu,
         parseDeskRequest, parseDeskReply, serviceTellText, cargoWants, folRoomsOf } from './m59-chalice.mjs';

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

section("a ride is refused while the server's teleport ban is running");
{
  // chalice.kod:168-177 -- `GetLastPlayerAttackTime + TeleportAttackDelaySec > GetTime()`
  // refuses the sip, and the item cast SKIPS `Rescue.CanPayCosts`, so this gate is the one
  // that matters. util/settings.kod:88 makes the delay ten minutes.
  const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2 });
  const duty = { with: 'Rizzo', seen_at: Date.now() };
  const base = { cfg, role: 'traveller', stationHops: 1, targetHops: 9, carrying: false, duty };
  eq(PVP_TELEPORT_BLOCK_MS, 10 * 60_000, 'ten minutes, from the kod');
  const now = 5_000_000;
  const fresh = shouldRide({ ...base, now, lastPlayerAttackAt: now - 60_000 });
  eq(fresh.ride, false, 'a minute after swinging at somebody, no ride');
  ok(/chalice refuses a sip/.test(fresh.why), 'and it says why: ' + fresh.why);
  ok(fresh.wait_ms > 0 && fresh.wait_ms <= 10 * 60_000, 'with how long is left, so a caller can wait');
  // THE POINT OF CHECKING EARLY: the refusal lands at the END of the sequence otherwise --
  // after the walk, the hand-over and the tip.
  eq(shouldRide({ ...base, now, lastPlayerAttackAt: now - (10 * 60_000 + 1) }).ride, true,
     'once the ban has lapsed the ride is on again');
  // UNKNOWN MEANS GO. Most keepers never swing at a player, so a missing stamp must not read
  // as a ban -- that would switch the chalice off for the whole fleet for ever.
  eq(shouldRide({ ...base, now, lastPlayerAttackAt: null }).ride, true, 'never swung at anybody: ride');
  eq(shouldRide({ ...base, now }).ride, true, 'and an absent field is the same as null');
  // A shard that removed the ban can say so.
  const off = normalizeChalice({ holder: 'x', station_room: 2, pvp_block_ms: 0 });
  eq(shouldRide({ ...base, cfg: off, now, lastPlayerAttackAt: now - 1000 }).ride, true,
     'pvp_block_ms 0 switches the check off');
}

section('every trip home brings at least a quarter of the holder\'s target (operator, 2026-09-26)');
{
  const target = { 'orc tooth': 50, elderberry: 200, emerald: 110 };
  eq(CHALICE_DEFAULTS.restock_min_fraction, 0.25, 'a quarter by default');
  const w = cargoWants({ shortfall: { 'orc tooth': 49, elderberry: 150, emerald: 5 }, target,
                         cfg: { ...CHALICE_DEFAULTS, restock_per_trip: 10 } });
  eq(w['orc tooth'], 13, 'a per-trip cap of 10 is raised to 25% of 50 teeth: 13');
  eq(w.elderberry, 50, 'and to 25% of 200 berries');
  eq(w.emerald, 5, 'but never more than he is short');
  const big = cargoWants({ shortfall: { 'orc tooth': 49 }, target, cfg: CHALICE_DEFAULTS });
  eq(big['orc tooth'], 49, 'the standard cap of 60 already exceeds a quarter');
  eq(Object.keys(cargoWants({ shortfall: {}, target, cfg: CHALICE_DEFAULTS })).length, 0, 'not short: nothing');
  const src = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const draw = src.indexOf(`["draw the holder's restock"`), buy = src.indexOf(`["buy the holder's restock"`);
  ok(draw > 0 && buy > draw, 'the town trip draws from the chest BEFORE it buys');
  ok(/async chaliceTownCargo\(\)[\s\S]{0,900}chest_detour_hops/.test(src), 'and only within chest_detour_hops of the hall');
}

section('the holder keeps its Rescue emeralds back from forces of light');
{
  // Forces of light is 2 elderberries + 1 emerald. The holder's supply trip starts with a
  // Rescue, which DUM casts only with one emerald spare over its reserve of two -- so three.
  const FOL = [['elderberry', 2], ['emerald', 1]];
  eq(CFG.rescue_emeralds, 3, 'three by default: one to cast, two for the DUM reserve');
  eq(reagentFloor(CFG, 'holder').emerald, 3, 'the holder keeps them');
  eq(Object.keys(reagentFloor(CFG, 'alternate')).length, 0, 'the alternate does not rescue out');
  eq(Object.keys(reagentFloor(CFG, 'traveller')).length, 0, 'nor does a traveller');
  const keep = reagentFloor(CFG, 'holder');
  // THE PROD CASE, 2026-09-24: berries to spare and the emeralds down to the last few.
  eq(castsAbove({ elderberry: 40, emerald: 3 }, FOL, keep), 0, 'three emeralds: none to spend on the room');
  eq(castsAbove({ elderberry: 40, emerald: 5 }, FOL, keep), 2, 'five: two casts, three kept');
  eq(castsAbove({ elderberry: 5, emerald: 50 }, FOL, keep), 2, 'berries bind when they are short');
  eq(castsAbove({ elderberry: 40, emerald: 1 }, FOL, keep), 0, 'below the floor is zero, not negative');
  eq(castsAbove({ elderberry: 40, emerald: 3 }, FOL), 3, 'with no floor every emerald is a cast');
  const off = normalizeChalice({ holder: 'x', station_room: 2, rescue_emeralds: 0 });
  eq(Object.keys(reagentFloor(off, 'holder')).length, 0, 'rescue_emeralds 0 switches the floor off');
  const bad = normalizeChalice({ holder: 'x', station_room: 2, rescue_emeralds: -4 });
  eq(bad.rescue_emeralds, 3, 'a negative floor keeps the default');
}

section('holder_keep: reagents the holder keeps for a job that is not the desk (21 teeth for a raid)');
{
  const kept = normalizeChalice({ holder: 'x', station_room: 2, holder_keep: { 'Orc Tooth': 21, emerald: 2 } });
  eq(kept.holder_keep['orc tooth'], 21, 'normalised to the lower-case item name');
  eq(reagentFloor(kept, 'holder')['orc tooth'], 21, 'the holder keeps the teeth');
  eq(reagentFloor(kept, 'holder').emerald, 5, 'and a kept emerald ADDS to the Rescue three');
  eq(Object.keys(reagentFloor(kept, 'alternate')).length, 0, 'the alternate keeps nothing');
  // reveal.kod:55 — three teeth a cast. 23 on hand, 21 kept: no reveal; 24: one.
  eq(castsAbove({ 'orc tooth': 23 }, [['orc tooth', 3]], reagentFloor(kept, 'holder')), 0, '23 teeth, 21 kept: no reveal');
  eq(castsAbove({ 'orc tooth': 24 }, [['orc tooth', 3]], reagentFloor(kept, 'holder')), 1, '24: exactly one');
  const menu = deskMenu({ cfg: kept, have: { 'orc tooth': 23, emerald: 9 }, floor: reagentFloor(kept, 'holder') });
  eq(menu.find(m => m.kind === 'reveal')?.ok, false, 'the desk menu says reveal needs reagents at 23');
  const bad = normalizeChalice({ holder: 'x', station_room: 2, holder_keep: { 'orc tooth': -1 } });
  ok(bad.problems.some(p => /holder_keep/.test(p)), 'a negative keep is reported');
}


// ---------------------------------------------------------------------------------------
section('the human desk: a person playing the server keeps the service listed');
{
  const now = Date.now();
  const mark = { character: 'Loial the Ogier', agent: 'hk1', pid: process.pid, since: now - 60_000, seen_at: now - 5_000 };
  const humans = { 'loial the ogier': mark };
  // THE LOGIN DISPLACES THE KEEPER, so its own facts go stale together: paused where it was
  // left, seen_at frozen. Neither may close the desk while a person is there.
  const frozen = { with: 'Loial the Ogier', paused: true, seen_at: now - 60 * 60_000 };
  eq(servingDesk(frozen, CFG, now, null), null, 'without the mark, the stale record reads as nobody serving');
  const d = servingDesk(frozen, CFG, now, humans);
  eq(d?.server, 'Loial the Ogier', 'with it, Loial is still serving');
  eq(d?.human, true, 'and the desk knows a person is at the controls');
  eq(servingDesk({ with: 'Loial the Ogier', lost: true }, CFG, now, humans), null, 'a lost cup still closes it');
  eq(servingDesk({}, CFG, now, humans)?.human, true, 'never recorded: the holder, played by a person');
  eq(servingDesk({ with: 'Rizzo' }, CFG, now, humans)?.human, false, 'the alternate with the cup is a keeper, not the person');
  const stale = { 'loial the ogier': { ...mark, seen_at: now - HUMAN_FRESH_MS - 1 } };
  eq(humanMark(stale, 'Loial the Ogier', now), null, 'a mark the broker stopped refreshing is dead');
  eq(humanMark(humans, 'LOIAL THE OGIER', now) != null, true, 'names match without case');
  eq(humanMark(humans, 'Loial the Ogier', now, () => false), null, 'a mark whose client exited is dead');
  const off = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, human_desk: false });
  eq(servingDesk(frozen, off, now, humans), null, 'human_desk: false restores the old behaviour');
  const r = shouldRide({ cfg: CFG, role: 'traveller', stationHops: 1, targetHops: 9, duty: frozen, humans, now });
  eq(r.ride, true, 'a traveller rides to a person');
  eq(r.human, true, 'and knows to ask by tell');
  eq(serviceTellText('chalice'), '~B~k[Service Request] ~b chalice', 'the operator\'s tell format, exactly');
  eq(CFG.human_wait_ms, 60_000, 'a person gets a minute by default');
  const clamp = normalizeChalice({ holder: 'x', station_room: 2, human_wait_ms: 200_000, human_max_wait_ms: 60_000 });
  eq(clamp.human_max_wait_ms, 200_000, 'the cap is never below the first wait');
}

section('the desk menu says what cannot be done and why');
{
  const menu = deskMenu({ cfg: normalizeChalice({ holder: 'x', station_room: 2, fol_room: 38 }),
    have: { emerald: 20, 'orc tooth': 1 }, floor: { emerald: 3 }, casts: 5, cup: true });
  eq(formatDeskMenu(menu), 'Remove Curse, Reveal ~r(-Req. reagents)~k, Chalice, Forces of Light',
     'the operator\'s example, word for word');
  const dry = deskMenu({ cfg: CFG, have: { emerald: 3, 'orc tooth': 9 }, floor: { emerald: 3 }, casts: 0, cup: false });
  eq(dry.find(m => m.kind === 'uncurse').ok, false, 'remove curse may not spend the rescue emeralds');
  eq(dry.find(m => m.kind === 'reveal').ok, true, 'three teeth pay for a reveal');
  eq(dry.find(m => m.kind === 'ride').why, 'cup is elsewhere', 'no cup, no chalice');
  eq(deskMenu({ cfg: normalizeChalice({ holder: 'x', station_room: 2 }), have: {}, cup: true })
       .some(m => m.kind === 'fol'), false, 'no fol_room, no forces of light on the menu');
}

section('what a person types is parsed whole, not searched');
{
  const k = (t) => parseDeskRequest(t)?.kind ?? null;
  eq(k('services?'), 'menu', '"services?"');
  eq(k('Services'), 'menu', '"Services"');
  eq(k('Remove Curse'), 'uncurse', '"Remove Curse"');
  eq(k('reveal'), 'reveal', '"reveal"');
  eq(k('Chalice'), 'ride', '"Chalice"');
  eq(k('Forces of Light'), 'fol', '"Forces of Light"');
  eq(parseDeskRequest('fol in 39')?.room, 39, 'forces of light names its room');
  eq(k('cancel'), 'cancel', '"cancel"');
  eq(k('can you remove curse later'), null, 'a sentence that contains a service is chat');
  eq(k('control'), null, '"control" belongs to the fleet controls');
  const r = (t) => parseDeskReply(t)?.kind ?? null;
  eq(r('hold on'), 'hold', '"hold on"');
  eq(r('wait, coming'), 'hold', '"wait, coming"');
  eq(r('1 min'), 'hold', '"1 min"');
  eq(r('not now'), 'decline', '"not now"');
  eq(r("can't"), 'decline', '"can\'t"');
  eq(r('done'), 'done', '"done"');
  eq(r('where are you going?'), null, 'anything else is not an answer');
}

section('the store: marks, holds, closes, one tell per gap, and nothing lost to an older writer');
{
  const dir2 = mkdtempSync(join(tmpdir(), 'chalice-human-'));
  try {
    const store = new ChaliceStore({ directory: dir2, namespace: 'h' });
    const t0 = 1_000_000;
    store.setHuman('Loial the Ogier', { agent: 'hk1', pid: 1 }, t0);
    eq(store.humans()['loial the ogier'].since, t0, 'marked');
    store.setHuman('Loial the Ogier', { agent: 'hk1', pid: 1 }, t0 + 30_000);
    eq(store.humans()['loial the ogier'].since, t0, 'a refresh keeps when it started');
    eq(store.humans()['loial the ogier'].seen_at, t0 + 30_000, 'and moves seen_at');
    // AN OLDER KEEPER'S READ-MODIFY-WRITE used to rebuild the state from four keys.
    store.setDuty({ with: 'Loial the Ogier' }, t0 + 31_000);
    ok(store.humans()['loial the ogier'], 'a duty write does not erase the mark');

    const t = store.request('Bunsen', { room: 2, server: 'Loial the Ogier' }, t0 + 40_000);
    eq(t.human_server, 'Loial the Ogier', 'the ticket records who it was sent to');
    const held = store.hold('Bunsen', { by: 'Loial the Ogier', ms: 120_000, maxMs: 300_000 }, t0 + 50_000);
    eq(held[0].hold_until, t0 + 170_000, 'hold on: two more minutes');
    const capped = store.hold('Bunsen', { ms: 900_000, maxMs: 300_000 }, t0 + 60_000);
    eq(capped[0].hold_until, t0 + 40_000 + 300_000, 'never past the cap from the request');
    eq(capped[0].holds, 2, 'and counted');
    // A HELD TICKET OUTLIVES ITS TTL until the hold runs out.
    store.claimNext('Nobody', { kind: 'fol', ttlMs: 60_000 }, t0 + 200_000);
    eq(store.ticket(t.id).status, 'open', 'held past the ttl, still open');
    const shut = store.closeFrom('Bunsen', 'abandoned', { by: 'Loial the Ogier', note: 'declined' }, t0 + 210_000);
    eq(shut.length, 1, 'not now closes it');
    eq(store.ticket(t.id).closed_by, 'Loial the Ogier', 'and says who');

    eq(store.claimTell('fol:loial', 90_000, t0), true, 'the first tell goes');
    eq(store.claimTell('fol:loial', 90_000, t0 + 30_000), false, 'the second inside the gap does not');
    eq(store.claimTell('fol:loial', 90_000, t0 + 91_000), true, 'after the gap it does');

    const mine = store.request('Kermit', { kind: 'uncurse', room: 2 }, t0 + 300_000);
    const theirs = store.request('Bunsen', { kind: 'uncurse', room: 2, human: true }, t0 + 301_000);
    const got = store.claimNext('Loial the Ogier', { kind: 'uncurse', humanOnly: true, ttlMs: 300_000 }, t0 + 302_000);
    eq(got?.id, theirs.id, 'the desk claims only the ticket a person filed');
    eq(store.ticket(mine.id).status, 'open', 'a keeper\'s own uncurse stays with its ride');
    eq(store.clearHuman('Loial the Ogier')?.agent, 'hk1', 'unmarked');
    eq(Object.keys(store.humans()).length, 0, 'and gone');
  } finally { rmSync(dir2, { recursive: true, force: true }); }
}

// FORCES OF LIGHT IN MORE THAN ONE ROOM (2026-09-26): "The Ukgoth farmers can also benefit from
// forces of light cast by Loial". Each room has its own clock and its own tickets.
console.log('forces of light in several rooms');
{
  const cfg = normalizeChalice({ holder: 'Loial the Ogier', fol_room: 38, fol_rooms: [599, 38, 'x'] });
  eq(JSON.stringify(folRoomsOf(cfg)), '[38,599]', 'fol_room first, then the extra rooms, once each');
  ok(cfg.problems.some(p => /fol_rooms: x/.test(p)), 'a nonsense room is reported, not applied');
  eq(JSON.stringify(folRoomsOf(normalizeChalice({ holder: 'x', fol_room: 38 }))), '[38]', 'one room still works alone');
  eq(folWanted({ cfg, here: 599, fol: {}, now: 5 }), true, 'an Ukgoth farmer asks for its own room');
  eq(folWanted({ cfg, here: 39, fol: {}, now: 5 }), false, 'a room nobody configured does not');
  eq(deskMenu({ cfg: normalizeChalice({ holder: 'x', station_room: 2, fol_rooms: [599] }), have: {}, casts: 5, cup: true })
       .some(m => m.kind === 'fol'), true, 'extra rooms alone still put forces of light on the menu');

  const dir3 = mkdtempSync(join(tmpdir(), 'chalice-fol-'));
  try {
    const store = new ChaliceStore({ directory: dir3, namespace: 'prod' });
    const t38 = store.request('Kermit', { room: 38, kind: 'fol' }, 1000);
    const t599 = store.request('Bunsen', { room: 599, kind: 'fol' }, 1000);
    store.litFol({ room: 38, until: 100_000, by: 'Loial the Ogier' }, 2000);
    eq(store.ticket(t38.id).status, 'done', 'lighting 38 answers the 38 ticket');
    eq(store.ticket(t599.id).status, 'open', 'and NOT the Ukgoth one');
    eq(store.folFor(38).until, 100_000, '38 has its clock');
    eq(store.folFor(599).until, undefined, '599 has none yet, so its occupants still ask');
    store.litFol({ room: 599, until: 50_000, by: 'Loial the Ogier' }, 3000);
    eq(store.folFor(599).until, 50_000, 'each room keeps its own');
    eq(store.folFor(38).until, 100_000, 'without overwriting the other');
  } finally { rmSync(dir3, { recursive: true, force: true }); }

  const AP = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok(AP.includes('st.folRoom = folRoomsOf(cfg).includes(Number(st.room)) ? Number(st.room) : cfg.fol_room;'),
     "the visit walks to the ticket's room only when it is one the holder lights");
  ok(AP.includes('store.litFol({ room: st.folRoom ?? cfg.fol_room'), 'and records the lit clock for that room');
  ok(AP.includes('if (!cfg || !folRoomsOf(cfg).includes(here)) return;'), 'occupants of every lit room may ask');
  ok(AP.includes('...folRoomsOf(this.chaliceCfg), opts.chaliceRoom]'), 'the post confinement admits every lit room');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
