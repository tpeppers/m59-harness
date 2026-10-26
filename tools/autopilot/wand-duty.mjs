// WAND DUTY: the wand bank at the gate.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 9 methods: get wandDutyCfg, refreshWandDutyConfig, wandEvent, wandsCarried, wandRecount,
//   wandDutyStep, wandDropoff, wandPickup, wandBank
import { humanMark, roleOf, sameName } from '../m59-chalice.mjs';
import { recordEvent } from '../m59-ledger.mjs';
import { keeperOrigin } from '../m59-move-origin.mjs';
import * as party from '../m59-party.mjs';
import * as wandDuty from '../m59-wand-duty.mjs';
import { TITHE_FLEET } from '../m59-autopilot.mjs';

export class WandDutyPart {
  // @part 1

  // THE SERVER NEEDS ROOM TOO. The holder carries the fleet's collection and its reagents
  // and drops nothing; the alternate is a farmer and puts down its cheapest loot.
  // ================================================================== WAND DUTY
  //
  // The wand bank at Castle Victoria's gate. tools/m59-wand-duty.mjs has the operator's order and
  // the argument; this is the half that talks to the game, and it is chalice farming's shape on
  // purpose: a private strategy's `wandDuty` hook names the bank, the farmer always sends the same
  // `[Service Request]` tell whoever is at the bank's keyboard, and every wait is a RESUMABLE STAGE
  // that does one short step per pass, so the survival ladder keeps its turn while a farmer stands
  // in room 2 for up to a minute waiting on a person to open the trade window.

  /** The configuration, refreshed from the strategies at most every 30s. Sync to read. */
  get wandDutyCfg() { return this._wandDutyCfg?.enabled ? this._wandDutyCfg : null; }

  async refreshWandDutyConfig(now = Date.now()) {
    if (this._wandDutyCfgAt && now - this._wandDutyCfgAt < 30_000) return this.wandDutyCfg;
    this._wandDutyCfgAt = now;
    let answer = null;
    try {
      answer = await this.s?._askStrategies?.('wandDuty', { agent: this.s?.name ?? null, character: this.who() });
    } catch { answer = null; }
    const cfg = answer?.answer ? wandDuty.normalizeWandDuty(answer.answer) : null;
    const said = JSON.stringify(cfg?.problems ?? []);
    if (cfg?.problems?.length && said !== this._wandDutyProblemsSaid) {
      this._wandDutyProblemsSaid = said;
      this.note('wand duty configuration problems', { strategy: answer.strategy, problems: cfg.problems });
    }
    this._wandDutyCfg = cfg;
    return this.wandDutyCfg;
  }

  wandEvent(what, detail = {}) {
    try { recordEvent(this.who(), 'wand_duty', { what, room: this.hereRoom(), ...detail }); } catch {}
  }

  wandsCarried() {
    const c = this.s?.client;
    return wandDuty.wandsIn((c?.inventory || []).map(o => ({ id: o.id, amount: o.amount, name: c.rsc.get(o.nameRsc) || '' })));
  }

  /** The count after the server has said what is in the pack, not before. */
  async wandRecount() {
    const s = this.s, c = s?.client;
    try {
      const since = c.evSeq;
      await s.pacer.submit('read', () => c.requestInventory());
      await c.waitFor({ since, kinds: ['inventory'], timeoutMs: 3000 });
    } catch { /* the cached pack is the answer then */ }
    return this.wandsCarried().count;
  }

  /** The pass hook, beside chalice duty in passErrand: the bank serves, a farmer picks up. */
  async wandDutyStep() {
    const cfg = this.wandDutyCfg;
    if (!cfg || this.townTrip || this.travelInterrupted() || this.suspendedJourney) return false;
    // A STATION OUTSIDE THE CONFINEMENT IS A STATION THIS CHARACTER DOES NOT VISIT. travel() refuses the
    // walk anyway (it no longer exempts wand duty); standing down here keeps the errand from opening a
    // visit it cannot make every pass. Said once per station, not per pass.
    const confine = Array.isArray(this.policy?.confineRooms) ? this.policy.confineRooms.map(Number) : null;
    if (confine?.length && !confine.includes(Number(cfg.station_room))) {
      if (this._wandConfinedSaid !== cfg.station_room) {
        this._wandConfinedSaid = cfg.station_room;
        this.note('wand duty stands down: the station is outside the confinement',
          { station: cfg.station_room, confined_to: confine });
      }
      return false;
    }
    return wandDuty.roleOf(cfg, this.who()) === 'holder' ? this.wandBank(cfg) : this.wandPickup(cfg);
  }

  // ------------------------------------------------------------------ leaving: the drop-off
  //
  // Called from continueTownTrip before the chalice decision, and from an on-demand chalice ride:
  // a farmer leaving Castle Victoria, walking or riding, hands the bank EVERY wand first. Returns
  // `{pending}` to hold the trip for another pass, else `{skip}` -- never a failed trip: a bank
  // that is absent, busy or silent costs the stop, and the farmer leaves with its wands.
  async wandDropoff(trip) {
    const cfg = this.wandDutyCfg;
    if (!cfg) return { skip: true, why: 'wand duty is off' };
    const st = (trip.wandDuty ??= { stage: 'decide' });
    const c = this.s?.client, now = Date.now();
    const pending = (ms = 1000) => { trip.nextTryAt = now + ms; return { pending: true }; };
    const end = (why, detail = {}) => {
      st.stage = 'done'; st.why = why;
      this.note(`wand duty drop-off: ${why}`, detail);
      this.wandEvent(detail.gave ? 'dropoff' : 'dropoff_skipped', { why, ...detail });
      return { skip: true, why };
    };
    switch (st.stage) {
      case 'done': return { skip: true, why: st.why ?? 'already decided' };
      case 'decide': {
        const w = this.wandsCarried();
        const d = wandDuty.shouldDropoff({ cfg, me: this.who(), here: this.hereRoom(), wands: w.count,
                                           targetRoom: trip.onDemand ? null : trip.target?.room ?? null });
        if (!d.go) { st.stage = 'done'; st.why = d.why; return { skip: true, why: d.why }; }
        st.had = w.count; st.stage = 'to_station';
        this.note('wand duty: handing every wand to the bank before leaving Castle Victoria',
                  { wands: w.count, bank: cfg.holder });
        return pending(0);
      }
      case 'to_station': {
        if (this.hereRoom() === cfg.station_room) { st.stage = 'offer'; return pending(0); }
        const r = await this.travel(cfg.station_room, { origin: keeperOrigin('wand_duty'),
                                                        maxHops: cfg.max_detour_hops + 2, wandDuty: true })
          .catch(e => ({ arrived: false, reason: e.message }));
        if (r.arrived) { st.stage = 'offer'; return pending(0); }
        if (r.paused || r.cancelled || this.travelInterrupted()) return pending(5000);
        return end('could not reach the station', { reason: r.reason ?? null });
      }
      case 'offer': {
        const them = this.playerHere(cfg.holder);
        if (!them) return end(`${cfg.holder} is not at the station`);
        const w = this.wandsCarried();
        if (!w.count) return end('nothing left to hand over');
        if (!st.told) { await this.chaliceTell(cfg.holder, wandDuty.dropoffRequest(), { service: 'wand_duty' }).catch(() => {}); st.told = true; }
        await this.s.pacer.submit('trade', () => c.offer(them.id, w.rows.map(x => x.id)));
        st.offeredAt = Date.now(); st.stage = 'await_counter';
        return pending(500);
      }
      case 'await_counter': {
        const t = c?.trade, waited = Date.now() - st.offeredAt;
        // The bank's empty counter is the permission to accept -- a keeper's inside a second, a
        // person's whenever they find the window.
        if (t?.mayAccept && wandDuty.sameName(t.withName, cfg.holder)) {
          await this.s.pacer.submit('trade', () => c.acceptOffer()).catch(() => {});
          st.stage = 'verify'; return pending(1500);
        }
        // No trade at all, past the moment the offer's own echo should have set one up: closed.
        if (!t && waited > 3000) return end(`${cfg.holder} closed the trade without countering`, { gave: 0 });
        if (waited > cfg.wait_ms) {
          await this.s.pacer.submit('trade', () => c.cancelOffer()).catch(() => {});
          return end(`no counter from ${cfg.holder} within ${Math.round(cfg.wait_ms / 1000)}s`, { gave: 0 });
        }
        return pending(500);
      }
      case 'verify': {
        // WHAT LEFT THE PACK, never the handshake: a trade that completes and moves nothing reads
        // exactly like one that worked.
        const left = await this.wandRecount();
        const gave = Math.max(0, (st.had ?? 0) - left);
        return end(gave ? `handed ${gave} wand(s) to ${cfg.holder}` : 'the trade ended and no wand left the pack',
                   { gave, left });
      }
    }
    return end('unknown stage');
  }

  // ------------------------------------------------------------------ arriving: the pickup
  //
  // A farmer farming Castle Victoria and short of `carry` wands steps to the station, tells the
  // bank what it wants, and takes what is offered -- the empty counter is social()'s, and said once
  // here too. One attempt per visit: 1 wand when 2 were wanted is a success, an empty bank (the
  // bank's own published count) is not visited at all, and no offer within the wait gives the
  // stop up. Hands the pass back the moment it is finished, so the farm carries on.
  async wandPickup(cfg) {
    const c = this.s?.client, here = this.hereRoom(), now = Date.now();
    if (!c?.self) return false;
    if (!wandDuty.inRegion(cfg, here)) { this._wandVisit = null; this._wandPickup = null; return false; }
    const end = (why, detail = {}) => {
      this._wandPickup = null;
      this.note(`wand duty pickup: ${why}`, detail);
      this.wandEvent(detail.got ? 'pickup' : 'pickup_skipped', { why, ...detail });
      return false;
    };
    let st = this._wandPickup;
    if (!st) {
      const w = this.wandsCarried();
      // A PERSON AT THE BANK may have restocked it by hand, and their keeper is not publishing: while
      // the broker's human mark for the bank is live, the published count is not believed -- ask.
      let person = null;
      try { person = humanMark(this.chaliceStore().humans(), cfg.holder); } catch { person = null; }
      const d = wandDuty.shouldPickup({ cfg, me: this.who(), here, assignedRoom: this.policy?.assignedRoom ?? null,
        farming: this.mode === 'farm', wands: w.count, bank: person ? null : wandDuty.readBank(TITHE_FLEET),
        last: this._wandVisit?.triedAt ?? null, hops: here === cfg.station_room ? 0 : this.hopsTo(cfg.station_room), now });
      if (!d.go) {
        if (d.empty && !this._wandVisit?.emptySaid) {
          (this._wandVisit ??= {}).emptySaid = true;
          this.wandEvent('pickup_skipped', { why: d.why });
        }
        return false;
      }
      (this._wandVisit ??= {}).triedAt = now;
      st = this._wandPickup = { stage: 'to_station', want: d.want, had: w.count, at: now };
      this.note('wand duty: stopping by the bank for wands', { want: d.want, carrying: w.count, bank: cfg.holder });
    }
    switch (st.stage) {
      case 'to_station': {
        if (here === cfg.station_room) { st.stage = 'ask'; return true; }
        const r = await this.travel(cfg.station_room, { origin: keeperOrigin('wand_duty'),
                                                        maxHops: cfg.max_detour_hops + 1, wandDuty: true })
          .catch(e => ({ arrived: false, reason: e.message }));
        if (r.arrived) { st.stage = 'ask'; return true; }
        if (r.paused || r.cancelled || this.travelInterrupted()) return true;
        return end('could not reach the station', { reason: r.reason ?? null });
      }
      case 'ask': {
        if (!this.playerHere(cfg.holder)) return end(`${cfg.holder} is not at the station`);
        await this.chaliceTell(cfg.holder, wandDuty.pickupRequest(st.want), { service: 'wand_duty' }).catch(() => {});
        st.askedAt = Date.now(); st.stage = 'await_offer';
        return true;
      }
      case 'await_offer': {
        const count = this.wandsCarried().count;
        if (count > st.had) return end(`took ${count - st.had} wand(s) from ${cfg.holder}`, { got: count - st.had, carrying: count });
        const t = c.trade;
        if (t?.role === 'recipient' && wandDuty.sameName(t.withName, cfg.holder) && !st.countered) {
          if (!t.ours?.length) await this.s.pacer.submit('act', () => c.counterOffer([])).catch(() => {});
          st.countered = Date.now();
        }
        if (Date.now() - (st.countered ?? st.askedAt) > cfg.wait_ms) {
          if (c.trade) await this.s.pacer.submit('act', () => c.cancelOffer()).catch(() => {});
          const got = Math.max(0, (await this.wandRecount()) - st.had);
          return end(got ? `took ${got} wand(s) from ${cfg.holder}`
                         : `no wands from ${cfg.holder} within ${Math.round(cfg.wait_ms / 1000)}s`, { got });
        }
        return true;   // standing at the station, waiting on the bank
      }
    }
    return end('unknown stage');
  }

  // ------------------------------------------------------------------ the bank
  //
  // A keeper-run bank publishes its count (so an empty bank is never walked to), hears pickup
  // tells from fleetmates, and offers up to what was asked to whoever is standing here. A drop-off
  // needs nothing new: acceptDonations already counters every fleetmate's offer of a wand. When a
  // person is playing the bank, none of this runs and the person answers the same tells by hand.
  async wandBank(cfg) {
    const c = this.s?.client, now = Date.now();
    if (!c?.self) return false;
    const w = this.wandsCarried();
    if (this._wandBankSaid?.wands !== w.count || now - (this._wandBankSaid?.at ?? 0) > 60_000) {
      try {
        wandDuty.writeBank(TITHE_FLEET, { holder: this.who(), wands: w.count, room: this.hereRoom(), at: now });
        this._wandBankSaid = { wands: w.count, at: now };
      } catch { /* a missed publish only means a farmer walks over to ask */ }
    }
    // Its own cursor: passFollow and social() read the same stream, and consuming it out from under
    // either would make one of them intermittently deaf.
    const evs = (c.eventsSince?.(this._wandCursor || 0) ?? []).filter(e => e.kind === 'said');
    this._wandCursor = c.evSeq;
    const asks = (this._wandAsks ??= new Map());
    for (const e of evs) {
      if (e.speaker === c.selfId) continue;
      const req = wandDuty.parseWandRequest(e.text);
      const name = e.name ?? e.speaker_name ?? null;
      if (req?.kind !== 'pickup' || !name || !party.isFleetmate(name)) continue;
      asks.set(name.toLowerCase(), { name, n: req.n, at: now });
    }
    for (const [k, a] of asks) if (now - a.at >= cfg.wait_ms) asks.delete(k);
    if (!asks.size || c.trade) return false;
    const ask = [...asks.values()].sort((a, b) => a.at - b.at).find(a => this.playerHere(a.name));
    if (!ask) return false;                         // still walking in
    asks.delete(ask.name.toLowerCase());
    const give = wandDuty.pickupOffer(ask.n, w.count);
    if (!give) {
      await this.chaliceTell(ask.name, 'no wands in the bank right now', { service: 'wand_duty' }, { reply: true }).catch(() => {});
      this.wandEvent('bank_empty', { for: ask.name });
      return true;
    }
    const ids = [];
    let left = give;
    for (const r of w.rows) {
      if (left <= 0) break;
      const have = Number(r.amount) || 1, take = Math.min(left, have);
      ids.push(take === have ? r.id : { id: r.id, amount: take });
      left -= take;
    }
    const before = w.count;
    const r = await this.chaliceGive(ask.name, ids, { stillHave: () => this.wandsCarried().count >= before, counterMs: 15_000 })
      .catch(e => ({ gave: false, why: e.message }));
    this.wandEvent(r.gave ? 'bank_gave' : 'bank_give_failed', { to: ask.name, n: give, ...(r.why ? { why: r.why } : {}) });
    this.note(r.gave ? `wand duty: handed ${give} wand(s) to ${ask.name}` : `wand duty: could not hand wands to ${ask.name}`,
              { why: r.why ?? null });
    return true;
  }
  // @end 1
}
