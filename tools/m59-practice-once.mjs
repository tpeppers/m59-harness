// CAST ONE PRACTICE SPELL, HERE, NOW — AND RETURN. The unit a host loop calls between other work.
//
//   import { practiceOnce, SHALILLE_DRILL } from './m59-practice-once.mjs';
//   const r = await practiceOnce({ call, agent: 't3' });    // { cast, spell, outcome, why, retryInMs }
//
// Operator, 2026-09-27, on the guild-hall vault brokers: "Both people managing the service desk are
// idly able to use their mana for disciple training, it restricts their movement, inventory, etc.,
// but requires no mana and both have guild chest access the whole time." So the DESK is the outer
// loop — it owns where the character stands and what its pack holds — and practice owns only the
// mana: one cast whenever no customer is waiting, never a walk, never a wait longer than one cast.
//
// WHAT IT DOES, IN ORDER, AND WHAT IT NEVER DOES:
//   * reads the pack, mana, vigor and the practice spells' abilities (one read each);
//   * eats one inky cap when vigor < 150 (+50 never overshoots 200; vigor is the mana clock and
//     resting stops at 80 — on the drill, caps took a round from ~103 s to ~68 s);
//   * picks ONE spell: among those it has the reagent and the mana for, the LOWEST ability — the
//     gate sums the best three at a level and a low ability improves fastest;
//   * stands (a seated character cannot cast, silently), casts, and judges the outcome by the
//     REAGENT: consumed = the spell ran; a failed roll consumes none and cannot improve anything
//     (spell.kod:1255); refused = the broker or the server said no;
//   * DOES NOT RETURN UNTIL THE CAST HAS RESOLVED — succeeded or fizzled — so nothing the host does
//     next (a move, a sit, a hand-over, another cast) can break the concentration. See TRANCE below;
//   * records a `cast` in the training ledger (m59-training-ledger.mjs) when given one;
//   * returns. It never walks, never rests, never waits for mana: when nothing is castable it says
//     why and how long until it probably is (`retryInMs`), and the host decides.
//
// TARGETS, measured 2026-09-26/27 on prod: holy symbol takes none; detect evil takes ONE — the
// caster — and a caster's own NAME does not resolve while `target: "me"` hits a stranger, so it is
// aimed at the caster's numeric object id, read fresh from /health (ids renumber every save).
// Detect evil is a personal enchantment: re-cast while it is still up, the server takes nothing and
// says little, which reads here as `unknown` rather than as a fizzle.

// TRANCE (operator, 2026-09-27: "shouldn't return before the spell is successfully cast or fizzles,
// so that outside methods don't accidentally break concentrations"). The ORDER in the kod is what
// makes this subtle: UserCast pays the costs FIRST (user.kod:4822 PayCosts — mana AND reagent, or
// "You were unsuccessful in casting %s" with no trance at all) and only THEN begins the trance
// (user.kod:4825). So a reagent that has left the pack means the trance has STARTED, not ended —
// the old check read it 2.5 s after the reply and called that success in the middle of detect
// evil's charge. The trance lasts viCast_time * (150 - spellpower) / 100 (spell.kod:1883-1901),
// at most 1.49x the cast time, and any run, rest, use or second cast inside it breaks it with
// "Your concentration is broken and the %s spell fizzles." So after a cast that got past PayCosts
// this waits until that break is heard OR the longest possible trance has elapsed since the cast
// was sent, and only then reads the pack and returns.
export const TRANCE_MARGIN_MS = 1500;
export const maxTranceMs = castMs => Math.ceil((Number(castMs) || 15_000) * 1.49) + TRANCE_MARGIN_MS;

// A PRACTICE TABLE is data: spell, reagent (as the pack names it) and how many a cast takes, mana,
// and whether it targets the caster. The Shal'ille level-1 drill, read off the kod and the server:
export const SHALILLE_DRILL = Object.freeze([
  { spell: 'holy symbol', reagent: /^elderberry$/i, per: 3, mana: 8, self: false, castMs: 2000, school: "Shal'ille" },  // holysymb.kod:49,61
  { spell: 'detect evil', reagent: /^fairy wing$/i, per: 1, mana: 10, self: true, castMs: 3000, school: "Shal'ille" },   // persench/detevil.kod:52,66
]);

const count = (items, rx) => (items ?? []).filter(i => rx.test(i.name ?? '')).reduce((n, i) => n + (Number(i.amount) || 1), 0);

// THE CHOICE, as a pure function so it can be tested without a server: the castable spell with the
// lowest ability; null (with the reason) when none is castable.
export function choosePractice({ table, abilities, pack, mana }) {
  const rows = table.map(t => ({ ...t, ability: abilities?.[t.spell] ?? null,
    haveReagent: count(pack, t.reagent) >= t.per }));
  const known = rows.filter(r => r.ability != null);
  if (!known.length) return { pick: null, why: 'knows none of the practice spells' };
  const stocked = known.filter(r => r.haveReagent);
  if (!stocked.length) return { pick: null, why: `out of reagents for ${known.map(r => r.spell).join(', ')}`, restock: true };
  const affordable = stocked.filter(r => mana != null && mana >= r.mana);
  if (!affordable.length) {
    const need = Math.min(...stocked.map(r => r.mana));
    return { pick: null, why: `mana ${mana ?? '?'} under the ${need} the cheapest stocked spell costs`, manaShort: need - (mana ?? 0) };
  }
  affordable.sort((a, b) => a.ability - b.ability || a.mana - b.mana);
  return { pick: affordable[0], why: `lowest ability of those castable (${affordable.map(r => `${r.spell} ${r.ability}`).join(', ')})` };
}

export async function practiceOnce({ call, agent, table = SHALILLE_DRILL, ledger = null, eatBelow = 150,
                                     controlUrl = process.env.M59_CONTROL_URL || 'http://127.0.0.1:8901' } = {}) {
  const [inv, st, ab] = await Promise.all([
    call('inventory', { agent }).catch(() => null),
    call('status', { agent }).catch(() => null),
    call('abilities', { agent, kind: 'spells' }).catch(() => null),
  ]);
  if (!Array.isArray(inv?.items) || !st) return { cast: false, why: 'pack or status unreadable', retryInMs: 15_000 };
  const pack = inv.items;
  const vigor = Number(st?.vigor?.value ?? st?.vitals?.vigor?.value ?? NaN);
  if (Number.isFinite(vigor) && vigor < eatBelow && count(pack, /inky/i) > 0)
    await call('act', { agent, verb: 'eat', target: 'Inky-cap mushroom' }).catch(() => null);
  const mana = st?.mana?.value ?? st?.vitals?.mana?.value ?? null;
  const abilities = Object.fromEntries((ab?.spells ?? []).map(s => [String(s.name).toLowerCase(), s.ability ?? null]));
  const c = choosePractice({ table, abilities, pack, mana });
  if (!c.pick) return { cast: false, why: c.why, restock: !!c.restock,
                        retryInMs: c.manaShort ? Math.max(10_000, c.manaShort * 6_000) : 60_000 };
  const t = c.pick;
  let target = null;
  if (t.self) {
    try {
      const h = await (await fetch(`${controlUrl.replace(/\/?$/, '/')}health`, { signal: AbortSignal.timeout(15_000) })).json();
      const id = Number(h?.session_object_ids?.[agent]);
      target = Number.isInteger(id) && id > 0 ? id : null;
    } catch {}
    if (target == null) return { cast: false, spell: t.spell, why: 'own object id unreadable — a self-cast by name does not resolve', retryInMs: 15_000 };
  }
  const before = count(pack, t.reagent);
  await call('rest', { agent, stand: true }).catch(() => null);
  const sentAt = Date.now();
  const r = await call('cast', { agent, spell: t.spell, ...(target != null ? { target } : {}) }).catch(e => ({ error: e.message }));
  const said = [...(r?.messages ?? []), ...(r?.said ?? []), ...(r?.keeper_said?.said ?? [])].map(String);
  let outcome;
  // NO TRANCE: refused, or the chance roll failed inside PayCosts. Nothing is charging.
  if (r?.cast === false || r?.error) outcome = 'refused';
  else if (said.some(m => /unsuccessful in casting/i.test(m))) outcome = 'fizzle';
  else if (said.some(m => /concentration is broken/i.test(m))) outcome = 'broken';
  else {
    // A TRANCE MAY BE CHARGING. Sit it out to the longest it can last, measured from the send —
    // the reply may already have taken that long (the keeper holds still for the cast), in which
    // case this waits nothing.
    const left = sentAt + maxTranceMs(t.castMs) - Date.now();
    if (left > 0) await new Promise(res => setTimeout(res, left));
    const after = await call('inventory', { agent }).catch(() => null);
    outcome = Array.isArray(after?.items) ? (count(after.items, t.reagent) <= before - t.per ? 'success' : 'unknown') : 'unknown';
  }
  await ledger?.record({ kind: 'cast', spell: t.spell, school: t.school, outcome,
                         ...(outcome === 'refused' ? { why: r?.reason ?? r?.error ?? null } : {}) }).catch(() => {});
  return { cast: outcome !== 'refused', spell: t.spell, outcome, why: c.why, resolvedMs: Date.now() - sentAt, retryInMs: 0 };
}
