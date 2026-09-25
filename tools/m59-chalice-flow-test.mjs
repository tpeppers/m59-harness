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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Autopilot } from './m59-autopilot.mjs';
import { OF } from './m59-parse.mjs';
import { ChaliceStore, normalizeChalice, GUILD_HALL_ROOM } from './m59-chalice.mjs';
import * as party from './m59-party.mjs';

// THE FLEET, for the human desk's fleetmate gate. Stranger is deliberately absent.
party.setRosterSource(() => new Set(['Loial the Ogier', 'Rizzo', 'Kermit', 'Pepe', 'Gonzo', 'Zoot',
  'Beaker', 'Bunsen', 'Animal', 'Floyd', 'Janice', 'Lew', 'Scooter', 'Statler', 'Clifford', 'Rowlf', 'Robin']));

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) { pass++; console.log('  ok  ', what); } else { fail++; console.log('  FAIL', what); } };
const section = (s) => console.log(`\n${s}`);

// ------------------------------------------------------------------------------ the world
function makeWorld() {
  let nextId = 5000;
  const names = new Map();              // rsc -> name
  const rsc = (name) => { const r = 90000 + names.size; names.set(r, name); return r; };
  const world = { players: new Map(), floor: new Map(), names, landings: [], counters: new Map(), tells: [] };
  // A COUNTER: what one merchant room sells and for how much. Enough for chaliceBuyCargo,
  // which opens a shop, matches a row by name and buys it.
  world.counter = (room, items) => world.counters.set(room, { sellerId: 7000 + room,
    items: items.map(([name, cost]) => ({ id: nextId++, name, cost })) });
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
      buy(_sellerId) { client._openShop = world.counters.get(p.room) ?? null; },
      buyItems(_sellerId, lines) {
        const shop = client._openShop; if (!shop) return;
        for (const line of [].concat(lines)) {
          const row = shop.items.find(i => i.id === line.id); if (!row) continue;
          const purse = client.inventory.find(x => /shilling/i.test(world.nameOf(x)));
          // THE COUNTER CLAMPS TO THE PURSE and reports success either way, which is the
          // whole reason the caller judges itself on the pack.
          const afford = row.cost > 0 ? Math.floor((purse?.amount ?? 0) / row.cost) : line.amount;
          const take = Math.min(line.amount, afford); if (take <= 0) continue;
          if (purse) purse.amount -= take * row.cost;
          const into = client.inventory.find(x => world.nameOf(x) === row.name);
          if (into) into.amount += take; else client.inventory.push(world.item(row.name, take));
        }
      },
      // TELLS: the who list is everybody in the world; a tell is recorded and echoed.
      players() {},
      get playersOnline() {
        return new Map([...world.players.values()].map(q => [q.self.id, { id: q.self.id, name: q.name }]));
      },
      sayGroup(ids, text) {
        for (const id of ids) {
          const to = [...world.players.values()].find(q => q.self.id === id);
          if (to) world.tells.push({ from: name, to: to.name, text, at: Date.now() });
        }
        client._said = text;
      },
      offer(toId, items) { client._offer = { toId, items }; },
      cancelOffer() { client._offer = null; },
      async waitFor({ kinds = [] } = {}) {
        if (kinds.includes('said') && client._said != null) {
          const text = client._said; client._said = null;
          return { events: [{ kind: 'said', speaker: client.selfId, text }] };
        }
        if (kinds.includes('countered') && client._offer) {
          const to = [...world.players.values()].find(q => q.self.id === client._offer.toId);
          if (to && to.room === p.room && to.client.accepts) return { events: [{ kind: 'countered' }] };
          return { events: [] };
        }
        if (kinds.includes('shop') && client._openShop)
          return { events: [{ kind: 'shop', sellerId: client._openShop.sellerId,
                              items: client._openShop.items }] };
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

  // ---------------------------------------------------------------------------------------
  section("the town trip buys the holder's restock and tips it on the way home");
  {
    // THE OPERATOR'S ORDER, 2026-09-24. The chest draw only ever runs for a traveller that
    // rode the chalice and landed in the hall — measured that day the chest held 4,551
    // elderberries and had been drawn from ZERO times, because no ride had ever completed.
    // Buying on the ordinary town trip needs no ride at all.
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'buy' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, post_room: 2,
      holder_supply: { elderberry: 200, emerald: 110 },
      supply_shops: { elderberry: { room: 104, seller: 'Joguer' },
                      emerald: { room: 109, seller: 'Herbutte' } },
      restock_per_trip: 60, restock_budget: 3000 });
    world.counter(104, [['elderberry', 10], ['herbs', 8]]);
    world.counter(109, [['emerald', 20]]);
    const loialP = world.add('Loial the Ogier', { room: 2, inventory: [
      world.item('chalice of the rain'), world.item('elderberry', 21), world.item('emerald', 24)] });
    const kermitP = world.add('Kermit', { room: 104, inventory: [world.item('shillings', 5000)] });
    const loial = keeper(world, loialP, { cfg, store });
    const kermit = keeper(world, kermitP, { cfg, store });
    kermit.sellerHere = async () => ({ seller: { id: 1 } });
    kermit.makeRoomToBuy = async () => {};
    await loial.chaliceDuty();                       // publishes have/target
    ok(store.supply().have?.elderberry === 21, 'the holder published what it is short of');

    await kermit.chaliceBuyCargo();
    const bought = kermit._holderCargo?.items ?? {};
    ok(bought.elderberry === 60 && bought.emerald === 60,
       `both halves bought, capped at restock_per_trip (${JSON.stringify(bought)})`);
    // THE TWO COUNTERS ARE NOT ONE MERCHANT. A traveller that stopped at the apothecary only
    // would come home with berries and no gem, and the gem is the half that binds.
    ok(kermitP.room === 109, 'and it walked to the second counter for the half the first does not stock');
    ok(store.supply().pledged?.some(p => p.by === 'Kermit'), 'pledged, so a second traveller does not double it');
    ok(kermit.events.some(e => e.what === 'cargo_bought'), 'and it is on the ledger');

    // ...then handed over at the station on the way back, by the same path the chest draw uses.
    kermit.townTrip = null;
    const before = loialP.client.inventory.filter(x => world.nameOf(x) === 'elderberry')
      .reduce((a, x) => a + x.amount, 0);
    await runUntil(() => !kermit._holderCargo, [async () => { await kermit.chaliceDeliverCargo(); }], { limit: 20 });
    ok(!kermit._holderCargo, 'the restock was delivered');
    const after = loialP.client.inventory.filter(x => world.nameOf(x) === 'elderberry')
      .reduce((a, x) => a + x.amount, 0);
    ok(after >= before + 60, `and the holder has the berries (${before} -> ${after})`);
  }

  // ---------------------------------------------------------------------------------------
  section("buying the holder's restock never spends what the trip itself needs");
  {
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'budget' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, post_room: 2,
      holder_supply: { elderberry: 200 },
      supply_shops: { elderberry: { room: 104, seller: 'Joguer' } },
      restock_per_trip: 60, restock_budget: 3000 });
    world.counter(104, [['elderberry', 10]]);
    const loialP = world.add('Loial the Ogier', { room: 2, inventory: [
      world.item('chalice of the rain'), world.item('elderberry', 21)] });
    const loial = keeper(world, loialP, { cfg, store });
    await loial.chaliceDuty();

    // A PURSE THAT IS ALL WALKING MONEY BUYS THE HOLDER NOTHING. The character's own float is
    // a floor, not a share: a fleet that tips itself broke stops farming, and a holder with no
    // farmers has nothing to serve.
    const brokeP = world.add('Statler', { room: 104, inventory: [world.item('shillings', 350)] });
    const broke = keeper(world, brokeP, { cfg, store });
    broke.sellerHere = async () => ({ seller: { id: 1 } });
    broke.makeRoomToBuy = async () => {};
    await broke.chaliceBuyCargo();
    ok(!broke._holderCargo, 'nothing was bought out of the walking money');
    ok(broke.notes.some(n => /nothing to spare/.test(n.what)), 'and it said so rather than going quiet');

    // AND THE BUDGET IS A CEILING, not a suggestion: 3000 at 10 a berry is 300, but the
    // per-trip cap is 60, and the tighter of the two wins.
    const richP = world.add('Waldorf', { room: 104, inventory: [world.item('shillings', 50_000)] });
    const rich = keeper(world, richP, { cfg, store });
    rich.sellerHere = async () => ({ seller: { id: 1 } });
    rich.makeRoomToBuy = async () => {};
    await rich.chaliceBuyCargo();
    ok(rich._holderCargo?.items?.elderberry === 60, 'a rich traveller still buys only its share');
    const spent = 50_000 - richP.client.inventory.find(x => /shilling/i.test(world.nameOf(x))).amount;
    ok(spent === 600, `and paid for exactly what arrived (${spent})`);
  }


  // ---------------------------------------------------------------------------------------
  section('every ride decision is recorded, including the ones that walk');
  {
    // 105 chalice events in one live day contained not a single ride decision, because a
    // decline at `decide` set the stage to 'off' and returned in silence. So the ledger could
    // not tell "considered the chalice and correctly walked" from "never considered it" — and
    // that is the failure mode this whole game has anyway, without a bot adding to it.
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'decline' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, post_room: 2 });
    const loialP = world.add('Loial the Ogier', { room: 2, inventory: [world.item('chalice of the rain')] });
    const farP = world.add('Statler', { room: 578, inventory: [world.item('shillings', 900)] });
    const loial = keeper(world, loialP, { cfg, store });
    const far = keeper(world, farP, { cfg, store });
    await loial.chaliceDuty();                            // somebody IS on duty
    // The Cragged Mountains are eleven hops from the station: correct to walk.
    far.hopsTo = (room) => (Number(room) === 2 ? 11 : 9);
    const trip = { target: { room: 113, hops: 9 } };
    const out = await far.chaliceRide(trip);
    ok(out.skip, 'it walks');
    ok(/11 hops away/.test(out.why), 'for the right reason: ' + out.why);
    const declined = far.events.filter(e => e.what === 'ride_declined');
    ok(declined.length === 1, `and the decision is on the ledger (${declined.length})`);
    ok(declined[0]?.station_hops === 11, 'with the distance that decided it');
    ok(far.notes.some(n => /ride declined/.test(n.what)), 'and in the keeper notes');
  }

  // ---------------------------------------------------------------------------------------
  section('a traveller that just swung at a player does not set out at all');
  {
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'pvp' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, post_room: 2 });
    const loialP = world.add('Loial the Ogier', { room: 2, inventory: [world.item('chalice of the rain')] });
    const kermitP = world.add('Kermit', { room: 38, inventory: [world.item('shillings', 900)] });
    const loial = keeper(world, loialP, { cfg, store });
    const kermit = keeper(world, kermitP, { cfg, store });
    await loial.chaliceDuty();

    // THE STAMP IS OUR OWN SWING, because `GetLastPlayerAttackTime` is server-side and nothing
    // sends it to us. `notePlayerSwing` is called wherever a swing is aimed at a person.
    kermit.notePlayerSwing();
    ok(Number.isFinite(kermit.lastPlayerSwingAt()), 'the swing is remembered');
    const trip = { target: { room: 113, hops: 9 } };
    const out = await kermit.chaliceRide(trip);
    ok(out.skip, 'so it does not set out');
    ok(/chalice refuses a sip/.test(out.why), 'naming the ban: ' + out.why);
    ok(kermitP.room === 38, 'and it never left the room, let alone walked to the station');
    const ev = kermit.events.find(e => e.what === 'ride_declined');
    ok(ev && ev.wait_ms > 0, `the ledger says how long is left (${ev?.wait_ms ?? '-'}ms)`);
    // AND IT COMES BACK. The ban lapses; nothing has to be reset by hand.
    kermit._lastPlayerAttackAt = Date.now() - (10 * 60_000 + 1000);
    kermit.s.lastPlayerAttackAt = kermit._lastPlayerAttackAt;
    const trip2 = { target: { room: 113, hops: 9 } };
    const again = await kermit.chaliceRide(trip2);
    ok(!again.skip, 'once it has lapsed the ride is on again');
  }

  // ---------------------------------------------------------------------------------------
  section('hopsTo reads the route the World actually returns');
  // Every keeper above stubs `hopsTo` with a number, and that stub is why this passed while
  // prod declined every ride as "no route to the station": `World.route` answers `hops` as
  // the LIST of hops, and the method tested that list with Number.isFinite.
  {
    const ap = Object.create(Autopilot.prototype);
    const routes = {
      2: { found: true, hops: [{ from: 38, to: 39 }, { from: 39, to: 2 }] },
      38: { found: true, hops: [] },
      77: { found: false, reason: 'no path' },
    };
    ap.s = { world: { route: (n) => routes[n] ?? { found: false } } };
    ok(ap.hopsTo(2) === 2, 'hopsTo counts the hops World.route returns as a list (got ' + ap.hopsTo(2) + ')');
    ok(ap.hopsTo(38) === 0, 'standing in the room is zero hops, not "no route"');
    ok(ap.hopsTo(77) === null, 'no route is null');
    ap.s = { world: { route: () => { throw new Error('a snapshot, not a World'); } } };
    ok(ap.hopsTo(2) === null, 'a World that cannot answer is null, never a number');
  }

  // =======================================================================================
  // THE HUMAN DESK (operator, 2026-09-25). A PERSON plays Loial: no keeper runs for him, the
  // broker's mark in the store says so, and this test drives his hands the way a person would
  // — reading tells, offering the cup, picking it up off the floor.
  // =======================================================================================
  const personAt = (store, name) => store.setHuman(name, { agent: 'hk1', pid: process.pid });
  // One pass of a person at Loial's keyboard: answer a chalice tell by offering the cup to
  // whoever sent it (if they are here), and pick the cup up when it is on the floor.
  const personHands = (world, meP, { offer = true } = {}) => async () => {
    const c = meP.client;
    const cup = c.inventory.find(x => /chalice/i.test(world.nameOf(x)));
    const ask = world.tells.find(t => t.to === meP.name && /\[Service Request\] ~b chalice/.test(t.text) && !t.seen);
    if (offer && cup && ask) {
      const them = world.players.get(ask.from);
      if (them && them.room === meP.room) {
        ask.seen = true;
        c.offer(them.self.id, [cup.id]);
        const ev = await c.waitFor({ kinds: ['countered'] });
        if (ev.events.some(e => e.kind === 'countered')) c.acceptOffer();
      }
    }
    const floor = world.floor.get(meP.room) ?? [];
    const i = floor.findIndex(x => /chalice/i.test(world.nameOf(x)));
    if (i >= 0) c.inventory.push(...floor.splice(i, 1));
  };

  section('a person plays Loial: the ride is asked for by tell, handed by hand, and nothing is tipped');
  {
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'human-ride' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, post_room: 2 });
    const loialP = world.add('Loial the Ogier', { room: 2, inventory: [world.item('chalice of the rain')] });
    // HIS KEEPER'S LAST WORDS before the login displaced it: paused, and about to go stale.
    store.setDuty({ with: 'Loial the Ogier', paused: true });
    personAt(store, 'Loial the Ogier');
    const kermitP = world.add('Kermit', { room: 38, inventory: [world.item('shillings', 1500)] });
    const kermit = keeper(world, kermitP, { cfg, store });
    const trip = { target: { room: 113, hops: 9 } };
    await runUntil(() => ['done', 'off'].includes(trip.chalice?.stage), [
      async () => { world.tick(); if (!['done', 'off'].includes(trip.chalice?.stage)) await kermit.chaliceRide(trip); },
      personHands(world, loialP),
    ]);
    ok(trip.chalice?.stage === 'done', `Kermit landed (stage ${trip.chalice?.stage}, why ${trip.chalice?.why ?? '-'})`);
    const tell = world.tells.find(t => t.from === 'Kermit' && t.to === 'Loial the Ogier');
    ok(tell?.text === '~B~k[Service Request] ~b chalice', `the tell is the operator's format (${tell?.text})`);
    ok(kermit.events.some(e => e.what === "desk_tell" && e.sent === true), `and the ledger says it was echoed (${JSON.stringify(kermit.events.filter(e => e.what === "desk_tell"))})`);
    ok(kermit.events.some(e => e.what === 'requested' && e.human), 'the request is marked as to a person');
    ok(kermit.events.some(e => e.what === 'received' && e.human && Number.isFinite(e.waited_ms)), 'so is the hand-over, with the wait');
    ok(coins(world, kermitP) === 1500, 'no tip: a person is not sent a second trade window');
    ok(kermit.events.some(e => e.what === 'tip' && e.human && e.amount === 0), 'and the ledger says why');
    await personHands(world, loialP)();
    ok(has(world, loialP, /chalice/i), 'the person picked the cup back up');
    ok(store.read().tickets.every(t => t.status === 'done'), 'the ticket is closed by the traveller, not left to expire');
  }

  section('"hold on" keeps the traveller waiting; "not now" sends it walking at once');
  {
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'human-hold' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, post_room: 2 });
    world.add('Loial the Ogier', { room: 2, inventory: [world.item('chalice of the rain')] });
    personAt(store, 'Loial the Ogier');
    const zootP = world.add('Zoot', { room: 38 });
    const zoot = keeper(world, zootP, { cfg, store });
    const trip = { target: { room: 113, hops: 9 } };
    for (let i = 0; i < 4 && trip.chalice?.stage !== 'wait'; i++) await zoot.chaliceRide(trip);
    ok(trip.chalice.stage === 'wait', `waiting for the person (${trip.chalice.stage})`);
    ok(trip.chalice.deadline - trip.chalice.requestedAt === cfg.human_wait_ms, 'a person gets human_wait_ms, not wait_ms');
    store.hold('Zoot', { by: 'Loial the Ogier', ms: cfg.human_hold_ms, maxMs: cfg.human_max_wait_ms });
    trip.chalice.deadline = Date.now() - 1;          // the first minute is up
    const r = await zoot.chaliceRide(trip);
    ok(!r.skip && trip.chalice.stage === 'wait', 'held: still waiting past the first minute');
    ok(zoot.events.some(e => e.what === 'desk_held'), 'and the hold is on the ledger');

    const trip2 = { target: { room: 113, hops: 9 } };
    const beakerP = world.add('Beaker', { room: 38 });
    const beaker = keeper(world, beakerP, { cfg, store });
    for (let i = 0; i < 4 && trip2.chalice?.stage !== 'wait'; i++) await beaker.chaliceRide(trip2);
    store.closeFrom('Beaker', 'abandoned', { by: 'Loial the Ogier', note: 'declined by Loial the Ogier' });
    const d = await beaker.chaliceRide(trip2);
    ok(d.skip && /said not now/.test(d.why), `walked at once: ${d.why}`);
    ok(beaker.events.some(e => e.what === 'ride_skipped' && e.declined), 'recorded as the person\'s decline');
  }

  section('an AFK person costs a minute, and says so; a person logging out hands back to the keeper');
  {
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'human-afk' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, post_room: 2 });
    world.add('Loial the Ogier', { room: 2, inventory: [world.item('chalice of the rain')] });
    personAt(store, 'Loial the Ogier');
    const gonzoP = world.add('Gonzo', { room: 38 });
    const gonzo = keeper(world, gonzoP, { cfg, store });
    const trip = { target: { room: 113, hops: 9 } };
    for (let i = 0; i < 4 && trip.chalice?.stage !== 'wait'; i++) await gonzo.chaliceRide(trip);
    trip.chalice.deadline = Date.now() - 1;
    const r = await gonzo.chaliceRide(trip);
    ok(r.skip && /played by a person\) did not hand/.test(r.why), `walked: ${r.why}`);
    ok(gonzo.events.some(e => e.what === 'ride_skipped' && e.human && Number.isFinite(e.waited_ms)),
       'the ledger row names the person and the wait — this is the "am I blocking" row');

    const trip2 = { target: { room: 113, hops: 9 } };
    const pepeP = world.add('Pepe', { room: 38 });
    const pepe = keeper(world, pepeP, { cfg, store });
    for (let i = 0; i < 4 && trip2.chalice?.stage !== 'wait'; i++) await pepe.chaliceRide(trip2);
    store.clearHuman('Loial the Ogier');
    await pepe.chaliceRide(trip2);
    ok(pepe.events.some(e => e.what === 'desk_human_left'), 'the logout is noticed mid-wait');
    ok(trip2.chalice.deadline - trip2.chalice.requestedAt >= cfg.wait_ms, 'and it now waits as for a keeper');
  }

  section('forces of light: five in the room is one tell to a person, not five');
  {
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'human-fol' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, post_room: 2, fol_room: 38 });
    world.add('Loial the Ogier', { room: 2, inventory: [world.item('chalice of the rain')] });
    personAt(store, 'Loial the Ogier');
    const farmers = ['Animal', 'Floyd', 'Janice', 'Lew', 'Scooter'].map(n => keeper(world, world.add(n, { room: 38 }), { cfg, store }));
    for (const f of farmers) f.chaliceFolWatch();
    await new Promise(r => setTimeout(r, 50));
    const tells = world.tells.filter(t => t.to === 'Loial the Ogier');
    ok(tells.length === 1, `one tell (${tells.length})`);
    ok(/forces of light \(38\)/.test(tells[0]?.text ?? ''), `naming the room (${tells[0]?.text})`);
    ok(store.read().tickets.filter(t => t.kind === 'fol').length === 5, 'every farmer still filed its ticket');
  }

  section('the reverse: a person asks bot Loial for remove curse, and he casts it on them');
  {
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'human-asks' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, post_room: 2 });
    const loialP = world.add('Loial the Ogier', { room: 2, inventory: [world.item('chalice of the rain'), world.item('emerald', 20)] });
    const loial = keeper(world, loialP, { cfg, store });
    const cast = [];
    loial.chaliceCast = async (name, target) => { cast.push({ name, target }); return { cast: true }; };
    // A keeper's own uncurse, filed during its ride, must stay with that ride.
    store.request('Kermit', { kind: 'uncurse', room: 2 });
    const bunsenP = world.add('Bunsen', { room: 39 });
    store.request('Bunsen', { kind: 'uncurse', room: 2, human: true });
    await loial.chaliceDuty();
    ok(loial._chaliceServe?.kind === 'desk', `he took the person's ticket (${loial._chaliceServe?.kind})`);
    ok(store.openFrom('Kermit', ['uncurse']).length === 1, 'and not the keeper\'s');
    await loial.chaliceDuty();
    ok(cast.length === 0, 'nothing is cast at an empty room');
    bunsenP.room = 2;
    await runUntil(() => !loial._chaliceServe, [async () => { await loial.chaliceDuty(); }], { limit: 20 });
    ok(cast.filter(c => c.name === 'remove curse' && c.target === bunsenP.self.id).length === 3, 'remove curse x3 on Bunsen');
    ok(loial.events.some(e => e.what === 'desk_served' && e.for === 'Bunsen'), 'recorded as served');
    ok(store.read().desk?.['loial the ogier']?.menu?.some(m => m.kind === 'uncurse'), 'and his menu is published for "services?"');
  }

  section('the reverse, chalice: a person is told what to do with the window, and given longer to do it');
  {
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'human-asks-ride' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, post_room: 2 });
    const loialP = world.add('Loial the Ogier', { room: 2, inventory: [world.item('chalice of the rain')] });
    const loial = keeper(world, loialP, { cfg, store });
    world.add('Bunsen', { room: 2 });
    let counterMs = null;
    const give = loial.chaliceGive.bind(loial);
    loial.chaliceGive = (to, items, o) => { counterMs = o.counterMs; return give(to, items, o); };
    store.request('Bunsen', { kind: 'ride', room: 2, human: true });
    await runUntil(() => loial.events.some(e => e.what === 'handed'), [async () => { await loial.chaliceDuty(); }], { limit: 20 });
    ok(counterMs === cfg.human_offer_ms, `the offer waits human_offer_ms for a person to counter (${counterMs})`);
    const told = world.tells.find(t => t.from === 'Loial the Ogier' && t.to === 'Bunsen');
    ok(/^~B~k\[Service\] ~b offering you the chalice/.test(told?.text ?? ''), `and says how (${told?.text})`);
    ok(loial.events.some(e => e.what === 'handed' && e.human), 'handed, marked as to a person');
  }

  section('fleetmates only: a person-filed ticket from a stranger is refused, not served');
  {
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'human-stranger' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, post_room: 2 });
    const loialP = world.add('Loial the Ogier', { room: 2, inventory: [world.item('chalice of the rain'), world.item('emerald', 20)] });
    const loial = keeper(world, loialP, { cfg, store });
    const cast = [];
    loial.chaliceCast = async (name, target) => { cast.push({ name, target }); return { cast: true }; };
    world.add('Stranger', { room: 2 });
    const t = store.request('Stranger', { kind: 'uncurse', room: 2, human: true });
    const r = store.request('Stranger', { kind: 'ride', room: 2, human: true });
    for (let i = 0; i < 4; i++) await loial.chaliceDuty();
    ok(cast.length === 0, 'nothing is cast for a stranger');
    ok(store.ticket(t.id).status === 'abandoned' && store.ticket(r.id).status === 'abandoned', 'both tickets closed');
    ok(has(world, loialP, /chalice/i), 'and the cup never left the pack');
    ok(loial.events.some(e => e.what === 'desk_refused' && /not a fleetmate/.test(e.why)), 'with the reason on the ledger');
    const told = await loial.chaliceTell('Stranger', 'chalice');
    ok(told.sent === false && /not a fleetmate/.test(told.why), `and no tell goes to one (${told.why})`);
    ok(!world.tells.some(x => x.to === 'Stranger'), 'none was sent');
  }

  // =======================================================================================
  // PROD 2026-09-25 18:24-18:26Z, REPLAYED. The operator played Loial; Rowlf and Zoot took the
  // cup, dropped unrevealed items, asked for reveal from a Loial with one orc tooth, and stood
  // holding the cup until the operator logged in as them.
  // =======================================================================================
  section('the prod stall: a person-served rider asks for no reveal, waits 30s for an uncurse, then drinks');
  {
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'stall-replay' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, post_room: 2 });
    const loialP = world.add('Loial the Ogier', { room: 2, inventory: [world.item('chalice of the rain'), world.item('orc tooth', 1)] });
    // His menu as his keeper last published it, before the login: reveal unavailable.
    store.setDesk('Loial the Ogier', { menu: [
      { kind: 'uncurse', label: 'Remove Curse', ok: true, why: null },
      { kind: 'reveal', label: 'Reveal', ok: false, why: 'Req. reagents' },
      { kind: 'ride', label: 'Chalice', ok: true, why: null }], room: 2 });
    personAt(store, 'Loial the Ogier');
    const wand = world.item('wand'); wand.rarity = 100;
    const ring = world.item('ring of lethargy'); ring.rarity = 200;
    const rowlfP = world.add('Rowlf', { room: 38, inventory: [wand, ring] });
    rowlfP.client.equipment = () => ({ equipped: [{ id: ring.id }] });
    const rowlf = keeper(world, rowlfP, { cfg, store });
    const trip = { target: { room: 113, hops: 9 } };
    // Up to the point the cup is in the pack and the services are asked.
    await runUntil(() => trip.chalice?.svc, [
      async () => { world.tick(); await rowlf.chaliceRide(trip); },
      personHands(world, loialP),
    ]);
    ok(rowlfP.client.inventory.some(x => x.id === wand.id), 'the wand stays in the pack — nothing dropped for a reveal');
    ok(!store.read().tickets.some(t => t.kind === 'reveal'), 'and no reveal is asked of a person');
    const tell = world.tells.filter(t => t.from === 'Rowlf').at(-1)?.text ?? '';
    ok(/remove curse — I drink in 30s; "done" or "not now" to go sooner/.test(tell), `the person is told the deadline and the way out (${tell})`);
    await rowlf.chaliceRide(trip);
    ok(trip.chalice.stage === 'services', 'waiting on the uncurse');
    trip.chalice.svc.at = Date.now() - cfg.human_service_ms - 1;   // the person does nothing for 30s
    await runUntil(() => trip.chalice?.stage === 'done', [async () => { world.tick(); await rowlf.chaliceRide(trip); }]);
    ok(rowlfP.room === GUILD_HALL_ROOM, `and then it drinks and lands without anybody logging in (${trip.chalice.stage})`);
    const ev = rowlf.events.find(e => e.what === 'services');
    ok(ev?.skipped?.some(s => s.service === 'reveal') && ev.human, 'the skipped reveal is on the ledger');
  }

  section('a keeper server whose menu says reveal is unavailable is not asked for one either');
  {
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'menu-gate' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, post_room: 2 });
    store.setDesk('Loial the Ogier', { menu: [{ kind: 'reveal', label: 'Reveal', ok: false, why: 'Req. reagents' }], room: 2 });
    const sword = world.item('long sword'); sword.rarity = 100;
    const kermitP = world.add('Kermit', { room: 2, inventory: [sword] });
    const kermit = keeper(world, kermitP, { cfg, store });
    const svc = kermit.chaliceAskServices(cfg, store, 'Kermit', { server: 'Loial the Ogier' });
    ok(!svc.asked.includes('reveal') && svc.dropped.length === 0, 'nothing dropped, nothing asked');
    ok(kermitP.client.inventory.some(x => x.id === sword.id), 'the sword stays in the pack');
    const none = kermit.chaliceAskServices(cfg, new ChaliceStore({ directory: dir, namespace: 'menu-none' }), 'Kermit', { server: 'Loial the Ogier' });
    ok(none.asked.includes('reveal'), 'with no menu published it asks, as it always did');
  }

  section('a rider displaced mid-wait does not "pick up" its items from the wrong room');
  {
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'displaced' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, post_room: 2 });
    const zootP = world.add('Zoot', { room: 714, inventory: [world.item('chalice of the rain')] });
    const zoot = keeper(world, zootP, { cfg, store });
    let looted = 0;
    zoot.s.lootFloor = async () => { looted++; return {}; };
    const trip = { target: { room: 113, hops: 9 }, chalice: { stage: 'services', server: 'Loial the Ogier',
      svc: { asked: ['reveal'], dropped: [9121, 8906, 8830], droppedIn: 2, skipped: [], at: Date.now() - 999_999 } } };
    await zoot.chaliceRide(trip);
    ok(looted === 0, 'no loot attempted in the guild hall');
    ok(zoot.events.some(e => e.what === 'services_items_left' && e.left_in === 2 && e.ids.length === 3),
       'and the three items left in room 2 are on the ledger');
  }

  // =======================================================================================
  // THE RETURN-TRIP RESTOCK, 2026-09-25: never delivered once on prod.
  // =======================================================================================
  section('withdrawFromStockpile no longer throws before its first step (the snapshot crash)');
  // A CHILD PROCESS, because the chest cache's directory is fixed when m59-storage.mjs loads.
  // The chest is seeded with what the draw asks for; without that it returns before the line
  // that crashed, and the test would pass against the bug (it did, the first time it was written).
  {
    const storage = join(dir, 'storage');
    mkdirSync(join(storage, 'chests'), { recursive: true });
    writeFileSync(join(storage, 'chests', 'r18c2.json'), JSON.stringify({ slot: 'r18c2', row: 18, col: 2,
      room: GUILD_HALL_ROOM, items: [{ name: 'orc tooth', amount: 162 }] }));
    const probe = `
      import { Autopilot } from ${JSON.stringify(new URL('./m59-autopilot.mjs', import.meta.url).href)};
      const ap = Object.create(Autopilot.prototype);
      ap.policy = {}; ap.tally = {}; ap.note = () => {};
      ap.s = { name: 'probe', client: { guild: { id: 1, rank: 3 }, inventory: [], rsc: { get: () => '' } },
               need() { return this.client; } };
      ap.who = () => 'Janice';
      let travelled = false;
      ap.travel = async () => { travelled = true; return { arrived: false, reason: 'the test stops here' }; };
      try { await ap.withdrawFromStockpile([{ item: 'orc tooth', amount: 29 }]); console.log(JSON.stringify({ travelled })); }
      catch (e) { console.log(JSON.stringify({ threw: e.message })); }`;
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', probe],
      { env: { ...process.env, M59_STORAGE_DIR: storage }, encoding: 'utf8', timeout: 60_000 });
    const line = (out.stdout || '').trim().split(/\r?\n/).filter(l => l.startsWith('{')).pop() ?? '{}';
    const r = JSON.parse(line);
    ok(!r.threw, `the draw does not throw (${r.threw ?? 'no throw'})`);
    ok(r.travelled === true, 'it planned a draw from the seeded chest and set off for it');
  }

  section('a draw that fails releases its pledge, so the next traveller still sees the shortfall');
  {
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'pledge-leak' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, holder_supply: { 'orc tooth': 50 } });
    store.setSupply({ have: { 'orc tooth': 1 }, target: { 'orc tooth': 50 } });
    const janice = keeper(world, world.add('Janice', { room: GUILD_HALL_ROOM }), { cfg, store });
    janice.policy.guildWants = { enabled: true };
    janice.withdrawFromStockpile = async () => { throw new ReferenceError('snapshot is not defined'); };
    await janice.chaliceTakeCargo(cfg, store);
    ok(!(store.supply().pledged ?? []).some(p => p.by === 'Janice'), 'no pledge left behind by the crash');
    ok(janice.events.some(e => e.what === 'cargo_draw_failed' && /snapshot/.test(e.why)), 'and the ledger says why');
    const zoot = keeper(world, world.add('Zoot', { room: 2, inventory: [world.item('orc tooth', 40)] }), { cfg, store });
    zoot.carryFloors = () => ({ 'orc tooth': 10 });
    const gift = zoot.chaliceDonation(store);
    ok(gift['orc tooth'] === 30, `so the next traveller donates its spare teeth (${JSON.stringify(gift)})`);

    const pepe = keeper(world, world.add('Pepe', { room: GUILD_HALL_ROOM }), { cfg, store });
    pepe.policy.guildWants = { enabled: true };
    pepe.withdrawFromStockpile = async () => ({ took: [], why: 'no chest holds any' });
    await pepe.chaliceTakeCargo(cfg, store);
    ok(pepe.events.some(e => e.what === 'cargo_none' && e.why === 'no chest holds any'), 'an empty draw is a row too');
  }

  section('a draw that works is carried home and handed over at the station');
  {
    const world = makeWorld();
    const store = new ChaliceStore({ directory: dir, namespace: 'cargo-ok' });
    const cfg = normalizeChalice({ holder: 'Loial the Ogier', station_room: 2, post_room: 2, holder_supply: { 'orc tooth': 50 } });
    const loialP = world.add('Loial the Ogier', { room: 2, inventory: [world.item('orc tooth', 1)] });
    store.setSupply({ have: { 'orc tooth': 1 }, target: { 'orc tooth': 50 } });
    const robinP = world.add('Robin', { room: GUILD_HALL_ROOM });
    const robin = keeper(world, robinP, { cfg, store });
    robin.policy.guildWants = { enabled: true };
    robin.withdrawFromStockpile = async (need) => {
      for (const { item, amount } of need) robinP.client.inventory.push(world.item(item, amount));
      return { took: need };
    };
    await robin.chaliceTakeCargo(cfg, store);
    ok(robin._holderCargo?.items?.['orc tooth'] === 49, `drew the 49 he is short (${JSON.stringify(robin._holderCargo?.items)})`);
    robin.hopsTo = () => 1;
    await robin.chaliceDeliverCargo();
    const teeth = loialP.client.inventory.filter(x => world.nameOf(x) === 'orc tooth').reduce((a, x) => a + x.amount, 0);
    ok(teeth === 50, `Loial is back to 50 teeth (${teeth})`);
    ok(robin.events.some(e => e.what === 'cargo_delivered'), 'delivered, on the ledger');
  }

  section('orc teeth are never bought');
  {
    const cfg = normalizeChalice({ holder: 'x', station_room: 2,
      supply_shops: { 'orc tooth': { room: 104, seller: 'Joguer' }, elderberry: { room: 104, seller: 'Joguer' } } });
    ok(!cfg.supply_shops['orc tooth'], 'a shop entry for orc teeth is refused');
    ok(cfg.problems.some(p => /orc teeth come from farming/.test(p)), 'and says why');
    ok(cfg.supply_shops.elderberry, 'the berries stay');
  }

} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
