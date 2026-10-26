#!/usr/bin/env node
import { readToolSource } from './autopilot/source.mjs';
// Offline contract for the CURSE SUSPECT and the TROLL MYSTIC SWORD. Opens no socket.
//
// Operator, 2026-10-16: "an un-curse DUM-bot request that gets triggered if a bot finds itself cursed
// and needing to switch weapons for farming reasons". The keeper's half is here: it must KNOW, and
// publish, that the weapon in hand will not come off (`weapon_magic.curse_suspect`). Pinned:
//   - the server's "seems to cling to your hand" during a swap is a certain curse, named by the id in
//     hand, and stops equipBest trying the rest of the pack (each would be refused the same way);
//   - three swaps off the same weapon refused with no reason make a SUSPECT; a veto, a cancel, a
//     ranking that kept the held weapon or a broken candidate does not count;
//   - a swap that goes through, or a remove curse, clears it; `since` is stable for one incident;
//   - a name-level curse mark does not poison a same-named twin the server grades rarity 0;
//   - against trolls every mystic sword is a candidate, banned or cursed, EXCEPT an identified magic
//     one (saved for PvP);
//   - a remove curse keeps the cursed mark and sweepCursed drops the freed weapon (operator, 2026-10-23).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Autopilot } from './m59-autopilot.mjs';
import { equipBest, weaponRanking, markCursedItem, isCursedItem, isMysticSword } from './m59-skills.mjs';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };

// A pack of {name, rarity, id?}; `using` starts with `held` (an id); `refuse` maps a used id to the
// sentence the fake server answers instead of wielding it.
function session(items, { held = null, refuse = {}, hooks = {} } = {}) {
  const c = {
    inventory: items.map((it, i) => ({ id: it.id ?? i + 1, nameRsc: 1000 + i, flags: 0, rarity: it.rarity ?? 0 })),
    rsc: { get: r => items[r - 1000]?.name ?? '' },
    using: new Set(held != null ? [held] : []), statsById: new Map(), evSeq: 0,
  };
  const sent = [];
  let last = null;
  c.use = id => { sent.push(id); c.evSeq++; last = refuse[id] ?? null; if (!last) c.using = new Set([id]); };
  c.waitFor = async () => ({ events: last ? [{ kind: 'message', text: last }] : [{ kind: 'equipment' }] });
  const s = { need: () => c, client: c, pacer: { submit: async (k, f) => f() }, ...hooks };
  return { s, c, sent };
}

function keeper(policy = {}, client = null) {
  const ap = Object.create(Autopilot.prototype);
  ap.policy = policy;
  ap.notes = []; ap.events = [];
  ap.note = (what, d) => ap.notes.push({ what, ...d });
  ap.ledgerEvent = (kind, d) => ap.events.push({ kind, ...d });
  ap.s = { client, world: { room: { num: 597 } } };
  return ap;
}

// ------------------------------------------------------------------------------- equipBest
await ok('a cling during a swap is a certain curse: named by the id in hand, the rest of the pack untried', async () => {
  let heard = null;
  const { s, c, sent } = session(
    [{ name: 'long sword' }, { name: 'long sword' }, { name: 'hammer' }],
    { held: 1, refuse: { 2: 'The long sword seems to cling to your hand!', 3: 'The long sword seems to cling to your hand!' },
      hooks: { onCursedInHand: (items, said) => { heard = { items, said }; } } });
  c._magicWeaponIds = new Set([2]);                 // the dedicated twin ranks first
  const r = await equipBest(s, { refresh: false });
  assert.equal(r.wielding, null);
  assert.deepEqual(r.cursed_in_hand, [{ id: 1, name: 'long sword' }]);
  assert.equal(sent.length, 1, 'stops at the first cling: ' + JSON.stringify(sent));
  assert.deepEqual(heard.items, [{ id: 1, name: 'long sword' }]);
  assert.match(heard.said, /cling/);
  assert.ok(c._cursedItemIds.has(1), 'the id in hand is marked');
  assert.ok(!c._cursedItemIds.has('name:long sword'), 'by id only: the twins stay choosable');
});

await ok('a refusal with no sentence is still just a rejection (no curse claimed)', async () => {
  const { s } = session([{ name: 'long sword' }, { name: 'long sword' }], { held: 1, refuse: { 2: 'You feel a breeze.' } });
  s.client._magicWeaponIds = new Set([2]);
  const r = await equipBest(s, { refresh: false, maxTries: 1 });
  assert.equal(r.cursed_in_hand, undefined);
  assert.equal(r.rejected.length, 1);
});

// ------------------------------------------------------------------------------- twin exemption
await ok('a name-level curse mark does not reach a twin the server grades normal (rarity 0)', () => {
  const { c } = session([{ name: 'long sword', rarity: 0 }, { name: 'long sword', rarity: 0 }, { name: 'long sword', rarity: 100 }]);
  markCursedItem(c, { id: 1, name: 'long sword' });
  assert.equal(isCursedItem(c, c.inventory[0], 'long sword'), true, 'the id the server refused stays cursed');
  assert.equal(isCursedItem(c, c.inventory[1], 'long sword'), false, 'the rarity-0 twin is clean');
  assert.equal(isCursedItem(c, c.inventory[2], 'long sword'), true, 'an unread twin may be the cursed one');
  assert.equal(isCursedItem(c, { id: 9, nameRsc: 1000 }, 'long sword'), true, 'no grade: the name mark holds');
});

// ------------------------------------------------------------------------------- troll mystic swords
const names = r => r.map(x => x.name);
await ok('against trolls a BANNED mystic sword is a candidate; against anything else the ban stands', () => {
  const { c } = session([{ name: 'mystic sword' }, { name: 'long sword' }]);
  assert.ok(!names(weaponRanking(c, { banned: ['mystic sword'] })).includes('mystic sword'));
  assert.ok(names(weaponRanking(c, { banned: ['mystic sword'], trollQuarry: true })).includes('mystic sword'));
});

await ok('against trolls a CURSED mystic sword is a candidate (named, graded 200, or learned)', () => {
  const { c } = session([{ name: 'cursed mystic sword', rarity: 200 }, { name: 'mystic sword', rarity: 0, id: 7 }]);
  markCursedItem(c, { id: 7, name: 'mystic sword' });
  const r = names(weaponRanking(c, { trollQuarry: true }));
  assert.ok(r.includes('cursed mystic sword'), JSON.stringify(r));
  assert.equal(r.filter(x => x === 'mystic sword').length, 1, 'the learned-cursed one too');
  assert.deepEqual(names(weaponRanking(c, {})), [], 'without trolls both stay out');
});

await ok('the ONE exception: an identified magic (non-cursed) mystic sword is saved for PvP; an unread one is a candidate', () => {
  // Operator, 2026-10-23: unread weapons are wielded; a curse proves itself by clinging (sweepCursed drops it).
  const { c } = session([{ name: 'mystic sword', rarity: 2 }, { name: 'mystic sword', rarity: 100 }, { name: 'long sword' }]);
  assert.deepEqual(names(weaponRanking(c, { banned: ['mystic sword'], trollQuarry: true })).sort(), ['long sword', 'mystic sword']);
});

await ok('the troll exemption reaches equipBest through the session hook, and only through it', async () => {
  const { s } = session([{ name: 'mystic sword' }], { hooks: { equipTrollQuarry: () => true } });
  assert.equal((await equipBest(s, { banned: ['mystic sword'], refresh: false })).wielding, 'mystic sword');
  const { s: s2 } = session([{ name: 'mystic sword' }]);
  assert.equal((await equipBest(s2, { banned: ['mystic sword'], refresh: false })).wielding, null);
  assert.ok(isMysticSword('Mystic Sword') && !isMysticSword('long sword'));
});

await ok('huntsTrolls reads the hunt, string or list', () => {
  assert.equal(keeper({ hunt: 'troll' }).huntsTrolls(), true);
  assert.equal(keeper({ hunt: ['skeleton', 'troll'] }).huntsTrolls(), true);
  assert.equal(keeper({ hunt: 'orc' }).huntsTrolls(), false);
  assert.equal(keeper({ hunt: null }).huntsTrolls(), false);
});

// ------------------------------------------------------------------------------- the suspect
const refusedSwap = { wielding: null, rejected: [{ id: 2, why: 'the server never added it to the use list and said nothing about why' }] };
await ok('three refused swaps off the same weapon make a suspect; two do not', () => {
  const { c } = session([{ name: 'long sword', id: 14493 }]);
  const ap = keeper({}, c);
  assert.equal(ap.noteSwapOutcome(refusedSwap, 14493, 14493), false);
  ap.noteSwapOutcome(refusedSwap, 14493, 14493);
  assert.equal(ap._curseSuspect ?? null, null);
  ap.noteSwapOutcome(refusedSwap, 14493, 14493);
  assert.equal(ap._curseSuspect.id, 14493);
  assert.equal(ap._curseSuspect.name, 'long sword');
  assert.equal(ap._curseSuspect.certain, false);
  assert.ok(ap.events.some(e => e.kind === 'curse_suspected'));
});

await ok('a veto, a cancel, a kept weapon, a broken candidate or no candidate is not the hand refusing', () => {
  const ap = keeper({}, session([{ name: 'long sword', id: 5 }]).c);
  for (let i = 0; i < 5; i++) {
    ap.noteSwapOutcome({ ...refusedSwap, vetoed: true }, 5, 5);
    ap.noteSwapOutcome({ ...refusedSwap, cancelled: true }, 5, 5);
    ap.noteSwapOutcome({ wielding: 'long sword', already_wielded: true }, 5, 5);
    ap.noteSwapOutcome({ wielding: null, rejected: [{ id: 2, why: 'the server says it is broken' }] }, 5, 5);
    ap.noteSwapOutcome({ wielding: null, note: 'nothing wieldable' }, 5, 5);
  }
  assert.equal(ap._curseSuspect ?? null, null);
});

await ok('a different weapon in hand starts the count again', () => {
  const ap = keeper({}, session([{ name: 'long sword', id: 5 }, { name: 'axe', id: 6 }]).c);
  ap.noteSwapOutcome(refusedSwap, 5, 5); ap.noteSwapOutcome(refusedSwap, 5, 5);
  ap.noteSwapOutcome(refusedSwap, 6, 6);
  assert.equal(ap._curseSuspect ?? null, null);
});

await ok('a swap that goes through clears it; a remove curse clears it', () => {
  const ap = keeper({}, session([{ name: 'long sword', id: 5 }]).c);
  ap.noteCurseSuspect({ items: [{ id: 5, name: 'long sword' }], certain: true });
  assert.equal(ap.noteSwapOutcome({ wielding: 'long sword', id: 9 }, 5, 9), true);
  assert.equal(ap._curseSuspect, null);
  ap.noteCurseSuspect({ items: [{ id: 5, name: 'long sword' }], certain: true });
  ap.noteUncursed('long sword', 'Your long sword loses its ominous luster.');
  assert.equal(ap._curseSuspect, null);
  assert.ok(ap.events.some(e => e.kind === 'curse_suspect_cleared'));
});

// Operator, 2026-10-23: "fix the curse with uncurse & dropping it". The remove curse leaves the attribute on
// the item, so the mark stays and sweepCursed drops the freed weapon -- only an id the hand refused to
// release, only once it is out of the hand, never a normal-grade item an id was recycled onto.
await ok('a remove curse keeps the mark, and sweepCursed drops the freed weapon and nothing else', async () => {
  const { s, c } = session([{ name: 'hammer', id: 5, rarity: 100 }, { name: 'long sword', id: 6, rarity: 0 },
                            { name: 'mace', id: 7, rarity: 100 }], { held: 7 });
  const dropped = [];
  c.drop = specs => { for (const sp of specs) { const id = sp?.id ?? sp; dropped.push(id); c.inventory = c.inventory.filter(o => o.id !== id); } };
  c.requestInventory = () => {};
  const ap = keeper({}, c);
  ap.s = { ...s, world: { room: { num: 350 } } };
  ap.protectedItemNames = () => [];
  markCursedItem(c, { id: 5 });                       // refused to release, now freed by a remove curse
  markCursedItem(c, { id: 6 });                       // an id recycled onto an ordinary long sword
  markCursedItem(c, { id: 7 });                       // still in the hand: not droppable yet
  ap.noteUncursed('hammer', 'Your hammer loses its ominous luster.');
  assert.ok(c._cursedItemIds.has(5), 'the mark outlives the remove curse');
  await new Promise(r => setTimeout(r, 1500));        // noteUncursed starts the sweep itself
  assert.deepEqual(dropped, [5], 'only the freed, non-normal, cursed weapon: ' + JSON.stringify(dropped));
  assert.equal(await ap.sweepCursed(), null, 'and a second sweep inside the gap does nothing');
  assert.ok(!c._cursedItemIds.has(5), 'the mark goes with the item');
  assert.ok(c._cursedItemIds.has(7), 'the one still in hand keeps its mark');
  assert.ok(ap.events.some(e => e.kind === 'cursed_dropped'));
});

await ok('since is stable for one incident, and a suspicion is upgraded to certain without restarting it', () => {
  const ap = keeper({}, session([{ name: 'long sword', id: 5 }]).c);
  const first = ap.noteCurseSuspect({ items: [{ id: 5, name: 'long sword' }], certain: false });
  const since = first.since;
  const up = ap.noteCurseSuspect({ items: [{ id: 5, name: 'long sword' }], certain: true, said: 'clings' });
  assert.equal(up.certain, true);
  assert.equal(up.since, since);
  const again = ap.noteCurseSuspect({ items: [{ id: 5, name: 'long sword' }], certain: false });
  assert.equal(again.certain, true, 'a weaker reading never downgrades a certain one');
});

await ok('the keeper wires both hooks and publishes the suspect on weapon_magic', () => {
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'latin1');
  assert.ok(src.includes('session.equipTrollQuarry = () => this.huntsTrolls();'));
  assert.ok(src.includes('session.onCursedInHand = (items, said) => this.noteCurseSuspect('));
  assert.ok(src.includes('curse_suspect: this._curseSuspect ?? null'));
  assert.ok(!/MAGIC SWAP', \{ to: id, result: r\?\.ok/.test(src), 'the swap result is no longer a field equipBest never returns');
});

console.log(`\n${n} passed`);
