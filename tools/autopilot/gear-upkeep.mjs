// GEAR UPKEEP: broken and worn items, weapon magic, curse suspects, field weapons.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 27 methods: noteReceivedGoods, heldBackIds, saveWeaponMagic, sweepBroken, sweepGearCondition, gearConditionStatus, weaponMagicBook,
//   overfarmKeepIds, packWeapons, wieldedWeaponId, weaponMagicStatus, noteCurseSuspect,
//   clearCurseSuspect, noteSwapOutcome, noteReagentRefusal, noteUncursed, sweepCursed,
//   noteEnchantLapse, noteWeaponArrived, noteDedication, shedUnusedConjures, fieldSpareWeapons,
//   fieldWeaponCap, capFieldWeapons, sweepWeaponMagic, syncMagicSet, applyMagicPreference
import { clearConjureHoard } from '../m59-conjure-cleanup.mjs';
import { spellCost } from '../m59-deskpractice.mjs';
import { reconcile } from '../m59-loadout.mjs';
import { shortfallTargets } from '../m59-sharing.mjs';
import * as skills from '../m59-skills.mjs';
import { WeaponMagicBook, magicSwap } from '../m59-weapon-magic.mjs';
import { CONJURABLE_WEAPONS, CURSE_SUSPECT_REFUSALS, swapWhyNot } from '../m59-autopilot.mjs';
import { selfFacts, roomFacts } from '../m59-joint-facts.mjs';
import { noteReceived, protectedReceived, arrivedFrom } from '../m59-received.mjs';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const WEAPON_MAGIC_DIR = process.env.M59_WEAPON_MAGIC_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'substrate', '.weapon-magic');
const weaponMagicFile = agent => join(WEAPON_MAGIC_DIR, `${String(agent ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

export class GearUpkeepPart {
  // @part 1
  // Drop broken, unworn weapons on a timer, with a bounded number per sweep.
  // Money, gems, equipped items and the user's dropJunk preference remain protected.
  async sweepBroken() {
    if (this.policy.dropJunk === false) return null;
    const every = Number(this.policy.dropBrokenEverySec);
    const gapMs = (Number.isFinite(every) && every > 0 ? every : 120) * 1000;
    if (Date.now() - (this.lastBrokenSweep ?? 0) < gapMs) return null;
    this.lastBrokenSweep = Date.now();
    const s = this.s, c = s.need();
    const worn = skills.equippedNow(c) ?? new Set();
    const spares = (c.inventory || [])
      .filter(o => !worn.has(o.id) && skills.weaponScore(c.rsc.get(o.nameRsc) || '') > 0)
      .map(o => o.id);
    // ASKING IS WHAT MAKES IT KNOWN. A spare is never swung, so nothing ever discovers it
    // is broken unless somebody looks — which is the loop that let those swords accumulate.
    if (spares.length) await skills.inspectForBroken(s, spares).catch(() => null);
    // `junkAndBroken` reports WHY, not a flag — there is no `d.broken`, and filtering on
    // one would have matched nothing and swept nothing, silently, for ever. Junk is left to
    // makeRoom: this sweep is only about gear the server will refuse to wield.
    const dead = skills.junkAndBroken(c).filter(d => /broken/.test(d.why || '')
      && !skills.itemIsProtected(d.name, this.protectedItemNames()));
    if (!dead.length) return null;
    const dropped = [];
    for (const d of dead.slice(0, 3)) {
      await s.pacer.submit('drop', () => c.drop([this.dropSpec(d)])).catch(() => {});
      await new Promise(r => setTimeout(r, 700));
      dropped.push(d.name);
    }
    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
    this.note('dropped broken gear', { dropped, still_broken: Math.max(0, dead.length - dropped.length),
      why: 'broken gear is weight and bulk spent on nothing at every pack size' });
    return { dropped };
  }

  // CONDITION OF WHAT THE CHARACTER IS ACTUALLY WEARING, read from look_at descriptions.
  //
  // The server never pushes condition — it is appended to the look_at description text.
  // We check worn weapon and worn armour at most every 90s, parse the condition phrase
  // into a 0-4 level, and cache the result on _gearCondition so the broker's fleet row
  // can surface it without an extra round trip.
  //
  // This only looks at EQUIPPED gear (plUsing), not inventory spares.  inspectForBroken
  // already watches the spares for broken detection; this is for the dashboard display.
  async sweepGearCondition() {
    const gapMs = 90_000;
    if (Date.now() - (this._lastGearConditionAt ?? 0) < gapMs) return;
    this._lastGearConditionAt = Date.now();
    const s = this.s, c = s.need();
    const eq = c.equipment();
    if (!eq.known) return;

    const weaponItem = eq.equipped.find(e => e.name && skills.weaponScore(e.name) > 0);
    const armorItem  = eq.equipped.find(e => {
      const n = (e.name || '').toLowerCase();
      return /leather|chain|scale|plate|cloth|robe|breastplate|cuirass|hauberk/i.test(n)
          && !skills.weaponScore(e.name);
    });

    const result = {
      weapon: weaponItem ? { name: weaponItem.name, id: weaponItem.id, level: null } : null,
      armor:  armorItem  ? { name: armorItem.name,  id: armorItem.id,  level: null } : null,
    };

    for (const slot of ['weapon', 'armor']) {
      const item = result[slot];
      if (!item) continue;
      const since = c.evSeq;
      await s.pacer.submit('look', () => c.look(item.id)).catch(() => {});
      const { events } = await c.waitFor({ since, kinds: ['look'], timeoutMs: 3000 }).catch(() => ({ events: [] }));
      const desc = events.find(e => e.id === item.id)?.description ?? null;
      item.level = skills.parseConditionLevel(desc);
    }

    this._gearCondition = result;
  }

  gearConditionStatus() {
    return this._gearCondition ?? null;
  }

  // ---------------------------------------------------------------- weapon magic
  //
  // WHETHER A WEAPON IS MAGIC IS A READING, and the only two things that say so are the item's
  // look text and the owner's lapse sentence (m59-weapon-magic.mjs has the argument). The book
  // lives on the autopilot so it survives a pass and is reported by status(); it does NOT survive
  // a keeper restart, which costs one look per weapon to rebuild — cheap, and honest, because an
  // enchantment may have lapsed in the meantime.
  weaponMagicBook() {
    if (!this._weaponMagic) {
      this._weaponMagic = new WeaponMagicBook();
      // A NEW KEEPER STARTS FROM THE LAST ONE'S READINGS (WeaponMagicBook.load: carried, believed, re-checked).
      try { this._weaponMagic.load(JSON.parse(readFileSync(weaponMagicFile(this.s?.name), 'utf8'))); } catch {}
    }
    return this._weaponMagic;
  }
  /** Save the readings for the keeper that replaces this one. Best effort; called after every sweep. */
  saveWeaponMagic() {
    try {
      const f = weaponMagicFile(this.s?.name);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(`${f}.${process.pid}.tmp`, JSON.stringify(this.weaponMagicBook().toJSON()));
      renameSync(`${f}.${process.pid}.tmp`, f);
    } catch {}
  }

  /** Ids the overfarm swap may never trade away: magic weapons (the book) and the one in hand. */
  overfarmKeepIds() {
    const ids = this.weaponMagicBook().keepIds();
    const w = this.wieldedWeaponId();
    if (w != null && Number(w) >= 0) ids.add(Number(w));
    return ids;
  }

  packWeapons(c = this.s.client) {
    return (c?.inventory ?? []).map(o => ({ id: o.id, name: c.rsc?.get?.(o.nameRsc) || '' }))
      .filter(i => i.name && skills.weaponScore(i.name) > 0);
  }

  wieldedWeaponId(c = this.s.client) {
    const eq = c?.equipment?.();
    if (!eq?.known) return null;
    const w = eq.equipped.find(e => e.name && skills.weaponScore(e.name) > 0);
    return w?.id ?? null;
  }

  weaponMagicStatus() {
    const c = this.s.client;
    if (!c?.inventory) return null;
    const sum = this.weaponMagicBook().summary(this.packWeapons(c), this.wieldedWeaponId(c),
      undefined, skills.brokenSet(c));
    // A SUSPECT WHOSE WEAPON IS NO LONGER IN HAND IS OVER, however it came off (broke, uncursed).
    const inHand = this.wieldedWeaponId(c);
    if (this._curseSuspect && inHand != null && inHand !== this._curseSuspect.id)
      this.clearCurseSuspect('the suspected weapon is no longer in hand');
    return { ...sum, prefer_magic: this.policy?.preferMagicWeapon === true,
             swapped_at: this._magicSwapAt ?? null, lapses: this._magicLapses ?? 0,
             curse_suspect: this._curseSuspect ?? null };
  }

  // A CURSE SUSPECT: the weapon in hand will not come off, so the keeper cannot arm itself for its
  // work, and the cure is somebody else's spell. Published on `weapon_magic.curse_suspect` for a bot
  // to act on (meridian59-dum-bot desk-uncurse-a-visitor walks the wearer to the desk). Operator,
  // 2026-10-16: "an un-curse DUM-bot request that gets triggered if a bot finds itself cursed and
  // needing to switch weapons for farming reasons".
  //
  // CERTAIN or SUSPECTED. Certain is the server's own sentence ("seems to cling to your hand",
  // wacursed.kod:35). Suspected is CURSE_SUSPECT_REFUSALS swaps off the same weapon refused in a row
  // with no reason given -- operator, 2026-09-27: "any suspected curse should just get a remove
  // curse", because a remove curse on a clean target is refused before any mana or emerald is spent.
  // `since` is stable for one incident (same weapon in hand), so a bot can count its own attempts.
  // upkeep.curse (tools/m59-joints.mjs): once a minute, show a pak what this body knows about its own curse
  // -- rpg/sheet.mjs `curse`, which is the server's evidence and never a debuff -- and let it ask the fleet's
  // service board for a remove curse. Added with the joints, not moved; with no pak it returns at once.
  jointCurseUpkeep() {
    const joints = this.s?.joints;
    if (!joints?.handles?.('upkeep.curse')) return null;
    const now = Date.now();
    if (now - (this._curseUpkeepAt ?? 0) < 60_000) return null;
    this._curseUpkeepAt = now;
    try {
      const c = this.s.client;
      const self = selfFacts(this.s, { keeper: this });
      const d = joints.ask('upkeep.curse', { ...roomFacts(this.s), self,
        can_cast: (c?.spells ?? []).map(sp => String(c.rsc?.get?.(sp.nameRsc) ?? sp.name ?? '').toLowerCase()).filter(Boolean) });
      if (d?.do === 'request') joints.effects.request?.({ service: d.service, target: self.name, why: d.why, pak: d.pak,
        joint: 'upkeep.curse', from: self.name, ttl_ms: 10 * 60_000 });
      return d;
    } catch { return null; }
  }

  noteCurseSuspect({ items = [], said = null, certain = false, why = null } = {}) {
    const held = (items ?? [])[0] ?? null;
    const prev = this._curseSuspect;
    const same = prev && held && prev.id === held.id;
    if (same && (prev.certain || !certain)) { prev.last_at = Date.now(); return prev; }
    const now = Date.now();
    this._curseSuspect = { id: held?.id ?? null, name: held?.name ?? null, certain: !!certain,
      said: said ?? null, since: same ? prev.since : now, last_at: now,
      why: why ?? (certain ? 'the server said the weapon in hand clings to the hand'
                           : 'swaps off the weapon in hand keep being refused') };
    this.note('CURSE SUSPECTED', { ...this._curseSuspect,
      note: 'the weapon in hand will not come off; a remove curse is the cure' });
    try { this.ledgerEvent('curse_suspected', { item: held?.name ?? null, item_id: held?.id ?? null,
      certain: !!certain, said: said ?? null, room: this.s.world?.room?.num ?? null }); } catch {}
    return this._curseSuspect;
  }

  clearCurseSuspect(why) {
    this._swapRefusals = null;
    const was = this._curseSuspect;
    if (!was) return;
    this._curseSuspect = null;
    this.note('curse suspect cleared', { item: was.name, item_id: was.id, why });
    try { this.ledgerEvent('curse_suspect_cleared', { item: was.name, item_id: was.id, why,
      held_ms: Date.now() - was.since }); } catch {}
  }

  // One swap's outcome. Returns whether the hand changed. Only a use the server actually REFUSED
  // counts toward a suspicion: a veto, a cancel, a ranking that kept the held weapon, an empty
  // candidate list or a broken candidate is not the hand refusing to let go.
  noteSwapOutcome(r, before, after) {
    const swapped = after != null && after !== before;
    if (swapped) { this.clearCurseSuspect('a swap went through: the hand let go'); return true; }
    if (r?.cursed_in_hand?.length) return false;          // filed already, by onCursedInHand
    const refused = (Array.isArray(r?.rejected) ? r.rejected : [])
      .filter(x => !/broken/i.test(String(x?.why ?? '')));
    if (before == null || r?.vetoed || r?.cancelled || r?.already_wielded || !refused.length) return false;
    const n = this._swapRefusals?.held === before ? this._swapRefusals.count + 1 : 1;
    this._swapRefusals = { held: before, count: n };
    if (n >= CURSE_SUSPECT_REFUSALS) {
      const c = this.s.client;
      const o = (c?.inventory || []).find(x => x.id === before);
      this.noteCurseSuspect({ items: [{ id: before, name: o ? (c.rsc.get(o.nameRsc) || null) : null }],
        certain: false, why: `${n} swaps off the weapon in hand refused in a row, no reason given` });
    }
    return false;
  }

  // A CURSE WAS LIFTED. `item` is the name the server gave, or null for the cast's own line (which
  // names nothing). Recorded as `uncursed` so a release can be audited; the item's own cursed mark
  // is cleared so the ranking may consider it again once it is revealed.
  // RAN OUT IN THE MIDDLE OF A CAST: "You don't have the reagents to cast <spell>!" (spell.kod:52).
  // The first time is the trigger (operator, 2026-10-16): the spell's reagents, from the kod
  // catalogue, go on the fleet board as a need, and every keeper nearby with them spare hands them
  // over (shareSpareReagents). Nothing has to be configured on the character that ran dry.
  noteReagentRefusal(spell) {
    const cost = spellCost(spell);
    if (!cost?.reagents?.length) {
      this.note('ran out of reagents for a spell the catalogue does not cost', { spell });
      return null;
    }
    this._reagentShortfall = shortfallTargets(cost, this._reagentShortfall ?? new Map());
    const asked = Object.fromEntries([...this._reagentShortfall].map(([k, s]) => [k, s.target]));
    this.note('ran out of reagents: asking the fleet', { spell, reagents: cost.reagents, targets: asked,
      why: 'a cast refused for reagents is a need the fleet can answer; anyone nearby with them spare will hand them over' });
    try { this.ledgerEvent('reagent_shortfall', { spell, targets: asked, room: this.s.world?.room?.num ?? null }); } catch {}
    try { this.declareInterest(); } catch {}
    return asked;
  }

  noteUncursed(item, said = null) {
    // THE CURSED MARK STAYS (operator, 2026-10-23: "fix the curse with uncurse & dropping it"). A remove
    // curse UNUSES what it frees (player.kod RemoveCurseAllItems) but leaves the attribute on the item
    // (player.kod:10076-10091), so clearing the mark here made the freed weapon a candidate again and the
    // next equip could put the same curse straight back on. The mark is what sweepCursed drops by, and it
    // forgets the mark itself once the item has left the pack.
    this.clearCurseSuspect(item ? `remove curse released the ${item}` : 'a remove curse took');
    this.note(item ? 'CURSE LIFTED' : 'remove curse took', { item: item ?? null, said,
      why: item ? `remove curse released the ${item}; dropping it` : 'a remove curse found a cursed item on this body' });
    this.ledgerEvent('uncursed', { item: item ?? null, said, room: this.s.world?.room?.num ?? null });
    this._lastCursedSweep = 0;
    this.sweepCursed().catch(() => {});
  }

  // DROP A CURSED WEAPON ONCE IT IS OUT OF THE HAND (operator, 2026-10-23). An unread weapon is wielded
  // like any other now (skills.weaponRanking), so the only proof of a curse is the server's own refusal
  // to let go of it -- "seems to cling to your hand" on unuse or drop (wacursed.kod:35), which marks the
  // item by id (markCursedItem). Once a remove curse (or a break) has freed the hand, the item is still
  // cursed and is worth nothing to us, so it goes on the floor rather than back into the ranking.
  // Only an id the server refused to release, on an item that still grades non-normal (a curse grades
  // 100 or 200, GetRarity item.kod:714-730), so an id recycled onto an ordinary item after a save is not
  // dropped. Protected names are never dropped.
  async sweepCursed() {
    if (Date.now() - (this._lastCursedSweep ?? 0) < 20_000) return null;
    this._lastCursedSweep = Date.now();
    const s = this.s, c = s.client;
    const marks = c?._cursedItemIds;
    if (!c || !marks?.size) return null;
    const worn = skills.equippedNow(c);
    if (!worn) return null;
    const dead = (c.inventory || [])
      .map(o => ({ o, name: c.rsc.get(o.nameRsc) || '' }))
      .filter(({ o, name }) => marks.has(o.id) && !worn.has(o.id) && Number(o.rarity) !== 0 &&
        skills.weaponScore(name) > 0 && !skills.itemIsProtected(name, this.protectedItemNames()));
    if (!dead.length) return null;
    const dropped = [];
    for (const { o, name } of dead.slice(0, 3)) {
      await s.pacer.submit('drop', () => c.drop([this.dropSpec(o)])).catch(() => {});
      await new Promise(r => setTimeout(r, 700));
      dropped.push({ id: o.id, name });
    }
    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
    const still = new Set((c.inventory || []).map(o => o.id));
    const gone = dropped.filter(d => !still.has(d.id));
    for (const d of gone) { marks.delete(d.id); marks.delete(`name:${String(d.name).trim().toLowerCase()}`); }
    this.note('dropped cursed weapon', { dropped: gone.map(d => d.name), refused: dropped.length - gone.length,
      why: 'the hand refused to release it, so it is cursed; a curse stays on the item after a remove curse' });
    try { this.ledgerEvent('cursed_dropped', { items: gone.map(d => d.name), room: this.s.world?.room?.num ?? null }); } catch {}
    return { dropped: gone };
  }

  // THE LAPSE, at the packet boundary. The sentence names a weapon and no id, so every reading
  // of that name is re-opened and the next sweep runs NOW rather than on its minute clock.
  noteEnchantLapse(name) {
    if (!name) return;
    const reopened = this.weaponMagicBook().lapse(name);
    this._magicLapses = (this._magicLapses ?? 0) + 1;
    this._weaponMagicAt = 0;
    this._magicSwapDue = true;
    this.note('ENCHANTMENT LAPSED', { weapon: name, readings_reopened: reopened.length,
      why: 'the server said the weapon seems a little more ordinary; re-read and swap to a magic spare' });
    this.ledgerEvent('enchant_lapse', { weapon: name });
    this.sweepWeaponMagic().catch(() => {});
  }

  // THE OTHER DIRECTION: "Your <name> is now dedicated to Kraanan." (name given) or "This weapon is
  // already dedicated to Kraanan." (null). Re-open the readings it could be about and look again now,
  // so a fresh dedication � or one the book had filed as mundane � reaches the swap within a sweep.
  // A WEAPON HANDED BACK: forget its reading and look again now. The troll crew's dedications are cast
  // by a fleet-mate, who alone hears "Your <name> is now dedicated to Kraanan", and the weapon comes back
  // under the same id -- so the owner's book went on calling it mundane. East Jasper, 2026-10-16
  // 22:07-22:13: three of Scooter's long swords dedicated by Pepe and by himself, and all still read
  // mundane, so DUM held him at the stage room and dedicated the next spare.
  noteWeaponArrived(ids = []) {
    const forgotten = this.weaponMagicBook().forget(ids);
    if (!forgotten.length) return;
    this._weaponMagicAt = 0;
    this._magicSwapDue = true;
    this.note('WEAPON BACK IN THE PACK', { ids: forgotten,
      why: 'a weapon returned under an id the book had read; somebody may have dedicated it, so read it again' });
    this.sweepWeaponMagic().catch(() => {});
  }

  noteDedication(name = null) {
    const reopened = this.weaponMagicBook().reopen(name);
    this._weaponMagicAt = 0;
    this._magicSwapDue = true;
    this.note('DEDICATION SEEN', { weapon: name, readings_reopened: reopened.length,
      why: 'the server said a weapon is dedicated to Kraanan; re-read before trusting the book' });
    this.sweepWeaponMagic().catch(() => {});
  }

  // A LOOK PER UNREAD WEAPON, at most two a sweep, on a one-minute clock (immediately after a
  // lapse). Same id-checked shape as sweepGearCondition: a look reply carrying another id is
  // discarded, never recorded against this one.
  // DROP CONJURED WEAPONS NOBODY IS USING. Operator, 2026-10-07: "make them drop conjured weapons
  // they're not using! we don't want inventories filling up with unaccountable garbage."
  //
  // A `create weapon` result is ItemAttMade: temporary, and refused by every merchant
  // (CanBeGivenToNPC), so a town trip cannot sell it and it rides in the pack until it expires.
  // The only cleanup that existed ran for weapons the character is BANNED from, so an allowed
  // weapon from a missed roll — a long sword, when the bout wanted an axe — was never shed: the
  // fleet carried 20 to 29 each on 2026-10-07, ~1,750 bulk a pack, which kept every pack near full
  // while the overfarm trip trigger (bulk SIFTED this lap) barely moved.
  //
  // Same safety as the banned-hoard path: clearConjureHoard drops only what a fresh LOOK proves is
  // conjured ("It shimmers insubstantially"); a looted weapon of the same name is sale stock and is
  // remembered as ordinary so it is looked at once. Never the weapon in hand, never a protected
  // name, and one spare of this character's training weapon is kept so a bout need not re-roll.
  // Every 5 minutes at most, a few looks at a time, and not while anything is hitting us.
  async shedUnusedConjures() {
    if (this.policy.dropJunk === false || this._conjureShedBusy) return;
    if (Date.now() - (this._conjureShedAt ?? 0) < (this.policy.conjureShedMs ?? 300_000)) return;
    const s = this.s, c = s.client;
    const equipment = c?.equipment?.();
    if (!c || equipment?.known !== true) return;
    if ((this.threat?.().landing ?? 0) > 0) return;
    this._conjureShedBusy = true;
    this._conjureShedAt = Date.now();
    try {
      const nameOf = o => String(c.rsc?.get?.(o.nameRsc) ?? o.name ?? '').toLowerCase();
      const knownOrdinary = (this.ordinaryBannedIds ??= new Set());
      const worn = new Set(equipment.equipped.map(e => e.id));
      const spareOf = String(this.policy.trainingWeapon ?? '').trim().toLowerCase();
      let spareKept = false;
      const candidates = [];
      for (const o of c.inventory ?? []) {
        const n = nameOf(o);
        if (worn.has(o.id) || knownOrdinary.has(o.id) || !CONJURABLE_WEAPONS.includes(n)) continue;
        if (spareOf && n === spareOf && !spareKept) { spareKept = true; continue; }
        candidates.push(o);
      }
      const generation = s.movementGeneration;
      const cancelled = () => s.movementGeneration !== generation || (this.threat?.().landing ?? 0) > 0;
      await this.capFieldWeapons({ nameOf, worn, spareOf, cancelled }).catch(() => null);
      if (!candidates.length) return;
      const eligible = o => {
        const eq = c.equipment?.();
        return eq?.known === true && !eq.equipped.some(e => e.id === o.id) && !this.wontDrop?.has(o.id) &&
          !skills.itemIsProtected(nameOf(o), this.protectedItemNames());
      };
      const cleanup = await clearConjureHoard(s, candidates, { eligible, cancelled, maxInspections: 8 });
      for (const id of cleanup.ordinary ?? []) knownOrdinary.add(id);
      for (const id of cleanup.dropped ?? []) (this.s._shedIds ??= new Map()).set(id, Date.now());
      if (cleanup.dropped?.length) {
        this.tally.conjures_shed = (this.tally.conjures_shed || 0) + cleanup.dropped.length;
        this.note('dropped conjured weapons nobody is using', {
          dropped: cleanup.dropped.length, still_to_check: Math.max(0, candidates.length - 8),
          ordinary_kept: cleanup.ordinary?.length || undefined,
          why: 'a create-weapon result cannot be sold and only fills the pack; the one in hand and ' +
               'one spare of the training weapon are kept' });
      }
    } finally { this._conjureShedBusy = false; }
  }

  // AND NOT A PILE OF LOOTED ONES EITHER. The same night it turned out the 20-29 long swords each
  // farmer carried were not conjured at all: Castle Victoria's skeletons drop worn long swords
  // ("well worn and may not last much longer"), and Lew looted 32 in one day. `maxWeapons` (2) was
  // only applied when SELLING on a town trip or clearing a FULL pack, so below the 85% selectivity
  // line and with town trips rare, they rode along indefinitely. In the field it now holds too:
  // beyond the weapon in hand, one spare of the training weapon and protected names, at most
  // `maxWeapons` spare weapons are carried; extras go, duplicates of a name first, then the
  // lowest-scored. A dropped worn sword is a few shillings; a pack that never fills is the trips.
  // WHAT A TRADE GAVE US, WRITTEN DOWN (m59-received.mjs). The server's "trade over" is the same packet for a completed
  // trade and a cancelled one, so: when a trade in which we were the RECEIVER ends, the offered names whose count in the
  // pack went up are what arrived. Read on every pass from the event stream; settled within 30s. Never throws.
  noteReceivedGoods() {
    try {
      const c = this.s?.client;
      if (!c || typeof c.eventsSince !== 'function') return;
      const counts = () => {
        const m = new Map();
        for (const o of c.inventory ?? []) { const n = String(c.rsc?.get?.(o.nameRsc) ?? o.name ?? '').toLowerCase(); if (n) m.set(n, (m.get(n) ?? 0) + (o.amount > 0 ? o.amount : 1)); }
        return m;
      };
      if (this._recvCursor == null || this._recvClient !== c) { this._recvClient = c; this._recvCursor = c.evSeq ?? 0; this._recvCounts = counts(); return; }
      for (const e of c.eventsSince(this._recvCursor) ?? []) {
        if (Number.isFinite(e?.seq)) this._recvCursor = Math.max(this._recvCursor, e.seq);
        const was = e?.was;
        if (e?.kind === 'trade-ended' && was?.role === 'recipient' && was.theirs?.length)
          (this._recvPending ??= []).push({ theirs: was.theirs, from: was.withName ?? null, before: this._recvCounts, at: Date.now() });
      }
      if (Number.isFinite(c.evSeq)) this._recvCursor = Math.max(this._recvCursor, c.evSeq);
      const now = counts();
      for (const p of [...(this._recvPending ?? [])]) {
        const got = arrivedFrom(p.theirs, p.before, now);
        if (got.length) {
          noteReceived(this.s?.name ?? '', got, { from: p.from });
          this.note('received by trade', { from: p.from, items: got, why: 'a delivery is protected from the field weapon cap for a while' });
        }
        if (got.length || Date.now() - p.at > 30_000) this._recvPending = this._recvPending.filter(x => x !== p);
      }
      if (!(this._recvPending ?? []).length) this._recvCounts = now;
    } catch { /* bookkeeping only */ }
  }

  // WHAT THIS KEEPER HOLDS BACK FROM EVERY RULE THAT GIVES, SELLS, EJECTS OR DROPS: a weapon the reading book knows is
  // enchanted (a dedication is not stock), and what arrived by trade within the protection window (m59-received.mjs). One
  // answer for every such path. Prod 2026-10-27: the field cap dropped a desk's six delivered maces after a handoff, and
  // the sharing rule gave Piggy's only dedicated mace to a fleet-mate's weapon demand -- twice in 32 seconds.
  /** Set of item ids this keeper holds back. */
  heldBackIds(c = this.s?.client) {
    const out = new Set();
    // Reconciled against the pack AS IT IS NOW first: a server save between sweeps renumbers every id, and keepIds over
    // the old ones protects nothing (Clifford's dedicated mace, dropped 2026-10-27 sixteen minutes after a save).
    try { const book = this.weaponMagicBook(); book.reconcile?.(this.packWeapons(c)); for (const id of book.keepIds()) out.add(Number(id)); } catch {}
    try {
      const left = new Map(protectedReceived(this.s?.name ?? ''));
      for (const o of c?.inventory ?? []) {
        const n = String(c.rsc?.get?.(o.nameRsc) ?? o.name ?? '').toLowerCase();
        if ((left.get(n) ?? 0) > 0) { out.add(Number(o.id)); left.set(n, left.get(n) - (o.amount > 0 ? o.amount : 1)); }
      }
    } catch {}
    return out;
  }

  /** Spare weapons counted against maxWeapons: not in hand, not protected, past one training spare. */
  fieldSpareWeapons(c = this.s.client) {
    const nameOf = o => String(c?.rsc?.get?.(o.nameRsc) ?? o.name ?? '').toLowerCase();
    const eq = c?.equipment?.();
    const worn = new Set((eq?.known ? eq.equipped : []).map(e => e.id));
    const spareOf = String(this.policy.trainingWeapon ?? '').trim().toLowerCase();
    // NOT A SPARE: what this keeper holds back (heldBackIds: enchanted, or just delivered).
    const held = this.heldBackIds(c);
    let spareSeen = false;
    const spares = [];
    for (const o of c?.inventory ?? []) {
      const n = nameOf(o);
      if (worn.has(o.id) || skills.weaponScore(n) <= 0) continue;
      if (skills.itemIsProtected(n, this.protectedItemNames())) continue;
      if (held.has(Number(o.id))) continue;
      if (spareOf && n === spareOf && !spareSeen) { spareSeen = true; continue; }
      spares.push(o);
    }
    return spares;
  }

  /** What the floor looter needs to stop at the cap; null when there is no cap or no equipment read. */
  fieldWeaponCap() {
    const max = Number(this.policy.maxWeapons);
    if (this.policy.dropJunk === false || !Number.isFinite(max) || max < 0) return null;
    if (this.s.client?.equipment?.()?.known !== true) return null;
    return { max, count: () => this.fieldSpareWeapons().length };
  }

  async capFieldWeapons({ nameOf, cancelled }) {
    const max = Number(this.policy.maxWeapons);
    if (!Number.isFinite(max) || max < 0) return;
    const c = this.s.client;
    const spares = this.fieldSpareWeapons(c);
    const extra = spares.length - max;
    if (extra <= 0) return;
    const seen = new Map();
    const ranked = spares.map(o => {
      const n = nameOf(o), k = seen.get(n) ?? 0;
      seen.set(n, k + 1);
      return { o, dup: k, score: skills.weaponScore(n) };
    }).sort((x, y) => (y.dup > 0) - (x.dup > 0) || x.score - y.score);
    const dropped = [];
    for (const { o } of ranked.slice(0, Math.min(extra, 10))) {
      if (cancelled()) break;
      if (!(c.inventory ?? []).some(x => x.id === o.id)) continue;
      await this.s.pacer.submit('drop', () => c.drop([this.dropSpec(o)]));
      (this.s._shedIds ??= new Map()).set(o.id, Date.now());
      dropped.push(nameOf(o));
      await new Promise(r => setTimeout(r, 400));
    }
    if (dropped.length) {
      await this.s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
      this.tally.weapons_shed = (this.tally.weapons_shed || 0) + dropped.length;
      this.note('dropped spare weapons over maxWeapons', { dropped: dropped.length,
        names: [...new Set(dropped)], max_weapons: max, still_over: Math.max(0, extra - dropped.length),
        why: 'looted spares beyond maxWeapons only fill the pack between rare town trips' });
    }
  }

  async sweepWeaponMagic() {
    const gapMs = this._magicSwapDue ? 0 : 60_000;
    if (Date.now() - (this._weaponMagicAt ?? 0) < gapMs) return;
    // A SWEEP THAT NEVER RETURNS MUST NOT HOLD THE FLAG FOR EVER (2026-10-26: every crew weapon stayed `unknown` for hours
    // and not one look was ever recorded -- consistent with a sweep stuck inside its first look, busy flag set). A flag
    // older than two minutes is a hung sweep, not a running one.
    if (this._weaponMagicBusy && Date.now() - (this._weaponMagicBusyAt ?? 0) < 120_000) return;
    this._weaponMagicBusy = true; this._weaponMagicBusyAt = Date.now();
    this._weaponMagicAt = Date.now();
    try {
      const s = this.s, c = s.need();
      const book = this.weaponMagicBook();
      const items = this.packWeapons(c);
      book.reconcile(items);
      for (const item of book.needsLook(items).slice(0, 2)) {
        const since = c.evSeq;
        book.noteLook(item.id, 'pending');
        // BOUNDED: a paced look that never resolves used to hang the whole sweep (see the busy flag above).
        const sent = await Promise.race([
          s.pacer.submit('look', () => c.look(item.id)).then(() => true, () => true),
          new Promise(r => setTimeout(() => r(false), 8000))]);
        if (!sent) { book.noteLook(item.id, 'pacer_timeout'); continue; }
        const { events } = await c.waitFor({ since, kinds: ['look'], timeoutMs: 5000 })
          .catch(() => ({ events: [] }));
        const desc = events.find(e => e.id === item.id)?.description ?? null;
        if (desc != null) book.record(item.id, item.name, desc);
        // Say why it is still unknown (see WeaponMagicBook.noteLook): no reply at all, or a reply about another id.
        book.noteLook(item.id, desc != null ? 'ok' : events.length ? 'other_id' : 'no_reply');
      }
      await this.applyMagicPreference(c, items);
    } finally { this._weaponMagicBusy = false; this.saveWeaponMagic(); }
  }

  // THE CLIENT'S MAGIC SET, REBUILT FROM THE BOOK. Synchronous, no wire. `weaponRanking` breaks a
  // tie toward `c._magicWeaponIds`, and that set lives on the CLIENT — which a reconnect replaces —
  // while the readings live in the book, which survives it. The set used to be written only by the
  // magic sweep inside passFarm, a rung the recovery ladder pre-empts for minutes at a time, so a
  // keeper that reconnected to shed aggro fought with an empty set: 2026-09-27 Animal went back to
  // a conjured mundane long sword in Ukgoth with the enchanted twin in his pack, and the trolls
  // rule stood him down "not ready". Every fight entry calls this, so the equip inside the fight
  // always ranks with the book's answer.
  syncMagicSet(c = this.s?.client, items = null) {
    if (!c) return null;
    const on = this.policy?.preferMagicWeapon === true;
    const sum = this.weaponMagicBook().summary(items ?? this.packWeapons(c), this.wieldedWeaponId(c),
      undefined, skills.brokenSet(c));
    // WHAT WAS CONJURED, whatever the policy: the sale plan skips it (inventorySalePlan), because
    // no merchant takes a made item and offering one is a refusal that reads like a bad price.
    c._madeItemIds = new Set(sum.weapons.filter(w => w.made === true).map(w => w.id));
    // Read as NOT conjured: a remembered summon id that now names one of these is looted, not ours.
    c._notMadeIds = new Set(sum.weapons.filter(w => w.made === false).map(w => w.id));
    const mundane = !on && this.policy?.preferMundaneWeapon === true;
    c._magicWeaponIds = on || mundane
      ? new Set(sum.weapons.filter(w => w.bypasses_nonmagic === true).map(w => w.id)) : null;
    c._preferMundane = mundane;
    return sum;
  }

  // THE ONE-SECOND HALF OF THE UKGOTH STRATEGY: keep the client's magic set current, and when the
  // weapon in hand is not known magic but a same-rank spare is, wield the spare. equipBest does
  // the swap and its verification; the ranking's tie-break is what makes it choose the spare.
  async applyMagicPreference(c = this.s.client, items = this.packWeapons(c)) {
    const on = this.policy?.preferMagicWeapon === true;
    const sum = this.syncMagicSet(c, items);
    const due = this._magicSwapDue; this._magicSwapDue = false;
    // PREFER MUNDANE: a magic weapon in hand with a mundane same-name spare in the pack -> equipBest swaps (the
    // ranking's inverted tie-break chooses the spare). The dedicated one is kept for the troll rooms.
    if (!on && this.policy?.preferMundaneWeapon === true) {
      const ws = sum?.weapons ?? [];
      const held = ws.find(w => w.wielded);
      const spare = held && held.bypasses_nonmagic === true
        && ws.find(w => !w.wielded && w.bypasses_nonmagic !== true && !w.broken && String(w.name) === String(held.name));
      if (!spare) return null;
      if (!due && Date.now() - (this._magicSwapAt ?? 0) < 30_000) return null;
      this._magicSwapAt = Date.now();
      const before = this.wieldedWeaponId(c);
      const r = await skills.equipBest(this.s, { priority: this.weaponPriorityNow?.() ?? null, banned: this.bannedWeaponsNow?.() ?? null })
        .catch(e => ({ ok: false, why: e.message }));
      const swapped = this.noteSwapOutcome(r, before, this.wieldedWeaponId(c));
      this.note('MUNDANE SWAP', { to: spare.id, result: swapped, ...swapWhyNot(r, swapped),
        why: 'prefer_mundane_weapon: the dedicated weapon is kept for the troll rooms' });
      return r;
    }
    if (!on) return null;
    const priority = this.weaponPriorityNow?.() ?? null;
    const rank = n => {
      if (!priority?.length) return 0;
      const i = priority.findIndex(p => String(n).toLowerCase().includes(String(p).toLowerCase()));
      return i === -1 ? priority.length : i;
    };
    // A BANNED MAGIC SPARE IS NOT A CANDIDATE. Magic now beats the family, so without this the swap
    // would pick an enchanted scimitar its owner bans, equipBest would refuse it, and the keeper
    // would try again every thirty seconds.
    const banned = this.bannedWeaponsNow?.() ?? null;
    // EXCEPT A MYSTIC SWORD AGAINST TROLLS, which no ban takes out (skills.isMysticSword).
    const trolls = this.huntsTrolls();
    const id = magicSwap({ ...sum, weapons: (sum?.weapons ?? []).filter(w => w.wielded ||
      (trolls && skills.isMysticSword(w.name)) || !skills.isBannedWeapon(w.name, banned)) }, rank);
    if (id == null) return null;
    if (!due && Date.now() - (this._magicSwapAt ?? 0) < 30_000) return null;
    this._magicSwapAt = Date.now();
    const before = this.wieldedWeaponId(c);
    const r = await skills.equipBest(this.s, { priority, banned })
      .catch(e => ({ ok: false, why: e.message }));
    // THE RESULT IS WHETHER THE HAND CHANGED. This read `r?.ok`, a field equipBest never returns,
    // so every swap -- the ones that worked included -- was journalled `result: null`.
    const swapped = this.noteSwapOutcome(r, before, this.wieldedWeaponId(c));
    this.note('MAGIC SWAP', { to: id, result: swapped, ...swapWhyNot(r, swapped),
      why: 'the weapon in hand is not read as magic and a same-rank spare is' });
    return r;
  }
  // @end 1
}
