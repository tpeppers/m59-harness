// THE NEEDLE: A SINGLE STRIKER AT THE TIP, ARCHERS BEHIND IT, AND A PULL WHEN IT GOES QUIET.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), installed onto Autopilot.prototype by
// `installParts` (tools/autopilot/parts.mjs). Do not import this file directly: import tools/m59-autopilot.mjs, which
// loads it. `autopilotSource()` (tools/autopilot/source.mjs) splices the `@part` block below into the keeper's text.
//
// 12 methods: needleState, needleSite, needleHere, needleSwing, needleWielded, needleArrows, needlePass, needleWalk, needleFight,
//   needlePull, needleTick, needleStatus
//
// Operator, 2026-11-05 (the design, verbatim in tools/m59-needle-farm.mjs): one striker holds the square at the tip of a
// coarse-grid cul-de-sac and swings at the closest valid monster; archers hold squares behind it that no monster can
// step onto or see, and shoot the closest valid monster; when nothing has come to the tip for 15 s the front archer
// steps to a pull square, shoots one monster, and steps back.
//
// WHERE IT IS WIRED, AND WHY HERE. A farm strategy reaches a keeper only as policy keys (m59-strategy-engine.mjs), and
// every farming decision a keeper makes is in `passFarm`. The needle is one strategy field, `needle` -> `policy.needle`,
// and ONE seam in passFarm: after the prey list has been through every filter (confinement, avoid, hunt area, gang-up,
// patrol) and before the ranking, `needlePass` either owns the pass (this keeper has a needle slot in this room) or
// returns null and passFarm goes on exactly as it always did. No `needle`, not in the needle's room, movement leased,
// a reserve whose site says `farm`, an archer with no arrows: null.
//
// WHAT IT NEVER TOUCHES (docs/m59-boundary.md): identity, mortality, survival, recovery. It runs inside passFarm, which
// is below passFleeAndRest and the fight-back rungs, so a striker under its flee line has already been moved by the
// ladder before this runs; that keeper's farm pass stops publishing, its row goes stale, and the next eligible melee
// takes the tip (the replacement rule, `allocate` in m59-needle-farm.mjs). Every fight here is `fight()` with the
// keeper's own flee line as `disengageAt`, and a striker that breaks off retreats through `retreatToSafety`, the same
// call passFarm makes.
import { bodyAuthority } from '../m59-body-command.mjs';
import { allocate, chooseTarget, loadSite, needleBusy, normNeedle, pullDue, readPresence, roleReach, slotOf, sq, writePresence } from '../m59-needle-farm.mjs';
import { OF } from '../m59-parse.mjs';
import { lineOfSight } from '../m59-safespots.mjs';
import * as skills from '../m59-skills.mjs';
import { HANDLED } from '../m59-autopilot.mjs';

const ON = (self, p) => !!self && !!p && self.row === p.row && self.col === p.col;
const ARROWS = /\barrows?\b/i;
const BOW = /\bbow\b/i;

export class NeedlePart {
  // @part 1

  /** The keeper's needle state, never in policy (nothing persists it). */
  needleState() {
    return (this._needle ??= { quietSince: null, lastPassAt: 0, dutyMs: 0, lastTickAt: Date.now(), shots: 0, swings: 0,
      kills: 0, pulls: 0, pullTimes: [], lastPullAt: 0, pull: null, slot: null, currentId: null, alloc: null,
      lastPublishAt: 0, walkFails: 0, mode: null, last: null });
  }

  /** The site object for a normalised needle, from this machine's substrate/needles/ (re-read when the file changes). */
  needleSite(n) {
    if (typeof n.site === 'object') return n.site;
    const now = Date.now(), cache = (this._needleSites ??= new Map());
    const hit = cache.get(n.site);
    if (hit && now - hit.checked < 10_000) return hit.site;
    try {
      const got = loadSite(n.site);
      cache.set(n.site, { site: got.site, mtime: got.mtime, checked: now });
      if (!hit || hit.mtime !== got.mtime) this.note('needle site loaded', { site: n.site, file: got.file, room: got.site.room });
      return got.site;
    } catch (e) {
      // A FILE THAT WILL NOT LOAD IS NOT AN EMPTY SITE (docs/m59-policy.md): keep the last good one if there was one.
      if (!hit?.errorNoted || now - hit.errorNoted > 60_000)
        this.note('needle site refused', { site: n.site, why: e.message, keeping: hit?.site ? 'the last good version' : 'nothing: ordinary farming' });
      cache.set(n.site, { ...(hit ?? {}), checked: now, errorNoted: now });
      return hit?.site ?? null;
    }
  }

  /** `{ site, role }` when this keeper has a needle in this room, else null. */
  needleHere(roomNum) {
    const p = this.policy?.needle;
    if (!p || typeof p !== 'object') return null;
    if (this._needleFor !== p) {
      let norm = null;
      try { norm = normNeedle(p); } catch (e) { this.note('needle order refused', { why: e.message }); norm = null; }
      this._needleFor = p; this._needleNorm = norm; this._needle = null;
    }
    const n = this._needleNorm;
    if (!n) return null;
    const site = this.needleSite(n);
    if (!site || site.room !== Number(roomNum)) return null;
    return { site, role: n.role };
  }

  /** The one exchange: skills.fight, held. A method so the offline test can stand in for the server. */
  needleSwing(s, opts) { return skills.fight(s, opts); }

  /** The name of the weapon in hand, or null. */
  needleWielded() {
    const c = this.s?.client, using = skills.equippedNow(c);
    if (!using) return null;
    const o = (c?.inventory ?? []).find(x => using.has(x.id) && !skills.brokenSet(c).has(x.id));
    return o ? (c.rsc?.get?.(o.nameRsc) || o.name || null) : null;
  }

  /** { arrows, bow }: how many arrows the pack holds and whether it carries a usable bow. */
  needleArrows() {
    const c = this.s?.client;
    let arrows = 0, bow = false;
    for (const o of c?.inventory ?? []) {
      const name = c.rsc?.get?.(o.nameRsc) || o.name || '';
      if (ARROWS.test(name)) arrows += Number(o.amount) || 1;
      else if (BOW.test(name) && !/crossbow/i.test(name) && !skills.brokenSet(c).has(o.id)) bow = true;
    }
    return { arrows, bow };
  }

  /**
   * ONE FARM PASS AT THE NEEDLE. `found` is passFarm's prey list after every filter. Returns HANDLED when the pass was
   * spent here, null to let passFarm decide as it always did.
   */
  async needlePass(ctx, found, needle) {
    const { s, c, room, v } = ctx;
    const { site, role } = needle;
    const self = c?.self;
    if (!self) return null;
    if (this.facultyHeld('movement')) {
      const owner = this.facultyOwner('movement');
      if (this._needleHeldNoted !== owner) {
        this._needleHeldNoted = owner;
        this.note('needle paused: movement is leased', { owner, why: 'the holder decides where this body stands' });
      }
      return null;
    }
    this._needleHeldNoted = null;
    const st = this.needleState(), now = Date.now(), me = this.s.name;
    if (st.lastPassAt && now - st.lastPassAt <= 120_000) st.dutyMs += now - st.lastPassAt;   // gaps over 2 min are not duty
    st.lastPassAt = now;
    st.quietSince ??= now;

    // VALID: the prey passFarm chose (hunt list, confinement, karma and the rest already applied), plus anything that can
    // hit us right now and is neither spared nor forbidden by karma. Never a player (findCreature and inReachOfUs both
    // drop OF.PLAYER), so never a fleet-mate.
    const byId = new Map();
    for (const o of found ?? []) if (o && !(o.flags & OF.PLAYER)) byId.set(o.id, o);
    for (const o of this.inReachOfUs?.() ?? []) {
      const name = c.rsc?.get?.(o.nameRsc) || o.name || '';
      if (this.sparedHere?.(o) || this.karmaForbids?.(name)) continue;
      byId.set(o.id, o);
    }
    const valid = [...byId.values()];
    if (needleBusy(site, valid)) st.quietSince = now;

    // FITNESS, AS THIS KEEPER SEES ITSELF -- the only health anybody publishes.
    const health = v?.health?.max ? v.health.value / v.health.max : null;
    const fleeAt = Number(this.safety?.()?.fleeAt) || 0;
    let fit = true, whyUnfit = null;
    const ammo = role === 'archer' ? this.needleArrows() : null;
    if (role === 'striker' && health != null && health < Math.max(site.striker.minHealth, fleeAt + 0.05)) {
      fit = false; whyUnfit = `health ${Math.round(health * 100)}% under the striker floor`;
    } else if (role === 'archer') {
      if (health != null && health < Math.max(site.archers.minHealth, fleeAt)) { fit = false; whyUnfit = `health ${Math.round(health * 100)}%`; }
      else if (!ammo.bow) { fit = false; whyUnfit = 'no usable bow'; }
      else if (ammo.arrows < site.archers.minArrows) { fit = false; whyUnfit = `${ammo.arrows} arrows`; }
    }

    let rows = [];
    try { rows = readPresence(site.name); } catch { rows = []; }
    const mine = { role, room: site.room, fit, why_unfit: whyUnfit, health, slot: st.slot, row: self.row, col: self.col, pull: st.pull };
    rows = rows.filter(r => r?.agent !== me).concat([{ ...mine, agent: me, at: now }]);
    const alloc = allocate(site, rows, { now });
    const slot = slotOf(alloc, me);
    const changed = slot.slot !== st.slot;
    st.slot = slot.slot; st.alloc = alloc;
    if (changed || now - st.lastPublishAt > 2_000) {
      try { writePresence(site.name, me, { ...mine, slot: slot.slot }, { now }); st.lastPublishAt = now; }
      catch (e) { if (!this._needleWriteSaid) { this._needleWriteSaid = true; this.note('needle row not written', { why: e.message }); } }
    }
    if (changed) this.note('needle slot', { site: site.name, slot: slot.slot ?? 'none', role, mode: alloc.mode,
      striker: alloc.striker, archers: alloc.archers.map(a => `${a.agent}@${sq(a.station)}`), why_unfit: whyUnfit ?? undefined });
    if (alloc.mode !== st.mode) {
      st.mode = alloc.mode;
      this.note(alloc.money_losing ? 'needle running archers-only: MONEY-LOSING' : 'needle mode', { site: site.name, mode: alloc.mode, why: alloc.why });
    }
    this.needleTick(site, role, ammo);

    // Unfit striker: the bench. Unfit archer (no arrows, no bow, hurt): ordinary farming, which is where the normal
    // restock answers (the island coordinator's sticky archers, the town trip); fit again, it walks back to its station.
    if (slot.role === 'none' && role === 'archer') return null;
    if (slot.role === 'reserve' || (slot.role === 'none' && role === 'striker')) {
      if (site.reserve.mode !== 'hold') return null;
      const i = Math.max(0, alloc.reserve.indexOf(me));
      const spot = site.reserve.squares[i % site.reserve.squares.length];
      if (!ON(self, spot)) return this.needleWalk(spot, 'to the needle bench');
      this.doing = 'waiting'; this.emptyPasses = 0;
      return HANDLED;
    }

    // THE STATION. A striker steps to its pull step while its front archer's pull is out (the operator: "the melee
    // striker can step forward/aside, and the bower in the front can step out ... before returning to their station
    // (and the melee striker to their station)").
    let station = slot.role === 'striker' ? site.striker.station : slot.station;
    if (slot.role === 'striker' && site.striker.pullStep && alloc.puller?.role === 'archer') {
      const pr = rows.find(r => r.agent === alloc.puller.agent)?.pull;
      if (pr?.phase === 'out' && now - Number(pr.at) < site.pull.excursionS * 1000) station = site.striker.pullStep;
    }
    if (!ON(self, station)) return this.needleWalk(station, slot.role === 'striker' ? 'to the needle tip' : `to archer station ${slot.index + 1}`);
    st.walkFails = 0;

    // THE CLOSEST VALID MONSTER IN REACH, re-chosen every pass. Never a chase: fight() is held to this square.
    const wielded = this.needleWielded();
    const reach = roleReach(site, slot.role, wielded);
    const geo = s.world?.geometry;
    const los = slot.role === 'archer' && geo ? o => lineOfSight(geo, self.row, self.col, o.row, o.col, { fine: false }) : null;
    const pick = chooseTarget(valid, self, { reach, currentId: st.currentId, los });
    if (pick.target) return this.needleFight(ctx, pick.target, { site, role: slot.role, reach, seen: pick.seen });

    // NOTHING AT THE TIP. The puller decides whether to fetch something; everyone else waits on station.
    if (alloc.puller?.agent === me) {
      const lastPullAt = Math.max(st.lastPullAt, ...rows.map(r => Number(r.pull?.done_at) || 0));
      const due = pullDue({ site, now, quietSince: st.quietSince, lastPullAt, pullTimes: st.pullTimes, health: health ?? 1,
        attacked: (this.inReachOfUs?.() ?? []).length > 0, visible: valid.length });
      st.last = { at: now, pull: due };
      if (due.due) return this.needlePull(ctx, { site, role: slot.role, from: alloc.puller.from, station, valid });
    }
    this.doing = 'waiting'; this.emptyPasses = 0;
    if (!this._needleWaitSaid || now - this._needleWaitSaid > 60_000) {
      this._needleWaitSaid = now;
      this.note('holding the needle', { site: site.name, slot: slot.slot, at: sq(self), reach, quiet_s: Math.round((now - st.quietSince) / 1000),
        valid_in_room: valid.length, pull: st.last?.pull?.why ?? (alloc.puller ? `puller ${alloc.puller.agent}` : 'nobody can pull') });
    }
    return HANDLED;
  }

  /** A bounded walk to a needle square. Three failures in a row hand the pass back to ordinary farming for it. */
  async needleWalk(to, why) {
    const s = this.s, st = this.needleState();
    const left = await this.leaveHold?.(`walking ${why}`).catch(e => ({ refused: true, why: e.message }));
    if (left?.refused) { this.doing = 'waiting'; return HANDLED; }
    this.doing = 'taking the needle';
    const w = await s.walkTo(to.col, to.row, { maxSteps: 24 }).catch(e => ({ arrived: false, steps: 0, reason: e.message }));
    const self = s.client?.self;
    if (ON(self, to) || w?.arrived) { st.walkFails = 0; this.progress(`walked ${why}`); return HANDLED; }
    st.walkFails = (st.walkFails ?? 0) + 1;
    if (st.walkFails >= 3) {
      this.note('needle: cannot reach my square', { to: sq(to), at: sq(self), why: w?.reason ?? null, attempts: st.walkFails,
        consequence: 'ordinary farming decides this pass; the walk is tried again next pass' });
      st.walkFails = 0;
      return null;
    }
    this.noProgress(`needle walk ${why} did not arrive: ${w?.reason ?? 'no reason given'}`);
    return HANDLED;
  }

  /** One held exchange at the chosen target, recorded exactly as a passFarm fight is. */
  async needleFight(ctx, target, { site, role, reach, seen = null }) {
    const { s, c, room, v } = ctx;
    const st = this.needleState();
    const name = c.rsc?.get?.(target.nameRsc) || target.name || '';
    // THE SAME TRAINING GATE passFarm uses: an archer is a trainee, and a style the regimen cannot honour refuses the swing.
    const trainingPrey = this.isTrainingPrey?.(name) ?? false;
    const style = trainingPrey ? this.trainingStyleFor(target.id) : this.styleForNonPrey(room);
    const training = await this.prepareTrainingStyle(style, target.id).catch(e => ({ ready: false, why: e.message, style }));
    if (!training.ready) {
      this.note('needle: training bout could not start', { target_id: target.id, style, why: training.why });
      this.noProgress(`training ${style} unavailable: ${training.why}`);
      return HANDLED;
    }
    this.farmStrategyHook?.('beforeSwing', { target: name, target_id: target.id, room: room?.num ?? null });
    await this.farmBuffAsk?.('before_swing', { target: name }).catch(() => null);
    if (this.touchTrainingHere?.()) await this.maintainTouchSpell(`before swinging at ${name}`).catch(() => null);
    const safe = this.safety();
    this.doing = role === 'striker' ? 'striking at the needle' : 'shooting at the needle';
    this.farmCombat = { at: Date.now(), pending: true, target: name, target_id: target.id, holding: true, needle: role };
    const f = await this.needleSwing(s, { target: name, match: () => true, preferId: target.id, exactTargetId: target.id,
      disengageAt: safe.fleeAt, loot: true, holdPosition: true, reach, equip: training.equip,
      rounds: Math.min(site.rounds, training.rounds ?? site.rounds),
      weaponPriority: this.weaponPriorityNow(name), bannedWeapons: this.bannedWeaponsNow() });
    try { bodyAuthority(s).guard(); } catch (error) {
      this.recordInterruptedFarmOutcome(f, { room, holding: false, preempted: error.code ?? error.message });
      return HANDLED;
    }
    this.farmCombat = { at: Date.now(), pending: false, target: name, target_id: target.id, holding: true, needle: role,
      killed: !!f.killed, died: !!f.died, out_of_reach: !!f.out_of_reach, reason: f.reason ?? f.why ?? null, rounds: f.rounds ?? null };
    if (trainingPrey && (f.killed || f.died)) this.finishTrainingBout(target.id);
    const rounds = Number(f.rounds) || 0;
    if (role === 'archer') st.shots += rounds; else st.swings += rounds;
    st.currentId = f.killed ? null : (f.foe_id ?? target.id);
    if (f.killed) st.kills++;
    if (f.out_of_reach || f.fought === false) {
      // It stepped out of reach between the choice and the swing: the next pass chooses again. Not a failure.
      this.noProgress(`needle: ${f.reason ?? 'the target left reach'}`);
      return HANDLED;
    }
    if (f.stale_identity) {
      this.note('stale object id during a needle fight -- reconnecting', { why: f.note });
      await this.reconnect('clearing a stale object id mid-fight');
      this.noProgress('reconnected after a stale object id');
      return HANDLED;
    }
    if (f.disengaged) {
      // A STRIKER THAT BREAKS OFF LEAVES THE TIP: the tip is in monster reach by design. An archer's square is not, so
      // it rests where it stands (nothing there can swing at it) and the survival ladder decides the rest next pass.
      if (role === 'striker' || f.disengaged.unarmed) {
        const away = await this.retreatToSafety({ because: f.disengaged.reason ?? `broke off at the needle tip at ${f.disengaged.at_health ?? '?'}`,
          mid_round: !!f.disengaged.mid_round, unarmed: !!f.disengaged.unarmed, still_here: (this.inReachOfUs?.() ?? []).length });
        if (away?.arrived) this.progress('left the needle tip to recover');
        else this.noProgress('broke off at the needle and could not retreat: ' + (away?.refused ?? 'no reason given'));
        return HANDLED;
      }
      this.note('broke off at an archer station -- resting on it', { at_health: f.disengaged.at_health,
        why: 'no monster square can reach or see this square, so standing still is the recovery' });
    }
    await this.recordFarmFightOutcome(f, { room, v, holding: false,
      extra: { needle: { site: site.name, role, ...(seen != null ? { sight: seen } : {}) } } });
    return HANDLED;
  }

  /**
   * THE PULL: out to the pull square, one shot (or one swing from a striker's pull step) at the valid monster nearest it,
   * back to the station. One pass, bounded by the walks' own step budgets and `pull.excursionS`. Every pull is counted
   * whether or not it found anything, so a pull that fetches nothing cannot repeat faster than the rate limit.
   */
  async needlePull(ctx, { site, role, from, station, valid }) {
    const { s, c } = ctx;
    const st = this.needleState(), started = Date.now(), me = this.s.name;
    st.pull = { phase: 'out', at: started };
    try { writePresence(site.name, me, { ...(readPresence(site.name).find(r => r.agent === me) ?? {}), pull: st.pull }, { now: started }); } catch { /* best effort */ }
    const out = { at: started, from: sq(from), shot: null, back: false, why: null };
    try {
      this.doing = 'pulling to the needle';
      if (!ON(c.self, from)) {
        const w = await s.walkTo(from.col, from.row, { maxSteps: site.pull.legSteps }).catch(e => ({ arrived: false, reason: e.message }));
        if (!ON(c.self, from) && !w?.arrived) { out.why = `could not reach the pull square: ${w?.reason ?? 'no reason'}`; return HANDLED; }
      }
      if (Date.now() - started > site.pull.excursionS * 1000) { out.why = 'excursion budget spent walking out'; return HANDLED; }
      const self = c.self, geo = s.world?.geometry;
      const reach = roleReach(site, role, this.needleWielded());
      const los = geo ? o => lineOfSight(geo, self.row, self.col, o.row, o.col, { fine: false }) : null;
      const live = valid.map(o => c.room?.objects?.get?.(o.id) ?? o).filter(Boolean);
      const pick = chooseTarget(live, self, { reach, los });
      if (!pick.target) { out.why = 'nothing valid in reach of the pull square'; return HANDLED; }
      const name = c.rsc?.get?.(pick.target.nameRsc) || pick.target.name || '';
      const f = await this.needleSwing(s, { target: name, match: () => true, exactTargetId: pick.target.id, preferId: pick.target.id,
        disengageAt: this.safety().fleeAt, loot: false, holdPosition: true, reach, rounds: 1,
        weaponPriority: this.weaponPriorityNow(name), bannedWeapons: this.bannedWeaponsNow() });
      out.shot = { target: name, id: pick.target.id, at: sq(pick.target), rounds: f.rounds ?? 0, landed: f.landed_hits ?? 0, sight: pick.seen };
      if (role === 'archer') st.shots += Number(f.rounds) || 0; else st.swings += Number(f.rounds) || 0;
    } finally {
      const back = await s.walkTo(station.col, station.row, { maxSteps: site.pull.legSteps + 8 }).catch(e => ({ arrived: false, reason: e.message }));
      out.back = ON(c.self, station) || !!back?.arrived;
      const done = Date.now();
      st.pull = { phase: 'done', at: started, done_at: done };
      st.lastPullAt = done; st.pullTimes = [...st.pullTimes.filter(t => done - t < 600_000), done]; st.pulls++;
      st.quietSince = done;                         // the clock restarts: the pulled monster needs time to walk in
      try { writePresence(site.name, me, { ...(readPresence(site.name).find(r => r.agent === me) ?? {}), pull: st.pull }, { now: done }); } catch { /* best effort */ }
      out.ms = done - started;
      this.note('needle pull', out);
      this.ledgerEvent('needle_pull', { site: site.name, role, ...out });
      if (out.shot) this.progress('pulled a monster to the needle'); else this.noProgress(`needle pull: ${out.why}`);
    }
    return HANDLED;
  }

  /** The economics row, every econ.tickMin minutes of duty: the denominator every rate in `econ` divides by. */
  needleTick(site, role, ammo = null) {
    const st = this.needleState(), now = Date.now();
    if (now - st.lastTickAt < site.econ.tickMin * 60_000) return;
    const minutes = st.dutyMs / 60_000;
    if (minutes > 0) {
      const c = this.s?.client;
      const purse = (c?.inventory ?? []).filter(o => /\bshillings?\b/i.test(c.rsc?.get?.(o.nameRsc) || o.name || ''))
        .reduce((n, o) => n + (Number(o.amount) || 0), 0);
      this.ledgerEvent('needle_duty', { site: site.name, room: site.room, role, slot: st.slot, mode: st.mode,
        minutes: +minutes.toFixed(2), shots: st.shots, swings: st.swings, kills: st.kills, pulls: st.pulls,
        arrows: ammo?.arrows ?? this.needleArrows().arrows, shillings: purse });
    }
    st.dutyMs = 0; st.shots = 0; st.swings = 0; st.kills = 0; st.pulls = 0; st.lastTickAt = now;
  }

  /** Status: the site, this keeper's slot and the allocation it last computed. Null when no needle is ordered. */
  needleStatus() {
    const p = this.policy?.needle;
    if (!p || typeof p !== 'object') return null;
    const n = this._needleNorm, st = this._needle;
    const site = n ? (typeof n.site === 'object' ? n.site : this._needleSites?.get(n.site)?.site ?? null) : null;
    return { site: site?.name ?? (typeof p.site === 'string' ? p.site : null), room: site?.room ?? null, role: n?.role ?? p.role ?? null,
      slot: st?.slot ?? null, mode: st?.mode ?? null, money_losing: !!st?.alloc?.money_losing,
      striker: st?.alloc?.striker ?? null, archers: (st?.alloc?.archers ?? []).map(a => ({ agent: a.agent, station: sq(a.station) })),
      puller: st?.alloc?.puller?.agent ?? null, reserve: st?.alloc?.reserve ?? [],
      quiet_s: st?.quietSince ? Math.round((Date.now() - st.quietSince) / 1000) : null,
      last_pull: st?.lastPullAt || null, pulls_10m: (st?.pullTimes ?? []).filter(t => Date.now() - t < 600_000).length,
      last: st?.last ?? null };
  }
  // @end 1
}
