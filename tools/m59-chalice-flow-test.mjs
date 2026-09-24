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
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
