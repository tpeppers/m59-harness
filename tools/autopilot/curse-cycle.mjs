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
// 7 methods: curseCycleInputs, curseCycleWornCursed, curseCycleLoose, curseCycleNote,
//   applyCurseCycle, curseCycleHall, passCurseCycle
import { CURSE_CYCLE_REAGENT, CURSE_CYCLE_SPELL, curseCycleGate, normalizeCurseCycle, uncurseAffordable } from '../m59-curse-cycle.mjs';
import { norm } from '../m59-loadout.mjs';
import * as skills from '../m59-skills.mjs';
import { CONTINUE, HANDLED } from '../m59-autopilot.mjs';

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
  // @end 1
}
