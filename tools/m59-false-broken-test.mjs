#!/usr/bin/env node
// m59-false-broken-test.mjs -- a break sentence condemns only the item it NAMES, and a precious
// item is dropped only on a fresh look at its own id. Offline: fakes only, no socket, no roster.
//
//   node tools/m59-false-broken-test.mjs
//
// THE INCIDENT, prod 2026-10-27 (Fozzie, t12, Ukgoth 599). The healing-wand tick inside
// attackRounds spent the last charge of a wand of healing between swings (10881: "charged" at
// 12:47:16.321, "blackened mess" at 12:47:19.190). The server says that as "Your wand of healing
// shatters into pieces!" (specwand.kod:71), fight() read ANY break sentence in the exchange as the
// wielded weapon breaking, and condemned the sound, Kraanan-dedicated mace 11023 by id. At
// 12:48:10.299 the minute-clock shield attempt took the mace out of the hand; passArm could not
// re-wield a "broken" mace, makeWeapon ran, and its freeRoomFor dropped 11023 at 12:48:13.369
// (left_pack after:drop 85ms) before casting create weapon. A look afterwards: "notched and
// stained with blood but is still an effective weapon".

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OF } from './m59-parse.mjs';
import { fight, equipBest, freeRoomFor, confirmBroken, brokenSet,
         textNamesItem, brokenTextFor } from './m59-skills.mjs';

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`ok ${pass + fail} - ${name}`); }
  else { fail++; console.error(`not ok ${pass + fail} - ${name}${detail ? ` -- ${detail}` : ''}`); }
}

const WAND_LAST = 'Your wand of healing shatters into pieces!';
const MACE_SHATTERS = 'Your mace shatters into pieces.';
const GAUNTLETS_BREAK = 'Your gauntlets are a tangled mess of metal.';
const MACE_REFUSED = "You can't use the mace--it's broken.";

console.log('which item a break sentence is about');
ok('a wand spending its last charge is not about the mace',
   !brokenTextFor(WAND_LAST, 'mace') && brokenTextFor(WAND_LAST, 'wand of healing'));
ok('the weapon\'s own shatter line names it', brokenTextFor(MACE_SHATTERS, 'mace'));
ok('the use refusal names the item refused', brokenTextFor(MACE_REFUSED, 'mace'));
ok('a gauntlet break is about the gauntlets only',
   !brokenTextFor(GAUNTLETS_BREAK, 'mace') && brokenTextFor(GAUNTLETS_BREAK, 'gauntlets'));
ok('whole words: a long sword breaking is not the short sword',
   !brokenTextFor('Your long sword shatters into pieces.', 'short sword') &&
     brokenTextFor('Your long sword shatters into pieces.', 'long sword'));
ok('a hit line that names the weapon is not a break', !brokenTextFor('Your mace bashes the troll.', 'mace'));
ok('an empty name names nothing', !textNamesItem(MACE_SHATTERS, '') && !textNamesItem(MACE_SHATTERS, null));
ok('a name with regex metacharacters is matched literally',
   textNamesItem("Your sword (of riija) shatters into pieces.", 'sword (of riija)') &&
     !textNamesItem('Your swordXofXriija shatters', 'sword.of.riija'));

// ---------------------------------------------------------------- fight()
// Modelled on m59-combat-safety-test's combat(): a scripted exchange per round.
function combat(sequence, { equip = true, inventory = [], using = [], names = null } = {}) {
  let health = 1, calls = 0, uses = 0;
  const nm = names ?? new Map([[1, 'troll'], [2, 'Fozzie'], [3, 'Ukgoth'], [10, 'mace'], [11, 'long sword']]);
  const foe = { id: 1, flags: OF.ATTACKABLE, col: 1, row: 0, nameRsc: 1 };
  const self = { id: 99, col: 0, row: 0, nameRsc: 2 };
  const objects = new Map([[1, foe], [99, self]]);
  const c = {
    selfId: self.id, self, room: { objects }, roomNameRsc: 3, inventory, using: new Set(using), evSeq: 0,
    rsc: { get: id => nm.get(id) ?? '' }, lookup: id => nm.get(id) ?? '',
    vitals: () => ({ health: { value: Math.round(health * 100), max: 100 }, vigor: { value: 100, scale_max: 200 } }),
    stats: () => {}, waitFor: async () => ({ events: [], timedOut: true }), roomContents: () => {},
    requestInventory: () => {}, face: async () => {},
    use: id => { uses++; c.using.clear(); c.using.add(id); },
  };
  const s = {
    need: () => c, pacer: { submit: async (_k, action) => action() }, world: { approachSquare: () => null },
    async attackRounds(id) {
      const step = sequence[calls++] ?? { messages: [] };
      if (step.leftHand != null) c.using.delete(step.leftHand);
      if (step.kill) objects.delete(id);
      return { messages: step.messages ?? [], vitals: c.vitals(), aborted: step.aborted ?? null };
    },
    async lootFloor() { return { taken: [], refused: [], carrying: [] }; },
  };
  return {
    c, calls: () => calls, uses: () => uses,
    run: () => fight(s, { target: 'troll', preferId: foe.id, rounds: sequence.length, disengageAt: 0.4,
                          loot: false, equip, holdPosition: true, reach: 3 }),
  };
}

console.log('\nfight(): the exchange is not only the weapon\'s');
{
  const mace = { id: 11023, nameRsc: 10 };
  const fozzie = combat([
    { messages: ['Your mace bashes the troll.', WAND_LAST] },
    { messages: ['Your mace bashes the troll.'], kill: true },
  ], { inventory: [mace], using: [mace.id] });
  const r = await fozzie.run();
  ok('THE INCIDENT: a wand\'s last charge mid-exchange does not condemn the mace in hand',
     !brokenSet(fozzie.c).has(mace.id), JSON.stringify([...brokenSet(fozzie.c)]));
  ok('and the fight carries on to the kill instead of disengaging unarmed',
     r.killed === true && !r.disengaged && fozzie.calls() === 2, JSON.stringify({ killed: r.killed, disengaged: r.disengaged }));
  ok('the misheard line is said out loud, not swallowed',
     (r.log || []).some(row => /not the weapon/.test(row.stage ?? row.what ?? JSON.stringify(row))), JSON.stringify(r.log));

  const gaunt = combat([
    { messages: [GAUNTLETS_BREAK] },
    { messages: [], kill: true },
  ], { inventory: [mace], using: [mace.id] });
  await gaunt.run();
  ok('a gauntlet breaking in battle does not condemn the weapon', !brokenSet(gaunt.c).has(mace.id));

  const wandAndLeft = combat([
    { messages: [WAND_LAST], leftHand: mace.id },
    { messages: [], kill: true },
  ], { inventory: [mace], using: [mace.id] });
  await wandAndLeft.run();
  ok('a wand line never stands in for the weapon, even if the hand emptied meanwhile',
     !brokenSet(wandAndLeft.c).has(mace.id));

  const real = combat([
    { messages: [MACE_SHATTERS], leftHand: mace.id },
    { messages: ['You punch the troll.'] },
  ], { inventory: [mace], using: [mace.id] });
  const rr = await real.run();
  ok('the mace\'s own shatter line still condemns it and stops before a punch',
     brokenSet(real.c).has(mace.id) && rr.disengaged?.unarmed === true && rr.disengaged?.weapon_id === mace.id &&
       real.calls() === 1, JSON.stringify(rr.disengaged));

  // The inventory says "jagged mace", the sentence says "mace": the name test misses, so the
  // server taking that weapon out of the hand has to carry it -- and only for a weapon-shaped line.
  const otherName = new Map([[1, 'troll'], [2, 'Fozzie'], [3, 'Ukgoth'], [10, 'jagged mace']]);
  const unnamed = combat([
    { messages: [MACE_SHATTERS], leftHand: mace.id },
    { messages: [] },
  ], { inventory: [mace], using: [mace.id], names: otherName });
  await unnamed.run();
  ok('a sentence that does not spell the inventory name: weapon-shaped break + leaving the hand still counts',
     brokenSet(unnamed.c).has(mace.id), JSON.stringify([...brokenSet(unnamed.c)]));
  const stillHeld = combat([
    { messages: [MACE_SHATTERS] },
    { messages: [], kill: true },
  ], { inventory: [mace], using: [mace.id], names: otherName });
  await stillHeld.run();
  ok('...but not while the server still has that weapon in the hand', !brokenSet(stillHeld.c).has(mace.id));
}

// ---------------------------------------------------------------- equipBest()
function wieldClient({ inventory, using = [], onUse }) {
  let seq = 0;
  const ring = [];
  const c = {
    inventory, using: new Set(using), get evSeq() { return seq; },
    rsc: { get: id => ({ 10: 'mace', 11: 'long sword' })[id] ?? '' },
    requestInventory: () => {},
    push(e) { ring.push({ seq: ++seq, ...e }); },
    use(id) { onUse(c, id); },
    waitFor: async ({ since = 0, kinds = null } = {}) => {
      const want = kinds && new Set([].concat(kinds));
      return { events: ring.filter(e => e.seq > since && (!want || want.has(e.kind))), timedOut: false };
    },
  };
  const s = { need: () => c, client: c, pacer: { submit: async (_k, fn) => fn() } };
  return { c, s };
}

console.log('\nequipBest(): a refusal must name the candidate');
{
  const mace = { id: 11023, nameRsc: 10 };
  const { c, s } = wieldClient({ inventory: [mace], onUse: (c, id) => {
    c.push({ kind: 'message', text: WAND_LAST });          // the wand tick, in the same window
    c.using.add(id); c.push({ kind: 'equipment', how: 'used', id });
  } });
  const r = await equipBest(s, { refresh: false });
  ok('a wield the server accepted is not condemned by a wand line in the window',
     r.wielding === 'mace' && !brokenSet(c).has(mace.id), JSON.stringify(r));
}
{
  const mace = { id: 11023, nameRsc: 10 };
  const { c, s } = wieldClient({ inventory: [mace], onUse: (c) => {
    c.push({ kind: 'message', text: MACE_REFUSED });
  } });
  const r = await equipBest(s, { refresh: false, maxTries: 1 });
  ok('the server refusing THIS weapon as broken still condemns it',
     r.wielding == null && brokenSet(c).has(mace.id), JSON.stringify(r));
}
{
  const mace = { id: 11023, nameRsc: 10 };
  const { c, s } = wieldClient({ inventory: [mace], onUse: (c) => {
    c.push({ kind: 'message', text: GAUNTLETS_BREAK });
  } });
  await equipBest(s, { refresh: false, maxTries: 1 });
  ok('a refusal window holding only somebody else\'s break does not condemn the candidate',
     !brokenSet(c).has(mace.id));
}

// ---------------------------------------------------------------- freeRoomFor()
function packClient({ inventory, using = [], broken = [], look }) {
  let seq = 0;
  const ring = [], drops = [], looks = [];
  const c = {
    inventory, using: new Set(using), get evSeq() { return seq; },
    _brokenWeapons: new Set(broken),
    rsc: { get: id => ({ 10: 'mace', 11: 'long sword', 12: 'broken mace' })[id] ?? '' },
    drop(specs) { for (const sp of specs) drops.push(typeof sp === 'object' ? sp.id : sp); },
    requestInventory: () => {},
    look(id) { looks.push(id); const r = look(id, looks.length); if (r) ring.push({ seq: ++seq, kind: 'look', ...r }); },
    waitFor: async ({ since = 0, kinds = null, match = null } = {}) => {
      const want = kinds && new Set([].concat(kinds));
      return { events: ring.filter(e => e.seq > since && (!want || want.has(e.kind)) && (!match || match(e))),
               timedOut: false };
    },
  };
  const s = { need: () => c, client: c, pacer: { submit: async (_k, fn) => fn() } };
  return { c, s, drops, looks };
}
const SOUND = 'This weapon has been dedicated to Kraanan\'s glory.  Enchanted by Raphael.\r\n\r\n' +
              'This mace is notched and stained with blood but is still an effective weapon.';
const SHATTERED = 'This mace has been shattered by a powerful blow.';
const isMace = d => d.id === 11023;

console.log('\nfreeRoomFor(): a precious item leaves only on a fresh look at its own id');
{
  const t = packClient({ inventory: [{ id: 11023, nameRsc: 10 }], broken: [11023],
                         look: id => ({ id, description: SOUND }) });
  const r = await freeRoomFor(t.s, { precious: isMace });
  ok('THE INCIDENT: a condemned dedicated mace that looks sound is NOT dropped',
     t.drops.length === 0 && r.dropped.length === 0, JSON.stringify(r));
  ok('the look was of that id, and the condemnation is lifted',
     t.looks.join(',') === '11023' && !brokenSet(t.c).has(11023) && r.kept?.[0]?.verdict === 'sound',
     JSON.stringify({ looks: t.looks, kept: r.kept }));
}
{
  const t = packClient({ inventory: [{ id: 11023, nameRsc: 10 }], broken: [11023],
                         look: id => ({ id, description: SHATTERED }) });
  const r = await freeRoomFor(t.s, { precious: isMace });
  ok('a precious item the server describes as shattered is dropped', t.drops.join(',') === '11023', JSON.stringify(r));
}
{
  const t = packClient({ inventory: [{ id: 11023, nameRsc: 10 }], broken: [11023], look: () => null });
  const r = await freeRoomFor(t.s, { precious: isMace });
  ok('no reply is not permission: kept, and still condemned',
     t.drops.length === 0 && brokenSet(t.c).has(11023) && r.kept?.[0]?.verdict === 'unknown', JSON.stringify(r));
}
{
  // The look race in CLAUDE.md: a reply carrying the PREVIOUS object's id, with its description.
  const t = packClient({ inventory: [{ id: 11023, nameRsc: 10 }], broken: [11023],
                         look: () => ({ id: 10641, description: SHATTERED }) });
  const r = await freeRoomFor(t.s, { precious: isMace });
  ok('a shattered description that came back under another id is not evidence', t.drops.length === 0, JSON.stringify(r));
}
{
  const t = packClient({ inventory: [{ id: 501, nameRsc: 11 }, { id: 502, nameRsc: 12 }], broken: [501],
                         look: () => { throw new Error('no look expected'); } });
  const r = await freeRoomFor(t.s, { precious: isMace });
  ok('ordinary condemned gear and junk are shed as before, with no look',
     t.drops.sort().join(',') === '501,502' && t.looks.length === 0, JSON.stringify(r));
}
{
  const t = packClient({ inventory: [{ id: 11023, nameRsc: 10 }], broken: [11023], look: () => null });
  const r = await freeRoomFor(t.s);
  ok('with no precious predicate the old behaviour is unchanged', t.drops.join(',') === '11023', JSON.stringify(r));
}
{
  const t = packClient({ inventory: [{ id: 11023, nameRsc: 10 }], broken: [11023],
                         look: id => ({ id, description: SOUND }) });
  const r = await freeRoomFor(t.s, { precious: () => { throw new Error('boom'); } });
  ok('a precious predicate that throws protects rather than drops', t.drops.length === 0, JSON.stringify(r));
}
{
  const t = packClient({ inventory: [{ id: 7, nameRsc: 10 }], look: id => ({ id, description: 'This mace is in flawless condition.' }) });
  ok('confirmBroken on a sound item reads sound', await confirmBroken(t.s, 7) === 'sound');
  const u = packClient({ inventory: [{ id: 7, nameRsc: 10 }], look: id => ({ id, description: 'A mace.' }) });
  ok('confirmBroken on a description without a condition phrase reads unknown and changes nothing',
     await confirmBroken(u.s, 7) === 'unknown' && !brokenSet(u.c).has(7));
}

// ---------------------------------------------------------------- the keeper's call site
console.log('\nmakeWeapon passes the keeper\'s protection to freeRoomFor');
{
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'autopilot', 'gear.mjs'), 'utf8');
  ok('makeWeapon calls freeRoomFor with a precious predicate built from heldBackIds and protected names',
     /skills\.freeRoomFor\(s,\s*\{\s*precious:/.test(src) && /heldBackIds\?\.\(c\)/.test(src) &&
       /protectedItemNames\?\.\(\)/.test(src) && !/skills\.freeRoomFor\(s\)/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
