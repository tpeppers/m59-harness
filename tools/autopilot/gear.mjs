// GEAR: reagents, cooking, conjured weapons, arming, armour, overdrive and meals.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 17 methods: reagentCount, overfarmScale, overfarmHoldsTrip, supplyShortfall, cookSomething,
//   makeWeapon, armSelf, rouletteTarget, trainingWeaponRoulette, knowsCreateWeapon,
//   wearLootedArmour, savedArmourName, wearIntoEmptySlots, wearArmourIfNeeded, startOverdrive,
//   endOverdrive, recordAte
import { withCastRite } from '../m59-castrite.mjs';
import { clearConjureHoard } from '../m59-conjure-cleanup.mjs';
import { recordEvent } from '../m59-ledger.mjs';
import { wantsOf } from '../m59-loadout.mjs';
import * as skills from '../m59-skills.mjs';
import { CONJURABLE_WEAPONS, CONJURED_WEAPON_BULK, CONJURE_HOARD_LIMIT, CREATE_FOOD_MANA, ROULETTE_UNTIL, SPELL_EXERTION_VIGOR, conjurePowerEstimate, pct, vigorOf } from '../m59-autopilot.mjs';

export class GearPart {
  // @part 1

  // A training bout belongs to one quarry. `skills.fight` deliberately resumes a
  // damaged target over a fresh one because changing targets discards advancement
  // credit; weapon style has to be just as sticky or an interrupted fight can count
  // once with each hand. The next style flips when a new quarry is selected.
  // What `create food` eats: 2 ElderBerry and 2 Herbs, from OUR pack, and it refuses
  // SILENTLY without them — so the count has to be checked before casting rather than
  // inferred from a failure.
  reagentCount() {
    const c = this.s.client;
    const n = (re) => (c?.inventory || [])
      .filter(o => re.test(c.rsc.get(o.nameRsc) || ''))
      .reduce((t, o) => t + (o.amount || 1), 0);
    return { elderberry: n(/elder\s?berry/i), herbs: n(/^herbs?$/i) };
  }

  // WHAT THIS CHARACTER IS SHORT OF, against its own loadout floors rather than a
  // constant. Returns short:false when there is no loadout to read, because an absent
  // floor is not a floor of zero — it is nobody having said, and the safe reading of
  // nobody having said is "carry on as before".
  //
  // Food counts as well as reagents: a pack with meals in it can raise vigor without
  // casting at all, so a character with bread is not out of supply just because the
  // reagents are gone. That is the whole point of carrying prepared food.
  /**
   * How much longer than an ordinary lap this character intends to farm, as a multiplier.
   *
   * 1 when overfarm is off, so every number downstream is untouched -- silence means the
   * behaviour that was already there.
   */
  overfarmScale() {
    const o = this.policy.overfarm;
    if (o?.enabled !== true) return 1;
    const pct = Number(o.overfarm_percent);
    return Number.isFinite(pct) && pct >= 100 ? pct / 100 : 1.5;
  }

  /**
   * Is an overfarm lap still running, and therefore holding the town trip open?
   *
   * THIS IS THE STRATEGY, not a tweak to it. Overfarming is a bet about TRAVEL OVERHEAD: the
   * money is made killing things, a trip only realises it, and a trip costs a road crossing
   * this fleet dies on. So it spends pack space to buy fewer trips, and the way it does that
   * is by usurping "the pack is full" as a reason to go to town until the sift target is met.
   *
   * Returns a reason while the lap is short of target, and null once it is met -- or whenever
   * the question cannot be answered, because a hold that fires on an unreadable pack would
   * keep a character in a monster room for ever.
   */
  overfarmHoldsTrip() {
    const o = this.policy.overfarm;
    if (o?.enabled !== true) return null;
    const lap = this.s?._overfarm;
    if (!lap) return null;
    const cap = skills.carryCapacity(this.s?.client);
    // AN UNREADABLE CEILING RELEASES THE HOLD. carryCapacity withholds room_for rather than
    // guess, and an inexact load is a LOWER bound -- the same reason the sell trigger treats
    // one as "make room". Holding on a number we do not have is how a character farms until
    // it dies.
    if (!cap?.known || !(cap.weight_max > 0) || cap.load?.exact === false) return null;
    // UNARMED WITH NO ROOM TO ARM RELEASES IT TOO. Overfarming is "keep killing and trade up",
    // and a character with no weapon and too little bulk to conjure one cannot kill anything,
    // so the target is never reached and the hold is permanent: Clifford and Rowlf, room 2,
    // 2026-09-26, 99% bulk, bankRun opened by passArm and held here every pass. The trip IS
    // the way back to a weapon.
    // Only a KNOWN empty hand: an unread equipment list is not an unarmed character.
    const bulkFree = cap.room_for?.bulk;
    const eq = this.s?.client?.equipment?.();
    if (eq?.known && this.wieldedWeaponId(this.s.client) == null && Number.isFinite(bulkFree)
        && bulkFree < CONJURED_WEAPON_BULK) return null;
    const target = Math.round(this.overfarmScale() * cap.weight_max);
    if (!(lap.sifted < target)) return null;
    return { held: true, sifted: lap.sifted, target,
             sifted_percent: Math.round((lap.sifted / cap.weight_max) * 100),
             target_percent: Math.round(this.overfarmScale() * 100) };
  }

  supplyShortfall() {
    const l = this.loadout();
    if (!l?.carry?.length) return { short: false, missing: [], why: 'no loadout floor to read' };
    const c = this.s.client;
    const items = (c?.inventory || []).map(o => ({ name: c.rsc.get(o.nameRsc), amount: o.amount }));
    const want = wantsOf(l, items);
    const reagents = this.reagentCount();
    const meals = this.larder(c).length;
    // Only the two halves of `create food` are treated as supply. A loadout may ask for
    // anything, and being short of a spare shield is not a reason to stop fighting.
    const missing = (want?.wants || []).filter(n => /elder\s?berry|^herbs?$/i.test(n));
    if (!missing.length) return { short: false, missing: [], reagents, meals };
    // With food still aboard the character can eat rather than cook, so the trip can wait
    // until that runs out too — which is what makes prepared food worth the pack space.
    if (meals > 0) return { short: false, missing, reagents, meals, why: 'still has meals' };
    return { short: true, missing, reagents, meals };
  }

  // COOK. Returns true if we cast and something appeared, meaning the pass was spent.
  //
  // `why` is the decision that brought us here, carried into the record. It defaults to
  // the only caller's reason rather than to nothing, because "cast create food" with no
  // reason attached is exactly the un-auditable line this is meant to replace.
  async cookSomething(why = 'the larder is empty') {
    const s = this.s, c = s.client;
    const r = this.reagentCount();
    if (r.elderberry < 2 || r.herbs < 2)
      return this.declinedCast('create food', 'not enough reagents',
        { have: r, needs: '2 elderberry + 2 herbs' });
    // c.spells is empty until asked for — reading it cold is the phantom "the spell
    // did not encode" bug.
    await s.pacer.submit('read', () => c.requestSpells()).catch(() => {});
    await new Promise(x => setTimeout(x, 400));
    const spell = (c.spells || []).find(sp => (c.rsc.get(sp.nameRsc) || '').toLowerCase() === 'create food');
    if (!spell)
      return this.declinedCast('create food', 'the character does not have the spell',
        { note: 'an unknown spell and an unlearned one are both simply absent from plSpells' });
    // MANA IS THE CONSTRAINT, NOT THE REAGENTS. Checked BEFORE the cast, because a cast
    // that cannot afford itself is refused silently and looks exactly like every other
    // silent refusal.
    //
    // `create food` costs 10 mana (viMana, Kraanan school — the same number the `spells`
    // tool reports from the kod source). This function checked reagents and never mana,
    // and then the failure note blamed "the reagents having been spent or sold" — so the
    // record actively pointed away from the cause. Of twelve failures on the live fleet,
    // eleven were cast under 10 mana: Pepe at 2, 2, 2 and 3, Lew at 6, 7, 7 and 8,
    // Fozzie at 8 and 9 — while Lew was carrying 16 elderberry and 8 herbs and Zoot 30
    // and 102. Reagents were never short; the fleet had been delivering them to
    // characters that could not afford to use them.
    const manaBefore = c.vitals?.()?.mana?.value ?? null;
    if (manaBefore !== null && manaBefore < CREATE_FOOD_MANA)
      return this.declinedCast('create food', 'not enough mana',
        { mana: manaBefore, needs: CREATE_FOOD_MANA, have_reagents: r,
          note: 'mana comes back by resting; the reagents are already in the pack' });
    const had = new Set((c.inventory || []).map(o => o.id));
    await withCastRite(s, { spell, targets: [], why: 'cookSomething' }, () => s.pacer.submit('cast', () => c.cast(spell.id, []), 1050));
    await c.waitFor({ kinds: ['message', 'inventory'], timeoutMs: 4000 }).catch(() => {});
    await new Promise(x => setTimeout(x, 1000));
    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    const made = (c.inventory || []).filter(o => !had.has(o.id));
    this.vigor.cooked += made.length ? 1 : 0;
    if (!made.length) {
      this.vigor.cook_failed++;
      this.recordCast('create food', { ok: false, why, reagents_before: r,
        mana_before: manaBefore, mana_after: c.vitals?.()?.mana?.value ?? null });
      this.note('create food produced nothing', { had: r, mana: c.vitals?.()?.mana,
        mana_before: manaBefore, needs_mana: CREATE_FOOD_MANA,
        why: 'it refuses silently. Mana is checked before we get here, so reaching this ' +
             'means the cast was affordable and still made nothing — reagents spent or ' +
             'sold between the count and the cast, or the food merged into a stack we ' +
             'already carried and so shows up as no new object id' });
      return false;
    }
    this.recordCast('create food', { ok: true, why, reagents_before: r,
      made: made.map(o => c.rsc.get(o.nameRsc)),
      mana_before: manaBefore, mana_after: c.vitals?.()?.mana?.value ?? null });
    this.note('made our own food', { made: made.map(o => c.rsc.get(o.nameRsc)), from: r });
    this.progress('cooked');
    return true;
  }

  // MAKE A WEAPON RATHER THAN ASK FOR ONE.
  //
  // An unarmed character is not hunting, it is standing in a monster room punching
  // things: GetWeapon returns nothing for an empty hand and UserAttack quietly falls
  // back to a punch, so nothing about it reads as broken from the outside. The keeper
  // used to answer that by wielding whatever survived and, failing that, broadcasting
  // for charity — while carrying a spell that makes a weapon out of nothing but mana.
  //
  // `create weapon` costs 15 mana and refuses SILENTLY below it, so the check is on
  // mana before the cast rather than on the absence of an item afterwards. What it
  // makes is temporary: this buys the fight in front of us and the walk to a shop, and
  // it is not a substitute for a real blade.
  async makeWeapon(why = 'no weapon in the pack') {
    const s = this.s, c = s.client;
    if (!c) return false;
    // THE SERVER CHECKS VIGOR BEFORE MANA, SO THIS DOES TOO. Checking mana first reports
    // "not enough mana" to a character holding a full bar of it, which is precisely the
    // misdiagnosis that hid this for 5194 casts.
    const vigorNow = vigorOf(c.vitals?.());
    if ((vigorNow ?? 0) < SPELL_EXERTION_VIGOR)
      return this.declinedCast('create weapon', 'too tired',
        { vigor: vigorNow, needs: SPELL_EXERTION_VIGOR,
          why: 'spell.kod:597 CanPayManaVigor refuses under viSpellExertion and spends ' +
               'nothing, so this would look exactly like a cast that never left' });
    const mana = c.vitals?.()?.mana;
    if ((mana?.value ?? 0) < 15)
      return this.declinedCast('create weapon', 'not enough mana',
        { mana: mana?.value ?? null, needs: 15 });
    // THREE REASONS NOT TO PULL THE LEVER, ALL OF THEM KNOWABLE BEFORE PAYING.
    //
    // The existing check below reads what the spell MADE and refuses to call a banned
    // result "armed". That is the right diagnosis and it says why in as many words: "the
    // loop cannot end while the ban and the spell disagree." It does not end the loop --
    // the next pass conjures another one. These three end it.
    if (this.bareHandedByTraining())
      return this.declinedCast('create weapon', 'training unarmed on its own ground',
        { training_style: this.policy?.trainingStyle ?? null,
          why: 'the bout disarms whatever this makes, so the cast buys a weapon that is ' +
               'taken off on the first swing' });
    const bannedNow = this.bannedWeaponsNow();
    if (bannedNow?.length) {
      const reachable = CONJURABLE_WEAPONS.filter(w =>
        !bannedNow.some(b => w.includes(String(b).toLowerCase()) ||
                             String(b).toLowerCase().includes(w)));
      if (!reachable.length)
        return this.declinedCast('create weapon', 'every weapon it could make is banned',
          { banned_weapons: bannedNow, could_make: CONJURABLE_WEAPONS,
            why: 'creaweap.kod can only produce these seven, and this character may hold ' +
                 'none of them, so the cast is a certainty of 15 mana and 70 bulk for an ' +
                 'item that will be refused',
            doing: 'un-ban one of them, or hand this character a weapon it may hold' });
      const hoard = this.bannedConjurablesHeld();
      let rouletteCleared = false;
      // LOOT IS NOT A LOST BET. The cap below argues from the spell's odds — "this character has
      // already banked N results it may not hold" — which is true of summons and false of an
      // orc's drops. The description check that tells them apart used to run only for
      // single-outcome weapon roulette, so everywhere else a pile of LOOTED banned weapons
      // refused the only way to arm, for ever. Measured on prod 2026-09-25: Kermit carrying five
      // orc scimitars and Scooter four, both banned from scimitars, both bare-handed at full
      // mana with UNARMED_CANNOT_CAST on every pass. The check now runs whenever the cap is
      // reached: a verified summon is dropped, an ordinary item stays (it is sale stock) and
      // stops counting against the cast. Ids already proved ordinary are remembered, so each
      // piece is looked at once rather than every pass.
      const knownOrdinary = (this.ordinaryBannedIds ??= new Set());
      if (hoard >= CONJURE_HOARD_LIMIT) {
        const generation = s.movementGeneration;
        const originalBan = JSON.stringify(bannedNow);
        const cancelled = () => s.movementGeneration !== generation ||
          JSON.stringify(this.bannedWeaponsNow()) !== originalBan;
        const nameOf = o => String(c.rsc?.get?.(o.nameRsc) ?? o.name ?? '').toLowerCase();
        const candidates = (c.inventory ?? []).filter(o =>
          !knownOrdinary.has(o.id) &&
          CONJURABLE_WEAPONS.some(w => nameOf(o).includes(w)) &&
          bannedNow.some(b => nameOf(o).includes(String(b).toLowerCase())));
        const eligible = o => {
          const equipment = c.equipment?.();
          return this.policy.dropJunk !== false && equipment?.known === true &&
            !equipment.equipped.some(e => e.id === o.id) && !this.wontDrop?.has(o.id) &&
            !skills.itemIsProtected(nameOf(o), this.protectedItemNames()) &&
            this.bannedWeaponUseless(nameOf(o));
        };
        const cleanup = await clearConjureHoard(s, candidates, { eligible, cancelled });
        for (const id of cleanup.ordinary ?? []) knownOrdinary.add(id);
        if (candidates.length)
          this.note(reachable.length === 1 ? 'cleared ineligible summons for weapon roulette'
                                           : 'sorted banned weapons into summons and loot before arming', {
            target: reachable.length === 1 ? reachable[0] : undefined, can_make: reachable, ...cleanup,
            why: 'only description-confirmed summons are dropped; ordinary weapons stay in the ' +
                 'pack as sale stock and no longer count against the cast',
          });
        if (cancelled()) return false;
        rouletteCleared = cleanup.cleared;
      }
      if (hoard >= CONJURE_HOARD_LIMIT && !rouletteCleared)
        // NOT NECESSARILY CONJURED, AND THE OLD WORDING SENT AN OPERATOR AFTER THE WRONG
        // THING. This counts weapons whose NAME a conjure could also produce, so an orc's
        // hammer counts exactly like one the fleet made. Beaker's three were all orc drops.
        // The gate is still right — three unusable weapons is three reasons not to add a
        // fourth — but the sentence has to say what was actually counted.
        return this.declinedCast('create weapon', 'already carrying unusable weapons it may not hold',
          { held: hoard, limit: CONJURE_HOARD_LIMIT, banned_weapons: bannedNow,
            can_still_make: reachable,
            why: 'the spell rolls a band rather than granting a choice, and this character ' +
                 'has already banked ' + hoard + ' results it may not hold. Casting again ' +
                 'is the same bet at the same odds, and each one costs mana and the pack ' +
                 'space that a supply would need',
            doing: 'shed the hoard, or hand it one of: ' + reachable.join(', ') });
    }
    // ONLY WHEN WE POSITIVELY KNOW THERE IS NO ROOM. carryCapacity withholds `room_for`
    // whenever anything in the pack is unweighed, and refusing on that silence would build
    // a fresh deadlock for exactly the characters this one already stranded — so an
    // unknown load still attempts the cast. Certainty in one direction only.
    const cap = skills.carryCapacity(c);
    const bulkFree = cap?.room_for?.bulk ?? null;
    if (bulkFree != null && bulkFree < CONJURED_WEAPON_BULK)
      return this.declinedCast('create weapon', 'no room for the weapon',
        { bulk_free: bulkFree, needs: CONJURED_WEAPON_BULK,
          why: 'ReqNewHold refuses on bulk and creaweap.kod deletes the weapon after the ' +
               'mana is spent, so this costs 15 mana and produces nothing' });
    await s.pacer.submit('read', () => c.requestSpells()).catch(() => {});
    await new Promise(x => setTimeout(x, 400));
    const spell = (c.spells || []).find(sp => (c.rsc.get(sp.nameRsc) || '').toLowerCase() === 'create weapon');
    if (!spell)
      return this.declinedCast('create weapon', 'the character does not have the spell');
    // STAND UP. This is the whole reason the spell appeared not to work: a sitting
    // character's cast is swallowed entirely — no mana, no message, no effect — and
    // "make a weapon" is reached almost exclusively from resting, so it was sitting
    // nearly every time. Scooter cast it forty times from an inn for nothing; standing
    // first produced a mace on the next attempt. See standToAct.
    await skills.standToAct(s).catch(() => null);
    // Standing invalidates any rest in progress, so stop believing we are seated — else
    // the unarmed branch will not sit again and the mana never comes back.
    this.sittingFor = null;
    // And shed anything already known dead, because the mana is spent whether or not the
    // weapon survives ReqNewHold (creaweap.kod:116-129).
    await skills.freeRoomFor(s).catch(() => null);
    const had = new Set((c.inventory || []).map(o => o.id));
    await withCastRite(s, { spell, targets: [], why: 'makeWeapon' }, () => s.pacer.submit('cast', () => c.cast(spell.id, []), 1050));
    await c.waitFor({ kinds: ['message', 'inventory'], timeoutMs: 4000 }).catch(() => {});
    await new Promise(x => setTimeout(x, 1000));
    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    const made = (c.inventory || []).filter(o => !had.has(o.id));
    const manaAfter = c.vitals?.()?.mana?.value ?? null;
    const spent = mana?.value != null && manaAfter != null ? mana.value - manaAfter : null;
    if (!made.length) {
      this.tally.weapons_conjured_failed = (this.tally.weapons_conjured_failed || 0) + 1;
      this.recordCast('create weapon', { ok: false, why,
        mana_before: mana?.value ?? null, mana_after: manaAfter, mana_spent: spent });
      // The mana says which failure this was, and the reply never does: nothing spent
      // means the cast did not happen at all, half means it rolled and failed, full
      // means it worked and something downstream refused the weapon.
      this.note('create weapon produced nothing', { mana: mana?.value, mana_spent: spent,
        why: spent === 0 ? 'NOTHING was spent — the cast did not happen. Still sitting, frozen, or blocked.'
           : spent != null && spent < 15 ? 'half cost — it was cast and failed its roll'
           : 'full cost — it was cast and succeeded, so the weapon was refused on being handed over' });
      return false;
    }
    const eq = await skills.equipBest(s, { priority: this.weaponPriorityNow(), banned: this.bannedWeaponsNow() }).catch(() => null);
    this.tally.weapons_conjured = (this.tally.weapons_conjured || 0) + 1;
    const madeNames = made.map(o => c.rsc.get(o.nameRsc));
    this.recordCast('create weapon', { ok: true, why, made: madeNames,
      mana_before: mana?.value ?? null, mana_after: c.vitals?.()?.mana?.value ?? null });

    // A WEAPON IN THE PACK IS NOT A WEAPON IN THE HAND, AND THIS SAID IT WAS.
    //
    // `progress('armed itself')` fired on the CAST succeeding, never on the wield. When the
    // thing it conjured is on the character's own ban list, `equipBest` correctly refuses it,
    // the character is still empty-handed, and the next pass conjures another one — a loop
    // that cannot terminate because the ban does not change and the spell keeps producing the
    // same kind of weapon.
    //
    // Measured on prod 2026-09-11. Bunsen and Robin ban long sword, short sword, mace, axe,
    // scimitar and six more; `create weapon` was making long swords. They shed 16 and 204
    // items when the pack was finally emptied by hand, and a pack that full answers
    // `receiver_full` to every `supply` — which is what actually stalled the Kraanan cohort
    // all evening, four unblockings in one night. The board meanwhile read
    // `UNARMED_NO_DONOR — waiting for mana`, so it looked like a mana problem throughout.
    const banned = this.bannedWeaponsNow();
    const blockedByBan = !eq?.wielding && banned?.length &&
      madeNames.some(nm => banned.some(b => String(nm ?? '').toLowerCase()
                                               .includes(String(b).toLowerCase())));
    if (!eq?.wielding) {
      this.note('conjured a weapon it cannot hold', {
        made: madeNames, mana_left: c.vitals?.()?.mana?.value,
        banned_weapons: blockedByBan ? banned : undefined,
        why: blockedByBan
          ? 'create weapon rolled an ineligible weapon, so equipBest refused it'
          : 'the weapon was made but nothing would wield it',
        doing: blockedByBan
          ? 'not counting this as armed; single-weapon roulette clears verified temporary misses at the hoard limit'
          : 'not counting this as armed' });
      return false;
    }
    this.note('conjured a weapon', { made: madeNames,
      now_wielding: eq?.wielding, mana_left: c.vitals?.()?.mana?.value,
      caveat: 'a made weapon is temporary — it buys this fight and the walk to a shop' });
    this.progress('armed itself');
    return true;
  }

  // ARE WE ACTUALLY ARMED, and if not, fix it with what we are carrying or can cast.
  // Called before picking a fight, because the alternative is a level-25 character
  // punching a level-30 centipede and neither the log nor the fleet page saying so.
  async armSelf() {
    const c = this.s.client;
    if (!c) return false;
    // IN A PVP FIGHT THE BODY WEARS ITS PVP GEAR, and CombatMode put it on. Re-arming here would
    // take it off for the farming set mid-fight. See m59-pvp-gear.mjs.
    if (c.pvpGearActive) return false;
    await this.wearArmourIfNeeded().catch(() => {});
    // A BRAWLER IS NOT AN UNARMED CHARACTER WITH A PROBLEM. Armour still goes on above;
    // only the weapon is declined, and only on this character's own farm ground.
    if (this.bareHandedByTraining()) {
      this.note('staying bare-handed on purpose', {
        training_style: this.policy?.trainingStyle ?? null,
        assigned_room: this.policy?.assignedRoom ?? null,
        why: 'trainingStyle is unarmed and this is the assigned farm room, so the fight ' +
             'itself will take any weapon back off (prepareTrainingStyle -> ' +
             'unuseTrainingWeapon). Arming here only pays 15 mana and 70 bulk to be ' +
             'disarmed on the first swing',
        doing: 'fighting with fists, which is what the style asked for' });
      return true;
    }
    const roulette = await this.trainingWeaponRoulette().catch(e => {
      this.note('training-weapon roulette failed', { why: e.message }); return null; });
    if (roulette?.armed) return true;
    if (skills.weaponsOf(c).length) {
      const eq = await skills.equipBest(this.s, { priority: this.weaponPriorityNow(), banned: this.bannedWeaponsNow() }).catch(() => null);
      if (eq?.wielding) return true;
    }
    return await this.makeWeapon('about to fight with nothing in hand').catch(() => false);
  }

  // THE TRAINING WEAPON, CONJURED AT THE WALL UNTIL THE SKILL IS DONE WITH IT.
  //
  // Operator, 2026-09-25: everyone under 50% hammer wielding trains hammers to 70 (the top of
  // what a level-75 skeleton still teaches), and "conjuring weapons while standing in a safe
  // spot should be the default behavior when using a weapon below a threshold".
  //
  // `training_weapon` already named the weapon, but only a TRAINING BOUT honoured it
  // (`prepareTrainingStyle`), and the wall-fight path never runs one: it equips by priority
  // from whatever is in the pack. A character told to train hammers and carrying only long
  // swords therefore swung long swords for ever. Buying hammers is not the fix either — the
  // spell makes one for 15 mana, it just does not make one EVERY time.
  //
  // So, before a pull, while standing where nothing reaches: if the armed training weapon is
  // conjurable, its proficiency is still under ROULETTE_UNTIL, and the pack holds no usable
  // one, cast `create weapon` once. A hit is wielded; a miss is dropped once its description
  // confirms it is our own summon (the same clearConjureHoard the ban roulette uses), so the
  // pack never fills with near-misses. One cast per call — mana is 21 to 33 on this fleet and
  // the fight in front of us must not wait on a lottery. Real weapons are never dropped.
  //
  // WHAT THE ODDS ARE is written to the note, because the lever is not obvious: the spell
  // rolls `Random(sp/3, sp)` and a hammer is 30-44, so the best a caster can do is ~48% at
  // spell power 44-47. Create Weapon is Kraanan, whose bonus is the number of people in the
  // room (up to 30), so a crowded Castle Victoria pushes power to 75+ and the odds to ~27%.
  /** The weapon the roulette is working towards, or null when it is not in play. */
  rouletteTarget() {
    const c = this.s?.client;
    const style = this.policy?.trainingStyle ?? 'normal';
    if (!c || style === 'normal' || style === 'unarmed') return null;
    const want = String(this.policy?.trainingWeapon ?? '').trim().toLowerCase();
    if (!CONJURABLE_WEAPONS.includes(want)) return null;
    if ((this.bannedWeaponsNow() ?? []).some(b => want.includes(String(b).toLowerCase()))) return null;
    const skill = skills.proficiencyFor(want);
    const ability = skills.abilityOf(c, skill);
    // UNKNOWN IS NOT PERMISSION: a skill the character does not hold, or whose ability has not
    // been read, does not justify spending mana on its weapon.
    if (!Number.isFinite(ability) || ability >= ROULETTE_UNTIL) return null;
    return { want, skill, ability };
  }

  async trainingWeaponRoulette() {
    const s = this.s, c = s.client;
    const target = this.rouletteTarget();
    if (!target) return null;
    const { want, skill, ability } = target;

    const nameOf = o => String(c.rsc?.get?.(o.nameRsc) ?? o.name ?? '').toLowerCase();
    const broken = skills.brokenSet(c);
    const mine = c._summoned ??= new Set();
    const isWant = o => nameOf(o) === want && !broken.has(o.id);
    // A SUMMON IS SAFE TO WIELD UNREAD. It shows rarity 100 like any unidentified weapon, and
    // the equip path refuses those because a cursed weapon can never be put down; one this
    // keeper watched appear from its own cast cannot be cursed. Allowed only when every
    // unread weapon of that name in the pack is one of ours.
    const equipWant = async () => {
      const unread = (c.inventory || []).filter(o => isWant(o) && skills.isUnrevealed(o));
      const allowUnrevealed = unread.length > 0 && unread.every(o => skills.isOwnSummon(c, o));
      const eq = await skills.equipBest(s, { priority: [want], banned: this.bannedWeaponsNow(),
        allowUnrevealed }).catch(() => null);
      return String(eq?.wielding ?? '').toLowerCase() === want;
    };
    const wielding = () => {
      const using = skills.equippedNow(c);
      return !!using && (c.inventory || []).some(o => using.has(o.id) && isWant(o));
    };
    if (wielding()) return { armed: true, already: true };
    if ((c.inventory || []).some(isWant)) {
      if (await equipWant()) return { armed: true, equipped: want };
      return null;                     // we hold one we may not wield; do not add another
    }

    // THE CHECKS makeWeapon MAKES, in the same order: vigor, mana, room, the spell, standing.
    const vigorNow = vigorOf(c.vitals?.());
    const mana = c.vitals?.()?.mana?.value ?? 0;
    if ((vigorNow ?? 0) < SPELL_EXERTION_VIGOR || mana < 15) return null;
    const bulkFree = skills.carryCapacity(c)?.room_for?.bulk ?? null;
    if (bulkFree != null && bulkFree < CONJURED_WEAPON_BULK) {
      this.noteOnce?.('roulette-room', 'no room to conjure the training weapon', { bulk_free: bulkFree,
        needs: CONJURED_WEAPON_BULK, want });
      return null;
    }
    const spell = (c.spells || []).find(sp => (c.rsc.get(sp.nameRsc) || '').toLowerCase() === 'create weapon');
    if (!spell) return null;

    const power = conjurePowerEstimate(c, spell);
    await skills.standToAct(s).catch(() => null);
    this.sittingFor = null;
    const had = new Set((c.inventory || []).map(o => o.id));
    await withCastRite(s, { spell, targets: [], why: 'trainingWeaponRoulette' }, () => s.pacer.submit('cast', () => c.cast(spell.id, []), 1050));
    await c.waitFor({ kinds: ['message', 'inventory'], timeoutMs: 4000 }).catch(() => {});
    await new Promise(x => setTimeout(x, 1000));
    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    const made = (c.inventory || []).filter(o => !had.has(o.id) && CONJURABLE_WEAPONS.includes(nameOf(o)));
    for (const o of made) mine.add(o.id);
    this.tally.roulette_casts = (this.tally.roulette_casts || 0) + 1;
    const hit = made.find(isWant);
    this.recordCast('create weapon', { ok: made.length > 0, why: `training-weapon roulette for ${want}`,
      made: made.map(nameOf), want, hit: !!hit, spell_power_estimate: power.power,
      chance_estimate: power.chance?.(want) ?? null });
    if (hit) {
      this.tally.roulette_hits = (this.tally.roulette_hits || 0) + 1;
      const armed = await equipWant();
      this.note(`conjured a ${want} to train ${skill}`, { ability, until: ROULETTE_UNTIL,
        casts: this.tally.roulette_casts, hits: this.tally.roulette_hits, wielding: armed,
        spell_power_estimate: power.power });
      return { armed, made: want };
    }
    const misses = made.filter(o => !isWant(o));
    if (misses.length) {
      const equipment = c.equipment?.();
      await clearConjureHoard(s, misses, {
        eligible: o => mine.has(o.id) && equipment?.known === true &&
                       !equipment.equipped.some(e => e.id === o.id),
      }).catch(() => null);
    }
    this.note(`training-weapon roulette: no ${want} this cast`, { made: made.map(nameOf),
      ability, until: ROULETTE_UNTIL, spell_power_estimate: power.power,
      chance_estimate: power.chance?.(want) ?? null,
      why: 'create weapon rolls a band; the misses are dropped and the next pull is armed with ' +
           'the best of the rest' });
    return null;
  }

  knowsCreateWeapon() {
    const c = this.s?.client;
    return !!(c?.spells || []).find(
      sp => (c.rsc?.get?.(sp.nameRsc) || '').toLowerCase() === 'create weapon');
  }

  // WEAR THE ARMOUR WE ARE CARRYING.
  //
  // Buying armour and not putting it on is the same as not buying it, and it is the
  // easy failure: the pack says the character owns leather, the server's use list says
  // it is fighting in its shirt, and only the second one is real. Nineteen of
  // twenty-five characters were once found wearing nothing at all.
  //
  // COSTS NOTHING WHEN THERE IS NOTHING TO DO. Both halves of the comparison are
  // already in the client's cache — armourOf reads the inventory we hold, equippedNow
  // reads the use list the server volunteers — so the common case is arithmetic and
  // sends no request at all. Only an actual mismatch pays for a `use`.
  // PUT ON ARMOUR THE MOMENT IT IS LOOTED, NOT ONLY WHEN UNARMED.
  //
  // wearArmourIfNeeded's only caller was armSelf(), and every armSelf() call is gated on
  // `!armedForSure()` — so a character with a weapon in hand never put on armour it looted.
  // Two costs, measured on prod 2026-09-25 in the Icky Cave: Statler carried two leather
  // armours and wore none, and because sellable() rightly refuses to sell body armour to a
  // character wearing none ("this is not a spare"), every leather the unarmoured crew looted
  // was unsellable for ever. One wear_best by hand put leather on him and made the second one
  // a spare. Called from both loot sites; free when the loot held no armour.
  //
  // IT FILLS AN EMPTY SLOT AND NEVER SWAPS, AND IT STANDS DOWN UNDER AN ECONOMY LEASE. Both
  // at a raid's request (2026-09-25): a raid hands each raider a deliberate outfit and records
  // it before the door, and holds work and economy while it does. wearArmourIfNeeded swaps
  // whenever the best-RANKED carried piece is not the worn one — raid chain would come off for
  // looted leather and the raid's own record would silently stop describing the body. So this
  // path only covers a slot with nothing in it, and only while economy is the keeper's. DUM
  // leases work and movement only, so a DUM-directed farmer still puts on what it loots.
  async wearLootedArmour(looted = []) {
    const piece = (looted || []).some(n => skills.armourKind(String(n).replace(/ x\d+$/, '')));
    if (!piece) return false;
    return this.wearIntoEmptySlots('put on armour we just looted');
  }

  // SELL LOOT IS ALWAYS FIT TO WEAR; SAVED STOCK NEVER IS. Operator, 2026-09-25: "make sure
  // they wear the leather and shields while they're farming if they aren't being saved".
  // So a piece named by protectedItemNames() — vault items, protect_items, guild-plan wants,
  // the stockpile, cargo held for somebody — is not a candidate: worn, it is out of reach of
  // the deposit or hand-over it is being kept for. Everything else in the pack may fill an
  // empty slot. Called after every loot, and from the farm pass on a one-minute clock so a
  // character that looted before this existed, or restarted with a spare aboard, still dresses.
  savedArmourName() {
    const saved = (this.protectedItemNames?.() ?? []).map(s => String(s).toLowerCase().trim())
      .filter(Boolean);
    if (!saved.length) return null;
    return (name) => {
      const n = String(name || '').toLowerCase();
      return saved.some(s => n === s || n.includes(s));
    };
  }

  async wearIntoEmptySlots(what = 'put on armour we were carrying') {
    if (this.facultyHeld?.('economy')) return false;
    const c = this.s?.client;
    if (c?.pvpGearActive) return false;          // PvP gear is on; see armSelf
    const using = skills.equippedNow(c);
    if (!c || !using) return false;           // no use list: cannot tell what is empty
    const exclude = this.savedArmourName();
    const have = skills.armourOf(c, { exclude });
    const wornSlots = new Set();
    for (const o of c.inventory || []) {
      if (!using.has(o.id)) continue;
      const kind = skills.armourKind(c.rsc.get(o.nameRsc) || '');
      if (kind) wornSlots.add(kind.slot);
    }
    // A PIECE WE PUT ON THAT CAME BACK OFF IS NOT PUT ON AGAIN FOR HALF AN HOUR. Something else
    // is taking it off — measured on Sweetums 2026-09-25: the shield went on (verified against
    // the use list) six times in six minutes and was gone again each time. The cause is NOT
    // established, and it is NOT the weapon: defence and offence are separate decisions in the
    // game as well as here. A shield and a weapon each take one of two hand slots
    // (player.kod viHand_space = 2, weapon.kod viUse_amount = 1; no weapon takes two, only
    // the lute does), and a weapon swap frees hand space by yielding a SAME-KIND item first
    // (player.kod FreeHandSlotsFor: "swapping one weapon for another does not drop an equipped
    // shield"). Re-wearing every minute only races whatever it is. Keyed by object id, which
    // is only a handle, so the memory is short and a renumbered id costs one extra attempt.
    const DRESS_BACKOFF_MS = 30 * 60_000;
    const dressed = (this.dressedIds ??= new Map());
    for (const [id, at] of dressed) if (Date.now() - at > DRESS_BACKOFF_MS) dressed.delete(id);
    const bounced = [];
    const empty = skills.ARMOUR_SLOTS.filter(sl => {
      if (!have[sl]?.length || wornSlots.has(sl)) return false;
      const id = have[sl][0].o.id;
      if (dressed.has(id)) { bounced.push({ slot: sl, name: have[sl][0].name, id }); return false; }
      return true;
    });
    for (const b of bounced) {
      if ((this.bounceNoted ??= new Set()).has(b.id)) continue;
      this.bounceNoted.add(b.id);
      this.note('armour we put on keeps coming off — leaving it for now', {
        ...b, retry_after_min: DRESS_BACKOFF_MS / 60_000,
        why: 'it was worn and verified, then the slot was empty again with the same piece back in ' +
             'the pack. Something took it off; it was not a weapon change — the server yields a ' +
             'same-kind hand item first, and no weapon needs two hands. Re-wearing it every ' +
             'minute would only race whatever did, so it is left and this is worth reading' });
    }
    if (!empty.length) return false;
    const trying = Object.fromEntries(empty.map(sl => [sl, have[sl][0].o.id]));
    // `_wearBest` is a test seam; production always takes skills.wearBest.
    const r = await (this._wearBest ?? skills.wearBest)(this.s, { slots: empty, exclude }).catch(() => null);
    for (const w of r?.worn ?? []) if (trying[w.slot] != null) dressed.set(trying[w.slot], Date.now());
    if (r?.worn?.length) {
      this.tally.armour_worn = (this.tally.armour_worn || 0) + r.worn.length;
      this.note(what, {
        worn: r.worn.map(w => `${w.name} (${w.slot})`), empty_slots: empty,
        why: 'the slot was empty and the piece was in the pack; a character wearing no body ' +
             'armour can never sell a spare, and one wearing none is hit more' });
    }
    return !!r?.worn?.length;
  }

  async wearArmourIfNeeded() {
    const c = this.s.client;
    if (c?.pvpGearActive) return false;          // PvP gear is on; see armSelf
    const using = skills.equippedNow(c);
    if (!c || !using) return false;          // no use list: cannot tell, so do not guess
    const have = skills.armourOf(c);
    const missing = skills.ARMOUR_SLOTS.filter(sl => have[sl]?.[0] && !using.has(have[sl][0].o.id));
    if (!missing.length) return false;
    const r = await skills.wearBest(this.s, { slots: missing }).catch(() => null);
    if (r?.worn?.length) {
      this.tally.armour_worn = (this.tally.armour_worn || 0) + r.worn.length;
      this.note('put on armour we were carrying', {
        worn: r.worn.map(w => `${w.name} (${w.slot})`), defense_total: r.defense_total,
        rejected: r.rejected?.length ? r.rejected : undefined,
        why: 'it was in the pack and not in the server\'s use list, which is the only list ' +
             'that fights' });
    }
    return !!r?.worn?.length;
  }

  // WHAT WAS EATEN, ON THE LEDGER. One `ate` row per food per sitting, so food eaten can be set
  // against food looted (`looted` rows) and bought. Operator, 2026-09-27: the troll crew's food
  // should go net-positive once it is fighting again, and nothing recorded a meal until now.
  // `skills.eat` answers `ate` as one name per mouthful and `vigor` as {before, after} for the
  // whole sitting, so vigor is per sitting and the amount is per item.
  startOverdrive(od, vigor, why) {
    this.overdrive = { active: true, since: Date.now(), target: od.target, from: vigor, why, meals: this.tally.meals || 0 };
    this.note('overdrive: sitting to eat up to ' + od.target + ' vigor', { from: vigor, target: od.target, why });
  }

  endOverdrive(vigor, why) {
    const o = this.overdrive;
    if (!o?.active) return;
    this.overdrive = { ...o, active: false };
    const minutes = +((Date.now() - o.since) / 60000).toFixed(1);
    const row = { from: o.from, to: vigor, gained: (vigor ?? 0) - (o.from ?? 0), minutes,
                  meals: (this.tally.meals || 0) - (o.meals || 0), target: o.target, why,
                  // THE DIGEST WAIT, as the operator asked it to be recorded.
                  stomach_before: o.stomach_before ?? null, predicted_ready_at: o.predicted_ready_at ?? null,
                  stomach_after: Math.round(Number(this.stomach?.level ?? 0)),
                  digest_minutes: o.digestFrom ? +((Date.now() - o.digestFrom) / 60000).toFixed(1) : 0,
                  released_by: why };
    this.note('overdrive released: back to the task', row);
    try { this.ledgerEvent('overdrive', row); } catch {}
  }

  recordAte(e, how) {
    try {
      const counts = new Map();
      for (const name of e?.ate ?? []) counts.set(name, (counts.get(name) ?? 0) + 1);
      for (const [item, amount] of counts)
        recordEvent(this.who(), 'ate', { item, amount, how,
          vigor_before: e.vigor?.before ?? null, vigor_after: e.vigor?.after ?? null,
          room: this.s?.world?.room?.num ?? null });
    } catch { /* telemetry must never break the thing it is measuring */ }
  }
  // @end 1
}
