// THE HUNT'S SETUP: fight floor, loadout, hunt area and priority, and the farm-strategy binding.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 18 methods: wantedFightFloor, fightFloor, declareInterest, loadout, packAsItems,
//   bannedWeaponsNow, huntsTrolls, bareHandedByTraining, touchSpellNow, huntAreaHere,
//   nearestHuntAreaSquare, huntPriorityOrder, huntPriorityStatus, applyFarmStrategy,
//   farmStrategyHook, farmStrategyStatus, policyForOrders, farmStrategyPushEcho
import { spellCost } from '../m59-deskpractice.mjs';
import { huntPriorityProblems, orderByHuntPriority, priorityRankOf } from '../m59-hunt-priority.mjs';
import { recordEvent } from '../m59-ledger.mjs';
import { loadoutFor, wantsOf } from '../m59-loadout.mjs';
import { SHORTFALL_TTL_MS, shortfallTargets } from '../m59-sharing.mjs';
import * as skills from '../m59-skills.mjs';
import { FarmStrategyEngine } from '../m59-strategy-engine.mjs';
import { touchSpellSpec } from '../m59-touchspell.mjs';
import { MIN_FIGHT_VIGOR, reachableFightFloor, reagentTargetFor, restVigorCapOf, STARVED_FIGHT_VIGOR, STRATEGIES, VIGOR_CAP } from '../m59-autopilot.mjs';

export class HuntSetupPart {
  // @part 1

  // HOW MUCH HEALTH IS ACTUALLY SAFE, derived rather than guessed.
  //
  // A lawful hit is capped at (base_max_health + 2) / 3 (player.kod:4612), so a
  // single blow can take A THIRD of a 25-health character's bar. Breaking off is not
  // instant either — the withdraw walk is a round or two during which it keeps
  // swinging.
  //
  // A flat "flee at 40%" ignores all three. Forty percent of 25 is ten health, which
  // is one hit plus change: Isolde was killed by a BABY SPIDER while nominally
  // obeying that threshold. Three hits of margin is the number that actually
  // survives, and before 30 it should never be tested at all — every death costs a
  // point of max health permanently, which is the very thing being farmed.
  // PROVISIONING: A ZONE AND A CYCLE, NOT A THRESHOLD.
  //
  // The old rule was one number — top up if below it, then fight regardless. That is
  // not how the mechanic rewards you. Three facts from the kod set the shape:
  //
  //   the stomach caps at 100 and drains 0.12 a second, so a full one takes 13.9
  //     minutes to clear (player.kod:45-51, 1347, 5703)
  //   eating converts nutrition to vigor by removing exertion (player.kod:5738)
  //   "Need empty stomach to get vigor boost from food" — the kod's own note
  //
  // So vigor is not a tap you open when low. Stomach room is the scarce resource,
  // and it refills on a clock you cannot hurry. Eating at 199 vigor wastes the room;
  // arriving at a fight with a full stomach means no top-ups for a quarter of an hour.
  //
  // What a player does, and what this now does:
  //
  //   CLIMB    eat what fits, wait for room, eat again, until vigor reaches the
  //            ceiling. The waiting is not idleness — it is the digestion clock.
  //   TOP OFF  at the ceiling, wait until there is room for one more meal before
  //            setting out, so the fighting stretch can be fed as it goes.
  //   FIGHT    eat opportunistically whenever there is room and vigor is off the
  //            ceiling. This never blocks the fight.
  //   FALL     when vigor drops through the FLOOR and the stomach is too full to do
  //            anything about it, stop and climb again.
  //
  // The floor and ceiling are what give it hysteresis. A single threshold makes the
  // character oscillate across one number, which is the thrashing this replaces.
  //
  // Returns true if the caller should NOT start a fight this pass.
  // THE ONE PLACE THAT DECIDES HOW TIRED IS TOO TIRED, because there used to be two
  // and they disagreed. provision() climbed to vigorFloor while the fight gate let the
  // character swing at fightAboveVigor, so `wellfed` ate its way to 120 and then
  // engaged at 70 anyway, and the whole strategy comparison was measuring nothing.
  // The floor this character WANTS, before an empty larder or poor farming lowers it.
  wantedFightFloor(plan = STRATEGIES[this.policy.strategy] || {}) {
    const p = this.policy;
    // fightAboveVigor was the old single knob; it still works, as the floor.
    return Math.max(MIN_FIGHT_VIGOR,
      p.vigorFloor ?? plan.vigorFloor ?? p.fightAboveVigor ?? plan.fightAboveVigor ?? 0);
  }

  // This character's resting ceiling (Second Wind included), as a fraction of the bar. See restVigorCapOf.
  restVigorCap() { return restVigorCapOf(this.s?.client?.vitals?.()); }

  fightFloor(plan = STRATEGIES[this.policy.strategy] || {}) {
    if (this.poorFarmingActive()) return this.poorVigorFloor();
    const want = this.wantedFightFloor(plan);
    // An empty larder puts the floor out of reach — resting stops at 80 — so holding
    // out for it would idle the character for ever. Fall back to what resting can
    // deliver, and COUNT it: this is the food supply failing, not a fighting decision,
    // and it should show up as a supply number rather than as a quiet slowdown.
    const larder = this.larder(this.s.client);
    if (!larder.length) {
      this.vigor.starved_passes++;
      // SAY IT ONCE, ON THE EDGE. This is the moment the operator's whole circuit turns on --
      // food is the countdown timer to the next town stop, and this is the alarm going off --
      // but fightFloor() runs every pass, so a level-triggered event here would write
      // thousands of identical rows and drown the ledger it is trying to inform.
      //
      // Fires when the larder goes empty and is armed again only once food is aboard, so a
      // character that finds a mushroom and eats it produces two rows rather than two
      // thousand. Cheap enough to sit on the hot path: one boolean.
      // AN EMPTY READ IS NOT AN EMPTY LARDER.
      //
      // The broker keeps in-process autopilot STUBS beside every keeper-backed session, and a
      // stub has no client -- so `larder()` returns [] and the character reads as starving
      // for ever. Live on prod 2026-09-06 that produced 73 firings for one agent inside an
      // hour, against a handful of real ones, and the giveaway was the `character` column:
      // agent ids (`t15`, `t5`) from stubs mixed with real names (`Clifford`, `Pepe`) from
      // keepers.
      //
      // So require evidence that we could actually SEE a pack. `items` present and an array
      // is the difference between "looked, found nothing" and "never looked". A character
      // genuinely carrying nothing still has an items array; a stub has no client at all.
      const canSeePack = Array.isArray(this.s?.client?.items);
      if (canSeePack && !this._larderWasEmpty) {
        this._larderWasEmpty = true;
        try {
          recordEvent(this.who(), 'larder_empty', {
            room: this.s?.world?.room?.num ?? null,
            room_name: this.s?.world?.room?.name ?? null,
            vigor: this.s?.client?.vitals?.()?.vigor?.value ?? null,
            fight_floor_wanted: want,
            fight_floor_used: Math.min(want, STARVED_FIGHT_VIGOR),
            purse: this.s?.client?.purse?.() ?? null,
            note: 'resting caps vigor at 80 of 200 and only food goes above it, so from here '
                + 'this character cannot reach a fight floor above 80 however long it rests',
          });
        } catch { /* telemetry must never break the thing it is measuring */ }
      }
      return Math.min(want, STARVED_FIGHT_VIGOR);
    }
    this._larderWasEmpty = false;
    // A LARDER THAT IS NOT EMPTY CAN STILL BE TOO SMALL. See reachableFightFloor: resting
    // stops at 80 and the rest has to be eaten, so one mushroom against a floor of 140 is
    // still a floor nothing can reach. Counted the same way, because it is the same fact
    // about supply rather than a fighting decision.
    const carried = larder.reduce((n, item) =>
      n + (Number(item?.food?.nutrition ?? item?.nutrition) || 0) *
          (Number(item?.o?.amount ?? item?.amount ?? 1) || 1), 0);
    const reachable = reachableFightFloor(want, VIGOR_CAP, carried);
    if (reachable < want) this.vigor.starved_passes++;
    return reachable;
  }

  // TELL THE REST OF THE FLEET WHAT WE ARE SHORT OF AND WHAT WE CAN SPARE.
  //
  // Cheap, and called every pass, because the whole value is in it being current when
  // somebody else is standing at a merchant deciding what to sell.
  declareInterest() {
    const c = this.s.client;
    if (!c) return;
    const r = this.reagentCount();
    const wants = [], needs = new Map(), spare = new Map();
    for (const [kind, have] of [['elderberry', r.elderberry], ['herb', r.herbs]]) {
      const want = reagentTargetFor(kind, this.policy.reagentTarget);
      if (have < want) wants.push(kind);
      if (have < want) needs.set(kind, want - have);
      else if (have > want) spare.set(kind, have - want);
    }
    // No food and nothing to cook with is a want somebody else can answer directly.
    if (!this.larder(c).length && (r.elderberry < 2 || r.herbs < 2)) wants.push('food');
    if (!skills.weaponsOf(c).length) wants.push('weapon');
    // AND WHATEVER THIS CHARACTER'S OWN LIST ASKS FOR. Until now the board could only
    // speak about elderberry and herbs, because they were the only two things with a
    // target — so a caster short of forty mushrooms had no way to stop a crewmate selling
    // them at a counter. A loadout gives every listed item a target, which is exactly what
    // the board needs to protect it.
    const l = this.loadout();
    if (l) {
      const mine = wantsOf(l, this.packAsItems());
      for (const w of mine.wants) if (!wants.includes(w)) wants.push(w);
      for (const [k, n] of mine.spare) if (!spare.has(k)) spare.set(k, n);
      // THE QUANTITIES TOO, and this line is the whole reason a loadout could be ignored by
      // the one mechanism that fetches things. `needs` is what `demandsForRoom` filters and
      // returns, so a shortfall that never reached it was invisible to farm delivery no
      // matter how loudly the loadout asked. Only the two reagents above had a target, so
      // only they were ever delivered — the fleet ran 14 elderberry against 215 herbs while
      // couriers kept buying herbs, because herbs were what the board could say.
      //
      // The reagent targets above win on a tie: they are this character's own floor for the
      // thing it casts with, and a loadout that also lists elderberry is asking for stock,
      // not for a smaller floor than the keeper already runs on.
      for (const [k, n] of mine.needs) if (!needs.has(k) && n > 0) needs.set(k, n);
    }
    // AND A SPELL THIS CHARACTER HAS BEEN CASTING THAT IT CAN NO LONGER AFFORD ONCE MORE. Running out
    // is usually the last cast spending the last reagent, not a refusal: a desk asked for nothing
    // while it has no emerald is never told "you don't have the reagents", because nobody asks it to
    // cast (DUM's desk rule passes on an empty desk). So the spells this client has sent are kept,
    // and one that can no longer be paid for raises the same shortfall the refusal would.
    const sent = c.lastCastSent;
    if (sent?.name) (this._castSpells ??= new Map()).set(String(sent.name).toLowerCase(), sent.at);
    for (const [spell, at] of [...(this._castSpells ?? [])]) {
      if (Date.now() - at > SHORTFALL_TTL_MS) { this._castSpells.delete(spell); continue; }
      const cost = spellCost(spell);
      if (!cost?.reagents?.length) continue;
      if (!cost.reagents.some(([item, n]) => this.countOfKind(item) < n)) continue;
      const fresh = cost.reagents.some(([item]) => !this._reagentShortfall?.has(String(item).toLowerCase()));
      this._reagentShortfall = shortfallTargets(cost, this._reagentShortfall ?? new Map());
      if (fresh) {
        this.note('cannot afford another cast: asking the fleet', { spell, reagents: cost.reagents });
        try { this.ledgerEvent('reagent_shortfall', { spell, by: 'spent', room: this.s.world?.room?.num ?? null }); } catch {}
      }
    }
    // AND WHAT THIS CHARACTER RAN OUT OF IN THE MIDDLE OF A CAST (noteReagentRefusal). A target, not
    // a moment: it stands until the pack holds it, or until nobody has answered for SHORTFALL_TTL_MS.
    if (this._reagentShortfall?.size) {
      const now = Date.now();
      for (const [kind, s] of [...this._reagentShortfall]) {
        const have = this.countOfKind(kind);
        if (have >= s.target || now - s.since > SHORTFALL_TTL_MS) { this._reagentShortfall.delete(kind); continue; }
        needs.set(kind, Math.max(needs.get(kind) ?? 0, s.target - have));
        if (!wants.includes(kind)) wants.push(kind);
        spare.delete(kind);
      }
    }
    this._needsNow = needs;
    skills.interest.declare(this.name ?? this.s.name, { wants, needs, spare,
      room: this.s.world?.room?.num ?? null, character: c.me?.name ?? null,
      farming: this.mode === 'farm' && this.running && !this.inert,
      // A SERVICE CHARACTER IS WORTH A WALK (m59-sharing.mjs): a chalice holder, a posted room
      // caster, or a donation-taker that is NOT out farming  a desk. Most farmers carry an
      // acceptDonations policy too, and the first live board read 22 of 23 keepers as "service",
      // which would have walked farmers between rooms to top up each other's herbs.
      service: this.isServicePost() });
    // Kept for the party register too. The fleet-wide board is a broadcast — anyone may
    // read it — while a partner needs the same list addressed to it specifically, so
    // that "one of us is short" can become "both of us go to town" rather than each
    // discovering the same shortage separately twenty minutes apart.
    this.wantsNow = wants;
  }

  // ------------------------------------------------------------------ the loadout
  //
  // THIS CHARACTER'S OWN LIST, or null when nobody has written one — and null means "carry
  // on exactly as before", which is why every caller guards on it rather than substituting
  // a default. `loadoutFor` caches on the file's mtime, so this is a stat() on the common
  // path and a parse only when somebody has just saved from the planner. That matters: it
  // is called every pass, for every character.
  //
  // KEYED ON THE CHARACTER NAME, NOT THE AGENT HANDLE. `t1` is this machine's word for a
  // slot in a roster; "Kermit" is the character, and the loadout follows the character
  // across checkouts and re-rolls of the roster file.
  loadout() {
    const who = this.s.client?.me?.name ?? this.s.credentials?.character;
    return who ? loadoutFor(who) : null;
  }

  // The pack in the shape the loadout helpers read: {name, amount}. They are shared with
  // the CLI, which sees inventories over the wire, so they speak display names rather than
  // the client's resource ids.
  packAsItems() {
    const c = this.s.client;
    if (!c) return [];
    return (c.inventory || []).map(o => ({ name: c.rsc.get(o.nameRsc) || '', amount: o.amount || 1 }));
  }

  // WHICH WEAPON TO REACH FOR. An explicit `weapon_priority` over MCP still wins — that is
  // somebody typing an instruction at this character right now — and below it sits the
  // loadout's own preference order, which is the standing answer. Null falls through to
  // ranking by proficiency, which is a feedback loop that only ever rewards what the
  // character is already good at.
  /**
   * Weapons this character must never draw, whatever the priority list says.
   *
   * A priority is a preference and its last entry is still an entry, so ranking a mace
   * last does not stop equip_best reaching it when the pack holds nothing else. Mace
   * fighting is Weaponcraft level 1 and the level-3 unlock reads only level-2 abilities,
   * so a mace trains a number no threshold looks at while displacing bare hands, which
   * train brawling -- level 2, and uncapped on this quarry.
   */
  bannedWeaponsNow() {
    const b = this.policy?.bannedWeapons;
    return Array.isArray(b) && b.length ? b : null;
  }

  /** Is the quarry trolls? Against them every mystic sword is a candidate (skills.isMysticSword). */
  huntsTrolls() {
    const h = this.policy?.hunt;
    return h != null && [].concat(h).some(x => /\btrolls?\b/i.test(String(x ?? '')));
  }

  /**
   * Is this character bare ON PURPOSE right now?
   *
   * `trainingStyle: 'unarmed'` means "train brawling on the quarry", and the keeper already
   * honours it inside a fight -- `prepareTrainingStyle('unarmed')` calls
   * `unuseTrainingWeapon()` and fights with fists. What it did NOT honour is the ARMING
   * side: `armSelf()` is reached from the recovery branch with no style check, so a brawler
   * resting between fights conjured a weapon, walked back out, and had it taken off again on
   * the first swing. Summon, drop, repeat -- 15 mana and 70 bulk a lap, for a weapon the
   * character is not allowed to keep hold of.
   *
   * Scoped to the character's OWN GROUND deliberately, which is what `styleForNonPrey`
   * already encodes. Off its station an unarmed trainer still arms, because the weapon it
   * wants there is for travel and survival rather than for the bout -- the same split
   * meridian59-dum-bot's `TRAINING_PRESET` assumes when it declines to send a weapon
   * priority for `unarmed` at all ("the keeper disarms in the farm room itself").
   */
  bareHandedByTraining() {
    return this.styleForNonPrey(this.s?.world?.room) === 'unarmed';
  }

  // ------------------------------------------------------------- TOUCH SPELL TRAINING
  //
  // A touch spell is a personal enchantment that IS the weapon, and only while the hand is
  // empty (player.kod:4712-4729). So training one is `trainingStyle: 'unarmed'` plus a buff
  // that has to be kept on — and every arming path that would put a weapon back in the hand
  // has to stand down. See m59-touchspell.mjs for the kod and the messages.
  //
  // THE SAME GROUND RULE AS UNARMED PRACTICE: farm mode, standing on the assigned room. A
  // journey, a recovery detour or a strange room keeps the ordinary arm-first survival rule —
  // being bare on the road is how the road kills people.

  /** The configured touch spell's spec, or null when the posture is off. */
  touchSpellNow() { return touchSpellSpec(this.policy?.touchSpell); }

  // HUNT PRIORITY (m59-hunt-priority.mjs). The ordering lives there; this binds it to the
  // keeper's own name reader and hunt matcher, and remembers the last choice for status.
  /** The hunt area's squares for this room (a Set of "row,col"), or null when the whole room is fair game. */
  // A GUARD ZONE in this room is the area; otherwise the strategy's hunt area is (operator 2026-10-16: a drawn
  // zone is an order to one character, and a file assigned to fifteen must not take it back).
  huntAreaHere(roomNum) {
    const g = this.policy?.guardZone;
    const a = g && Number(g.room) === Number(roomNum) ? g : this.policy?.huntArea;
    if (!a || Number(a.room) !== Number(roomNum) || !Array.isArray(a.squares) || !a.squares.length) return null;
    if (this._huntAreaFor !== a) { this._huntAreaFor = a; this._huntAreaSet = new Set(a.squares.map(([r, c]) => `${r},${c}`)); }
    return this._huntAreaSet;
  }

  /** The area square nearest to us that no other body stands on (stacked fleet-mates trap each other), or null. */
  nearestHuntAreaSquare(area, me, taken = new Set()) {
    let best = null, bd = Infinity;
    for (const k of area) {
      if (taken.has(k)) continue;
      const [row, col] = k.split(',').map(Number), d = Math.hypot(row - me.row, col - me.col);
      if (d < bd) { bd = d; best = { row, col }; }
    }
    return best;
  }

  huntPriorityOrder(found, preferId = null) {
    const c = this.s?.client;
    const nameOf = o => c?.rsc?.get?.(o.nameRsc) || o.name || '';
    const matcherFor = n => this.huntMatch(n);
    const ordered = orderByHuntPriority(found, this.policy.huntPriority, { nameOf, matcherFor, preferId });
    const head = ordered[0];
    if (head) this._huntPriorityLast = { target: nameOf(head), id: head.id, at: Date.now(),
      ...priorityRankOf(nameOf(head), this.policy.huntPriority, { matcherFor }),
      resumed: preferId != null && head.id === preferId };
    return ordered;
  }
  huntPriorityStatus() {
    const order = this.policy?.huntPriority;
    if (!Array.isArray(order) || !order.length) return null;
    return { order, ignored: huntPriorityProblems(order, this.policy.hunt, { matcherFor: n => this.huntMatch(n) }),
             last_choice: this._huntPriorityLast ?? null };
  }

  // FARMING STRATEGY FILES (m59-strategy-engine.mjs). Binding only: the engine loads, validates,
  // applies (faculty by faculty — it yields whatever a bot or lease holds) and runs the hooks; the
  // keeper reads no field of a strategy. Never throws into a pass.
  async applyFarmStrategy(reason = 'pass') {
    if (!this.policy?.farmStrategy && !this._farmStrategy) return null;
    try { return await (this._farmStrategy ??= new FarmStrategyEngine(this)).converge(reason); }
    catch (e) { this.note('farm strategy failed to apply', { reason, why: e.message }); return null; }
  }
  farmStrategyHook(hook, payload = {}) { return this._farmStrategy?.dispatch(hook, payload); }
  farmStrategyStatus() {
    return this._farmStrategy?.status()
      ?? (this.policy?.farmStrategy ? { assigned: this.policy.farmStrategy, state: 'not applied yet' } : null);
  }
  /** The policy as the ORDERS say it — the strategy's overlay taken back out — for anything that persists. */
  policyForOrders() { return this._farmStrategy ? this._farmStrategy.ordersView(this.policy) : { ...this.policy }; }
  /** Which keys of an incoming push merely echo the strategy's overlay (m59-strategy-engine.mjs pushEcho). */
  farmStrategyPushEcho(fields = {}) { return this._farmStrategy?.pushEcho(fields) ?? { echo: [], restated: [] }; }
  // @end 1
}
