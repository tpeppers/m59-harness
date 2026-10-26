// SAME-ROOM BRIDGES: crossing between the islands of one room, and to a quarry on another.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 2 methods: crossSameRoomIsland, bridgeToQuarry
import { sameRoomDoorPlan, sameRoomIslandBridgePlan } from '../m59-world.mjs';

export class BridgesPart {
  // @part 1

  // CROSS BETWEEN DISCONNECTED PARTS OF ONE ROOM.
  //
  // Ordinary travel intentionally stops when the room number matches its destination.
  // That is usually exactly right and makes it incapable of expressing this particular
  // journey: Upstairs Castle Victoria -> Castle Victoria -> Upstairs Castle Victoria.
  // The second upstairs arrival is the destination even though its room number is the
  // same as the departure, because it is on the quarry's side of the central wall.
  async crossSameRoomIsland(plan) {
    const s = this.s, c = s.client;
    if (!plan || !c || !s.world) return { arrived: false, reason: 'no same-room bridge plan' };

    // A SAME-ROOM BRIDGE IS STILL TRAVEL. The route temporarily leaves the room
    // (39 -> 38 -> 39 in Upstairs Castle Victoria), so checking only the final room
    // quietly bypassed an operator confinement that allowed 39 and nothing else.
    // Keep this guard here, immediately before the first raw leaveViaAny call: this
    // helper deliberately does not use travel(), so it cannot inherit that method's
    // confineRooms check. Death/Underworld escape does not use this helper and remains
    // available even under a one-room confinement.
    const confine = Array.isArray(this.policy?.confineRooms) ? this.policy.confineRooms : null;
    if (confine?.length && !new Set(confine.map(Number)).has(Number(plan.viaRoom))) {
      this.note('split-room bridge refused by the confinement', {
        room: plan.fromName,
        via: plan.viaName,
        confined_to: confine.map(Number),
        why: 'changing sides would leave the permitted room, even though the route returns to it',
      });
      return {
        arrived: false,
        confined: true,
        reason: `the split-room bridge passes through room ${plan.viaRoom}, outside the confinement`,
      };
    }

    const matches = (e, doors, to) => e.kind === 'go' && e.to === to && e.stand_on &&
      doors.some(d => d.row === e.stand_on.row && d.col === e.stand_on.col);
    const settle = async () => {
      const before = c.evSeq;
      await s.pacer.submit('read', () => c.roomContents());
      await c.waitFor({ since: before, kinds: ['room-contents'], timeoutMs: 2500 });
    };

    const out = (s.world.exits?.() || [])
      .filter(e => matches(e, plan.leaveDoors, plan.viaRoom));
    if (!out.length)
      return { arrived: false, reason: `cannot reach a door from this part of ${plan.fromName}` };

    this.doing = 'travelling';
    // REMEMBER WHICH SIDE, so that a bridge interrupted half-way — by a wedge, a fight, a
    // watchdog cancel — does not come back through whichever door happens to be nearest.
    // Read in the travel funnel; see the note there.
    this.wantSide = { room: plan.fromRoom, target: { col: plan.target.col, row: plan.target.row },
                      at: Date.now() };
    this.note('changing sides of a split room', {
      room: plan.fromName, quarry: { col: plan.target.col, row: plan.target.row },
      via: plan.viaName, why: plan.why,
    });
    // `exact`: the planner chose these doors, and a widened set is a different journey.
    // See leaveViaAny — the baked anchor is a better guess than a scanned square right up
    // until the doors are not alternatives, which is the whole premise of a split room.
    let crossed = await s.leaveViaAny(out, { exact: true })
      .catch(e => ({ left: false, reason: e.message }));
    this.movedAt = Date.now();
    if (!crossed.left) return { arrived: false, reason: crossed.reason || 'could not leave this side' };
    await settle().catch(() => {});
    if (s.world.room?.num !== plan.viaRoom)
      return { arrived: false, reason: `the first door arrived in ${s.world.room?.name || 'an unknown room'}` };

    const back = (s.world.exits?.() || [])
      .filter(e => matches(e, plan.returnDoors, plan.fromRoom));
    if (!back.length)
      return { arrived: false, reason: `no door from ${plan.viaName} lands on the quarry's side` };
    // THE LEG THAT WAS ACTUALLY BROKEN. `returnDoors` are filtered by the planner to those
    // whose LANDING can reach the quarry; the anchor for 38 -> 39 lands on the other island
    // and outranked them, so the round trip came back to the side it left from.
    crossed = await s.leaveViaAny(back, { exact: true })
      .catch(e => ({ left: false, reason: e.message }));
    this.movedAt = Date.now();
    if (!crossed.left) return { arrived: false, reason: crossed.reason || 'could not take the other door back' };
    await settle().catch(() => {});

    const room = s.world.room, geo = s.world.geometry, me = c.self;
    const arrived = room?.num === plan.fromRoom && geo && me &&
      geo.path(me.row, me.col, plan.target.row, plan.target.col, { fine: true }).found;
    if (!arrived)
      return { arrived: false, reason: 'returned to the room, but not to the quarry\'s connected side' };
    // Arrived where we meant to, so the side is no longer a thing to steer by.
    this.wantSide = null;
    this.note('reached the quarry\'s side of the room', {
      room: room.name, via: plan.viaName,
      at: { col: me.col, row: me.row }, quarry: { col: plan.target.col, row: plan.target.row },
      next: 'choose a wall on this side, hit the quarry, and pull it there',
    });
    return { arrived: true, room: room.num, position: { col: me.col, row: me.row } };
  }

  // Door routing belongs to reaching the quarry, independent of whether combat
  // requires a safe wall. End the pass after either outcome: room contents and
  // vitals captured before a crossing are stale, even when the room number repeats.
  async bridgeToQuarry(quarry) {
    const s = this.s;
    const room = s.world?.room;
    const internal = sameRoomDoorPlan(s.world?.map, room?.num,
      s.world?.geometry, s.client?.self, quarry);
    if (internal?.doors?.length) {
      const generation = s.movementGeneration;
      const door = internal.doors[0];
      // A shelter belongs to the side we are leaving. Retain the ordinary health
      // gate, then let the existing executor stand, approach and confirm the go.
      const released = await this.leaveHold('taking an internal door to the quarry');
      if (released?.refused || s.movementWasCancelled?.(generation)) return true;
      this.doing = 'approaching';
      const result = await s.crossSameRoomDoor(door, { movementGeneration: generation })
        .catch(e => ({ crossed: false, reason: e.message }));
      this.movedAt = Date.now();
      if (result.cancelled || s.movementWasCancelled?.(generation)) return true;
      this.note('taking an internal door to the quarry', {
        room: room.num, target_id: quarry.id,
        stand_on: { row: door.row, col: door.col },
        lands: { row: door.arriveRow, col: door.arriveCol },
        doors_planned: internal.doors.length, crossed: result.crossed === true,
        at: result.at, why: result.reason,
      });
      if (result.crossed) {
        this.foeId = quarry.id;
        this.progress('crossed an internal door — reassess the live quarry before engaging');
      } else {
        this.deferPullTarget(room.num, quarry.id, result.reason);
        this.noProgress('internal door crossing did not complete');
      }
      // One door per pass: both the quarry and the landing may have moved. A
      // second chamber is reached by replanning from the confirmed new position.
      return true;
    }
    const plan = sameRoomIslandBridgePlan(s.world?.map, s.world?.room?.num,
      s.world?.geometry, s.client?.self, quarry);
    if (!plan) return false;
    const result = await this.crossSameRoomIsland(plan)
      .catch(e => ({ arrived: false, reason: e.message }));
    if (result.arrived) {
      this.progress('crossed to the quarry side — refresh before engaging');
    } else {
      this.deferPullTarget(plan.fromRoom, quarry.id, result.reason);
      this.note('could not reach the quarry through the connecting room', {
        target_id: quarry.id, room: plan.fromRoom, via: plan.viaRoom,
        why: result.reason,
      });
      this.noProgress('split-room crossing did not complete');
    }
    return true;
  }
  // @end 1
}
