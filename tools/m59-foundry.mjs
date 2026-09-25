// m59-foundry — MAKE THE WEAPON THE RAID WANTS WITH `create weapon`, BY CHOOSING THE SPELL POWER.
//
// create weapon (creaweap.kod, Kraanan, level 1, 15 mana, no reagents) rolls random(P/3, P) on
// the caster's spell power P and hands over, by the roll:
//
//     < 20 mace   < 30 short sword   < 45 HAMMER   < 60 axe   < 75 long sword   < 95 scimitar   else mystic sword
//
// and the weapon lasts 2 x P minutes (GetDuration). A made weapon CAN be dedicated — the IA_MADE
// attribute does not override ItemCanEnchant (itematt.kod:233).
//
// P for a Kraanan spell (spell.kod GetSpellPower) is  ability/2  +  min(30, ACTIVE OBJECTS IN THE
// ROOM)  +  min(10, health x 10 / max)  + shrine, faction and item bonuses. This fleet knows the
// spell at 80-99, so ability alone is 40-50; standing with twenty raiders adds the full 30 and a
// healthy body 10 more, P ~ 85, and the roll lands on a hammer about a quarter of the time — the
// rest is axes, long swords and scimitars, which is where every pack's twenty long swords came
// from. Alone and a little hurt P ~ 45, and the roll is a hammer or a mace about two times in
// three. The operator's observation: step out of the room (or log off) and the hammers come.
//
// So a caster here COUNTS the bodies where it stands, estimates P, and casts in whichever candidate
// room brings P closest to the hammer band; keeps a hammer or a mace; drops every miss (a spare,
// un-earmarked weapon — m59-inventory makeRoom's rule); rests for mana between casts. Every cast is
// logged with its estimate and what came out, so the model above gets checked against the server
// rather than trusted.
import { call, castVerified, observe } from './m59-fleetscript.mjs';
import { freshItems, freshLook, walkRoom } from './m59-inventory.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lower = s => String(s ?? '').toLowerCase().trim();

export const CREATE_WEAPON = Object.freeze({ spell: 'create weapon', mana: 15 });
/** The roll bands, lowest first: [upper bound (exclusive), weapon]. creaweap.kod:66-107. */
export const BANDS = Object.freeze([[20, 'mace'], [30, 'short sword'], [45, 'hammer'], [60, 'axe'],
                                    [75, 'long sword'], [95, 'scimitar'], [Infinity, 'mystic sword']]);
export const BLUNT = /^(hammer|mace)$/i;
export const isWeaponOut = n => BANDS.some(([, w]) => w === lower(n));

/** The Kraanan spell power, without the shrine/faction/item terms we cannot read. */
export function spellPowerEstimate({ ability = 0, active = 0, health = 1, maxHealth = 1 } = {}) {
  const base = Math.floor(ability / 2);
  const primary = Math.max(0, Math.min(30, active));
  const secondary = Math.max(0, Math.min(10, Math.floor((health * 10) / Math.max(1, maxHealth))));
  return base + primary + secondary;
}

/** random(P/3, P) is uniform over integers; -> { weapon: probability }. */
export function outcomeOdds(P) {
  const lo = Math.floor(P / 3), hi = Math.max(lo, P), n = hi - lo + 1;
  const out = {};
  for (let r = lo; r <= hi; r++) {
    const w = BANDS.find(([ub]) => r < ub)[1];
    out[w] = (out[w] ?? 0) + 1 / n;
  }
  return out;
}
export const bluntOdds = P => { const o = outcomeOdds(P); return (o.hammer ?? 0) + (o.mace ?? 0); };
/** Minutes a weapon made at P lasts (creaweap.kod GetDuration). */
export const lifetimeMin = P => 2 * P;

/** Active bodies where the agent stands: everything attackable, and itself. */
export async function activeHere(agent) {
  const l = await call('look', { agent }, 40_000).catch(() => null);
  const n = (l?.objects ?? []).filter(o => o.is_player || (o.can ?? []).includes('attack')).length;
  return { room: Number(l?.room?.num ?? l?.room ?? NaN), active: n + 1 };
}

export async function abilityOf(agent, spell = CREATE_WEAPON.spell) {
  const a = await call('abilities', { agent }, 40_000).catch(() => null);
  return Number((a?.spells ?? []).find(s => lower(s.name) === spell)?.ability ?? NaN);
}

/**
 * FORGE until a blunt weapon is in the pack or the deadline passes.
 *   rooms: candidate rooms to cast in (the first is where the agent returns to)
 *   want:  RegExp of what to keep (default hammer|mace)
 * Returns { ok, got?, casts: [{room, active, P, odds, got, kept}], why? }.
 */
export async function forge(agent, { rooms = [], want = BLUNT, deadline = Date.now() + 20 * 60_000,
                                     restMana = true, log = console.log } = {}) {
  const ability = await abilityOf(agent);
  if (!Number.isFinite(ability)) return { ok: false, why: 'does not know create weapon', casts: [] };
  const casts = [];
  const home = rooms[0] ?? Number((await observe(agent)).room);
  const have = async () => (await freshItems(agent)).find(i => want.test(String(i.name ?? '').trim()));
  const already = await have();
  if (already) return { ok: true, got: already.name, casts, already: true };
  // WHERE TO CAST: stand in each candidate, count the bodies, estimate P; cast in the best.
  const measure = async () => {
    const st = await call('status', { agent, brief: true }, 30_000).catch(() => null);
    const { room, active } = await activeHere(agent);
    return { room, active, P: spellPowerEstimate({ ability, active, health: st?.health?.value ?? 1, maxHealth: st?.health?.max ?? 1 }) };
  };
  let best = null;
  for (const r of rooms.length ? rooms : [home]) {
    if (Number((await observe(agent)).room) !== Number(r) && !(await walkRoom(agent, Number(r))).ok) continue;
    const m = await measure();
    if (!best || bluntOdds(m.P) > bluntOdds(best.P)) best = m;
  }
  if (best && Number((await observe(agent)).room) !== best.room) await walkRoom(agent, best.room);

  while (Date.now() < deadline) {
    const st = await call('status', { agent, brief: true }, 30_000).catch(() => null);
    if ((st?.mana?.value ?? 0) < CREATE_WEAPON.mana) {
      if (!restMana) break;
      await call('rest', { agent }, 30_000).catch(() => {});
      await sleep(10_000);
      continue;
    }
    await call('rest', { agent, stand: true }, 30_000).catch(() => {});
    const { room, active } = await activeHere(agent);
    const P = spellPowerEstimate({ ability, active, health: st?.health?.value ?? 1, maxHealth: st?.health?.max ?? 1 });
    const before = new Set((await freshItems(agent)).map(i => i.id));
    const r = await castVerified(agent, CREATE_WEAPON.spell, { cost: CREATE_WEAPON.mana });
    const made = (await freshItems(agent)).filter(i => !before.has(i.id) && isWeaponOut(i.name));
    const got = made[0]?.name ?? null;
    const kept = !!got && want.test(got);
    casts.push({ t: Date.now(), room, active, ability, P, blunt_odds: Number(bluntOdds(P).toFixed(2)), got,
                 kept, outcome: r.outcome ?? (r.landed ? 'landed' : null) });
    log(`  ${agent} forge: P~${P} (ability ${ability}, ${active} here) -> ${got ?? 'nothing'}${kept ? ' KEPT' : ''}`);
    if (kept) {
      if (room !== home) await walkRoom(agent, home);
      return { ok: true, got, P, lifetime_min: lifetimeMin(P), casts };
    }
    // A miss is a spare weapon nobody earmarked: it goes on the floor, not into a full pack.
    for (const m of made) await call('act', { agent, verb: 'drop', target: m.id }, 30_000).catch(() => {});
  }
  if (Number((await observe(agent)).room) !== home) await walkRoom(agent, home);
  return { ok: false, why: 'no blunt weapon before the deadline', casts };
}
