// THE CURSE CYCLE: wear an unread ring, uncurse, drop the cursed one.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 16 methods: curseCycleInputs, curseCycleWornCursed, curseCycleLoose, curseCycleNote,
//   applyCurseCycle, curseCycleHall, passCurseCycle, applyUnrevealedWeaponLoot, unrevealedWeaponStatus,
//   cursedWornCount, tendCurseServices, rewearCursedItems, askUncurseDesk, uncurseDeskPublish, serveUncurseDesk,
//   uncurseDeskStatus
import { CURSE_CYCLE_REAGENT, CURSE_CYCLE_SPELL, curseCycleGate, normalizeCurseCycle, uncurseAffordable } from '../m59-curse-cycle.mjs';
import { norm } from '../m59-loadout.mjs';
import * as skills from '../m59-skills.mjs';
import { CONTINUE, HANDLED } from '../m59-autopilot.mjs';
import { readUnrevealedWeaponMode, unrevealedWeaponGate } from '../m59-unrevealed-weapons.mjs';
import { readRewearCursed, readUncurseDesk, rewearDue, shouldAskUncurse, uncurseCustomers, uncurseDeskMenu,
         UNCURSE_REAGENT, UNCURSE_SPELL } from '../m59-uncurse-service.mjs';
import { claimRequest, finishRequest, openRequests } from '../rpg/requests.mjs';
import { OF } from '../m59-parse.mjs';
import { TITHE_FLEET } from '../m59-autopilot.mjs';

export class CurseCyclePart {
  // @part 1

  // ------------------------------------------------------------------ the curse cycle
  //
  // m59-curse-cycle.mjs has the kod and the argument. The keeper's half: ask the strategies once a
  // minute, gate the pickup on what this body can pay for THIS pass, and when a cycled ring has
  // cursed us, cast remove curse on ourselves and drop it. Silence -- no strategy answering -- is
  // the old behaviour: no unidentified ring is ever picked up.

  /** What the gate reads, taken from this body now. Unknowns stay null and shut the gate. */
  curseCycleInputs() {
    const c = this.s?.client;
    const key = v => String(v ?? '').toLowerCase();
    const spells = (c?.spells ?? []).map(sp => key(c.rsc?.get?.(sp.nameRsc) || sp.name));
    const karma = c?.stat?.('karma');
    const floors = this.carryFloors?.() ?? {};
    const floor = Number(Object.entries(floors).find(([n]) => key(n) === CURSE_CYCLE_REAGENT)?.[1]) || 0;
    const kept = Number(this.chaliceReagentFloor?.()?.[CURSE_CYCLE_REAGENT]) || 0;
    return { spells, knowsSpell: spells.includes(CURSE_CYCLE_SPELL),
             karma: karma == null || karma === '' ? null : Number(karma),
             mana: c?.vitals?.()?.mana?.value ?? null,
             emeralds: this.reagentOnHand(CURSE_CYCLE_REAGENT), floor: Math.max(floor, kept) };
  }

  /** Cursed items worn now, as `{ o, name, ring }`. Only a RING is ever this cycle's to drop. */
  curseCycleWornCursed(c = this.s?.client) {
    return this.chaliceCursedWorn().map(o => {
      const name = String(c?.rsc?.get?.(o.nameRsc) || o.name || '').toLowerCase();
      return { o, name, ring: /\bring\b/.test(name) };
    });
  }

  /** Cursed RINGS in the pack and not worn: what the cycle puts back on the floor. */
  curseCycleLoose(c = this.s?.client) {
    const worn = new Set((c?.equipment?.()?.equipped ?? []).map(e => e.id));
    return (c?.inventory ?? []).filter(o => !worn.has(o.id)
      && /\bring\b/i.test(String(c.rsc?.get?.(o.nameRsc) || ''))
      && (Number(o.rarity) === 200 || skills.isCursedItem(c, o)));
  }

  /** Once per `ms` per key: the cycle's reasons are worth one line, not one a pass. */
  curseCycleNote(key, what, detail, ms = 300_000) {
    const seen = (this._curseCycleNoted ??= new Map());
    if (Date.now() - (seen.get(key) ?? 0) < ms) return;
    seen.set(key, Date.now());
    this.note(what, detail);
  }

  /** Ask (at most once a minute), gate, and install the gate on the session. Never throws. */
  async applyCurseCycle() {
    const s = this.s;
    try {
      if (Date.now() - (this._curseCycleAskedAt ?? 0) >= 60_000 && typeof s?._askStrategies === 'function') {
        this._curseCycleAskedAt = Date.now();
        const inp = this.curseCycleInputs();
        const got = await s._askStrategies('curseCycle', {
          agent: this.name ?? s.name, character: s.client?.me?.name ?? null, spells: inp.spells,
          karma: inp.karma, emeralds: inp.emeralds, mana: inp.mana, room: s.world?.room?.num ?? null,
          guild_wants: this.policy.guildWants?.enabled === true,
        }).catch(() => null);
        const { cfg, problems } = normalizeCurseCycle(got?.answer ?? null);
        if (problems.length) this.curseCycleNote('problems', 'curse cycle: refused part of the answer',
          { strategy: got?.strategy ?? null, problems });
        if (JSON.stringify(cfg) !== JSON.stringify(this._curseCycleCfg ?? null))
          this.note(cfg ? 'curse cycle on' : 'curse cycle off', { strategy: got?.strategy ?? null, ...(cfg ?? {}) });
        this._curseCycleCfg = cfg;
        this._curseCycleStrategy = got?.strategy ?? null;
      }
      const cfg = this._curseCycleCfg;
      if (!cfg) { s?.setCurseCycle?.(null); this._curseCycleGate = null; return; }
      const gate = curseCycleGate(cfg, this.curseCycleInputs());
      this._curseCycleGate = gate;
      s?.setCurseCycle?.(gate.open ? { open: true, pickup: cfg.pickup } : null);
    } catch (e) {
      s?.setCurseCycle?.(null);
      this.curseCycleNote('threw', 'curse cycle: gate failed, pickup stays refused', { why: e?.message ?? String(e) });
    }
  }

  /** The names to carry to the hall when guild_wants is off: `hall`, once `hall_min` are held. */
  curseCycleHall() {
    const cfg = this._curseCycleCfg;
    if (!cfg?.hall?.length) return null;
    const pack = this.packAsItems();
    const held = cfg.hall.reduce((n, item) => n + pack.filter(x => norm(x.name) === item)
      .reduce((t, x) => t + (x.amount || 1), 0), 0);
    return held >= cfg.hall_min ? cfg.hall : null;
  }

  async passCurseCycle(ctx) {
    // THE NON-CHALICE REMOVE-CURSE DESK AND THE AMULET RE-WEAR (m59-uncurse-service.mjs) share this rung: both are inert
    // (CONTINUE) unless policy.uncurseDesk / policy.rewearCursed name this character, or it is a farmer wearing a curse
    // with a desk offering in its room.
    const svc = await this.tendCurseServices(ctx).catch(e => {
      this.curseCycleNote('services-threw', 'remove-curse services failed', { why: e?.message ?? String(e) }, 60_000);
      return CONTINUE;
    });
    if (svc === HANDLED) return HANDLED;
    const cfg = this._curseCycleCfg;
    if (!cfg) return CONTINUE;
    const s = this.s, c = ctx?.c ?? s?.client;
    if (!c?.equipment || c.equipment()?.known !== true) return CONTINUE;
    const worn = this.curseCycleWornCursed(c);
    // A ring that would not leave the pack is retried every five minutes, not every pass.
    const looseDue = Date.now() - (this._curseCycleDropFailAt ?? 0) >= 300_000;
    if (!worn.some(w => w.ring) && !(looseDue && this.curseCycleLoose(c).length)) return CONTINUE;
    if ((this.threat?.().landing ?? 0) > 0) return CONTINUE;   // not while something is hitting us

    let cast = null;
    const rewore = [];
    if (worn.some(w => w.ring)) {
      const pay = uncurseAffordable(cfg, this.curseCycleInputs());
      if (!pay.ok) {
        this.curseCycleNote('cannot-pay', 'curse cycle: a cursed ring is worn and cannot be broken yet',
          { worn: worn.map(w => w.name), why: pay.why });
        return CONTINUE;
      }
      this.doing = 'breaking a curse';
      // remove curse takes off EVERY cursed item worn, and the curse is on the wearer, not the item.
      // Whatever is not a ring (a trainee's Amulet of Shadows) was worn on purpose: it goes back on.
      const rewear = worn.filter(w => !w.ring).map(w => ({ id: w.o.id, name: w.name }));
      try { await skills.standToAct(s); } catch {}
      // castSelfSpell targets our own object id and judges the cast by the mana it spent.
      cast = await this.castSelfSpell(CURSE_CYCLE_SPELL, 'curse cycle: a cycled ring cursed us')
        .catch(e => ({ landed: false, why: e?.message ?? String(e) }));
      await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
      await c.waitFor?.({ kinds: ['inventory'], timeoutMs: 3000 })?.catch?.(() => {});
      const still = this.curseCycleWornCursed(c).filter(w => w.ring);
      if (still.length) {
        this.curseCycleNote('still-worn', 'curse cycle: remove curse did not take the ring off',
          { worn: still.map(w => w.name), cast }, 60_000);
        return cast?.landed ? HANDLED : CONTINUE;
      }
      this.tally.curse_cycle_uncursed = (this.tally.curse_cycle_uncursed || 0) + 1;
      for (const r of rewear) {
        // Re-read by id AND name: an id is a handle.
        const o = (c.inventory ?? []).find(x => x.id === r.id
          && String(c.rsc?.get?.(x.nameRsc) || '').toLowerCase() === r.name);
        if (!o || (c.equipment()?.equipped ?? []).some(e => e.id === o.id)) continue;
        await s.pacer.submit('use', () => c.use(o.id)).catch(() => {});
        rewore.push(r.name);
      }
    }

    // EVERY CURSED RING IS OFF THE FINGER NOW, so the drop costs nothing: lethring.kod ReqLeaveOwner
    // tortures the owner only while the ring is worn. The list is re-read right here, by id AND name,
    // because an id is a handle and a stale one could name something else.
    const dropped = [];
    for (const o of this.curseCycleLoose(c)) {
      const name = String(c.rsc?.get?.(o.nameRsc) || '').toLowerCase();
      await s.pacer.submit('drop', () => c.drop([this.dropSpec(o)])).catch(() => {});
      (s._shedIds ??= new Map()).set(o.id, Date.now());
      dropped.push(name);
      await new Promise(r => setTimeout(r, 400));
    }
    if (dropped.length) {
      await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
      await c.waitFor?.({ kinds: ['inventory'], timeoutMs: 3000 })?.catch?.(() => {});
    }
    const left = this.curseCycleLoose(c).length;
    if (left) this._curseCycleDropFailAt = Date.now();
    this.tally.curse_cycle_dropped = (this.tally.curse_cycle_dropped || 0) + Math.max(0, dropped.length - left);
    const row = { strategy: this._curseCycleStrategy, cast: cast ? { landed: !!cast.landed,
      mana_before: cast.mana_before ?? null, mana_after: cast.mana_after ?? null } : null,
      dropped, rewore, still_carried: left, room: s.world?.room?.num ?? null,
      emeralds_left: this.reagentOnHand(CURSE_CYCLE_REAGENT) };
    this.note(left ? 'curse cycle: a cursed ring would not leave the pack' : 'curse cycle: dropped a cursed ring', row);
    this.ledgerEvent('curse_cycle', row);
    if (left) return CONTINUE;
    this.progress('curse cycle: broke a curse and dropped the ring');
    return HANDLED;
  }

  // ------------------------------------------------------------------ unidentified weapons
  //
  // m59-unrevealed-weapons.mjs has the kod and the argument: a cursed weapon wields itself on
  // pickup (item.kod:508-514) and never lets go. The keeper's half is the verdict for this pass,
  // installed on the session like the curse cycle's gate; `lootFloor` reads it on every path.

  /**
   * Install this pass's verdict on unidentified weapons (`policy.lootUnrevealedWeapons`). Never
   * throws. Unset is the old behaviour; an unreadable service board under 'desk', or any failure
   * here while a mode is set, REFUSES -- the unknown is the curse.
   */
  applyUnrevealedWeaponLoot(now = Date.now()) {
    const s = this.s;
    const raw = this.policy?.lootUnrevealedWeapons ?? null;
    let gate;
    try {
      const { mode, problem } = readUnrevealedWeaponMode(raw);
      if (problem) this.curseCycleNote('unrevealed-weapons-problem', 'unrevealed weapons: policy value refused', { value: raw, problem });
      let desks = null;
      if (mode === 'desk') {
        // The board is a file every desk rewrites once a minute; reading it every pass buys nothing.
        if (!this._unrevealedWeaponDesks || now - this._unrevealedWeaponDesks.at >= 30_000) {
          let read = null;
          try { read = this.chaliceStore().desk() ?? {}; } catch { read = null; }
          this._unrevealedWeaponDesks = { at: now, desks: read };
        }
        desks = this._unrevealedWeaponDesks.desks;
      }
      gate = { ...unrevealedWeaponGate(mode, { desks, now, rooms: this.policy?.confineRooms ?? null }), problem };
    } catch (e) {
      gate = raw == null
        ? { mode: null, allow: null, desk: null, why: `gate failed (${e?.message ?? e}); unset, so looted as before`, problem: null }
        : { mode: String(raw), allow: false, desk: null, why: `gate failed (${e?.message ?? e}); refused`, problem: null };
    }
    const was = this._unrevealedWeaponGate;
    this._unrevealedWeaponGate = gate;
    try { s?.setUnrevealedWeaponLoot?.(gate); } catch {}
    if (gate.mode != null && (!was || was.mode !== gate.mode || was.allow !== gate.allow))
      this.note(gate.allow === false ? 'unrevealed weapons: left on the floor' : 'unrevealed weapons: looted',
        { mode: gate.mode, why: gate.why, desk: gate.desk?.name ?? null });
    return gate;
  }

  /** For `autopilot status`: always present, so "unset" reads differently from "not reported". */
  unrevealedWeaponStatus() {
    const g = this._unrevealedWeaponGate;
    const policy = this.policy?.lootUnrevealedWeapons ?? null;
    if (!g) return { policy, mode: readUnrevealedWeaponMode(policy).mode, allow: null, desk: null, why: 'not computed yet', problem: null };
    return { policy, mode: g.mode, allow: g.allow, desk: g.desk ?? null, in_confinement: g.in_confinement ?? null,
             why: g.why ?? null, problem: g.problem ?? null };
  }

  // ------------------------------------------------------------------ the remove-curse desk, the re-wear, the ask
  //
  // m59-uncurse-service.mjs has the operator's order (2026-11-13, Pepe and Sweetums in the Great Ocean) and the kod. The
  // keeper's half: put a practice amulet back on, ask a desk for a curse we did not choose, and -- for a desk -- publish
  // the record the farmers' `lootUnrevealedWeapons: 'desk'` gate reads, and cast on whoever asked.

  /** Cursed items worn now: the server's grade or this session's mark, plus anything worn from rewearCursed. null unread. */
  cursedWornCount(c = this.s?.client) {
    if (!c?.equipment || c.equipment()?.known !== true) return null;
    const ids = new Set(this.chaliceCursedWorn().map(o => o.id));
    const rewear = new Set(readRewearCursed(this.policy?.rewearCursed));
    if (rewear.size) {
      const worn = new Set((c.equipment()?.equipped ?? []).map(e => e.id));
      for (const o of c.inventory ?? [])
        if (worn.has(o.id) && rewear.has(String(c.rsc?.get?.(o.nameRsc) || o.name || '').trim().toLowerCase())) ids.add(o.id);
    }
    return ids.size;
  }

  /** The rung's work, in order: re-wear, ask, desk. HANDLED when something was done with the body this pass. */
  async tendCurseServices(ctx) {
    const c = ctx?.c ?? this.s?.client;
    if (!c) return CONTINUE;
    if (await this.rewearCursedItems(c)) return HANDLED;
    this.askUncurseDesk(c);
    const { cfg, problem } = readUncurseDesk(this.policy?.uncurseDesk ?? null);
    if (problem) this.curseCycleNote('uncurse-desk-problem', 'uncurse desk: policy value refused', { problem });
    if (!cfg) { this._uncurseDesk = null; return CONTINUE; }
    // A CHALICE HOLDER ALREADY PUBLISHES A DESK UNDER THIS NAME, with uncurse on it; two writers would fight over one record.
    if (this.chaliceRole?.() === 'holder') { this._uncurseDesk = { able: false, why: 'the chalice desk serves here' }; return CONTINUE; }
    const able = this.uncurseDeskPublish(cfg, c);
    if (!able) return CONTINUE;
    return (await this.serveUncurseDesk(cfg, c)) ? HANDLED : CONTINUE;
  }

  /** Put back on what policy.rewearCursed names and a remove curse took off. True when a use was sent. */
  async rewearCursedItems(c) {
    const rewear = readRewearCursed(this.policy?.rewearCursed);
    if (!rewear.length || c.equipment?.()?.known !== true) return false;
    if (Date.now() - (this._rewearAt ?? 0) < 30_000) return false;
    if ((this.threat?.().landing ?? 0) > 0 || this.s?.combat?.active) return false;
    const v = c.vitals?.()?.health;
    if (v?.max > 0 && v.value / v.max < 0.8) return false;
    const equipped = c.equipment()?.equipped ?? [];
    const due = rewearDue({ rewear, wornIds: new Set(equipped.map(e => e.id)),
      wornNames: equipped.filter(e => !(Number(e.id) >= 0)).map(e => String(e.name ?? '')).filter(Boolean),
      pack: (c.inventory ?? []).map(o => ({ id: o.id, name: c.rsc?.get?.(o.nameRsc) || o.name || '' })) });
    if (!due.length) return false;
    this._rewearAt = Date.now();
    for (const r of due) await this.s.pacer.submit('use', () => c.use(r.id)).catch(() => {});
    this.tally.rewore_cursed = (this.tally.rewore_cursed || 0) + due.length;
    this.note('put a cursed item back on', { items: due.map(r => r.name), why: 'policy.rewearCursed: worn on purpose for remove curse practice' });
    try { this.ledgerEvent('rewear_cursed', { items: due.map(r => r.name), room: this.s?.world?.room?.num ?? null }); } catch {}
    return true;
  }

  /** A farmer wearing a curse it did not choose asks the board, while a desk offers in its room. At most once a minute. */
  askUncurseDesk(c) {
    const gate = this._unrevealedWeaponGate;
    if (!gate?.desk || Date.now() - (this._uncurseAskAt ?? 0) < 60_000) return null;
    const cursedWorn = this.chaliceCursedWorn().map(o => String(c.rsc?.get?.(o.nameRsc) || o.name || ''));
    const v = shouldAskUncurse({ cursedWorn, suspect: this._curseSuspect ?? null, rewear: readRewearCursed(this.policy?.rewearCursed),
                                 desk: gate.desk, room: this.hereRoom() });
    if (!v.ask) return null;
    this._uncurseAskAt = Date.now();
    const req = this.s?.joints?.effects?.request;
    if (typeof req !== 'function') return null;
    try {
      req({ service: 'uncurse', target: this.who(), character: this.who(), from: this.s?.name ?? null, why: v.why,
            pak: 'keeper:uncurse-ask', ttl_ms: 5 * 60_000 });
      this.curseCycleNote('uncurse-asked', 'asked the remove-curse desk', { desk: gate.desk.name, why: v.why });
    } catch {}
    return v;
  }

  /** Publish this desk's record (once a minute, or at once when it changes). Returns whether it can cast now. */
  uncurseDeskPublish(cfg, c, now = Date.now()) {
    const key = s => String(s ?? '').trim().toLowerCase();
    const knows = (c.spells ?? []).some(sp => key(c.rsc?.get?.(sp.nameRsc) || sp.name) === UNCURSE_SPELL);
    const floor = Number(this.chaliceReagentFloor?.()?.[UNCURSE_REAGENT]) || 0;
    const here = this.hereRoom();
    const m = uncurseDeskMenu(cfg, { here, knows, karma: c.stat?.('karma') ?? null, mana: c.vitals?.()?.mana?.value ?? null,
                                     emeralds: this.reagentOnHand(UNCURSE_REAGENT), floor });
    const was = this._uncurseDesk;
    this._uncurseDesk = { able: m.able, why: m.why, room: cfg.room ?? here, at: was?.at ?? null, served: was?.served ?? 0 };
    if (!was || was.able !== m.able || now - (was.at ?? 0) >= 60_000) {
      try { this.chaliceStore().setDesk(this.who(), { menu: m.menu, room: cfg.room ?? (Number.isFinite(here) ? here : null) }, now); } catch {}
      this._uncurseDesk.at = now;
      if (!was || was.able !== m.able) this.note(m.able ? 'uncurse desk open' : 'uncurse desk closed', { room: cfg.room ?? here, why: m.why });
    }
    return m.able;
  }

  /** Cast Remove Curse on the oldest asker standing here. True when a cast was made. */
  async serveUncurseDesk(cfg, c, now = Date.now()) {
    if (this.errand || this.townTrip || this.suspendedJourney || this.busyStatus?.() || (this.inert && !this.inert.travelling)) return false;
    if ((this.threat?.().landing ?? 0) > 0) return false;
    if (now - (this._uncurseServeAt ?? 0) < 10_000) return false;
    this._uncurseServeAt = now;
    let requests = [];
    try { requests = openRequests({ service: 'uncurse', fleet: TITHE_FLEET, now }); } catch { return false; }
    if (!requests.length) return false;
    const players = [...(c.room?.objects?.values?.() ?? [])]
      .filter(o => (o.flags & OF.PLAYER) && o.id !== c.selfId).map(o => ({ id: o.id, name: c.rsc?.get?.(o.nameRsc) || '' }));
    this._uncurseLast ??= new Map();
    const [next] = uncurseCustomers({ requests, players, room: this.hereRoom(), me: this.who(), now,
                                      lastCast: this._uncurseLast, cooldownMs: cfg.cooldown_ms });
    if (!next) return false;
    const by = this.who();
    try { claimRequest({ id: next.request.id, by, fleet: TITHE_FLEET, now }); } catch {}
    this.doing = `remove curse for ${next.player.name}`;
    const mana0 = c.vitals?.()?.mana?.value ?? null, em0 = this.reagentOnHand(UNCURSE_REAGENT);
    const r = await this.chaliceCast(UNCURSE_SPELL, next.player.id).catch(e => ({ cast: false, why: e?.message ?? String(e) }));
    const mana1 = c.vitals?.()?.mana?.value ?? null, em1 = this.reagentOnHand(UNCURSE_REAGENT);
    // THE VERDICT IS WHAT IT COST: remcurse.kod refuses a target with nothing cursed BEFORE any mana or emerald is spent.
    const lifted = (mana0 != null && mana1 != null && mana1 < mana0) || em1 < em0;
    this._uncurseLast.set(String(next.player.name).toLowerCase(), Date.now());
    const outcome = !r?.cast ? 'not_cast' : lifted ? 'lifted' : 'nothing_cursed';
    if (r?.cast) try { finishRequest({ id: next.request.id, by, outcome, fleet: TITHE_FLEET }); } catch {}
    if (this._uncurseDesk) this._uncurseDesk.served = (this._uncurseDesk.served ?? 0) + (lifted ? 1 : 0);
    this.tally.uncurse_desk_casts = (this.tally.uncurse_desk_casts || 0) + (r?.cast ? 1 : 0);
    const row = { for: next.player.name, outcome, why: r?.why ?? null, request: next.request.id, room: this.hereRoom() };
    this.note('uncurse desk: served', row);
    try { this.ledgerEvent('uncurse_desk', row); } catch {}
    return !!r?.cast;
  }

  /** For `autopilot status`: null when this character is not a desk. */
  uncurseDeskStatus() {
    const { cfg, problem } = readUncurseDesk(this.policy?.uncurseDesk ?? null);
    if (!cfg && !problem) return null;
    return { policy: cfg, problem, ...(this._uncurseDesk ?? { able: null, why: 'not computed yet' }),
             rewear: readRewearCursed(this.policy?.rewearCursed) };
  }
  // @end 1
}
