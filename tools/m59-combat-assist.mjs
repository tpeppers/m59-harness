// THE ASSIST BEAT -- WHAT A CHARACTER DOES IN A PVP FIGHT IT CANNOT SWING IN.
//
// The week to 2026-10-29 (m59-research reports/pvp-against-faction-raiders.md): the fleet is split across three
// factions, a soldier cannot hit a soldier of its own faction with safety on, and 205 swings were refused for it --
// Scooter swung at Rick Deckard 106 times, one "Good thing your safety was on!" a second, while Morpheus, whom he
// COULD hit, killed him. A refused swing at a player in a return-fire fight goes to combatFailure, which retries the
// same target every second for as long as it stands there; nothing ever told the fight that this player is one we
// cannot hurt.
//
// So a PvP fight now sorts the players in it, per character, into DIRECT combatants (we can hit them) and INDIRECT ones
// (we cannot; and because the server's rule is symmetric, they cannot hit us either). The joints ask a pak to do the
// sorting -- `pvp.target` before any swing, `pvp.refused` after the server says no -- and the fight swings only at
// direct ones. An indirect one hitting us anyway is proof the line moved (he went outlaw, changed faction, took the
// shield off), and he is direct again at once. When every player left in the fight is indirect, the fight is not over:
// it is this file's. Every beat it asks `pvp.assist` what to do instead -- swing at another player who IS direct, cast a
// buff or a heal on an ally, apply an item, clear a monster off an ally -- and does it under the fight's own body lease,
// safety on, through the ordinary pacer and cast rite.
//
// THE HARNESS CARRIES THE MECHANISM AND NO ORDERS (docs/m59-pvp-strategies.md, the operator, 2026-10-13). Nothing here
// knows a faction, a spell priority, or who should cast what. With no pak loaded nobody is ever indirect, this file is
// never reached, and every fight is the one m59-pvp-rooms-test and m59-war-test pin.
//
// SHARED STATE IS PUBLISHED, NEVER ASKED. Allies' mana, buffs, spells and fight roles reach a pak as facts read from the
// fleet-health reports every keeper already writes (m59-fleet-health.mjs, the `combat` sheet built by `publicSheet`
// below). Two of ours deciding to cast the same buff on the same ally in the same round is settled by a CLAIM
// (m59-fleet-claims.mjs) the pak names and this file takes, before anything is sent.
import { OF, isKiller, isOutlaw } from './m59-parse.mjs';
import { readFleetHealth } from './m59-fleet-health.mjs';
import { claimFleetAction } from './m59-fleet-claims.mjs';
import { spellCost } from './m59-deskpractice.mjs';
import { withCastRite } from './m59-castrite.mjs';
import { selfFacts, roomFacts } from './m59-joint-facts.mjs';

// room.kod viPermanent_flags, as CombatMode reads them (not imported: that module imports this one).
const ROOM_NO_COMBAT = 0x0002, ROOM_NO_PK = 0x0004, ROOM_GUILD_PK_ONLY = 0x0008;
// A monster blow on an ally older than this is not "attacking an ally" any more.
export const MONSTER_HIT_MS = 6_000;
// The fleet-health report an ally wrote is evidence for this long.
export const ALLY_REPORT_MS = 3_000;
const SHEET_EVERY_MS = 1_500;

const lc = s => String(s ?? '').trim().toLowerCase();
const nameOf = (c, o) => String(c?.rsc?.get?.(o?.nameRsc) ?? o?.name ?? '').trim();
const hyp = (a, b) => a && b && Number.isFinite(a.row) && Number.isFinite(b.row) ? Math.round(10 * Math.hypot(a.row - b.row, a.col - b.col)) / 10 : null;

/** The spells this client knows, by lowercase name. */
export function knownSpells(c) {
  return (c?.spells ?? []).map(sp => ({ sp, name: lc(nameOf(c, sp)) })).filter(x => x.name);
}

/** Pack counts by lowercase item name. */
export function packCounts(c) {
  const out = {};
  for (const it of c?.inventory ?? []) {
    const n = lc(nameOf(c, it));
    if (n) out[n] = (out[n] ?? 0) + (Number(it.amount) || 1);
  }
  return out;
}

/** Can this body pay for `spell` right now: mana, and every reagent on hand (matched by substring, as practice does). */
export function canPay(spell, { mana, pack }) {
  const cost = spellCost(spell);
  if (!cost) return false;
  if (!(Number(mana) >= cost.mana)) return false;
  const items = Object.entries(pack ?? {});
  return cost.reagents.every(([item, n]) => items.filter(([k]) => k.includes(item)).reduce((a, [, v]) => a + v, 0) >= n);
}

export class CombatAssist {
  constructor(mode) {
    this.mode = mode;
    this.last = null; this.history = []; this.claimsLost = [];
    this.sheet = null; this.sheetAt = -Infinity;
  }

  snapshot() {
    const now = this.mode.now();
    return { last: this.last && { ...this.last }, history: this.history.map(r => ({ ...r })),
      claims_lost_10s: this.claimsLost.filter(t => now - t < 10_000).length };
  }

  // ------------------------------------------------------------------ what this body publishes about itself
  /**
   * The `combat` sheet in this character's fleet-health report: what an ally's pak needs to know to plan around us.
   * Cheap and bounded -- it is built on every health stat. The expensive half (spells, castable) is cached.
   */
  publicSheet() {
    const m = this.mode, s = m.s, c = s.client, now = m.now();
    if (!c?.self) return null;
    const v = c.vitals?.() ?? {};
    const o = m.active, p = o?.pvp;
    if (now - this.sheetAt >= SHEET_EVERY_MS || this.sheetClient !== c) {
      const spells = knownSpells(c).map(x => x.name).slice(0, 96);
      const pack = packCounts(c);
      this.sheet = { spells, castable: spells.filter(n => canPay(n, { mana: v.mana?.value, pack })) };
      this.sheetAt = now; this.sheetClient = c;
    }
    const buffs = [];
    try { for (const e of c.enchantments?.() ?? []) if (e.type == null || e.type === 1) { const n = lc(e.name); if (n) buffs.push(n); } } catch {}
    const lastCast = c.lastCastSent?.at != null ? c.lastCastSent.at + m.spellTimerMs(c.lastCastSent.name) : 0;
    const me = lc(nameOf(c, c.self) || m.character?.());
    return {
      // When this body can next send a swing or a cast, and what it cast lately: a buff in flight is not on its
      // target's sheet yet, and an ally's planner must not hand the same buff to somebody else in the meantime.
      busy_until: Math.max(m.attackReadyAt ?? 0, lastCast) || null,
      recent_casts: this.history.filter(h => h.do === 'cast' && h.ok && now - h.at < 8000)
        .map(h => ({ spell: h.spell, target: h.target === 'self' ? me : lc(h.target), at: h.at })).slice(-6),
      mana: Number.isFinite(v.mana?.value) ? { value: v.mana.value, max: v.mana.max ?? null } : null,
      buffs: buffs.slice(0, 32), spells: this.sheet.spells, castable: this.sheet.castable,
      // `standby`: standing to (pvp-strategy stand_to) -- nobody has attacked yet; a caster AND somebody to buff.
      role: !p ? null : p.stand_to && !p.attackers.length ? 'standby' : o.phase === 'assisting' ? 'indirect' : 'direct',
      fighting: p && o.phase !== 'assisting' ? (o.targetName ?? null) : null,
      attackers: p ? p.attackers.map(a => lc(a.character)).slice(0, 16) : [],
      indirect: p ? Object.keys(p.indirect ?? {}).slice(0, 16) : [],
      monster_hits: (m.monsterHits ?? []).filter(h => now - h.at < MONSTER_HIT_MS).slice(-8),
      casting: !!s.pacer?.holdStatus?.()?.active,
    };
  }

  // ------------------------------------------------------------------ the facts a pak is asked with
  facts(o) {
    const m = this.mode, s = m.s, c = o.client, me = c.self, now = m.now();
    const flags = m.roomFlagsHere();
    const room = s.world?.room?.num ?? null;
    const p = o.pvp;
    const v = c.vitals?.() ?? {};
    const pack = packCounts(c);
    const spells = knownSpells(c).map(x => x.name);
    const allies = [];
    const sheet = this.publicSheet();
    const pct = h => Number.isFinite(h?.value) && h?.max > 0 ? Math.round(100 * h.value / h.max) : null;
    allies.push({ name: nameOf(c, me) || m.character?.() || null, id: c.selfId, self: true, distance: 0,
      health_pct: pct(v.health), health: v.health ? { value: v.health.value, max: v.health.max } : null,
      mana: sheet?.mana ?? null, buffs: sheet?.buffs ?? [], spells: sheet?.spells ?? [], castable: sheet?.castable ?? [],
      role: sheet?.role ?? null, attacked_by: sheet?.attackers ?? [], monster_hits: sheet?.monster_hits ?? [],
      busy_until: sheet?.busy_until ?? null, recent_casts: sheet?.recent_casts ?? [], report_age_ms: 0 });
    const hostiles = [], monsters = [];
    for (const obj of c.room?.objects?.values?.() ?? []) {
      if (obj.id === c.selfId) continue;
      const name = nameOf(c, obj);
      if (obj.flags & OF.PLAYER) {
        if (!name) continue;
        if (m.isOurs(name)) {
          const r = s.credentials?.host ? readFleetHealth({ ...s.credentials, character: name },
            { room, bodyId: obj.id, now, maxAgeMs: ALLY_REPORT_MS }) : null;
          const k = r?.combat ?? null;
          allies.push({ name, id: obj.id, self: false, distance: hyp(me, obj),
            health_pct: r ? pct(r.health) : null, health: r?.health ?? null,
            mana: k?.mana ?? null, buffs: k?.buffs ?? [], spells: k?.spells ?? [], castable: k?.castable ?? [],
            role: k?.role ?? null, attacked_by: k?.attackers ?? [], monster_hits: k?.monster_hits ?? [],
            busy_until: k?.busy_until ?? null, recent_casts: k?.recent_casts ?? [],
            report_age_ms: r ? now - r.at : null });
          continue;
        }
        const a = p?.attackers?.find(x => lc(x.character) === lc(name));
        hostiles.push({ name, id: obj.id, distance: hyp(me, obj),
          attacked_us: !!a && (a.hit_us_at != null || (a.incoming_hits ?? 0) + (a.incoming_misses ?? 0) > 0),
          hit_us_at: a?.hit_us_at ?? null, last_attacked_at: a?.last_attacked_at ?? null,
          indirect: m.isIndirect(o, name), in_fight: !!a,
          murderer: isKiller(obj.flags), outlaw: isOutlaw(obj.flags), enemy: !!(obj.flags & OF.ENEMY),
          attackable: !!(obj.flags & OF.ATTACKABLE) });
      } else if (obj.flags & OF.ATTACKABLE) {
        monsters.push({ id: obj.id, name: name || null, distance: hyp(me, obj), attacking: [] });
      }
    }
    // A hostile is a COMBATANT when anyone of ours names him as an attacker: the fight is about him.
    const named = new Set(allies.flatMap(a => a.attacked_by ?? []).map(lc));
    for (const h of hostiles) h.combatant = h.in_fight || named.has(lc(h.name));
    // A monster is ATTACKING AN ALLY when that ally's own keeper heard it land a blow, recently.
    for (const a of allies) for (const hit of a.monster_hits ?? []) {
      if (now - Number(hit.at) >= MONSTER_HIT_MS) continue;
      const mon = monsters.find(x => (hit.id != null && x.id === hit.id) || (hit.id == null && lc(x.name) === lc(hit.name)));
      if (mon && !mon.attacking.includes(a.name)) mon.attacking.push(a.name);
    }
    const lastCast = c.lastCastSent?.at != null ? c.lastCastSent.at + m.spellTimerMs(c.lastCastSent.name) : 0;
    return {
      ...roomFacts(s),
      room_flags: { no_combat: !!(flags & ROOM_NO_COMBAT), no_pk: !!(flags & ROOM_NO_PK), guild_pk_only: !!(flags & ROOM_GUILD_PK_ONLY) },
      self: selfFacts(s, { now }),
      me: { name: allies[0].name, mana: v.mana?.value ?? null, max_mana: v.mana?.max ?? null, spells,
        castable: sheet?.castable ?? [], pack, casting: !!s.pacer?.holdStatus?.()?.active,
        ready_in_ms: Math.max(0, Math.max(m.attackReadyAt ?? 0, lastCast) - now) },
      hostiles, allies, monsters,
      last: this.last && { ...this.last },
      claims_lost: this.claimsLost.filter(t => now - t < 10_000).length,
    };
  }

  // ------------------------------------------------------------------ one beat
  async beat(o) {
    const m = this.mode, s = m.s, c = o.client, now = m.now();
    if (now < (o.assistNextAt ?? 0)) return;
    // Safety stays ON in an assist: nothing here is a strike on an innocent, and a heal is not an attack.
    await m.restoreSafety();
    if (m.active !== o || o.phase !== 'assisting') return;
    const joints = s.joints;
    if (!joints?.handles?.('pvp.assist')) { o.assistNextAt = now + 1000; return; }
    let d = null;
    try { d = joints.ask('pvp.assist', this.facts(o)); } catch { d = null; }
    if (!d) { o.assistNextAt = now + 1000; return; }
    const done = (ok, reason = null, extra = {}) => {
      this.last = { at: m.now(), do: d.do, ok, reason, pak: d.pak ?? null, why: d.why ?? null, ...extra };
      this.history.push(this.last); if (this.history.length > 32) this.history.splice(0, this.history.length - 32);
      o.lastAssist = { ...this.last };
      // A skip that repeats (a claim lost every 200 ms to the same caster) is said once per reason per 5 s.
      const quiet = !ok && this.lastSkip?.reason === reason && this.last.at - this.lastSkip.at < 5000;
      if (!ok && !quiet) this.lastSkip = { reason, at: this.last.at };
      if (!quiet) m.record(ok ? 'pvp_assist' : 'pvp_assist_skipped', o);
      return ok;
    };
    if (d.do === 'wait') { o.assistNextAt = now + d.ms; return; }
    if (d.do === 'stand_down') { done(true); m.stop(`pvp.assist stand_down (${d.pak}): ${d.why ?? 'nothing left to help with'}`); return; }
    if (d.do === 'attack') return this.attack(o, d, done);
    if (d.do === 'fight_monster') return this.fightMonster(o, d, done);
    if (d.do === 'cast') return this.cast(o, d, done);
    if (d.do === 'apply') return this.applyItem(o, d, done);
    o.assistNextAt = now + 1000;
  }

  /** `attack`: a player present and not ours goes back into the fight as somebody to swing at -- once. */
  attack(o, d, done) {
    const m = this.mode, c = o.client, now = m.now();
    const obj = this.player(c, d.target);
    if (!obj || m.isOurs(nameOf(c, obj))) { o.assistNextAt = now + 500; return done(false, 'not_a_hostile_here', { target: d.target }); }
    const name = nameOf(c, obj), p = o.pvp;
    // ONE PROBE. An indirect combatant named here is swung at once more; the next refusal asks pvp.refused again.
    if (p.indirect) delete p.indirect[lc(name)];
    if (!p.attackers.some(a => lc(a.character) === lc(name)))
      p.attackers.push({ character: name, first_attacked_at: now, last_attacked_at: now, assisted: true,
        incoming_hits: 0, incoming_misses: 0, outgoing_hits: 0, outgoing_misses: 0 });
    p.prefer = [lc(name), ...(p.prefer ?? []).filter(n => n !== lc(name))];
    done(true, null, { target: name });
    o.phase = 'waiting'; o.phaseRevision++; o.targetId = null; o.targetName = null; o.nextAt = 0;
    if (m.syncPvP(o)) m.refreshTarget(o);
  }

  /** `fight_monster`: a monster on an ally, swung at through the fight's own readiness, approach and pacer. */
  async fightMonster(o, d, done) {
    const m = this.mode, s = m.s, c = o.client;
    const mon = c.room?.objects?.get?.(d.id);
    if (!mon || mon.id === c.selfId || (mon.flags & OF.PLAYER) || !(mon.flags & OF.ATTACKABLE)) {
      o.assistNextAt = m.now() + 250; return done(false, 'no_such_monster', { target: d.id });
    }
    o.targetId = mon.id; o.targetName = lc(nameOf(c, mon));
    const ready = m.attackReadiness(o, mon, { range: 2 });
    o.lastReadiness = { action: 'assist_monster', ...ready };
    if (!ready.positioned) { await m.approachCombat(o, mon); return; }
    if (ready.timer_remaining_ms > 0) { o.assistNextAt = m.now() + ready.timer_remaining_ms; return; }
    await m.stand(o);
    await m.faceCombatTarget(o);
    await s.pacer.submit('attack', () => {
      const live = c.room.objects.get(o.targetId);
      if (!m.attackReadiness(o, live, { range: 2, facing: true }).ready) return;
      if (c.attack(live.id) === false) return;
      m.lastOutChannel = { channel: 'melee', at: m.now() };
      m.attackReadyAt = m.now() + 1000;
      o.attacks++;
      done(true, null, { target: o.targetName, target_id: live.id });
    }, 1050);
    o.assistNextAt = m.now() + 250;
  }

  /** `cast`: a spell this body knows, on itself, the room, or an ally present -- never on an enemy (that is `attack`). */
  async cast(o, d, done) {
    const m = this.mode, s = m.s, c = o.client, now = m.now();
    const spell = knownSpells(c).find(x => x.name === d.spell)?.sp;
    if (!spell) { o.assistNextAt = now + 500; return done(false, 'spell_not_known', { spell: d.spell }); }
    let targets;
    if (d.target === 'self') targets = [c.selfId];
    else if (d.target === 'room' || d.target === 'none') targets = [];
    else {
      const obj = this.player(c, d.target);
      const name = obj ? nameOf(c, obj) : null;
      if (!obj || !(obj.id === c.selfId || m.isOurs(name))) { o.assistNextAt = now + 500; return done(false, 'cast_target_not_an_ally_here', { spell: d.spell, target: d.target }); }
      targets = [obj.id];
    }
    if (s.pacer?.holdStatus?.()?.active) { o.assistNextAt = now + 250; return; }
    const lastCast = c.lastCastSent?.at != null ? c.lastCastSent.at + m.spellTimerMs(c.lastCastSent.name) : 0;
    const readyAt = Math.max(m.attackReadyAt ?? 0, lastCast);
    if (readyAt > now) { o.assistNextAt = readyAt; return; }
    const cost = spellCost(d.spell);
    if (cost && !(Number(c.vitals?.()?.mana?.value) >= cost.mana)) { o.assistNextAt = now + 1000; return done(false, 'no_mana', { spell: d.spell }); }
    if (d.claim && !this.claim(o, d)) { o.assistNextAt = now + 200; return done(false, 'claim_lost', { spell: d.spell, target: d.target, key: d.claim.key }); }
    const timer = m.spellTimerMs(d.spell);
    await withCastRite(s, { spell, pvp: true, targets, why: 'pvp assist' }, () => s.pacer.submit('cast', () => {
      if (c.cast(spell.id, targets) === false) return;
      m.lastOutChannel = { channel: `spell:${d.spell}`, at: m.now() };
      m.attackReadyAt = m.now() + timer;
      o.casts++;
      done(true, null, { spell: d.spell, target: d.target, ...(d.claim ? { key: d.claim.key } : {}) });
    }, 1050));
    o.assistNextAt = m.now() + Math.max(500, timer);
  }

  /** `apply`: an item from the pack on ourselves or any player present. Items skip every PvP gate (player.kod TryApplyItem). */
  async applyItem(o, d, done) {
    const m = this.mode, s = m.s, c = o.client, now = m.now();
    const item = (c.inventory ?? []).find(i => lc(nameOf(c, i)) === d.item);
    if (!item) { o.assistNextAt = now + 500; return done(false, 'item_not_carried', { item: d.item }); }
    const target = d.target === 'self' ? c.self : this.player(c, d.target);
    if (!target) { o.assistNextAt = now + 500; return done(false, 'apply_target_not_here', { item: d.item, target: d.target }); }
    if (d.claim && !this.claim(o, d)) { o.assistNextAt = now + 200; return done(false, 'claim_lost', { item: d.item, target: d.target, key: d.claim.key }); }
    await s.pacer.submit('use', () => {
      if (c.apply(item.id, target.id) === false) return;
      done(true, null, { item: d.item, target: d.target });
    });
    o.assistNextAt = m.now() + 1000;
  }

  claim(o, d) {
    const m = this.mode, s = m.s, now = m.now();
    const ok = claimFleetAction({ host: s.credentials?.host, port: s.credentials?.port, room: s.world?.room?.num },
      d.claim.key, { now, ms: d.claim.ms, by: m.character?.() ?? null });
    if (!ok) { this.claimsLost.push(now); if (this.claimsLost.length > 64) this.claimsLost.splice(0, 32); }
    return ok;
  }

  /** A player in our room by name (case-insensitive) or `#id`. */
  player(c, who) {
    const byId = /^#\d+$/.test(String(who)) ? Number(String(who).slice(1)) : null;
    for (const obj of c.room?.objects?.values?.() ?? []) {
      if (!(obj.flags & OF.PLAYER)) continue;
      if (byId != null ? obj.id === byId : lc(nameOf(c, obj)) === lc(who)) return obj;
    }
    if (byId === c.selfId || lc(who) === lc(nameOf(c, c.self))) return c.self;
    return null;
  }
}
