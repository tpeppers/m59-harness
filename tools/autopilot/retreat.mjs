// ROOM TO MOVE, ROAMING, AND RETREAT.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 8 methods: foodSurplus, makeRoom, preyRooms, awayFromStation, roam, guardedRetreatTravel,
//   retreatToSafety, withdraw
import { foodSurplusOf, isFood, weighItem } from '../m59-items.mjs';
import { dropRank, sellTest } from '../m59-loadout.mjs';
import { findPath } from '../m59-map.mjs';
import { keeperOrigin } from '../m59-move-origin.mjs';
import { affordances } from '../m59-parse.mjs';
import * as skills from '../m59-skills.mjs';
import { huntLabel, huntingGrounds, loadSpawns, roomThreats } from '../m59-spawns.mjs';
import { CITY_INNS } from '../m59-underworld.mjs';
import { ITEM_VALUE, PREFERRED_QUIET_RETREATS, REAGENT_TARGET, SPAWN_FILE, farmRoomDenials, preferAssignedRoom, preferredQuietRetreat } from '../m59-autopilot.mjs';

export class RetreatPart {
  // @part 1

  // HOW MUCH FOOD IS ABOVE THE RESERVE. A thin adapter: the arithmetic is
  // `foodSurplusOf` in m59-items.mjs, where it is pure and pinned by m59-items-test —
  // this half only supplies the pack and the capacity, which is all that needs a session.
  //
  // Food is the LOWEST priority to keep and 20% of capacity survives. Operator's call,
  // 2026-09-12. The argument, and what the unbounded exemption cost, are at the pure end.
  foodSurplus() {
    const c = this.s.client;
    if (!c) return null;
    const cap = skills.carryCapacity(c);
    // An inexact load is a LOWER bound, and "there is surplus" is a claim that deletes
    // items — the same reason carryCapacity withholds room_for rather than guess.
    if (!cap?.known || !cap.load || cap.load.exact === false) return null;
    return foodSurplusOf({
      items: (c.inventory || []).map(o => ({ id: o.id, name: c.rsc.get(o.nameRsc) || '',
                                             amount: o.amount })),
      capacity: Math.max(Number(cap.weight_max) || 0, Number(cap.bulk_max) || 0),
      fraction: this.policy.foodReserveFraction,
    });
  }

  async makeRoom() {
    this.doing = 'trading';
    const s = this.s, c = s.need();
    // THE SAME GUARD AS sellInTown, AND IT WAS MISSING HERE. makeRoom is reached far more
    // often than the town trip — any pass with a full pack standing next to anything that
    // reports `buy` — so leaving it unguarded meant the fix was decorative. Skivlat takes
    // goods and gives nothing; see SELL_TO in m59-skills.mjs.
    const buyer = [...c.room.objects.values()]
      .find(o => affordances(o.flags).includes('buy') && skills.trustedBuyer(c.rsc.get(o.nameRsc)));
    if (buyer) {
      // THE LOADOUT DECIDES WHAT LEAVES THE PACK, WHERE IT HAS AN OPINION. sellAll's own
      // guards — money, worn gear, anything a crewmate is short of — still apply; this adds
      // this character's floors and its sell list on top.
      const sold = await skills.sellAll(s, { merchant: buyer.id, loadout: this.loadout(),
                                            protect: this.saleProtectedNames(),
                                            maxWeapons: this.policy.maxWeapons,
                                            weaponPriority: this.weaponPriorityNow() })
                               .catch(e => ({ error: e.message }));
      // WE ARE STANDING AT A SHOP WITH MONEY IN HAND. Restocking reagents here costs
      // nothing extra — the walk is already paid for — and it is the one time buying
      // from a vendor is not simply losing the spread to them.
      const bought = await this.restockReagents(buyer).catch(() => null);
      if (!sold.error && sold.sold?.length) {
        this.tradeFact({ earned: sold.total_received, sold: sold.sold });
        return { ok: true, did: 'sold to ' + c.rsc.get(buyer.nameRsc),
                 detail: { earned: sold.total_received, sold: sold.sold.length,
                           kept_for_the_fleet: sold.kept_for_the_fleet?.length || undefined,
                           bought: bought?.length || undefined } };
      }
      if (bought?.length)
        return { ok: true, did: 'restocked reagents at ' + c.rsc.get(buyer.nameRsc),
                 detail: { bought } };
    }
    // No buyer. Drop the biggest stack of something expendable.
    await s.pacer.submit('read', () => c.requestInventory());
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });

    // DEAD WEIGHT FIRST, and it has to be first because the keep list below protects it.
    //
    // `keep` names sword|mace|hammer|axe|bow to stop the pack-clearer stripping the
    // character's weapon — sound, except that a BROKEN weapon is not renamed
    // (weapon.kod:788 changes only the icon) and the junk item is literally called
    // "broken mace". So the guard that exists to protect equipment was the reason every
    // character hauled its shattered swords around for ever: unsellable, unwieldable,
    // and specifically exempted from being dropped.
    // ASK ABOUT THE SPARES BEFORE DECIDING THERE IS NOTHING TO DROP.
    //
    // junkAndBroken can only report weapons brokenSet already knows about, and brokenSet
    // only ever learned by a failed wield — which happens at most once a pass and only
    // for the weapon the character was about to use. So a pack full of dead maces
    // reported "nothing to drop" indefinitely: the spares were never the ones being
    // wielded, so they were never tested, so they were never known, so they were never
    // dropped. Floyd had six and Kermit eight on exactly that loop.
    //
    // Looking is the cheap question (see inspectForBroken), and it is asked only about
    // spares — never the weapon in hand — and only when the pack is worth clearing, so
    // it costs nothing on the common path.
    const worn0 = skills.equippedNow(c) ?? new Set();
    const spares = (c.inventory || [])
      .filter(o => !worn0.has(o.id) && skills.weaponScore(c.rsc.get(o.nameRsc) || '') > 0)
      .map(o => o.id);
    if (this.policy.dropJunk !== false && spares.length)
      await skills.inspectForBroken(s, spares).catch(() => null);

    const dead = skills.junkAndBroken(c);
    if (this.policy.dropJunk !== false && dead.length) {
      const d = dead[0];
      await s.pacer.submit('drop', () => c.drop([this.dropSpec(d)]));
      await new Promise(r => setTimeout(r, 900));
      await s.pacer.submit('read', () => c.requestInventory());
      await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });
      return { ok: true, did: `dropped ${d.name} (${d.why})`,
               detail: { now_carrying: c.inventory.length, dead_weight_left: dead.length - 1 } };
    }

    // The keep list is a VALUE guard — money, gems, the sort of gear worth carrying a
    // spare of. It used to double as the equipment guard, and that was only ever an
    // approximation: it protects things whose NAMES look like equipment, so anything
    // worn that is not named after a weapon or a piece of armour — a ring, a cloak, an
    // amulet, boots, a lute — was as droppable as a rat pelt while the character was
    // wearing it.
    //
    // The server keeps the real answer in plUsing and sends it on every inventory read,
    // which is exactly what just happened above. Use it: this cannot be got wrong by a
    // name nobody thought of.
    const keep = /shilling|coin|diamond|ruby|emerald|sapphire|armor|armour|shield|sword|mace|hammer|axe|bow|helm|gauntlet/i;
    const worn = skills.equippedNow(c) ?? new Set();
    const me = this.s.name;
    // THE ORDER THINGS GET GIVEN UP IN. Own needs first — reagents we are short of
    // ourselves are covered by `keep` below via mine(). Then anything a crewmate is
    // short of, which outranks loot we are only carrying in order to sell it: the
    // vendor spread means a herb dropped here and bought back there costs twice, and
    // the character who needed it could not eat in the meantime. Bulk breaks ties,
    // because the point of the drop is to make room.
    const r = this.reagentCount();
    const target = this.policy.reagentTarget ?? REAGENT_TARGET;
    const mine = name => {
      const k = skills.shareKind(name);
      if (!k) return false;
      return (k === 'elderberry' ? r.elderberry : r.herbs) <= target;   // still short ourselves
    };
    // AND WHAT THIS CHARACTER SAID, WHICH OUTRANKS ALL OF IT IN BOTH DIRECTIONS. `dropRank`
    // returns -1 for something on the sell list (go before anything else, including
    // sell-fodder nobody named), 3 for something the loadout protects (go last, after even
    // a crewmate's reagents), and NULL for anything it has no opinion about — which is the
    // whole overlay: an unmentioned item keeps the ranking it has always had.
    //
    // It is given the pack, so a floor of twelve elderberry protects twelve and not the
    // thirteenth. A rank that could not count would either hoard the surplus for ever or
    // shed the character's last cast.
    const mineToo = dropRank(this.loadout(), this.packAsItems());
    const rank = o => {
      const name = c.rsc.get(o.nameRsc) || '';
      const said = mineToo?.(name);
      if (said !== null && said !== undefined) return said;
      // BELOW SELL-FODDER, ABOVE THE OPERATOR'S OWN SELL LIST. Surplus food is the cheapest
      // thing in the pack to lose — the Duke's tables hand it out and the walk there is one
      // the fleet already makes — so it goes before loot we are only carrying to sell. It
      // does NOT go before something the loadout explicitly named for selling (-1): that is
      // an instruction rather than an inference.
      if (surplus?.id === o.id) return -0.5;
      // A WEAPON THIS CHARACTER MAY NEVER HOLD IS THE ONLY THING IN THE PACK WITH NO USE AT
      // ALL, so it goes before ordinary sell-fodder and before surplus food.
      //
      // Food is surplus but still edible; loot is carried to be sold. A banned weapon can be
      // neither wielded nor grown into — `equipBest` refuses it on every pass for as long as
      // it is aboard — and it costs twice over, because `bannedConjurablesHeld()` counts it
      // and at three of them `create weapon` declines with "already carrying unusable
      // conjured weapons". So the pack fills with weapons the character cannot use, and the
      // spell that would give it one it CAN use is switched off by their presence.
      //
      // Measured on prod 2026-09-19: Beaker at 25 mana, unarmed, holding two hammers and an
      // axe — every one of them banned, none of them conjured; the operator identified them
      // as orc drops. Three is the limit, so the ladder was blocked by loot.
      //
      // It stays ABOVE the loadout's explicit sell list (-1), because that list is an
      // instruction and this is an inference.
      if (this.bannedWeaponUseless?.(name)) return -0.75;
      if (mine(name)) return 2;                                          // ours, keep longest
      if (skills.interest.anyoneWants(name, { except: me })) return 1;    // somebody's, keep
      return 0;                                                          // sell-fodder, goes first
    };
    // THE NAME-BASED VALUE GUARD IS AN APPROXIMATION AND THE LOADOUT IS NOT, so a loadout
    // that puts something on the sell list gets past it. That is the point: `keep` protects
    // "emerald" for everyone, and a character carrying fifty-six sapphires it will never
    // cast with needs a way to say so — which was previously only possible by editing a
    // regex shared by twenty-one characters.
    const overrideSell = sellTest(this.loadout());
    // Read once: it walks the pack, and the filter and the ranking both ask about it.
    const surplus = this.foodSurplus();
    const junk = (c.inventory || [])
      .filter(o => {
        const name = c.rsc.get(o.nameRsc) || '';
        if (worn.has(o.id) || this.wontDrop?.has(o.id) ||
            skills.itemIsProtected(name, this.protectedItemNames())) return false;
        if (overrideSell?.(name)) return true;
        // FOOD IS THE LOWEST PRIORITY TO KEEP, ABOVE A RESERVE — and it used to be exempt
        // outright, which is how the fleet came to shed its reagents in order to protect
        // 2,700 slices of free pork. `foodSurplus` picks ONE stack and says how much of it
        // is above the 20% larder; nothing else about food is droppable.
        if (isFood(name)) return surplus?.id === o.id;
        // Create-food reagents stay exempt. They are not free, they are the thing a town
        // trip exists to fetch, and they are what was being dropped instead.
        if (skills.shareKind(name)) return false;
        return !keep.test(name);
      })
      .sort((a, b) => {
        const score = o => {
          const name = c.rsc.get(o.nameRsc) || '';
          const key = String(name).toLowerCase();
          const unit = weighItem(name);
          const amount = Math.max(1, Number(o.amount) || 1);
          const relief = unit ? Math.max(unit.weight, unit.bulk) * amount : 0;
          const valueKnown = Object.prototype.hasOwnProperty.call(ITEM_VALUE, key);
          const value = valueKnown ? Number(ITEM_VALUE[key]) || 0 : null;
          // Value per unit of the binding resource keeps the most earning power in the
          // remaining 75%. Unknown value or load ranks last: unknown is never worthless.
          const density = valueKnown && unit && Math.max(unit.weight, unit.bulk) > 0
            ? value / Math.max(unit.weight, unit.bulk) : Infinity;
          return { rank: rank(o), valueKnown, loadKnown: !!unit, density, relief, value };
        };
        const x = score(a), y = score(b);
        return x.rank - y.rank ||
          Number(y.valueKnown && y.loadKnown) - Number(x.valueKnown && x.loadKnown) ||
          x.density - y.density ||
          (x.value ?? Infinity) - (y.value ?? Infinity) ||
          y.relief - x.relief;
      });
    if (!junk.length) {
      return { ok: false, did: 'nothing safe to drop',
               detail: { hint: 'raise maxCarry, or go and sell — everything carried looks worth keeping' } };
    }
    const drop = junk[0];
    const name = c.rsc.get(drop.nameRsc);
    const before = c.inventory.length;
    // A PARTIAL DROP KEEPS THE STACK, so how much to shed has to be decided here and the
    // success test below cannot be an item count. Only surplus food is partial; everything
    // else goes whole, as it always did.
    const partial = surplus?.id === drop.id ? surplus.units : null;
    const heldBefore = Math.max(1, Number(drop.amount) || 1);
    await s.pacer.submit('drop', () => c.drop([this.dropSpec(drop, partial)]));
    await new Promise(r => setTimeout(r, 900));
    await s.pacer.submit('read', () => c.requestInventory());
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });
    // DID IT ACTUALLY GO? A drop the server refused looks exactly like one it accepted
    // from here, and makeRoom returns from the pass either way, so a refusal that repeats
    // is a character that never does anything again. Refuse to report success for a drop
    // that changed nothing, and remember the item so the next pass tries something else.
    //
    // FOR A PARTIAL DROP THE COUNT IS THE WRONG WITNESS. Shedding 250 of 294 slices leaves
    // the stack in the pack, so `inventory.length` does not move and the drop that worked
    // perfectly would be recorded as refused and the stack blacklisted in `wontDrop` — after
    // which the surplus could never be shed again this session. Ask the STACK instead.
    if (partial != null) {
      const still = (c.inventory || []).find(o => o.id === drop.id);
      const heldAfter = still ? Math.max(0, Number(still.amount) || 0) : 0;
      if (heldAfter >= heldBefore) {
        (this.wontDrop ??= new Set()).add(drop.id);
        return { ok: false, did: `the server would not drop ${name}`,
                 detail: { refused: name, wanted: partial, still_holding: heldAfter,
                           hint: 'a stacked drop needs a positive quantity (UserDrop returns ' +
                                 'early on number <= 0); this stack is now skipped for the session' } };
      }
      return { ok: true, did: `dropped ${heldBefore - heldAfter} x ${name} (surplus food)`,
               detail: { kept: heldAfter, reserve: surplus.reserve, food_load: surplus.food_load,
                         reserve_fraction: surplus.fraction, now_carrying: c.inventory.length } };
    }
    if (c.inventory.length >= before) {
      (this.wontDrop ??= new Set()).add(drop.id);
      return { ok: false, did: `the server would not drop ${name}`,
               detail: { still_carrying: c.inventory.length, refused: name,
                         hint: 'a stacked item needs a quantity (UserDrop returns early on ' +
                               'number <= 0); this one is now skipped for the rest of the session' } };
    }
    return { ok: true, did: `dropped ${name}${drop.amount > 1 ? ` x${drop.amount}` : ''}`,
             detail: { now_carrying: c.inventory.length } };
  }

  // Move to a neighbouring room and look there instead. Prefers somewhere not yet
  // visited, so the character sweeps outward rather than bouncing between two rooms.
  // Rooms whose spawn table generates what we are hunting, safest-and-likeliest
  // first, excluding where we already are and anywhere we have failed to reach.
  //
  // The threat ceiling is expressed relative to the character's own level, because
  // that is what makes it portable: prey worth killing is ABOVE your level (the
  // advancement roll needs monster_level > base_max_health), so a flat "nothing
  // above your level" rule would reject every room worth being in. Six over is the
  // gap between prey that pays and prey that kills — level-30 rats are right for a
  // level-25 character; the level-35 larvae sharing room 567 with them are not.
  preyRooms(room) {
    const want = this.policy.hunt;
    if (!want) return [];
    const spawns = loadSpawns(SPAWN_FILE);
    if (!spawns) return [];
    const ceiling = this.threatCeiling();
    const deniedFarmRooms = farmRoomDenials(this.noWallRooms, this.cappedRooms);
    // Do not truncate before looking for the assignment.  Ranking is global, whereas
    // assignedRoom is an operator/fleet decision and must be allowed to outrank it.
    const mine = this.policy.assignedRoom;
    // AN ASSIGNMENT OUTRANKS THE BYSTANDER CEILING — and only that. The ceiling is how a keeper
    // picks a room ON ITS OWN; an assigned room is somebody's decision about exactly that risk.
    // Ukgoth generates trolls and is rejected for its level-120 Guardians, so a troll hunter
    // assigned 599 farmed it once inside and, the moment anything took it out, walked to 516
    // instead — 2026-09-27, Animal and Janice, each noting "leaving for the explicitly assigned
    // farming room" on the way somewhere else. The survival ladder is unchanged.
    const assignedOverride = r => !!r.rejected && mine != null && r.room === mine;
    const rooms = huntingGrounds(spawns, want,
      { maxDanger: ceiling, limit: Number.MAX_SAFE_INTEGER })
      .filter(r => (!r.rejected || assignedOverride(r)) && r.room !== room?.num && !this.unreachable.has(r.room))
      // And not one we have already refused for having no usable wall or an irrecoverably
      // blocked spawn cap. Without this the keeper walks out and ranks the room it just
      // abandoned as the best destination again.
      .filter(r => !deniedFarmRooms.has(r.room))
      .filter(r => !this.bansDestination(r.room));
    const kept = rooms.find(assignedOverride);
    if (kept && this.notedAssignedOverride !== mine) {
      this.notedAssignedOverride = mine;
      this.note('keeping the assigned room over the threat ceiling', { room: mine,
        ceiling_says: kept.rejected, why: 'the assignment is an explicit order about that risk' });
    }
    // AN ASSIGNMENT OUTRANKS THE SPAWN TABLE. Every caller takes [0], so putting the
    // assigned room at the front is the whole of "go back where you were put" — and
    // it stays subject to the other filters above, so an assignment to somewhere that
    // cannot generate the prey, or that we have proven unreachable, is ignored rather
    // than obeyed into a corner.
    return preferAssignedRoom(rooms, mine === room?.num ? null : mine, 8);
  }

  /**
   * Were we given a station, and are we somewhere else?
   *
   * A seam rather than an inline comparison because it is the whole of a behaviour change
   * that moves live characters, and the two ways to get it wrong are both silent: reading
   * `this.assignedRoom` (which does not exist) makes it always false, and falling back to
   * `homeRoom` makes it true for characters nobody ever gave an order to.
   *
   * ONLY AN EXPLICIT ORDER COUNTS. `policy.assignedRoom` is what `spread`, the supervisor
   * or a bot set on purpose; `homeRoom` is merely where we last settled.
   */
  awayFromStation(room) {
    const station = this.policy?.assignedRoom;
    return Number.isFinite(station) && station !== room?.num;
  }

  async roam(room) {
    const s = this.s;
    // Getting out is its own move when there is a crowd standing on us. Doing it here
    // rather than at each of the three departures below means it cannot be forgotten
    // at one of them.
    if ((await this.leaveHold('roaming to look for hunting elsewhere')).refused) return;

    // GO BACK TO WHERE THE WORK WAS. Roaming outward is a one-way gradient: each
    // empty room justifies moving to the next, and nothing ever argues for turning
    // round. Left alone it walked out of a rat warren, through four rooms, into a
    // town square, and spent twenty minutes there alternating between "nothing to
    // hunt" and "the guardian angel will not let me leave". If we know somewhere
    // that produced a kill, that is where to be.
    if (this.homeRoom != null && room?.num !== this.homeRoom) {
      this.note('heading back to where the hunting was', { from: room?.name, to_room: this.homeRoom });
      const back = await this.travel(this.homeRoom, { origin: keeperOrigin('roam_home'), maxHops: 8 }).catch(e => ({ arrived: false, reason: e.message }));
      this.emptyPasses = 0;
      if (back.arrived) {
        this.tally.rooms_moved++;
        this.roamedRooms = 0;
        this.progress('returned to the hunting ground');
        this.note('back at the hunting ground', { room: this.homeRoom });
      } else {
        // FORGET IT RATHER THAN RETRY FOREVER. Some rooms cannot be returned to at
        // all — the newbie zone is behind a one-way portal, and a character that
        // graduated out of it keeps a homeRoom it can never reach again. Retrying
        // that route every eight seconds is exactly the silent stall this whole
        // mechanism was meant to prevent.
        this.note('cannot get back — forgetting that hunting ground',
                  { to_room: this.homeRoom, why: back.reason });
        this.homeRoom = null;
        this.noProgress('lost the way back; will look for new hunting from here');
      }
      return;
    }

    // ASK WHERE THE PREY LIVES BEFORE WALKING ANYWHERE.
    //
    // Creatures do not wander in this world: each room has a generator with a fixed
    // table, and a giant rat appears in a room if and only if that room's table
    // names it. So the room to go to is a lookup, and walking the exit graph hoping
    // to stumble across one is searching for something that was never going to move.
    // Left to do that, a character walked out of a rat warren and into the
    // Princess's castle — a room whose table contains no vermin at all and never
    // will.
    //
    // The threat ceiling is the other half. Two rooms both list giant rats at 60-70%;
    // one of them also rolls a level-35 groundworm larva, and that is the room that
    // kept killing a level-26 character of mine. Filtering on the toughest thing the
    // TABLE can produce — not on what happens to be standing there now — is what
    // separates them.
    const known = this.preyRooms(room);
    if (known.length) {
      const target = known[0];
      this.note('going where this creature is actually generated', {
        to_room: target.room, room_name: target.room_name,
        spawn_chance: target.chance, also_here: target.also_here,
      });
      this.doing = 'travelling';
      const r = await this.travel(target.room, { origin: keeperOrigin('roam'), maxHops: 12 })
                       .catch(e => ({ arrived: false, reason: e.message }));
      this.emptyPasses = 0;
      if (r.arrived) {
        this.tally.rooms_moved++;
        this.roamedRooms = 0;
        this.homeRoom = target.room;
        this.progress('reached a room that generates the prey');
        return;
      }
      // Unreachable from here — remember not to keep choosing it, and fall through
      // to the exit walk rather than retrying the same failed route forever.
      this.unreachable.add(target.room);
      this.note('could not reach that spawn room', { to_room: target.room, why: r.reason });
    }

    if (this.roamedFrom === null) { this.roamedFrom = room?.num ?? null; this.roamedRooms = 0; }
    if (this.roamedRooms >= this.policy.roamLimit) {
      this.note('roamed far enough', { rooms: this.roamedRooms, limit: this.policy.roamLimit,
                                       hint: 'raise roamLimit, or move the character yourself' });
      this.emptyPasses = 0;
      this.noProgress('roam limit reached with nothing to hunt');
      return;
    }
    // DO NOT WALK INTO A ROOM YOU CANNOT WALK OUT OF.
    //
    // Thirty-two rooms in this world have no route back to any hunting ground, and
    // they are not marked as anything: Marion is a perfectly ordinary-looking town
    // whose room object has plEdge_Exits = $, so you can walk in from the West
    // Merchant Way and then there is no edge to walk out of. The Marion crypt below
    // it is worse. Eight characters roamed in and spent half an hour cycling between
    // an inn and a sanctuary, reporting a roam limit rather than a trap, because
    // from the inside it looks exactly like a room with nothing to hunt in it.
    //
    // The graph already knows. Ask it before stepping through, not after.
    const map = s.world?.map;
    const goals = this.preyRooms(room).map(r => r.room);
    // CAN I GET BACK? That is the whole test, and it is local — no global notion of
    // "sealed" is needed, and none of the ones I tried worked: Marion reaches its own
    // crypt, and the crypt has a spawn table, so every reachability-to-anything test
    // declared the pocket healthy right up until twenty-three characters were in it.
    //
    // Asking instead whether the DESTINATION can route back HERE catches a one-way
    // door exactly, because that is what a one-way door is.
    const escapable = (to) => {
      if (!map || room?.num == null) return true;
      if (to === room.num) return true;
      if (!findPath(map, to, room.num).found) return false;
      if (!goals.length) return true;
      return goals.includes(to) || goals.some(g => findPath(map, to, g).found);
    };
    // AND DO NOT WALK INTO A ROOM THAT WILL KILL YOU.
    //
    // Escapability is only half of it. Room 2602, "Affirmation of the Forsaken",
    // is one door off a quiet Marion crypt and its generator is thrashers — level
    // 150, cap fifteen, a hundred percent of the table. Eight characters of mine
    // stood in it and lived only because nothing had spawned yet. The room next
    // door rolls level-75 skeletons at 80%.
    //
    // None of this is visible from inside the room, and none of it is in the room's
    // name. It is in the spawn table, which we already have, so there is no excuse
    // for stepping through the door to find out.
    const spawns = loadSpawns(SPAWN_FILE);
    const level = s.client?.vitals?.()?.health?.max ?? 0;
    const ceiling = this.threatCeiling();
    const tooDangerous = (to) => {
      if (!spawns || ceiling == null) return null;
      const worst = (roomThreats(spawns, to) || [])[0];
      return worst && (worst.level ?? 0) > ceiling ? worst : null;
    };

    const all = (s.world?.exits() || []).filter(e => e.to != null && e.reachable !== false);
    const dangerous = [];
    const exits = all.filter(e => {
      const d = tooDangerous(e.to);
      if (d) { dangerous.push(`${e.to_name} (${e.to}): ${d.creature} is level ${d.level}`); return false; }
      return escapable(e.to);
    });
    if (dangerous.length)
      this.note('refused to roam somewhere lethal', { rejected: dangerous, my_ceiling: ceiling });
    if (all.length && !exits.length) {
      this.note('every way out of here is a dead end', {
        room: room?.name,
        rejected: all.map(e => `${e.to_name} (${e.to})`),
        why: 'none of these can route back to a room that generates ' + huntLabel(this.policy.hunt) });
      this.noProgress('surrounded by rooms with no way back to the hunting grounds');
      this.emptyPasses = 0;
      return;
    }
    if (!exits.length) { this.note('nowhere to roam to', { room: room?.name }); this.emptyPasses = 0; return; }
    const fresh = exits.filter(e => !this.visited.has(e.to));
    const pick = (fresh.length ? fresh : exits)
      .sort((a, b) => (a.steps_away ?? 999) - (b.steps_away ?? 999))[0];

    const r = await s.leaveVia(pick);
    this.emptyPasses = 0;
    if (r.left) {
      this.roamedRooms++;
      this.tally.rooms_moved++;
      if (room?.num != null) this.visited.add(room.num);
      const now = s.world?.room;
      if (now?.num != null) this.visited.add(now.num);
      this.note('roamed', { from: room?.name, to: r.arrived_in, rooms_so_far: this.roamedRooms });
    } else {
      this.note('could not roam', { toward: pick.to_name, why: r.reason });
    }
  }

  // RETREAT TO A WALL, NOT MERELY AWAY.
  //
  // This used to give up the spot it was holding and walk to the furthest reachable
  // OPEN square — distance was the only thing it ranked. That is the wrong currency,
  // and it is how characters died: a plain square six steps away is still a square
  // anything can walk up to and hit, so the retreat bought a few seconds and put the
  // character somewhere it could not recover.
  //
  // What makes it fatal is what happens next. playDead() — disconnect, reconnect,
  // turn — is a FULL HEAL in the middle of a monster room, but only from a spot that
  // holds: the freeze that protects also stops HealthTimer, so out in the open it
  // recovers vigor and never health. Do that twice from the same health and it is a
  // livelock, which is what "refusing to freeze again" is, and after refusing, the
  // caller falls through to here. So a withdrawal onto open ground is precisely the
  // state in which the escape hatch does not work.
  //
  // Defensibility beats distance, because in a spot that holds the distance does not
  // matter — nothing lands at all. So: try for a wall first, preferring one the book
  // has already proved, and keep the distance-based walk only as the fallback for
  // rooms that genuinely have no corner in them.
  // RUNNING PART OF THE WAY TO SAFETY IS A DEATH SENTENCE.
  //
  // `fight()` has always broken off at the flee threshold, set `disengaged`, and
  // returned a note saying in plain words: "the monster is still there and still
  // hostile — walk away before resting, or it will keep hitting you."
  //
  // NOTHING READ IT. `grep -n "\.disengaged" m59-autopilot.mjs` returned nothing. So
  // the character stopped swinging and stood exactly where it was, at 20% health, next
  // to the six things that had just taken it there. Out in the open that protects you
  // from nothing — not swinging only helps behind a wall, and the note says so.
  //
  // That is the shape of this fleet's deaths. Of 65: 92% were killed by something they
  // were not hunting, 91% had five or more creatures within reach, and the mean at the
  // moment of death was 5.6. Standing still in that is not a retreat.
  //
  // `withdraw()` is a LOCAL move — to a wall, a few squares. It is the right answer
  // when a safe spot stopped working and the wrong one here: a few squares away from
  // six centipedes is still inside their vision (4-6 squares) and well inside a chase.
  // So this leaves the room entirely and goes to a refuge. Usually that is an inn, which
  // carries ROOM_NO_COMBAT and ROOM_SANCTUARY. Castle Victoria has a much shorter useful
  // answer: its front step spawns no monsters. That ends the monster fight and permits a
  // rest, but does NOT protect against another player.
  //
  // A configured quiet retreat wins for its own rooms, then the nearest CITY_INNS entry
  // the router will accept. If travel cannot get us there we fall back to the local
  // withdraw, because a wall we can reach beats a refuge we cannot.
  async guardedRetreatTravel(room) {
    // A route that has stopped changing room or square is not an escape. The ordinary
    // pass watchdog cannot safely solve this by firing repeatedly: the first interrupt
    // is what gets us INTO the retreat branch, and cancelling every walk merely because
    // health is already below fleeAt would also cancel a healthy escape. Guard this
    // specific journey on actual movement progress instead.
    const s = this.s;
    const noProgressMs = this.retreatNoProgressMs ?? 3_000;
    const guardMs = this.retreatGuardMs ?? 250;
    const position = () => {
      const me = s.client?.self;
      return `${s.world?.room?.num ?? '?'}:${me?.col ?? '?'}:${me?.row ?? '?'}`;
    };
    let lastPosition = position();
    let lastProgressAt = Date.now();
    let guard = null;
    const timer = setInterval(() => {
      const now = Date.now();
      const currentPosition = position();
      if (currentPosition !== lastPosition) {
        lastPosition = currentPosition;
        lastProgressAt = now;
        return;
      }
      if (now - lastProgressAt < noProgressMs || guard) return;
      const hp = s.client?.vitals?.()?.health;
      // This guard is itself the last-resort escape path, so diagnostic
      // enrichment must never prevent it from cancelling a stuck route.
      let maxHit = null;
      try { maxHit = this.safety()?.maxHit ?? null; } catch { /* optional telemetry */ }
      guard = {
        why: 'retreat route made no room or square progress',
        stalled_ms: now - lastProgressAt,
        room: s.world?.room?.num ?? null,
        col: s.client?.self?.col ?? null,
        row: s.client?.self?.row ?? null,
        health: hp?.value ?? null,
        max_health: hp?.max ?? null,
        one_hit_reserve: maxHit != null && hp?.value != null
          ? hp.value <= maxHit : null,
      };
      try { s.cancelMovement?.(null, 'guarded retreat deadline', { origin: keeperOrigin('retreat') }); } catch { /* the failed result below is enough */ }
    }, guardMs);
    try {
      // An emergency retreat must keep moving toward the sanctuary. Ordinary journeys
      // may deliberately hold an intermediate wall for up to 90 seconds, but the retreat
      // guard would correctly see that as no route progress and cancel it. Keep those
      // experimental holds out of this last-resort path rather than teaching the guard
      // to ignore a long period in which a genuinely blocked exit could kill us.
      const result = await this.recoveryTravel(room, { reason: 'retreat', holdBetweenRooms: false });
      return { ...(result ?? {}), retreat_guard: guard };
    } finally {
      clearInterval(timer);
    }
  }

  async retreatToSafety(why = {}) {
    const s = this.s, c = s.client;
    const here = s.world?.room?.num ?? null;
    const inns = Object.entries(CITY_INNS).map(([city, v]) => ({ city, ...v }));

    // A WORKING SAFE SPOT IS ALREADY SAFETY, AND RUNNING FROM ONE IS THE WORST MOVE
    // AVAILABLE. This guard lived inside withdraw(), and swapping callers over to this
    // function quietly dropped it — which would have taken characters off proven walls
    // and marched them across a monster field at the health that made them flee.
    //
    // The asymmetry is the whole safe-spot thesis. `Player.TargetWithinSightAndRange`
    // never calls LineOfSight while `Monster.CanReach` does (player.kod:4115 against
    // monster.kod:1782), so on the right square nothing can land a blow unless we swing
    // first. Standing still there stops the damage immediately and for free, and it is
    // the one place the offline/online rotation can be used to shed whatever has piled
    // up. Distance solves being hurt EVERYWHERE ELSE; here it is what starts it.
    //
    // Deliberately checks holdWorks() and not merely hold: a square we believe in but
    // have never been attacked on is not evidence, and the whole point of this branch
    // is that something is attacking us right now.
    if (this.hold && this.holdWorks()) {
      this.note('staying behind the wall instead of running', {
        spot: { col: this.hold.col, row: this.hold.row }, ...why,
        why: 'this square has held under attack, so nothing here can land a blow unless we ' +
             'swing — leaving it would trade the only thing keeping us alive for distance ' +
             'we do not need' });
      return { arrived: true, held_spot: true };
    }

    // Outside Castle Victoria is safe from its monsters, not from players. Treat being
    // there as a completed retreat without laundering it into a true sanctuary.
    const inQuietRetreat = Object.values(PREFERRED_QUIET_RETREATS)
      .some(x => x.room === here);
    if (inQuietRetreat) {
      this.note('already in a monster-free retreat', {
        room: here, player_safe: false, ...why,
        safety: 'no monsters spawn here; another player can still attack' });
      return { arrived: true, already: true, room: here, player_safe: false };
    }

    // Already in a true sanctuary? Then we are safe and this is a no-op worth saying.
    if (here != null && inns.some(i => i.inn === here)) {
      this.note('already in a sanctuary', { room: here, ...why });
      return { arrived: true, already: true };
    }

    // CHANGING OBJECTIVE FOR AN INN IS OFF, AND EVERYTHING ABOVE THIS LINE STILL RUNS.
    //
    // Operator's call, 2026-08-27. The three answers above — hold the wall we are on, count
    // a monster-free retreat as arrived, count a sanctuary as arrived — are all statements
    // about where we ALREADY are, and they are kept. What is switched off is the one below:
    // picking an inn somewhere else and walking to it.
    //
    // Why it does not work. The rooms that produce these emergencies are the roads
    // themselves — 36 of 37 measured road deaths were in the five corridor rooms, none in a
    // town — so a walk to an inn is a walk through more of exactly what is killing us, begun
    // at the health that made it an emergency. It is the flee tactic with a longer distance
    // attached, and the ordinary flee rung was already removed for the same reason: monsters
    // see 4 + difficulty/2 squares and follow.
    //
    // The replacement is not "nothing". It is the route-adjacent safe spot: park within
    // `travel_shelter_detour` of the road we are already on, play dead once to shed what is
    // chasing, rest to full, carry on. That is a few squares rather than a few rooms, and it
    // is the only move that ends the damage instead of extending it.
    //
    // KEPT AND SWITCHED OFF rather than deleted, because a behaviour that is gone cannot be
    // measured again, and because this one is right for a case nobody has isolated yet — a
    // character stranded somewhere with no spot in reach at all. `retreat_to_inn: true`
    // brings it back per character.
    if (this.policy.retreatToInn !== true) {
      this.note('not changing objective for an inn', {
        room: here, ...why,
        why: 'walking to a sanctuary means crossing more of the road that is already ' +
             'killing us, at the health that made this an emergency. The move is a ' +
             'route-adjacent safe spot instead.',
        enable_with: 'retreat_to_inn: true' });
      // AND THE REPLACEMENT HAS TO BE DISPATCHED, NOT DESCRIBED.
      //
      // The paragraph above says the answer is a route-adjacent safe spot. It said so for
      // nine days while this branch returned `{arrived:false}` and did nothing at all, and
      // every caller of this function reported success anyway — so the sentence WAS the
      // behaviour. JohnsSlave died of it four times in two days (issue #51): the ladder
      // decided correctly at 14% health with seven things adjacent, wrote "moving to
      // somewhere I can heal", called this, got the refusal, and reported progress. Final
      // window on the last one: 31 seconds, 46 samples, `squares_per_second: 0.0`,
      // `net_squares: 0`, `rooms_crossed: 0`. A body that never moved, in a journal that
      // reads like an escape.
      //
      // The spot IS the doctrine's answer, so take one here. Standing in a monster room is
      // the same problem the travel path solves with `shelterRun`, minus the route: the
      // wall is a few squares away rather than a few rooms, and it is the only move that
      // ends the damage instead of extending it.
      //
      // Sharing `wallTriedAt` with the ladder's own wall rung is deliberate — one 30s
      // budget for "go and get a wall", however many rungs ask for it, so a hurt character
      // does not spend every pass re-scanning a room that has no reachable wall. When the
      // budget is spent or the room has none, this returns a refusal that MOVES NOTHING
      // and says so, and the caller is required to treat that as the non-event it is.
      const mayTry = !this.hold &&
                     (!this.wallTriedAt || Date.now() - this.wallTriedAt > 30_000);
      if (mayTry) {
        this.wallTriedAt = Date.now();
        const took = await this.takeRecoverySpot(
          'the inn walk is off and the doctrine says a wall — taking one here',
          { source: 'retreat' }).catch(() => null);
        if (took?.took) {
          this.note('took a wall instead of an inn', {
            room: here, spot: took.spot ?? null, ...why,
            why: 'the route-adjacent safe spot is what replaced the inn walk, and this is it: ' +
                 'a square in this room that nothing can reach us on, a few seconds away ' +
                 'instead of a few rooms' });
          return { arrived: true, took_spot: true, spot: took.spot ?? null, room: here };
        }
        return { arrived: false, refused: 'retreat_to_inn is off', room: here,
                 no_spot: took?.why ?? 'no wall taken this pass' };
      }
      return { arrived: false, refused: 'retreat_to_inn is off', room: here,
               no_spot: this.hold ? 'already holding a square'
                 : 'a wall was already searched for within the last 30s' };
    }
    // NEAREST FIRST, AND NOT MANY. Iterating the six in declaration order would send a
    // character bleeding in the Badlands to whichever inn happened to be listed first —
    // possibly across the world, through everything in between, at the health that made
    // it flee. So rank by actual hops and take the closest; anything unroutable sorts
    // last and is skipped.
    const rankedInns = inns
      .map(i => ({ ...i, hops: s.world?.route?.(i.inn)?.hops?.length ?? Infinity }))
      .filter(i => Number.isFinite(i.hops))
      .sort((a, b) => a.hops - b.hops)
      .map(i => ({ ...i, preferred: false, safety: 'true sanctuary', playerSafe: true }));
    // This explicit exception wins over a farther inn. From upstairs the route is
    // 39 -> 38 -> 2; from base Castle Victoria it is the door straight to room 2.
    const quiet = preferredQuietRetreat(s.world, { maxHops: 6 });
    let ranked = [
      ...(quiet ? [{ city: null, inn: quiet.room, innName: quiet.name, ...quiet }] : []),
      ...rankedInns.filter(i => i.inn !== quiet?.room),
    ];

    // A CONFINEMENT THE REFUGE DOES NOT KNOW ABOUT IS NOT A CONFINEMENT.
    //
    // `confineRooms` is the operator saying "these rooms and nowhere else, whatever
    // happens". Without it this function is the largest hole in any such arrangement,
    // because it is SURVIVAL code and therefore runs exactly when everything else has
    // already agreed the character should stay put.
    //
    // Measured on prod 2026-08-19, twice in one evening: Gonzo was farming room 39 with a
    // flagged player in the room, crossed the flee line, and this walked him to room 2 —
    // `PREFERRED_QUIET_RETREATS` maps BOTH 38 and 39 there. He died in room 2 at 6:57 PM
    // (`killed_by: null`, no monster broadcast, which is what a player kill looks like from
    // in here) and was walked to the same room again at 7:34, losing 19 of 26 health on the
    // way. That table's "safety: no monsters spawn here" is TRUE and is not the same fact
    // as player-safe, and the difference is the whole of this bug.
    //
    // The fallback is deliberately the local wall rather than the nearest permitted refuge:
    // this function's own argument is that "a wall we can reach beats a refuge we cannot",
    // and a refuge outside the confinement is one we have been told we cannot take.
    const confine = Array.isArray(this.policy?.confineRooms) ? this.policy.confineRooms : null;
    if (confine?.length) {
      const allowed = new Set(confine.map(Number));
      const refused = ranked.filter(r => !allowed.has(Number(r.inn)));
      ranked = ranked.filter(r => allowed.has(Number(r.inn)));
      if (refused.length)
        this.note('refuge refused by the confinement', {
          confined_to: [...allowed], refused: refused.map(r => ({ room: r.inn, name: r.innName })),
          why: 'the operator confined this character to these rooms; a refuge outside them ' +
               'is a journey, and the journey is what has been killing it',
          falling_back_to: ranked.length ? 'a permitted refuge' : 'the local wall' });
    }

    if (!ranked.length) {
      this.note('no refuge is routable from here — falling back to a local wall', why);
      await this.withdraw(this.inReachOfUs() ?? []).catch(() => {});
      return { arrived: false, fell_back: true, no_route: true };
    }
    // Two attempts, not six. A retreat that keeps trying is a character walking while
    // being hit; if the two nearest both refuse, the wall here is the better bet.
    for (const dest of ranked.slice(0, 2)) {
      this.note('running all the way to safety', {
        to: dest.innName, room: dest.inn, hops: dest.hops, ...why,
        safety: dest.safety,
        player_safe: dest.playerSafe,
        ...(dest.playerSafe === false
          ? { pvp_note: 'another player can still attack here; the safety is specifically that no monsters spawn' }
          : {}),
        health: (() => { const h = c?.vitals?.()?.health; return h?.max ? Math.round(100 * h.value / h.max) + '%' : null; })(),
        why_not_local: 'a few squares from a crowd is still inside its vision and its chase — ' +
                       (dest.preferred
                         ? 'crossing the Castle Victoria door leaves every monster behind'
                         : 'an inn is a sanctuary and ends the fight'),
      });
      const r = await this.guardedRetreatTravel(dest.inn)
        .catch(e => ({ arrived: false, error: String(e) }));
      if (r?.arrived) {
        this.progress(`reached ${dest.preferred ? 'monster-free retreat' : 'safety'} at ${dest.innName}`);
        this.fledInARow = 0;
        return { arrived: true, at: dest.innName, room: dest.inn, hops: dest.hops,
                 preferred: dest.preferred, player_safe: dest.playerSafe };
      }
      if (r?.retreat_guard) {
        this.note('aborted a retreat route that was not moving', {
          to: dest.innName,
          ...r.retreat_guard,
          consequence: 'do not spend the remaining health retrying another route through the same blocked exit',
        });
        break;
      }
    }
    // Nothing reachable. A wall here is better than nothing, so fall through to the
    // behaviour that at least gets our back covered.
    this.note('could not reach any refuge — falling back to a local wall', why);
    await this.withdraw(this.inReachOfUs() ?? []).catch(() => {});
    return { arrived: false, fell_back: true };
  }

  async withdraw(threats) {
    const s = this.s, c = s.client;
    const me0 = c.self, geo0 = s.world?.geometry;
    if (!me0 || !geo0) { this.note('cannot withdraw', { why: 'no geometry' }); return; }

    // A WALL WE ALREADY HOLD IS NOT SOMETHING TO RUN FROM. We normally reach here
    // because the spot stopped working, but the rest of the loop can send us here
    // while a good one is still under us — and abandoning it to stand in the open is
    // strictly worse than staying. Check before paying for the walk.
    if (this.hold && this.holdWorks()) {
      this.note('staying behind the wall instead of withdrawing', {
        spot: { col: this.hold.col, row: this.hold.row }, threats: threats.length,
        why: 'this square has held under attack, so nothing here can land a blow — walking ' +
             'off it to gain distance would trade the one thing keeping us alive for space' });
      return;
    }

    // Withdraw to recover. The nearest clear wall wins regardless of where a future
    // fight could be held; quarry-to-wall pairing belongs to combat after recovery.
    const spot = await this.takeRecoverySpot(
      'withdrawing from a fight we are losing — to a wall, not into the open')
      .catch(() => ({ took: false }));
    if (spot.took) {
      this.tally.withdrawals_to_a_wall = (this.tally.withdrawals_to_a_wall || 0) + 1;
      this.note('withdrew to a defensible square', {
        to: { col: this.hold?.col, row: this.hold?.row }, threats: threats.length,
        why: 'a spot that holds ends the fight on our terms and makes the logoff-and-turn ' +
             'heal available, which open ground does not' });
      return;
    }

    // The recovery search already considered every local wall. Do not select and
    // announce another forward candidate that would be discarded by a second search.
    // With no clear wall, leave the existing no-wandering fallback in control.
    this.note('not walking away — nowhere here is safer than here', {
      threats: threats.length,
      why: 'a monster follows, so distance buys seconds and spends them going nowhere. There ' +
           'is no wall to be had here, so the way out is ON.',
      instead: 'carrying on to the objective',
    });
    return { withdrawn: false, declined: 'no wall here, and walking away is not an answer' };
  }
  // @end 1
}
