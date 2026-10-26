// PROVISION: the keeper's own shopping list before it sets out.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 1 methods: provision
import * as skills from '../m59-skills.mjs';
import { EAT_TO_AT_LEAST, overdriveDigest, overdriveReachable, overdriveSettings, shouldWaitForProvision } from '../m59-autopilot.mjs';

export class ProvisionPart {
  // @part 1

  async provision(plan, v) {
    const p = this.policy;
    const floor = this.fightFloor(plan);
    // Declared here, at the top, on purpose: it used to sit thirty lines down and a note
    // above it read it inside the temporal dead zone, which aborted the keeper pass with
    // `Cannot access 'vigor' before initialization` and left a character idle for ten
    // minutes. Anything added to this method above this line must not touch `vigor`.
    const vigor = v.vigor?.value ?? 0;
    // EATING IS NOT A STRATEGY OPTION.
    //
    // This returned before it ever looked at the larder unless the policy named a fight
    // floor or a vigor ceiling — so `fightAboveVigor: 0`, which means "no minimum vigor
    // required to fight", silently also meant "never eat". Twelve of twenty-one
    // characters were running exactly that and had not eaten in hours; ten of them sat
    // at 78-80, which is the resting cap, with the fleet's food and reagents idle.
    //
    // What that costs is now measured rather than assumed. Across 6,800 armed
    // observations a character at or below 85 vigor died at 101.8 per thousand against
    // 4.4 in the 86-120 band — and carrying food changed nothing (94.7 without, 133.3
    // with), because carrying is not eating. The single cheapest thing any character can
    // do for its survival is swallow what is already in its pack.
    //
    // So when nothing sets a target, eat to just clear of the cap rather than not at all.
    // A named floor or ceiling still wins; this only fills the silence.
    const ceiling = this.poorFarmingActive() ? this.poorVigorFloor() : p.vigorCeiling ?? plan.vigorCeiling
                 ?? (floor ? 0 : (p.eatToAtLeast ?? EAT_TO_AT_LEAST));
    if (!floor && !ceiling) return false;              // only if someone set it to zero on purpose

    // EATING IS NOT RESTING. A guard here once refused to eat, or to cook, while anything
    // attackable stood in the room, on the argument that raising vigor meant standing still
    // and not looking, the same act as a rest. It is not: a meal is one `use` on an item
    // already in the pack, it lands in the same second, and it goes down mid-fight. The
    // guard was deleted on 2026-09-02 at the operator's instruction. Two recorded fixtures,
    // `wallstop-39-r8c23` and `wallstop-562-r1c101`, still carry its "not eating here"
    // note; that is evidence of what the keeper said at the time, not a rule that is live.

    const s = this.s;
    const larder = this.larder(s.client);
    const best = larder[0]?.food ?? null;
    // AND THE SMALLEST, WHICH IS THE ONE THAT DECIDES WHETHER WE CAN EAT AT ALL.
    //
    // larderOf sorts by nutrition per unit of FILLING, so larder[0] is the most
    // efficient item — not the smallest. Every stomach gate below asked "is there room
    // for the best one", and when there was not, the character ate NOTHING and set out
    // at the resting cap with a full pack. Eleven of twenty-one sat at exactly 80 vigor
    // that way, each carrying 30 to 147 vigor of food, while a single edible mushroom
    // (filling 5) would have gone down every time.
    //
    // `eat` already refuses anything that would overshoot 200, so gating on the smallest
    // cannot waste a big item — it just stops one large loaf from vetoing the meal.
    const smallest = larder.reduce((m, x) => (!m || x.food.filling < m.filling ? x.food : m), null);

    if (!best) {
      // MAKE SOME, IF WE CAN. Out of food used to be treated as purely a supply
      // problem, which was true of a fleet that could not cast — and false of this
      // one, where every character knows `create food` and spends all day picking up
      // the two things it consumes. A cast is cheaper than a merchant, cheaper than
      // asking another character, and available in the field where the alternative
      // is a walk back through the rooms that keep killing them.
      if (await this.cookSomething()) return 'ate';  // spend this pass eating instead
      // Genuinely nothing to eat and nothing to make it from. Say it once and carry
      // on fighting at whatever vigor resting gives — refusing to fight would idle
      // the character for ever. fightFloor() has already dropped to the starved floor.
      if (!this.warnedNoFood) {
        this.warnedNoFood = true;
        this.note('no food to raise vigor with', {
          vigor, floor, ceiling, reagents: this.reagentCount(),
          why: 'the larder is empty and there are not 2 elderberry + 2 herbs to cast with',
          hint: 'inky cap mushrooms give the most vigor per unit of stomach (50/25)' });
      }
      this.climbing = false;
      if (this.overdrive?.active) this.endOverdrive(vigor, 'out of food');
      return false;
    }
    this.warnedNoFood = false;

    // Hysteresis: fall through the floor to start climbing, reach the ceiling to stop.
    // With no floor set there is nothing to fall through, so the latch also trips on the
    // ceiling — otherwise the implicit target above would be computed and never used.
    if (vigor < floor || (!floor && vigor < ceiling)) this.climbing = true;

    // OVERDRIVE STARTS WITH A CLIMB AND ENDS AT ITS TARGET. See overdriveSettings.
    const od = overdriveSettings(p);
    const reach = od ? overdriveReachable(od.target, larder) : null;
    if (od && this.climbing && !this.overdrive?.active && vigor < reach - 5)
      this.startOverdrive(od, vigor, 'a climb began below the fighting floor');
    if (this.overdrive?.active) {
      // The waiting rule compares against what the larder can reach, not the nominal target.
      this.overdrive.reach = reach ?? this.overdrive.target;
      const why = !od ? 'switched off'
        : Date.now() - this.overdrive.since > od.maxMinutes * 60_000 && vigor < this.overdrive.reach - 5 ? `${od.maxMinutes} min cap`
        : null;
      if (why) this.endOverdrive(vigor, why);
      else if (vigor >= this.overdrive.reach - 5) {
        // AT THE TARGET: DIGEST, then release. See overdriveSettings.
        const level = Number(this.stomach?.level ?? 0);
        if (!this.overdrive.digestFrom) {
          const readyInS = this.stomach?.secondsUntilRoomFor?.(100 - od.digestTo) ?? 0;
          this.overdrive = { ...this.overdrive, digestFrom: Date.now(), stomach_before: Math.round(level),
                             predicted_ready_at: new Date(Date.now() + readyInS * 1000).toISOString() };
        }
        const d = overdriveDigest({ od, stomachLevel: level, digestingForMs: Date.now() - this.overdrive.digestFrom,
          danger: !!this.inReachOfUs?.()?.length,
          // NOT "IS A LEASE HELD": DUM holds work and movement on every crew hunter for good, so that
          // released every digest the instant it began (Sweetums, 2026-09-28: 151 -> 180, digest 0 min,
          // "a lease wanted the body"). What needs the body is something USING it — an errand or a
          // journey in hand (inert), or one waiting to resume.
          leased: !!(this.inert || this.suspendedJourney) });
        if (d.hold) {
          this.doing = 'overdrive: digesting';
          if (!this.overdrive.notedDigest) {
            this.overdrive.notedDigest = true;
            this.note('overdrive: at the target, digesting before setting out', { vigor, stomach: Math.round(level),
              digest_to: od.digestTo, predicted_ready_at: this.overdrive.predicted_ready_at,
              why: 'setting out with room for a full sitting, so vigor is topped up as soon as fighting spends it' });
          }
          return 'waiting';
        }
        this.endOverdrive(vigor, d.released_by);
      }
    }


    if (this.climbing) {
      this.doing = 'recovering';
      if (vigor < (ceiling || floor)) {
        const e = await skills.eat(s, { stomach: this.stomach, upToVigor: ceiling || undefined,
                                       exclude: this.notOursToEat() })
                              .catch(() => ({ ate: [] }));
        if (e.ate?.length) {
          this.tally.meals = (this.tally.meals || 0) + 1;
          this.recordAte(e, 'stocking up');
          this.note('ate while stocking up', {
            ate: e.ate, vigor: e.vigor, ceiling,
            stomach: Math.round(this.stomach.level), strategy: p.strategy });
          this.progress('ate to raise vigor');
          return 'ate';
        }
        // NOTHING FITS UNDER THE CEILING: every food aboard would carry vigor past 200, which `eat`
        // refuses — and the stomach wait reads 0 because there IS room, so the rule below would wait
        // for ever. This is as high as this larder reaches; set out. (Kermit, 2026-09-28: 188 -> 188,
        // 29.5 min, 0 meals.)
        const minBite = Math.min(...larder.map(x => Number(x.food?.nutrition) || Infinity));
        if (Number.isFinite(minBite) && vigor + minBite > Math.min(200, ceiling || 200)) {
          this.climbing = false;
          if (this.overdrive?.active && !(vigor >= (this.overdrive.reach ?? this.overdrive.target) - 5))
            this.endOverdrive(vigor, 'no bite fits under 200');
          this.note('as high as this larder reaches', { vigor, smallest_bite: minBite, ceiling,
            why: 'every food aboard would carry vigor past 200, which eating refuses' });
          return false;
        }
        // Too full to make progress: waiting is useful only until the configured
        // fighting floor is satisfied. Above it, a long digestion interval is time
        // not spent fighting; eat opportunistically during the hunt instead.
        const wait = this.stomach.secondsUntilRoomFor(smallest.filling);
        const hurt = (v.health?.value ?? 0) < (v.health?.max ?? 0) * 0.95;
        if (!shouldWaitForProvision({ vigor, floor, wait, hurt, overdrive: this.overdrive })) {
          this.climbing = false;
          this.note('setting out above the fighting floor', {
            vigor, floor, ceiling, stomach: Math.round(this.stomach.level),
            room_for_next_in_s: wait,
            why: 'the configured fighting floor is satisfied and the next top-up is too far away' });
          return false;
        }
        if (this.overdrive?.active) this.doing = 'overdrive';
        this.note('waiting to get hungry', {
          vigor, ceiling, stomach: Math.round(this.stomach.level),
          room_for_next_in_s: wait, next: larder[0].name,
          why: 'the stomach drains 0.12/s and food is refused above 100 — vigor above ' +
               'the resting threshold of 80 can only come from eating' });
        return 'waiting';
      }

      // At the ceiling. Waiting for stomach room before setting out is only worth it
      // if the wait buys something else, because the arithmetic is unforgiving:
      // attacking costs 0.5 vigor a swing at one a second, or 30 a minute, while the
      // very best food sustains 14.4. Nothing closes that gap, so vigor is spent
      // capital and TIME SPENT FIGHTING is what it buys. Idling 3.5 minutes to make
      // room is 3.5 minutes not fighting.
      //
      // The exception is being hurt: at 200 vigor health comes back at a point a
      // second, so an idle spent healing is not idle at all. Wait then, not otherwise.
      const wait = this.stomach.secondsUntilRoomFor(best.filling);
      const hurt = (v.health?.value ?? 0) < (v.health?.max ?? 0) * 0.95;
      if (!this.stomach.roomFor(smallest.filling) && (hurt || wait <= 60)) {
        this.note('topping off before setting out', {
          vigor, stomach: Math.round(this.stomach.level), room_for_next_in_s: wait,
          healing: hurt, why: hurt
            ? 'at this vigor health returns about a point a second, so the wait heals too'
            : 'the wait is short enough to be worth the top-up' });
        return 'waiting';
      }
      this.climbing = false;
      this.note('setting out fed', { vigor, floor, ceiling,
                                     stomach: Math.round(this.stomach.level) });
    }

    // FIGHTING: EAT EVERY TIME THERE IS ROOM. This is where the strategy actually
    // pays, and the old code missed it — it topped up once before setting out and
    // then let vigor sag for the whole hunt, which is the expensive half.
    //
    // Health regeneration goes as ((200-vigor)^2/6 + 1000) ms a point
    // (player.kod:5617), so 200 vigor heals 2.67x as fast as 100 and 3.4x as fast as
    // the 80 that resting alone reaches. Every minute spent fighting at 100 instead
    // of 200 is most of a healing rate thrown away.
    //
    // Stomach room is the throttle, so take all of it whenever it appears rather than
    // one item per pass — a pass is eight seconds and the room reappears on a clock
    // measured in minutes. `eat` declines anything that would overshoot 200.
    if (ceiling && this.stomach.roomFor(smallest.filling)) {
      const e = await skills.eat(s, { stomach: this.stomach, upToVigor: ceiling,
                                     exclude: this.notOursToEat() })
                            .catch(() => ({ ate: [] }));
      if (e.ate?.length) {
        this.tally.meals = (this.tally.meals || 0) + 1;
        this.recordAte(e, 'mid-hunt');
        this.note('ate mid-hunt', { ate: e.ate, vigor: e.vigor,
                                    stomach: Math.round(this.stomach.level) });
      }
    }

    // Say once whether the larder can actually sustain a hunt. The stomach drains
    // 0.12 filling a second, so the best food in the pack sets a hard ceiling on
    // vigor per minute — and it is well under what swinging costs.
    if (!this.warnedThroughput) {
      this.warnedThroughput = true;
      const perMin = +(best.nutrition / best.filling * 0.12 * 60).toFixed(1);
      this.note('vigor throughput', {
        food: larder[0].name, sustains_vigor_per_min: perMin,
        attacking_costs_per_min: 30,
        note: perMin < 30
          ? 'vigor cannot be held while swinging; it is spent capital, and better food ' +
            'buys more fighting time (inky cap 14.4/min vs wheel of cheese 5.4)'
          : undefined });
    }
    return false;
  }
  // @end 1
}
