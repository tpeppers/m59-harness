// Opt-in support actions whose KOD path does NOT share the attack timer.
// HealWand -> SpecialWand -> Player.TryApplyItem: same-room User, no LOS,
// facing, range, mana or post-cast timer. UserApply DOES break spell trance.
import { OF } from './m59-parse.mjs';
import { idsCurrent } from './m59-idgen.mjs';
import { isHealingWand, isEmptyHealingWandObject, healingWandState } from './m59-healing-wands.mjs';
import { readFleetHealth } from './m59-fleet-health.mjs';
import { claimFleetHeal } from './m59-heal-claims.mjs';

const nameOf = (c, o) => String(c.rsc?.get?.(o?.nameRsc) ?? o?.name ?? '').trim();
const fold = n => String(n).trim().toLowerCase();
const healthyBody = h => h?.value > 0 && h.max >= h.value && Number.isFinite(h.max);
export class CombatSupport {
  constructor(mode, { health = readFleetHealth, claim = claimFleetHeal } = {}) {
    this.mode = mode; this.health = health; this.claim = claim;
    this.busy = null; this.nextAt = 0; this.last = null; this.history = []; this.rejected = new Map();
  }
  snapshot() { return { pending: !!this.busy, last: this.last && { ...this.last }, history: this.history.map(r => ({ ...r })) }; }
  eligible(o) {
    const m = this.mode, s = m.s, c = o.client;
    return m.active === o && s.client === c && s.live && c.combatReady !== false && c.state === 'game' &&
      c.self && healthyBody(c.vitals?.()?.health) && s.world?.room?.num > 1 &&
      !!(o.pvp || o.flight || c.room?.objects?.get?.(o.targetId)?.flags & OF.PLAYER) &&
      !s.pacer.holdStatus?.().active && !s._rite;
  }
  items(c) {
    const saves = c.idsAsOf?.().saves_seen;
    for (const [id, r] of this.rejected) if (r.client !== c || r.saves !== saves || r.until <= this.mode.now() ||
      !c.inventory?.some(i => i.id === id)) this.rejected.delete(id);
    return (c.inventory ?? []).filter(i => !this.rejected.has(i.id) && isHealingWand(nameOf(c, i)) && !isEmptyHealingWandObject(nameOf(c, i), i))
      .map(i => ({ id: i.id, name: nameOf(c, i), kind: 'healing_wand' }));
  }
  targets(c) {
    const m = this.mode, s = m.s, now = m.now(), room = s.world?.room?.num;
    const targets = [];
    const selfHealth = c.vitals?.()?.health;
    if (healthyBody(selfHealth)) targets.push({ id: c.selfId, name: c.me?.name ?? s.name, self: true, health: { ...selfHealth }, at: now });
    if (!s.credentials?.host) return targets;
    for (const o of c.room?.objects?.values?.() ?? []) {
      const name = nameOf(c, o);
      if (o.id === c.selfId || !(o.flags & OF.PLAYER) || !name || !m.isOurs(name)) continue;
      const report = this.health({ ...s.credentials, character: name }, { room, bodyId: o.id, now, maxAgeMs: 1500 });
      if (report && healthyBody(report.health)) targets.push({ id: o.id, name, self: false, health: { ...report.health }, at: report.at });
    }
    return targets;
  }
  currentTarget(c, pick) {
    return this.targets(c).find(t => t.id === pick.to && fold(t.name) === fold(pick.target.name) &&
      t.self === pick.target.self && t.health.value / t.health.max < pick.below &&
      t.health.max - t.health.value >= pick.min_missing);
  }
  async choose(o) {
    const m = this.mode, c = o.client;
    const items = this.items(c);
    if (!items.length) return null;
    const loaded = await m.combatStrategies();
    const strategies = (loaded?.strategies ?? []).filter(st => st.enabled && typeof st.pvpSupport === 'function');
    if (!strategies.length) return null;
    const ctx = { now: m.now(), agent: m.agentId ?? null, character: c.me?.name ?? m.s.name,
      room: m.s.world?.room?.num, phase: o.phase, pvp: true, personal_threat: m.personalThreatStatus(),
      items, targets: this.targets(c) };
    if (!ctx.targets.some(t => t.health.value < t.health.max)) return null;
    for (const st of strategies) {
      try {
        let timer, answer;
        try { answer = await Promise.race([Promise.resolve(st.pvpSupport(structuredClone(ctx))),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Error('support hook timed out')), 1000); })]); }
        finally { clearTimeout(timer); }
        if (answer == null) continue;
        if (Object.keys(answer).some(k => !['queue', 'interval_ms'].includes(k)) || !Array.isArray(answer.queue) ||
            answer.queue.length > 64 || !Number.isSafeInteger(answer.interval_ms) || answer.interval_ms < 1000 || answer.interval_ms > 60000)
          throw Error('expected support queue and interval_ms: 1000..60000');
        const picks = [];
        for (const action of answer.queue) {
          if (!action || Object.keys(action).some(k => !['apply', 'to', 'below', 'min_missing'].includes(k)) ||
              !Number.isSafeInteger(action.apply) || !Number.isSafeInteger(action.to) ||
              !Number.isFinite(action.below) || action.below <= 0 || action.below > 1 ||
              !Number.isSafeInteger(action.min_missing) || action.min_missing < 2)
            throw Error('support action requires apply, to, below and min_missing');
          const item = ctx.items.find(i => i.id === action.apply), target = ctx.targets.find(t => t.id === action.to);
          if (!item || !target) throw Error('support selected an unknown wand or unobserved fleet target');
          const pick = { ...action, item, target, strategy: st.name, interval: answer.interval_ms };
          if (this.currentTarget(c, pick)) picks.push(pick);
        }
        if (picks.length) return { ...picks[0], alternatives: picks.slice(1) };
      } catch (e) { this.last = { at: m.now(), status: 'strategy_fault', strategy: st.name, reason: e.message }; }
    }
    return null;
  }
  offer(o) {
    const m = this.mode;
    if (!this.eligible(o)) return;
    if (this.busy && (this.busy.o !== o || this.busy.phase !== o.phaseRevision)) this.busy = null;
    if (this.busy || m.now() < this.nextAt) return;
    const token = { o, phase: o.phaseRevision };
    this.busy = token; this.nextAt = m.now() + 1000;
    this.task = this.prepare(o, token).catch(e => {
      if (this.busy === token) this.last = { at: m.now(), status: 'skipped', reason: e.message };
    }).finally(() => { if (this.busy === token) this.busy = null; });
  }
  async prepare(o, token) {
    const m = this.mode, s = m.s, c = o.client, room = c.room.id, body = c.selfId;
    if (!await this.choose(o)) return;
    const check = () => {
      if (this.busy !== token || !this.eligible(o) || o.phaseRevision !== token.phase || c.room.id !== room || c.selfId !== body)
        throw Error('support superseded');
    };
    let since;
    await s.pacer.submit('read', () => { check(); since = c.evSeq; c.requestInventory(); });
    const pack = await c.waitFor({ since, kinds: ['inventory'], timeoutMs: 1000 });
    check();
    if (!pack.events?.some(e => e.kind === 'inventory' && e.seq > since)) throw Error('fresh inventory timed out');
    const pick = await this.choose(o);
    if (!pick) return;
    const generation = c.idsAsOf?.();
    const idsOK = () => !c.idsAsOf || idsCurrent(c.idsAsOf()) && c.idsAsOf().saves_seen === generation?.saves_seen;
    const item = c.inventory.find(i => i.id === pick.apply);
    if (!item || !idsOK()) return;
    await s.pacer.submit('read', () => { check(); if (!idsOK()) throw Error('ids changed'); since = c.evSeq; c.look(item.id); });
    const reply = await c.waitFor({ since, kinds: ['look'], match: e => e.id === item.id, timeoutMs: 1000 });
    check();
    const look = reply.events?.find(e => e.kind === 'look' && e.id === item.id && e.seq > since);
    if (!look || !Number.isFinite(look.at) || look.at > m.now() || m.now() - look.at > 500)
      throw Error('no fresh charged-wand inspection');
    const condition = healingWandState(look.description);
    if (condition !== 'charged') {
      this.rejected.set(item.id, { client: c, saves: generation?.saves_seen,
        until: condition === 'empty' ? Infinity : m.now() + 3000 });
      throw Error(condition === 'empty' ? 'wand exhausted' : 'wand condition unknown');
    }
    // Low-priority APPLY uses the ordinary pacer, with no extra action gap and
    // no reservation of attackReadyAt. A send during spell trance is forbidden.
    await s.pacer.submit('use', () => {
      check();
      if (!idsOK() || c.inventory.find(i => i.id === item.id) !== item || nameOf(c, item) !== pick.item.name ||
          isEmptyHealingWandObject(nameOf(c, item), item) || m.now() - look.at > 500) return;
      let target;
      // A recipient already covered by another healer must not starve the next
      // wounded ally. Reuse the exact inspected wand for later queue entries.
      for (const candidate of [pick, ...pick.alternatives]) {
        if (candidate.apply !== item.id) continue;
        const current = this.currentTarget(c, candidate);
        if (current && this.claim({ ...s.credentials, character: current.name },
          { room: s.world.room.num, bodyId: current.id, now: m.now() })) { target = current; break; }
      }
      if (!target) return;
      c.apply(item.id, target.id);
      this.nextAt = m.now() + pick.interval;
      this.last = { at: m.now(), status: 'sent', item: item.id, target: target.name, target_id: target.id,
        health_before: target.health.value, max_health: target.health.max, report_at: target.at, strategy: pick.strategy };
      this.history.push(this.last); this.history = this.history.slice(-32);
      o.lastSupport = { ...this.last }; m.record('pvp_support_sent', o);
    });
  }
}
