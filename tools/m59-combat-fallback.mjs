// Opt-in private fallback queue. Inspection never holds up the combat/movement pass.
// Each dispatch rechecks ownership, current inventory, condition age, primary
// feasibility and the SAME attack timer used by wand/spell/melee packets.
import { potionCatalogue, potionCondition } from './m59-potions.mjs';
import { OF } from './m59-parse.mjs';
import { idsCurrent } from './m59-idgen.mjs';

export const CONDITION_MAX_AGE_MS = 500;
export class CombatFallback {
  constructor(mode, { catalogue = potionCatalogue } = {}) {
    this.mode = mode; this.catalogue = catalogue; this.episode = null;
    this.attempted = new Set(); this.rejected = new Set(); this.nextAt = 0;
    this.busy = null; this.last = null; this.history = [];
  }
  snapshot() {
    return { pending: !!this.busy, episode: this.episode, attempted_effects: [...this.attempted],
      last: this.last && { ...this.last }, history: this.history.map(x => ({ ...x })) };
  }
  observe(ev) {
    const now = this.mode.now();
    for (const row of this.history) {
      if (now - row.at > 3000) continue;
      if (ev.kind === 'left' && ev.id === row.item) row.item_left_at = now;
      if (ev.kind === 'enchantment' && ev.added?.type === 1 &&
          String(ev.added.name).toLowerCase() === row.effect) row.effect_seen_at = now;
    }
  }
  eligible(o) {
    const m = this.mode, c = m.s.client;
    const target = c.room?.objects?.get?.(o.targetId);
    return m.active === o && o.client === c && m.s.live && c.combatReady !== false &&
      c.self && c.vitals?.()?.health?.value > 0 && m.s.world?.room?.num > 1 &&
      !!(o.pvp || o.flight || target?.flags & OF.PLAYER) && !m.s.pacer.holdStatus?.().active;
  }
  episodeOf(o) { return this.mode.personalThreatStatus().episode ?? 'order:' + o.id; }
  primaryAvailable(o) {
    if (o.flight || o.phase === 'waiting') return false;
    const m = this.mode, c = o.client, target = c.room?.objects?.get?.(o.targetId);
    const options = o.fallbackPrimary ?? { range: 2 };
    const ready = m.attackReadiness(o, target, options);
    // Turning to a feasible target is part of its primary attack, not a chance
    // for a queued potion to steal the slot before the turn packet arrives.
    return ready.positioned && ready.timer_remaining_ms === 0;
  }
  items(c) {
    return (c.inventory ?? []).flatMap(item => {
      const name = String(c.rsc?.get?.(item.nameRsc) ?? item.name ?? '').trim();
      const potion = this.catalogue().get(name.toLowerCase());
      return potion && !this.rejected.has(item.id) ? [{ id: item.id, name, effect: potion.effect, harmful: potion.harmful }] : [];
    });
  }
  async choose(o, reason) {
    const m = this.mode, c = o.client;
    const target = c.room?.objects?.get?.(o.targetId);
    const ctx = { now: m.now(), agent: m.agentId ?? null, character: c.me?.name ?? m.s.name,
      room: m.s.world?.room?.num ?? null, phase: o.phase, reason,
      pvp: !!(o.pvp || o.flight || target?.flags & OF.PLAYER), personal_threat: m.personalThreatStatus(),
      items: this.items(c), attempted_effects: [...this.attempted],
      enchantments: c.enchantments?.().filter(e => e.type === 1).map(e => e.name) ?? [] };
    const loaded = await m.combatStrategies();
    for (const st of loaded?.strategies ?? []) {
      if (!st.enabled || typeof st.pvpFallback !== 'function') continue;
      try {
        let timeout;
        let answer;
        try {
          answer = await Promise.race([Promise.resolve(st.pvpFallback(structuredClone(ctx))),
            new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('fallback hook timed out')), 1000); })]);
        } finally { clearTimeout(timeout); }
        if (answer == null) continue;
        if (Object.keys(answer).some(k => !['queue', 'interval_ms'].includes(k)) ||
            !Array.isArray(answer.queue) || answer.queue.length > 64 ||
            !Number.isSafeInteger(answer.interval_ms) || answer.interval_ms < 1000 || answer.interval_ms > 60000)
          throw Error('expected { queue: [{use: carriedPotionId}], interval_ms: 1000..60000 }');
        for (const action of answer.queue) {
          if (!action || Object.keys(action).some(k => k !== 'use') || !Number.isSafeInteger(action.use))
            throw Error('fallback action must name only use: carriedPotionId');
          const item = ctx.items.find(i => i.id === action.use);
          if (!item) throw Error('fallback selected an item without known potion mechanics');
          return { ...item, strategy: st.name, interval: answer.interval_ms };
        }
      } catch (e) { this.last = { at: m.now(), status: 'strategy_fault', strategy: st.name, reason: e.message }; }
    }
    return null;
  }
  offer(o, reason) {
    if (!this.eligible(o) || this.primaryAvailable(o)) return;
    if (this.mode.attackReadiness(o, o.client.room?.objects?.get?.(o.targetId)).timer_remaining_ms > 0) return;
    const m = this.mode, episode = this.episodeOf(o);
    if (episode !== this.episode) {
      this.episode = episode; this.attempted.clear(); this.rejected.clear(); this.nextAt = 0;
    }
    if (this.busy && (this.busy.o !== o || this.busy.phaseRevision !== o.phaseRevision || this.busy.episode !== episode))
      this.busy = null;
    if (this.busy || m.now() < this.nextAt) return;
    const token = { episode, o, phaseRevision: o.phaseRevision };
    this.busy = token; this.nextAt = m.now() + 1000;
    // Invoked inside the order's body/packet scopes. They survive these awaits
    // and revoke every queued request/use if that order, room or player changes.
    this.task = this.prepare(o, reason, token).catch(e => {
      if (this.busy === token) this.last = { at: m.now(), status: 'skipped', reason: e.message };
    }).finally(() => { if (this.busy === token) this.busy = null; });
  }
  async prepare(o, reason, token) {
    const m = this.mode, s = m.s, c = o.client;
    if (!await this.choose(o, reason)) return; // no private answer: no requests or actions
    const check = () => {
      if (this.busy !== token || !this.eligible(o) || this.episodeOf(o) !== token.episode)
        throw Error('fallback superseded');
    };
    let since;
    await s.pacer.submit('read', () => { check(); since = c.evSeq; c.requestInventory(); });
    const pack = await c.waitFor({ since, kinds: ['inventory'], timeoutMs: 2000 });
    check();
    if (!pack.events?.length) throw Error('fresh inventory timed out');
    const pick = await this.choose(o, reason); // authoritative pack may have changed ids/types
    if (!pick) return;
    const proof = c.idsAsOf?.();
    const currentIds = () => !c.idsAsOf || idsCurrent(c.idsAsOf()) &&
      c.idsAsOf().saves_seen === proof?.saves_seen;
    if (!currentIds()) throw Error('inventory ids changed generation');
    const item = c.inventory.find(i => i.id === pick.id), potion = this.catalogue().get(pick.name.toLowerCase());
    if (!item || !potion) return;
    await s.pacer.submit('read', () => {
      check(); if (!currentIds()) throw Error('inventory ids changed generation');
      since = c.evSeq; c.look(item.id);
    });
    const seen = await c.waitFor({ since, kinds: ['look'], match: e => e.id === item.id, timeoutMs: 2000 });
    check();
    const look = seen.events?.find(e => e.id === item.id);
    if (!look) throw Error('fresh exact-item inspection timed out');
    const inspectedAt = look.at;
    if (!Number.isFinite(inspectedAt) || inspectedAt > m.now() ||
        m.now() - inspectedAt > CONDITION_MAX_AGE_MS) throw Error('inspection expired');
    const condition = potionCondition(potion, look.description);
    if (!condition.safe) {
      this.rejected.add(item.id);
      this.last = { at: m.now(), item: item.id, effect: pick.effect, status: 'skipped', reason: condition.reason };
      return;
    }
    // This remains a low-priority use packet. A primary queued during inspection
    // runs first; we then see its timer and leave the fallback for another pass.
    await s.pacer.submit('use', () => {
      check();
      if (!o.fallbackReason || !currentIds() || c.inventory.find(i => i.id === item.id) !== item ||
          String(c.rsc?.get?.(item.nameRsc) ?? item.name ?? '').trim() !== pick.name ||
          m.now() - inspectedAt > CONDITION_MAX_AGE_MS || this.primaryAvailable(o) ||
          m.attackReadiness(o, c.room?.objects?.get?.(o.targetId)).timer_remaining_ms > 0) return;
      c.use(item.id);
      m.attackReadyAt = Math.max(m.attackReadyAt ?? 0, m.now() + (potion.post_cast_ms ?? 2000));
      this.nextAt = m.now() + pick.interval;
      this.attempted.add(pick.effect);
      this.last = { at: m.now(), item: item.id, effect: pick.effect, strategy: pick.strategy, status: 'sent' };
      this.history.push(this.last); this.history = this.history.slice(-64);
      o.lastFallback = { ...this.last }; m.record('pvp_fallback_sent', o);
    });
  }
}
