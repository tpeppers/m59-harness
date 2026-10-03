#!/usr/bin/env node
// WHO IS AN ALLY: the one question a keeper asks before it spends a spell ON another player.
//
//   node tools/m59-ally.mjs "Morpheus" "Kermit"     # what the verdict is for each, and why
//
// A buff or a heal cast on a person is help, and help given to the wrong person is a weapon
// handed to him. Measured 2026-10-03 on prod: Beaker (t6) cast BLESS on Morpheus at 12:53:23Z,
// thirty seconds after Morpheus -- a Human Resistance player, remembered in the war book, 297
// hits in the grudge book -- had finished killing six fleet characters in Castle Victoria. Robin
// (t8) blessed him twice more that night. Over the prod ledgers the "ally in the room" buff
// went to at least twenty players who are not ours: Morpheus 16 times, Sasquatch 93, Goblin
// 35, Gountrug 30, Roomba 16, Kage 14, Wenbo 5 -- most of them in the grudge book.
//
// WHY: `Autopilot.buffAllies` (m59-autopilot.mjs) chose its target from every object in the room
// carrying OF.PLAYER that was not itself. It never asked `party.isFleetmate`, never asked the
// grudge book, the war book or the PvP-death records. "Another player" was the whole test, so
// any stranger -- and therefore any enemy -- standing in the room was "an ally". The fleet-mate
// roster source was NOT the problem: keeper processes install it (m59-keeper-process.mjs,
// `party.setRosterSource(party.rosterFileSource(...))`), the practice desk's `fleetmate` target
// already used it, and that path never blessed a stranger. `medic` had the same unguarded filter.
//
// THE RULE, IN ORDER, AND HOSTILITY WINS OVER EVERYTHING:
//   1. not a player, or no name                                   -> not an ally
//   2. HOSTILE -- any one of:                                     -> not an ally, whatever else
//        - the server marks the object an enemy (PLAYER_IS_ENEMY, a mutual guild war);
//        - the war book remembers the name in a guild we are at war with (refused or not --
//          "refused" governs whether we may SWING, never whether we may help);
//        - the grudge book has ANY row for the name, of any age (an hour is the window for
//          returning fire; helping somebody who has ever attacked us is never right);
//        - a PvP-death record names the player as the killer of one of ours.
//      This beats rule 3 on purpose. A fleet-mate wrongly in the grudge book (the Statler
//      incident, 2026-08-27) loses a buff; an enemy wrongly called a fleet-mate does not gain
//      one. Being wrong here must cost a missed buff, never a buffed enemy.
//   3. one of ours (`party.isFleetmate`, which includes menagerie hosts) -> ally
//   4. named in the caller's explicit `friends` list                    -> ally
//   5. anybody else -- a stranger, a guildmate we do not run, a player the server flags
//      FRIEND -- is NOT an ally. Silence means no buff, never "probably fine".
//
// Pure given its sources; every source is injectable so m59-ally-test.mjs can pin it offline.

import * as party from './m59-party.mjs';
import { membership, isEnemyGuild, ENEMY_FLAG, PLAYER_FLAG } from './m59-war.mjs';
import { grudgeAgainst } from './m59-grudge.mjs';
import { knownKillers } from './m59-pvp-return.mjs';

const fold = n => String(n ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

const defaultSources = () => ({
  isFleetmate: n => party.isFleetmate(n),
  // Any row, any age: `window: Infinity` turns "owed a return blow" into "has ever attacked us".
  grudge: n => grudgeAgainst(n, { window: Infinity }),
  warMember: n => { const m = membership(n); return m?.guild_key && isEnemyGuild(m.guild_key) ? m : null; },
  killers: () => knownKillers(),
});

/**
 * Why this player is hostile to the fleet, or null.
 * @param {{name:string, flags?:number}} target
 */
export function hostileBasis(target, sources = {}) {
  const src = { ...defaultSources(), ...sources };
  const name = target?.name ?? '';
  const flags = Number(target?.flags ?? 0) >>> 0;
  if (flags & ENEMY_FLAG) return { basis: 'war_flag', why: 'the server marks this player an enemy (guild war)' };
  let m = null; try { m = src.warMember(name); } catch { m = null; }
  if (m) return { basis: 'war_book', why: `remembered as a member of ${m.guild ?? 'a guild'} we are at war with` };
  let g = null; try { g = src.grudge(name); } catch { g = null; }
  if (g) return { basis: 'grudge_book',
                  why: `in the grudge book: ${g.hits ?? '?'} hit(s) on ${(g.victims ?? []).join(', ') || 'this fleet'}` };
  let k = null; try { k = src.killers(); } catch { k = null; }
  if (k?.has?.(fold(name))) return { basis: 'killer', why: 'killed one of ours (a PvP-death record names him)' };
  return null;
}

/**
 * May a keeper spend a spell on this player as an ALLY?
 * @param {{name:string, flags?:number}} target   name as resolved off the wire, flags off the room object
 * @param {{friends?: string[], sources?: object}} opts
 * @returns {{ally: boolean, basis: string, why: string}}
 */
export function allyVerdict(target, { friends = [], sources = {} } = {}) {
  const name = String(target?.name ?? '').trim();
  const flags = Number(target?.flags ?? 0) >>> 0;
  if (target?.flags != null && !(flags & PLAYER_FLAG)) return { ally: false, basis: 'not_player', why: 'not a player' };
  if (!name) return { ally: false, basis: 'unnamed', why: 'no name resolved, so nobody can vouch for it' };
  const src = { ...defaultSources(), ...sources };
  const h = hostileBasis({ name, flags }, src);
  if (h) return { ally: false, basis: h.basis, why: `hostile: ${h.why}` };
  let mate = false; try { mate = !!src.isFleetmate(name); } catch { mate = false; }
  if (mate) return { ally: true, basis: 'fleetmate', why: 'one of ours' };
  if ([].concat(friends ?? []).some(f => fold(f) === fold(name)))
    return { ally: true, basis: 'friend', why: 'named in this policy as a friend' };
  return { ally: false, basis: 'stranger', why: 'not one of ours and not a named friend' };
}

// ------------------------------------------------------------------ CLI
// A CLI process has no broker, so it installs the fleet roster as its fleet-mate source exactly
// as a keeper process does -- without it every one of ours would read as a stranger.
if (/m59-ally\.mjs$/.test(process.argv[1] ?? '')) {
  const { fleetName, stateFileFor } = await import('./m59-fleetpath.mjs');
  const { menageriePathFor } = await import('./m59-menagerie-roster.mjs');
  const { readFileSync } = await import('node:fs');
  const argv = process.argv.slice(2);
  const names = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--fleet');
  if (!names.length) { console.log('usage: node tools/m59-ally.mjs [--fleet <name>] <player name> [...]'); process.exit(2); }
  const path = stateFileFor(fleetName(argv));
  let hosts = [];
  try { hosts = Object.values(JSON.parse(readFileSync(menageriePathFor(path), 'utf8')))
                  .map(e => e?.credentials?.character).filter(Boolean); } catch { hosts = []; }
  party.setRosterSource(party.rosterFileSource(path, { extra: hosts }));
  for (const n of names) {
    const v = allyVerdict({ name: n, flags: PLAYER_FLAG });
    console.log(`${v.ally ? 'ALLY    ' : 'NOT ALLY'}  ${n}  (${v.basis}: ${v.why})`);
  }
}
