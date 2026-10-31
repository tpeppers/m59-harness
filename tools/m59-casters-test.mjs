#!/usr/bin/env node
// A CASTER IN THE ROOM MEANS THE ROOM HAS NO SAFE SPOT -- offline, no socket, no roster.
//
//   node tools/m59-casters-test.mjs
//
// Prod 2026-10-27, Lew (t20) in 2133: on a "proven" spot at 52/90 with an avar shaman and chieftain in the room, 43/90
// thirty seconds later. Monsters cast during the chase with no range or sight check (monster.kod MonsterCanCastSpell),
// so a wall that stops melee stops none of it. Operator: leave the room by the nearest exit. What this pins:
//   * the caster classes, and that the island's clan names resolve to them;
//   * which exit: a room in the confinement first, then one with no caster in its spawn list, then the nearest;
//   * the keeper leaves when resting or hurt with a caster present, and not at full health off a spot, nor with none;
//   * the exit is allowed outside the confinement, and it is tried at most once a minute.
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
};
const C = await import('./m59-casters.mjs');
const A = await import('./m59-autopilot.mjs');
const S = await import('./m59-spawns.mjs');
const sp = S.loadSpawns(A.SPAWN_FILE);

console.log('who casts');
const cls = n => S.creatureByName(sp, n)?.cls ?? null;
ok('both avar shaman clans, the chieftain and the orc wizard are casters',
   ['peet-seeeep avar shaman', 'kyip-kyip-kreeet avar shaman', 'AvarChieftain', 'orc wizard'].every(n => C.isCasterClass(cls(n))));
ok('an avar warrior, a kriipa and a troll are not', !['peet-seeeep avar warrior', 'kriipa', 'troll'].some(n => C.isCasterClass(cls(n))));
ok('castersAmong picks them out of a room', C.castersAmong([{ name: 'peet-seeeep avar warrior' }, { name: 'kyip-kyip-kreeet avar shaman' }], cls).length === 1);

console.log('which way out');
const exits = [{ to: 2132, row: 50, col: 10, reachable: true }, { to: 2124, row: 2, col: 40, reachable: true }, { to: 2115, row: 40, col: 1, reachable: false }];
ok('a room in the confinement first, even if farther', C.casterExit(exits, { here: 2133, from: { row: 57, col: 7 }, confine: [2124] })?.to === 2124);
ok('then a room with no caster spawning in it', C.casterExit(exits, { here: 2133, from: { row: 57, col: 7 }, roomHasCaster: n => n === 2132 })?.to === 2124);
ok('then the nearest', C.casterExit(exits, { here: 2133, from: { row: 57, col: 7 } })?.to === 2132);
ok('an unreachable exit is never chosen', C.casterExit([exits[2]], { here: 2133 }) === null);

console.log('the keeper leaves');
function keeper({ hp = 43, max = 90, hold = { col: 7, row: 57 }, names = ['peet-seeeep avar warrior', 'kyip-kyip-kreeet avar shaman'] } = {}) {
  const travels = [], notes = [];
  const objects = new Map(names.map((n, i) => [100 + i, { id: 100 + i, nameRsc: n, flags: 0x1 }]));
  const c = { selfId: 1, self: { row: 57, col: 7 }, room: { objects }, rsc: { get: x => x }, vitals: () => ({ health: { value: hp, max } }) };
  const k = Object.assign(Object.create(A.Autopilot.prototype), {
    s: { client: c, world: { room: { num: 2133 }, exits: () => exits } }, policy: { confineRooms: [2124, 2115] },
    hold, note: (w, d) => notes.push({ w, d }), releaseHold: () => { k.hold = null; }, operatorSurvivalStandDown: () => false,
    travel: async (room, opts) => { travels.push({ room, opts }); return { arrived: true }; } });
  return { k, travels, notes };
}
const { OF } = await import('./m59-parse.mjs');
const hostile = names => names.map((n, i) => ({ id: 100 + i, nameRsc: n, flags: OF.ATTACKABLE }));
{
  const { k, travels } = keeper();
  const left = await k.leaveForCasters({ hostiles: hostile(['peet-seeeep avar warrior', 'kyip-kyip-kreeet avar shaman']) });
  ok('hurt on a spot with a shaman in the room: walks out by the confinement exit, no logoff', left === true && travels[0]?.room === 2124
     && travels[0].opts.casterExit === true, JSON.stringify(travels));
  ok('and gives up the spot it was holding', k.hold === null);
  const again = await k.leaveForCasters({ hostiles: hostile(['kyip-kyip-kreeet avar shaman']) });
  ok('not tried again within the minute', again === false && travels.length === 1);
}
{
  const { k, travels } = keeper({ hp: 80, hold: null });
  ok('scratched mid-fight off a spot (80/90): the room is not left', (await k.leaveForCasters({ hostiles: hostile(['kyip-kyip-kreeet avar shaman']) })) === false && !travels.length);
  const low = keeper({ hp: 40, hold: null });
  ok('below the rest line off a spot (40/90): it leaves rather than look for a spot here',
     (await low.k.leaveForCasters({ hostiles: hostile(['kyip-kyip-kreeet avar shaman']) })) === true && low.travels.length === 1);
}
{
  const { k, travels } = keeper();
  ok('no caster: nothing to leave for', (await k.leaveForCasters({ hostiles: hostile(['peet-seeeep avar warrior']) })) === false && !travels.length);
}
{
  const { readToolSource } = await import('./autopilot/source.mjs');
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('the survival pass asks it before the about-to-die rungs', /if \(await this\.leaveForCasters\(\{ hostiles, v \}\)/.test(src)
     && src.indexOf('leaveForCasters({ hostiles, v })') < src.indexOf('const worstHit = Math.min(30'));
  // Since 2026-10-30 (probationary, m59-survival-edge.mjs) the caster leg passes the gate as a SURVIVAL EXIT: out of the
  // confinement unless the room is banned or one of ours died to a player there within the PvP hold.
  ok('and the confinement gate lets the caster exit through, as a survival exit',
     /isSurvivalExit\(\{ origin: opts\?\.origin, casterExit: opts\?\.casterExit \}\)/.test(src)
     && /&& !approachRoom && !survivalExitLeg\) \{/.test(src));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
