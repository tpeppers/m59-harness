// SHADOW RIFT, ANYWHERE: GATHER THE GROUP ROUND THE PRISM, POOL THE REAGENTS, ONE MAXIMISED PRIMARY CHANTS, THE REST
// FEED IT MANA AND FILL THE LAST SEATS.
//
//   node tools/m59-fleet-repl.mjs --fleet <fleet>
//   > dry shadow-rift agents=a,b,c,d room=101                     plan only: who is primary, what is drawn from where
//   > shadow-rift agents=a,b,c,d room=101                         primary=auto: the highest achievable spell power
//   > shadow-rift agents=a,b,c,d room=101 primary=c               a named primary, gathered wherever it stands
//   > shadow-rift agents=a,b,c,d room=2009 square=r15c15 hold=true  drop the prism at a square, hold the portal open
//   > shadow-rift agents=a,b,c,d room=101 halls=714,703 vaults=false   draw from guild halls, not vaults
//
//   Stop early:      create <logDir>/shadow-rift.stop  (checked every tick; logDir defaults to substrate/logs/)
//   Start next now:  create <logDir>/shadow-rift.next  -- ends the CURRENT wait (vigor, gather, pre-fill, Qor hour, prism)
//                    at its next check; the file is consumed, so one touch skips one wait.
//   Events:          <logDir>/shadow-rift.events.log   (one JSON row per plan, eat, seat check, forecast, join, touch, result)
//
// docs/m59-shadow-rift.md is the operator's page (params, the stop/skip files, the hold end state). The mechanic is
// m59-research/reports/shadow-rift.md, cited by section below; kod citations are against M59_ROOT.
//
// The operator's spec (2026-11-20): a single maximised-spellpower PRIMARY does ~99% of the channelling (mace, Qor
// disciple robe, best shield, circlet last for max mana, 200 vigor from inky caps); everyone else targets the primary
// with MYSTIC TOUCH whenever a touch would not be wasted; "walk them all into the same area visually so they can cast
// mystic touch on each other, they should share reagents, etc. -- all baked into the script so that we can re-use this
// script to open other portals in other places".
//
// WHAT THE LIVE RUNS TAUGHT (2026-11-20, three runs):
//   * a run refused "only 1 here", and another chose the wrong primary because the intended one stood elsewhere at plan
//     time: the script did not GATHER. Now every member walks to `room` (one walk step per member, one driver for the
//     whole run), walks then crawls to a cluster square beside the prism (RING below, never ON the prism square -- the
//     portal opens there), and is re-checked (and sent back once with one travel order) right before the join.
//   * "no Qor disciple robe" was a robe absent with its owner; the gear plan is now made in the room, from fresh reads.
//   * a hand-over "received 0" then refused: every hand-over is verified by the receiver's count and retried twice;
//     seats are whoever ACTUALLY holds 4 feathers after sharing (spareSeats backups), never a list fixed in advance.
//   * a mushroom shop sold 1 of 36: a listing is good for one purchase, so each source is asked up to 8 lots, each
//     re-counted, stopping a kind the moment a lot moves nothing.
//   * only some members knew mystic touch: refillers are read from each member's ability list.
//   * errands had deposited feathers and inky caps into PERSONAL VAULTS: sources are packs -> each member's own vault
//     (the cached vault reading, substrate/storage/; m59-vaults.mjs: Obert 114 on the mainland, Itzal 2005 on the
//     island) -> guild halls (`halls`, in order, mainland only) -> a plain-mushroom seller by region (Joguer 104 /
//     Zhieu 373 / Frisconar 53; none on the island: `mushroomShop=<room>:<seller>`).
//   * the primary's cast reply TIMED OUT while the join had worked: every join (primary and seats) is decided by the
//     keeper's own enchantment observation (keeper /state enchantment_observations), with the cast reply and every
//     line the caster heard logged ('join' events).
//   * REFILLS WERE TOO SMALL (2-4 mana a touch every ~20-30 s against ~0.6/s net drain; the primary went 72 -> 2 and the
//     chant collapsed at ~700/1500): one loop per donor casts mystic touch directly, as fast as the server allows, and
//     only when the touch is worth most -- the donor at `touchAt` (90%) of its own max -- unless the collapse forecast
//     says DANGER, when any donor mana above the floor goes. A touch is verified by the donor's own "You give part of
//     your magical energy to <name>." and the target's mana; anything else it heard is logged (a conjured weapon's
//     "A long sword appears." was once read as a touch).
//   * THE COLLAPSE IS PREDICTED: before any feather is paid, a FORECAST (rate from the clock-read sp, time to charge,
//     the primary's net drain vs the donors' sustainable supply) chooses 'solo' (seats at the end), 'together' (the
//     whole circle at once), or REFUSES (force=true overrides). During the chant the primary's 60 s mana trend is
//     compared with the time the charge still needs; the seats come in early when the trend says it will run dry.
//   * THE SEATS NEVER CHANTED and nobody knew why: each seat is VALIDATED before the primary pays (in the room, sees
//     the prism on the ground, karma <= -40, 4 feathers, vigor and mana for `seatRolls` failed rolls, its roll chance
//     from mysticism), and a failed roll is retried. Two seats read karma -39 at one point: Qor 4 needs <= -40
//     (spell.kod KarmaCheck), and the server refuses silently with no mana spent.
//   * every draw first checks the drawer's free bulk (status.carry.room_for.bulk): a full pack draws nothing and the
//     draw still says ok.
//   * cast roles: a member found already tagged 'rift' (a run that died before restoring) is put back to `restoreRole`.
//
// THE MECHANIC (m59-research/reports/shadow-rift.md, cited by section; kod at M59_ROOT):
//   * "How a casting works" step 1: the caster takes the NEAREST PRISM ON THE GROUND in its room; a prism in a pack is
//     never found. So the prism must be on the floor of the casting room; if a group member carries it, it is dropped
//     there first. A prism held by anyone OUTSIDE the run is NEVER commanded: the run waits `prismWaitMinutes` for it.
//   * step 2 / "Q6": the caster's room must allow player portals: guild halls, inns, every ROOM_NO_COMBAT room, boss
//     and puzzle rooms refuse. The report's "Easy rooms" table lists legal rooms with no spawns; the script also
//     refuses a room m59-hazards calls no-combat.
//   * step 4: a successful join costs 30 mana (-1 above SP 40, -1 above 80), 40 vigor and 4 DARK ANGEL FEATHERS; a
//     failed roll costs half mana (15) and half exertion (20 vigor), no feathers, and no seat. Joining needs vigor > 40.
//   * step 5: a join contributes floor(sp/2) at once, then bound((sp+1)/25, 1, 4) per second, and drains 1 mana/s.
//   * step 6: it FIRES when stored power >= 1500 AND there are at least as many chanting casters as the prism has
//     sides. "If the power is there but seats are empty, it waits" -- the power keeps building and nothing is lost.
//   * "Abort" / "The chant must be continuous": a caster who breaks trance or runs out of mana leaves; the stored power
//     survives while ANYONE is still chanting and is wiped when the last one leaves ("The prism darkens..."). Casting
//     any spell, using any item, resting, running, changing room or taking damage breaks YOUR chant. "You chant once.
//     Do not cast again."
//   * "How long one join lasts": regen keeps running during the chant, so more max mana = a longer, stronger join;
//     that is why the circlet goes on last (circlet.kod NewUsed: max health -bound(maxHP/7,5,20), max mana +2x that).
//
// RECONCILING "THE PRIMARY DOES 99%" WITH "ONE DISTINCT CASTER PER SIDE" (report step 6 + the "Tactic" paragraph
// under "Time to fire": "One or two strong casters can chant up most of the 1500, then the rest join at the end"):
//   1. The primary joins ALONE and chants continuously. It never casts again (a re-cast breaks its own chant).
//   2. Everyone else stays OUT of the circle and keeps the primary's mana up with mystic touch. The primary cannot
//      refill itself (any item or spell breaks the trance), but a touch is cast BY the donor ON the primary, which is
//      not an action of the primary's. [UNVERIFIED in game: that GainMana on a trancing target does not break its
//      trance. kod: GainMana has no BreakTrance; the trance breakers listed in the report do not include it.]
//   3. When the prism is charged -- the server's own "You feel like the prism has the power to cast the spell, but
//      lacks the right symmetry of focal energy." (prism.kod:353, 1-in-30 per contribution once power >= needed), or a
//      non-chanting member's look at the prism reads "glows extremely brightly" (charge >= 2/3, prism.kod:382-404) AND
//      the conservative power estimate is >= 1500 -- sides-1 SEAT casters join. Their job is the symmetry.
//   4. Emergency: if the primary's mana is about to run out, the seats join EARLY so the stored power survives the
//      primary's exit; the primary then re-joins as a new seat (another 4 feathers, `spareJoins`).
//
// FEATHERS: 4 x sides for one clean casting (12 for a 3-sided prism), plus 4 x `spareJoins` (default 1: a primary
// re-join) and 4 x `spareSeats` (a backup seat). Pooled from packs, own vaults, then halls, and handed out in the room.
//
// SPELL POWER MODEL (spell.kod GetSpellPower, :2066-2246; every term cited):
//   sp = bound( base + qorHour + karma + faction + items , 1, 99 )
//     base    = floor(shadow rift ability / 2)                                          (spell.kod "half the ability")
//     qorHour = bound(2 + |gameHour - 12| * 2, 0, 30) -- the GAME hour, read from the clock (m59-dayclock anchor, else
//               system.kod's derivation; a game hour is 5 real minutes); `qorHour` overrides   (spell.kod SS_QOR)
//     karma   = bound(floor(|karma| / 10), 0, 10)                                        (spell.kod SS_QOR secondary)
//     faction = parlia.kod:1081 GetFactionSpellPowerBonus: not readable, counted 0 (never overrated).
//     items   = sum over worn items (tools/m59-spellpower.mjs, generated from the kod): mace +5 (the only weapon that
//               ADDS), hammer 0, long sword -10, axe -15, scimitar -20; disciple robe of QOR +4 x the wearer's highest
//               known Qor level (max 20; robedisc.kod:137), its school read from its look text; plain robes +10;
//               leather 0; orc shield Qor +15 (orcshld.kod:72, and its ReqUse refuses a wearer with karma > -50); Duke
//               soldier shield 15 x rank / 10 (dukeshld.kod:153; the rank is not read, so `dukeRank`, default 1 --
//               a supreme hero is 10, the same +15 as an orc shield); circlet 0 (helms otherwise -5).
//   Items are POOLED: the primary's achievable sp is computed with the best legal item in the group per slot. A cursed
//   (or unidentified, so possibly cursed) WIELDED weapon cannot be unwielded (CLAUDE.md: "a cursed weapon can never be
//   put down"), so that slot is locked at its own modifier and the plan says so.
//   PRIMARY: `primary` names one (it must be in the run, in the room, alive and able to cast shadow rift), or 'auto'
//   (the default) takes the highest achievable sp (ties: higher max mana). The ranking is printed either way.
//
// THE ORC SHIELD IS OPT-IN (`orcShield=true`, default false). Operator, 2026-11-20: faction soldiers cannot equip one,
// and on a fleet where everyone is a faction soldier a fetch is a wasted trip of 200 bulk. A supreme-hero Duke soldier
// shield gives the same +15 (`dukeRank=10`). Off, an orc shield is neither fetched nor planned into anyone's gear. On,
// one is fetched from vaults/halls for a primary that is NOT a soldier and the group carries none, and an orc shield is
// pooled only for a non-soldier at karma <= -50.
//
// MYSTIC TOUCH (mysttch.kod; Faren 1, 3 mana, 1 plain "mushroom"): moves bound(sp/2,10,55)% of the CASTER'S CURRENT
// mana, limited to (caster mana - 3), capped so the target ends at most min(1.5 x its max mana, 75); refused when the
// caster has <= 8 mana or the target is already at that cap. "NOT WASTED" = targetMana + expected <= cap (touchWorth).
// The percentage starts at `touchPct` and is learned per donor from observed touches. Donors at 200 vigor get Faren's
// vigor/20 = +10 sp, which is why EVERYONE is fed to 200, not just the primary.
//
// VIGOR (report "How long one join lasts": joining needs vigor > 40 and costs 40; regen scales with vigor): every
// member eats toward `vigorTarget` (200). Inky-cap mushroom = nutrition 50, filling 25 (inkycap.kod:45-46); `eat`
// refuses a bite that would carry vigor past 200, so inkies go in up to 150 and any smaller food tops off. A fleet
// whose standing orders forbid eating inky caps is overridden here, for this errand only.
//
// GEAR ROUTE: items move member -> primary by `supply` (who_travels neither, verified by the receiver's pack); a worn
// item is unused by its owner first. The primary then uses them: weapon, armour, shield, and the CIRCLET LAST.
// THE CAST RITE IS SWITCHED OFF FOR EVERY CHANTER: a cast-gear strategy (docs/m59-cast-rites.md) may dress a caster
// for each cast and pop the stash after the TRANCE -- in the middle of a minutes-long chant, which would break it. So
// each chanter's role in substrate/cast-roles.json is set to `rift` (no strategy should answer it) for the ceremony and
// put back afterwards (also on process exit).
//
// STOP CONDITIONS: the portal (open) / "The prism hums and shudders." (bind) -> success, then the prism is looked at
// and the destination reported; "must be taken out of the area" / "already contains a portal" / "repelled by the
// presence of another nearby portal" -> fail (feathers are spent: report "Q2"); the ceremony collapsing with no joins
// left; feathers or vigor exhausted; a name in `enemies` seen in the room; `maxMinutes`; the stop file.
// SURVIVAL STAYS WITH THE KEEPER: nothing here cancels movement or rests a body; a hit breaks a chant, and the script
// only reports it.
//
// HOLD (`hold=true`): after the portal opens, every caster is confined to the room (mode survive, roam off, town trips
// off, panic and break-out logoffs off; survival otherwise on) to keep the portal open. It is an END STATE, not a
// timer: release it with an ordinary autopilot order.
//
// UNVERIFIED, AND SAID SO HERE: (a) receiving mystic touch mid-chant does not break the chant; (b) the keeper's cast
// hold is capped at 60 s (m59-keeper-process.mjs `Math.min(60_000, holdMs)`); after it lapses the errand hold is all
// that keeps the primary still, and an idleGear hook that strips gear on a keeper pass would break the chant -- the
// loop watches the primary's equipment and reports it if it happens; (c) whether shadow rift has a 20 s personal
// trance before the join (report "Caveat"); (d) a prism's side count is read from its look text ("This prism has
// three sides"), else `sides`.
import { walk, shop, verify, splitFood } from '../m59-fleetscript.mjs';
import { hallWithdrawRetrying } from '../m59-hall-access.mjs';
import { itemSpellModifier, itemSlot, itemHands, isDiscipleRobe, robeSchoolFromLook } from '../m59-spellpower.mjs';
import { castRoles, setRole } from '../m59-spellgear.mjs';
import { isNoCombatRoom } from '../m59-hazards.mjs';
import { FactionStatusCache } from '../m59-faction-status.mjs';
import { fleetName, stateFileFor } from '../m59-fleetpath.mjs';
import { bandFor } from '../m59-keeperwhy.mjs';
import { VAULTS } from '../m59-vaults.mjs';
import { StorageCache } from '../m59-storage.mjs';
import { readAnchor } from '../m59-dayclock.mjs';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
// The stop / start-next-now / events directory: gitignored (/substrate/logs/). `logDir=` or M59_SHADOW_RIFT_LOGS moves it.
export const DEFAULT_LOGDIR = process.env.M59_SHADOW_RIFT_LOGS || join(REPO, 'substrate', 'logs');
let LOGDIR = DEFAULT_LOGDIR;
export const setLogDir = (dir) => { LOGDIR = dir ? resolve(String(dir)) : DEFAULT_LOGDIR; return LOGDIR; };
export const logDir = () => LOGDIR;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const truthy = v => v === true || /^(true|1|yes)$/i.test(String(v ?? ''));

// ------------------------------------------------------------------ the game's own numbers
export const RIFT = Object.freeze({ needed: 1500, joinMana: 30, joinVigor: 40, vigorGate: 40, feathersPerJoin: 4,
  failMana: 15, failVigor: 20 });
export const TOUCH = Object.freeze({ mana: 3, minMana: 5, cap: 75, minPct: 10, reagent: 'mushroom' });
export const FEATHER = 'dark angel feather', INKY = 'Inky-cap mushroom';
const FEATHER_RX = /^dark angel feathers?$/i, INKY_RX = /^inky.?cap mushrooms?$/i, MUSHROOM_RX = /^mushrooms?$/i;
const PRISM_RX = /^prism$/i, CIRCLET_RX = /^circlet$/i;
/** `enemies=` (comma-separated player names): any of them seen in the casting room stops the run. Exact names only. */
export const enemyMatcher = (list = '') => {
  const names = String(list ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return n => names.includes(String(n ?? '').trim().toLowerCase());
};
// The server's sentences (prism.kod:43-48, shadrift.kod:22-46).
const SAID = {
  began: /you begin to chant and a prism nearby starts to glow/i,
  joined: /you join in the chanting of an incantation/i,
  charged: /prism has the power to cast the spell, but lacks the right symmetry/i,
  over: /the prism darkens and a blanket of silence/i,
  opened: /a shimmering portal springs into being/i,
  bound: /the prism hums and shudders/i,
  loop: /must be taken out of the area to which it is bound/i,
  targetPortal: /its target area already contains a portal/i,
  repelled: /repelled by the presence of another nearby portal/i,
  noPrism: /can'?t find a prism/i,
  badRoom: /shadow rift.*(here|location)|pointless/i,
  broken: /concentration is broken|chant(ing)? (is )?(broken|interrupted)|you stop chanting/i,
};
const GLOW = [[/glows extremely brightly/i, 3], [/glowing fairly brightly/i, 3], [/glowing from a point at its center/i, 2],
  [/glows faintly from within/i, 1]];
const SIDES_WORD = { three: 3, five: 5, seven: 7, '3': 3, '5': 5, '7': 7 };

// ------------------------------------------------------------------ readers (tolerant of both status shapes)
const vit = (st, k) => ({ value: Number(st?.[k]?.value ?? st?.vitals?.[k]?.value ?? NaN),
                          max: Number(st?.[k]?.max ?? st?.vitals?.[k]?.max ?? NaN) });
const roomOf = st => Number(st?.room?.num ?? st?.where?.num ?? st?.room_num ?? NaN);
const karmaOf = st => Number(st?.karma?.value ?? (typeof st?.karma === 'number' ? st.karma : NaN));
// Shadow Rift is Qor level 4: the server refuses it above karma -40 with no mana spent (m59-spells.json required_karma -40).
export const RIFT_KARMA = -40;
const nameOf = i => String(i?.name ?? '').trim();
const countIn = (items, rx) => (items ?? []).filter(i => rx.test(nameOf(i))).reduce((n, i) => n + (Number(i.amount) || 1), 0);
const abilityOf = (ab, spell) => Number(JSON.stringify(ab ?? '').match(new RegExp(`"${spell}","id":-?\\d+,"ability":(\\d+)`, 'i'))?.[1] ?? NaN);
const knows = (ab, spell) => new RegExp(`"${spell}"`, 'i').test(JSON.stringify(ab ?? ''));
const evText = e => [e?.text, e?.message, e?.said, e?.string].filter(Boolean).join(' ') || JSON.stringify(e ?? '');

function characterNames(fleet) {
  const out = {};
  try {
    const roster = JSON.parse(readFileSync(stateFileFor(fleet), 'utf8'));
    for (const [agent, entry] of Object.entries(roster ?? {})) if (entry?.credentials?.character) out[agent] = entry.credentials.character;
  } catch { /* names unknown: the touch target falls back to the agent id */ }
  return out;
}

function logEvent(row) {
  try { mkdirSync(LOGDIR, { recursive: true });
        appendFileSync(join(LOGDIR, 'shadow-rift.events.log'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n'); }
  catch { /* the log is a convenience */ }
}

/** Does the agent's KEEPER observe a shadow rift enchantment first seen at or after sinceMs? (keeper /state
 *  enchantment_observations; the broker's cast reply can time out while the join worked -- 2026-11-20.) */
//  The port is found in this fleet's keeper band (substrate/keeper-bands.json, m59-keeperwhy bandFor), believing the
//  /state `agent` and never the port number (a handoff reuses ports). No band, no keeper read: joinOne then falls back to
//  the server's own "you begin to chant" / "you join in the chanting" sentences.
const KEEPER_PORT = new Map();
let BAND;
async function keeperState(agent) {
  const tryPort = async (p) => { try { const j = await (await fetch(`http://127.0.0.1:${p}/state`, { signal: AbortSignal.timeout(1500) })).json(); return j?.agent === agent && j.connected !== false ? j : null; } catch { return null; } };
  const cached = KEEPER_PORT.get(agent);
  if (cached) { const j = await tryPort(cached); if (j) return j; KEEPER_PORT.delete(agent); }   // a handoff moves the port
  if (BAND === undefined) { try { BAND = bandFor(fleetName()); } catch { BAND = null; } }
  if (!BAND) return null;
  const ports = Array.from({ length: BAND.end - BAND.base + 1 }, (_, i) => BAND.base + i);
  const hits = await Promise.all(ports.map(async p => [p, await tryPort(p)]));
  const hit = hits.find(([, j]) => j);
  if (hit) { KEEPER_PORT.set(agent, hit[0]); return hit[1]; }
  return null;
}
export const keeperBandKnown = () => !!BAND;
async function riftEnchanted(agent, sinceMs) {
  const j = await keeperState(agent);
  const e = (j?.enchantment_observations?.entries ?? []).find(x => /shadow rift/i.test(x.name ?? ''));
  return !!e && Number(e.first_seen_at ?? e.last_seen_at ?? 0) >= sinceMs;
}
// THE GAME HOUR (system.kod RecalcLightAndWeather: a game day is 2 real hours, an hour 5 real minutes), anchored by
// m59-dayclock's observed night start when there is one (the same rule as m59-nightshift.gameHour, transcribed here because
// importing m59-nightshift runs its CLI). Qor's primary bonus is bound(2 + |hour-12|*2, 0, 30) (spell.kod SS_QOR).
export function gameHourNow(atMs = Date.now()) {
  let anchor = null;
  try { const a = readAnchor(); anchor = a?.night_starts_at ? Date.parse(a.night_starts_at) : null; } catch {}
  if (Number.isFinite(anchor)) { const C = 120 * 60_000; return (22 + Math.floor((((atMs - anchor) % C) + C) % C / 300_000)) % 24; }
  const H = 3600, t = Math.floor(atMs / 1000) - 5 * H;
  return Math.floor(Math.floor((((t % (2 * H)) + 2 * H) % (2 * H)) / 60) / 5);
}
export const qorBonusAt = (atMs = Date.now()) => Math.max(0, Math.min(30, 2 + Math.abs(gameHourNow(atMs) - 12) * 2));
const stopRequested = () => existsSync(join(LOGDIR, 'shadow-rift.stop'));
// "START NEXT NOW" (operator 2026-11-20: a raid/chant supervisor should let you skip a wait nobody gains from). Create
// <logDir>/shadow-rift.next and the CURRENT wait (vigor, gather, re-gather, mana pre-fill, primary wait) ends at its next check and
// the run moves on. The file is consumed, so one touch skips one wait.
let nextSeen = 0;
const skipWait = () => { const f = join(LOGDIR, 'shadow-rift.next'); if (!existsSync(f)) return false; try { unlinkSync(f); } catch {} nextSeen++; console.log('  NEXT: start-next-now file seen -- skipping the current wait'); return true; };

// ------------------------------------------------------------------ the spell-power model (pure)
/** One item's modifier for a Qor spell, robe school and Duke rank applied. */
export function qorItemMod(item, { qorLevel = 4, dukeRank = 1 } = {}) {
  const n = nameOf(item);
  if (/shield of the duke'?s army/i.test(n)) return Math.trunc((15 * dukeRank) / 10);
  if (isDiscipleRobe(n)) return item.robe_school ? itemSpellModifier(n, { spellSchool: 'Qor', robeSchool: item.robe_school, schoolLevel: qorLevel }) : 5;
  return itemSpellModifier(n, { spellSchool: 'Qor' });
}
const SLOTS = ['weapon', 'shield', 'armour', 'helm'];
const usable = i => !i.cursed && !i.broken && !i.unidentified;
export const SHIELD = 'orc shield';
const SHIELD_RX = /^orc shields?$/i;
/** orcshld.kod ReqUse: "slips out of your fingers" above karma -50. */
export const ORC_SHIELD_KARMA = -50;
/** May this candidate be planned into an orc shield? Only with orcShield on, a non-soldier, karma <= -50. */
export const orcShieldFor = (cand, orcShield = false) =>
  !!orcShield && cand?.factionSoldier === false && Number.isFinite(cand?.karma) && cand.karma <= ORC_SHIELD_KARMA;
/** A faction soldier's shield (dukeshld.kod and its two siblings). */
export const SOLDIER_SHIELD_RX = /^shield of the (duke'?s army|princess'? army|rebel militia)$/i;
/** factionSoldier: true when it carries a soldier shield, else the faction cache's reading, else null (unread). */
export function soldierOf(items = [], cached = null) {
  if ((items ?? []).some(i => SOLDIER_SHIELD_RX.test(String(i?.name ?? '').trim()))) return true;
  return typeof cached?.soldier === 'boolean' && cached?.faction ? cached.soldier : null;
}

/**
 * The best achievable worn set for one candidate, drawing on the whole group's carried items.
 * `cand.items` = the candidate's items, `pool` = every member's items (each tagged with `owner`).
 * A cursed EQUIPPED item locks its slot. An orc shield is considered only when `orcShieldFor(cand, orcShield)`.
 * Returns { sp, parts, set: {slot: item|null}, locked: [] }.
 */
export function bestSet(cand, pool, { qorHour = 2, dukeRank = 1, qorLevel = 4, orcShield = false } = {}) {
  const orcOk = orcShieldFor(cand, orcShield);
  const set = {}, locked = [];
  for (const slot of SLOTS) {
    const worn = cand.items.find(i => i.equipped && itemSlot(nameOf(i)) === slot);
    // AN UNIDENTIFIED WORN ITEM MAY BE CURSED (2026-11-20 live: a wielded scimitar read rarity 100 "unidentified" on the
    // wire, and was cursed): the server would refuse its removal, so the slot is locked rather than planned around a swap.
    if (worn?.cursed || worn?.unidentified) { set[slot] = worn; locked.push(slot); continue; }
    // A Duke shield is personal (a soldier's own); an orc shield only when orcShieldFor; everything else pools.
    const options = pool.filter(i => itemSlot(nameOf(i)) === slot && usable(i) &&
      (i.owner === cand.agent || !/shield of the duke'?s army/i.test(nameOf(i))) &&
      (orcOk || !SHIELD_RX.test(nameOf(i))) &&
      !(slot === 'armour' && isDiscipleRobe(nameOf(i)) && i.robe_school && !/qor/i.test(i.robe_school)));
    let best = null, bestMod = 0;            // an empty slot is 0, so a -20 scimitar loses to bare hands
    for (const o of options) { const m = qorItemMod(o, { dukeRank, qorLevel }); if (m > bestMod || (m === bestMod && best && o.owner === cand.agent)) { best = o; bestMod = m; } }
    // A circlet is wanted for MANA even at 0 sp, so the helm slot takes one over an empty head.
    if (slot === 'helm' && !best) best = options.find(o => CIRCLET_RX.test(nameOf(o))) ?? null;
    set[slot] = best;
  }
  // Two-handed weapon (a bow) cannot sit beside a shield; the mod table has hands.
  if (set.weapon && itemHands(nameOf(set.weapon)) >= 2 && set.shield) {
    const wm = qorItemMod(set.weapon, { dukeRank, qorLevel }), sm = qorItemMod(set.shield, { dukeRank, qorLevel });
    if (locked.includes('weapon') || wm >= sm) set.shield = null; else set.weapon = null;
  }
  const items = SLOTS.reduce((n, s) => n + (set[s] ? qorItemMod(set[s], { dukeRank, qorLevel }) : 0), 0);
  const base = Math.floor((Number(cand.ability) || 0) / 2);
  const hour = Math.max(0, Math.min(30, Number(qorHour)));
  const karma = Number.isFinite(cand.karma) ? Math.max(0, Math.min(10, Math.floor(Math.abs(cand.karma) / 10))) : 0;
  const faction = cand.faction === 'rebel' ? 0 : 0;   // CalcFactionBonus is not readable; never overrated
  const raw = base + hour + karma + faction;
  const sp = Math.max(1, Math.min(99, Math.max(0, raw) + items));
  return { sp, base, hour, karma, faction, items, set, locked,
           parts: `base ${base} + qorHour ${hour} + karma ${karma} + faction ${faction}(unread) + items ${items >= 0 ? '+' : ''}${items}` };
}
/** Rate and the conservative stored-power estimate after `secs` of one join (report step 5). */
export const riftRate = sp => Math.max(1, Math.min(4, Math.floor((sp + 1) / 25)));
export const joinPower = (sp, secs) => Math.floor(sp / 2) + riftRate(sp) * Math.max(0, secs);
/** Qor 4 needs karma <= -40 (spell.kod KarmaCheck); an UNREAD karma is not refused here (the seat check reads it). */
export const riftKarmaBlocks = karma => Number(karma) > RIFT_KARMA;
/** Why a seat may NOT join yet ([] = it may): the room, the prism in sight, karma <= -40 (STRICT: an unread karma
 *  fails here), 4 feathers, vigor > 40 + 20 and mana >= 30 + 15 per allowed failed roll (report step 4). */
export function seatProblems({ room, wantRoom, sees, karma, feathers, vigor, mana }, rolls = 2) {
  const bad = [];
  if (room !== wantRoom) bad.push(`in ${room}`);
  if (!sees) bad.push('cannot see the prism on the ground');
  if (!(karma <= RIFT_KARMA)) bad.push(`karma ${karma} > ${RIFT_KARMA}`);
  if (feathers < RIFT.feathersPerJoin) bad.push(`${feathers} feathers`);
  if (!(vigor > RIFT.vigorGate + RIFT.failVigor * rolls)) bad.push(`vigor ${vigor}`);
  if (!(mana >= RIFT.joinMana + RIFT.failMana * rolls)) bad.push(`mana ${mana}`);
  return bad;
}
/** A seat's roll chance, bound(myst + (100-myst)*sp/100, 5, 95) (spell.kod:1193). */
export const rollChance = (myst, sp) => Math.max(5, Math.min(95, Math.round(myst + (100 - myst) * sp / 100)));

// ------------------------------------------------------------------ mystic touch and the forecast (pure)
/** Mana regen per second ~= vigor * maxMana / 25000 (report "How long one join lasts": 2604 ms/pt at 160 vigor, 60 max). */
export const manaRegen = (vigor, maxMana) => (Number(vigor) || 0) * (Number(maxMana) || 0) / 25000;
/** The most a target may end at after a touch: min(1.5 x its max mana, 75) (mysttch.kod). */
export const touchCap = maxMana => Math.min(TOUCH.cap, Math.floor(1.5 * (Number(maxMana) || 0)));
/** What one touch moves: pct% of the donor's CURRENT mana, at least 1, at most (mana - 3). */
export const touchAmount = (donorMana, pct) => Math.max(1, Math.min(donorMana - TOUCH.mana, Math.floor(donorMana * pct / 100)));
/** The most a donor can SUSTAIN per second: its regen, less the 3-mana cost of each touch moving pct% of a full tank. */
export const donorSupply = (vigor, maxMana, pct) => {
  const a = (Number(maxMana) || 0) * pct / 100;
  return a > 0 ? manaRegen(vigor, maxMana) * a / (a + TOUCH.mana) : 0;
};
/**
 * THE NO-WASTE RULE: should this donor touch this target now? Never into a full tank (targetMana + amount <= cap),
 * never below the donor's floor (> 3 + 5 mana), never below a seat's join reserve, and only when "ripe" -- the donor at
 * `touchAt` of its own max -- unless `danger`, when any donor mana above the floor goes.
 * Returns { go, amount, cap, why }.
 */
export function touchWorth({ donorMana, donorMax, targetMana, targetMax, pct = 10, touchAt = 0.9, danger = false, reserve = 0 }) {
  const dm = Number(donorMana), pm = Number(targetMana), cap = touchCap(targetMax);
  if (!Number.isFinite(dm) || !Number.isFinite(pm)) return { go: false, amount: 0, cap, why: 'unread mana' };
  const amount = touchAmount(dm, pct);
  if (dm <= TOUCH.mana + TOUCH.minMana) return { go: false, amount, cap, why: 'donor at its floor' };
  const ripe = dm >= (Number(donorMax) || 1) * touchAt || (danger && dm > TOUCH.mana + TOUCH.minMana + 2);
  if (!ripe) return { go: false, amount, cap, why: 'donor not ripe' };
  if (dm - TOUCH.mana - amount < reserve) return { go: false, amount, cap, why: 'donor keeps its join reserve' };
  if (pm + amount > cap) return { go: false, amount, cap, why: 'would be wasted: target too full' };
  return { go: true, amount, cap, why: null };
}
/**
 * THE COLLAPSE FORECAST. `chanters` = [{ sp, mana, vigor, maxMana, chanting }] (the primary first), `supply` = the donors'
 * summed donorSupply, `have` = stored power already in the prism. Joining costs 30 mana and 40 vigor for one not yet
 * chanting; each chanter drains 1 mana/s less its regen at the post-join vigor. Returns
 * { rate, T, pool, drain, supply, lasts, ok }: ok when the chanters' mana lasts `margin` x the time to charge.
 */
export function forecastRift({ chanters, supply = 0, have = 0, margin = 1.1 }) {
  const rate = chanters.reduce((n, c) => n + riftRate(c.sp), 0) || 1;
  const first = chanters[0]?.sp ?? 1;
  const need = Math.max(0, RIFT.needed - have - (have ? 0 : Math.floor(first / 2)));
  const T = need / rate;
  let pool = 0, drain = 0;
  for (const c of chanters) {
    pool += Math.max(0, (Number(c.mana) || 0) - (c.chanting ? 0 : RIFT.joinMana));
    drain += 1 - manaRegen(Math.max(1, (Number(c.vigor) || 0) - (c.chanting ? 0 : RIFT.joinVigor)), c.maxMana);
  }
  const lasts = drain - supply > 0 ? pool / (drain - supply) : Infinity;
  return { rate, T, pool, drain, supply, lasts, ok: lasts >= T * margin };
}

export async function readMember(call, agent) {
  const [st, inv, eq, ab] = await Promise.all([
    call('status', { agent }, 60_000).catch(() => null),
    call('inventory', { agent }, 60_000).catch(() => null),
    call('equipment', { agent }, 60_000).catch(() => null),
    call('abilities', { agent, kind: 'spells' }, 60_000).catch(() => null),
  ]);
  const equippedNames = (eq?.equipped ?? []).map(e => ({ name: nameOf(e), cursed: e.cursed === true || Number(e.rarity) === 200, unidentified: Number(e.rarity) === 100 }));
  const left = [...equippedNames];
  const items = (inv?.items ?? []).map(i => {
    const n = nameOf(i);
    const k = left.findIndex(e => e.name.toLowerCase() === n.toLowerCase());
    const equipped = i.equipped === true || i.using === true || k >= 0;
    const cursed = /\bcursed\b/i.test(n) || Number(i.rarity) === 200 || (k >= 0 && left[k].cursed);
    const unidWorn = k >= 0 && left[k].unidentified;
    if (k >= 0) left.splice(k, 1);
    return { id: i.id, name: n, amount: Number(i.amount) || 1, equipped, cursed, unidentified: Number(i.rarity) === 100 || unidWorn,
             broken: /\bbroken\b/i.test(n), rarity: i.rarity ?? null, owner: agent };
  });
  return { agent, st, inv, eq, ab, items, ok: !!st && Array.isArray(inv?.items), freeBulk: Number(st?.carry?.room_for?.bulk ?? NaN),
           room: roomOf(st), hp: vit(st, 'health').value ?? vit(st, 'hp').value, maxHp: vit(st, 'health').max,
           mana: vit(st, 'mana'), vigor: vit(st, 'vigor'), karma: karmaOf(st), dead: st?.dead === true || st?.ghost === true,
           ability: abilityOf(ab, 'shadow rift'), knowsRift: knows(ab, 'shadow rift') && !riftKarmaBlocks(karmaOf(st)), knowsSpell: knows(ab, 'shadow rift'), knowsTouch: knows(ab, 'mystic touch'),
           cursedWield: equippedNames.filter(e => e.cursed || e.unidentified).map(e => e.name + (e.unidentified ? ' (unidentified: may be cursed)' : '')) };
}

function markFaction(m, fac) {
  let cached = null;
  try { cached = fac?.read(m.character) ?? null; } catch { /* no cache on this machine */ }
  m.faction = cached?.faction ?? 'unknown';
  m.factionSoldier = soldierOf(m.items, cached);
  return m;
}
const factionCache = () => new FactionStatusCache({ dir: join(REPO, 'substrate', 'faction-status') });

async function readRobeSchools(call, members, warn) {
  for (const m of members) for (const i of m.items.filter(x => isDiscipleRobe(x.name))) {
    const r = await call('look_at', { agent: m.agent, target: i.id }, 30_000).catch(() => null);
    // AN ID IS A HANDLE, AND look_at HAS ANSWERED WITH THE PREVIOUS CALL'S OBJECT (CLAUDE.md): check it.
    if (r && Number(r.id) === Number(i.id)) i.robe_school = robeSchoolFromLook(r.description ?? r.desc ?? JSON.stringify(r));
    else warn.push(`${m.agent}: could not read the school of its ${i.name} (look_at answered another object) -- counted +5`);
  }
}

async function eatTo(call, agent, target, untilMs) {
  const v0 = vit(await call('status', { agent }, 30_000).catch(() => null), 'vigor').value;
  let v = v0, meals = 0;
  while (Date.now() < untilMs && Number.isFinite(v) && v < target && !skipWait()) {
    const items = (await call('inventory', { agent }, 30_000).catch(() => null))?.items ?? [];
    const food = splitFood(items).food.filter(f => f.nutrition > 0 && v + f.nutrition <= 200)
      .sort((a, b) => (INKY_RX.test(nameOf(b)) - INKY_RX.test(nameOf(a))) || b.nutrition - a.nutrition);
    if (!food.length) { console.log(`  ${agent}: no food that fits under 200 at vigor ${v}`); break; }
    const er = await call('act', { agent, verb: 'eat', target: food[0].name }, 30_000).catch(e => ({ error: e.message }));
    logEvent({ ev: 'eat', agent, food: food[0].name, vigor: v, reply: er?.error ?? er?.why ?? er?.ok ?? null });
    await sleep(1500);
    const after = vit(await call('status', { agent }, 30_000).catch(() => null), 'vigor').value;
    if (after > v) { meals++; v = after; continue; }
    await sleep(30_000);                       // a full stomach empties on its own clock
    v = vit(await call('status', { agent }, 30_000).catch(() => null), 'vigor').value;
  }
  console.log(`  ${agent}: vigor ${v0} -> ${v} (${meals} bites)`);
  return v;
}

async function wear(call, agent, itemName) {
  const r = await call('act', { agent, verb: 'use', target: itemName }, 30_000).catch(e => ({ error: e.message }));
  await sleep(1200);
  const eq = await call('equipment', { agent }, 30_000).catch(() => null);
  const on = (eq?.equipped ?? []).some(e => nameOf(e).toLowerCase() === itemName.toLowerCase());
  console.log(`  ${agent}: use ${itemName} -> ${on ? 'worn' : 'NOT worn'}${r?.error ? ' (' + r.error + ')' : ''}`);
  return on;
}

/** A listener on one agent's event stream; collects message/said lines with times. */
function listen(call, agent, sink) {
  let on = true, since;
  const loop = (async () => {
    while (on) {
      const ev = await call('wait_for_event', { agent, timeout_ms: 3000, ...(since != null ? { since } : {}) }, 20_000).catch(() => null);
      if (ev?.cursor != null) since = ev.cursor;
      for (const e of ev?.events ?? []) if (e?.kind === 'message' || e?.kind === 'said') sink.push({ at: Date.now(), agent, text: evText(e) });
    }
  })();
  return async () => { on = false; await loop.catch(() => {}); };
}

/** The whole ceremony, run inside the PRIMARY's verify. Returns the verify answer. */

// ------------------------------------------------------------------ places, by region (location-agnostic)
export const isIsland = room => Number(room) >= 2000 && Number(room) < 2700;
/** `halls=714,703` -> [714, 703] (at most two, never on the island: no hall passage is surveyed there). */
export const parseHalls = (halls, room) => (isIsland(room) ? [] : String(halls ?? '').split(/[\s,]+/).map(Number).filter(h => h > 0).slice(0, 2));
/** The vault a member draws from near the casting room (m59-vaults.mjs: Obert 114, Itzal 2005). */
export const vaultFor = room => (isIsland(room) ? VAULTS.find(v => v.room === 2005) : VAULTS.find(v => v.room === 114)) ?? null;
/** Who sells PLAIN mushrooms near the casting room (substrate/m59-shops-seen.json: 104 Joguer, 373 Zhieu, 53 Frisconar). */
export const MUSHROOM_SHOPS = Object.freeze([
  { room: 104, seller: 'Joguer', near: r => r >= 100 && r < 200 },              // Barloque
  { room: 373, seller: "Zhieu B'hob", near: r => r >= 340 && r < 400 },         // Jasper
  { room: 53, seller: 'Frisconar', near: r => r >= 40 && r < 100 },             // Tos
]);
export function mushroomShopFor(room, override = '') {
  const m = /^(\d+):(.+)$/.exec(String(override ?? '').replace(/%20|_/g, ' ').trim());
  if (m) return { room: Number(m[1]), seller: m[2].trim() };
  if (isIsland(room)) return null;   // none seen on the island; carry them over
  return MUSHROOM_SHOPS.find(s => s.near(Number(room))) ?? MUSHROOM_SHOPS[0];
}
/** Squares around the prism, never ON it (the portal opens on the prism's square and teleports whoever stands there). */
const RING = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, -1], [1, -1], [-1, 1], [0, 2], [2, 0], [0, -2], [-2, 0]];
export const clusterSquare = (prism, i) => (prism && Number.isFinite(prism.row) && Number.isFinite(prism.col)
  ? { row: prism.row + RING[i % RING.length][0], col: prism.col + RING[i % RING.length][1] } : null);
export const parseSquare = s => { const m = /^r(\d+)c(\d+)$/i.exec(String(s ?? '').trim()); return m ? { row: Number(m[1]), col: Number(m[2]) } : null; };
const cheb = (a, b) => (a && b ? Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col)) : Infinity);

// ------------------------------------------------------------------ the shared run (one process drives every agent)
let RUN = null;
function freshRun(p) {
  let ceremonyDone; const ceremonyP = new Promise(r => { ceremonyDone = r; });
  return { p, planP: null, plan: null, arrived: new Set(), prism: null, need: {}, ceremonyP, ceremonyDone, roleRestore: null, done: false };
}
const wantsOf = (k) => k === FEATHER ? FEATHER_RX : k === INKY ? INKY_RX : k === SHIELD ? SHIELD_RX : MUSHROOM_RX;
const KINDS = [FEATHER, INKY, 'mushroom', SHIELD];

/** The wants of every member for one role assignment (report step 4: 4 feathers a join). */
function wantsFor(members, { primary, seats, refillers, p }) {
  const w = {};
  for (const m of members) {
    const v = Number.isFinite(m.vigor?.value) ? m.vigor.value : 80;
    w[m.agent] = { [FEATHER]: 0, [INKY]: Math.max(0, Math.floor((Number(p.vigorTarget) - v) / 50)), mushroom: 0, [SHIELD]: 0 };
    if (refillers.includes(m.agent)) w[m.agent].mushroom = Number(p.touchMushrooms);
  }
  if (primary && w[primary]) w[primary][FEATHER] = RIFT.feathersPerJoin * (1 + Number(p.spareJoins));
  for (const s of seats) if (w[s]) w[s][FEATHER] = RIFT.feathersPerJoin;
  return w;
}

/** Roles from what each member KNOWS (abilities), wherever it stands. Seats: the best rift casters but the primary. */
function rolesFor(members, p, sides, holdsFeathers = null) {
  const alive = members.filter(m => m.ok && !m.dead);
  const want = String(p.primary);
  let primary = alive.find(m => m.agent === want && m.knowsRift) ?? null;
  const why = primary ? null : `primary ${want} is ${members.find(m => m.agent === want) ? 'dead, unreadable or cannot cast shadow rift' : 'not in this run'}`;
  if (!primary && want !== 'auto') { /* fall back below, and say so */ }
  return { primary, why, alive, sides,
    seatCandidates: alive.filter(m => m !== primary && m.knowsRift)
      .sort((a, b) => ((holdsFeathers?.(b) ? 1 : 0) - (holdsFeathers?.(a) ? 1 : 0)) || (b.ability || 0) - (a.ability || 0)),
    refillers: alive.filter(m => m !== primary && m.knowsTouch).map(m => m.agent) };
}

/** LOGISTICS PLAN, read from wherever the members stand: who draws what from which vault, the hall, the shop. */
export async function computeLogistics(call, p) {
  const agents = String(p.agents).split(/[\s,]+/).filter(Boolean);
  const fleet = fleetName(), names = characterNames(fleet), fac = factionCache();
  const room = Number(p.room), warn = [], refuse = [];
  const members = [];
  for (const a of agents) members.push(await readMember(call, a));
  for (const m of members) {
    m.character = names[m.agent] ?? m.agent;
    markFaction(m, fac);
    if (!m.ok) warn.push(`${m.agent}: unreadable now (status/inventory) -- planned with an empty pack`);
    if (m.dead) warn.push(`${m.agent}: dead -- left out`);
    if (m.cursedWield.length) warn.push(`${m.agent}: wields a CURSED ${m.cursedWield.join(', ')} -- its weapon slot stays locked`);
    if (!m.knowsSpell) warn.push(`${m.agent}: does not know shadow rift -- refiller/support only`);
    else if (!m.knowsRift) warn.push(`${m.agent}: knows shadow rift but karma is ${m.karma} (> ${RIFT_KARMA}): the server refuses the cast -- not a caster until karma is ${RIFT_KARMA} or lower`);
    if (!m.knowsTouch) warn.push(`${m.agent}: does not know mystic touch -- cannot refill the primary`);
  }
  if (isNoCombatRoom(room)) refuse.push(`room ${room} is a no-combat room: shadow rift refuses there (report Q6)`);
  const sides = Number(p.sides);
  const r = rolesFor(members, p, sides);
  if (!r.primary && String(p.primary) !== 'auto') warn.push(`${r.why} -- the primary is chosen by spell power in the casting room`);
  const primaryAgent = r.primary?.agent ?? r.seatCandidates[0]?.agent ?? null;
  const candidates = r.alive.filter(m => m.agent !== primaryAgent && m.knowsRift).sort((a, b) => (b.ability || 0) - (a.ability || 0));
  if (candidates.length + (primaryAgent ? 1 : 0) < sides) refuse.push(`a ${sides}-sided prism needs ${sides} distinct shadow rift casters; this run has ${candidates.length + (primaryAgent ? 1 : 0)}`);
  const seats = candidates.slice(0, Math.max(0, sides - 1) + Number(p.spareSeats)).map(m => m.agent);
  if (!r.refillers.length) warn.push('NOBODY in the run knows mystic touch: the primary chants on its own mana (report: ~47 s a join at 60 max mana)');
  const wants = wantsFor(r.alive, { primary: primaryAgent, seats, refillers: r.refillers, p });
  // THE ORC SHIELD (+15 for Qor, orcshld.kod:72) -- OPT-IN, orcShield=true. Fetched for the primary when no member carries
  // one (2026-11-20 live: a primary sat at sp 40 = 1/s for want of +15). Operator, the same day: "faction soldiers can't
  // equip them" -- so never for a faction soldier (a supreme-hero Duke shield gives the same +15; pass dukeRank=10), and
  // never for a primary whose soldiering is unread (an unknown is not a non-soldier).
  const pm = r.alive.find(m => m.agent === primaryAgent);
  if (truthy(p.orcShield) && pm && pm.factionSoldier === false && wants[primaryAgent] &&
      !r.alive.some(m => m.items.some(i => SHIELD_RX.test(i.name) && usable(i)))) wants[primaryAgent][SHIELD] = 1;
  const held = Object.fromEntries(KINDS.map(k => [k, r.alive.reduce((n, m) => n + countIn(m.items, wantsOf(k)), 0)]));
  const need = Object.fromEntries(KINDS.map(k => [k, Object.values(wants).reduce((n, w) => n + w[k], 0)]));
  const short = Object.fromEntries(KINDS.map(k => [k, Math.max(0, need[k] - held[k])]));

  // SOURCES, IN ORDER: packs (above) -> members' own vaults -> the guild hall -> a shop.
  const draws = {};                 // agent -> { vault: {kind: n}, hall: {kind: n}, shop: {kind: n} }
  const left = { ...short };
  const vault = truthy(p.vaults) ? vaultFor(room) : null;
  const store = new StorageCache({ dir: join(REPO, 'substrate', 'storage') });
  if (vault) {
    const order = r.alive.slice().sort((a, b) => (Object.values(wants[b.agent]).reduce((x, y) => x + y, 0)) - (Object.values(wants[a.agent]).reduce((x, y) => x + y, 0)));
    for (const m of order) {
      const v = store.readVault(m.character);
      const rows = v?.by_room?.[vault.room]?.items ?? (Number(v?.room ?? vault.room) === vault.room ? v?.items : null) ?? [];
      for (const k of KINDS) {
        if (left[k] <= 0) continue;
        const have = countIn(rows, wantsOf(k));
        const n = Math.min(have, left[k]);
        if (n > 0) { ((draws[m.agent] ??= {}).vault ??= {})[k] = n; left[k] -= n; }
      }
    }
  }
  // HALLS, IN ORDER (mainland only): `halls`, the fleet's own guild halls (default none: which halls a fleet may draw
  // from is its own business); hall_withdraw needs a surveyed passage for each (docs/m59-economy.md). The fetcher is the
  // member with the most FREE BULK (2026-11-20 live: a full pack drew nothing at a hall and the draw still answered ok),
  // then the most health.
  const halls = parseHalls(p.halls, room);
  const hall = halls[0] ?? 0;
  const fetcher = r.alive.filter(m => m.agent !== primaryAgent).sort((a, b) => (b.freeBulk ?? 0) - (a.freeBulk ?? 0) || (b.hp || 0) - (a.hp || 0))[0]?.agent ?? primaryAgent;
  const hallKinds = [FEATHER, INKY, SHIELD].filter(k => left[k] > 0);
  if (halls.length && hallKinds.length && fetcher) (draws[fetcher] ??= {}).hall = Object.fromEntries(hallKinds.map(k => [k, left[k]]));
  for (const m of r.alive) if ((m.freeBulk ?? 999) < Number(p.minFreeBulk) && (draws[m.agent] || wants[m.agent] && Object.values(wants[m.agent]).some(n => n > 0)))
    warn.push(`${m.agent}: only ${m.freeBulk} free bulk -- draws and hand-overs to it may move nothing (make space first)`);
  const shop = mushroomShopFor(room, p.mushroomShop);
  if (left.mushroom > 0) {
    if (shop && fetcher) (draws[fetcher] ??= {}).shop = { mushroom: left.mushroom };
    else warn.push(`${left.mushroom} plain mushrooms short and no mushroom seller is known near ${room} -- give mushroomShop=<room>:<seller>`);
  }
  const minFeathers = RIFT.feathersPerJoin * sides;
  const reachable = held[FEATHER] + Object.values(draws).reduce((n, d) => n + (d.vault?.[FEATHER] ?? 0), 0) + (hall ? Infinity : 0);
  if (reachable < minFeathers) refuse.push(`the run can find ${held[FEATHER]} dark angel feathers (packs) + its vaults; one ${sides}-sided casting needs ${minFeathers}`);
  const plan = { at: new Date().toISOString(), room, sides, vault, hall, halls, shop, primary: primaryAgent, seats, refillers: r.refillers,
    names: Object.fromEntries(members.map(m => [m.agent, m.character])), members: r.alive.map(m => m.agent),
    wants, held, short, draws, fetcher, warn, refuse,
    where: Object.fromEntries(members.map(m => [m.agent, m.room])) };
  return plan;
}

export function printLogistics(plan, log = console.log) {
  log(`  SHADOW RIFT in ${plan.room} (${plan.sides}-sided prism expected); primary ${plan.primary}; seat candidates ${plan.seats.join(',') || '-'}; mystic touch ${plan.refillers.join(',') || '-'}`);
  log(`    standing in: ${Object.entries(plan.where).map(([a, r]) => `${a}@${r}`).join(' ')}`);
  log(`    group holds ${JSON.stringify(plan.held)}; short ${JSON.stringify(plan.short)}`);
  for (const [a, d] of Object.entries(plan.draws)) log(`    ${a}: ${d.vault ? `vault ${plan.vault?.room} ${JSON.stringify(d.vault)} ` : ''}${d.hall ? `halls ${plan.halls.join('>')} ${JSON.stringify(d.hall)} ` : ''}${d.shop ? `shop ${plan.shop?.room} ${plan.shop?.seller} ${JSON.stringify(d.shop)}` : ''}`);
  for (const w of plan.warn) log(`    WARN ${w}`);
  for (const r of plan.refuse) log(`    REFUSE ${r}`);
}

function planOnce(call, p) {
  const age = RUN?.plan?.at ? Date.now() - Date.parse(RUN.plan.at) : 0;
  if (!RUN || RUN.p.agents !== p.agents || RUN.done || age > 10 * 60_000 || (RUN.plan?.refuse?.length && age > 60_000)) RUN = freshRun(p);
  RUN.planP ??= computeLogistics(call, p).then(plan => { RUN.plan = plan; printLogistics(plan); logEvent({ ev: 'logistics', plan }); return plan; })
    .catch(e => { const plan = { refuse: [`could not plan: ${e.message}`], warn: [], members: [], draws: {} }; RUN.plan = plan; return plan; });
  return RUN.planP;
}

// ------------------------------------------------------------------ the ceremony-time gear plan (members IN the room)
export async function gearPlan(call, members, p, warn) {
  await readRobeSchools(call, members, warn);
  const pool = members.flatMap(m => m.items);
  const opts = { qorHour: Number(p.qorHour) >= 0 ? Number(p.qorHour) : qorBonusAt(Date.now()), dukeRank: Number(p.dukeRank), qorLevel: 4, orcShield: truthy(p.orcShield) };
  const ranked = members.filter(m => m.knowsRift).map(m => ({ m, best: bestSet(m, pool, opts) }))
    .sort((a, b) => b.best.sp - a.best.sp || (b.m.mana.max || 0) - (a.m.mana.max || 0));
  let pick = String(p.primary) !== 'auto' ? ranked.find(r => r.m.agent === String(p.primary)) ?? null : null;
  if (!pick) { if (String(p.primary) !== 'auto') warn.push(`primary ${p.primary} is not in the casting room alive and able to cast -- falling back to the highest spell power`); pick = ranked[0] ?? null; }
  if (!pick) return null;
  const primary = pick.m, best = pick.best, gear = [];
  for (const slot of SLOTS) {
    const it = best.set[slot];
    if (it && (it.owner !== primary.agent || !it.equipped)) gear.push({ slot, item: it.name, from: it.owner, mod: qorItemMod(it, opts) });
  }
  for (const i of primary.items.filter(i => i.equipped && SLOTS.includes(itemSlot(i.name)) && !i.cursed && !best.set[itemSlot(i.name)] && qorItemMod(i, opts) < 0))
    gear.push({ slot: itemSlot(i.name), item: i.name, from: primary.agent, unuse: true, mod: -qorItemMod(i, opts) });
  if (!pool.some(i => /^mace$/i.test(i.name) && usable(i))) warn.push(best.locked.includes('weapon') ? 'primary weapon locked by a curse' : 'no mace in the group: -5 sp (the only weapon that adds spell power)');
  if (!pool.some(i => isDiscipleRobe(i.name) && /qor/i.test(i.robe_school ?? ''))) warn.push(pool.some(i => isDiscipleRobe(i.name)) ? 'a disciple robe is here but no look read QOR on it (counted +5)' : 'no disciple robe in the group: -16..20 sp');
  if (truthy(p.orcShield) && !pool.some(i => SHIELD_RX.test(i.name) && usable(i))) warn.push('orcShield=true but no orc shield in the group (faction soldiers cannot wear one; a supreme-hero Duke shield gives the same +15 with dukeRank=10)');
  if (!pool.some(i => CIRCLET_RX.test(i.name) && usable(i))) warn.push('no circlet in the group: no max-mana boost');
  if (best.locked.length) warn.push(`primary ${primary.agent}: ${best.locked.join(', ')} locked by a cursed item`);
  warn.push(`Qor hour bonus now ${opts.qorHour} (game hour ${gameHourNow()}; 2 at noon .. 26 at midnight; a game hour is 5 real minutes)`);
  for (const r of ranked) if (r.m !== primary && r.best.sp > best.sp) warn.push(`${r.m.agent} would reach ~${r.best.sp} sp against the primary's ~${best.sp}`);
  return { primary, best, gear, ranking: ranked.map(r => ({ agent: r.m.agent, sp: r.best.sp, parts: r.best.parts, ability: r.m.ability, maxMana: r.m.mana.max })) };
}

// ------------------------------------------------------------------ hand-overs, verified and retried
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rxFor = what => new RegExp(`^${esc(what).replace(/-/g, '.?')}s?$`, 'i');
async function countOf(call, agent, rx) { return countIn((await call('inventory', { agent }, 60_000).catch(() => null))?.items, rx); }
/** supply, read back BY THE RECEIVER'S COUNT; a hand-over that moves nothing is retried twice (2026-11-20 live: one moved 0). */
async function moveItem(call, from, to, what, amount, rx = rxFor(what)) {
  if (from === to || amount <= 0) return { ok: true, moved: 0 };
  let moved = 0;
  for (let attempt = 0; attempt < 3 && moved < amount; attempt++) {
    const sent = await countOf(call, from, rx);
    if (sent <= 0) { console.log(`  ${from} has no ${what} left to give`); break; }
    const before = await countOf(call, to, rx);
    const n = Math.min(amount - moved, sent);
    const r = await call('supply', { from, to, what, amount: n, who_travels: 'neither', ...(attempt === 0 ? { exact: true } : {}) }, 240_000).catch(e => ({ error: e.message }));
    let after = before;
    for (let i = 0; i < 4 && after <= before; i++) { await sleep(1500); after = await countOf(call, to, rx); }
    moved += Math.max(0, after - before);
    console.log(`  ${from} -> ${to}: ${what} x${n}: received ${after - before}${r?.error ? ' (' + String(r.error).slice(0, 100) + ')' : r?.why ? ' (' + String(r.why).slice(0, 100) + ')' : ''}${attempt ? ` [retry ${attempt}]` : ''}`);
    if (after <= before) await sleep(3000);
  }
  return { ok: moved > 0, moved };
}
/** Move `kind` from surplus holders to whoever is short of `wants`, reading every pack fresh. */
async function distribute(call, agents, wants, kind) {
  const rx = wantsOf(kind), packs = {};
  for (const a of agents) packs[a] = await countOf(call, a, rx);
  const want = a => wants[a]?.[kind] ?? 0;
  for (const to of agents) {
    let gap = want(to) - packs[to];
    for (const from of agents.slice().sort((a, b) => (packs[b] - want(b)) - (packs[a] - want(a)))) {
      if (gap <= 0) break;
      const spare = packs[from] - want(from);
      if (from === to || spare <= 0) continue;
      const r = await moveItem(call, from, to, kind, Math.min(spare, gap), rx);
      packs[from] -= r.moved; packs[to] += r.moved; gap -= r.moved;
    }
    if (gap > 0) console.log(`  ${to}: still ${gap} ${kind} short of its ${want(to)}`);
  }
  return packs;
}

// ------------------------------------------------------------------ presence: gather and re-gather
async function whereIs(call, agent) {
  const lk = await call('look', { agent }, 60_000).catch(() => null);
  return { room: Number(lk?.room?.num ?? NaN), at: Number.isFinite(lk?.you?.row) ? { row: lk.you.row, col: lk.you.col } : null, look: lk };
}
/** One travel per drifted member (never re-issued while it walks), polled to arrival; then a walk_to the cluster. */
async function regather(call, agents, room, square, budgetMs) {
  const out = {};
  await Promise.all(agents.map(async (a, i) => {
    let w = await whereIs(call, a);
    if (w.room !== room) {
      const hp = await call('status', { agent: a }, 30_000).catch(() => null);
      const h = vit(hp, 'health'); if (h.max > 0 && h.value / h.max < 0.9) { out[a] = `hurt (${h.value}/${h.max}) outside ${room}: left to its keeper`; return; }
      console.log(`  ${a} drifted to ${w.room}: travelling back to ${room} (one order)`);
      await call('travel', { agent: a, to: room, background: true }, 60_000).catch(() => null);
      const until = Date.now() + budgetMs;
      while (Date.now() < until && w.room !== room && !skipWait()) { await sleep(8000); w = await whereIs(call, a); }
      if (w.room !== room) { out[a] = `still in ${w.room} after ${Math.round(budgetMs / 1000)} s`; return; }
    }
    const sq = square(a, i);
    if (sq && cheb(w.at, sq) > Number(RUN?.p?.clusterRadius ?? 2)) {
      await call('walk_to', { agent: a, col: sq.col, row: sq.row, arrive_within: 8 }, 90_000).catch(() => null);
      w = await whereIs(call, a);
    }
    out[a] = w.room === room ? true : `not in ${room}`;
  }));
  return out;
}

async function findPrism(call, agents, room) {
  for (const a of agents) {
    const w = await whereIs(call, a);
    if (w.room !== room) continue;
    const objs = w.look?.objects ?? [];
    const players = objs.filter(o => o?.player || o?.kind === 'player' || o?.is_player).map(o => nameOf(o));
    const prism = objs.find(o => PRISM_RX.test(nameOf(o)) && !o?.player);
    if (prism) return { where: 'ground', id: prism.id, by: a, square: { row: Number(prism.row), col: Number(prism.col) }, players };
    for (const b of agents) {
      const it = ((await call('inventory', { agent: b }, 60_000).catch(() => null))?.items ?? []).find(i => PRISM_RX.test(nameOf(i)));
      if (it) return { where: 'pack', holder: b, id: it.id, players };
    }
    return { where: null, players };
  }
  return { where: null, players: [] };
}
async function lookPrism(call, agent, id) {
  const r = await call('look_at', { agent, target: id ?? 'prism' }, 30_000).catch(() => null);
  const text = String(r?.description ?? r?.desc ?? '');
  const sides = SIDES_WORD[(text.match(/this prism has (\w+)/i) ?? [])[1]?.toLowerCase()] ?? null;
  const dest = (text.match(/it appears to be ([^.]+)/i) ?? [])[1] ?? null;
  const glow = GLOW.find(([rx]) => rx.test(text))?.[1] ?? 0;
  return { text, sides, dest, glow, idOk: r ? (id == null || Number(r.id) === Number(id)) : false };
}

// ------------------------------------------------------------------ the ceremony (inside the PRIMARY's last verify)
async function ceremony(call, logi, p) {
  const room = Number(p.room), until = Date.now() + Number(p.maxMinutes) * 60_000, warn = [];
  const log = (ev, extra = {}) => logEvent({ ev, ...extra });
  const isEnemy = enemyMatcher(p.enemies);
  // 0. the barrier: everyone who is still on the errand reaches the room, or `gatherMinutes` passes
  const bUntil = Date.now() + Number(p.gatherMinutes) * 60_000;
  while (Date.now() < bUntil && logi.members.some(a => !RUN.arrived.has(a)) && !skipWait()) await sleep(5000);
  const late = logi.members.filter(a => !RUN.arrived.has(a));
  if (late.length) console.log(`  not arrived after ${p.gatherMinutes} min: ${late.join(', ')} -- one travel order each, then on without them`);
  let agents = logi.members.slice();
  // 1. the prism, and the cluster around it; re-gather anyone not in the room or not in the cluster
  // The prism: on the ground, or in a member's pack (that member stands on `square` -- e.g. r15c15 in 2009 -- and drops it),
  // or held by someone OUTSIDE the run (say, a character a person is piloting): never commanded, so the run waits up to
  // `prismWaitMinutes` for it to appear on the floor.
  const want = parseSquare(p.square);
  let prism = await findPrism(call, agents, room);
  const pUntil = Date.now() + Number(p.prismWaitMinutes) * 60_000;
  while (!prism.where && Date.now() < pUntil && !stopRequested() && !skipWait()) {
    console.log(`  no prism on the floor of ${room} or in a member's pack yet${want ? ` (it belongs at r${want.row}c${want.col})` : ''} -- waiting`);
    await sleep(20_000);
    prism = await findPrism(call, agents, room);
  }
  if (prism.where === 'pack') {
    if (want) {
      await call('walk_to', { agent: prism.holder, col: want.col, row: want.row, arrive_within: 8, max_steps: 120 }, 120_000).catch(() => null);
      console.log(`  ${prism.holder}: dropping the prism at r${want.row}c${want.col}`);
    }
    await call('act', { agent: prism.holder, verb: 'drop', target: prism.id }, 30_000).catch(() => null);
    await sleep(2500);
    // the dropper steps OFF the prism's square: the portal opens there and teleports whoever stands on it
    if (want) { const at = clusterSquare(want, 0); await call('walk_to', { agent: prism.holder, col: at.col, row: at.row, arrive_within: 8, max_steps: 40 }, 60_000).catch(() => null); }
    prism = await findPrism(call, agents, room);
  }
  if (prism.where !== 'ground') return { ok: false, why: `no prism on the ground in ${room} and none in a member's pack after ${p.prismWaitMinutes} min (a prism held outside the run is never commanded)` };
  if (want && cheb(prism.square, want) > 0) console.log(`  WARN the prism lies at r${prism.square.row}c${prism.square.col}, not the asked r${want.row}c${want.col} -- casting at it where it lies`);
  RUN.prism = prism.square;
  const enemies = (prism.players ?? []).filter(n => isEnemy(n));
  if (enemies.length) return { ok: false, why: `named enemy in the room: ${enemies.join(', ')}` };
  const slot = new Map(agents.map((a, i) => [a, i]));
  const square = (a) => clusterSquare(prism.square, slot.get(a) ?? 0);
  let here = await regather(call, agents, room, square, Number(p.regatherMinutes) * 60_000);
  agents = agents.filter(a => here[a] === true);
  for (const [a, v] of Object.entries(here)) if (v !== true) console.log(`  ${a}: left out -- ${v}`);
  const pl = await lookPrism(call, prism.by, prism.id);
  const sides = (pl.idOk && pl.sides) || Number(p.sides);
  const purpose = pl.idOk && pl.dest ? 'open' : 'bind';
  console.log(`  prism at r${prism.square.row}c${prism.square.col}: ${sides} sides, ${purpose === 'open' ? 'bound to ' + pl.dest : 'UNBOUND'}`);
  if (purpose === 'bind' && truthy(p.openOnly)) return { ok: false, why: 'the prism reads unbound and openOnly=true (a bind would record this spot for ever, report Q2)' };
  if (purpose === 'open') {
    const roomName = String((await whereIs(call, agents[0])).look?.room?.name ?? '');
    if (pl.dest && roomName && new RegExp(esc(pl.dest.replace(/^the\s+/i, '')), 'i').test(roomName)) return { ok: false, why: `the prism is bound to this room (${pl.dest}); opening here fails and spends the feathers` };
  }
  // 2. fresh reads of everyone present; the primary and the gear, from what is IN the room
  const members = [];
  const fac = factionCache();
  for (const a of agents) { const m = await readMember(call, a); m.character = logi.names[a] ?? a; markFaction(m, fac); members.push(m); }
  const g = await gearPlan(call, members, p, warn);
  if (!g) return { ok: false, why: 'nobody in the cluster can cast shadow rift' };
  const P = g.primary.agent, name = g.primary.character;
  for (const r of g.ranking) console.log(`    ${r.agent === P ? '*' : ' '} ${r.agent} ~sp ${r.sp} (${r.parts}; rift ${r.ability}%, max mana ${r.maxMana})`);
  for (const x of g.gear) console.log(`    gear: ${x.unuse ? 'take off' : 'wear'} ${x.item} (${x.slot}, ${x.mod >= 0 ? '+' : ''}${x.mod})${x.from !== P ? ' from ' + x.from : ''}`);
  for (const w of warn) console.log(`    WARN ${w}`);
  const roles = rolesFor(members.map(m => ({ ...m })), { ...p, primary: P }, sides);
  const refillers = roles.refillers;
  if (roles.seatCandidates.length < sides - 1) return { ok: false, why: `a ${sides}-sided prism needs ${sides} distinct shadow rift casters in the room; ${roles.seatCandidates.length + 1} are here` };
  // 3. SHARE: feathers to the primary and enough seat candidates, inkies to everyone, mushrooms to the refillers
  const seatsWanted = Math.min(roles.seatCandidates.length, sides - 1 + Number(p.spareSeats));
  let wants = wantsFor(members, { primary: P, seats: roles.seatCandidates.slice(0, seatsWanted).map(m => m.agent), refillers, p });
  const packsF = await distribute(call, agents, wants, FEATHER);
  // SEATS ARE WHOEVER ACTUALLY HOLDS 4 FEATHERS NOW; a failed hand-over reassigns rather than refusing.
  let seatPool = roles.seatCandidates.map(m => m.agent).filter(a => packsF[a] >= RIFT.feathersPerJoin);
  if (seatPool.length < sides - 1) {
    for (const s of roles.seatCandidates.map(m => m.agent).filter(a => !seatPool.includes(a))) {
      const donor = agents.filter(a => a !== s && packsF[a] - (a === P ? RIFT.feathersPerJoin : seatPool.includes(a) ? RIFT.feathersPerJoin : 0) >= RIFT.feathersPerJoin)[0];
      if (!donor) break;
      const r = await moveItem(call, donor, s, FEATHER, RIFT.feathersPerJoin - packsF[s], FEATHER_RX);
      packsF[donor] -= r.moved; packsF[s] += r.moved;
      if (packsF[s] >= RIFT.feathersPerJoin) seatPool.push(s);
      if (seatPool.length >= sides - 1) break;
    }
  }
  if (packsF[P] < RIFT.feathersPerJoin) return { ok: false, why: `the primary ${P} holds ${packsF[P]} dark angel feathers after sharing; a join needs 4` };
  if (seatPool.length < sides - 1) return { ok: false, why: `only ${seatPool.length} seat caster(s) hold 4 feathers after sharing (${JSON.stringify(packsF)}); ${sides - 1} needed -- no feather spent on a circle that cannot close` };
  await distribute(call, agents, wants, INKY);
  await distribute(call, agents, wants, 'mushroom');
  console.log(`  seats in order: ${seatPool.join(', ')}; refillers: ${refillers.join(', ') || '-'}`);
  // 4. gear onto the primary (circlet last), vigor, circlet
  for (const x of g.gear.filter(x => !x.unuse && x.from !== P)) {
    await call('act', { agent: x.from, verb: 'unuse', target: x.item }, 30_000).catch(() => null);
    await sleep(800);
    await moveItem(call, x.from, P, x.item, 1);
  }
  for (const x of g.gear.filter(x => x.unuse)) await call('act', { agent: P, verb: 'unuse', target: x.item }, 30_000).catch(() => null);
  for (const x of g.gear.filter(x => !x.unuse && !CIRCLET_RX.test(x.item))) await wear(call, P, x.item);
  {
    const fresh = {};
    for (const a of agents) fresh[a] = { [INKY]: Math.max(0, Math.floor((Number(p.vigorTarget) - (vit(await call('status', { agent: a }, 30_000).catch(() => null), 'vigor').value || 0)) / 50)) };
    await distribute(call, agents, fresh, INKY);
  }
  const vUntil = Date.now() + Number(p.vigorMinutes) * 60_000;
  const vig = await Promise.all(agents.map(a => eatTo(call, a, Number(p.vigorTarget), vUntil)));
  const pv = vig[agents.indexOf(P)];
  if (!(pv > RIFT.vigorGate + RIFT.joinVigor)) return { ok: false, why: `the primary's vigor is ${pv}; it needs > ${RIFT.vigorGate + RIFT.joinVigor} to join with a re-join in hand` };
  if (pv < Number(p.vigorTarget)) console.log(`  WARN primary vigor ${pv} < ${p.vigorTarget}`);
  const circ = g.gear.find(x => CIRCLET_RX.test(x.item));
  if (circ) await wear(call, P, circ.item);
  // 5. VALIDATE EVERY SEAT BEFORE ANYONE PAYS (2026-11-20 live: three seats cast, none chanted, nothing was logged).
  //    Each seat must: be in the room, SEE the prism on the ground, know shadow rift, have karma <= -40 (status.karma.value),
  //    hold 4 feathers, vigor > 40 + 20 per allowed failed roll, mana >= 30 + 15 per allowed failed roll. Its roll chance is
  //    bound(myst + (100-myst)*sp/100, 5, 95) (spell.kod:1193); `seatRolls` failed rolls are budgeted per seat.
  const st = a => call('status', { agent: a }, 30_000).catch(() => null);
  const mystOf = s => Number(s?.attributes?.mysticism?.value ?? 25);
  const chance = (s, sp) => rollChance(mystOf(s), sp);
  const spOf = a => g.ranking.find(r => r.agent === a)?.sp ?? 1;
  const validate = async (a) => {
    const s = await st(a), w = await whereIs(call, a);
    const sees = (w.look?.objects ?? []).some(o => PRISM_RX.test(nameOf(o)));
    const karma = karmaOf(s), feathers = await countOf(call, a, FEATHER_RX);
    const vg = vit(s, 'vigor').value, mn = vit(s, 'mana').value;
    const rolls = Number(p.seatRolls);
    const bad = seatProblems({ room: w.room, wantRoom: room, sees, karma, feathers, vigor: vg, mana: mn }, rolls);
    const row = { agent: a, room: w.room, sees, karma, feathers, vigor: vg, mana: mn, sp: spOf(a), chance: chance(s, spOf(a)), ok: !bad.length, bad };
    console.log(`    seat check ${a}: ${row.ok ? 'OK' : 'NO -- ' + bad.join(', ')} (karma ${karma}, feathers ${feathers}, vigor ${vg}, mana ${mn}, ~sp ${row.sp}, roll ${row.chance}%)`);
    log('seat_check', row);
    return row;
  };
  // 6. THE FORECAST: rate, duration, the primary's mana budget against the refill supply -- before any feather is paid.
  //    rate = bound((sp+1)/25,1,4) (report step 5). The Qor hour bonus is read from the game clock (m59-dayclock anchor,
  //    else system.kod's derivation): a game hour is 5 real minutes, so the bonus moves DURING a long chant.
  //    Mana regen per second ~= vigor * maxMana / 25000 (report "How long one join lasts", 2604 ms/pt at 160 vigor, 60 max).
  //    One mystic touch moves pct% of the donor's CURRENT mana (pct = bound(faren sp/2,10,55), learned from observed touches)
  //    for 3 mana, so a donor sustains regen * a/(a+3) at most, and the most per touch when it is full.
  const pct = new Map();                                   // donor -> learned % of its mana a touch moves
  const pctOf = d => pct.get(d) ?? Number(p.touchPct);
  const supplyOf = async (donors) => {
    let total = 0;
    for (const d of donors) { const s = await st(d); total += donorSupply(vit(s, 'vigor').value, vit(s, 'mana').max, pctOf(d)); }
    return total;
  };
  const forecast = async (label, chanters = [P]) => {
    const ps = await st(P);
    const pm = vit(ps, 'mana').value, spNow = g.best.sp - Number(g.best.hour) + qorBonusAt(Date.now());
    const spP = Math.max(1, Math.min(99, spNow));
    const donors = refillers.filter(d => agents.includes(d) && !chanters.includes(d));
    const S = await supplyOf(donors);
    const rows = [];
    for (const a of chanters) {
      const s = a === P ? ps : await st(a);
      rows.push({ sp: a === P ? spP : spOf(a), mana: vit(s, 'mana').value, vigor: vit(s, 'vigor').value, maxMana: vit(s, 'mana').max, chanting: chanting.has(a) });
    }
    const m = forecastRift({ chanters: rows, supply: S, have: RUN.estPower ?? 0, margin: Number(p.forecastMargin) });
    const { rate, T, pool, drain, lasts } = m;
    const f = { label, sp: spP, rate, T: Math.round(T), chanters, pool, primary_mana: pm, drain: +drain.toFixed(2), supply: +S.toFixed(2), lasts: Number.isFinite(lasts) ? Math.round(lasts) : 'forever', ok: m.ok };
    console.log(`  FORECAST (${label}): ~sp ${spP} -> ${rate}/s, ~${f.T} s to charge; chanters' mana ${pool} after joining, net drain ${f.drain}/s vs refill supply ${f.supply}/s -> lasts ${f.lasts} s: ${f.ok ? 'SUSTAINABLE' : 'NOT SUSTAINABLE'}`);
    log('forecast', f);
    return f;
  };

  // 7. KEEPER-STATE JOINS: a join is decided by the keeper's own enchantment observation (riftEnchanted), never only by a
  //    sentence or a cast reply (the primary's reply timed out on 2026-11-20 while the join had worked). Every cast reply and
  //    every line the caster heard is logged.
  const lines = [];
  const heard = (rx, since = 0) => lines.find(l => l.at >= since && rx.test(l.text));
  const stopEars = agents.map(a => listen(call, a, lines));
  const chanting = new Set();
  const joinOne = async (agent, why) => {
    const t0 = Date.now();
    const fail = /fizzle|failed|you are too tired|not enough|reagents|can'?t find a prism|pointless|bad location|cannot cast/i;
    let reply = null;
    const sent = call('cast', { agent, spell: 'shadow rift', holdMs: 60_000 }, 25_000).then(r => { reply = r; }).catch(e => { reply = { error: e.message }; });
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const byKeeper = await riftEnchanted(agent, t0);
      const bySentence = !keeperBandKnown() && lines.some(x => x.at >= t0 && x.agent === agent && (SAID.began.test(x.text) || SAID.joined.test(x.text)));
      if (byKeeper || bySentence) {
        chanting.add(agent);
        console.log(`  ${agent}: shadow rift -> CHANTING (${byKeeper ? 'the keeper shows the enchantment' : 'the server said so; no keeper band to read'})`);
        log('join', { agent, why, ok: true, reply, said: lines.filter(l => l.agent === agent && l.at >= t0).map(l => l.text) });
        return true;
      }
      const l = lines.find(x => x.at >= t0 && x.agent === agent && fail.test(x.text));
      if (l || reply?.cast === false) {
        await sleep(1500);
        if (await riftEnchanted(agent, t0)) { chanting.add(agent); return true; }
        const said = lines.filter(x => x.agent === agent && x.at >= t0).map(x => x.text);
        console.log(`  ${agent}: shadow rift -> NOT joined: ${l?.text ?? reply?.reason ?? '?'}`);
        log('join', { agent, why, ok: false, reply, said });
        return false;
      }
    }
    await sent;
    const said = lines.filter(x => x.agent === agent && x.at >= t0).map(x => x.text);
    console.log(`  ${agent}: shadow rift -> no enchantment after 30 s. cast reply: ${JSON.stringify(reply)?.slice(0, 300)}; heard: ${said.slice(-6).join(' | ') || '(nothing)'}`);
    log('join', { agent, why, ok: false, reply, said, note: 'no keeper enchantment in 30 s' });
    return false;
  };
  /** A seat joins; a failed roll (half mana, half exertion) is retried up to `seatRolls` times while it still validates. */
  const seatJoin = async (s, why) => {
    for (let k = 0; k <= Number(p.seatRolls); k++) {
      const v = await validate(s);
      if (!v.ok && !(k > 0 && v.bad.every(b => /^mana|^vigor/.test(b)) && v.mana >= RIFT.joinMana && v.vigor > RIFT.vigorGate)) return false;
      if (await joinOne(s, why + (k ? ` (roll ${k + 1})` : ''))) return true;
      await sleep(2000);
    }
    return false;
  };

  // 8. REFILLS: one loop PER DONOR, all in parallel, as fast as the server lets each cast (post_cast 1 s); a donor touches
  //    only when the touch is worth the most -- its own mana at or above `touchAt` of its max -- unless the primary is in
  //    danger (forecast lasts < remaining), when any touch above the floor goes. Never into a full tank (pm + a <= cap).
  //    Verified by the PRIMARY's mana rising and the donor's own "You give part of your magical energy to <name>."
  const gaveTo = who => new RegExp(`give part of your magical energy to ${esc(logi.names[who] ?? who)}`, 'i');
  const GAVE = /give part of your magical energy to/i;
  const touches = [];
  const keep = { on: true, danger: false };
  const donorLoop = async (d) => {
    while (keep.on && !stopRequested()) {
      if (chanting.has(d)) { await sleep(2000); continue; }
      // the target: the primary, or -- once seats are chanting -- the chanter with the least mana for its max
      const targets = [...new Set([P, ...[...chanting].filter(a => a !== d)])];
      const reads = await Promise.all([st(d), ...targets.map(t => st(t))]);
      const ds = reads[0];
      const tgt = targets.map((t, i) => ({ t, s: reads[i + 1] })).filter(x => Number.isFinite(vit(x.s, 'mana').value))
        .sort((a, b) => vit(a.s, 'mana').value / (vit(a.s, 'mana').max || 1) - vit(b.s, 'mana').value / (vit(b.s, 'mana').max || 1))[0] ?? { t: P, s: reads[1] };
      const ps = tgt.s, T = tgt.t;
      const dm = vit(ds, 'mana').value, pm = vit(ps, 'mana').value;
      const reserve = seatPool.slice(0, sides - 1).includes(d) && !RUN.seatsIn ? RIFT.joinMana + RIFT.failMana : 0;
      const worth = touchWorth({ donorMana: dm, donorMax: vit(ds, 'mana').max, targetMana: pm, targetMax: vit(ps, 'mana').max,
        pct: pctOf(d), touchAt: Number(p.touchAt), danger: keep.danger, reserve });
      if (!worth.go) { await sleep(1500); continue; }
      const a = worth.amount;
      const t0 = Date.now();
      const r = await call('cast', { agent: d, spell: 'mystic touch', target: logi.names[T] ?? T, holdMs: 1500 }, 20_000).catch(e => ({ error: e.message }));
      await sleep(1200);
      const [ds2, ps2] = await Promise.all([st(d), st(T)]);
      const gave = lines.find(l => l.agent === d && l.at >= t0 && gaveTo(T).test(l.text));
      const other = lines.filter(l => l.agent === d && l.at >= t0 && !GAVE.test(l.text)).map(l => l.text);
      const moved = (vit(ds, 'mana').value - vit(ds2, 'mana').value) - TOUCH.mana;            // what left the donor, less the cost
      const rose = vit(ps2, 'mana').value - pm;
      if (gave && moved > 0 && dm > 0) pct.set(d, Math.max(TOUCH.minPct, Math.min(55, Math.round(100 * moved / dm))));
      const row = { from: d, to: T, donor_mana: dm, primary_mana: pm, expected: a, moved, primary_rose: rose, landed: !!gave, danger: keep.danger, reply: r?.cast === false ? r.reason : r?.error ?? undefined, other: other.length ? other : undefined };
      touches.push({ at: Date.now(), amount: gave ? Math.max(0, moved) : 0 });
      log('touch', row);
      if (!gave && other.length) console.log(`  WARN ${d}'s touch did not say "give part of your magical energy to ${logi.names[T] ?? T}": ${other.join(' | ')}`);
      await sleep(gave ? 800 : 2500);
    }
  };

  // 9. pre-fill, presence, seat validation, forecast -- all before the primary pays
  const preUntil = Date.now() + Number(p.prefillMinutes) * 60_000;
  const donorsP = refillers.filter(d => agents.includes(d)).map(d => donorLoop(d));
  while (Date.now() < preUntil && !skipWait()) {
    const ps = await st(P); const pm = vit(ps, 'mana').value, mx = vit(ps, 'mana').max;
    if (pm >= Math.min(touchCap(mx), mx) - 2) break;
    await sleep(3000);
  }
  here = await regather(call, agents, room, square, Number(p.regatherMinutes) * 60_000);
  const checks = [];
  for (const s of seatPool) checks.push(await validate(s));
  seatPool = checks.filter(c => c.ok).sort((a, b) => b.chance - a.chance).map(c => c.agent);
  const abort = async (why) => { keep.on = false; await Promise.all(donorsP); for (const s of stopEars) await s(); return { ok: false, why }; };
  if (here[P] !== true) return abort(`the primary is not in the cluster before the join: ${here[P]}`);
  if (seatPool.length < sides - 1) return abort(`only ${seatPool.length} seat(s) pass the seat check (${checks.map(c => c.agent + ':' + (c.ok ? 'ok' : c.bad.join('/'))).join('; ')}); ${sides - 1} needed -- nothing paid`);
  // WAIT FOR A BETTER QOR HOUR when asked (minQorRate): the bonus is 2 + |hour-12|*2, best at game midnight.
  for (let waited = 0; Number(p.minRate) > 1 && riftRate(Math.min(99, g.best.sp - g.best.hour + qorBonusAt(Date.now()))) < Number(p.minRate); ) {
    if (waited >= Number(p.hourWaitMinutes) * 60_000 || skipWait() || stopRequested()) break;
    if (waited % 300_000 === 0) console.log(`  waiting for the Qor hour: game hour ${gameHourNow()}, bonus ${qorBonusAt(Date.now())}, rate ${riftRate(Math.min(99, g.best.sp - g.best.hour + qorBonusAt(Date.now())))} < minRate ${p.minRate}`);
    await sleep(30_000); waited += 30_000;
  }
  let fc = await forecast('solo, seats at the end');
  let plan = 'solo';
  if (!fc.ok) {
    const fc2 = await forecast('everyone at once', [P, ...seatPool.slice(0, sides - 1)]);
    if (fc2.ok) { plan = 'together'; fc = fc2; }
    else if (!truthy(p.force)) return abort(`the refill supply cannot sustain the chant (solo lasts ${fc.lasts} s for ${fc.T} s; together lasts ${fc2.lasts} s for ${fc2.T} s) -- refusing before any feather is paid (force=true overrides). Levers: a better Qor hour (game hour ${gameHourNow()}), a supreme-hero Duke shield or an orc shield (+15), more mystic touch donors, more max mana.`);
    else console.log('  WARN force=true: going ahead although the forecast says the chant cannot be sustained');
  }

  // 10. THE CHANT: cast-gear rites off for every chanter, the primary casts once (or the whole circle, plan 'together')
  const cr = castRoles();
  RUN.roleRestore = [P, ...seatPool].map(a => ({ agent: a, role: cr[a] === 'rift' ? (p.restoreRole || null) : (cr[a] ?? null) }));
  for (const a of [P, ...seatPool]) { try { setRole(a, 'rift'); } catch (e) { console.log(`  WARN could not untag ${a}'s cast role: ${e.message}`); } }
  let joins = 0, seatJoins = 0, result = null, joinedAt = null, lastGlow = 0;
  RUN.estPower = 0; RUN.seatsIn = false;
  const eq0 = new Set((((await call('equipment', { agent: P }, 30_000).catch(() => null))?.equipped) ?? []).map(e => nameOf(e).toLowerCase()));
  const lookAgent = () => agents.find(a => a !== P && !chanting.has(a));
  const manaLog = [];                                       // [t, pm] -- the primary's mana trend
  const slope = () => {
    const now = Date.now(), win = manaLog.filter(([t]) => now - t <= 60_000);
    if (win.length < 3) return null;
    const [t0, m0] = win[0], [t1, m1] = win[win.length - 1];
    return (m1 - m0) / Math.max(1, (t1 - t0) / 1000);
  };
  const bringSeats = async (why) => {
    RUN.seatsIn = true;
    console.log(`  SEATS IN (${why})`);
    for (const s of seatPool.filter(x => !chanting.has(x))) {
      if (chanting.size >= sides) break;
      if (await seatJoin(s, why)) seatJoins++;
    }
  };
  try {
    if (await riftEnchanted(P, Date.now() - 180_000)) { chanting.add(P); joins++; joinedAt = Date.now(); console.log(`  ${P}: already chanting (keeper shows a fresh shadow rift enchantment) -- not casting again`); }
    for (let attempt = 0; attempt < 3 && !chanting.has(P); attempt++) {
      if (await joinOne(P, 'primary')) { joins++; joinedAt = Date.now(); break; }
      const refusal = heard(SAID.noPrism) ?? heard(SAID.badRoom);
      if (refusal) { result = { ok: false, why: 'the server refused the casting place: ' + refusal.text }; break; }
      await sleep(10_000);
    }
    if (!result && !chanting.has(P)) result = { ok: false, why: 'the primary never began to chant' };
    if (!result && plan === 'together') await bringSeats('planned: everyone at once');
    let tick = 0, lastEstAt = Date.now();
    while (!result) {
      tick++;
      if (stopRequested()) { result = { ok: false, why: 'stop file' }; break; }
      if (Date.now() > until) { result = { ok: false, why: `maxMinutes ${p.maxMinutes} ran out` }; break; }
      const since = joinedAt ?? 0;
      const fired = heard(SAID.opened, since) ?? heard(SAID.bound, since);
      if (fired) { result = { ok: true, fired: fired.text }; break; }
      const bad = heard(SAID.loop, since) ?? heard(SAID.targetPortal, since) ?? heard(SAID.repelled, since);
      if (bad) { result = { ok: false, why: `the casting fired and failed: ${bad.text}` }; break; }
      if (heard(SAID.over, since)) {
        chanting.clear(); RUN.estPower = 0;
        if (joins >= 1 + Number(p.spareJoins) || await countOf(call, P, FEATHER_RX) < RIFT.feathersPerJoin) { result = { ok: false, why: 'the chant collapsed (prism darkened) and no re-join is left' }; break; }
        const f = await forecast('after a collapse');
        if (!f.ok && !truthy(p.force)) { result = { ok: false, why: 'the chant collapsed and the forecast says a restart would collapse again -- stopping before more feathers go' }; break; }
        console.log('  the prism darkened with no portal: the stored power is gone -- the primary starts again');
        await sleep(5000);
        if (await joinOne(P, 'primary restart')) { joins++; joinedAt = Date.now(); seatJoins = 0; RUN.seatsIn = false; continue; }
        result = { ok: false, why: 'the chant collapsed and the primary could not re-join' }; break;
      }
      // the charge estimate: every chanter adds its rate each second (conservative: the seats' first ⌊sp/2⌋ ignored)
      const now = Date.now(), dt = (now - lastEstAt) / 1000; lastEstAt = now;
      const spP = Math.max(1, Math.min(99, g.best.sp - g.best.hour + qorBonusAt(now)));
      RUN.estPower += [...chanting].reduce((n, a) => n + riftRate(a === P ? spP : spOf(a)), 0) * dt + (RUN.estPower === 0 ? Math.floor(spP / 2) : 0);
      const ps = await st(P); const pm = vit(ps, 'mana').value;
      if (Number.isFinite(pm)) manaLog.push([now, pm]);
      while (manaLog.length && now - manaLog[0][0] > 120_000) manaLog.shift();
      if (tick % 5 === 0) {
        const eq = new Set((((await call('equipment', { agent: P }, 30_000).catch(() => null))?.equipped) ?? []).map(e => nameOf(e).toLowerCase()));
        const lost = [...eq0].filter(n => !eq.has(n));
        if (lost.length) { console.log(`  WARN the primary's ${lost.join(', ')} came off mid-chant -- that breaks the chant`); log('gear_lost', { lost }); eq0.clear(); for (const n of eq) eq0.add(n); }
        if (keeperBandKnown() && !(await riftEnchanted(P, (joinedAt ?? 0) - 5000)) && chanting.has(P)) { console.log(`  ${P}: the keeper no longer shows the chant`); chanting.delete(P); }
      }
      const la = lookAgent();
      if (la && tick % 4 === 0) { const gl = await lookPrism(call, la, null); lastGlow = gl.glow; }
      // PREDICT THE COLLAPSE: the primary's mana trend (refills included) against the time the charge still needs.
      const sl = slope(), rateNow = [...chanting].reduce((n, a) => n + riftRate(a === P ? spP : spOf(a)), 0) || 1;
      const remaining = Math.max(0, RIFT.needed - RUN.estPower) / rateNow;
      const toEmpty = sl != null && sl < 0 && Number.isFinite(pm) ? pm / -sl : Infinity;
      keep.danger = toEmpty < remaining + Number(p.seatLeadSeconds);
      const charged = !!heard(SAID.charged, since) || (lastGlow >= 3 && RUN.estPower >= RIFT.needed);
      if (tick % 10 === 0) console.log(`  chant: primary mana ${pm} (trend ${sl == null ? '?' : sl.toFixed(2)}/s, empty in ${Number.isFinite(toEmpty) ? Math.round(toEmpty) + ' s' : 'never'}), est power ~${Math.round(RUN.estPower)}/${RIFT.needed} (${Math.round(remaining)} s to go), glow ${lastGlow}, chanting ${[...chanting].join(',')}${keep.danger ? ' -- DANGER: refills go at any donor mana' : ''}`);
      // THE SEATS COME IN: when charged; or EARLY, while the primary still has `seatLeadSeconds` of mana, when the trend says
      // he will run dry before the charge completes -- their joins keep the stored power alive past his exit.
      if (!RUN.seatsIn && (charged || (Number.isFinite(toEmpty) && toEmpty <= remaining && toEmpty <= Number(p.seatLeadSeconds) * 2))) {
        await bringSeats(charged ? 'the prism is charged' : `the primary runs dry in ~${Math.round(toEmpty)} s, the charge needs ~${Math.round(remaining)} s`);
        if (seatJoins < sides - 1) console.log(`  WARN only ${seatJoins} of ${sides - 1} seats are chanting`);
        continue;
      }
      if (RUN.seatsIn && chanting.size < sides && seatJoins < seatPool.length && tick % 6 === 0) await bringSeats('a seat is still missing');
      if (!chanting.has(P) && chanting.size && joins < 1 + Number(p.spareJoins)) { if (await joinOne(P, 'primary re-join')) joins++; continue; }
      await sleep(2000);
    }
  } finally {
    keep.on = false; await Promise.all(donorsP).catch(() => null);
    for (const s of stopEars) await s();
    restoreRole();
  }
  // 11. the world, read back
  const la = agents.find(a => a !== P) ?? P;
  const lk = (await whereIs(call, la)).look;
  const portal = (lk?.objects ?? []).find(o => /portal/i.test(nameOf(o)));
  const gl = await lookPrism(call, la, null);
  const given = touches.reduce((n, t) => n + t.amount, 0);
  const report = { purpose, primary: P, seats: seatPool, plan, joins, seat_joins: seatJoins, touches: touches.length, mana_given: given,
    portal: portal ? { name: nameOf(portal), row: portal.row, col: portal.col } : null, prism_leads_to: gl.dest ?? pl.dest ?? null,
    heard: lines.filter(l => Object.values(SAID).some(rx => rx.test(l.text))).map(l => `${l.agent}: ${l.text}`).slice(-20) };
  log('result', { result, report });
  console.log(`  RESULT ${result?.ok ? 'OK' : 'FAILED'}: ${result?.fired ?? result?.why}; ${touches.length} touches gave ~${given} mana; portal ${report.portal ? 'seen at r' + report.portal.row + 'c' + report.portal.col : 'NOT seen'}; prism leads to ${report.prism_leads_to ?? '?'}. Nobody walks through: the prism stays on the portal square.`);
  // 12. HOLD (the island use): the casters stay in the room to keep the portal open -- confined, no logoffs, survival on.
  if (result?.ok && truthy(p.hold)) {
    for (const a of agents) {
      const r = await call('autopilot', { agent: a, action: 'start', mode: 'survive', farm_strategy: null, assigned_room: room, confine_rooms: [room], roam: false,
        town_trips: false, panic_logoff: false, break_out_via_logoff: false, why: `shadow-rift: hold the portal open in ${room}` }, 60_000).catch(e => ({ error: e.message }));
      console.log(`  HOLD ${a}: confined to ${room}, logoffs off${r?.error ? ' -- FAILED: ' + r.error : ''}`);
    }
    report.hold = { room, agents };
  }
  if (result?.ok && purpose === 'open' && !report.portal) return { ok: false, why: 'the server announced a portal but none is visible in the room', ...report };
  return result?.ok ? { ok: true, ...report } : { ok: false, why: result?.why ?? 'unknown', ...report };
}

function restoreRole() {
  const rr = RUN?.roleRestore;
  if (!rr) return;
  for (const r of rr) { try { setRole(r.agent, r.role); console.log(`  ${r.agent}: cast role restored to ${r.role ?? '(none)'}`); } catch { /* best effort */ } }
  RUN.roleRestore = null;
}
process.once('exit', restoreRole);

// ------------------------------------------------------------------ the script
const LOTS = 8;   // a vault or a shop listing is good for ONE purchase (lots shrink): up to 8 requests per source
export const script = {
  name: 'shadow-rift',
  describe: 'Shadow Rift anywhere: gather the group around the prism, pool feathers/inkies/mushrooms (packs, own vaults, hall, shop), dress one maximised primary, 200 vigor, chant; the rest mystic-touch it and fill the last seats.',
  params: {
    agents:         { type: 'agents', required: true },
    primary:        { type: 'string', default: 'auto', describe: "'auto' (the highest achievable spell power in the room) or an agent id, gathered wherever it stands" },
    room:           { type: 'number', required: true, describe: 'the casting room (must allow player portals: not an inn, hall or other no-combat room; report "Easy rooms")' },
    sides:          { type: 'number', default: 3, describe: 'prism sides when its look cannot be read' },
    openOnly:       { type: 'boolean', default: true, describe: 'refuse an UNBOUND prism (a bind records this spot for ever)' },
    spareJoins:     { type: 'number', default: 1, describe: 'extra primary joins budgeted (4 feathers each)' },
    spareSeats:     { type: 'number', default: 1, describe: 'extra seat casters given 4 feathers, in case a seat cannot join' },
    vigorTarget:    { type: 'number', default: 200 },
    vigorMinutes:   { type: 'number', default: 15 },
    touchMushrooms: { type: 'number', default: 30, describe: 'plain mushrooms per mystic-touch refiller' },
    prefillMinutes: { type: 'number', default: 4 },
    seatRolls:      { type: 'number', default: 2, describe: 'failed shadow rift rolls allowed per seat (15 mana + 20 vigor each)' },
    seatLeadSeconds:{ type: 'number', default: 90, describe: "bring the seats in when the primary's mana trend leaves less than the charge needs plus this" },
    touchAt:        { type: 'number', default: 0.9, describe: 'a donor touches when its own mana is at least this fraction of max (any mana in danger)' },
    touchPct:       { type: 'number', default: 10, describe: "starting estimate of the % of a donor's mana one touch moves (learned per donor)" },
    forecastMargin: { type: 'number', default: 1.1, describe: "the primary's forecast mana must last this many times the charge time" },
    minRate:        { type: 'number', default: 1, describe: 'wait (up to hourWaitMinutes) for a Qor hour giving the primary at least this rate/s' },
    hourWaitMinutes:{ type: 'number', default: 0 },
    force:          { type: 'boolean', default: false, describe: 'cast although the forecast says the chant cannot be sustained' },
    maxMinutes:     { type: 'number', default: 45, describe: 'the ceremony budget' },
    gatherMinutes:  { type: 'number', default: 20, describe: 'how long the ceremony waits for the members still on their way' },
    regatherMinutes:{ type: 'number', default: 5, describe: 'one travel order for a member found outside the room before the join' },
    clusterRadius:  { type: 'number', default: 2, describe: 'squares from its cluster spot beside the prism before a member is walked in' },
    square:         { type: 'string', default: '', describe: 'rNcM: where the prism belongs (a member carrying it drops it there)' },
    prismWaitMinutes:{ type: 'number', default: 10, describe: 'wait for a prism held outside the run to appear on the floor' },
    hold:           { type: 'boolean', default: false, describe: 'after the portal opens, keep every caster in the room: confined, panic/break-out logoffs off' },
    restoreRole:    { type: 'string', default: '', describe: "cast role put back for a member found already tagged 'rift' by a run that died (empty: clear the tag)" },
    qorHour:        { type: 'number', default: -1, describe: 'Qor hour bonus override; -1 reads the game clock' },
    dukeRank:       { type: 'number', default: 1, describe: "a Duke soldier shield's rank (not on the wire): 15 x rank / 10 sp; a supreme hero is 10" },
    orcShield:      { type: 'boolean', default: false, describe: 'fetch an orc shield (+15 Qor) for a NON-soldier primary from vaults/halls; faction soldiers cannot wear one (use dukeRank for a soldier shield)' },
    vaults:         { type: 'boolean', default: true, describe: "draw from members' own vaults (Obert 114 on the mainland, Itzal 2005 on the island)" },
    halls:          { type: 'string', default: '', describe: 'guild halls to draw from, in order, at most two (e.g. 714,703; never on the island); empty for none' },
    enemies:        { type: 'string', default: '', describe: 'comma-separated player names: any of them seen in the casting room stops the run' },
    logDir:         { type: 'string', default: '', describe: 'where the stop / next files and the events log live (default substrate/logs/, or M59_SHADOW_RIFT_LOGS)' },
    minFreeBulk:    { type: 'number', default: 30, describe: "a draw needs this much free bulk in the drawer's pack" },
    mushroomShop:   { type: 'string', default: '', describe: '<room>:<seller> for plain mushrooms (default: by region; none on the island)' },
  },
  async steps(p) {
    const agent = p.agent, room = Number(p.room);
    setLogDir(p.logDir);
    if (!Number.isFinite(room) || room <= 0) throw new Error('shadow-rift needs room=<the casting room number>');
    const plan = () => (RUN?.plan && !RUN.plan.refuse?.length ? RUN.plan : null);
    const draw = src => plan()?.draws?.[agent]?.[src] ?? null;
    const vaultRoom = vaultFor(room)?.room ?? 114, vaultman = vaultFor(room)?.npc ?? "Obert Cair'bre";
    const shopAt = mushroomShopFor(room, p.mushroomShop);
    // REMAINING per source, re-counted after every lot: a lot that sold nothing ends that source.
    const left = { vault: null, shop: null };
    const base = {};
    const linesFor = src => () => {
      const want = left[src] ?? draw(src);
      if (!want) return [];
      return Object.entries(want).filter(([, n]) => n > 0).map(([k, n]) => ({ match: wantsOf(k), amount: Math.min(50, n) }));
    };
    const recount = src => ({ ...verify(async ({ call }) => {
      const want = draw(src);
      if (!want) return true;
      const inv = (await call('inventory', { agent }, 60_000).catch(() => null))?.items ?? [];
      base[src] ??= Object.fromEntries(KINDS.map(k => [k, countIn(inv, wantsOf(k))]));
      const prev = left[src] ?? want;
      left[src] = Object.fromEntries(Object.entries(want).map(([k, n]) => [k, Math.max(0, n - (countIn(inv, wantsOf(k)) - base[src][k]))]));
      // no progress since the last lot: stop asking this source for that kind
      for (const k of Object.keys(left[src])) if (left[src][k] > 0 && left[src][k] === prev[k] && base[src].__seen) left[src][k] = 0;
      base[src].__seen = true;
      return true;
    }, `${src} recount`), optional: true });
    const hallList = parseHalls(p.halls, room);
    let hallBase = null, hallGot = {};
    const hallStillShort = () => {
      const want = draw('hall');
      if (!want) return null;
      const left = Object.fromEntries(Object.entries(want).map(([k, n]) => [k, Math.max(0, n - (hallGot[k] ?? 0))]).filter(([, n]) => n > 0));
      return Object.keys(left).length ? left : null;
    };
    const lots = (src, seller) => Array.from({ length: LOTS }, () => [shop(seller, linesFor(src), { optional: true }), recount(src)]).flat();
    return [
      verify(async ({ call }) => {
        const pl = await planOnce(call, p);
        if (pl.refuse?.length) return { ok: false, why: `refused: ${pl.refuse.join('; ')}` };
        if (!pl.members?.includes(agent)) return { ok: false, why: 'dead or unreadable: left out of this ceremony' };
        if (agent === pl.primary) console.log('  NOTE: liveStart refuses bodies under an operator override hold (m59-jobs.mjs override clear).');
        const d = pl.draws?.[agent];
        console.log(`  ${agent}: ${agent === pl.primary ? 'PRIMARY' : pl.seats.includes(agent) ? 'seat candidate' : 'support'}${pl.refillers.includes(agent) ? ' + mystic touch' : ''}${d ? ' + draws ' + JSON.stringify(d) : ''}`);
        return true;
      }, 'survey and plan'),
      // 1. THE MEMBER'S OWN VAULT (lots shrink; each lot re-counted)
      walk(() => (draw('vault') ? vaultRoom : room), { candidates: [vaultRoom, room], why: 'own vault: shadow rift reagents' }),
      { ...verify(async ({ call }) => {
        if (!draw('vault')) return true;
        const s0 = await call('status', { agent }, 30_000).catch(() => null);
        const free = Number(s0?.carry?.room_for?.bulk ?? NaN);
        if (Number.isFinite(free) && free < Number(p.minFreeBulk)) console.log(`  WARN ${agent}: ${free} free bulk at the vault -- the withdrawals may move nothing`);
        return true;
      }, 'room in the pack'), optional: true },
      recount('vault'),
      ...lots('vault', vaultman),
      // 2. THE GUILD HALLS (mainland), in order, the fetcher only; each draw checks the fetcher's free bulk first and is
      //    verified by count, and the next hall is asked only for what is still short.
      ...hallList.flatMap(h => [
        walk(() => (hallStillShort() ? h : room), { candidates: [h, room], why: `guild hall ${h}: feathers, inky caps` }),
        { ...verify(async ({ call }) => {
          const short = hallStillShort();
          if (!short) return true;
          const s0 = await call('status', { agent }, 30_000).catch(() => null);
          const free = Number(s0?.carry?.room_for?.bulk ?? NaN);
          if (Number.isFinite(free) && free < Number(p.minFreeBulk)) { console.log(`  WARN ${agent}: ${free} free bulk -- skipping hall ${h} (a full pack draws nothing and answers ok)`); return true; }
          const inv0 = (await call('inventory', { agent }, 60_000).catch(() => null))?.items ?? [];
          hallBase ??= Object.fromEntries(KINDS.map(k => [k, countIn(inv0, wantsOf(k))]));
          const wants = Object.entries(short).map(([item, amount]) => ({ item, amount }));
          const r = await hallWithdrawRetrying(call, { agent, wants }, 620_000).catch(e => ({ error: e.message }));
          const inv1 = (await call('inventory', { agent }, 60_000).catch(() => null))?.items ?? [];
          hallGot = Object.fromEntries(KINDS.map(k => [k, countIn(inv1, wantsOf(k)) - hallBase[k]]));
          console.log(`  ${agent}: hall ${h} -> ${JSON.stringify(r?.took ?? r?.error ?? r?.why)}; by count ${JSON.stringify(hallGot)}`);
          return true;
        }, `hall ${h} draw`), optional: true },
      ]),
      // 3. THE SHOP (plain mushrooms for mystic touch)
      walk(() => (draw('shop') && shopAt ? shopAt.room : room), { candidates: [shopAt?.room ?? room, room], why: 'plain mushrooms for mystic touch' }),
      recount('shop'),
      ...(shopAt ? lots('shop', shopAt.seller) : []),
      // 4. GATHER: everyone into the casting room, then beside the prism
      walk(room, { why: 'gather for the shadow rift' }),
      { ...verify(async ({ call }) => {
        if (!RUN?.prism) { const pr = await findPrism(call, [agent], room); if (pr.where === 'ground') RUN.prism = pr.square; }
        return true;
      }, 'where is the prism'), optional: true },
      // 2026-11-20 live: crawl_to alone moved ~1 square / 7 s from across a 73x67 room and three members ground into the NE
      // corner blocking each other (r4-5 c41-42). Walk the routed path to near the spot first; the crawl only finishes it.
      { ...verify(async ({ call }) => {
        const sq = clusterSquare(RUN?.prism, (plan()?.members ?? []).indexOf(agent));
        if (!sq) return true;
        for (let t = 0; t < 2; t++) {
          const r = await call('walk_to', { agent, col: sq.col, row: sq.row, arrive_within: 96, max_steps: 120 }, 120_000).catch(() => null);
          if (r?.arrived) break;
          await sleep(3000);
        }
        return true;
      }, 'walk near the prism'), optional: true },
      { ...{ do: 'crawl_to', col: () => clusterSquare(RUN?.prism, (plan()?.members ?? []).indexOf(agent))?.col ?? null,
             row: () => clusterSquare(RUN?.prism, (plan()?.members ?? []).indexOf(agent))?.row ?? null, room, within: 1 }, optional: true },
      verify(async ({ call }) => {
        RUN.arrived.add(agent);
        const pl = plan();
        if (!pl) return { ok: false, why: 'no plan' };
        // THE CEREMONY RUNS IN THE PRIMARY'S STEP -- or, if the planned primary's own errand ended before it got here,
        // in the first member to reach this step once `gatherMinutes` has passed without him.
        const runner = async () => {
          if (agent === pl.primary) return true;
          const t = Date.now() + Number(p.gatherMinutes) * 60_000;
          while (Date.now() < t && !RUN.arrived.has(pl.primary) && !RUN.runner && !skipWait()) await sleep(5000);
          return !RUN.arrived.has(pl.primary) && !RUN.runner;
        };
        const mine = await runner();
        if (mine && !RUN.runner) RUN.runner = agent;
        if (RUN.runner !== agent) {
          // A DONOR'S BODY STAYS HELD (busy + lease) while the primary's step runs the ceremony.
          const r = await Promise.race([RUN.ceremonyP, sleep((Number(p.gatherMinutes) + Number(p.maxMinutes) + Number(p.vigorMinutes) + Number(p.prefillMinutes) + 30) * 60_000).then(() => ({ ok: false, why: 'the ceremony did not finish' }))]);
          return r?.ok ? true : { ok: false, why: r?.why ?? 'ceremony failed' };
        }
        let out;
        try { out = await ceremony(call, pl, p); }
        catch (e) { out = { ok: false, why: `ceremony threw: ${e.message}` }; restoreRole(); }
        RUN.ceremonyDone(out); RUN.done = true;
        return out;
      }, 'the ceremony'),
    ];
  },
};
