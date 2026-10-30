// OFFLINE. Unidentified weapons off the floor (m59-unrevealed-weapons.mjs, policy.lootUnrevealedWeapons).
// A cursed weapon wields itself on pickup (item.kod:508-514) and never lets go, and an unrevealed one
// reads as a plain "axe". Pins: silence loots exactly as before; 'never' refuses; 'desk' refuses with no
// live remove-curse desk and allows with one; a revealed weapon is never refused; bows are weapons; the
// strategy field maps to the policy key; an unrecognised value is reported and not applied; and the
// keeper installs the verdict on the session, which lootFloor obeys -- explicit ids included.
//
// `node tools/m59-unrevealed-weapons-test.mjs`
import { UNREVEALED_WEAPON_MODES, UNCURSE_DESK_MAX_AGE_MS, unrevealedWeaponMode, readUnrevealedWeaponMode,
         uncurseDesk, unrevealedWeaponGate, refusedWeaponPickup } from './m59-unrevealed-weapons.mjs';
import { validateStrategy, STRATEGY_FIELDS, KEY_FACULTY } from './m59-strategy-schema.mjs';
import { weaponScore, isUnrevealed } from './m59-skills.mjs';
import { OF } from './m59-parse.mjs';
import { readToolSource } from './autopilot/source.mjs';
const { Autopilot } = await import('./m59-autopilot.mjs');
const { Session } = await import('./m59-session.mjs');

let pass = 0, fail = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${what}`); } };
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${what} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);
const section = s => console.log(`\n${s}`);

const NOW = 1_800_000_000_000;
const desk = (over = {}) => ({ server: 'Loial', room: 38, at: NOW - 60_000,
  menu: [{ kind: 'uncurse', label: 'Remove Curse', ok: true, why: null }], ...over });
const classify = { isWeapon: n => weaponScore(n) > 0, isUnrevealed };
const unread = name => ({ rarity: 100, amount: 1, name });

section('the mode');
{
  eq(UNREVEALED_WEAPON_MODES, ['always', 'desk', 'never'], 'three modes');
  eq(unrevealedWeaponMode(null), null, 'null is silence');
  eq(unrevealedWeaponMode(undefined), null, 'undefined is silence');
  eq(unrevealedWeaponMode(' Desk '), 'desk', 'case and space are forgiven');
  let threw = null; try { unrevealedWeaponMode('sometimes'); } catch (e) { threw = e.message; }
  ok(threw && /always, desk, never/.test(threw), 'an unrecognised value throws, naming the choices');
  threw = null; try { unrevealedWeaponMode(true); } catch (e) { threw = e.message; }
  ok(!!threw, 'a boolean is not a mode');
  const r = readUnrevealedWeaponMode('sometimes');
  ok(r.mode === null && /ignored/.test(r.problem ?? ''), 'the keeper reading reports it and does not apply it');
  eq(readUnrevealedWeaponMode('never'), { mode: 'never', problem: null }, 'a good value reads clean');
}

section('is there a remove-curse desk');
{
  ok(uncurseDesk({ loial: desk() }, { now: NOW }).desk?.name === 'Loial', 'a fresh desk offering uncurse is one');
  ok(!uncurseDesk({ loial: desk({ menu: [{ kind: 'uncurse', ok: false, why: 'Req. reagents' }] }) }, { now: NOW }).desk,
     'uncurse listed but not ok (no emerald) is not');
  ok(!uncurseDesk({ loial: desk({ menu: [{ kind: 'reveal', ok: true }] }) }, { now: NOW }).desk,
     'a desk without uncurse is not');
  const stale = uncurseDesk({ loial: desk({ at: NOW - UNCURSE_DESK_MAX_AGE_MS - 1 }) }, { now: NOW });
  ok(!stale.desk && /has not published/.test(stale.why), 'a desk silent for 15 minutes is nobody sitting at it, and says so');
  ok(!uncurseDesk({ loial: desk({ at: undefined }) }, { now: NOW }).desk, 'a record with no timestamp is not fresh');
  ok(!uncurseDesk(null, { now: NOW }).desk, 'an unreadable board is no desk (fail closed)');
  ok(!uncurseDesk({}, { now: NOW }).desk, 'an empty board is no desk');
  const two = { loial: desk({ room: 38, at: NOW - 1000 }), rowlf: desk({ server: 'Rowlf', room: 599, at: NOW - 5000 }) };
  const inside = uncurseDesk(two, { now: NOW, rooms: [599] });
  ok(inside.desk?.name === 'Rowlf' && inside.in_confinement === true, 'a desk inside the confinement is preferred');
  const outside = uncurseDesk(two, { now: NOW, rooms: [536] });
  ok(outside.desk?.name === 'Loial' && outside.in_confinement === false, 'otherwise any live desk still counts, newest first');
}

section('the gate');
{
  const g0 = unrevealedWeaponGate(null, { now: NOW });
  ok(g0.allow === null && g0.mode === null, 'unset: allow null, the old behaviour');
  ok(unrevealedWeaponGate('always', { now: NOW }).allow === true, "'always' allows");
  ok(unrevealedWeaponGate('never', { desks: { loial: desk() }, now: NOW }).allow === false, "'never' refuses even beside a desk");
  const noDesk = unrevealedWeaponGate('desk', { desks: {}, now: NOW });
  ok(noDesk.allow === false && /no remove-curse desk/.test(noDesk.why), "'desk' with no desk refuses, and says why");
  const withDesk = unrevealedWeaponGate('desk', { desks: { loial: desk() }, now: NOW });
  ok(withDesk.allow === true && withDesk.desk?.name === 'Loial', "'desk' with an uncurse-ok desk allows, naming it");
  ok(unrevealedWeaponGate('desk', { desks: null, now: NOW }).allow === false, "'desk' with an unreadable board refuses");
}

section('which floor objects it refuses');
{
  ok(weaponScore('longbow') > 0 && weaponScore('battle bow') > 0 && weaponScore('long sword') > 0 && weaponScore('axe') > 0,
     'the session classifier calls bows, swords and axes weapons');
  const never = unrevealedWeaponGate('never', { now: NOW });
  const deskOff = unrevealedWeaponGate('desk', { desks: {}, now: NOW });
  const deskOn = unrevealedWeaponGate('desk', { desks: { loial: desk() }, now: NOW });
  const unset = unrevealedWeaponGate(null, { now: NOW });
  ok(/unidentified weapon.*equips itself on pickup.*never/.test(refusedWeaponPickup('axe', unread('axe'), never, classify) ?? ''),
     "'never' refuses an unidentified axe, with the reason");
  ok(/no remove-curse desk/.test(refusedWeaponPickup('long sword', unread('long sword'), deskOff, classify) ?? ''),
     "'desk' with no desk refuses an unidentified long sword: no remove-curse desk");
  ok(!!refusedWeaponPickup('longbow', unread('longbow'), never, classify), 'a cursed bow equips itself too: refused');
  ok(refusedWeaponPickup('axe', unread('axe'), deskOn, classify) === null, "'desk' with a desk takes it");
  ok(refusedWeaponPickup('axe', unread('axe'), unset, classify) === null, 'unset takes it');
  ok(refusedWeaponPickup('axe', unread('axe'), null, classify) === null, 'no gate at all takes it');
  ok(refusedWeaponPickup('axe', { rarity: 0, amount: 1 }, never, classify) === null, 'a revealed weapon is never refused');
  ok(/graded cursed/.test(refusedWeaponPickup('axe', { rarity: 200, amount: 1 }, deskOn, classify) ?? ''),
     'one already graded cursed is refused under desk even beside a desk');
  ok(refusedWeaponPickup('axe', { rarity: 200, amount: 1 }, unset, classify) === null,
     'but not under silence: unset changes nothing');
  ok(refusedWeaponPickup('emerald', unread('emerald'), never, classify) === null, 'a reagent is not a weapon');
  ok(refusedWeaponPickup('arrow', { rarity: 100, amount: 40 }, never, classify) === null, 'a stack is never unrevealed');
}

section('the strategy field');
{
  const f = STRATEGY_FIELDS.find(x => x.path === 'lootUnrevealedWeapons');
  ok(f && f.keys.join() === 'lootUnrevealedWeapons' && f.faculty === 'economy' && f.arg === 'loot_unrevealed_weapons',
     'lootUnrevealedWeapons -> lootUnrevealedWeapons [economy], broker arg loot_unrevealed_weapons');
  eq(KEY_FACULTY.lootUnrevealedWeapons, 'economy', 'the key is economy');
  const v = validateStrategy({ name: 'troll-wheel', hunt: 'troll', lootUnrevealedWeapons: 'desk' });
  ok(v.ok && v.strategy.desired.lootUnrevealedWeapons === 'desk', 'a file saying desk sets the key to desk');
  const bad = validateStrategy({ name: 'troll-wheel', hunt: 'troll', lootUnrevealedWeapons: 'sometimes' });
  ok(!bad.ok && bad.problems.some(p => p.path === 'lootUnrevealedWeapons'), 'an unrecognised value refuses the file, naming the field');
  const unk = validateStrategy({ name: 'troll-wheel', hunt: 'troll', unrevealedWeapons: 'desk' });
  ok(unk.ok && unk.unrecognised.includes('unrevealedWeapons') && !('unrevealedWeapons' in unk.strategy.desired),
     'an unknown key is still reported, never applied');
}

// ------------------------------------------------------------------ the keeper, against a stub
function keeper({ policy = {}, desks = {}, deskThrows = false } = {}) {
  const installed = [];
  const s = { setUnrevealedWeaponLoot: g => installed.push(g), world: { room: { num: 38 } } };
  const ap = Object.create(Autopilot.prototype);
  Object.assign(ap, { s, policy: { lootUnrevealedWeapons: null, ...policy }, tally: {}, notes: [] });
  ap.note = (what, detail) => ap.notes.push({ what, detail });
  ap.chaliceStore = () => ({ desk: () => { if (deskThrows) throw new Error('board locked'); return desks; } });
  return { ap, installed };
}

section('the keeper installs the verdict every pass');
{
  let k = keeper();
  k.ap.applyUnrevealedWeaponLoot(NOW);
  ok(k.installed.at(-1)?.allow === null && k.installed.at(-1)?.mode === null, 'unset installs the old behaviour');
  ok(k.ap.unrevealedWeaponStatus().allow === null, 'and status says so');
  k = keeper({ policy: { lootUnrevealedWeapons: 'never' } });
  k.ap.applyUnrevealedWeaponLoot(NOW);
  ok(k.installed.at(-1)?.allow === false, "'never' installs a refusal");
  ok(k.ap.notes.some(n => /left on the floor/.test(n.what)), 'and notes it once');
  k = keeper({ policy: { lootUnrevealedWeapons: 'desk' }, desks: {} });
  k.ap.applyUnrevealedWeaponLoot(NOW);
  ok(k.installed.at(-1)?.allow === false, "'desk' with no desk on the board refuses");
  k = keeper({ policy: { lootUnrevealedWeapons: 'desk' }, desks: { loial: desk() } });
  k.ap.applyUnrevealedWeaponLoot(NOW);
  ok(k.installed.at(-1)?.allow === true, "'desk' with an uncurse-ok desk allows");
  eq(k.ap.unrevealedWeaponStatus().desk?.name, 'Loial', 'status names the desk it rests on');
  k = keeper({ policy: { lootUnrevealedWeapons: 'desk' }, deskThrows: true });
  k.ap.applyUnrevealedWeaponLoot(NOW);
  ok(k.installed.at(-1)?.allow === false, "'desk' with a board that will not read refuses (fail closed)");
  k = keeper({ policy: { lootUnrevealedWeapons: 'sometimes' } });
  k.ap.curseCycleNote = (key, what, detail) => k.ap.notes.push({ what, detail });
  k.ap.applyUnrevealedWeaponLoot(NOW);
  ok(k.installed.at(-1)?.allow === null, 'an unrecognised policy value is not applied: the old behaviour');
  ok(/must be one of/.test(k.ap.unrevealedWeaponStatus().problem ?? ''), 'and status reports the problem');
  ok(k.ap.notes.some(n => /policy value refused/.test(n.what)), 'and the keeper notes it');
  // A gate that throws while a mode is set refuses.
  k = keeper({ policy: { lootUnrevealedWeapons: 'never' } });
  Object.defineProperty(k.ap, 'policy', { get() { return { lootUnrevealedWeapons: 'never', get confineRooms() { throw new Error('x'); } }; } });
  ok((() => { try { k.ap.applyUnrevealedWeaponLoot(NOW); return true; } catch { return false; } })(), 'never throws');
}

section('the wiring');
{
  const ap = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok(/await this\.applyCurseCycle\(\);\s*this\.applyUnrevealedWeaponLoot\(\);/.test(ap), 'installed every pass, beside the curse cycle');
  ok(/lootUnrevealedWeapons: null,/.test(ap), 'the default policy carries the key, null');
  const status = readToolSource(new URL('./autopilot/status.mjs', import.meta.url), 'utf8');
  ok(/unrevealed_weapons: this\.unrevealedWeaponStatus/.test(status), 'autopilot status reports the verdict');
}

// ------------------------------------------------------------------ lootFloor obeys it
function floor(gate) {
  const names = new Map([[11, 'axe'], [12, 'long sword'], [13, 'emerald']]);
  const objs = [
    { id: 11, nameRsc: 11, flags: OF.GETTABLE, col: 5, row: 5, amount: 1, rarity: 100 },   // unidentified axe
    { id: 12, nameRsc: 12, flags: OF.GETTABLE, col: 5, row: 5, amount: 1, rarity: 0 },     // revealed long sword
    { id: 13, nameRsc: 13, flags: OF.GETTABLE, col: 5, row: 5, amount: 1, rarity: 100 },   // unidentified reagent
  ];
  const gets = [];
  const c = { state: 'game', selfId: 1, evSeq: 1, inventory: [], self: { id: 1, col: 5, row: 5 },
    room: { objects: new Map(objs.map(o => [o.id, o])) }, rsc: { get: k => names.get(k) ?? '' },
    roomContents: () => {}, requestInventory: () => {}, look: () => {}, get: id => gets.push(id),
    equipment: () => ({ known: true, equipped: [] }), waitFor: async () => ({ events: [] }) };
  const s = { client: c, live: true, pacer: { submit: async (_k, fn) => fn() }, need: () => c,
              world: { room: { num: 599 } } };
  Session.prototype.setUnrevealedWeaponLoot.call(s, gate);
  return { s, gets };
}

section('lootFloor obeys the verdict');
{
  let f = floor(null);
  await Session.prototype.lootFloor.call(f.s, { stayPut: true });
  ok(f.gets.includes(11), 'unset: the unidentified axe is picked up, as before');
  f = floor(unrevealedWeaponGate('never', { now: NOW }));
  let r = await Session.prototype.lootFloor.call(f.s, { stayPut: true });
  ok(!f.gets.includes(11), "'never': the unidentified axe is left");
  ok(r.refused.some(x => /unidentified weapon/.test(x.item ?? '')), 'and the refusal is visible');
  ok(f.gets.includes(12), "'never': a revealed long sword is still taken");
  ok(f.gets.includes(13), "'never': an unidentified non-weapon is still taken");
  f = floor(unrevealedWeaponGate('desk', { desks: {}, now: NOW }));
  r = await Session.prototype.lootFloor.call(f.s, { stayPut: true });
  ok(!f.gets.includes(11) && r.refused.some(x => /no remove-curse desk/.test(x.item ?? '')), "'desk' with no desk: left, saying why");
  f = floor(unrevealedWeaponGate('desk', { desks: { loial: desk({ at: Date.now() }) }, now: Date.now() }));
  await Session.prototype.lootFloor.call(f.s, { stayPut: true });
  ok(f.gets.includes(11), "'desk' with a desk: taken");
  f = floor(unrevealedWeaponGate('never', { now: NOW }));
  await Session.prototype.lootFloor.call(f.s, { stayPut: true, ids: [11, 12] });
  ok(!f.gets.includes(11) && f.gets.includes(12), 'an explicit id list is held to it too, like the unidentified ring');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
