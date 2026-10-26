// IS THAT CREATURE A PLAYER? Morph and anonymity, and what gives each away.
//
// MORPH (morph.kod; Riija 5, 20 mana, a 20 s trance) turns a player into the illusion of a monster. What
// other clients receive (user.kod:2343-2357, 7329-7336; morph.kod:190-461):
//   * the monster's icon, animations and NAME;
//   * object flags WITHOUT OF_PLAYER (and without OF_OFFERABLE) -- the harness's "is this a player" test
//     answers no, which is the whole disguise;
//   * BUT the player-type field is left alone: a morphed murderer or outlaw still sends PF_KILLER /
//     PF_OUTLAW (user.kod:7283-7310), and no real monster's flags ever carry those bits (monster.kod:
//     5168-5192 builds them from MOVEON_NO, BATTLER_YES, BUY/OFFER and drawfx only). That is a TELL;
//   * guild marks are suppressed (PLAYER_IS_ENEMY is not sent while morphed, user.kod:2390-2417);
//   * when a morphed player SPEAKS, the line uses user_said_str_morphed (user.kod:114-116,6461-6479) --
//     a monster that talks is a player;
//   * a morphed attacker's blow is coloured like a monster's and an unarmed one "attacks" rather than
//     punches (battler.kod:884-973); its damage is the monster template's, so damage is weak evidence;
//   * a morphed player can cast, walk through exits and apply wands; monsters are not told it entered
//     (room.kod:1805-1813), so the local monsters ignore it. A "monster" the room's monsters ignore, that
//     casts, that leaves by a door, or that the room cannot generate, is suspicious.
//
// ANONYMITY (anon.kod; Riija 1) blanks the player's name on the wire (GetApparentName -> "", user.kod:
// 405-410) and keeps OF_PLAYER, the PF bits and even the guild marks (user.kod:2393). So an anonymous
// player is simply "a player with no name": certain, not a guess, and nothing here needs to infer it.
//
// This module only ASSESSES. It returns evidence with weights; whether to act is a joint
// (`threat.classify`) and a pak's decision. With no pak loaded nothing reads this.
import { OF, playerClass, PF } from '../m59-parse.mjs';

export const SIGNALS = Object.freeze({
  pf_bits: { weight: 0.9, about: 'a creature carrying a player-type mark (murderer/outlaw/DM) -- monsters never do' },
  spoke: { weight: 0.95, about: 'a creature spoke in chat -- the morphed-say format' },
  cast: { weight: 0.7, about: 'a creature was seen casting a player spell' },
  not_spawnable: { weight: 0.5, about: 'this room cannot generate that creature (monsroom plMonsters)' },
  took_exit: { weight: 0.6, about: 'a creature left by an exit' },
  out_of_range_hit: { weight: 0.4, about: 'a blow far outside that creature\'s known damage' },
  ignored_by_monsters: { weight: 0.2, about: 'the room\'s monsters are not attacking it' },
});

const lower = s => String(s ?? '').trim().toLowerCase();

/** An anonymous player: OF_PLAYER set, no name on the wire. */
export function isAnonymous(o, lookup = () => null) {
  if (!o || !(o.flags & OF.PLAYER)) return false;
  const n = String(lookup(o.nameRsc) ?? o.name ?? '').trim();
  return n === '';
}

/**
 * Evidence that a non-player object is a disguised player.
 *   o          the room object
 *   ctx.name   its display name
 *   ctx.room   the room number
 *   ctx.spawns the spawn index (m59-spawns.json shape: { rooms: { "<num>": [{ creature, cls }] } }) or null
 *   ctx.events recent observations about this object: [{ kind: 'spoke'|'cast'|'took_exit'|'hit', ... }]
 * Returns { suspect, score, evidence: [{signal, weight, detail}], spawnable_here }.
 */
export function assessCreature(o, { name = null, room = null, spawns = null, events = [], hitCeiling = null } = {}) {
  const evidence = [];
  if (!o || (o.flags & OF.PLAYER)) return { suspect: false, score: 0, evidence, spawnable_here: null };
  const n = lower(name ?? o.name);
  const cls = playerClass(o.flags ?? 0);
  if (cls === PF.KILLER || cls === PF.OUTLAW || cls === PF.DM)
    evidence.push({ signal: 'pf_bits', weight: SIGNALS.pf_bits.weight, detail: `player class bits 0x${cls.toString(16)} on a creature` });
  let spawnable = null;
  const table = spawns?.rooms?.[String(room)];
  if (Array.isArray(table) && n) {
    spawnable = table.some(e => lower(e.creature) === n || lower(e.cls) === n.replace(/\s+/g, ''));
    if (!spawnable) evidence.push({ signal: 'not_spawnable', weight: SIGNALS.not_spawnable.weight, detail: `room ${room} generates ${table.map(e => e.creature).join(', ') || 'nothing'}` });
  }
  for (const ev of events ?? []) {
    if (ev.kind === 'spoke') evidence.push({ signal: 'spoke', weight: SIGNALS.spoke.weight, detail: String(ev.text ?? '').slice(0, 120) });
    else if (ev.kind === 'cast') evidence.push({ signal: 'cast', weight: SIGNALS.cast.weight, detail: ev.spell ?? 'a spell' });
    else if (ev.kind === 'took_exit') evidence.push({ signal: 'took_exit', weight: SIGNALS.took_exit.weight, detail: `left toward ${ev.to ?? '?'}` });
    else if (ev.kind === 'hit' && Number.isFinite(ev.damage) && Number.isFinite(hitCeiling) && ev.damage > hitCeiling * 1.5)
      evidence.push({ signal: 'out_of_range_hit', weight: SIGNALS.out_of_range_hit.weight, detail: `${ev.damage} against a ceiling of ${hitCeiling}` });
    else if (ev.kind === 'ignored') evidence.push({ signal: 'ignored_by_monsters', weight: SIGNALS.ignored_by_monsters.weight, detail: ev.detail ?? '' });
  }
  // Independent signals combine as 1 - prod(1 - w): two weak tells outweigh one.
  const seen = new Set(), weights = [];
  for (const e of evidence) if (!seen.has(e.signal)) { seen.add(e.signal); weights.push(e.weight); }
  const score = Math.round((1 - weights.reduce((p, w) => p * (1 - w), 1)) * 100) / 100;
  return { suspect: score >= 0.5, score, evidence, spawnable_here: spawnable };
}
