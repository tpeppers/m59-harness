#!/usr/bin/env node
import { readToolSource } from './autopilot/source.mjs';
// THE PVP RETURN DELAY — offline, no socket, no roster.
//
//   node tools/m59-pvp-return-test.mjs
//
// The operator's order, 2026-09-30: "set it so that there's a 30m PVP delay on returning to
// any farming zone". A player (Morpheus, Human Resistance) camped the farm entrances and killed
// respawned characters one at a time as each walked straight back. What this pins:
//
//   * how a PvP death is recognised — the two live shapes from that night (a guild-combat kill
//     the attribution could only GUESS was a player, and a kill with the player in the room),
//     and every way a monster must NOT read as one (article, unresolved id, a monster's name);
//   * a PvP death holds departures to farming rooms for 30 minutes, then releases them;
//   * a monster death holds nothing; a delay of 0 holds nothing;
//   * the hold survives a keeper restart (a fresh Autopilot reads the persisted record);
//   * what is exempt: an explicit travel order, a leased or busy character, a recovery
//     detour, a walk to a sanctuary;
//   * the broker schema, setter, fleet row and policy_control reflection all carry the key.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'm59-pvp-return-test-'));
const spawnFile = join(dir, 'spawns.json');
writeFileSync(spawnFile, JSON.stringify({ rooms: {
  50:  [],                                               // an inn — no spawns: a sanctuary
  586: [{ creature: 'frogman', huntable: true }],        // a farming room (the assignment)
  999: [{ creature: 'giant rat', huntable: true }],      // another farming room
  700: [],                                               // a town room
}}));
// Everything the keeper writes goes to scratch, BEFORE the imports resolve.
process.env.M59_SPAWN_FILE = spawnFile;
process.env.M59_LEDGER_DIR = join(dir, 'ledger');
process.env.M59_PVP_HOLD_DIR = join(dir, 'holds');
process.env.M59_WAR_FILE = join(dir, 'war.json');
process.env.M59_GRUDGE_FILE = join(dir, 'grudges.json');
writeFileSync(process.env.M59_WAR_FILE, JSON.stringify({ format: 'm59-war/1', our_guild: 'The Second Swines',
  enemy_guilds: { 'human resistance': { name: 'Human Resistance', since: 1 } },
  members: { neo: { name: 'Neo', guild: 'Human Resistance', guild_key: 'human resistance', source: 'guild_combat' } } }));

const { Autopilot, HANDLED, CONTINUE } = await import('./m59-autopilot.mjs');
const { classifyPvpDeath, pvpReturnDelayMs, pvpHoldState, readPvpDeath, pvpHoldFile,
        PVP_RETURN_DELAY_MS_DEFAULT } = await import('./m59-pvp-return.mjs');
const { attributeDeath } = await import('./m59-death-attribution.mjs');
const { rememberedEnemy } = await import('./m59-war.mjs');
const party = await import('./m59-party.mjs');
const { localise } = await import('./m59-localpolicy.mjs');
party.setRosterSource(() => new Set(['Gonzo', 'Rizzo', 'Lew', 'Floyd', 'Sweetums']));

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' -- ' + detail : ''}`);
};
const MIN = 60_000;
const monsterAttribution0 = () => ({ killer: 'frogman', kind: 'named_kill', was_killed_by_player: false });

// ------------------------------------------------------------------ recognising PvP
console.log('recognising a PvP death');
const classify = (o) => classifyPvpDeath({ isFleetmate: party.isFleetmate, enemy: n => rememberedEnemy(n), ...o });

// Lew, prod 2026-09-30 21:33: no ordinary broadcast (guild combat replaces it), the personal
// message named Morpheus, Morpheus was NOT in the last frame, the attribution could only guess.
{
  const at = 1790803996377;
  const text = [
    { at: at - 900, kind: 'message', text: '### Rizzo of the The Second Swines has been slaughtered by Morpheus of the Human Resistance in guild combat.' },
    { at: at - 200, kind: 'message', text: '### Lew of the The Second Swines has been slaughtered by Morpheus of the Human Resistance in guild combat.' },
    { at, kind: 'message', text: 'You are dead, poor soul.  Go now, and take revenge on Morpheus!' },
  ];
  const frames = [{ threats: ['centipede', 'frogman'], players_present: ['Sweetums', 'Rizzo'] }];
  const attribution = attributeDeath({ character: 'Lew', summary: { at }, text,
    threats: { players_present: ['Sweetums', 'Rizzo'] } });
  ok('the attribution alone could only guess (the shape of that night)',
     attribution.killed_by_player_is_a_guess === true && attribution.killer === 'Morpheus');
  const v = classify({ character: 'Lew', deathAt: at, attribution, text, frames });
  ok('a guild-combat kill naming us is PvP', v.pvp === true && v.basis === 'guild_combat'
     && v.killers[0] === 'Morpheus', JSON.stringify(v));
  const other = classify({ character: 'Sweetums', deathAt: at, attribution: null,
    text: text.filter(e => /Rizzo/.test(e.text)), frames });
  ok('a guild-combat line about SOMEBODY ELSE is not our death', other.pvp === false);
}
// Floyd, 21:32: the personal message named Morpheus and he was a player in the last frame.
{
  const at = 1790803947009;
  const text = [{ at, kind: 'message', text: 'You are dead, poor soul.  Go now, and take revenge on Morpheus!' }];
  const attribution = attributeDeath({ character: 'Floyd', summary: { at }, text,
    threats: { players_present: ['Gonzo', 'Lew', 'Morpheus'] } });
  const v = classify({ character: 'Floyd', deathAt: at, attribution, text, frames: [] });
  ok('a player standing in the room at the end is PvP', v.pvp === true && v.basis === 'player_in_room', JSON.stringify(v));
}
{
  const at = 1_000_000;
  const text = [{ at, kind: 'message', text: '### Lew was just killed by a groundworm.' }];
  const v = classify({ character: 'Lew', deathAt: at, text, frames: [{ threats: ['groundworm'] }],
    attribution: attributeDeath({ character: 'Lew', summary: { at }, text }) });
  ok('a monster named with an article is not PvP', v.pvp === false, JSON.stringify(v));

  const murder = [{ at, kind: 'message', text: '### Lew has been murdered in cold blood.' }];
  const m = classify({ character: 'Lew', deathAt: at, text: murder,
    attribution: attributeDeath({ character: 'Lew', summary: { at }, text: murder }) });
  ok('a murder is PvP even without a name', m.pvp === true && m.basis === 'murder');

  const dyn = classify({ character: 'Lew', deathAt: at, attribution: { killer: '<dynamic 1000081>',
    kind: 'player_kill', was_killed_by_player: true } });
  ok('an unresolved <dynamic …> id is never a player', dyn.pvp === false);

  const mate = classify({ character: 'Lew', deathAt: at, attribution: { killer: 'Rizzo',
    kind: 'player_kill', was_killed_by_player: true } });
  ok('a fleetmate is never the camper', mate.pvp === false && mate.basis === 'fleetmate');

  const war = classify({ character: 'Lew', deathAt: at, attribution: { killer: 'Neo',
    kind: 'named_kill', was_killed_by_player: null } });
  ok('a remembered war enemy is PvP (the war book)', war.pvp === true && war.basis === 'war_book');

  const monsterName = classify({ character: 'Lew', deathAt: at, frames: [{ threats: ['Guardian of Zjiria'] }],
    attribution: { killer: 'Guardian of Zjiria', kind: 'named_kill', was_killed_by_player: true,
                   killed_by_player_is_a_guess: true } });
  ok('a guess whose name is a monster in the frames is refused', monsterName.pvp === false);

  const none = classify({ character: 'Lew', deathAt: at, attribution: { killer: null, kind: 'unknown' } });
  ok('no named killer is not PvP', none.pvp === false);
}

// A PLAYER'S MINUTE. The operator, 2026-10-21: any PvP against the character in the 60 seconds
// before it died makes the death PvP for the return delay, whoever struck last.
console.log('a player hit us in the last minute');
{
  const at = 2_000_000;
  const frog = { attribution: monsterAttribution0(), frames: [{ at: at - 1000, health: 0, threats: ['frogman'] }] };
  const seen = classify({ character: 'Lew', deathAt: at, ...frog, attacks: [{ at: at - 40_000, name: 'Morpheus' }] });
  ok('a frogman kill 40s after Morpheus hit us is PvP', seen.pvp === true && seen.basis === 'player_attack_recent'
     && seen.killers[0] === 'Morpheus' && seen.killed_by[0] === 'frogman', JSON.stringify(seen));
  const old = classify({ character: 'Lew', deathAt: at, ...frog, attacks: [{ at: at - 61_000, name: 'Morpheus' }] });
  ok('61s before is outside the minute', old.pvp === false, JSON.stringify(old));
  const after = classify({ character: 'Lew', deathAt: at, ...frog, attacks: [{ at: at + 30_000, name: 'Morpheus' }] });
  ok('a hit seen after the death does not count', after.pvp === false);
  const mate = classify({ character: 'Lew', deathAt: at, ...frog, attacks: [{ at: at - 5000, name: 'Rizzo' }] });
  ok('a fleetmate in the attack list is not PvP', mate.pvp === false);
  const dyn = classify({ character: 'Lew', deathAt: at, ...frog, attacks: [{ at: at - 5000, name: '<dynamic 1000081>' }] });
  ok('an unresolved id in the attack list is not PvP', dyn.pvp === false);
  const byMate = classify({ character: 'Lew', deathAt: at, attribution: { killer: 'Rizzo', kind: 'player_kill',
    was_killed_by_player: true }, attacks: [{ at: at - 5000, name: 'Morpheus' }] });
  ok("even a fleetmate's stray last blow is PvP when a stranger hit us first", byMate.pvp === true
     && byMate.killers[0] === 'Morpheus');
  const frames = [
    { at: at - 30_000, health: 50, players_near: ['Morpheus'], threats: ['frogman'] },
    { at: at - 25_000, health: 31, players_near: ['Morpheus', 'Rizzo'], threats: ['frogman'] },
    { at: at - 1000, health: 2, players_near: [], threats: ['frogman'] },
  ];
  const fr = classify({ character: 'Lew', deathAt: at, attribution: monsterAttribution0(), frames });
  ok('frames: health fell with a stranger in reach — PvP, fleetmate not named', fr.pvp === true
     && fr.basis === 'player_attack_recent' && fr.killers.join() === 'Morpheus', JSON.stringify(fr));
  const still = classify({ character: 'Lew', deathAt: at, attribution: monsterAttribution0(), frames: [
    { at: at - 30_000, health: 50, players_near: ['Morpheus'] }, { at: at - 25_000, health: 50, players_near: ['Morpheus'] },
    { at: at - 1000, health: 2, players_near: [] }] });
  ok('frames: a stranger standing near while health held is not an attack', still.pvp === false);
  const present = classify({ character: 'Lew', deathAt: at, attribution: monsterAttribution0(), frames: [
    { at: at - 30_000, health: 50, players_present: ['Morpheus'] }, { at: at - 25_000, health: 31, players_present: ['Morpheus'] }] });
  ok('frames: merely in the room (players_present) is not in reach', present.pvp === false);
}

// ------------------------------------------------------------------ the window
console.log('the window');
ok('default is two hours, on', pvpReturnDelayMs({}) === 120 * MIN && PVP_RETURN_DELAY_MS_DEFAULT === 7_200_000);
ok('null means the default', pvpReturnDelayMs({ pvpReturnDelayMs: null }) === 120 * MIN);
ok('0 disables', pvpReturnDelayMs({ pvpReturnDelayMs: 0 }) === 0
   && pvpHoldState({ died_at: Date.now() }, 0) === null);
ok('an unusable value keeps the default rather than switching it off',
   pvpReturnDelayMs({ pvpReturnDelayMs: 'thirty' }) === 120 * MIN && pvpReturnDelayMs({ pvpReturnDelayMs: -5 }) === 120 * MIN);
{
  const t0 = 5_000_000;
  const h = pvpHoldState({ died_at: t0, killers: ['Morpheus'] }, 120 * MIN, t0 + 119 * MIN);
  ok('119 minutes in: held, with a minute left', h && h.remaining_s === 60 && h.killer === 'Morpheus');
  ok('120 minutes in: released', pvpHoldState({ died_at: t0 }, 120 * MIN, t0 + 120 * MIN) === null);
}

// ------------------------------------------------------------------ the keeper
console.log('the keeper');
function keeper(name, { room = 50, mode = 'farm', policy = {} } = {}) {
  const c = {
    selfId: 99, me: { name }, events: [],
    room: { id: room, objects: new Map() },
    rsc: { get: () => '' },
    vitals: () => ({ health: { value: 60, max: 60 }, mana: { value: 30, max: 30 }, vigor: { value: 190, max: 200 } }),
    equipment: () => ({ known: true, equipped: [{ name: 'hammer' }] }),
    inventory: [],
  };
  const s = { name, live: true, client: c,
              world: { room: { num: room, name: `room ${room}` }, geometry: null } };
  const ap = new Autopilot(s, { mode, policy: { hunt: 'frogman', ...policy } });
  ap.policy.assignedRoom = 586;
  ap.settledIn = room;                 // no seat-finding in a fake room
  return ap;
}
const pvpAttribution = { killer: 'Morpheus', kind: 'player_kill', was_killed_by_player: true };
const monsterAttribution = { killer: 'frogman', kind: 'named_kill', was_killed_by_player: false };

{
  const ap = keeper('t1');
  const death = { at: Date.now(), died_in: 'Outside Castle Victoria', room_num: 586 };
  ap.classifyAndRememberPvp(death, { attribution: pvpAttribution });
  ok('the death record says it was PvP, and who', death.pvp === true && death.pvp_killers[0] === 'Morpheus'
     && death.pvp_basis === 'player_in_room');
  const refused = await ap.travel(586, { maxHops: 14 });
  ok('PvP death -> no departure to the assigned farming room', refused.refused === true && refused.pvp_hold === true,
     JSON.stringify(refused));
  ok('...nor to any room that generates prey', ap.pvpReturnGate(999)?.pvp_hold === true);
  ok('...but a walk to a sanctuary or town is not held', ap.pvpReturnGate(50) === null && ap.pvpReturnGate(700) === null);
  ok('an explicit travel order is not held', ap.pvpReturnGate(586, { explicitOrder: true }) === null);
  ok('a recovery detour (fleeing) is not held', ap.pvpReturnGate(586, { recoveryDetour: true }) === null);
  const st = ap.status();
  ok('status reports the hold', st.pvp_return_hold?.killer === 'Morpheus' && st.pvp_return_hold.remaining_s > 29 * 60
     && st.pvp_return_delay_ms === 7_200_000, JSON.stringify(st.pvp_return_hold));
  const r = await ap.holdOffTheFarm({ room: ap.s.world.room });
  ok('in the inn, the farm rung rests instead of choosing work', r === HANDLED);
  ap.running = true;                   // activity() answers 'stopped' for a keeper not looping
  ok('and the board says why', /PvP death by Morpheus/.test(ap.activity()), ap.activity());
  ap.running = false;

  // A lease holder decides the destination.
  const claim = ap.claimFaculties({ faculties: ['work', 'movement'], by: 'dum', leaseMs: 60_000 });
  ok('(the movement lease was granted)', ap.facultyHeld('movement'), JSON.stringify(claim).slice(0, 120));
  ok('a leased journey is not blocked', ap.pvpReturnGate(586) === null);
  ok('and the rung stands aside for the lease holder', await ap.holdOffTheFarm({ room: ap.s.world.room }) === CONTINUE);
  ap.releaseFaculties({ by: 'dum' });
  ap.busy = { at: Date.now(), until: Date.now() + 60_000, by: 'fleetscript', kind: 'errand' };
  ok('a busy (outside operation) character is not blocked', ap.pvpReturnGate(586) === null);
  ap.busy = null;

  // THE RESTART: a fresh Autopilot on the same slot, as the keeper process builds after a respawn.
  const again = keeper('t1');
  ok('the record was persisted', readPvpDeath('t1')?.killers?.[0] === 'Morpheus', pvpHoldFile('t1'));
  ok('the hold survives a keeper restart', again.pvpReturnGate(586)?.pvp_hold === true);

  // Delay 0 releases it on the next pass, even inside the window it died under.
  again.policy.pvpReturnDelayMs = 0;
  ok('delay 0 -> no hold', again.pvpReturnGate(586) === null && again.status().pvp_return_hold === null);
  ok('delay 0 -> the rung does not hold', await again.holdOffTheFarm({ room: again.s.world.room }) === CONTINUE);
}
{
  // Two hours and a minute after the death: departure allowed again.
  const ap = keeper('t2');
  ap.classifyAndRememberPvp({ at: Date.now() - 121 * MIN, room_num: 586 }, { attribution: pvpAttribution });
  ok('after two hours the departure is allowed', ap.pvpReturnGate(586) === null && ap.pvpReturnHold() === null);
  ok('and the rung lets farming choose again', await ap.holdOffTheFarm({ room: ap.s.world.room }) === CONTINUE);
}
{
  const ap = keeper('t3');
  const death = { at: Date.now(), room_num: 586 };
  ap.classifyAndRememberPvp(death, { attribution: monsterAttribution, frames: [{ threats: ['frogman'] }] });
  ok('monster death -> recorded as not PvP', death.pvp === false);
  ok('monster death -> no hold', ap.pvpReturnGate(586) === null && ap.status().pvp_return_hold === null
     && readPvpDeath('t3') === null);
}
{
  // The whole keeper path: a stranger in reach takes a bite, a frogman finishes the job.
  const ap = keeper('t5');
  const c = ap.s.client;
  c.self = { col: 10, row: 10 };
  c.rsc = { get: id => ({ 1: 'Morpheus' })[id] ?? '' };
  c.room.objects.set(7, { id: 7, nameRsc: 1, flags: 0x4 | 0x8, col: 11, row: 10 });
  let hp = 60;
  c.vitals = () => ({ health: { value: hp, max: 60 }, mana: { value: 30, max: 30 }, vigor: { value: 190, max: 200 } });
  await ap.checkAttackedByPlayer();
  hp = 41;
  await ap.checkAttackedByPlayer();
  ok('(the keeper wrote the attack down for this character)', ap.playerAttacks?.[0]?.name === 'Morpheus',
     JSON.stringify(ap.playerAttacks));
  const f = ap.recordFrame();
  ok('a frame names the player in reach', f?.players_near?.includes('Morpheus'), JSON.stringify(f?.players_near));
  const death = { at: Date.now() + 500, room_num: 586 };
  ap.classifyAndRememberPvp(death, { attribution: monsterAttribution, frames: [{ threats: ['frogman'] }] });
  ok("a monster death inside a player's minute is recorded as PvP", death.pvp === true
     && death.pvp_basis === 'player_attack_recent', JSON.stringify({ pvp: death.pvp, basis: death.pvp_basis }));
  ok('...and holds the character off the farm', ap.pvpReturnGate(586)?.pvp_hold === true
     && readPvpDeath('t5')?.killers?.[0] === 'Morpheus');
}
{
  // An older PvP death never overwrites a newer one.
  const ap = keeper('t4');
  const now = Date.now();
  ap.classifyAndRememberPvp({ at: now }, { attribution: pvpAttribution });
  ap.classifyAndRememberPvp({ at: now - 10 * MIN }, { attribution: { ...pvpAttribution, killer: 'Trinity' } });
  ok('the newest PvP death wins', ap.pvpReturnHold()?.killer === 'Morpheus');
  // Standing in a farming room already: the rung does not move it, the gate stops it leaving
  // for another one.
  const inFarm = keeper('t4', { room: 999 });
  ok('already in a farming room: the rung stands aside', await inFarm.holdOffTheFarm({ room: inFarm.s.world.room }) === CONTINUE);
  ok('...and the gate stops it setting off for another', inFarm.pvpReturnGate(586)?.pvp_hold === true);
}

// ------------------------------------------------------------------ the policy surfaces
console.log('the policy surfaces');
{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const broker = readToolSource(join(HERE, 'm59-broker.mjs'), 'utf8');
  ok('the autopilot schema declares pvp_return_delay_ms', /pvp_return_delay_ms: \{ type: 'number', minimum: 0/.test(broker));
  ok('the setter writes p.policy.pvpReturnDelayMs (so policy_control reflects it)',
     /p\.policy\.pvpReturnDelayMs = Math\.floor\(ms\)/.test(broker));
  ok('the fleet row carries pvp_return_hold', /pvp_return_hold: st\?\.pvp_return_hold \?\? null/.test(broker));
  const game = readToolSource(join(HERE, 'm59-game.mjs'), 'utf8');
  ok('travelJob marks explicit orders', /keeper\.travel\(dest, \{ \.\.\.opts, movementGeneration, explicitOrder: true \}\)/.test(game));

  const { reflectPolicy } = await import('./m59-policy-controls.mjs');
  const fakeTool = { schema: { properties: { pvp_return_delay_ms: { type: 'number', minimum: 0 } } },
                     run: () => 'p.policy.pvpReturnDelayMs = Math.floor(ms)' };
  const spec = reflectPolicy(fakeTool, [{}]).find(s => s.id === 'pvp_return_delay_ms');
  ok('policy_control reflects it onto policy.pvpReturnDelayMs', spec?.policy === 'pvpReturnDelayMs');

  const l = localise('valley_orders', { mode: 'farm' }, { doc: { blocks: { valley_orders: { pvp_return_delay_ms: 600_000 } } } });
  ok('m59-localpolicy accepts it as an overridable key', l.orders.pvp_return_delay_ms === 600_000 && !l.refused.length);
  const bad = localise('valley_orders', { mode: 'farm' }, { doc: { blocks: { valley_orders: { pvp_return_delay_ms: -1 } } } });
  ok('...and refuses an unusable value out loud', bad.refused.length === 1 && bad.orders.pvp_return_delay_ms === undefined);
  const off = localise('valley_orders', { mode: 'farm' }, { doc: { blocks: { valley_orders: { pvp_return_delay_ms: 0 } } } });
  ok('...and warns when it is switched off', off.warnings.length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
