// OFFLINE. The chalice ride ON DEMAND (m59-chalice-ride.mjs): a courier asks for a ride to the
// guild hall outside any town trip, and the keeper drives the same stage machine a town trip does.
//
// Pinned here, against a fake world with a real holder keeper (`chaliceDuty`), a real rider keeper
// (`chaliceRideNow`) and a real ChaliceStore in a temp directory:
//   - a ride that lands, served by the holder through the ordinary ticket, and hands the cup back;
//   - the refusals, each with its code and before anything walks: no holder, far station, the PvP
//     lockout, a busy cup when queueing is refused, a desk that is away, a hurt rider;
//   - the sip: the rider STANDS before it, never sips twice inside the landing window, and a sip
//     the server refuses for the PvP lockout comes back as a refusal at once, not as a slow landing;
//   - the FleetScript step `rideChalice`, judged by the room the world reports;
//   - a town trip's ride decided and landed exactly as before.
//
// No socket. `node tools/m59-chalice-ride-test.mjs`.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// FleetScript reads these at import: a scratch run lock and a keeper band nothing serves.
const LOCK_DIR = mkdtempSync(join(tmpdir(), 'm59-ride-lock-'));
process.env.M59_RUNLOCK_DIR = LOCK_DIR;
process.env.M59_CONTROL_URL = 'http://127.0.0.1:1/';
writeFileSync(join(LOCK_DIR, 'keeper-bands.json'), JSON.stringify({ ridefleet: 19950 }));
process.env.M59_KEEPER_BAND_REGISTRY = join(LOCK_DIR, 'keeper-bands.json');
process.env.M59_KEEPER_BEAT_MS = '400';

const { Autopilot } = await import('./m59-autopilot.mjs');
const { OF } = await import('./m59-parse.mjs');
const { ChaliceStore, normalizeChalice, GUILD_HALL_ROOM, sipVerdict, cupInUse } = await import('./m59-chalice.mjs');
const { rideNowPreflight, refusalCode, rideNowOptions } = await import('./m59-chalice-ride.mjs');
const party = await import('./m59-party.mjs');
const { stateFileFor } = await import('./m59-fleetpath.mjs');
const { fleetScript, rideChalice, walk } = await import('./m59-fleetscript.mjs');

party.setRosterSource(() => new Set(['Loial the Ogier', 'Rizzo', 'Kermit', 'Pepe', 'Gonzo', 'Zoot']));

let pass = 0, fail = 0;
const ok = (cond, what, extra = '') => {
  if (cond) { pass++; console.log('  ok  ', what); } else { fail++; console.log('  FAIL', what, extra ? `— ${extra}` : ''); }
};
const section = (s) => console.log(`\n${s}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PEACE = 'Only those who have walked the path of peace may partake of the chalice.';
const SIPPED = 'You sip a bit of the water out of the Chalice of the Rain.';

// ------------------------------------------------------------------------------ the world
function makeWorld() {
  let nextId = 5000;
  const names = new Map();
  const rsc = (name) => { const r = 90000 + names.size; names.set(r, name); return r; };
  const world = { players: new Map(), floor: new Map(), names, landings: [], log: [] };
  world.item = (name, amount = 1) => ({ id: nextId++, nameRsc: rsc(name), amount });
  world.nameOf = (o) => names.get(o.nameRsc) ?? '';
  world.add = (name, { room, inventory = [], accepts = true, health = 100 }) => {
    const self = { id: nextId++, nameRsc: rsc(name) };
    const events = [];
    const client = {
      selfId: self.id, self: { row: 1, col: 1 }, inventory, accepts,
      get evSeq() { return events.length; },
      rsc: { get: r => names.get(r) ?? '' },
      vitals: () => ({ health: { value: p.health, max: 100 }, mana: { value: 50, max: 50 } }),
      equipment: () => ({ equipped: [] }),
      get room() { return { num: p.room, objects: world.objectsFor(p) }; },
      stand() { world.log.push({ who: name, did: 'stand' }); },
      requestInventory() {},
      offer(toId, items) { client._offer = { toId, items }; },
      cancelOffer() { client._offer = null; },
      async waitFor({ since = 0, kinds = [], match = null } = {}) {
        if (kinds.includes('countered') && client._offer) {
          const to = [...world.players.values()].find(q => q.self.id === client._offer.toId);
          if (to && to.room === p.room && to.client.accepts) return { events: [{ kind: 'countered' }] };
          return { events: [] };
        }
        if (kinds.includes('message')) {
          const got = events.slice(since).filter(e => e.kind === 'message' && (!match || match(e)));
          return { events: got, timedOut: !got.length };
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
          const amount = typeof spec === 'object' && spec.amount ? spec.amount : it.amount;
          if (amount < it.amount) { it.amount -= amount; to.client.inventory.push({ ...it, id: nextId++, amount }); }
          else { client.inventory.splice(i, 1); to.client.inventory.push(it); }
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
      // THE CUP, AS chalice.kod HAS IT: a PvP lockout refuses with a sentence and starts nothing;
      // otherwise the sip is announced and a power-1 Rescue lands in the hall a moment later.
      apply(id) {
        const it = client.inventory.find(x => x.id === id);
        if (!/chalice/i.test(world.nameOf(it ?? {}))) return;
        world.log.push({ who: name, did: 'apply' });
        p.applies = (p.applies ?? 0) + 1;
        if (p.pvpLocked) { events.push({ kind: 'message', text: PEACE }); return; }
        events.push({ kind: 'message', text: SIPPED });
        world.landings.push({ who: p, at: Date.now() + 60 });
      },
    };
    const p = { name, room, self, client, health };
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

function keeper(world, p, { cfg, store }) {
  const ap = Object.create(Autopilot.prototype);
  ap.policy = { walkingMoney: 400, fleeBelow: 0.4 };
  ap.tally = {}; ap.notes = []; ap.events = []; ap.walks = [];
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
  // Castle Victoria (38) and the station (2) are next door; everywhere else is nine hops away.
  const near = new Set([2, 38, GUILD_HALL_ROOM]);
  ap.hopsTo = (room) => (Number(room) === Number(p.room) ? 0 : near.has(Number(room)) && near.has(Number(p.room)) ? 1 : 9);
  ap.travel = async (room) => { ap.walks.push(Number(room)); p.room = Number(room); return { arrived: true }; };
  ap.takeRecoverySpot = async () => { ap.hold = { parked: true }; };
  ap.protectedItemNames = () => [];
  ap.shoppingPlan = () => ({ required_purse: 0 });
  ap.purseNow = () => p.client.inventory.filter(x => /shilling/i.test(world.nameOf(x))).reduce((a, x) => a + x.amount, 0);
  ap.chaliceCastsLeft = () => 50;
  ap.chaliceCursedWorn = () => [];
  ap.chaliceUnrevealed = () => [];
  ap.cargoTaken = 0;
  ap.chaliceTakeCargo = async () => { ap.cargoTaken++; };
  ap.fundStandingOrder = async () => {};
  ap.chaliceDepositMoney = async () => {};
  return ap;
}

/** Run the holder (and the world's clock) in the background while `fn` runs. */
async function withDesk(world, desk, fn) {
  let on = true;
  const loop = (async () => {
    while (on) { world.tick(); try { await desk?.chaliceDuty(); } catch {} await sleep(5); }
  })();
  try { return await fn(); } finally { on = false; await loop; }
}

const has = (world, p, re) => p.client.inventory.some(x => re.test(world.nameOf(x)));
const CFG = normalizeChalice({ holder: 'Loial the Ogier', alternate: 'Rizzo', station_room: 2, post_room: 2 });

const dir = mkdtempSync(join(tmpdir(), 'chalice-ride-'));
let ns = 0;
const scene = ({ riderRoom = 38, holder = true, rider = 'Kermit' } = {}) => {
  const world = makeWorld();
  const store = new ChaliceStore({ directory: dir, namespace: `s${++ns}` });
  const H = holder ? world.add('Loial the Ogier', { room: 2, inventory: [world.item('chalice of the rain')] }) : null;
  const R = world.add(rider, { room: riderRoom, inventory: [world.item('shillings', 1500)] });
  return { world, store, H, R, holder: H && keeper(world, H, { cfg: CFG, store }), rider: keeper(world, R, { cfg: CFG, store }) };
};

try {
  // ------------------------------------------------------------------------------ pure
  section('the decision, pure');
  {
    const base = { cfg: CFG, role: 'traveller', stationHops: 1, me: 'Kermit', health: 1 };
    ok(rideNowPreflight(base).ok, 'a traveller one hop from the station may ride');
    ok(rideNowPreflight({ ...base, duty: { with: 'Loial the Ogier', lost: true } }).code === 'no_holder', 'no holder on duty: no_holder');
    ok(rideNowPreflight({ ...base, stationHops: 9 }).code === 'too_far', 'nine hops: too_far');
    ok(rideNowPreflight({ ...base, stationHops: 4, maxHops: 5 }).ok, 'and the hop limit is the caller\'s, not max_detour_hops');
    const pvp = rideNowPreflight({ ...base, lastPlayerAttackAt: Date.now() - 60_000 });
    ok(pvp.code === 'pvp' && pvp.wait_ms > 0, 'a swing at a player a minute ago: pvp, with the wait', JSON.stringify(pvp));
    ok(rideNowPreflight({ ...base, role: 'holder' }).code === 'holder', 'the holder does not ride its own cup');
    ok(rideNowPreflight({ ...base, carrying: true }).code === 'carrying', 'a rider holding the cup is refused');
    ok(rideNowPreflight({ ...base, health: 0.2 }).code === 'hurt', 'under the flee line: hurt');
    ok(rideNowPreflight({ ...base, riding: true }).code === 'already_riding', 'one ride at a time');
    const away = { with: 'Loial the Ogier', room: 104, room_by: 'Loial the Ogier', seen_at: Date.now() };
    ok(rideNowPreflight({ ...base, duty: away }).code === 'holder_away', 'the desk says it is in 104: holder_away');
    ok(rideNowPreflight({ ...base, duty: { ...away, seen_at: Date.now() - 10 * 60_000 } }).ok, 'a stale word about the desk is not evidence');
    ok(rideNowPreflight({ ...base, duty: { ...away, room: 2 } }).ok, 'the desk at the station rides');
    const state = { tickets: [{ id: 'x', kind: 'ride', traveller: 'Pepe', status: 'handed', at: 1 }] };
    ok(rideNowPreflight({ ...base, state, queue: false }).code === 'busy', 'another rider holds the cup and queue:false: busy');
    const q = rideNowPreflight({ ...base, state });
    ok(q.ok && q.queued === 1 && q.behind === 'Pepe', 'and with queueing on, it waits its turn behind Pepe', JSON.stringify(q));
    ok(!cupInUse({ handoff: { rider: 'Loial the Ogier', by: 'Pepe', expires: Date.now() + 9e3 } }, 'Kermit', Date.now(),
      { servers: ['Loial the Ogier'] }).busy, 'a cup dropped back for the desk is not somebody\'s ride');
    ok(sipVerdict([{ text: PEACE }]) === 'refused_pvp' && sipVerdict([SIPPED]) === 'sipped' && sipVerdict([]) === 'unknown',
       'the sip verdict reads chalice.kod\'s own sentences, and silence is unknown');
    ok(refusalCode('no landing 45s after the sip') === 'no_landing' && refusalCode('nobody brought the chalice in 180s') === 'not_served',
       'the stage machine\'s sentences map to codes');
    ok(rideNowOptions({ max_hops: 99 }).maxHops === 3, 'an unusable hop limit keeps the default');
  }

  // ------------------------------------------------------------------------------ end to end
  section('a courier in Castle Victoria rides on demand; the holder serves the same ticket');
  {
    const S = scene();
    const r = await withDesk(S.world, S.holder, () => S.rider.chaliceRideNow({ pollMs: 5, why: 'mushrooms for Janice' }));
    ok(r.ok && r.landed && r.room === GUILD_HALL_ROOM && r.guild_hall, `landed in the hall (${JSON.stringify(r)})`);
    ok(S.R.room === GUILD_HALL_ROOM, 'and the world agrees');
    ok(S.rider.walks[0] === 2, 'it walked to the station first');
    ok(typeof r.ticket === 'string' && r.ticket.startsWith('ride-'), 'and reports the ride ticket');
    ok(!has(S.world, S.R, /chalice/i), 'without the cup');
    const back = await withDesk(S.world, S.holder, async () => {
      for (let i = 0; i < 200 && !(has(S.world, S.H, /chalice/i) && !S.holder._chaliceServe); i++) await sleep(5);
      return has(S.world, S.H, /chalice/i);
    });
    ok(back, 'the holder picked the cup back up');
    ok(S.store.read().tickets.find(t => t.id === r.ticket)?.status === 'done', 'the ticket is done');
    ok(S.rider.cargoTaken === 0, 'an on-demand landing takes no holder cargo (there is no trip home to carry it)');
    ok(!S.rider.claims?.size, 'the faculties it took are handed back');
    ok(S.rider._rideNow === null, 'and nothing is left in flight');
    const order = S.world.log.filter(x => x.who === 'Kermit').map(x => x.did);
    ok(order.indexOf('stand') >= 0 && order.indexOf('stand') < order.indexOf('apply'), 'it STOOD before the sip', order.join(','));
    ok(S.R.applies === 1, 'and sipped exactly once');
    ok(S.rider.events.some(e => e.what === 'drank' && e.sip === 'sipped'), 'the ledger records the sip the server announced');
  }

  section('the refusals, before anything walks');
  {
    const S = scene({ holder: false });
    S.store.setDuty({ with: 'Loial the Ogier', lost: true });
    const r = await S.rider.chaliceRideNow({ pollMs: 5 });
    ok(r.ok === false && r.refused === 'no_holder', `no holder: ${r.refused} — ${r.why}`);
    ok(!S.rider.walks.length, 'and it never walked');
  }
  {
    const S = scene({ riderRoom: 500 });
    const r = await S.rider.chaliceRideNow({ pollMs: 5 });
    ok(r.refused === 'too_far' && /9 hops/.test(r.why), `far station: ${r.why}`);
    ok(!S.rider.walks.length, 'and it never walked');
    S.store.setDuty({ with: 'Loial the Ogier', lost: true });   // so the ride that is allowed stops at once
    const r2 = await S.rider.chaliceRideNow({ pollMs: 5, max_hops: 9 });
    ok(r2.refused === 'no_holder', `a larger max_hops gets past the distance (${r2.refused})`);
  }
  {
    const S = scene();
    S.rider._lastPlayerAttackAt = Date.now() - 30_000;
    const r = await S.rider.chaliceRideNow({ pollMs: 5 });
    ok(r.refused === 'pvp' && /path|player/.test(r.why) && r.wait_ms > 0, `PvP cooldown: ${r.why}`);
    ok(!S.rider.walks.length, 'and it never walked');
  }
  {
    const S = scene();
    S.store.request('Pepe', { room: 2 });
    const t = S.store.claimNext('Loial the Ogier');
    S.store.mark(t.id, 'handed');
    const r = await S.rider.chaliceRideNow({ pollMs: 5, queue: false });
    ok(r.refused === 'busy' && /Pepe/.test(r.why), `busy cup, queue:false: ${r.why}`);
    ok(!S.rider.walks.length, 'and it never walked');
  }
  {
    const S = scene();
    S.R.health = 25;
    const r = await S.rider.chaliceRideNow({ pollMs: 5 });
    ok(r.refused === 'hurt', `under the flee line: ${r.why}`);
  }
  {
    const S = scene();
    S.store.setDuty({ with: 'Loial the Ogier', room: 104, room_by: 'Loial the Ogier' });
    const r = await S.rider.chaliceRideNow({ pollMs: 5 });
    ok(r.refused === 'holder_away' && /104/.test(r.why), `desk away: ${r.why}`);
  }
  {
    const S = scene();
    S.rider._rideNow = { chalice: { stage: 'wait' } };
    const r = await S.rider.chaliceRideNow({ pollMs: 5 });
    ok(r.refused === 'already_riding', 'a second ride on the same character is refused');
  }

  section('survival owns the body: hurt before the cup is in hand gives the ride up');
  {
    const S = scene();
    // The holder never comes, so the rider waits at the station; then something hits it.
    const p = S.rider.chaliceRideNow({ pollMs: 5 });
    for (let i = 0; i < 100 && S.rider._rideNow?.chalice?.stage !== 'wait'; i++) await sleep(5);
    S.R.health = 20;
    const r = await p;
    ok(r.refused === 'survival' && r.stage === 'wait', `given up to survival at ${r.stage}: ${r.why}`);
    ok(S.store.read().tickets.every(t => t.status === 'abandoned'), 'and the ticket is withdrawn so nobody serves a ghost');
  }

  section('the sip: the PvP lockout is a REFUSAL, at once, not a slow landing');
  {
    const S = scene();
    S.R.pvpLocked = true;           // the server knows; our own clock does not
    const t0 = Date.now();
    const r = await withDesk(S.world, S.holder, () => S.rider.chaliceRideNow({ pollMs: 5 }));
    ok(r.ok === false && r.refused === 'pvp' && /path of peace/.test(r.why), `refused: ${r.refused} — ${r.why}`);
    ok(Date.now() - t0 < CFG.landing_ms / 2, `answered in ${Date.now() - t0}ms, not after the ${CFG.landing_ms / 1000}s landing wait`);
    ok(S.R.applies === 1, 'one sip, not retried');
    ok(!has(S.world, S.R, /chalice/i), 'and the cup was put down for the desk');
    ok(S.rider.lastPlayerSwingAt() > 0, 'and the lockout is remembered, so the next ask refuses before walking');
  }

  section('the sip is never repeated inside the landing window');
  {
    const S = scene({ riderRoom: 2 });
    const cup = S.world.item('chalice of the rain');
    S.R.client.inventory.push(cup);
    S.H.client.inventory.length = 0;
    const trip = { onDemand: true, target: { room: GUILD_HALL_ROOM }, chalice: { stage: 'drink', ticket: null } };
    // The pass THROWS after the apply reached the server (the pacer times out on the reply).
    const pacer = S.rider.s.pacer;
    S.rider.s.pacer = { submit: async (_k, fn) => { fn(); throw new Error('pacer timed out'); } };
    await S.rider.chaliceRide(trip).catch(() => null);
    S.rider.s.pacer = pacer;
    ok(trip.chalice.stage === 'drink' && S.R.applies === 1, 'the pass died in the drink stage after one sip');
    await S.rider.chaliceRide(trip);
    ok(S.R.applies === 1, 'the re-entered stage did NOT sip again');
    ok(trip.chalice.stage === 'landing', `it waits for the pending Rescue instead (${trip.chalice.stage})`);
    ok(!has(S.world, S.R, /chalice/i) && (S.world.floor.get(2) ?? []).some(x => x.id === cup.id),
       'and the cup still in hand was put down for the desk, not carried into the hall');
  }

  // ------------------------------------------------------------------------------ the town trip
  section('a town trip rides exactly as before');
  {
    const S = scene();
    const trip = { target: { room: 113, hops: 9 } };
    await withDesk(S.world, S.holder, async () => {
      for (let i = 0; i < 2000 && !['done', 'off'].includes(trip.chalice?.stage); i++) {
        await S.rider.chaliceRide(trip); await sleep(2);
      }
    });
    ok(trip.chalice.stage === 'done' && S.R.room === GUILD_HALL_ROOM, `the town trip landed (${trip.chalice.stage} ${trip.chalice.why ?? ''})`);
    ok(S.rider.cargoTaken === 1, 'and a town-trip landing still takes on the holder\'s cargo');
    ok(S.rider.walks[0] === 2 && S.rider.walks.length === 1, 'one walk, to the station');
    const near = scene();
    near.rider.hopsTo = (room) => (Number(room) === 2 ? 1 : 1);
    const r = await near.rider.chaliceRide({ target: { room: 39, hops: 1 } });
    ok(r.skip && r.code === 'not_on_the_way', 'a town no further than the station still walks, as before', JSON.stringify(r));
  }

  // ------------------------------------------------------------------------------ FleetScript
  section('the FleetScript step is judged by the world');
  {
    const rooms = {};
    let reply = null, keeperRooms = null;
    const sent = [];
    globalThis.fetch = async (_url, opts) => {
      if (!opts || opts.method !== 'POST') return { json: async () => ({ ok: true, fleet: 'ridefleet', state: stateFileFor('ridefleet') }) };
      const { name, arguments: a } = JSON.parse(opts.body).params;
      sent.push({ name, ...a });
      let payload = { ok: true };
      if (name === 'status') payload = { where: { num: rooms[a.agent], name: 'room' }, hp: { value: 50, max: 50 } };
      else if (name === 'chalice_ride') { payload = reply(a); if (keeperRooms) Object.assign(rooms, keeperRooms); }
      else if (name === 'travel') { rooms[a.agent] = a.to; payload = { started: true }; }
      else if (name === 'travel_estimate') payload = { ms: 1000, hops: 1 };
      return { json: async () => ({ result: { content: [{ text: JSON.stringify(payload) }] } }) };
    };
    const quiet = () => {};
    const run = (steps) => fleetScript({ name: 'courier', fleet: 'ridefleet', agents: ['c1'], steps, onLog: quiet });

    rooms.c1 = 38; reply = () => ({ ok: true, landed: true, room: 714, ms: 18000, ticket: 'ride-1' }); keeperRooms = { c1: 714 };
    let r = await run([rideChalice({ why: 'mushrooms' })]);
    ok(r.results.c1.ok === true, 'a landing the world confirms passes', JSON.stringify(r.results.c1));
    const ask = sent.find(c => c.name === 'chalice_ride');
    ok(ask && ask.agent === 'c1' && ask.why === 'mushrooms' && ask.budget_ms > 0, 'and it asked the keeper with a budget', JSON.stringify(ask));

    rooms.c1 = 38; keeperRooms = { c1: 2 }; sent.length = 0;
    r = await run([rideChalice()]);
    ok(r.results.c1.ok === false && /world puts the rider in 2/.test(r.results.c1.why ?? JSON.stringify(r.results.c1)),
       'a keeper that SAYS it landed while the world says room 2 FAILS', JSON.stringify(r.results.c1));

    rooms.c1 = 38; keeperRooms = null; sent.length = 0;
    reply = () => ({ ok: false, landed: false, refused: 'pvp', why: 'attacked a player 30s ago' });
    r = await run([{ ...rideChalice(), optional: true }, walk(714)]);
    ok(r.results.c1.ok === true && rooms.c1 === 714, 'a refused ride, optional, falls back to the walk', JSON.stringify(r.results.c1));
    ok(sent.some(c => c.name === 'travel' && c.to === 714), 'and the walk did the work');
    rooms.c1 = 38; sent.length = 0;
    r = await run([rideChalice()]);
    ok(r.results.c1.ok === false && /refused \(pvp\)/.test(JSON.stringify(r.results.c1)), 'not optional, the refusal fails the run and says why');

    rooms.c1 = 714; sent.length = 0;
    r = await run([rideChalice()]);
    ok(r.results.c1.ok === true && !sent.some(c => c.name === 'chalice_ride'), 'already in the hall: passes without asking for a ride');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(LOCK_DIR, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
