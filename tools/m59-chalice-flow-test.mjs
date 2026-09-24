// OFFLINE. Drives the keeper half of chalice farming — `chaliceRide` and `chaliceDuty` on
// real Autopilot methods — against a small fake world: rooms, players, a floor, trades that
// only complete when the other side counters, and a Rescue that lands in the guild hall.
//
// Three keepers, the real stage machines, one shared store in a temp directory. What is
// pinned is the protocol end to end, because each half is simple and the bugs live between
// them: a cup handed and never picked up, a holder that walks home without it, an alternate
// that goes to town while it is the only one serving.
//
// No socket. `node tools/m59-chalice-flow-test.mjs`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Autopilot } from './m59-autopilot.mjs';
import { OF } from './m59-parse.mjs';
import { ChaliceStore, normalizeChalice, GUILD_HALL_ROOM } from './m59-chalice.mjs';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) { pass++; console.log('  ok  ', what); } else { fail++; console.log('  FAIL', what); } };
const section = (s) => console.log(`\n${s}`);

// ------------------------------------------------------------------------------ the world
function makeWorld() {
  let nextId = 5000;
  const names = new Map();              // rsc -> name
  const rsc = (name) => { const r = 90000 + names.size; names.set(r, name); return r; };
  const world = { players: new Map(), floor: new Map(), names, landings: [] };
  world.item = (name, amount = 1) => ({ id: nextId++, nameRsc: rsc(name), amount });
  world.nameOf = (o) => names.get(o.nameRsc) ?? '';

  world.add = (name, { room, inventory = [], accepts = true }) => {
    const self = { id: nextId++, nameRsc: rsc(name) };
    const client = {
      selfId: self.id, self: { row: 1, col: 1 }, inventory, evSeq: 1, accepts,
      rsc: { get: r => names.get(r) ?? '' },
      stat: () => 100,
      equipment: () => ({ equipped: [] }),
      get room() { return { num: p.room, objects: world.objectsFor(p) }; },
      stand() {},
      requestInventory() {},
      offer(toId, items) { client._offer = { toId, items }; },
      cancelOffer() { client._offer = null; },
      async waitFor({ kinds = [] } = {}) {
        if (kinds.includes('countered') && client._offer) {
          const to = [...world.players.values()].find(q => q.self.id === client._offer.toId);
          if (to && to.room === p.room && to.client.accepts) return { events: [{ kind: 'countered' }] };
          return { events: [] };
        }
        return { events: [{ kind: kinds[0] ?? 'x' }] };
      },
      acceptOffer() {
        const o = client._offer; client._offer = null;
        const to = [...world.players.values()].find(q => q.self.id === o?.toId);
        if (!to) return;
        for (const spec of o.items) {
          const id = typeof spec === 'object' ? spec.id : spec;
          const i = client.inventory.findIndex(x => x.id === id);
          if (i < 0) continue;
          const it = client.inventory[i];
          const amount = typeof spec === 'object' ? spec.amount : it.amount;
          if (amount < it.amount) {
            it.amount -= amount;
            const into = to.client.inventory.find(x => world.nameOf(x) === world.nameOf(it));
            if (into) into.amount += amount; else to.client.inventory.push({ ...it, id: nextId++, amount });
          } else {
            client.inventory.splice(i, 1);
            to.client.inventory.push(it);
          }
        }
      },
      drop(specs) {
        for (const spec of [].concat(specs)) {
          const id = typeof spec === 'object' ? spec.id : spec;
          const i = client.inventory.findIndex(x => x.id === id);
          if (i < 0) continue;
          const [it] = client.inventory.splice(i, 1);
          (world.floor.get(p.room) ?? world.floor.set(p.room, []).get(p.room)).push(it);
        }
      },
      apply(id) {
        // A power-1 Rescue: lands after the timer, in the guild hall (same region).
        if (/chalice/i.test(world.nameOf(client.inventory.find(x => x.id === id) ?? {})))
          world.landings.push({ who: p, at: Date.now() + 1500 });
      },
    };
    const p = { name, room, self, client };
    world.players.set(name, p);
    return p;
  };

  world.objectsFor = (p) => {
    const m = new Map();
    for (const q of world.players.values())
      if (q !== p && q.room === p.room) m.set(q.self.id, { id: q.self.id, nameRsc: q.self.nameRsc, flags: OF.PLAYER, row: 1, col: 1 });
    for (const it of world.floor.get(p.room) ?? []) m.set(it.id, { ...it, flags: OF.GETTABLE, row: 1, col: 2 });
    return m;
  };

  world.tick = () => {
    const now = Date.now();
    for (const l of [...world.landings]) if (now >= l.at) {
      l.who.room = GUILD_HALL_ROOM;
      world.landings.splice(world.landings.indexOf(l), 1);
    }
  };
  return world;
}

function keeper(world, p, { cfg, store, casts = 50 }) {
  const ap = Object.create(Autopilot.prototype);
  ap.policy = { walkingMoney: 400 };
  ap.tally = {}; ap.notes = []; ap.events = [];
  ap.s = {
    name: p.name, client: p.client, get world() { return { room: { num: p.room } }; },
    need: () => p.client,
    pacer: { submit: async (_k, fn) => fn() },
    async lootFloor({ ids }) {
      const floor = world.floor.get(p.room) ?? [];
      for (const id of ids) {
        const i = floor.findIndex(x => x.id === id);
        if (i >= 0) p.client.inventory.push(...floor.splice(i, 1));
      }
      return { taken: ids };
    },
  };
  ap.note = (what, detail) => ap.notes.push({ what, detail });
  ap.progress = () => {};
  ap.who = () => p.name;
  ap._chaliceCfg = cfg; ap._chaliceCfgAt = Date.now() + 1e9;
  ap._chaliceStoreObj = store;
  ap.chaliceEvent = (what, detail) => ap.events.push({ what, ...detail });
  ap.travelInterrupted = () => false;
  ap.suspendedJourney = null;
  ap.hopsTo = (room) => (Number(room) === 2 ? 1 : Number(room) === 38 ? 1 : 9);
  ap.travel = async (room) => { p.room = Number(room); return { arrived: true }; };
  ap.takeRecoverySpot = async () => { ap.hold = { parked: true }; };
  ap.protectedItemNames = () => [];
  ap.shoppingPlan = () => ({ required_purse: 0 });
  ap.purseNow = () => p.client.inventory.filter(x => /shilling/i.test(world.nameOf(x))).reduce((a, x) => a + x.amount, 0);
  ap._casts = casts;
  ap.chaliceCastsLeft = () => ap._casts;
  return ap;
}

async function runUntil(cond, steps, { limit = 400, pause = 20 } = {}) {
  for (let i = 0; i < limit; i++) {
    if (cond()) return true;
    for (const s of steps) await s();
    await new Promise(r => setTimeout(r, pause));
  }
  return cond();
}

const has = (world, p, re) => p.client.inventory.some(x => re.test(world.nameOf(x)));
const coins = (world, p) => p.client.inventory.filter(x => /shilling/i.test(world.nameOf(x))).reduce((a, x) => a + x.amount, 0);

const dir = mkdtempSync(join(tmpdir(), 'chalice-flow-'));
try {
  // ---------------------------------------------------------------------------------------
  section('a castle farmer rides home; the holder hands, is tipped, picks up, goes back');
  {
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'one' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', alternate: 'Rizzo', station_room: 2, post_room: 38 });
    const loialP = world.add('Loial the Ogier', { room: 38, inventory: [world.item('chalice of the rain')] });
    const kermitP = world.add('Kermit', { room: 38, inventory: [world.item('shillings', 1500), world.item('orc tooth', 10)] });
    const loial = keeper(world, loialP, { cfg, store });
    const kermit = keeper(world, kermitP, { cfg, store });
    const trip = { target: { room: 113, hops: 9 }, startedAt: Date.now() };

    const landed = await runUntil(() => trip.chalice?.stage === 'done', [
      async () => { world.tick(); if (!['done', 'off'].includes(trip.chalice?.stage)) await kermit.chaliceRide(trip); },
      async () => { await loial.chaliceDuty(); },
    ]);
    ok(landed, `Kermit landed (stage ${trip.chalice?.stage}, why ${trip.chalice?.why ?? '-'})`);
    ok(kermitP.room === GUILD_HALL_ROOM, 'in the guild hall');
    ok(!has(world, kermitP, /chalice/i), 'without the cup');
    const back = await runUntil(() => has(world, loialP, /chalice/i) && loialP.room === 38 && !loial._chaliceServe,
      [async () => { await loial.chaliceDuty(); }]);
    ok(back, `Loial picked it up and is back at his post (room ${loialP.room})`);
    ok(coins(world, loialP) === 300, `tipped the standard 300 (got ${coins(world, loialP)})`);
    ok(coins(world, kermitP) === 1200, 'out of Kermit\'s purse');
    ok(store.read().tickets.every(t => t.status === 'done'), 'the ticket is done');
    ok(kermit.events.some(e => e.what === 'landed' && e.guild_hall), 'the landing is recorded as the guild hall');
    ok(trip.target.hops === 9, 'the onward leg is re-ranked from where it landed');
  }

  // ---------------------------------------------------------------------------------------
  section('a broke farmer still rides — offer-nothing');
  {
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'two' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, post_room: 38 });
    const loialP = world.add('Loial the Ogier', { room: 38, inventory: [world.item('chalice of the rain')] });
    const pepeP = world.add('Pepe', { room: 38, inventory: [world.item('shillings', 350)] });
    const loial = keeper(world, loialP, { cfg, store });
    const pepe = keeper(world, pepeP, { cfg, store });
    const trip = { target: { room: 113, hops: 9 } };
    await runUntil(() => trip.chalice?.stage === 'done', [
      async () => { world.tick(); if (!['done', 'off'].includes(trip.chalice?.stage)) await pepe.chaliceRide(trip); },
      async () => { await loial.chaliceDuty(); },
    ]);
    ok(pepeP.room === GUILD_HALL_ROOM, 'landed');
    ok(coins(world, pepeP) === 350, 'kept every shilling it needed for walking money');
    ok(pepe.events.some(e => e.what === 'tip' && e.amount === 0 && /offer-nothing/.test(e.why)), 'and the ledger says offer-nothing');
  }

  // ---------------------------------------------------------------------------------------
  section('nobody serving: the trip walks, and says why');
  {
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'three' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, post_room: 38 });
    store.setDuty({ with: 'Loial the Ogier', lost: true });
    const gonzoP = world.add('Gonzo', { room: 38 });
    const gonzo = keeper(world, gonzoP, { cfg, store });
    const trip = { target: { room: 113, hops: 9 } };
    const r = await gonzo.chaliceRide(trip);
    ok(r.skip && /nobody is on chalice duty/.test(r.why), `skipped: ${r.why}`);
    ok(gonzoP.room === 38, 'and never walked to the station for nothing');
  }

  section('the holder never comes: the traveller walks after its wait');
  {
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'four' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, post_room: 38 });
    const zootP = world.add('Zoot', { room: 38 });
    const zoot = keeper(world, zootP, { cfg, store });
    const trip = { target: { room: 113, hops: 9 } };
    for (let i = 0; i < 4; i++) await zoot.chaliceRide(trip);
    ok(trip.chalice.stage === 'wait', `waiting at the station (${trip.chalice.stage})`);
    trip.chalice.deadline = Date.now() - 1;
    const r = await zoot.chaliceRide(trip);
    ok(r.skip && /nobody brought/.test(r.why), `gave up: ${r.why}`);
    ok(store.read().tickets.every(t => t.status === 'abandoned'), 'and withdrew the ticket so nobody arrives to serve a ghost');
  }

  // ---------------------------------------------------------------------------------------
  section('the holder leaves: relief to the alternate, who serves and does not farm, then returns it');
  {
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'five' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', alternate: 'Rizzo', station_room: 2, post_room: 38,
      handover_below_casts: 12 });
    const loialP = world.add('Loial the Ogier', { room: 38, inventory: [world.item('chalice of the rain')] });
    const rizzoP = world.add('Rizzo', { room: 39, inventory: [world.item('shillings', 100)] });
    const loial = keeper(world, loialP, { cfg, store, casts: 8 });
    const rizzo = keeper(world, rizzoP, { cfg, store });

    const relieved = await runUntil(() => has(world, rizzoP, /chalice/i), [
      async () => { await loial.chaliceDuty(); },
      async () => { await rizzo.chaliceDuty(); },
    ]);
    ok(relieved, 'Rizzo took the cup from Loial');
    ok(rizzoP.room === 38, 'at Loial\'s post, where Loial was standing');
    ok(store.duty().with === 'Rizzo' && store.duty().holder_away === true, 'duty records Rizzo on, Loial away');

    // Loial leaves on his supply trip.
    loialP.room = 104;
    const parked = await rizzo.chaliceDuty();
    ok(parked === true, 'the alternate on duty is HANDLED every pass — so no farm and no town trip');
    ok(rizzo.hold?.parked, 'and it holds a safe spot');

    // A farmer rides, served by Rizzo.
    const kermitP = world.add('Kermit', { room: 38, inventory: [world.item('shillings', 1000)] });
    const kermit = keeper(world, kermitP, { cfg, store });
    const trip = { target: { room: 113, hops: 9 } };
    await runUntil(() => trip.chalice?.stage === 'done', [
      async () => { world.tick(); if (!['done', 'off'].includes(trip.chalice?.stage)) await kermit.chaliceRide(trip); },
      async () => { await rizzo.chaliceDuty(); },
    ]);
    ok(kermitP.room === GUILD_HALL_ROOM, `Kermit rode home on Rizzo's watch (${trip.chalice?.stage}, ${trip.chalice?.why ?? ''})`);
    await runUntil(() => has(world, rizzoP, /chalice/i) && !rizzo._chaliceServe, [async () => { await rizzo.chaliceDuty(); }]);
    ok(has(world, rizzoP, /chalice/i), 'and Rizzo has the cup back');
    ok(coins(world, rizzoP) === 400, `the tip went to whoever served (${coins(world, rizzoP)})`);

    // Loial comes back restocked and asks for it.
    loialP.room = 38; loial._casts = 60;
    const home = await runUntil(() => has(world, loialP, /chalice/i), [
      async () => { await loial.chaliceDuty(); },
      async () => { await rizzo.chaliceDuty(); },
    ]);
    ok(home, 'Loial has the cup again');
    ok(store.duty().with === 'Loial the Ogier' && store.duty().holder_away === false, 'and the duty says so');
    const free = await rizzo.chaliceDuty();
    ok(free === false, 'Rizzo is released back to farming');
  }

  // ---------------------------------------------------------------------------------------
  section('services and supply: uncursed and revealed at the station, donates, restocks from the chest');
  {
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'seven' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, post_room: 2,
      holder_supply: { elderberry: 200, emerald: 110, 'orc tooth': 30 } });
    const loialP = world.add('Loial the Ogier', { room: 2, inventory: [world.item('chalice of the rain'),
      world.item('elderberry', 100), world.item('emerald', 110), world.item('orc tooth', 9)] });
    const ring = world.item('ring of lethargy'); ring.rarity = 200;
    const sword = world.item('long sword'); sword.rarity = 100;
    const kermitP = world.add('Kermit', { room: 38, inventory: [world.item('shillings', 1000), ring, sword,
      world.item('elderberry', 90), world.item('orc tooth', 12)] });
    kermitP.client.equipment = () => ({ equipped: [{ id: ring.id }] });
    const loial = keeper(world, loialP, { cfg, store });
    const kermit = keeper(world, kermitP, { cfg, store });
    kermit.carryFloors = () => ({});
    kermit.policy.guildWants = { enabled: true };
    const cast = [];
    loial.chaliceCast = async (name, target) => {
      cast.push({ name, target });
      if (name === 'remove curse') ring.rarity = 0;
      if (name === 'reveal') for (const it of world.floor.get(2) ?? []) if (it.id === target) it.rarity = 0;
      return { cast: true };
    };
    kermit.withdrawFromStockpile = async (need) => {
      for (const { item, amount } of need) kermitP.client.inventory.push(world.item(item, amount));
      return { took: need };
    };
    await loial.chaliceDuty();                         // publishes the supply
    ok(store.supply().target?.elderberry === 200, 'the holder published its supply and target');
    const trip = { target: { room: 113, hops: 9 } };
    await runUntil(() => trip.chalice?.stage === 'done', [
      async () => { world.tick(); if (!['done', 'off'].includes(trip.chalice?.stage)) await kermit.chaliceRide(trip); },
      async () => { await loial.chaliceDuty(); },
    ]);
    ok(kermitP.room === GUILD_HALL_ROOM, `landed (${trip.chalice?.stage} ${trip.chalice?.why ?? ''})`);
    ok(cast.some(c => c.name === 'remove curse' && c.target === kermitP.self.id), 'remove curse was cast on the traveller');
    ok(ring.rarity !== 200, 'and the ring is no longer cursed');
    ok(cast.some(c => c.name === 'reveal' && c.target === sword.id), 'reveal was cast on the sword where it lay');
    ok(kermitP.client.inventory.some(x => x.id === sword.id), 'and the traveller picked its sword back up');
    const loialBerries = loialP.client.inventory.filter(x => world.nameOf(x) === 'elderberry').reduce((a, x) => a + x.amount, 0);
    ok(loialBerries > 100, `spare berries were donated (${loialBerries})`);
    const teeth = loialP.client.inventory.filter(x => world.nameOf(x) === 'orc tooth').reduce((a, x) => a + x.amount, 0);
    ok(teeth >= 21, `and all twelve spare orc teeth, which pay for reveals (${teeth})`);
    ok(kermit._holderCargo, `landing in the hall, it took on a restock (${JSON.stringify(kermit._holderCargo?.items ?? null)})`);
    ok(store.supply().pledged?.some(p => p.by === 'Kermit'), 'and pledged it, so nobody doubles it');

    // Back from town: the road to the castle passes the station.
    const cargo = { ...kermit._holderCargo.items };
    kermit.townTrip = null;
    const before = Object.fromEntries(Object.keys(cargo).map(k =>
      [k, loialP.client.inventory.filter(x => world.nameOf(x) === k).reduce((a, x) => a + x.amount, 0)]));
    await runUntil(() => !kermit._holderCargo, [async () => { await kermit.chaliceDeliverCargo(); }], { limit: 20 });
    ok(!kermit._holderCargo, 'the restock was delivered');
    ok(Object.keys(cargo).every(k => loialP.client.inventory.filter(x => world.nameOf(x) === k)
      .reduce((a, x) => a + x.amount, 0) >= before[k] + cargo[k]), 'every unit of it reached the holder');
    ok(!store.supply().pledged?.some(p => p.by === 'Kermit'), 'and the pledge is released');
  }

  // ---------------------------------------------------------------------------------------
  section('forces of light on request: an occupant asks, the holder steps in, casts, steps out');
  {
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'six' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, post_room: 2, fol_room: 38 });
    const loialP = world.add('Loial the Ogier', { room: 2, inventory: [world.item('chalice of the rain')] });
    const kermitP = world.add('Kermit', { room: 38 });
    const loial = keeper(world, loialP, { cfg, store });
    const kermit = keeper(world, kermitP, { cfg, store });
    let casts = 0, castIn = null;
    loial.chaliceFit = () => true;
    loial.busyStatus = () => null;
    loial.roomEnchant = async ({ remote } = {}) => { casts++; castIn = loialP.room; return remote ? { cast: true, holdMs: 60_000, casts_left: 99 } : undefined; };

    ok(await loial.chaliceDuty() === false, 'nobody asked: the holder stays at its post and casts nothing');
    ok(loialP.room === 2 && casts === 0, 'still in room 2');
    kermit.chaliceFolWatch();
    ok(store.read().tickets.some(t => t.kind === 'fol' && t.status === 'open'), 'an occupant of 38 with no lit clock asks');
    const lit = await runUntil(() => casts > 0 && loialP.room === 2 && !loial._chaliceServe, [async () => { await loial.chaliceDuty(); }]);
    ok(lit, 'the holder went in, cast, and came back to room 2');
    ok(castIn === 38, `and the cast was made in 38 (was ${castIn})`);
    ok(casts === 1, 'one paid cast is enough');
    ok(store.fol().until > Date.now() + 50_000, 'the shared clock says lit for the cast duration');
    ok(store.read().tickets.filter(t => t.kind === 'fol').every(t => t.status === 'done'), 'every request for it is closed');
    kermit._folLookedAt = 0; kermit._folAskedAt = 0;
    kermit.chaliceFolWatch();
    ok(!store.read().tickets.some(t => t.kind === 'fol' && t.status === 'open'), 'and a lit room is not asked for again');

    // Hurt, or mid-errand: no trip into the room.
    store.litFol({ room: 38, until: 0, by: 'x' });
    kermit._folLookedAt = 0; kermit._folAskedAt = 0; kermit.chaliceFolWatch();
    loial.chaliceFit = () => false;
    await loial.chaliceDuty();
    ok(loialP.room === 2 && casts === 1, 'a holder under its flee line does not step in');
    // A cast that never pays (already infused, or declined): four tries, then lit-for-a-while
    // on the shared clock -- never a time in the past that brings it straight back in.
    loial.chaliceFit = () => true;
    loial.roomEnchant = async () => { casts++; return { cast: false, why: 'refused' }; };
    await runUntil(() => loialP.room === 2 && !loial._chaliceServe && casts >= 5, [async () => { await loial.chaliceDuty(); }]);
    ok(casts === 5, `gave up after four unpaid attempts (${casts - 1})`);
    ok(store.fol().until > Date.now() + 20_000, 'and the shared clock is in the future, so nobody asks again at once');
    loial.roomEnchant = async ({ remote } = {}) => { casts++; castIn = loialP.room; return remote ? { cast: true, holdMs: 60_000, casts_left: 99 } : undefined; };
    store.litFol({ room: 38, until: 0, by: 'x' });
    kermit._folLookedAt = 0; kermit._folAskedAt = 0; kermit.chaliceFolWatch();
    const c0 = casts;
    loial.chaliceFit = () => true; loial.busyStatus = () => ({ by: 'dum' });
    await loial.chaliceDuty();
    ok(loialP.room === 2 && casts === c0, 'nor while its own supply errand owns the body');
    // A RAID THAT POSTS THE HOLDER ELSEWHERE still stands it down — but by the OPERATION it
    // declares, not by the faculties it owns. A fleetscript marks the character busy before its
    // first step, and the board reports that as a commitment that is not takeable.
    loial.busyStatus = () => null;
    loial.errand = { kind: 'lootrun' };
    await loial.chaliceDuty();
    ok(loialP.room === 2 && casts === c0, 'nor while a raid holds the body for an operation');
    ok(store.duty().paused === true, 'and the duty record says it is not serving, so travellers walk');
    delete loial.errand;
    // AND THE CASE THAT WAS BROKEN FOR A DAY. A bare bot claim is OWNERSHIP, not an operation —
    // the board marks it `takeable`, and m59-commitment.mjs's header says conflating the two
    // deadlocks the bot that asked for it. DUM claims work and movement on every character it
    // manages for its whole run, so reading that as "somebody else is driving" meant the
    // ALTERNATE could never take a relief ticket, and the holder's supply trip left the castle
    // carrying the fleet's only chalice (prod, 2026-09-24).
    loial.facultyHeld = f => f === 'work' || f === 'movement';
    await loial.chaliceDuty();
    ok(store.duty().paused === false, 'a bare bot claim is ownership, not an operation — still serving');
    // AND A PAUSE SURVIVES A RESTART, so it has to be cleared from the RECORD rather than from a
    // flag in the process that set it. A keeper that died while paused used to leave
    // `paused: true` on disk with nothing left in memory to clear it, and `servingCharacter`
    // reads that as nobody on duty, for ever.
    store.setDuty({ paused: true });
    delete loial._chalicePausedSaid;
    await loial.chaliceDuty();
    ok(store.duty().paused === false, 'a pause left behind by a dead keeper is cleared by the next one');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
