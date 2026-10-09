// PVP GEAR: ITEMS A CHARACTER WEARS ONLY TO FIGHT PEOPLE, AND THE WANDS IT FIRES TOGETHER.
//
//   substrate/pvp-gear-<fleet>.json   (this machine's; gitignored -- an order, not a mechanic)
//   {
//     "format": "m59-pvp-gear/1",
//     "items":  ["shield of", "plate armor"],        // name substrings: worn ONLY in a PvP fight
//     "wands":  [{ "match": "lightning wand", "timer": true },
//                { "match": "vampiric shock", "timer": false }],
//     "volley_ms": 2000
//   }
//
// WHY TWO LISTS. Armour and shields are WORN: they go on when a PvP fight starts and come off when
// it ends, and farming must never pick them as its "best" piece (skills.armourOf / weaponRanking
// skip them unless the client is in a PvP fight). Wands are never worn -- a wand is fired from the
// PACK with BP_REQ_APPLY(wand, target) (player.kod TryApplyItem requires only IsHolding).
//
// THE TWO WANDS ARE DIFFERENT MACHINES, which is why each carries `timer`:
//   * lightning wand (Wand is SpellItem, SID_LIGHTNING_BOLT). It goes through the spell's
//     CanPayCosts, so it shares the character's ATTACK TIMER: 2s post-cast (lightnin.kod:45), and a
//     zap within that of a melee swing is refused "You point your wand but nothing happens" with no
//     charge spent. It also needs line of sight and a rough facing. 4-9 charges; deleted at 0.
//   * wand of vampiric shock (SpecialWand, vampwand.kod). No attack timer, no line of sight, no
//     facing: same room only. 10-18 charges, decremented BEFORE the effect; at 0 it is BROKEN, not
//     deleted, and every later apply is refused. Each zap heals the user and pushes its karma
//     toward -80.
// So a character holding a lightning wand does not swing between volleys (a swing would eat the
// next zap); one holding only a vampiric wand keeps swinging and zaps on the beat as well.
//
// THE BEAT. Every keeper is a process on the same machine, so the wall clock is shared: firing on
// floor(now / volley_ms) puts every character in the fight on the same 2-second beat without any
// messaging. Unidentified wands are all named just "wand" (wand.kod:19), so a wand must be
// identified before it matches here -- the operator hands out identified ones.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName } from './m59-fleetpath.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..', '..');

export const DEFAULT_PVP_GEAR = Object.freeze({
  format: 'm59-pvp-gear/1',
  items: [],
  wands: [{ match: 'lightning wand', timer: true }, { match: 'vampiric shock', timer: false }],
  volley_ms: 2000,
  expect_incoming: [],
  accept_if_missing: [],
  warband_buffs: {},
  warband_rebuff_ms: 180_000,
  keepoff_waiters: 2,
  keepoff_ms: 3 * 60 * 60_000,
  keepoff_rush: true,
});

export const PVP_GEAR_FILE = () => {
  if (process.env.M59_PVP_GEAR_FILE) return process.env.M59_PVP_GEAR_FILE;
  let name = null;
  try { name = fleetName(); } catch { name = null; }
  return join(HERE, 'substrate', name ? `pvp-gear-${name}.json` : 'pvp-gear.json');
};

let cache = { key: null, value: DEFAULT_PVP_GEAR, checked: 0 };
/** The config, mtime-cached and re-stat'ed at most every 2s. A file that will not parse keeps the last good one. */
export function pvpGearConfig() {
  const file = PVP_GEAR_FILE(), now = Date.now();
  if (cache.file === file && now - cache.checked < 2000) return cache.value;
  cache.checked = now; cache.file = file;
  let mtime = 0;
  try { mtime = existsSync(file) ? statSync(file).mtimeMs : 0; } catch { mtime = 0; }
  if (cache.key === mtime) return cache.value;
  cache.key = mtime;
  if (!mtime) { cache.value = DEFAULT_PVP_GEAR; return cache.value; }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    cache.value = {
      ...DEFAULT_PVP_GEAR,
      items: Array.isArray(raw.items) ? raw.items.map(String).filter(Boolean) : DEFAULT_PVP_GEAR.items,
      wands: Array.isArray(raw.wands) ? raw.wands.filter(w => w?.match).map(w => ({ match: String(w.match), timer: w.timer !== false }))
                                      : DEFAULT_PVP_GEAR.wands,
      volley_ms: Number(raw.volley_ms) >= 1000 ? Number(raw.volley_ms) : DEFAULT_PVP_GEAR.volley_ms,
      expect_incoming: Array.isArray(raw.expect_incoming) ? raw.expect_incoming.map(String).filter(Boolean) : [],
      accept_if_missing: Array.isArray(raw.accept_if_missing) ? raw.accept_if_missing.map(String).filter(Boolean) : [],
      // WARBAND BUFFS: { "<agent>": ["bless", "super strength"] } -- each named buffer keeps every
      // warband ally in its room (and itself) buffed while the swarm is on.
      warband_buffs: raw.warband_buffs && typeof raw.warband_buffs === 'object' ? raw.warband_buffs : {},
      warband_rebuff_ms: Number(raw.warband_rebuff_ms) >= 30_000 ? Number(raw.warband_rebuff_ms) : 180_000,
      // THE KEEP-OFF LOCK (tools/m59-keepoff.mjs): how many wait at a logged-off target's ghost, how
      // long the lock lasts, and whether every idle swarm character rushes his login.
      keepoff_waiters: Number.isSafeInteger(raw.keepoff_waiters) && raw.keepoff_waiters >= 0 ? raw.keepoff_waiters : 2,
      keepoff_ms: Number(raw.keepoff_ms) >= 60_000 ? Number(raw.keepoff_ms) : 3 * 60 * 60_000,
      keepoff_rush: raw.keepoff_rush !== false,
      swarm_leader_files: Array.isArray(raw.swarm_leader_files) ? raw.swarm_leader_files.map(String).filter(Boolean) : [],
    };
  } catch { /* keep the last good value */ }
  return cache.value;
}

const has = (name, pat) => String(name ?? '').toLowerCase().includes(String(pat).toLowerCase());

// AN UNIDENTIFIED WAND CAN STILL BE NAMED FROM THE WIRE. Until identified every `Wand` subclass is
// called just "wand" (wand.kod:19 HideHiddenAttributes hides the NAME only) and shares one icon,
// wand6.bgf -- but each keeps its own palette translation, which the server sends per object and
// m59-parse.mjs extracts as `translation`. Among everything named "wand" on the wand6 icon:
//   LightningWand  viColor = XLAT_TO_YELLOW (0x08)   lightngw.kod:28   <- the only yellow one
//   IdentifyWand   XLAT_TO_BLUE (0x06); the Qor wands gray; brittle/shatter orange; forget,
//   dement, slither, seduce purple; purify, hospice sky; mark of dishonor red; SpellWand (the
//   SpecialWand fireball, also named "wand") red.
// So a "wand" whose translation is 0x08 is a lightning wand, and in particular is NOT a wand of
// identification. The wand of vampiric shock always shows its own name (vampwand.kod, wand3.bgf).
export const XLAT_TO_YELLOW = 0x08;
export const UNIDENTIFIED_SIGNATURES = Object.freeze([
  { as: 'lightning wand', name: 'wand', translation: XLAT_TO_YELLOW },
]);

/**
 * The name this item should be treated as: its own, or what its wire signature proves it is.
 *
 * KNOWN GAP, LEFT AS SHIPPED ON PURPOSE (2026-10-06). The wire does not carry viColor: it carries
 * EncodeTwoColorXLAT(viColor, label) = XLAT_BASE_VALUE + 11*primary + label (spelitem.kod:145,
 * util.kod:271), so a lightning wand arrives as 223 and the raw comparison with 8 below matches
 * no real wand. Correcting it here would start the whole fleet firing unidentified lightning
 * wands at the next deploy, which is a fleet's rollout decision, not a mechanic. So the decoded
 * reading is offered to the private `pvpWand` strategy instead (ctx.unidentified, built from
 * `unidentifiedWandsIn` below), and the operator turns it on where and for whom they choose.
 */
export function effectiveName(c, o) {
  const name = String(c.rsc?.get?.(o.nameRsc) ?? o.name ?? '');
  const bare = name.trim().toLowerCase();
  for (const sig of UNIDENTIFIED_SIGNATURES)
    if (bare === sig.name && Number(o.translation) === sig.translation) return sig.as;
  return name;
}

// THE DECODER, as util.kod DecodePrimaryColor. Pure; used by the shadow import
// (m59-shadow-fidelity.mjs) and by `unidentifiedWandsIn`.
export const XLAT_BASE_VALUE = 0x87;
/** The primary colour of an encoded wire translation; null when none was sent or it is not an encoding. */
export function decodePrimaryColour(encoded) {
  const x = Number(encoded);
  if (!Number.isFinite(x) || x <= 0) return null;          // 0 / absent: no translation was sent
  if (x > 120 && x < 125) return 0x0B;                      // XLAT_TO_DGREEN, skin-paired
  if (x > 124 && x < 128) return 0x0C;                      // XLAT_TO_BLACK, skin-paired
  if (x < XLAT_BASE_VALUE) return null;                     // not a two-colour encoding
  return Math.floor((x - XLAT_BASE_VALUE) / 11);
}

/** Bare "wand" rows in the pack, with their decoded colour. A spent id is skipped. */
export function unidentifiedWandsIn(c, { spent = new Set() } = {}) {
  return (c.inventory ?? [])
    .filter(o => !spent.has(o.id) && nameOf(c, o).trim().toLowerCase() === 'wand')
    .map(o => ({ o, id: o.id, translation: Number(o.translation) || 0, colour: decodePrimaryColour(o.translation) }));
}

/** Is this item one the character wears ONLY in a PvP fight? */
export const isPvpOnly = (name, cfg = pvpGearConfig()) => !!name && cfg.items.some(p => has(name, p));

const nameOf = (c, o) => c.rsc?.get?.(o.nameRsc) ?? o.name ?? '';

/** PvP-only items in the pack, with whether each is worn now. */
export function pvpItemsIn(c, cfg = pvpGearConfig()) {
  const worn = c.using ?? new Set();
  return (c.inventory ?? []).map(o => ({ o, name: nameOf(c, o) }))
    .filter(r => isPvpOnly(r.name, cfg)).map(r => ({ ...r, worn: worn.has(r.o.id) }));
}

/** Volley wands in the pack, in config order (so a lightning wand is preferred when listed first). */
export function volleyWandsIn(c, { spent = new Set(), cfg = pvpGearConfig() } = {}) {
  const out = [];
  for (const w of cfg.wands) for (const o of c.inventory ?? []) {
    const name = effectiveName(c, o);
    if (!spent.has(o.id) && has(name, w.match) && !out.some(x => x.o.id === o.id))
      out.push({ o, name, timer: w.timer });
  }
  return out;
}

export const beatOf = (now, ms = pvpGearConfig().volley_ms) => Math.floor(now / ms);

// THE VOLLEY DECISION, SEPARATED FROM THE PACKETS. What a character does with its wands each
// tick of a PvP fight is a fleet's bet, not a mechanic: which wand, whether to hold the swing,
// when to give up on a target that keeps refusing. So CombatMode.wandVolley asks an enabled
// private strategy answering `pvpWand` first (substrate/strategies/, m59-strategies.mjs), and
// falls back to `chooseWandVolley` below when there is none, it declines, it throws, or its
// answer does not check out. No strategies directory is exactly the behaviour shipped before
// the seam existed.
//
//   ctx (built by CombatMode.wandContext; plain data, safe to keep):
//     { character, now, volley_ms, beat, lastVolleyBeat, lastFireAt,
//       wands:  [{ id, name, timer }],               // live volley wands, config order, spent ones gone
//       unidentified: [{ id, translation, colour }], // bare "wand" rows, colour DECODED (8 = yellow,
//                                                    // lightning); a strategy may fire one by id
//       target: { id, name, player, row, col, dist },
//       me:     { row, col, hp, max_hp },
//       shots:  [{ at, wand, refused }],              // this fight, oldest first, at most SHOT_HISTORY
//       pvp, warband, room }
//
//   answer: { fire: <wand id> | null, hold: boolean, face: boolean, why?: string }
//     fire  the wand to apply at the target now, or null for no zap this tick
//     hold  true = reserve the attack timer from melee; blocked wand sight still approaches
//     face  turn to the target before the zap (a lightning wand needs rough facing)
//   The harness enforces sight, facing and the actual shared cooldown at send time,
//   including for decoded lightning selected privately. ctx.readiness reports
//   ready, positioned, reason, los, distance and timer_remaining_ms. Strategies
//   choose the wand; hold cannot suppress the movement required to fire it.
//
// `refused` on a shot is set when "You point your wand but nothing happens" arrives after it:
// the server refused the bolt (attack timer, line of sight, a no-combat room, a resist) and
// spent no charge. See m59-research reports/lightning-wand.md for every refusal path.
export const SHOT_HISTORY = 20;

/** The built-in answer: one zap per wall-clock beat, best wand first, hold while a timer wand is carried. */
export function chooseWandVolley(ctx) {
  const wands = ctx?.wands ?? [];
  if (!wands.length) return { fire: null, hold: false, face: false, why: 'no volley wand' };
  const hold = wands.some(w => w.timer);
  if (ctx.beat === ctx.lastVolleyBeat) return { fire: null, hold, face: false, why: 'this beat already fired' };
  const pick = wands[0];
  return { fire: pick.id, hold, face: !!pick.timer, why: 'on the beat' };
}

/**
 * A strategy's answer, checked before anything is sent. Returns the answer normalised, or
 * { invalid: why } -- and the caller then uses the built-in decision, because an answer that
 * names a wand the character does not hold must not turn into a packet.
 */
export function checkWandAnswer(answer, ctx) {
  if (!answer || typeof answer !== 'object') return { invalid: 'answer is not an object' };
  const fire = answer.fire ?? null;
  if (fire !== null && ![...(ctx?.wands ?? []), ...(ctx?.unidentified ?? [])].some(w => w.id === fire))
    return { invalid: `fire names ${fire}, which is not a live volley wand or an unidentified wand in the pack` };
  if (answer.hold !== undefined && typeof answer.hold !== 'boolean') return { invalid: 'hold is not a boolean' };
  if (answer.face !== undefined && typeof answer.face !== 'boolean') return { invalid: 'face is not a boolean' };
  return { fire, hold: !!answer.hold, face: !!answer.face, why: answer.why == null ? null : String(answer.why) };
}

// THE SWARM LEADER'S TARGET, as m59-proxy.mjs writes it from the operator's own REQ_ATTACK:
// { target: <object id>, how, at, room_object_id, player_object_id }. The proxy writes into ITS
// checkout's substrate/, so run the terminal from the checkout the keepers run from, or point
// both at one file with M59_SWARM_LEADER_FILE.
export const SWARM_LEADER_FILE = () => process.env.M59_SWARM_LEADER_FILE || join(HERE, 'substrate', 'swarm-leader.json');
// THE TERMINAL MAY RUN FROM ANOTHER CHECKOUT. The proxy writes swarm-leader.json into ITS repo's
// substrate/, and the fleet terminal is usually started from the mindmap checkout while the
// keepers run from the deploy -- so the config may list more files (`swarm_leader_files`, read
// live), and the freshest `at` among them wins.
const leaderFiles = () => [...new Set([SWARM_LEADER_FILE(), ...(pvpGearConfig().swarm_leader_files ?? [])])];
let leaderCache = { value: null, checked: 0, mtimes: '' };
export function readSwarmLeader() {
  const now = Date.now();
  if (now - leaderCache.checked < 150) return leaderCache.value;
  leaderCache.checked = now;
  const files = leaderFiles();
  const mtimes = files.map(f => { try { return existsSync(f) ? statSync(f).mtimeMs : 0; } catch { return 0; } });
  const key = mtimes.join(',') + '|' + files.join(',');
  if (key === leaderCache.mtimes) return leaderCache.value;
  leaderCache.mtimes = key;
  let best = null;
  files.forEach((f, i) => {
    if (!mtimes[i]) return;
    try { const v = JSON.parse(readFileSync(f, 'utf8')); if (!best || Number(v?.at) > Number(best.at)) best = v; } catch {}
  });
  leaderCache.value = best;
  return leaderCache.value;
}

// EXPECTED INCOMING: what a character should accept when somebody hands it over, without asking.
// The operator's rule, 2026-09-30: "always accept being handed anything from the PVP gear list (or
// any expected incoming list), with the remaining elements from the PvP gear list always expected
// unless already carried" -- so the operator can offer a character its kit and it takes it.
//   * every PvP item and volley wand the character is NOT already carrying (a pattern already
//     satisfied by something in the pack is not expected again: one shield, one lightning wand);
//   * everything in the config's `expect_incoming` list, always.
export function expectedIncoming(c, { cfg = pvpGearConfig() } = {}) {
  const carried = (c?.inventory ?? []).map(o => effectiveName(c, o));
  // `accept_if_missing`: ordinary gear (not PvP-only -- farming wears it too) that a character
  // should still take when it has none, e.g. a shield.
  const missing = [...cfg.items, ...cfg.wands.map(w => w.match), ...(cfg.accept_if_missing ?? [])]
    .filter(p => !carried.some(n => has(n, p)));
  return [...new Set([...missing, ...(cfg.expect_incoming ?? [])])];
}

/**
 * Is every item in this offer expected? Offered items are {name, translation?} as the trade
 * window reports them; an unidentified yellow "wand" counts as the lightning wand it must be.
 */
export function offerIsExpected(c, offered, { cfg = pvpGearConfig() } = {}) {
  if (!offered?.length) return false;
  const expected = expectedIncoming(c, { cfg });
  const as = i => effectiveName({ rsc: { get: () => i.name } }, { nameRsc: 0, translation: i.translation });
  return offered.every(i => expected.some(p => has(as(i), p)));
}
