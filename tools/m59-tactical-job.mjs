// Exact one-shot viewer orders. This module owns no sockets and changes no policy.
// The caller provides the keeper's endpoint/faculty authority check. All nested
// mover packets retain that guard through Pacer, including door stand/go helpers.
import { withPacketScope } from './m59-packet-scope.mjs';
import { setIntentTarget } from './m59-intent-observations.mjs';
import { OF } from './m59-parse.mjs';
import { rtsJobReport } from './m59-rts-safety.mjs';
import { travelUnderLease } from './fleetscripts/leased-travel.mjs';

const text = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const requireThat = (test, message) => { if (!test) throw new Error(`tactical: ${message}`); };

export function tacticalExitDescriptor(exit) {
  return { kind: text(exit.kind, 40), destination_room: exit.to,
    col: exit.stand_on?.col, row: exit.stand_on?.row,
    how: text(exit.how, 240), trigger: text(exit.trigger, 160) };
}

export function selectTacticalExit(exits, target, room, confine = []) {
  requireThat(target && Number.isSafeInteger(target.destination_room) && target.destination_room > 0,
    'exit destination is not known');
  requireThat(!confine.length || confine.map(Number).includes(target.destination_room),
    'exit is outside the keeper confinement');
  const keys = ['kind', 'destination_room', 'col', 'row', 'how', 'trigger'];
  const matches = exits.filter(exit => {
    const descriptor = tacticalExitDescriptor(exit);
    return keys.every(key => descriptor[key] === target[key]);
  });
  requireThat(matches.length === 1, 'clicked exit changed or is ambiguous; refresh and click again');
  const exit = matches[0];
  requireThat(['go', 'edge', 'region'].includes(exit.kind), 'unsupported or locked exit');
  // A go tile is often a geometry pocket. reachable:false is NOT a door refusal.
  requireThat(exit.kind === 'go' || exit.reachable !== false, 'exit approach is unreachable');
  return exit;
}

export function checkTacticalBinding(session, args) {
  const c = session.need();
  const b = args.binding;
  requireThat(b && b.agent === session.name && Number.isSafeInteger(b.player_id) &&
    b.player_id > 0 && b.player_id === c.selfId, 'selected character identity changed');
  requireThat(Number.isSafeInteger(b.room) && b.room === Number(session.world?.room?.num) &&
    b.room_resource_id === c.roomRsc && Number.isInteger(c.room?.security) &&
    b.room_security_u32 === (c.room.security >>> 0),
    'selected room wire identity changed');
  requireThat(typeof b.character === 'string' && b.character === c.rsc.get(c.self?.nameRsc),
    'selected character name changed');
  return c;
}

export function tacticalJobStatus(job, args, now = Date.now()) {
  requireThat(job && job.tacticalId === args.order_id && job.controlToken === args.control_token &&
    job.leaseToken === args.lease_token && job.startedAt === args.started_at,
    'the exact accepted job is no longer available');
  const report = rtsJobReport(job, now);
  return { order_id: job.tacticalId, observed_at: now,
    state: !job.done ? 'running' : report.cancelled ? 'cancelled' : report.failed ? 'failed' : 'completed',
    message: report.failed ? String(report.failed).slice(0,240) : undefined };
}

export function startTacticalJob(session, keeper, args, authority) {
  requireThat(/^[a-f0-9]{32}$/.test(args.order_id ?? ''), 'invalid order identity');
  requireThat(args.control_token === args.order_id && typeof args.lease_token === 'string' &&
    args.lease_token.length >= 16, 'missing order capability');
  requireThat(['attack', 'exit', 'route'].includes(args.action), 'unsupported action');
  authority('tactical-intent');
  const c = checkTacticalBinding(session, args);
  const roomObject = c.room.id;
  let deadline = Date.now() + (args.action === 'route' ? 45 * 60_000 : 120_000);
  let targetIdentity = null, exit = null;
  const target = args.target;
  const currentTarget = () => {
    const object = c.room.objects.get(target?.object_id);
    requireThat(object && (object.flags & OF.ATTACKABLE) && !(object.flags & OF.PLAYER),
      'target is absent or no longer PvE-attackable');
    requireThat(c.rsc.get(object.nameRsc) === target.name &&
      (!targetIdentity || object.nameRsc === targetIdentity.nameRsc), 'target identity changed');
    return object;
  };
  if (args.action === 'attack') targetIdentity = { nameRsc: currentTarget().nameRsc };
  else if (args.action === 'route') {
    requireThat(target && Object.keys(target).length === 1 &&
      Number.isSafeInteger(target.destination_room) && target.destination_room > 0 &&
      session.world.map?.rooms?.[String(target.destination_room)], 'route destination is not a known map');
    requireThat(typeof keeper.travel === 'function', 'maintained keeper travel is unavailable');
    const confine = keeper.policy?.confineRooms;
    requireThat(!Array.isArray(confine) || !confine.length || confine.map(Number).includes(target.destination_room),
      'route is outside the keeper confinement');
  }
  else exit = selectTacticalExit(session.world.exits(), target, args.binding.room,
    Array.isArray(keeper.policy?.confineRooms) ? keeper.policy.confineRooms : []);

  const guard = kind => {
    requireThat(Date.now() < deadline, 'order deadline expired');
    const job = session.job;
    requireThat(job && !job.done && job.controlToken === args.control_token &&
      job.leaseToken === args.lease_token && !job.cancelled && !job.cancelRequestedAt &&
      !session.movementWasCancelled(job.generation, args.control_token), 'order cancelled or superseded');
    // Post-crossing BP_PLAYER confirmation is a read. It cannot authorize another move.
    if (args.action === 'route') {
      requireThat(['move', 'turn', 'rest', 'read', 'use', 'cast'].includes(kind), `unexpected ${kind} route packet`);
      authority(kind);
      requireThat(session.need() === c && c.selfId === args.binding.player_id,
        'client connection or character changed');
      // BP_PLAYER can precede the new ROOM_CONTENTS. A confirmation read may
      // bridge that gap; no movement may use a missing/changed character row.
      requireThat(c.self ? c.rsc.get(c.self.nameRsc) === args.binding.character : kind === 'read',
        'character changed or room contents are incomplete');
      requireThat(Number(session.world?.room?.num) !== 1 &&
        (kind === 'read' || c.vitals()?.health?.value > 0), 'route interrupted by death or unknown health');
      return;
    }
    if (kind === 'read') return;
    requireThat(['move', 'turn', 'rest', 'attack'].includes(kind), `unexpected ${kind} packet`);
    authority(kind);
    requireThat(checkTacticalBinding(session, args) === c, 'client connection changed');
    requireThat(c.room.id === roomObject, 'room generation changed');
    const health = c.vitals()?.health;
    const maximum = health?.max ?? health?.scale_max;
    requireThat(Number.isFinite(health?.value) && maximum > 0 && health.value / maximum > 0.35,
      'health is unknown or at/below 35%; returning control');
    if (args.action === 'attack') currentTarget();
    else requireThat(kind !== 'attack', 'exit orders do not authorize combat');
  };
  const job = session.startJob(args.action === 'route' ? 'travel' : args.action,
    `tactical ${args.action}`, async generation => {
      // Session installs the job before calling us, but its result identity is set
      // after startJob returns. No packet can run before this microtask boundary.
      await Promise.resolve();
      setIntentTarget(session,args.action==='route'?{kind:'travel',destination_room:target.destination_room}:exit?{kind:'exit',col:target.col,row:target.row,destination_room:target.destination_room}
        :{kind:'attack',object_id:target.object_id});
      return withPacketScope(guard, async () => {
        guard('rest');
        if (args.action === 'route') {
          const result = await travelUnderLease({ session, keeper, destination: target.destination_room,
            generation, token: args.control_token, check: () => guard('read'),
            setDeadline: ms => { deadline = Math.min(deadline, Date.now() + ms); } });
          return { arrived: result.ok === true, reason: result.why };
        }
        if (exit) {
          if (target.destination_room === args.binding.room) {
            const doors = (session.world.room.goExits ?? []).filter(door =>
              !door.locked && door.to === target.destination_room && door.col === target.col && door.row === target.row);
            requireThat(exit.kind === 'go' && doors.length === 1 &&
              Number.isFinite(doors[0].arriveCol) && Number.isFinite(doors[0].arriveRow),
              'internal door landing is unknown or ambiguous');
            await session.standBeforeGo();
            const result = await session.crossSameRoomDoor(doors[0], {
              movementGeneration: generation, controlToken: args.control_token });
            return { arrived: result?.crossed === true && c.room.id === roomObject,
              reason: result?.reason ?? 'internal doorway landing was not confirmed' };
          }
          const result = await session.leaveVia(exit, { movementGeneration: generation,
            controlToken: args.control_token, expectedRoomId: roomObject });
          return { arrived: result?.left === true &&
            Number(session.world?.room?.num) === target.destination_room && c.room.id !== roomObject,
            reason: result?.reason ?? 'the selected destination was not confirmed' };
        }
        await session.standBeforeGo();
        let swings = 0;
        // Keep the exact fight, not just a fixed number of swings. The deadline,
        // live lease, cancellation and survival guard still bound every packet.
        for (;; swings++) {
          if (!c.room.objects.has(target.object_id)) return { swings, target_gone: true };
          guard('attack');
          let object = currentTarget();
          const me = c.self;
          if (Math.hypot(object.col - me.col, object.row - me.row) > 2) {
            const spot = session.world.approachSquare(object.col, object.row);
            requireThat(spot && Number.isFinite(spot.col) && Number.isFinite(spot.row),
              'no validated approach to this target');
            const walked = await session.walkTo(spot.col, spot.row, {
              maxSteps: 120, hardCap: 400, movementGeneration: generation,
              controlToken: args.control_token });
            requireThat(walked?.arrived === true, walked?.reason ?? 'attack approach did not arrive');
            object = currentTarget();
          }
          await session.faceToward(object);
          await session.pacer.submit('attack', () => c.attack(target.object_id), 1050);
        }
      });
    }, { controlToken: args.control_token, leaseToken: args.lease_token });
  job.tacticalId = args.order_id;
  return { accepted: true, order_id: args.order_id, started_at: job.startedAt };
}
