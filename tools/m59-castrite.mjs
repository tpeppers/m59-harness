// CAST RITES: WARM-UP AND WARM-DOWN AROUND A SPELL. Stash what is worn, dress for the spell, cast,
// wait out the trance, pop the stash.
//
// The operator, 2026-10-16: "add the ability to interject and say if casting (spell) we want to do
// certain warm-up / warm-down activities before/after the spell cast. That functionality needs to
// be in the harness, and overridable from a private strategy repository." And then: characters
// tagged as MAGES "stash the current equipped things, equip/unequip whatever to maximize their spell
// casting power, cast the spell, then pop the stash ... for all spells when casting".
//
// PUBLIC FRAMEWORK, PRIVATE POLICY (operator, 2026-10-16): the extension points live here and do
// NOTHING by themselves; what to wear for a spell, who is a mage, which weapon a caster prefers, when
// a robe may be worn -- all of it is a private strategy's (ours: m59-private strategy/strategies/
// cast-gear.mjs). With no strategy answering, `withCastRite` calls `send()` and nothing else, exactly
// as the call site did before it was wrapped, whatever any character is tagged.
//
//   facts      m59-spellpower.mjs (each item's slot, hands and spellpower modifier, from the kod),
//              m59-trance.mjs (how long a spell charges, and what breaks it)
//   mechanics  m59-spellgear.mjs (legal hands, the fewest packets between two gear states, role tags)
//   engine     THIS FILE: asks, dresses, casts, waits out the trance, pops the stash
//   policy     a strategy in substrate/strategies/ answering `castRite` and/or `idleGear`
//
// THE HOOKS
//
//   castRite(ctx) -> null | { skip: true } | {
//     wear:     { weapon?, shield?, armour?, helm? }   the TARGET per slot: an item id, or null for
//               empty; a slot left out is left alone. The engine finds the fewest legal packets.
//     steps:    [{ equip: <item> } | { unequip: <item> }, ...]   OR explicit packets, in order
//     restore:  'after' (default) | 'linger' | 'never'
//     linger_ms: with 'linger', how long after the LAST rite cast to keep the gear on
//     while_fighting: with 'linger', also keep it on while a combat order is active
//     why:      a sentence, kept in the record
//   }
//   ctx = castRiteContext: the spell (catalogue row: school, level, trance), the character's role tag
//   (substrate/cast-roles.json; meaningless to the engine), whether this is a PvP cast, the room (and
//   whether it is an inn), whether the keeper owns the hands right now (touch training, the roulette),
//   and every carried item with its slot, hands, grade, curse/broken marks and its spellpower modifier
//   FOR THIS SPELL.
//
//   idleGear(ctx) -> null | { steps: [...], forbid: [<pattern>...], prefer_weapons: [<pattern>...], why }
//   Asked on every room change and every few seconds of a keeper pass, whenever no rite is in progress,
//   no trance is charging and no fight is on. `forbid` is excluded from wearBest; `prefer_weapons` is
//   ranked first by weaponRanking (after its magic-first rule) until the next answer.
//
// THE STASH IS RESTORED BY SLOT, NOT BY UNDO. What was worn in the hands, on the body and on the
// head before the first cast of a rite is the target of the pop, and m59-spellgear transitionSteps
// gets there in the fewest legal packets (a use replaces the incumbent; a bow's two hands are freed
// explicitly). A second cast inside a lingering rite re-plans from what is worn now and keeps the
// FIRST stash, so the pop puts back the fighting gear, never the robe.
//
// GEAR IS NEVER CHANGED DURING A TRANCE. Using or unusing an item raises EVENT_USE, which fizzles a
// charging spell (user.kod:4619, :4643), and the Pacer drops `use` while concentration is held. So
// the dressing finishes before the cast, and the pop waits until the Pacer lets go. While a rite is
// open the keeper's own equipBest/wearBest stand down (s._rite), so they cannot undress a caster
// between its costume and its cast.
//
// AS FAST AS THE SERVER ALLOWS. Five packets per wall-clock second (user.kod:883); the Pacer spaces
// every packet 200ms. Rite packets are sent URGENT -- ahead of queued movement, behind nothing but an
// attack or cast already waiting -- one after another without waiting for each echo, because the
// server processes one socket's packets in order and the cast arrives after them all.
import { spellInfo, tranceMs } from './m59-trance.mjs';
import { isDiscipleRobe, itemSpellModifier, itemSlot, itemHands, robeSchoolFromLook, normSchool }
  from './m59-spellpower.mjs';
import { castRole, gearCandidates, transitionSteps, slotState, wornState, legalHands }
  from './m59-spellgear.mjs';
import { CITY_INNS } from './m59-underworld.mjs';

export const RITE_HOOKS = Object.freeze(['castRite', 'idleGear']);
export const IDLE_EVERY_MS = 10_000;
export const ROBE_LOOK_EVERY_MS = 30_000;
export const VERIFY_MS = 1200;
const INN_ROOMS = new Set(Object.values(CITY_INNS).map(x => x.inn));

const equipped = (c) => (c?.using instanceof Set ? c.using : null);
const itemName = (c, o) => String(c?.rsc?.get?.(o?.nameRsc) ?? o?.name ?? '');
const now = () => Date.now();

function resolveSpell(c, spell) {
  if (spell == null) return null;
  const list = c?.spells ?? [];
  const nameOf = sp => String(sp?.name ?? c?.rsc?.get?.(sp?.nameRsc) ?? '').toLowerCase();
  let sp = null;
  if (typeof spell === 'object') sp = spell;
  else if (typeof spell === 'number' || /^\d+$/.test(String(spell))) sp = list.find(x => Number(x.id) === Number(spell)) ?? { id: Number(spell) };
  else sp = list.find(x => nameOf(x) === String(spell).trim().toLowerCase()) ?? { name: String(spell) };
  const name = nameOf(sp) || null;
  const row = name ? spellInfo(name) : null;
  return Object.freeze({ id: sp.id ?? null, name, school: row?.school_name ?? null, level: row?.level ?? null,
    mana: row?.mana ?? null, cast_time_ms: row?.cast_time_ms ?? 0, trance_max_ms: name ? tranceMs(name) : 0 });
}

/** The wearer's highest known spell level in a school (the robe's piLevel, robedisc.kod:203). */
export function schoolLevel(c, school) {
  if (!school) return 0;
  let best = 0;
  for (const sp of c?.spells ?? []) {
    const row = spellInfo(sp?.name ?? c?.rsc?.get?.(sp?.nameRsc));
    if (row && normSchool(row.school_name) === normSchool(school) && Number(row.level) > best) best = Number(row.level);
  }
  return best;
}

function robeSchoolOf(s, id, name) {
  const hit = s?._robeSchools?.get(id);
  return hit && hit.name === name ? hit.school : null;
}

// The marks m59-skills keeps, read here without importing it (it imports this file): a curse by name
// or by the keeper's own record (isCursedItem), a broken weapon (brokenSet), an identified magic grade
// (isMagicGrade: kept, never worn -- operator, 2026-09-27).
function marks(c, o, name) {
  const rarity = o?.rarity == null ? null : Number(o.rarity);
  const cursed = /\bcursed\b/i.test(name) || rarity === 200 || (rarity !== 0 && !!c?._cursedItemIds?.has?.(o.id));
  return { rarity, cursed, broken: !!c?._brokenWeapons?.has?.(o.id), magic: [1, 2, 4].includes(rarity) && (Number(o.amount) || 1) <= 1 };
}

/** What a strategy is shown. Frozen: a strategy answers, it does not reach in. */
export function castRiteContext(s, phase, { spell = null, pvp = null, why = null, targets = null } = {}) {
  const c = s?.client;
  const using = equipped(c) ?? new Set();
  const room = s?.world?.room ?? null;
  const items = (c?.inventory ?? []).map(o => {
    const name = itemName(c, o);
    const robeSchool = isDiscipleRobe(name) ? robeSchoolOf(s, o.id, name) : null;
    return Object.freeze({
      id: o.id, name, equipped: using.has(o.id), amount: o.amount ?? 1,
      slot: itemSlot(name), hands: itemHands(name), ...marks(c, o, name),
      disciple_robe: isDiscipleRobe(name), robe_school: robeSchool, school_level: schoolLevel(c, robeSchool),
      spell_modifier: itemSpellModifier(name, { spellSchool: spell?.school ?? null, robeSchool,
                                                schoolLevel: schoolLevel(c, robeSchool) }),
    });
  });
  const worn = items.filter(i => i.equipped);
  let gear = worn.reduce((n, i) => n + i.spell_modifier, 0);
  if (gear < 0 && normSchool(spell?.school) === 'kraanan') gear = Math.trunc(gear / 2);
  // The keeper may own the hands for something else: an empty hand for touch-spell training
  // (s.equipVeto), one named weapon for the training roulette (s.equipOnly). A hook that throws locks nothing.
  let handsLocked = false;
  try { handsLocked = !!(s?.equipVeto?.() || s?.equipOnly?.()); } catch { handsLocked = false; }
  return Object.freeze({
    phase, why, agent: s?.name ?? null, role: castRole(s?.name), spell, targets: targets ? [].concat(targets) : null,
    pvp: pvp ?? !!s?.combat?.active?.pvp, fighting: !!s?.combat?.active,
    room: Object.freeze({ num: room?.num ?? null, name: room?.name ?? null, inn: INN_ROOMS.has(room?.num) }),
    items: Object.freeze(items), equipped: Object.freeze(worn), gear_spell_modifier: gear, hands_locked: handsLocked,
    school_level: spell?.school ? schoolLevel(c, spell.school) : null,
    rite: riteStatus(s),
  });
}

/** A strategy's answer, normalized; null when it asks for nothing this engine can do. */
export function normalizeRite(answer) {
  if (!answer || typeof answer !== 'object') return null;
  if (answer.skip === true) return { skip: true, steps: [], forbid: [] };
  const steps = [];
  for (const st of Array.isArray(answer.steps) ? answer.steps : []) {
    if (st && st.equip != null && (typeof st.equip === 'number' || typeof st.equip === 'string')) steps.push({ op: 'equip', item: st.equip });
    else if (st && st.unequip != null && (typeof st.unequip === 'number' || typeof st.unequip === 'string')) steps.push({ op: 'unequip', item: st.unequip });
  }
  let wear = null;
  if (answer.wear && typeof answer.wear === 'object' && !Array.isArray(answer.wear)) {
    wear = {};
    for (const slot of ['weapon', 'shield', 'armour', 'helm'])
      if (slot in answer.wear && (answer.wear[slot] === null || Number.isFinite(Number(answer.wear[slot]))))
        wear[slot] = answer.wear[slot] === null ? null : Number(answer.wear[slot]);
    if (!Object.keys(wear).length) wear = null;
  }
  const restore = ['after', 'linger', 'never'].includes(answer.restore) ? answer.restore : null;
  const words = (v) => (Array.isArray(v) ? v : []).filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().toLowerCase());
  const forbid = words(answer.forbid), prefer_weapons = words(answer.prefer_weapons);
  if (!steps.length && !forbid.length && !wear && !prefer_weapons.length) return null;
  return { steps, wear, restore, forbid, prefer_weapons, why: typeof answer.why === 'string' ? answer.why : null,
           linger_ms: answer.linger_ms == null ? null : Math.max(0, Math.min(Number(answer.linger_ms) || 0, 10 * 60_000)),
           while_fighting: !!answer.while_fighting };
}

function findItem(c, ref) {
  const inv = c?.inventory ?? [];
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    const hit = inv.find(o => Number(o.id) === Number(ref));
    return hit ? { id: hit.id, name: itemName(c, hit) } : null;
  }
  const want = String(ref).trim().toLowerCase();
  const rows = inv.map(o => ({ id: o.id, name: itemName(c, o) }));
  return rows.find(r => r.name.toLowerCase() === want) ?? rows.find(r => r.name.toLowerCase().includes(want)) ?? null;
}

/**
 * Send each step, in order, urgent and back to back (the Pacer's 200ms is the server's limit), then
 * read the use list back once. A step on an item already in the asked state costs nothing.
 */
export async function runSteps(s, steps, { verify = true } = {}) {
  const c = s.client, done = [];
  const since = c.evSeq;
  let stopped = null;
  for (const st of steps) {
    const item = findItem(c, st.item);
    if (!item) { done.push({ ...st, ok: false, why: 'not carried' }); continue; }
    const on = equipped(c)?.has(item.id) ?? null;
    if (st.op === 'equip' && on === true) { done.push({ ...st, ...item, ok: true, already: true }); continue; }
    if (st.op === 'unequip' && on === false) { done.push({ ...st, ...item, ok: true, already: true }); continue; }
    let sent;
    try { sent = await s.pacer.submit('use', () => (st.op === 'equip' ? c.use(item.id) : c.unuse(item.id)), 0, { urgent: true }); }
    catch (e) { done.push({ ...st, ...item, ok: false, why: e.message }); stopped = 'refused'; break; }
    if (sent?.held) { done.push({ ...st, ...item, ok: false, why: 'a trance is charging' }); stopped = 'trance'; break; }
    done.push({ ...st, ...item, ok: null, sent: true });
  }
  if (verify && done.some(d => d.sent)) {
    await c.waitFor?.({ since, kinds: ['equipment'], timeoutMs: VERIFY_MS }).catch(() => null);
    const using = equipped(c);
    for (const d of done) if (d.sent && using) d.ok = d.op === 'equip' ? using.has(d.id) : !using.has(d.id);
  }
  return { done, stopped };
}

export function riteStatus(s) {
  const r = s?._rite;
  if (!r) return Object.freeze({ active: false, last: s?._riteLast ?? null });
  return Object.freeze({ active: true, spell: r.spell, source: r.source, restore: r.restore, pvp: r.pvp, why: r.why,
    stash: r.stash.map(x => x.name), restore_in_ms: r.restoreAt ? Math.max(0, r.restoreAt - now()) : null,
    last: s._riteLast ?? null });
}

async function ask(s, hook, ctx) {
  if (typeof s?._askStrategies !== 'function') return null;
  try { return await s._askStrategies(hook, ctx); } catch { return null; }
}

/**
 * What this cast's rite is, or null for none. A `wear` target becomes packets here, from what is worn
 * now, by the same transition the pop uses; an illegal target (a bow beside an ordinary shield, an
 * item not carried, a slot the item does not fill, a cursed item to take off) is refused whole.
 */
function decideRite(s, ctx, asked) {
  const answer = normalizeRite(asked?.answer);
  if (!answer || answer.skip) return null;
  let steps = answer.steps;
  if (!steps.length && answer.wear) {
    const cands = gearCandidates(ctx.items, { spellSchool: ctx.spell?.school ?? null });
    const from = wornState(cands);
    const to = { ...from };
    for (const [slot, id] of Object.entries(answer.wear)) {
      if (id === null) { if (from[slot]?.cursed) return null; to[slot] = null; continue; }
      const g = cands.find(x => x.id === id);
      if (!g || g.slot !== slot) return null;
      if (from[slot]?.cursed && from[slot].id !== id) return null;
      to[slot] = g;
    }
    if (!legalHands(to.weapon, to.shield)) return null;
    steps = transitionSteps(from, to).map(st => (st.equip != null ? { op: 'equip', item: st.equip } : { op: 'unequip', item: st.unequip }));
  }
  if (!steps.length) return null;
  return { steps, restore: answer.restore ?? 'after', linger_ms: answer.linger_ms ?? 0,
           while_fighting: answer.while_fighting, source: asked?.strategy ?? 'strategy', why: answer.why };
}

/**
 * Wrap one cast. `send` is exactly what the call site did before: it is called once, and its
 * result is returned unchanged. With no strategy answer, that is ALL that happens, whatever the tags.
 */
export async function withCastRite(s, { spell = null, pvp = null, why = null, targets = null, rite = true } = {}, send) {
  const c = s?.client;
  if (!rite || !c) return send();
  // A trance is charging: a swap now would fizzle it, and this cast will wait it out (or replace
  // it, if the caller said so) at the Pacer. Either way it is not the moment for gear.
  if (s.pacer?.holdStatus?.().active) return send();
  if (typeof s._askStrategies !== 'function') return send();
  const sp = resolveSpell(c, spell);
  const ctx = castRiteContext(s, 'before_cast', { spell: sp, pvp, why, targets });
  const asked = await ask(s, 'castRite', ctx);
  const plan = decideRite(s, ctx, asked);
  if (!plan) return send();

  // One rite at a time per body: a second cast inside a lingering rite keeps the FIRST stash.
  await (s._riteLock ?? Promise.resolve());
  let release;
  s._riteLock = new Promise(r => { release = r; });
  try {
    const r = s._rite ?? { stash: [...(equipped(c) ?? [])].map(id => ({ id, name: itemName(c, (c.inventory ?? []).find(o => o.id === id)) })),
                           started: now(), casts: 0 };
    s._rite = r;                      // open BEFORE the first packet: equipBest/wearBest stand down
    clearTimeout(s._riteTimer);
    const ran = await runSteps(s, plan.steps, { verify: false });
    Object.assign(r, { spell: sp?.name ?? r.spell, restore: plan.restore, linger_ms: plan.linger_ms,
                       while_fighting: !!plan.while_fighting, pvp: pvp ?? !!s.combat?.active?.pvp,
                       source: plan.source, why: plan.why, last_steps: ran.done, casts: r.casts + 1 });
    const result = await send();
    // The trance itself is waited out by scheduleRestore, which will not touch gear while the Pacer
    // holds concentration (the session opens that hold for every cast with a trance).
    r.castAt = now();
    r.restoreAt = r.castAt + 250 + (r.restore === 'linger' ? r.linger_ms : 0);
    if (r.restore === 'never') { s._riteLast = { ...riteStatus(s), ended: 'never restored', at: now() }; s._rite = null; }
    else scheduleRestore(s);
    return result;
  } catch (e) {
    // A failed cast still owes the stash back.
    if (s._rite) { s._rite.restoreAt = now(); scheduleRestore(s); }
    throw e;
  } finally { release(); }
}

function scheduleRestore(s) {
  clearTimeout(s._riteTimer);
  const tick = () => {
    const r = s._rite;
    if (!r) return;
    const wait = (s.pacer?.holdStatus?.().active) ? 200
      : (r.restore === 'linger' && r.while_fighting && s.combat?.active) ? 1000
      : Math.max(0, (r.restoreAt ?? 0) - now());
    if (wait > 0) { s._riteTimer = setTimeout(tick, Math.min(wait, 1000)); s._riteTimer.unref?.(); return; }
    restoreRite(s, 'rite over').catch(() => {});
  };
  s._riteTimer = setTimeout(tick, 0);
  s._riteTimer.unref?.();
}

/** Pop the stash: hands, body and head back to what they were before the rite, by the fewest packets. */
export async function restoreRite(s, why = 'restore') {
  const r = s?._rite, c = s?.client;
  if (!r || !c) return null;
  if (s.pacer?.holdStatus?.().active) { scheduleRestore(s); return null; }
  await (s._riteLock ?? Promise.resolve());
  if (s._rite !== r) return null;
  const items = (c.inventory ?? []).map(o => ({ id: o.id, name: itemName(c, o), equipped: !!equipped(c)?.has(o.id) }));
  const cands = gearCandidates(items);
  // The stash, re-found by id and name (an id is a handle, CLAUDE.md), else by name alone.
  const stashIds = r.stash.map(x => (items.find(i => i.id === x.id && i.name === x.name)
    ?? items.find(i => i.name === x.name && !i.equipped))?.id).filter(v => v != null);
  const steps = transitionSteps(slotState(cands, [...(equipped(c) ?? [])]), slotState(cands, stashIds));
  // Items outside the four slot groups (a strategy may move anything): put back what left, take off what came.
  const stashSet = new Set(stashIds);
  for (const i of items) {
    if (cands.some(g => g.id === i.id)) continue;
    if (i.equipped && !stashSet.has(i.id) && (r.last_steps ?? []).some(d => d.id === i.id && d.op === 'equip')) steps.push({ unequip: i.id });
    if (!i.equipped && stashSet.has(i.id)) steps.push({ equip: i.id });
  }
  const ran = await runSteps(s, steps.map(st => (st.equip != null ? { op: 'equip', item: st.equip } : { op: 'unequip', item: st.unequip })));
  if (ran.stopped === 'trance') { scheduleRestore(s); return ran; }
  s._riteLast = { spell: r.spell, source: r.source, casts: r.casts, ended: why, at: now(), steps: ran.done };
  s._rite = null;
  return ran;
}

/** Is this item one the idle-gear policy forbids the keeper from putting on by itself? */
export function gearForbidden(s, name) {
  const f = s?._gearForbid;
  if (!f?.length) return false;
  const n = String(name ?? '').toLowerCase();
  return f.some(p => n.includes(p));
}

async function learnRobeSchools(s) {
  const c = s.client;
  if (!c || now() - (s._robeLookAt ?? 0) < ROBE_LOOK_EVERY_MS) return;
  s._robeSchools ??= new Map();
  const inv = c.inventory ?? [];
  for (const id of [...s._robeSchools.keys()]) if (!inv.some(o => o.id === id)) s._robeSchools.delete(id);
  const o = inv.find(x => isDiscipleRobe(itemName(c, x)) && !s._robeSchools.has(x.id));
  if (!o) return;
  s._robeLookAt = now();
  const name = itemName(c, o), since = c.evSeq;
  await s.pacer.submit('look', () => c.look(o.id)).catch(() => null);
  const w = await c.waitFor?.({ since, kinds: ['look'], timeoutMs: 3000, match: e => e.kind === 'look' && Number(e.id) === Number(o.id) }).catch(() => null);
  // CHECK THE ID THAT CAME BACK: a look reply can carry the previous call's object (CLAUDE.md).
  const ev = (w?.events ?? []).find(e => e.kind === 'look' && Number(e.id) === Number(o.id));
  const school = ev ? robeSchoolFromLook(ev.description) : null;
  if (school) s._robeSchools.set(o.id, { name, school, at: now() });
}

/**
 * The idle check: a strategy's say over what is worn when nothing is being cast. Cheap when there is
 * nothing to do, and never runs inside a rite, a trance or a fight. A `prefer_weapons` answer is put
 * on the client for m59-skills weaponRanking; no answer clears it.
 */
export async function idleGearCheck(s, { why = 'pass', force = false, refill = null } = {}) {
  const c = s?.client;
  if (!c) return null;
  if (typeof s._askStrategies !== 'function') return null;
  const room = s.world?.room?.num ?? null;
  if (!force && room === s._idleGearRoom && now() - (s._idleGearAt ?? 0) < IDLE_EVERY_MS) return null;
  if (s._rite || s.pacer?.holdStatus?.().active || s.combat?.active || s._idleGearBusy) return null;
  s._idleGearBusy = true;
  try {
    s._idleGearRoom = room; s._idleGearAt = now();
    const asked = await ask(s, 'idleGear', castRiteContext(s, 'idle', { why }));
    const answer = normalizeRite(asked?.answer);
    s._gearForbid = answer?.forbid ?? [];
    c._preferWeapons = answer?.prefer_weapons?.length ? answer.prefer_weapons : null;
    s.gearForbidden = name => gearForbidden(s, name);
    let ran = null;
    if (answer?.steps?.length) {
      ran = await runSteps(s, answer.steps);
      // A body slot emptied by the policy is the keeper's to refill, minus what is forbidden.
      if (ran.done.some(d => d.op === 'unequip' && d.sent)) {
        const wear = refill ?? (await import('./m59-skills.mjs')).wearBest;
        await wear(s, { slots: ['armour'], exclude: n => gearForbidden(s, n) })?.catch?.(() => null);
      }
      s._idleGearLast = { at: now(), why, room, strategy: asked?.strategy ?? null, steps: ran.done };
    }
    // Robe schools are learned while idle, so the next cast's ctx can tell +20 from +5.
    if (!s.combat?.active) await learnRobeSchools(s).catch(() => null);
    return ran;
  } finally { s._idleGearBusy = false; }
}
