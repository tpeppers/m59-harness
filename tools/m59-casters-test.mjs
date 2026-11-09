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
  { const w = keeper({ hp: 90, max: 90 });
    ok('a farmer holding a spot at FULL health waiting for prey stays (Farol 546, 2026-11-07)',
       (await w.k.leaveForCasters({ hostiles: hostile(['kyip-kyip-kreeet avar shaman']) })) === false && !w.travels.length && w.k.hold !== null); }
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

console.log('healthy Great Ocean farmers can retain proved cover from a rock throw');
{
  const { loadMap, CHECKED_MAP_FILE } = await import('./m59-map.mjs');
  const { sharedRoomGeometry } = await import('./m59-roo.mjs');
  const { validateStrategy } = await import('./m59-strategy-schema.mjs');
  const room = loadMap(CHECKED_MAP_FILE).rooms[552];
  const geometry = sharedRoomGeometry(room);
  const blocked = { row: 45, col: 65 };
  const mollusk = (at = blocked) => ({ ...hostile(['mollusk creature'])[0], ...at });
  const coastal = (args = {}) => {
    const { hp = 112, at = { row: 45, col: 55 }, bodies = [mollusk()],
      geo = geometry, damageAt = 0, enabled = true } = args;
    const f = keeper({ hp, max: 121, hold: { ...at, room: 552 } });
    const { k } = f;
    Object.assign(k.s.world, { room, geometry: geo });
    Object.assign(k.s.client, { self: at, room: { security: geometry.security,
      objects: new Map(bodies.map(o => [o.id, o])) } });
    k.policy.molluskCoverRecovery = enabled;
    k.mode = 'farm';
    k.s.damagedAt = damageAt;
    return f;
  };
  const stay = async (label, f) => ok(label,
    !(await f.k.leaveForCasters()) && f.travels.length === 0 && !!f.k.hold && !f.k._casterExitAt);
  const leave = async (label, f) => ok(label,
    (await f.k.leaveForCasters()) && f.travels[0]?.opts.casterExit === true && f.k.hold === null);
  await stay('at the ten-square boundary, both geometry views block the rock throw', coastal());
  await stay('outside ten squares, a possible line of sight is out of rock range',
    coastal({ at: { row: 27, col: 1 }, bodies: [mollusk({ row: 27, col: 12 })] }));
  await leave('at ten squares a rock may reach us when either server LOS view allows it',
    coastal({ bodies: [mollusk({ row: 45, col: 45 })] }));
  await leave('a true caster anywhere retains the original escape', coastal({ bodies: [mollusk(),
    { ...hostile(['orc wizard'])[0], id: 101, row: 45, col: 66 }] }));
  await leave('low current health retains the original escape', coastal({ hp: 90 }));
  await leave('recent damage retains the original escape', coastal({ damageAt: Date.now() }));
  await leave('missing geometry retains the original escape', coastal({ geo: null }));
  await leave('an unconfirmed player position retains the original escape',
    coastal({ at: { row: 45, col: 55, predicted: true } }));
  await leave('an unknown caster position retains the original escape',
    coastal({ bodies: [mollusk({ row: null, col: 65 })] }));
  await leave('an unresolved hostile type does not prove cover from the entire scene', coastal({ bodies: [mollusk(),
    { ...hostile(['unresolved hostile'])[0], id: 101, row: 45, col: 66 }] }));
  await leave('the unchanged default evacuates even from locally blocked rocks', coastal({ enabled: false }));
  const outside = coastal();
  outside.k.s.world.room = { ...room, num: 562 };
  await leave('the opt-in cannot change the rule outside 552', outside);
  const exposed = coastal({ hp: 30, at: { row: 61, col: 30 },
    bodies: [mollusk({ row: 60, col: 30 })] });
  ok('Kermit’s melee wall cannot be adopted or reused for recovery with a live throwing line',
    exposed.k.wallHere()?.ok === true && !exposed.k.currentRecoveryWall() &&
    !exposed.k.adoptRecoveryWall() && !exposed.k.sessionSpotHere());
  const covered = coastal({ hp: 3, at: { row: 43, col: 57 },
    bodies: [mollusk({ row: 44, col: 55 })] });
  ok('Pepe’s blocked throwing line still permits recovery at very low HP',
    covered.k.currentRecoveryWall()?.ok && covered.k.sessionSpotHere());
  const caster = covered.k.s.client.room.objects.values().next().value;
  caster.col = 56;
  caster.row = 43;
  ok('a moved ranged attacker invalidates previously proved cover before another rest',
    !covered.k.currentRecoveryWall() && !covered.k.sessionSpotHere());
  const legacy = coastal({ enabled: false, at: { row: 61, col: 30 },
    bodies: [mollusk({ row: 60, col: 30 })] });
  ok('non-opted-in recovery uses the prior melee wall verdict',
    legacy.k.currentRecoveryWall()?.ok === true);
  const onlyWall = (f, at, onward = null) => {
    const k = f.k, { client } = k.s;
    k.spotExclusions = () => null;
    return k.searchSafeSpot(geometry, client.self, room, { within: 100, los: 0, recovery: true,
      stats: {}, onward, candidateFilter: (col, row) => (at.row === row && at.col === col) ||
        (onward?.row === row && onward.col === col) });
  };
  ok('the recovery search rejects the exposed wall before walking to it',
    onlyWall(exposed, { row: 61, col: 30 }) === null);
  caster.col = 55;
  caster.row = 44;
  ok('the recovery search retains a verified covered wall',
    onlyWall(covered, { row: 43, col: 57 })?.row === 43);
  const fallback = coastal({ at: { row: 61, col: 28 },
    bodies: [{ ...hostile(['unresolved hostile'])[0], row: 45, col: 66 }] });
  ok('an uncertain caster scene blocks walls but keeps a verified onward exit eligible',
    onlyWall(fallback, { row: 61, col: 30 }, { row: 65, col: 27 })?.kind === 'exit');
  const { restUntil } = await import('./m59-skills.mjs');
  const k = covered.k, c = k.s.client;
  let rests = 0;
  c.rest = () => { rests++; };
  c.stats = () => {};
  c.waitFor = async () => ({ events: [] });
  Object.assign(k.s, { need: () => c, pacer: { async submit(lane, action) {
    if (lane === 'rest') { caster.row = 43; caster.col = 56; }
    return action();
  } } });
  const queued = await restUntil(k.s, { health:1, shouldCancel: () => !k.currentRecoveryWall() });
  ok('a ranged attacker acquiring a line while rest is queued prevents the rest packet',
    queued.cancelled === true && !rests);
  const spec = validateStrategy({ name: 'great-ocean', molluskCoverRecovery: true });
  ok('the strategy opts in with a boolean, without changing protected recovery thresholds',
    spec.ok && spec.strategy.desired.molluskCoverRecovery === true &&
    !validateStrategy({ name: 'great-ocean', molluskCoverRecovery: 'true' }).ok &&
    !validateStrategy({ name: 'great-ocean', restBelow: 0.2 }).ok);
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
     && /&& !approachRoom && !survivalExitLeg\b/.test(src));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
