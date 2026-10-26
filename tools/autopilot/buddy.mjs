// BUDDY FARMING: tagger and killer.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 8 methods: buddyRole, buddyVetoes, buddyPublish, buddyRoomObjects, buddyReadLanded, passBuddy,
//   passBuddyTag, passBuddyKill
import * as buddySys from '../m59-buddy.mjs';
import { classifyCombatLine as classifyBuddyLine } from '../m59-combatlog.mjs';
import { OF } from '../m59-parse.mjs';
import { PLAYER_REACH } from '../m59-safespots.mjs';
import { CONTINUE, HANDLED } from '../m59-autopilot.mjs';

export class BuddyPart {
  // @part 1

  // ---------------------------------------------------------------- THE BUDDY SYSTEM
  //
  // Operator, 2026-10-09 (the "Qor buddy system"): a TAGGER picks an untouched monster, lands one
  // blow, walks back to its wall and stands there; its fixed partner, the KILLER, stands beside that
  // wall and kills it. The tagger's max-health roll is credited (it was the tagger's last target, it
  // did damage, it stayed in the room) and its karma does not move (only the killer's does). The
  // kod for each of those clauses is in m59-buddy.mjs's header.
  //
  // WHAT THIS RUNG IS NOT ALLOWED TO DO: anything protected. It sits below passFleeAndRest, so a
  // tagger below its flee line has already been moved by the ladder before this runs, and the veto
  // below refuses only ATTACK packets -- never a step, a rest or a flee. A tagger that loses its
  // killer, its room or its patience stops waiting and drops the tag; it never stands in a fight
  // nobody is going to finish.
  buddyRole() {
    let cfg = null;
    try { cfg = buddySys.normalizeBuddy(this.policy?.buddy ?? null); } catch { cfg = null; }
    const r = cfg ? buddySys.roleIn(cfg, this.s?.name) : null;
    return r ? { ...r, cfg } : null;
  }

  /** The attack veto a tagger installs: while a tag is out, nothing else may be swung at, and once
   *  it has landed not even the tag (the killing blow is the partner's -- and the karma with it). */
  buddyVetoes(id) {
    const t = this.buddyTag;
    if (!t || this.mode !== 'farm' || this.buddyRole()?.role !== 'tag') return false;
    if (id !== t.id) return true;
    return !!t.landed;
  }

  buddyPublish(rec) {
    try { buddySys.writeBuddyRecord(this.s.name, rec); }
    catch (e) {
      if (!this._buddyWriteSaid) { this._buddyWriteSaid = true; this.note('buddy record not written', { why: e.message }); }
    }
  }

  buddyRoomObjects() {
    const c = this.s.client, out = { monsters: [], players: [] };
    for (const o of c?.room?.objects?.values?.() ?? []) {
      if (o.row == null || o.col == null) continue;
      if (o.flags & OF.PLAYER) { if (o.id !== c.selfId) out.players.push({ id: o.id, row: o.row, col: o.col }); continue; }
      if (!(o.flags & OF.ATTACKABLE)) continue;
      out.monsters.push({ id: o.id, row: o.row, col: o.col, name: c.rsc?.get?.(o.nameRsc) ?? o.name ?? '' });
    }
    return out;
  }

  /** Our own combat lines since the last look: did the tag land? */
  buddyReadLanded() {
    const c = this.s.client, t = this.buddyTag;
    if (!c?.eventsSince) return false;
    let evs = [];
    try { evs = c.eventsSince(this._buddyCursor ?? c.evSeq ?? 0) ?? []; } catch { evs = []; }
    if (Number.isFinite(c.evSeq)) this._buddyCursor = c.evSeq;
    const name = t?.name ?? this._buddyPendingName;
    if (!name) return false;
    for (const e of evs) {
      if (e?.kind !== 'message' || typeof e.text !== 'string') continue;
      let parsed = null;
      try { parsed = classifyBuddyLine(e.text); } catch { parsed = null; }
      if (buddySys.tagLanded(parsed, name)) return true;
    }
    return false;
  }
  // @end 1

  // @part 2

  async passBuddy(ctx) {
    const role = this.mode === 'farm' ? this.buddyRole() : null;
    if (!role) { if (this.buddyTag) this.buddyTag = null; return CONTINUE; }
    // A bot or lease holding `work` chooses the quarry; the buddy system is a way of choosing it.
    const owner = this.facultyOwner?.('work') ?? 'keeper';
    if (owner !== 'keeper' && !String(owner).startsWith('combat:')) return CONTINUE;
    const { s } = ctx;
    const room = this.hereRoom();
    // In the room it was posted to, or the farm's own travel takes it there first.
    if (this.policy.assignedRoom && room !== Number(this.policy.assignedRoom)) {
      this.buddyTag = null;
      return CONTINUE;
    }
    if (this.buddyRoomNum !== room) { this.buddyRoomNum = room; this.buddyTagged = new Map(); this.buddyTag = null; }
    // Installed on the session: the client asks it on every attack packet (m59-game attackVeto).
    if (s && s.buddyVeto !== this._buddyVetoFn) {
      this._buddyVetoFn = id => this.buddyVetoes(id);
      s.buddyVeto = this._buddyVetoFn;
    }
    return role.role === 'tag' ? this.passBuddyTag(ctx, role, room) : this.passBuddyKill(ctx, role, room);
  }

  async passBuddyTag(ctx, role, room) {
    const { c } = ctx;
    const me = c.self;
    const cfg = role.cfg;
    const mate = buddySys.readBuddyRecord(role.partner);
    const publish = () => this.buddyPublish({ role: 'tag', partner: role.partner, room,
      hold: this.hold ? { col: this.hold.col, row: this.hold.row } : null,
      tag: this.buddyTag ? { id: this.buddyTag.id, name: this.buddyTag.name, landed: !!this.buddyTag.landed,
                             at: this.buddyTag.at } : null });
    if (this.buddyTag && !this.buddyTag.landed && this.buddyReadLanded()) {
      this.buddyTag.landed = true;
      this.note('buddy: tag landed', { target: this.buddyTag.name, partner: role.partner });
    }
    // 1. A WALL TO PULL TO. The killer comes to stand beside it.
    if (!this.hold) {
      this.doing = 'buddy: finding a corner';
      await this.takeSafeSpot('buddy system: a corner to pull to', null, { nearestOnly: true }).catch(() => null);
      publish();
      return HANDLED;
    }
    // 2. A TAG OUT: wait for it to die; swing at it again only until one blow lands.
    const t = this.buddyTag;
    if (t) {
      const live = c.room?.objects?.get?.(t.id);
      const alive = !!(live && (live.flags & OF.ATTACKABLE));
      if (!alive) {
        this.note('buddy: tag is gone', { target: t.name, landed: !!t.landed,
          waited_s: Math.round((Date.now() - t.at) / 1000),
          why: t.landed ? 'killed (or left) -- the roll, if any, was the server\'s'
                        : 'gone before a blow landed' });
        if (t.landed) this.tally.buddyAssists = (this.tally.buddyAssists || 0) + 1;
        this.buddyTag = null;
        publish();
        return HANDLED;
      }
      if (Date.now() - t.at > cfg.wait_s * 1000) {
        this.note('buddy: gave up waiting', { target: t.name, landed: !!t.landed, wait_s: cfg.wait_s });
        this.buddyTag = null;
        publish();
        return HANDLED;
      }
      const adjacent = me && Math.max(Math.abs(live.row - me.row), Math.abs(live.col - me.col)) <= 1;
      if (!t.landed && adjacent && (t.tries ?? 0) < cfg.tries) {
        // It followed us in and nothing has landed yet: the same target, so a swing keeps the tag.
        t.tries = (t.tries ?? 0) + 1;
        this.doing = 'buddy: tagging';
        // A TOUCH SPELL IN TRAINING IS THE WEAPON HERE TOO. passFarm keeps the buff on before every
        // swing; the tagger swings through fightNow and pull() instead, so without this the hand was
        // emptied and the buff never cast — Bunsen tagged with his fists (2026-10-10).
        if (this.touchTrainingHere())
          await this.maintainTouchSpell(`before tagging ${t.name}`)
            .catch(e => { const st = this.touchState(); if (st) st.blockedReason = e.message; });
        await this.fightNow({ target: t.name, exactTargetId: t.id, preferId: t.id, rounds: 1,
          holdPosition: true, reach: PLAYER_REACH, loot: false, disengageAt: this.safety().fleeAt,
          match: () => true, weaponPriority: this.weaponPriorityNow?.(t.name),
          bannedWeapons: this.bannedWeaponsNow?.() }).catch(() => null);
        if (this.buddyReadLanded()) { t.landed = true; this.note('buddy: tag landed', { target: t.name, partner: role.partner }); }
      } else {
        this.doing = t.landed ? 'buddy: waiting for the kill' : 'buddy: waiting for the tag to come in';
      }
      publish();
      return HANDLED;
    }
    // 3. NO TAG OUT: tag only with the killer here and beside the wall.
    const near = mate && mate.room === room && mate.pos && Math.max(
      Math.abs(mate.pos.row - this.hold.row), Math.abs(mate.pos.col - this.hold.col)) <= cfg.reach + 1;
    if (!near) {
      this.doing = 'buddy: waiting for my partner';
      if (!this._buddyWaitSaid || Date.now() - this._buddyWaitSaid > 120_000) {
        this._buddyWaitSaid = Date.now();
        this.note('buddy: waiting for my partner', { partner: role.partner, they_are_in: mate?.room ?? null,
          why: mate ? 'not beside the wall yet' : 'no fresh record from them' });
      }
      publish();
      return HANDLED;
    }
    // NO PULL WHILE KARA'HOL'S CURSE IS ON, OR WHILE HELD. The curse ends in a hold the caster cannot
    // free-action out of (karahol.kod: 40+power/2 seconds, then a hold a sixth as long), so a pull
    // started under it can leave the tagger frozen in the open at the far end. It is a practice
    // drill on these characters, cast from the corner; the corner is where it has to wear off.
    const spell = (c.enchantments?.() ?? []).map(e => String(e.name ?? '').toLowerCase())
      .find(n => /kara'?hol|^hold$/.test(n));
    if (spell) {
      this.doing = `buddy: waiting out ${spell} in the corner`;
      publish();
      return HANDLED;
    }
    const seen = this.buddyRoomObjects();
    const hunt = Array.isArray(this.policy.hunt) ? this.policy.hunt : this.policy.hunt ? [this.policy.hunt] : null;
    const want = buddySys.pickFreshTarget({ monsters: seen.monsters, players: seen.players, me: this.hold,
      quarry: cfg.quarry ?? hunt, tagged: this.buddyTagged ?? new Map() });
    if (!want) { this.doing = 'buddy: nothing untouched to tag'; publish(); return HANDLED; }
    this.buddyTagged.set(want.id, Date.now());
    if (Number.isFinite(c.evSeq)) this._buddyCursor = c.evSeq;
    this._buddyPendingName = want.name;
    if (this.touchTrainingHere()) {
      await this.touchOnTarget(want, want.name).catch(() => null);
      await this.maintainTouchSpell(`before pulling ${want.name}`)
        .catch(e => { const st = this.touchState(); if (st) st.blockedReason = e.message; });
    }
    const p = await this.pull(want).catch(e => ({ pulled: false, why: e.message }));
    const landed = this.buddyReadLanded();
    this._buddyPendingName = null;
    if (!p.pulled) {
      this.note('buddy: tag refused', { target: want.name, why: p.why });
      publish();
      return HANDLED;
    }
    this.buddyTag = { id: want.id, name: want.name, at: Date.now(), tries: 1, landed };
    this.note('buddy: tagged', { target: want.name, landed, back: !!p.back, partner: role.partner });
    publish();
    return HANDLED;
  }

  async passBuddyKill(ctx, role, room) {
    const { s, c } = ctx;
    const me = c.self;
    const cfg = role.cfg;
    const mate = buddySys.readBuddyRecord(role.partner);
    const publish = () => this.buddyPublish({ role: 'kill', partner: role.partner, room,
      pos: c.self ? { col: c.self.col, row: c.self.row } : null });
    // No tagger in this room with a wall: farm as usual (CONTINUE), but say where we are.
    if (!mate || mate.room !== room || !mate.hold || !me) { publish(); return CONTINUE; }
    const d = (a, b) => Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));
    // 1. Stand beside the tagger's wall.
    if (d(me, mate.hold) > cfg.reach) {
      const sq = s.world?.approachSquare?.(mate.hold.col, mate.hold.row);
      const to = sq ?? mate.hold;
      this.doing = 'buddy: going to my partner';
      const r = await s.walkTo(to.col, to.row, { maxSteps: (sq?.steps ?? 20) + 8 })
        .catch(e => ({ arrived: false, reason: e.message }));
      this.movedAt = Date.now();
      if (!r?.arrived) this.note('buddy: could not reach my partner', { partner: role.partner, why: r?.reason ?? 'no answer' });
      publish();
      return HANDLED;
    }
    publish();
    // 2. Kill the tag once its blow has landed -- or once it has been out long enough that waiting
    //    on a combat line we may have missed only leaves it chewing on the tagger.
    const seen = this.buddyRoomObjects();
    const tag = mate.tag ? seen.monsters.find(m => m.id === mate.tag.id) ?? null : null;
    const tagReady = !!tag && (mate.tag.landed || Date.now() - (mate.tag.at ?? 0) > 20_000);
    const inReach = m => d(me, m) <= PLAYER_REACH + 0.5;
    const atWall = m => d(mate.hold, m) <= 1;
    let target = tagReady && (inReach(tag) || atWall(tag)) ? tag : null;
    // 3. Anything else at the wall is ours: it is chewing on a tagger that will not swing back.
    if (!target) target = seen.monsters.find(m => (!tag || m.id !== tag.id) && (atWall(m) || inReach(m))) ?? null;
    if (!target) { this.doing = tag ? 'buddy: waiting for the tag to land' : 'buddy: guarding my partner'; return HANDLED; }
    this.doing = target === tag ? 'buddy: killing the tag' : 'buddy: clearing my partner\'s wall';
    const f = await this.fightNow({ target: target.name, exactTargetId: target.id, preferId: target.id,
      rounds: 6, holdPosition: false, reach: PLAYER_REACH, loot: true, disengageAt: this.safety().fleeAt,
      match: () => true, weaponPriority: this.weaponPriorityNow?.(target.name),
      bannedWeapons: this.bannedWeaponsNow?.() }).catch(e => ({ fought: false, note: e.message }));
    if (f?.killed) {
      this.tally.kills = (this.tally.kills || 0) + 1;
      this.killTimes?.push(Date.now());
      this.ledgerEvent?.('killed', { creature: f.target ?? target.name, room_num: room,
        buddy: role.partner, buddy_tag: target === tag });
      this.progress?.(`buddy: killed ${f.target ?? target.name} for ${role.partner}`);
    } else if (f?.fought) this.progress?.(`buddy: fighting ${target.name} for ${role.partner}`);
    return HANDLED;
  }
  // @end 2
}
