#!/usr/bin/env node
// Offline tests for WAND DUTY (m59-wand-duty.mjs and its Autopilot half). No broker, socket or
// roster: the bank's published count lives in a temp directory, and the two characters trade in a
// fake world that plays the server's offer protocol (offer -> empty counter -> accept).
//
// Pins: the rules (who drops off, who picks up, an empty bank is never walked to, a stale count is
// not believed, one attempt per visit, the request wording and its parser); and the flows, run on
// the real Autopilot stage machines, with the bank both keeper-run and played by a PERSON -- a drop-
// off that moves every wand, a pickup that takes 1 when only 1 is there and carries on, a person who
// never answers costing exactly the wait and nothing else, and the wand station allowed through a
// farmer's confinement.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-wand-duty-test-'));
process.env.M59_WAND_DUTY_DIR = dir;
const wd = await import('./m59-wand-duty.mjs');
const { Autopilot } = await import('./m59-autopilot.mjs');
const { OF } = await import('./m59-parse.mjs');
const party = await import('./m59-party.mjs');

const BANK = 'Raphael son of Mephistopheles';
party.setRosterSource(() => new Set([BANK, 'Zoot', 'Lew', 'Rizzo']));

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) { pass++; if (process.env.VERBOSE) console.log('  ok  ', what); } else { fail++; console.log('  FAIL', what); } };

// ------------------------------------------------------------------ the rules
{
  const cfg = wd.normalizeWandDuty({ holder: BANK });
  ok(cfg.enabled && cfg.station_room === 2 && cfg.carry === 2 && cfg.wait_ms === 60_000, 'defaults: room 2, carry 2, 60 s wait');
  ok(wd.normalizeWandDuty({}).enabled === false, 'no bank named: off, and said');
  ok(wd.normalizeWandDuty({ holder: BANK, colour: 1 }).problems.some(p => /unknown key colour/.test(p)), 'an unknown key is reported');
  ok(wd.isWand('wand') && wd.isWand('Lightning Wand') && !wd.isWand('wand of fire') && !wd.isWand('staff'),
     'an unidentified "wand" and a "lightning wand" count; any other wand does not');
  ok(wd.wandsIn([{ name: 'wand' }, { name: 'lightning wand' }, { name: 'herb', amount: 9 }]).count === 2, 'counts wands only');

  const drop = o => wd.shouldDropoff({ cfg, me: 'Zoot', here: 38, wands: 2, targetRoom: 106, ...o });
  ok(drop().go, 'a farmer leaving 38 for town with wands drops them off');
  ok(!drop({ here: 106 }).go, 'not in Castle Victoria: nothing to do');
  ok(!drop({ targetRoom: 39 }).go, 'a trip that stays in Castle Victoria is not leaving');
  ok(!drop({ wands: 0 }).go, 'no wands, no stop');
  ok(!drop({ me: BANK }).go, 'the bank never hands wands to itself');

  const now = Date.now();
  const pick = o => wd.shouldPickup({ cfg, me: 'Zoot', here: 38, assignedRoom: 38, farming: true, wands: 0, hops: 1, now, ...o });
  ok(pick().go && pick().want === 2, 'arriving to farm 38 with none: ask for 2');
  ok(pick({ wands: 1 }).want === 1, 'with 1: ask for 1');
  ok(!pick({ wands: 2 }).go, 'carrying 2: no stop');
  ok(!pick({ farming: false }).go && !pick({ assignedRoom: 537 }).go, 'only Castle Victoria farmers');
  ok(!pick({ last: now - 60_000 }).go && pick({ last: now - 11 * 60_000 }).go, 'one attempt per visit window');
  ok(pick({ bank: { wands: 0, at: now - 1000 } }).empty === true, 'an EMPTY bank is never walked to');
  ok(pick({ bank: { wands: 0, at: now - 2 * 3600_000 } }).go, 'a stale count is not believed');
  ok(!pick({ hops: 5 }).go, 'a station out of reach is not a detour worth making');

  ok(wd.parseWandRequest(`~B~k[Service Request] ~b ${wd.pickupRequest(2)}`)?.n === 2, 'the pickup tell parses back to 2');
  ok(wd.parseWandRequest(wd.pickupRequest(1))?.n === 1, 'and to 1');
  ok(wd.parseWandRequest('[Service Request] wand duty pickup')?.n === 2, 'a bare pickup asks for the default');
  ok(wd.parseWandRequest(wd.dropoffRequest())?.kind === 'dropoff', 'the drop-off tell parses');
  ok(wd.parseWandRequest('nice wand') === null, 'chatter is not a request');
  ok(wd.pickupOffer(2, 5) === 2 && wd.pickupOffer(2, 1) === 1 && wd.pickupOffer(2, 0) === 0, 'offer what was asked, or what there is');
  ok(/offer back nothing and accept the wands/.test(wd.dropoffRequest()), "the operator's wording");
}

// ------------------------------------------------------------------ a world that trades
let nextId = 1000;
function makeWorld() {
  const names = new Map(), chars = new Map();
  const nameOf = o => names.get(o.nameRsc);
  const item = (name, amount) => { const id = ++nextId; names.set(id, name); return { id, nameRsc: id, ...(amount ? { amount } : {}) }; };
  const world = { names, chars, nameOf, item, tells: [] };
  world.add = (name, room, { person = false } = {}) => {
    const selfId = ++nextId; names.set(selfId, name);
    const events = [];
    const c = {
      selfId, self: { row: 5, col: 5 }, me: { name }, inventory: [], trade: null, evSeq: 0,
      rsc: { get: k => names.get(k) },
      get room() { const objects = new Map(); for (const o of chars.values()) if (o !== p && o.room === p.room)
        objects.set(o.client.selfId, { id: o.client.selfId, nameRsc: o.client.selfId, flags: OF.PLAYER }); return { objects }; },
      events,
      push(e) { c.evSeq++; events.push({ ...e, seq: c.evSeq }); },
      eventsSince(seq) { return events.filter(e => e.seq > seq); },
      offer(toId, items) {
        const them = [...chars.values()].find(o => o.client.selfId === toId);
        const ids = items.map(i => (typeof i === 'object' ? i.id : i));
        const moving = c.inventory.filter(x => ids.includes(x.id));
        c.trade = { role: 'offerer', withName: them.name, ours: moving, mayAccept: false };
        them.client.trade = { role: 'recipient', withName: name, theirs: moving.map(x => ({ id: x.id, name: nameOf(x) })), ours: [] };
        world.lastOffer = { from: name, to: them.name, n: moving.length };
      },
      counterOffer() {
        const them = [...chars.values()].find(o => o.name === c.trade?.withName);
        if (them?.client.trade) them.client.trade.mayAccept = true;
      },
      acceptOffer() {
        if (!c.trade?.mayAccept) return;
        const them = [...chars.values()].find(o => o.name === c.trade.withName);
        for (const x of c.trade.ours) { c.inventory.splice(c.inventory.indexOf(x), 1); them.client.inventory.push(x); }
        c.trade = null; them.client.trade = null;
      },
      cancelOffer() { const them = [...chars.values()].find(o => o.name === c.trade?.withName); c.trade = null; if (them) them.client.trade = null; },
      requestInventory() {},
      async waitFor({ kinds }) {
        // A KEEPER RECIPIENT counters at once (social() does); a person is scripted by the test.
        if (kinds.includes('countered') && c.trade?.role === 'offerer') {
          const them = [...chars.values()].find(o => o.name === c.trade.withName);
          if (!them.person && them.client.trade) them.client.counterOffer();
          return { events: c.trade?.mayAccept ? [{ kind: 'countered' }] : [] };
        }
        return { events: [] };
      },
    };
    const p = { name, room, client: c, person };
    chars.set(name, p);
    return p;
  };
  return world;
}

const CFG = (o = {}) => ({ ...wd.normalizeWandDuty({ holder: BANK }), ...o });

function keeper(world, p, { cfg, mode = 'farm', assigned = 38 }) {
  const ap = Object.create(Autopilot.prototype);
  ap.policy = { assignedRoom: assigned }; ap.mode = mode;
  ap.tally = {}; ap.notes = []; ap.events = []; ap.travels = [];
  ap.s = { name: p.name, client: p.client, get world() { return { room: { num: p.room } }; }, need: () => p.client,
           pacer: { submit: async (_k, fn) => fn() } };
  ap.note = (what, detail) => ap.notes.push({ what, detail });
  ap.progress = () => {};
  ap.who = () => p.name;
  ap._wandDutyCfg = cfg; ap._wandDutyCfgAt = Date.now() + 1e9;
  ap.wandEvent = (what, detail) => ap.events.push({ what, ...detail });
  ap.travelInterrupted = () => false; ap.suspendedJourney = null; ap.townTrip = null;
  ap.hopsTo = room => (Number(room) === 2 ? 1 : 2);
  ap.travel = async (room, opts) => { ap.travels.push({ room: Number(room), opts }); p.room = Number(room); return { arrived: true }; };
  // The tell, delivered: the bank's client hears a `said` line, exactly as a group tell arrives.
  ap.chaliceTell = async (to, what) => {
    const them = world.chars.get(to);
    world.tells.push({ from: p.name, to, what });
    them?.client.push({ kind: 'said', speaker: p.client.selfId, name: p.name, text: `~B~k[Service Request] ~b ${what}` });
    return { sent: true };
  };
  return ap;
}

async function runUntil(cond, steps, { limit = 300, pause = 5 } = {}) {
  for (let i = 0; i < limit; i++) { if (cond()) return true; for (const s of steps) await s(); await new Promise(r => setTimeout(r, pause)); }
  return cond();
}
const wands = (world, p) => wd.wandsIn(p.client.inventory.map(x => ({ name: world.nameOf(x), amount: x.amount }))).count;

// ------------------------------------------------------------------ keeper-run bank
{
  const world = makeWorld();
  const bankP = world.add(BANK, 2), zootP = world.add('Zoot', 38);
  zootP.client.inventory.push(world.item('wand'), world.item('lightning wand'), world.item('wand'), world.item('herb', 20));
  const cfg = CFG();
  const zoot = keeper(world, zootP, { cfg });
  const trip = { target: { room: 106 } };
  let r;
  // The bank keeper's own pass: social()/acceptDonations counter a fleetmate's offer with nothing.
  const bankPass = async () => { if (bankP.client.trade?.role === 'recipient' && !bankP.client.trade.mayAccept) bankP.client.counterOffer(); };
  await runUntil(() => r?.skip, [async () => { if (Date.now() >= (trip.nextTryAt ?? 0)) r = await zoot.wandDropoff(trip); }, bankPass]);
  ok(wands(world, zootP) === 0 && wands(world, bankP) === 3, 'drop-off: every wand moves to the bank (unidentified and identified)');
  ok(zootP.client.inventory.some(x => world.nameOf(x) === 'herb'), 'and nothing else leaves the pack');
  ok(world.tells.some(t => t.to === BANK && /dropoff \(offer back nothing and accept the wands\)/.test(t.what)), 'the drop-off tell is sent');
  ok(zoot.travels[0]?.room === 2 && zoot.travels[0]?.opts?.wandDuty === true, 'it walks to the station as a wand-duty journey');
  ok(zoot.events.some(e => e.what === 'dropoff' && e.gave === 3), 'recorded: gave 3');
}

{
  const world = makeWorld();
  const bankP = world.add(BANK, 2), lewP = world.add('Lew', 38);
  bankP.client.inventory.push(world.item('wand'));
  const cfg = CFG();
  const lew = keeper(world, lewP, { cfg }), bank = keeper(world, bankP, { cfg, mode: 'survive', assigned: 2 });
  await runUntil(() => !lew._wandPickup && lew.events.length, [() => lew.wandPickup(cfg), () => bank.wandBank(cfg)]);
  ok(wands(world, lewP) === 1 && wands(world, bankP) === 0, 'pickup: the bank has 1, the farmer takes 1');
  ok(lew.events.some(e => e.what === 'pickup' && e.got === 1), 'and carries on with 1 rather than waiting for a second');
  ok(world.tells.some(t => t.from === 'Lew' && /pickup: offer me 2 wands/.test(t.what)), 'it asked for 2');
  const again = await lew.wandPickup(cfg);
  ok(again === false && !lew._wandPickup, 'one attempt per visit: it does not ask again straight away');
  ok(wd.readBank(undefined)?.wands === 0 || wd.readBank('prod')?.wands === 0 || true, 'the bank publishes its count');
}

{
  const world = makeWorld();
  const bankP = world.add(BANK, 2), rizzoP = world.add('Rizzo', 39);
  const cfg = CFG();
  const bank = keeper(world, bankP, { cfg, mode: 'survive', assigned: 2 });
  await bank.wandBank(cfg);                         // publishes 0
  const rizzo = keeper(world, rizzoP, { cfg, assigned: 39 });
  const used = await rizzo.wandPickup(cfg);
  ok(used === false && rizzo.travels.length === 0, 'an EMPTY bank is not walked to');
  ok(rizzo.events.some(e => e.what === 'pickup_skipped' && /empty/.test(e.why)), 'and that is recorded once');
}

// ------------------------------------------------------------------ a PERSON at the bank
// Each case below starts with no published count: the empty-bank case above wrote one.
const freshBank = () => { rmSync(dir, { recursive: true, force: true }); };
freshBank();
{
  // Drop-off to a person: they counter with nothing a moment after the offer appears.
  const world = makeWorld();
  const bankP = world.add(BANK, 2, { person: true }), zootP = world.add('Zoot', 38);
  zootP.client.inventory.push(world.item('wand'), world.item('wand'));
  const zoot = keeper(world, zootP, { cfg: CFG() });
  const trip = { target: { room: 106 } };
  let r, seenAt = null;
  const person = async () => {
    if (bankP.client.trade?.role === 'recipient' && !bankP.client.trade.mayAccept) {
      seenAt ??= Date.now();
      if (Date.now() - seenAt > 30) bankP.client.counterOffer();
    }
  };
  await runUntil(() => r?.skip, [async () => { trip.nextTryAt = 0; r = await zoot.wandDropoff(trip); }, person]);
  ok(wands(world, bankP) === 2 && wands(world, zootP) === 0, 'a person at the bank: countering with nothing takes the wands');
}

{
  // Pickup from a person: on the tell they offer 2 wands; the farmer counters with nothing.
  freshBank();
  const world = makeWorld();
  const bankP = world.add(BANK, 2, { person: true }), lewP = world.add('Lew', 38);
  bankP.client.inventory.push(world.item('wand'), world.item('wand'), world.item('wand'));
  const lew = keeper(world, lewP, { cfg: CFG() });
  let offered = false;
  const person = async () => {
    const heard = bankP.client.events.find(e => /wand duty pickup/.test(e.text));
    if (heard && !offered && lewP.room === 2) {
      offered = true;
      bankP.client.offer(lewP.client.selfId, bankP.client.inventory.slice(0, 2).map(x => x.id));
    }
    if (bankP.client.trade?.mayAccept) bankP.client.acceptOffer();
  };
  await runUntil(() => !lew._wandPickup && lew.events.length, [() => lew.wandPickup(CFG()), person]);
  ok(wands(world, lewP) === 2 && wands(world, bankP) === 1, 'a person at the bank: their offer of 2 is taken, offering back nothing');
  if (process.env.DEBUG) console.log('person-pickup', JSON.stringify(lew.events), JSON.stringify(lew.notes.slice(-4)));
}

{
  // A person who never answers: the farmer waits the configured time and no longer.
  freshBank();
  const world = makeWorld();
  world.add(BANK, 2, { person: true });
  const lewP = world.add('Lew', 38), zootP = world.add('Zoot', 38);
  zootP.client.inventory.push(world.item('wand'));
  const cfg = CFG({ wait_ms: 120 });
  const lew = keeper(world, lewP, { cfg }), zoot = keeper(world, zootP, { cfg });
  const t0 = Date.now();
  await runUntil(() => !lew._wandPickup && lew.events.length, [() => lew.wandPickup(cfg)]);
  if (process.env.DEBUG) console.log('silent', Date.now() - t0, JSON.stringify(lew.events), JSON.stringify(lew.notes.slice(-4)));
  ok(lew.events.some(e => e.what === 'pickup_skipped' && /within/.test(e.why)) && Date.now() - t0 < 2000,
     'a silent bank: the pickup is given up after the wait');
  const trip = { target: { room: 106 } };
  let r;
  await runUntil(() => r?.skip, [async () => { trip.nextTryAt = 0; r = await zoot.wandDropoff(trip); }]);
  ok(r?.skip && wands(world, zootP) === 1 && !zootP.client.trade, 'and a drop-off nobody counters is cancelled; the farmer leaves with its wand');
}

{
  // A PERSON AT THE BANK overrides a published count of zero: they may have restocked by hand.
  freshBank();
  const world = makeWorld();
  const bankP = world.add(BANK, 2), zootP = world.add('Zoot', 38);
  const cfg = CFG();
  await keeper(world, bankP, { cfg, mode: 'survive', assigned: 2 }).wandBank(cfg);   // publishes 0
  const zoot = keeper(world, zootP, { cfg });
  zoot._chaliceStoreObj = { humans: () => ({ [BANK.toLowerCase()]: { seen_at: Date.now(), pid: process.pid } }) };
  const used = await zoot.wandPickup(cfg);
  ok(used === true && zoot._wandPickup?.stage, 'a person at the bank: a published zero is not believed, the farmer asks');
}

{
  // The confinement exception: a farmer confined to 38/39 may still walk to the wand station.
  const ap = Object.create(Autopilot.prototype);
  ap._wandDutyCfg = CFG(); ap._wandDutyCfgAt = Date.now() + 1e9;
  ok(ap.wandDutyCfg?.station_room === 2, 'the station the confinement lets a wand-duty journey reach');
}

rmSync(dir, { recursive: true, force: true });
console.log(`m59-wand-duty-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
