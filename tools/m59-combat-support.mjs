// Opt-in support actions whose KOD path does NOT share the attack timer.
// HealWand -> SpecialWand -> Player.TryApplyItem: same-room User, no LOS,
// facing, range, mana or post-cast timer. UserApply DOES break spell trance.
import { OF, dropSpec } from './m59-parse.mjs';
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
    this.conditions = new Map();
  }
  snapshot() { return { pending: !!this.busy, last: this.last && { ...this.last }, history: this.history.map(r => ({ ...r })) }; }
  eligible(o) {
    const m = this.mode, s = m.s, c = o.client;
    return m.active === o && s.client === c && s.live && c.combatReady !== false && c.state === 'game' &&
      c.self && healthyBody(c.vitals?.()?.health) && s.world?.room?.num > 1 &&
      !!(o.farming ? o.allowed?.() : o.pvp || o.flight || c.room?.objects?.get?.(o.targetId)?.flags & OF.PLAYER) &&
      !s.pacer.holdStatus?.().active && !s._rite;
  }
  items(c, { includeEmpty = false } = {}) {
    const saves = c.idsAsOf?.().saves_seen;
    for (const [id, r] of this.conditions) if (r.client !== c || r.saves !== saves || this.mode.now() - r.at > 30000 ||
      !c.inventory?.some(i => i.id === id)) this.conditions.delete(id);
    for (const [id, r] of this.rejected) if (r.client !== c || r.saves !== saves || r.until <= this.mode.now() ||
      !c.inventory?.some(i => i.id === id)) this.rejected.delete(id);
    return (c.inventory ?? []).filter(i => !this.rejected.has(i.id) && isHealingWand(nameOf(c, i)) &&
      (includeEmpty || !isEmptyHealingWandObject(nameOf(c, i), i)))
      .map(i => ({ id: i.id, name: nameOf(c, i), kind: 'healing_wand',
        condition: isEmptyHealingWandObject(nameOf(c, i), i) ? 'empty' : this.conditions.get(i.id)?.state ?? 'unknown',
        inspected_at: this.conditions.get(i.id)?.at ?? null }));
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
  context(o, items, inspectedId) {
    const m = this.mode, c = o.client;
    return { now: m.now(), agent: m.agentId ?? null, character: c.me?.name ?? m.s.name,
      room: m.s.world?.room?.num, phase: o.phase, pvp: !o.farming, farming: !!o.farming,
      base_below: o.baseBelow ?? m.keeper?.()?.policy?.healWandBelow ?? 0,
      inspected_item: inspectedId, personal_threat: m.personalThreatStatus(), items, targets: this.targets(c) };
  }
  async choose(o, inspectedId = null) {
    const m = this.mode, c = o.client;
    if (!c.inventory?.some(i => isHealingWand(nameOf(c, i)))) return null;
    const loaded = await m.combatStrategies();
    const strategies = (loaded?.strategies ?? []).filter(st => st.enabled &&
      (typeof st.healingWand === 'function' || !o.farming && typeof st.pvpSupport === 'function'));
    if (!strategies.length) return null;
    const items = this.items(c, { includeEmpty: strategies.some(st => typeof st.healingWand === 'function') });
    if (!items.length) return null;
    const ctx = this.context(o, items, inspectedId);
    for (const st of strategies) {
      try {
        let timer, answer;
        const hook = typeof st.healingWand === 'function' ? 'healingWand' : 'pvpSupport';
        try { answer = await Promise.race([Promise.resolve(st[hook](structuredClone(ctx))),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Error('support hook timed out')), 1000); })]); }
        finally { clearTimeout(timer); }
        if (answer == null) continue;
        if (Object.keys(answer).some(k => !['queue', 'interval_ms', 'inspect'].includes(k)) ||
            answer.inspect != null && typeof answer.inspect !== 'boolean' || !Array.isArray(answer.queue) ||
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
          const pick = { ...action, item, target, strategy: st.name, interval: answer.interval_ms,
            stockPolicy: hook === 'healingWand' ? st.healingWand : null };
          if (this.currentTarget(c, pick)) picks.push(pick);
        }
        if (picks.length) return { ...picks[0], alternatives: picks.slice(1) };
        if (hook === 'healingWand' && answer.inspect === true) return { inspect: true, strategy: st.name, interval: answer.interval_ms };
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
    let pick = await this.choose(o);
    if (!pick) return;
    const generation = c.idsAsOf?.();
    const idsOK = () => !c.idsAsOf || idsCurrent(c.idsAsOf()) && c.idsAsOf().saves_seen === generation?.saves_seen;
    // A private opt-in may inspect one unknown wand while healthy. This warms
    // usable-stock evidence without counting an unknown or exhausted item.
    const stock = this.items(c, { includeEmpty: true });
    const candidate = pick.inspect ? stock.find(i => i.condition === 'empty') ?? stock.find(i => i.condition === 'unknown') : null;
    const item = c.inventory.find(i => i.id === (candidate?.id ?? pick.apply));
    if (!item || !idsOK()) return;
    await s.pacer.submit('read', () => { check(); if (!idsOK()) throw Error('ids changed'); since = c.evSeq; c.look(item.id); });
    const reply = await c.waitFor({ since, kinds: ['look'], match: e => e.id === item.id, timeoutMs: 1000 });
    check();
    const look = reply.events?.find(e => e.kind === 'look' && e.id === item.id && e.seq > since);
    if (!look || !Number.isFinite(look.at) || look.at > m.now() || m.now() - look.at > 500)
      throw Error('no fresh charged-wand inspection');
    const condition = healingWandState(look.description);
    this.conditions.set(item.id, { state: condition, at: m.now(), client: c, saves: generation?.saves_seen });
    if (condition !== 'charged') {
      // Operator explicitly requested "dropping and discounting empty wands".
      // Match the existing HealingWands helper: only an exact named, carried
      // healing wand whose fresh LOOK is the KOD zero-charge description.
      if (condition === 'empty') await s.pacer.submit('drop', () => {
        check();
        if (idsOK() && c.inventory.find(i => i.id === item.id) === item &&
            isHealingWand(nameOf(c, item)) && m.now() - look.at <= 500) {
          c.drop([dropSpec(item)]);
          this.last = { at: m.now(), status: 'dropped_empty', item: item.id, strategy: pick.strategy };
        }
      });
      this.rejected.set(item.id, { client: c, saves: generation?.saves_seen,
        until: condition === 'empty' ? Infinity : m.now() + 3000 });
      throw Error(condition === 'empty' ? 'wand exhausted' : 'wand condition unknown');
    }
    const loaded = await m.combatStrategies();
    if (loaded?.strategies?.some(st => st.enabled && typeof st.healingWand === 'function')) {
      pick = await this.choose(o, item.id);
      if (!pick || pick.inspect || pick.apply !== item.id) return;
    }
    // Low-priority APPLY uses the ordinary pacer, with no extra action gap and
    // no reservation of attackReadyAt. A send during spell trance is forbidden.
    await s.pacer.submit('use', () => {
      check();
      if (!idsOK() || c.inventory.find(i => i.id === item.id) !== item || nameOf(c, item) !== pick.item.name ||
          isEmptyHealingWandObject(nameOf(c, item), item) || m.now() - look.at > 500) return;
      let target, appliedLimits;
      // A recipient already covered by another healer must not starve the next
      // wounded ally. Reuse the exact inspected wand for later queue entries.
      for (const candidate of [pick, ...pick.alternatives]) {
        if (candidate.apply !== item.id) continue;
        let limits = candidate;
        if (candidate.stockPolicy) {
          // Stock/HP may change during pacing. The opt-in hook is synchronous
          // at dispatch; a promise/fault declines rather than using old limits.
          try {
            const answer = candidate.stockPolicy(structuredClone(this.context(o, this.items(c, { includeEmpty: true }), item.id)));
            if (answer?.then) { answer.catch?.(() => {}); continue; }
            const action = answer?.queue?.find(a => a.apply === item.id && a.to === candidate.to);
            if (!Number.isFinite(action?.below) || action.below <= 0 || action.below > 1 ||
                !Number.isSafeInteger(action.min_missing) || action.min_missing < 2) continue;
            limits = { ...candidate, below: action.below, min_missing: action.min_missing };
          } catch { continue; }
        }
        const current = this.currentTarget(c, limits);
        if (current && this.claim({ ...s.credentials, character: current.name },
          { room: s.world.room.num, bodyId: current.id, now: m.now() })) { target = current; appliedLimits = limits; break; }
      }
      if (!target) return;
      const charged = this.items(c).filter(i => i.condition === 'charged').length;
      c.apply(item.id, target.id);
      this.conditions.delete(item.id); // the last charge may just have been spent
      this.nextAt = m.now() + pick.interval;
      this.last = { at: m.now(), status: 'sent', item: item.id, target: target.name, target_id: target.id,
        health_before: target.health.value, max_health: target.health.max, report_at: target.at, strategy: pick.strategy,
        below: appliedLimits.below, charged_wands_at_send: charged };
      this.history.push(this.last); this.history = this.history.slice(-32);
      o.lastSupport = { ...this.last }; m.record('pvp_support_sent', o);
    });
  }
}
