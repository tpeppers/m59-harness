#!/usr/bin/env node
// Offline tests for tools/fleetscripts/shadow-rift.mjs -- the pure halves only: the Qor spell-power model (qorItemMod,
// bestSet with dukeRank and the opt-in orc shield), the rift rate, the collapse forecast, the mystic-touch size and the
// no-waste rule, the karma gate for Qor 4 (-40), the seat check, the cluster squares, and the param parsers.
// No socket, no roster, no broker: nothing here touches a fleet.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  qorItemMod, bestSet, orcShieldFor, soldierOf, riftRate, joinPower, riftKarmaBlocks, RIFT_KARMA, rollChance,
  seatProblems, manaRegen, touchCap, touchAmount, donorSupply, touchWorth, forecastRift, clusterSquare, parseSquare,
  mushroomShopFor, vaultFor, parseHalls, isIsland, enemyMatcher, qorBonusAt, setLogDir, logDir, RIFT, script,
} from './fleetscripts/shadow-rift.mjs';

let n = 0;
const ok = (name, fn) => { try { fn(); n++; } catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1; } };
const item = (name, owner, extra = {}) => ({ name, owner, amount: 1, equipped: false, cursed: false, broken: false, unidentified: false, ...extra });
const cand = (agent, items, extra = {}) => ({ agent, items, ability: 80, karma: -60, factionSoldier: true, ...extra });

// ------------------------------------------------------------------ item modifiers (m59-spellpower, kod-generated)
ok('qorItemMod: mace adds, scimitar subtracts, circlet is 0', () => {
  assert.equal(qorItemMod(item('mace')), 5);
  assert.equal(qorItemMod(item('scimitar')), -20);
  assert.equal(qorItemMod(item('long sword')), -10);
  assert.equal(qorItemMod(item('circlet')), 0);
  assert.equal(qorItemMod(item('orc shield')), 15);
});
ok('qorItemMod: a Duke soldier shield is 15 x rank / 10 (dukeshld.kod:153)', () => {
  const s = item("shield of the duke's army");
  assert.equal(qorItemMod(s, { dukeRank: 1 }), 1);
  assert.equal(qorItemMod(s, { dukeRank: 5 }), 7);
  assert.equal(qorItemMod(s, { dukeRank: 10 }), 15);   // supreme hero: the same +15 as an orc shield
});
ok('qorItemMod: a disciple robe is +4 x Qor level when its school reads Qor, +5 unread, less for another school', () => {
  assert.equal(qorItemMod(item('robe of the disciples', 'a', { robe_school: 'Qor' }), { qorLevel: 4 }), 16);
  assert.equal(qorItemMod(item('robe of the disciples')), 5);
  assert.ok(qorItemMod(item('robe of the disciples', 'a', { robe_school: "Shal'ille" }), { qorLevel: 4 }) < 16);
});

// ------------------------------------------------------------------ bestSet: pooling, locks, the orc shield gate
ok('bestSet pools the group: the mace and the Qor robe from others, the circlet for the head', () => {
  const me = cand('a', [item('long sword', 'a', { equipped: true })]);
  const pool = [...me.items, item('mace', 'b'), item('robe of the disciples', 'c', { robe_school: 'Qor' }), item('circlet', 'b')];
  const r = bestSet(me, pool, { qorHour: 2 });
  assert.equal(r.set.weapon.name, 'mace');
  assert.equal(r.set.armour.name, 'robe of the disciples');
  assert.equal(r.set.helm.name, 'circlet');
  assert.equal(r.items, 5 + 16);
  // base floor(80/2)=40 + hour 2 + karma floor(60/10)=6 + faction 0 + items 21
  assert.equal(r.sp, 40 + 2 + 6 + 21);
});
ok('bestSet: a -20 scimitar loses to bare hands; a cursed or unidentified WORN weapon locks the slot', () => {
  const me = cand('a', [item('scimitar', 'a')]);
  assert.equal(bestSet(me, me.items).set.weapon, null);
  const cursed = cand('a', [item('scimitar', 'a', { equipped: true, cursed: true })]);
  const r = bestSet(cursed, [...cursed.items, item('mace', 'b')]);
  assert.equal(r.set.weapon.name, 'scimitar');
  assert.deepEqual(r.locked, ['weapon']);
  const unid = cand('a', [item('scimitar', 'a', { equipped: true, unidentified: true })]);
  assert.deepEqual(bestSet(unid, unid.items).locked, ['weapon']);
});
ok("bestSet: a Duke shield is the owner's own; dukeRank changes its worth", () => {
  const me = cand('a', []);
  const other = [item("shield of the duke's army", 'b')];
  assert.equal(bestSet(me, other, { dukeRank: 10 }).set.shield, null);
  const mine = cand('a', [item("shield of the duke's army", 'a')]);
  assert.equal(bestSet(mine, mine.items, { dukeRank: 10 }).items, 15);
  assert.equal(bestSet(mine, mine.items, { dukeRank: 1 }).items, 1);
});
ok('the orc shield is OPT-IN: off by default, never for a soldier or an unread soldier, needs karma <= -50', () => {
  const pool = [item('orc shield', 'b')];
  const civ = cand('a', [], { factionSoldier: false, karma: -60 });
  assert.equal(bestSet(civ, pool).set.shield, null, 'default orcShield=false');
  assert.equal(bestSet(civ, pool, { orcShield: true }).set.shield.name, 'orc shield');
  assert.equal(bestSet(cand('a', [], { factionSoldier: true }), pool, { orcShield: true }).set.shield, null, 'soldier');
  assert.equal(bestSet(cand('a', [], { factionSoldier: null }), pool, { orcShield: true }).set.shield, null, 'unread');
  assert.equal(bestSet(cand('a', [], { factionSoldier: false, karma: -45 }), pool, { orcShield: true }).set.shield, null, 'orcshld.kod ReqUse karma > -50');
  assert.equal(orcShieldFor(civ, false), false);
  assert.equal(orcShieldFor(civ, true), true);
});
ok('soldierOf: a soldier shield in the pack says soldier; else the cache; else unread', () => {
  assert.equal(soldierOf([{ name: "shield of the duke's army" }], null), true);
  assert.equal(soldierOf([{ name: 'shield of the rebel militia' }], { faction: 'duke', soldier: false }), true);
  assert.equal(soldierOf([], { faction: 'duke', soldier: false }), false);
  assert.equal(soldierOf([], null), null);
});
ok('bestSet: a two-handed bow cannot sit beside a shield', () => {
  const me = cand('a', [item('long bow', 'a', { equipped: true, cursed: true })]);
  const r = bestSet(me, [...me.items, item("shield of the duke's army", 'a')], { dukeRank: 10 });
  assert.equal(r.set.weapon.name, 'long bow');
  assert.equal(r.set.shield, null);
});
ok('bestSet: sp is bound to 1..99 and the hour term to 0..30', () => {
  assert.equal(bestSet(cand('a', [], { ability: 0, karma: 0 }), [], { qorHour: 0 }).sp, 1);
  assert.equal(bestSet(cand('a', [], { ability: 200, karma: -200 }), [], { qorHour: 99 }).sp, 99);
  assert.equal(bestSet(cand('a', []), [], { qorHour: 99 }).hour, 30);
});
ok('qorBonusAt stays inside 2..26 over a whole game day', () => {
  for (let t = 0; t < 2 * 3600_000; t += 300_000) { const b = qorBonusAt(1_800_000_000_000 + t); assert.ok(b >= 2 && b <= 26, `bonus ${b}`); }
});

// ------------------------------------------------------------------ the rift rate and the karma gate
ok('riftRate is bound((sp+1)/25, 1, 4); joinPower adds floor(sp/2) at once', () => {
  assert.equal(riftRate(1), 1); assert.equal(riftRate(48), 1); assert.equal(riftRate(49), 2);
  assert.equal(riftRate(74), 3); assert.equal(riftRate(99), 4);
  assert.equal(joinPower(60, 10), 30 + 2 * 10);
});
ok('Qor 4 karma gate is -40: -40 casts, -39 is refused; an unread karma is left to the seat check', () => {
  assert.equal(RIFT_KARMA, -40);
  assert.equal(riftKarmaBlocks(-40), false);
  assert.equal(riftKarmaBlocks(-39), true);
  assert.equal(riftKarmaBlocks(NaN), false);
});
ok('seatProblems: karma strict (unread fails), feathers, vigor and mana budgeted for failed rolls', () => {
  const good = { room: 101, wantRoom: 101, sees: true, karma: -40, feathers: 4, vigor: 81, mana: 60 };
  assert.deepEqual(seatProblems(good, 2), []);
  assert.match(seatProblems({ ...good, karma: -39 }, 2).join(), /karma -39/);
  assert.match(seatProblems({ ...good, karma: NaN }, 2).join(), /karma/);
  assert.match(seatProblems({ ...good, feathers: 3 }, 2).join(), /3 feathers/);
  assert.match(seatProblems({ ...good, vigor: 80 }, 2).join(), /vigor/);   // > 40 + 20 x 2
  assert.match(seatProblems({ ...good, mana: 59 }, 2).join(), /mana/);     // >= 30 + 15 x 2
  assert.match(seatProblems({ ...good, room: 102 }, 2).join(), /in 102/);
  assert.match(seatProblems({ ...good, sees: false }, 2).join(), /prism/);
});
ok('rollChance is bound(myst + (100-myst)*sp/100, 5, 95)', () => {
  assert.equal(rollChance(25, 0), 25);
  assert.equal(rollChance(50, 50), 75);
  assert.equal(rollChance(90, 99), 95);
  assert.equal(rollChance(0, 1), 5);
});

// ------------------------------------------------------------------ mystic touch: size and the no-waste rule
ok('touchCap is min(1.5 x max, 75); touchAmount is pct of current mana, at least 1, at most mana - 3', () => {
  assert.equal(touchCap(40), 60); assert.equal(touchCap(60), 75); assert.equal(touchCap(0), 0);
  assert.equal(touchAmount(60, 10), 6); assert.equal(touchAmount(5, 10), 1); assert.equal(touchAmount(4, 55), 1);
  assert.equal(touchAmount(100, 55), 55);
});
ok('touchWorth: never into a full tank, never below the floor, only when ripe unless in danger', () => {
  const base = { donorMana: 60, donorMax: 60, targetMana: 30, targetMax: 60, pct: 10, touchAt: 0.9 };
  assert.equal(touchWorth(base).go, true);
  assert.equal(touchWorth(base).amount, 6);
  assert.equal(touchWorth({ ...base, targetMana: 70 }).go, false, '70 + 6 > cap 75: wasted');
  assert.equal(touchWorth({ ...base, targetMana: 69 }).go, true, '69 + 6 = 75: not wasted');
  assert.equal(touchWorth({ ...base, donorMana: 40 }).go, false, 'not ripe at 40/60');
  assert.equal(touchWorth({ ...base, donorMana: 40, danger: true }).go, true, 'danger spends any mana above the floor');
  assert.equal(touchWorth({ ...base, donorMana: 8, danger: true }).go, false, 'floor: <= 3 + 5');
  assert.equal(touchWorth({ ...base, reserve: 54 }).go, false, 'a seat keeps its join reserve');
  assert.equal(touchWorth({ ...base, targetMana: NaN }).go, false);
});
ok('donorSupply: regen x a/(a+3), and nothing from an empty tank', () => {
  assert.equal(manaRegen(200, 60), 200 * 60 / 25000);
  const a = 60 * 10 / 100;
  assert.equal(donorSupply(200, 60, 10), manaRegen(200, 60) * a / (a + 3));
  assert.equal(donorSupply(200, 0, 10), 0);
});

// ------------------------------------------------------------------ the collapse forecast
ok('forecastRift: a lone sp-49 primary with 75 mana and no donors cannot carry 1500', () => {
  const f = forecastRift({ chanters: [{ sp: 49, mana: 75, vigor: 200, maxMana: 60, chanting: false }], supply: 0 });
  assert.equal(f.rate, 2);
  assert.equal(f.T, (1500 - 24) / 2);
  assert.equal(f.pool, 75 - RIFT.joinMana);
  assert.ok(Math.abs(f.drain - (1 - manaRegen(160, 60))) < 1e-9);
  assert.equal(f.ok, false);
});
ok('forecastRift: enough supply makes it last forever; margin is applied; stored power shortens T', () => {
  const ch = [{ sp: 99, mana: 75, vigor: 200, maxMana: 60, chanting: true }];
  assert.equal(forecastRift({ chanters: ch, supply: 5 }).lasts, Infinity);
  assert.equal(forecastRift({ chanters: ch, supply: 5 }).ok, true);
  const half = forecastRift({ chanters: ch, supply: 0, have: 1000 });
  assert.equal(half.T, 500 / 4);
  const pool = 75, drain = 1 - manaRegen(200, 60), lasts = pool / drain;
  assert.equal(forecastRift({ chanters: ch, have: 1500 - Math.floor(lasts * 4 / 1.1) }).ok, true);
  assert.equal(forecastRift({ chanters: ch, have: 1500 - Math.ceil(lasts * 4 / 1.0) - 10, margin: 1.1 }).ok, false);
});
ok('forecastRift: a whole circle together adds every rate', () => {
  const f = forecastRift({ chanters: [{ sp: 74 }, { sp: 49 }, { sp: 20 }].map(c => ({ ...c, mana: 60, vigor: 200, maxMana: 60 })) });
  assert.equal(f.rate, 3 + 2 + 1);
});

// ------------------------------------------------------------------ places and squares
ok('clusterSquare rings the prism and never lands ON it; parseSquare reads rNcM', () => {
  const p = { row: 15, col: 15 };
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const s = clusterSquare(p, i);
    assert.ok(!(s.row === 15 && s.col === 15), `slot ${i} is the prism square`);
    assert.ok(Math.max(Math.abs(s.row - 15), Math.abs(s.col - 15)) <= 2);
    seen.add(`${s.row},${s.col}`);
  }
  assert.equal(seen.size, 12, 'twelve distinct squares');
  assert.deepEqual(clusterSquare(p, 12), clusterSquare(p, 0));
  assert.equal(clusterSquare(null, 0), null);
  assert.deepEqual(parseSquare('r15c7'), { row: 15, col: 7 });
  assert.equal(parseSquare('15,7'), null);
});
ok('regions: island vault and no mushroom shop or hall there; mainland shop by region; override wins', () => {
  assert.equal(isIsland(2009), true); assert.equal(isIsland(101), false);
  assert.equal(vaultFor(2009)?.room, 2005);
  assert.equal(vaultFor(101)?.room, 114);
  assert.equal(mushroomShopFor(2009), null);
  assert.equal(mushroomShopFor(101).room, 104);
  assert.equal(mushroomShopFor(360).room, 373);
  assert.equal(mushroomShopFor(50).room, 53);
  assert.deepEqual(mushroomShopFor(2009, '2002:Zala'), { room: 2002, seller: 'Zala' });
  assert.deepEqual(parseHalls('714,703,713', 101), [714, 703]);
  assert.deepEqual(parseHalls('714', 2009), []);
  assert.deepEqual(parseHalls('', 101), []);
});
ok('enemies: exact names only, case-insensitive, none by default', () => {
  const none = enemyMatcher('');
  assert.equal(none('anyone'), false);
  const m = enemyMatcher('Alpha, Bravo Charlie');
  assert.equal(m('alpha'), true); assert.equal(m('Bravo Charlie'), true);
  assert.equal(m('Alphabet'), false); assert.equal(m('Bravo'), false);
});
ok('logDir is a parameter; the default is under substrate/logs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-'));
  try { assert.equal(setLogDir(dir), dir); assert.equal(logDir(), dir); }
  finally { setLogDir(''); rmSync(dir, { recursive: true, force: true }); }
  if (!process.env.M59_SHADOW_RIFT_LOGS) assert.match(logDir().replace(/\\/g, '/'), /\/substrate\/logs$/);
});

// ------------------------------------------------------------------ the script's declared surface carries no fleet's orders
ok('params: room required, primary auto, no halls, no enemies, orc shield off, no restore role', () => {
  const P = script.params;
  assert.equal(P.room.required, true);
  assert.equal(P.room.default, undefined);
  assert.equal(P.primary.default, 'auto');
  assert.equal(P.halls.default, '');
  assert.equal(P.enemies.default, '');
  assert.equal(P.orcShield.default, false);
  assert.equal(P.restoreRole.default, '');
  assert.equal(P.logDir.default, '');
});

console.log(`shadow-rift: ${n} groups passed`);
