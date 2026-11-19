#!/usr/bin/env node
// THE WEAPON RESERVE, OFFLINE. tools/m59-weapon-reserve.mjs (pure), the REAL Session.lootFloor, the REAL
// inventorySalePlan and the keeper's own methods (weaponReserveNow, unarmedMakeSpace, makeRoomBeyondPlan, passArm,
// checkIfShouldSell) against a fake client. No socket, no roster, no broker.
//
//   node tools/m59-weapon-reserve-test.mjs
//
// THE INCIDENT (prod, 2026-11-18). Gonzo unarmed for 19,045 s reciting `unarmed -- 60 bulk free, needs 70 to hold
// one` 17,710 times with `stuck.lever: null`; Fozzie 11,799 s at 51 free; Waldorf at 61; Zoot every ten minutes
// `made space {freed: 0, short_by: {bulk: 40}, dropped: []}`. Packs of 400-820 orc teeth and purple mushrooms that
// every keep list protects, so the sale plan was empty. Zoot's happened INSIDE a journey: the travel guard paused his
// town trip for the empty hand and he sat on a wall for hours. Freed by hand, he conjured, then re-looted the teeth
// to 8 bulk free. Raphael, allowed nothing but a mace, picked up the long swords dropped for him.
//
// WHAT THIS PINS. (A) the loot path keeps a replacement weapon's room free while no usable spare is carried, says so
// on the refusal, and loots to the brim again with a spare; (B) an unarmed body short of that room drops, in order,
// sale-plan rows, gear it may not use, then the fewest units of the cheapest protected stack -- never money, the last
// of a food, the chalice, a quest or bound item, or working stock -- reserves what it dropped, and arms; when nothing
// may be dropped it says what is in the way under its own refusal code with a lever; (C) an unarmed body leaves a
// weapon it may not wield unless something collects it. It should fail the day a full pack can strand a farmer again.
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'm59-weapon-reserve-test-'));
process.env.M59_FLEET = 'weapon-reserve-offline-test';
process.env.M59_LEDGER_DIR = join(scratch, 'ledger');
process.env.M59_INVENTORY_INTENT_DIR = join(scratch, 'intent');
process.env.M59_DIBS_FILE = join(scratch, 'dibs.json');
process.env.M59_REAGENT_RESERVE_FILE = join(scratch, 'reagent-reserve.json');
process.env.M59_FARM_FOOD_CACHE_FILE = join(scratch, 'farm-food-cache.json');
process.env.M59_FARM_GEAR_CACHE_FILE = join(scratch, 'farm-gear-cache.json');

const { Session } = await import('./m59-game.mjs');
const { Autopilot, CONJURABLE_WEAPONS, HANDLED, CONTINUE, stallLever, STALL_LEVERS, unarmedBlocker } = await import('./m59-autopilot.mjs');
const WR = await import('./m59-weapon-reserve.mjs');
const MS = await import('./m59-make-space.mjs');
const { planPickup, normalizeOverfarm } = await import('./m59-overfarm.mjs');
const { killDropItems, leftReason } = await import('./m59-killdrop.mjs');
const { OF } = await import('./m59-parse.mjs');
const { readDibs, forgetDibs, dibsVerdict } = await import('./m59-dibs.mjs');
const { UNARMED_MAKE_SPACE_EVERY_MS, UNARMED_MAKE_SPACE_RETRY_MS } = await import('./autopilot/pass-combat.mjs');
const { validateStrategy, fieldFor } = await import('./m59-strategy-schema.mjs');
const { autopilotSource } = await import('./autopilot/source.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`); }
};
const J = v => JSON.stringify(v);

// ---------------------------------------------------------------------------------------------- the fixture
//
// One body: a fake client (pack, use list, floor), the real Session over it, and the keeper's prototype with only the
// answers that would otherwise read this machine's files stubbed. `pack` rows are [name, amount] (amount 0 = a single
// object); `worn` names what is in the use list. Dropping puts the thing on the floor at the body's square, a get
// merges it back into the pack: what the server does.
function body({ pack = [], worn = [], might = 55, protect = [], policy = {}, loadout = null, heldBackNames = [],
                room = 579, name = 'Fozzie', dropRefuses = new Set() } = {}) {
  const s = new Session('t12');
  let seq = 0, nextId = 100;
  const events = [], wire = [], floorDrops = [];
  const objects = new Map();
  const inventory = pack.map(([n, amount]) => ({ id: ++nextId, nameRsc: n, amount }));
  const using = new Set(inventory.filter(o => worn.includes(o.nameRsc)).map(o => o.id));
  const c = {
    me: { name }, selfId: 1, self: { col: 20, row: 30 }, inventory, using, room: { objects }, spells: [],
    rsc: { get: n => n || '' }, stat: k => (k === 'might' ? might : null),
    vitals: () => ({ health: { value: 120, max: 120 }, mana: { value: 30 }, vigor: { value: 150 } }),
    equipment: () => ({ known: true, equipped: c.inventory.filter(o => c.using.has(o.id)).map(o => ({ id: o.id, name: o.nameRsc })) }),
    get evSeq() { return seq; },
    roomContents() {}, requestSpells() {},
    requestInventory() { wire.push('inventory'); events.push({ seq: ++seq, kind: 'inventory' }); },
    waitFor: async ({ since = 0, kinds = [] } = {}) => ({ events: events.filter(e => e.seq > since && kinds.includes(e.kind)) }),
    look(id) { events.push({ seq: ++seq, kind: 'look', id, description: 'This weapon is in flawless condition.' }); },
    drop(specs) {
      wire.push('drop');
      for (const spec of specs) {
        const id = typeof spec === 'number' ? spec : spec.id;
        const o = c.inventory.find(x => x.id === id);
        if (!o || dropRefuses.has(o.nameRsc)) continue;
        const n = typeof spec === 'number' ? (o.amount || 1) : spec.amount;
        floorDrops.push({ name: o.nameRsc, amount: n });
        if (o.amount > 0) { o.amount -= n; if (!(o.amount > 0)) c.inventory = c.inventory.filter(x => x.id !== id); }
        else c.inventory = c.inventory.filter(x => x.id !== id);
        const fid = ++nextId;
        objects.set(fid, { id: fid, nameRsc: o.nameRsc, col: c.self.col, row: c.self.row, flags: OF.GETTABLE, amount: o.amount >= 0 && typeof spec !== 'number' ? n : 0 });
      }
    },
    get(id) {
      const o = objects.get(id);
      if (!o) return;
      objects.delete(id);
      const stack = o.amount > 0 ? c.inventory.find(x => x.nameRsc === o.nameRsc && x.amount > 0) : null;
      if (stack) stack.amount += o.amount; else c.inventory.push({ id: o.id, nameRsc: o.nameRsc, amount: o.amount });
      events.push({ seq: ++seq, kind: 'got', id });
    },
  };
  s.client = c; s.need = () => c; s.pacer = { submit: async (_k, fn) => fn() };
  s.world = { room: { num: room, name: `room ${room}` } };
  const ledger = [], notes = [], refusals = new Map();
  const ap = Object.assign(Object.create(Autopilot.prototype), {
    s, policy: { maxWeapons: null, ...policy }, tally: {}, refusals, idlePasses: 0,
  });
  ap.protectedItemNames = () => protect;
  ap.loadout = () => loadout;
  ap.weaponPriorityNow = () => policy.weaponPriority ?? null;
  ap.heldBackIds = () => new Set(c.inventory.filter(o => heldBackNames.includes(o.nameRsc)).map(o => o.id));
  ap.guildWantedNames = () => [];
  ap.islandSaleRelease = null; ap.saleLoadout = null;
  ap.ledgerEvent = (kind, d) => ledger.push({ kind, ...d });
  ap.note = (what, detail) => notes.push({ what, detail });
  ap.facultyHeld = () => false;
  ap.progress = why => { ap.lastProgressWhy = why; };
  ap.bareHandedByTraining = () => false;
  // The conjure, as makeWeapon would do it: declined under the 70-bulk preflight, else a short sword in the hand.
  ap.armSelf = async () => {
    ap.armCalls = (ap.armCalls ?? 0) + 1;
    const usable = ap.usableWeaponsNow(c);
    if (usable.length) { c.using.add(usable[0].o.id); return true; }
    if ((ap.packFreeNow()?.bulk ?? 0) < 70) return false;
    const made = { id: ++nextId, nameRsc: 'short sword', amount: 0 };
    c.inventory.push(made); c.using.add(made.id);
    return true;
  };
  s.setWeaponReserve(() => ap.weaponReserveNow());
  const floor = (fname, { amount = 1, col = 20, row = 31, rarity = undefined } = {}) => {
    const id = ++nextId;
    objects.set(id, { id, nameRsc: fname, col, row, flags: OF.GETTABLE, amount, ...(rarity != null ? { rarity } : {}) });
    return id;
  };
  const has = n => c.inventory.filter(o => o.nameRsc === n).reduce((t, o) => t + (o.amount > 0 ? o.amount : 1), 0);
  const onFloor = n => [...objects.values()].filter(o => o.nameRsc === n).reduce((t, o) => t + (o.amount > 0 ? o.amount : 1), 0);
  return { s, c, ap, ledger, notes, refusals, wire, floorDrops, floor, has, onFloor, free: () => ap.packFreeNow() };
}

// THE PROD PACK: 811 orc teeth, 6 purple mushrooms, worn leather armour and a shield, 1000 shillings -- and 11
// emeralds as the make-weight that puts free bulk at exactly Fozzie's 51 (might 55: 2800 - 2749). Everything the
// keep list, the protect list and the farm town keep on prod is protected here, so the sale plan is empty.
const PROD_PACK = [['orc tooth', 811], ['purple mushroom', 6], ['emerald', 11], ['leather armor', 0], ['small round shield', 0], ['shilling', 1000]];
const PROD_WORN = ['leather armor', 'small round shield'];
const PROD_PROTECT = ['orc tooth', 'purple mushroom', 'emerald'];
const prodBody = (extra = {}) => body({ pack: PROD_PACK.map(r => [...r]), worn: PROD_WORN, protect: PROD_PROTECT, ...extra });

// ---------------------------------------------------------------------------------------------- one definition
console.log('\nONE DEFINITION OF THE RESERVE');
{
  const size = WR.weaponReserveSize();
  ok('the reserve is the largest thing create weapon can hand over: an axe, 90 bulk and 90 weight',
     size.bulk === 90 && size.weight === 90, J(size));
  ok('measured over the same seven weapons the keeper says the spell can make',
     J(WR.REPLACEMENT_WEAPONS) === J(CONJURABLE_WEAPONS));
  ok('a weight table that cannot weigh every one of them does not get to shrink it',
     J(WR.weaponReserveSize(n => (n === 'axe' ? null : { bulk: 50, weight: 50 }))) === J(WR.WEAPON_RESERVE_FALLBACK));
  ok('the policy value is true or false; silence is on', WR.normWeaponReserve(undefined) === true &&
     WR.normWeaponReserve(null) === true && WR.normWeaponReserve(false) === false);
  let threw = null;
  try { WR.normWeaponReserve('off'); } catch (e) { threw = e.message; }
  ok('anything else is refused with the reason, never coerced', /true \(the default/.test(threw ?? ''), threw);
}

console.log('\nTHE PICKUP RULE, PURE');
{
  const reserve = { bulk: 90, weight: 90 };
  const v = WR.reservePickup({ free: { bulk: 100, weight: 400 }, reserve, cost: { bulk: 15, weight: 15 } });
  ok('a pickup that would leave less than the reserve is left', v.take === false && /^WEAPON RESERVE/.test(v.why), J(v));
  ok('and the refusal groups under one label on the kill_drop reader', leftReason(v.why) === 'weapon reserve', leftReason(v.why));
  ok('weight binds as well as bulk', WR.reservePickup({ free: { bulk: 500, weight: 95 }, reserve, cost: { bulk: 1, weight: 10 } }).take === false);
  ok('a pickup that leaves the reserve whole is taken', WR.reservePickup({ free: { bulk: 100, weight: 400 }, reserve, cost: { bulk: 10, weight: 10 } }).take === true);
  ok('a weapon this body may wield is never refused for the reserve', WR.reservePickup({ free: { bulk: 60, weight: 60 }, reserve, cost: { bulk: 60, weight: 60 }, replacement: true }).take === true);
  ok('no reserve in force takes everything', WR.reservePickup({ free: { bulk: 1, weight: 1 }, reserve: null, cost: { bulk: 50, weight: 50 } }).take === true);
  ok('an unweighed pack or item is taken as before: certainty in one direction only',
     WR.reservePickup({ free: null, reserve, cost: { bulk: 50, weight: 50 } }).take === true &&
     WR.reservePickup({ free: { bulk: 91, weight: 91 }, reserve, cost: null }).take === true);
  const st = (o) => WR.reserveState({ equipment: true, ...o });
  ok('in force: armed with no usable spare', st({ armed: true, carried: [] }).in_force === true);
  ok('in force: unarmed with one usable weapon in the pack -- it is about to be the hand weapon, not a spare',
     st({ armed: false, carried: ['mace'] }).in_force === true && st({ armed: false, carried: ['mace'] }).unarmed === true);
  ok('waived: armed with a usable spare', st({ armed: true, carried: ['mace'] }).waived === true && st({ armed: true, carried: ['mace'] }).reserve === null);
  ok('off: an unread hand is not an empty one', WR.reserveState({ equipment: false }).in_force === false);
  ok('off: the exemptions say why', /never_attack/.test(WR.reserveState({ equipment: true, exempt: 'never_attack: this character swings nothing' }).why));
  ok('off: weapon_reserve false', WR.reserveState({ enabled: false, equipment: true }).in_force === false);
  ok('reached: within a few units of the line', WR.reserveReached({ free: { bulk: 95, weight: 400 }, reserve }) === true &&
     WR.reserveReached({ free: { bulk: 140, weight: 400 }, reserve }) === false);
  ok('reached: a pickup was just left for it and the pack is no emptier',
     WR.reserveReached({ free: { bulk: 140, weight: 400 }, reserve, left: { at: Date.now() - 60_000, free: { bulk: 140, weight: 400 } } }) === true);
  ok('not reached: that was before the pack was emptied',
     WR.reserveReached({ free: { bulk: 900, weight: 900 }, reserve, left: { at: Date.now() - 60_000, free: { bulk: 140, weight: 400 } } }) === false);
  ok('may wield: a ban, the "only" weapon and a non-weapon each say why',
     /banned_weapons/.test(WR.unwieldableWhy('scimitar', { banned: ['scimitar'] })) &&
     /only mace/.test(WR.unwieldableWhy('long sword', { only: ['mace'] })) &&
     WR.unwieldableWhy('mace', { only: ['mace'], banned: ['scimitar'] }) === null &&
     WR.unwieldableWhy('orc tooth') === 'not a weapon');
}

// ---------------------------------------------------------------------------------------------- A: the loot path
console.log('\nA. THE LOOT PATH KEEPS THE ROOM FOR THE NEXT WEAPON');
{
  // Armed with a short sword, no spare, 100 bulk free (might 0: 1700). 5 orc teeth are 15 bulk: 85 would be left.
  const f = body({ pack: [['short sword', 0], ['orc tooth', 516], ['shilling', 200]], worn: ['short sword'], might: 0 });
  ok('fixture: 102 bulk free, armed, no spare', f.free().bulk === 102 && f.ap.weaponReserveNow().in_force === true, J(f.free()));
  const teeth = f.floor('orc tooth', { amount: 5 }), gem = f.floor('emerald', { amount: 3 });
  const r = await f.s.lootFloor({ kill: { name: 'orc', before: new Set() } });
  ok('the teeth that would eat the reserve stay on the floor', f.onFloor('orc tooth') === 5 && f.has('orc tooth') === 516, J(r.taken));
  const row = r.refused.find(x => x.id === teeth);
  ok('with the reason on the refusal row, by id', /^WEAPON RESERVE/.test(row?.why ?? ''), J(r.refused));
  ok('what leaves the reserve whole is still taken', f.has('emerald') === 3 && !f.c.room.objects.has(gem));
  const drop = killDropItems({ floor: [{ id: teeth, name: 'orc tooth', amount: 5 }], before: new Set(), taken: r.taken, refused: r.refused });
  ok('and it lands on the kill_drop row as the reason it was left', drop[0].taken === false && leftReason(drop[0].why) === 'weapon reserve', J(drop));
  ok('the session remembers the pack stopped at the reserve line', f.s._weaponReserveLeft?.left === 1 && f.ap.weaponReserveReached() === true);
  await f.s.lootFloor({ ids: [teeth], maxItems: 1 });
  ok('an explicit id request is the caller choosing it: never refused for the reserve', f.has('orc tooth') === 521);
}
{
  const f = body({ pack: [['short sword', 0], ['mace', 0], ['orc tooth', 496], ['shilling', 200]], worn: ['short sword'], might: 0 });
  ok('fixture: 102 bulk free with a usable spare: waived', f.free().bulk === 102 && f.ap.weaponReserveNow().waived === true, J(f.ap.weaponReserveNow().why));
  f.floor('orc tooth', { amount: 30 });
  await f.s.lootFloor({});
  ok('a body with a spare weapon loots to the brim as before', f.has('orc tooth') === 526 && f.free().bulk === 12, J(f.free()));
}
{
  // The weapon it may wield is what the reserve is for: taken as the spare, and the rest of the sweep is waived.
  const f = body({ pack: [['short sword', 0], ['orc tooth', 516]], worn: ['short sword'], might: 0 });
  f.floor('mace', { amount: 0, row: 31 }); f.floor('orc tooth', { amount: 5, row: 33 });
  const r = await f.s.lootFloor({});
  ok('a wieldable floor weapon is taken although it leaves less than the reserve', f.has('mace') === 1, J(r.refused));
  ok('and with it aboard as a spare the same sweep fills the pack', f.has('orc tooth') === 521, J(r.refused));
}
{
  const f = body({ pack: [['short sword', 0], ['orc tooth', 516]], worn: ['short sword'], might: 0, policy: { weaponReserve: false } });
  f.floor('orc tooth', { amount: 5 });
  await f.s.lootFloor({});
  ok('weapon_reserve: false loots to the brim, as before', f.has('orc tooth') === 521 && f.ap.weaponReserveNow().in_force === false);
  const g = body({ pack: [['orc tooth', 540]], might: 0, policy: { neverAttack: true } });
  g.floor('orc tooth', { amount: 5 });
  await g.s.lootFloor({});
  ok('a never_attack mule keeps no reserve: it swings nothing', g.has('orc tooth') === 545 && /never_attack/.test(g.ap.weaponReserveNow().why));
  const h = body({ pack: [['short sword', 0], ['orc tooth', 516]], worn: ['short sword'], might: 0 });
  h.floor('a thing nobody has weighed', { amount: 4 });
  await h.s.lootFloor({});
  ok('an item the weight table does not know is taken as before', h.has('a thing nobody has weighed') === 4);
}
{
  // OVERFARM: the lap is full AT the reserve line, so it trades up there instead of stopping (and the sift keeps moving).
  const policy = { ...normalizeOverfarm({ enabled: true, overfarm_percent: 150 }) };
  const packRows = [{ id: 1, name: 'red mushroom', amount: 322 }];           // 1610 of 1700
  const floorRows = [{ id: 9, name: 'purple mushroom', amount: 2 }];
  const plain = planPickup({ floor: floorRows, pack: packRows, policy, capacity: 1700, sifted: 0 });
  const held = planPickup({ floor: floorRows, pack: packRows, policy, capacity: 1700, sifted: 0, reserve: 90 });
  ok('overfarm without a reserve simply takes what fits', plain.take.length === 1 && plain.swaps.length === 0 && plain.phase !== 'overfarm');
  ok('with the reserve counted as carried the pack is FULL at the line and the lap trades up',
     held.phase === 'overfarm' && held.swaps.length === 1 && held.take.length === 1 && held.room === 0, J({ phase: held.phase, swaps: held.swaps.length, room: held.room }));
  ok('the sift target is still measured against the whole pack', held.sifted_percent === plain.sifted_percent);
}

// ---------------------------------------------------------------------------------------------- C: unwieldable weapons
console.log('\nC. AN UNARMED BODY DOES NOT PICK UP A WEAPON IT MAY NOT WIELD');
{
  // Raphael: allowed nothing but a mace (training_weapon_only), unarmed, room to spare.
  const pol = { trainingWeaponOnly: true, trainingStyle: 'short_sword', trainingWeapon: 'mace', maxWeapons: 2 };
  const f = body({ pack: [['orc tooth', 100], ['shilling', 50]], might: 0, policy: pol, name: 'Raphael' });
  const sword = f.floor('long sword', { amount: 0 }), mace = f.floor('mace', { amount: 0, row: 32 });
  const r = await f.s.lootFloor({});
  ok('the long sword it may not wield stays where it lies', f.has('long sword') === 0 && f.c.room.objects.has(sword), J(r.taken));
  const row = r.refused.find(x => x.id === sword);
  ok('and the refusal says which rule', /^UNWIELDABLE/.test(row?.why ?? '') && /only mace/.test(row.why) && leftReason(row.why) === 'unwieldable', row?.why);
  ok('the mace it may wield is taken', f.has('mace') === 1 && !f.c.room.objects.has(mace));
}
{
  const f = body({ pack: [['orc tooth', 100]], might: 0, policy: { bannedWeapons: ['scimitar'], maxWeapons: 0 } });
  f.floor('scimitar', { amount: 0 }); f.floor('hammer', { amount: 0, row: 32 });
  const r = await f.s.lootFloor({});
  ok('a banned weapon is left by an unarmed body', f.has('scimitar') === 0 && r.refused.some(x => /UNWIELDABLE/.test(x.why) && /banned_weapons/.test(x.why)));
  ok('the one that goes into the empty hand is not a spare against max_weapons', f.has('hammer') === 1, J(r.refused));
}
{
  const f = body({ pack: [['orc tooth', 100]], might: 0, policy: { bannedWeapons: ['scimitar'], maxWeapons: 2 } });
  f.s.setLootOnly({ '*': ['scimitar', 'orc tooth'] });
  f.floor('scimitar', { amount: 0 });
  await f.s.lootFloor({});
  ok('unless a loot list names it: then it is collected', f.has('scimitar') === 1);
  const g = body({ pack: [['orc tooth', 100]], might: 0, policy: { bannedWeapons: ['scimitar'], maxWeapons: 2 } });
  g.ap.guildWantedNames = () => ['scimitar'];
  g.floor('scimitar', { amount: 0 });
  await g.s.lootFloor({});
  ok('or a guild plan still short of it', g.has('scimitar') === 1);
  const h = body({ pack: [['orc tooth', 100]], might: 0, policy: { bannedWeapons: ['scimitar'], maxWeapons: 2 } });
  h.floor('scimitar', { amount: 0, rarity: 2 });
  h.c._noUnreadWield = true;
  await h.s.lootFloor({});
  ok('or a farm town hall that takes magic weapons (hall cargo)', h.has('scimitar') === 1);
}
{
  const f = body({ pack: [['hammer', 0], ['orc tooth', 100]], worn: ['hammer'], might: 0, policy: { bannedWeapons: ['scimitar'], maxWeapons: 2 } });
  f.floor('scimitar', { amount: 0 });
  await f.s.lootFloor({});
  ok('an ARMED body still takes a weapon it may not wield as sale stock, as before', f.has('scimitar') === 1);
}

// ---------------------------------------------------------------------------------------------- B: the remedy
console.log('\nB. UNARMED AND SHORT OF ROOM: THE EXACT PROD CASE');
{
  const f = prodBody();
  ok('fixture: 51 bulk free, unarmed, nothing usable in the pack', f.free().bulk === 51 && f.ap.weaponReserveNow().unarmed === true, J(f.free()));
  const plan = f.ap.salePlanView();
  ok('fixture: the sale plan is empty -- every stack is protected', plan.totals.droppable.units === 0, J(plan.totals.droppable));
  const quiet = await f.ap.makeSpaceNow({ bulk: 100, weight: 100 });
  ok('make_space drops nothing, and now says what protects each stack',
     quiet.dropped.length === 0 && quiet.kept?.[0]?.name === 'orc tooth' && quiet.kept[0].amount === 811 && !!quiet.kept[0].why &&
     /Kept: 811 orc tooth \(/.test(quiet.note), J({ kept: quiet.kept, note: quiet.note }));
  ok('and the ledger row and the journal carry it', f.ledger.at(-1)?.kept?.length > 0 && f.notes.at(-1)?.detail?.kept?.length > 0);
  const short = f.ap.unarmedRoomShort(f.c);
  ok('it is 39 bulk short of the reserve', short?.bulk === 39 && short.weight === 0, J(short));
  const t0 = 2_000_000_000;
  const armed = await f.ap.unarmedMakeSpace(f.c, t0);
  ok('the remedy drops just enough teeth: 13 (39 bulk), and nothing else', f.has('orc tooth') === 798 && f.onFloor('orc tooth') === 13 &&
     f.has('purple mushroom') === 6 && f.has('emerald') === 11 && f.has('shilling') === 1000, J(f.floorDrops));
  ok('and it arms on the spot: the conjure now fits', armed === true && f.ap.armCalls === 1 && f.ap.weaponReserveNow().unarmed === false);
  const row = f.ledger.filter(l => l.kind === 'make_space').at(-1);
  ok('the ledger says what, how many and why', row?.beyond_plan === true && row.dropped.length === 1 && row.dropped[0].name === 'orc tooth' &&
     row.dropped[0].amount === 13 && row.dropped[0].tier === 'stock' && /least valuable protected stack/.test(row.dropped[0].why) && row.ok === true, J(row));
  ok('and so does the journal', f.notes.some(n => n.what === 'made space beyond the sale plan' && /13 orc tooth/.test(J(n.detail.dropped))));
  forgetDibs();
  const book = readDibs(process.env.M59_DIBS_FILE);
  const claim = book.claims.find(cl => cl.item === 'orc tooth' && cl.room === 579);
  ok('the dropped teeth are reserved for it in the dibs book, where they lie', !!claim && claim.for.includes('fozzie') && claim.near?.radius === 1 &&
     claim.near.row === 30 && claim.near.col === 20 && claim.by === 'weapon-reserve', J(book.claims));
  ok('so another farmer\'s sweep leaves them, and its own may take them back',
     dibsVerdict({ book, room: 579, item: 'orc tooth', character: 'Gonzo', at: { row: 30, col: 20 } }).allowed === false &&
     dibsVerdict({ book, room: 579, item: 'orc tooth', character: 'Fozzie', at: { row: 30, col: 20 } }).allowed === true);
  // ZOOT'S REPEAT: freed by hand, he conjured, then re-looted the teeth to 8 bulk free.
  const before = f.has('orc tooth');
  const r = await f.s.lootFloor({});
  ok('armed again with no spare, it does NOT re-loot the teeth it dropped', f.has('orc tooth') === before && f.onFloor('orc tooth') === 13 &&
     r.refused.some(x => /^WEAPON RESERVE/.test(x.why)), J(r.refused));
  ok('status shows the reserve, the room against it and what the remedy did',
     f.ap.weaponReserveStatus()?.in_force === true && f.ap.weaponReserveStatus().remedy?.outcome === 'armed' &&
     f.ap.weaponReserveStatus().free.bulk === 40, J(f.ap.weaponReserveStatus()));
  const again = await f.ap.unarmedMakeSpace(f.c, t0 + 60_000);
  ok('rate-bounded: a second call inside the window does nothing', again === false && f.ap.armCalls === 1);
}

console.log('\nB. THE ORDER: SALE PLAN, THEN USELESS GEAR, THEN THE CHEAPEST PROTECTED STACK');
{
  // 12 fairy wings are on the sale plan (60 bulk): they cover the 39 and no tooth is touched.
  const f = body({ pack: [['orc tooth', 791], ['fairy wing', 12], ['purple mushroom', 6], ['emerald', 11], ['leather armor', 0], ['small round shield', 0], ['shilling', 1000]],
                   worn: PROD_WORN, protect: PROD_PROTECT });
  ok('fixture: 51 bulk free', f.free().bulk === 51, J(f.free()));
  await f.ap.unarmedMakeSpace(f.c, 2_000_000_000);
  ok('what was going to be sold goes first, and covers it: no protected stock is dropped',
     f.has('orc tooth') === 791 && f.onFloor('fairy wing') === 10 && f.floorDrops.length === 1 && !f.ledger.some(l => l.beyond_plan) &&
     f.ap.weaponReserveNow().unarmed === false, J(f.floorDrops));
}
{
  // A banned scimitar nothing protects (70 bulk) is dead weight: it goes before any tooth.
  const f = body({ pack: [['orc tooth', 788], ['scimitar', 0], ['purple mushroom', 6], ['emerald', 10], ['leather armor', 0], ['small round shield', 0], ['shilling', 1000]],
                   worn: PROD_WORN, protect: PROD_PROTECT, policy: { bannedWeapons: ['scimitar'] } });
  ok('fixture: 51 bulk free, the scimitar is kept by the sale plan (no weapon limit)', f.free().bulk === 51 &&
     f.ap.salePlanView().rows.find(r => r.name === 'scimitar').droppable === false, J(f.free()));
  const armed = await f.ap.unarmedMakeSpace(f.c, 2_000_000_000);
  const row = f.ledger.filter(l => l.kind === 'make_space').at(-1);
  ok('gear it may not use goes before the product', f.has('scimitar') === 0 && f.has('orc tooth') === 788 && armed === true &&
     row?.dropped?.[0]?.tier === 'gear' && /may not wield/.test(row.dropped[0].why), J(row?.dropped));
  ok('and is not picked straight back up (the shed list)', f.s._shedIds?.size === 1);
  const g = body({ pack: [['orc tooth', 788], ['scimitar', 0], ['purple mushroom', 6], ['emerald', 10], ['leather armor', 0], ['small round shield', 0], ['shilling', 1000]],
                   worn: PROD_WORN, protect: [...PROD_PROTECT, 'scimitar'], policy: { bannedWeapons: ['scimitar'] } });
  await g.ap.unarmedMakeSpace(g.c, 2_000_000_000);
  ok('but a weapon a protect list names is not "nothing protects it": the teeth go instead', g.has('scimitar') === 1 && g.has('orc tooth') === 775, J(g.floorDrops));
}

console.log('\nB. WHAT IS NEVER DROPPED');
{
  // Nothing but money, one meal, the chalice, a quest item, a dedicated weapon and working stock: nothing may go.
  const f = body({ pack: [['shilling', 5000], ['meat pie', 1], ['Chalice of the Rain', 0], ['shard of a sword', 3], ['hammer', 0],
                          ['purple mushroom', 300], ['leather armor', 0]],
                   worn: ['leather armor'], might: 0, protect: ['purple mushroom'], heldBackNames: ['hammer'],
                   policy: { bannedWeapons: ['hammer'] },
                   loadout: { character: 'Fozzie', keep: [], sell: [], gear: { weapon: [], slots: {} }, carry: [{ item: 'purple mushroom', min: 300, max: 300 }] } });
  ok('fixture: short of the reserve', !!f.ap.unarmedRoomShort(f.c), J(f.free()));
  const armed = await f.ap.unarmedMakeSpace(f.c, 2_000_000_000);
  ok('money, the last meal, the chalice, a quest item, a held-back weapon and stock at its floor all stay',
     armed === false && f.floorDrops.length === 0 && f.has('shilling') === 5000 && f.has('meat pie') === 1 && f.has('hammer') === 1 &&
     f.has('shard of a sword') === 3 && f.has('purple mushroom') === 300, J(f.floorDrops));
  const kept = f.ap._unarmedRoom?.kept ?? [];
  const whyOf = n => kept.find(k => k.name === n)?.why ?? '';
  ok('and each says what protects it', /money/.test(whyOf('shilling')) && /quest/.test(whyOf('shard of a sword')) &&
     /held back/.test(whyOf('hammer')) && /working stock/.test(whyOf('purple mushroom')), J(kept));
  ok('the outcome is recorded as blocked, with a ledger row and a journal line', f.ap._unarmedRoom?.outcome === 'blocked' &&
     f.ledger.some(l => l.kind === 'unarmed_no_room' && l.short_by.bulk > 0) &&
     f.notes.some(n => /nothing more may be dropped/.test(n.what)));
}
{
  // Food goes last and never the last of it; working stock above its floor goes only by the overage.
  const f = body({ pack: [['spider eye', 170], ['shilling', 10], ['leather armor', 0]], worn: ['leather armor'], might: 0 });   // 1530 + 150: 20 free
  await f.ap.unarmedMakeSpace(f.c, 2_000_000_000);
  ok('with nothing but food it drops only what the shortfall needs (8 of 170: 72 bulk onto 20)', f.has('spider eye') === 162 &&
     f.onFloor('spider eye') === 8 && f.ap.weaponReserveNow().unarmed === false, J(f.floorDrops));
  const g = body({ pack: [['spider eye', 1], ['mushroom', 400], ['shilling', 10]], might: 0, protect: ['mushroom'] });
  await g.ap.unarmedMakeSpace(g.c, 2_000_000_000);
  ok('the last of a food is never dropped', g.has('spider eye') === 1, J(g.floorDrops));
}
{
  // Value unknown is not cheap: herbs (no price in the table) are never the "least valuable" stack.
  const f = body({ pack: [['herb', 420]], might: 0 });
  const armed = await f.ap.unarmedMakeSpace(f.c, 2_000_000_000);
  ok('a stack whose value is unknown is not dropped', armed === false && f.floorDrops.length === 0 &&
     /unknown/.test(f.ap._unarmedRoom?.kept?.[0]?.why ?? ''), J(f.ap._unarmedRoom));
}
{
  const f = prodBody({ policy: { weaponReserve: false } });
  ok('weapon_reserve: false leaves the old hook: the early remedy does not even ask', f.ap.unarmedRoomShort(f.c) === null);
  await f.ap.unarmedMakeSpace(f.c, 2_000_000_000);
  ok('and the hook itself stops at the sale plan', f.floorDrops.length === 0 && f.has('orc tooth') === 811);
  const g = prodBody();
  g.ap.facultyHeld = fac => fac === 'economy';
  const t0 = 2_000_000_000;
  await g.ap.unarmedMakeSpace(g.c, t0);
  ok('a bot holding the economy faculty is left alone, and says so', g.floorDrops.length === 0 && g.ap._unarmedRoom?.outcome === 'held');
  g.ap.facultyHeld = () => false;
  ok('a fact about the moment is asked again soon, not in ten minutes',
     (await g.ap.unarmedMakeSpace(g.c, t0 + UNARMED_MAKE_SPACE_RETRY_MS - 1)) === false && g.floorDrops.length === 0 &&
     (await g.ap.unarmedMakeSpace(g.c, t0 + UNARMED_MAKE_SPACE_RETRY_MS)) === true && UNARMED_MAKE_SPACE_RETRY_MS < UNARMED_MAKE_SPACE_EVERY_MS);
  const h = prodBody({ dropRefuses: new Set(['orc tooth']) });
  await h.ap.unarmedMakeSpace(h.c, t0);
  ok('each drop is judged by the pack: one the server did not take frees nothing', h.has('orc tooth') === 811 && h.ap._unarmedRoom?.outcome === 'blocked');
}

// ---------------------------------------------------------------------------------------------- through passArm
console.log('\nTHROUGH passArm: THE FARM PASS, A PAUSED JOURNEY, AND AN ARMED BODY');
const passFixture = (f, extra = {}) => {
  const actions = [];
  Object.assign(f.ap, { mode: 'farm', trainingStyleFor: () => null, safety: () => ({ fleeAt: 0.5 }),
    sweepBroken: async () => {}, sweepCursed: async () => {}, knowsCreateWeapon: () => true, sanctuary: () => false,
    leaveForManaWhileUnarmed: async () => { actions.push('left'); return false; }, settle: async () => ({ settled: false }),
    bankRun: async () => { actions.push('town-trip'); return false; }, stop: () => actions.push('stopped'),
    playDead: async () => false, noProgress: why => { actions.push(why); Autopilot.prototype.noProgress.call(f.ap, why); },
    doneWaiting: () => {}, waitFor: () => {}, declinedCast: () => false, ...extra });
  return actions;
};
{
  const f = prodBody();
  passFixture(f);
  const r = await f.ap.passArm({ s: f.s, c: f.c, room: f.s.world.room });
  ok('the farm pass: one passArm drops the 13 teeth and arms', r === HANDLED && f.has('orc tooth') === 798 && f.ap.weaponReserveNow().unarmed === false);
  ok('and leaves no refusal behind', !f.refusals.has('UNARMED_NO_ROOM') && !f.refusals.has('UNARMED_NO_DONOR'));
}
{
  // ZOOT, 2026-11-18: the travel guard's arm trigger paused his town trip and he sat on a wall for hours at 60 free.
  const f = prodBody({ name: 'Zoot' });
  passFixture(f);
  f.ap.suspendedJourney = { to: 113, why: 'travelling to 113', trigger: 'unarmed', at: Date.now(), guard: { arm: true } };
  const r = await f.ap.passArm({ s: f.s, c: f.c, room: f.s.world.room });
  ok('a journey paused for the empty hand runs the same remedy: it arms on the wall', r === HANDLED && f.has('orc tooth') === 798 &&
     f.ap.weaponReserveNow().unarmed === false && f.ap.suspendedJourney?.to === 113, J(f.floorDrops));
}
{
  // A body that does not know create weapon gets the room too: whatever arms it next has to fit.
  const f = prodBody();
  const actions = passFixture(f, { knowsCreateWeapon: () => false });
  f.ap.armSelf = async () => false;
  const r = await f.ap.passArm({ s: f.s, c: f.c, room: f.s.world.room });
  ok('a body that cannot conjure still makes the room', r === CONTINUE && f.has('orc tooth') === 798 && f.free().bulk === 90 &&
     !f.refusals.has('UNARMED_NO_ROOM'), J({ actions, free: f.free() }));
}
{
  const f = body({ pack: [['short sword', 0], ...PROD_PACK.map(r => [...r])], worn: ['short sword', ...PROD_WORN], protect: PROD_PROTECT });
  passFixture(f);
  const r = await f.ap.passArm({ s: f.s, c: f.c, room: f.s.world.room });
  ok('an ARMED body never drops product, however full', r === CONTINUE && f.floorDrops.length === 0 && f.free().bulk === 1 && f.has('orc tooth') === 811, J(f.free()));
}

console.log('\nSTEP 5: WHEN NOTHING MAY BE DROPPED, A NAMED REFUSAL WITH A LEVER');
{
  const f = body({ pack: [['herb', 420]], might: 0, policy: { townTrips: true } });
  const actions = passFixture(f);
  const r = await f.ap.passArm({ s: f.s, c: f.c, room: f.s.world.room });
  const ref = f.refusals.get('UNARMED_NO_ROOM');
  ok('the refusal is UNARMED_NO_ROOM, blocking, and not the code the supervisor reads as waiting for mana',
     r === HANDLED && ref?.blocking === true && ref.faculty === 'work' && !f.refusals.has('UNARMED_NO_DONOR'), J([...f.refusals.keys()]));
  ok('it names what is in the way and what protects it', /420 herb/.test(ref?.why ?? '') && /hand/.test(ref?.remedy ?? ''), J(ref));
  const stall = actions.find(a => /^unarmed -- /.test(String(a)));
  ok('the stall sentence carries the verdict', /^unarmed -- 20 bulk free, needs 70 to hold one; nothing more may be dropped: needs a town trip or a hand-over$/.test(stall ?? ''), stall);
  ok('and names a lever instead of null', stallLever(stall) === 'hand_over' && f.ap.stalledLever === 'hand_over');
  ok('the town trip is still asked for, after the remedy', actions.indexOf('town-trip') >= 0);
  for (let i = 0; i < 40; i++) await f.ap.passArm({ s: f.s, c: f.c, room: f.s.world.room });
  ok('forty more passes do not declare STALL_NO_LEVER: something is named to act on it', !f.refusals.has('STALL_NO_LEVER') && f.ap.stallRepeats > 20);
  ok('and the remedy was not re-run every pass', f.ledger.filter(l => l.kind === 'unarmed_no_room').length === 1);
}
{
  ok('the bare sentence is the keeper\'s own remedy', stallLever('unarmed -- 60 bulk free, needs 70 to hold one') === 'make_room');
  ok('mana and vigor stalls are untouched (still leverless waits)', stallLever('unarmed -- 9 mana, needs 15 to make one') === null &&
     stallLever('unarmed -- 5 vigor, needs 13 to cast one') === null);
  ok('blink still answers what it answered', stallLever('could not reach the safe spot') === 'blink' && Object.keys(STALL_LEVERS).join() === 'blink,hand_over,make_room');
  ok('unarmedBlocker gives room its own code', unarmedBlocker({ vigor: 80, mana: 99, bulkFree: 10, vigorNeeded: 13, manaNeeded: 15, bulkNeeded: 70 }).code === 'UNARMED_NO_ROOM' &&
     unarmedBlocker({ vigor: 80, mana: 4, bulkFree: 999, vigorNeeded: 13, manaNeeded: 15, bulkNeeded: 70 }).code === 'UNARMED_NO_DONOR');
  const sup = readFileSync(new URL('./m59-supervise.mjs', import.meta.url), 'utf8');
  ok('the supervisor leaves UNARMED_NO_ROOM alone under its own sentence, not the mana one',
     /refused\('UNARMED_NO_ROOM'\)\) \{[\s\S]{0,900}a restart makes none[\s\S]{0,40}continue;/.test(sup) &&
     sup.indexOf("refused('UNARMED_NO_ROOM')") < sup.indexOf("refused('UNARMED_NO_DONOR')"));
}

// ---------------------------------------------------------------------------------------------- the sell trigger
console.log('\nA PACK STOPPED AT THE RESERVE LINE IS FULL TO THE SELL TRIGGER');
{
  // 95 bulk free of 1700 is 94.4%: under a sell_at_load of 0.97, which loot can no longer reach.
  const f = body({ pack: [['short sword', 0], ['fairy wing', 311]], worn: ['short sword'], might: 0, policy: { sellAtLoad: 0.97, maxCarry: 50, minSellTripValue: 0 } });
  ok('fixture: 95 bulk free, at the line', f.free().bulk === 95 && f.ap.weaponReserveReached() === true, J(f.free()));
  let verdict = null, threw = null;
  try { verdict = f.ap.checkIfShouldSell(); } catch (e) { threw = e.message; }
  ok('the load trigger fires although 94% is under sell_at_load 0.97', verdict?.sell === true && verdict.trigger === 'load' &&
     verdict.at_weapon_reserve === true && /weapon reserve/.test(verdict.why), threw ?? J(verdict));
  const g = body({ pack: [['short sword', 0], ['fairy wing', 250]], worn: ['short sword'], might: 0, policy: { sellAtLoad: 0.97, maxCarry: 50, minSellTripValue: 0 } });
  let v2 = null;
  try { v2 = g.ap.checkIfShouldSell(); } catch (e) { threw = e.message; }
  ok('below the line nothing changes: 76% is not due', v2?.sell === false && !v2.at_weapon_reserve, threw ?? J(v2));
}

// ---------------------------------------------------------------------------------------------- plumbing
console.log('\nTHE POLICY KEY, PLUMBED LIKE ITS NEIGHBOURS');
{
  const src = autopilotSource();
  ok('the default policy names it, on', /\n      weaponReserve: true,\n/.test(src));
  ok('the keeper installs the reserve on the session every pass', /s\.setWeaponReserve\?\.\(\(\) => this\.weaponReserveNow\(\)\);/.test(src));
  ok('the remedy is asked before any create-weapon branch, and the room branch still opens the town trip',
     src.indexOf('const roomShort = this.unarmedRoomShort(c);') > 0 &&
     src.indexOf('const roomShort = this.unarmedRoomShort(c);') < src.indexOf('if (!this.knowsCreateWeapon() && this.sanctuary()) {') &&
     src.indexOf('const roomShort = this.unarmedRoomShort(c);') < src.indexOf("if (blocker === 'room') {"));
  const br = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  ok('the broker autopilot tool takes weapon_reserve and refuses a value that will not normalise',
     /weapon_reserve: \{ type: \['boolean', 'null'\]/.test(br) &&
     /if \(a\.weapon_reserve !== undefined\) \{\s*try \{ p\.policy\.weaponReserve = normWeaponReserve\(a\.weapon_reserve\); \}\s*catch \(e\) \{ return \{ started: false, reason: `weapon_reserve refused:/.test(br));
  const good = validateStrategy({ name: 'no-reserve', weaponReserve: false });
  const bad = validateStrategy({ name: 'bad-reserve', weaponReserve: 'sometimes' });
  ok('a strategy file may set weaponReserve, as economy', good.ok === true && good.unrecognised.length === 0 &&
     fieldFor('weaponReserve').arg === 'weapon_reserve' && fieldFor('weaponReserve').faculty === 'economy', J(good));
  ok('and a value that is not true or false is refused', bad.ok === false, J(bad.errors ?? bad));
  const st = readFileSync(new URL('./autopilot/status.mjs', import.meta.url), 'utf8');
  ok('autopilot status publishes weapon_reserve', /weapon_reserve: \(\(\) => \{ try \{ return this\.weaponReserveStatus/.test(st));
  const game = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
  ok('the reserve is asked inside lootFloor, the one place a floor drop becomes a carried item, and never for an explicit id',
     /const weaponReserve = \(!ids\?\.length \|\| !explicitIdsOverride\) \? this\.weaponReserveState\(\) : null;/.test(game));
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
