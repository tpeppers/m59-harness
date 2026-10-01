// A sector packet announces the destination, not completion of its animation.
// Match this door and its OPEN height; waitFor resolves even when it times out.
//
// A RUN OF SECTORS IS OPEN WHEN ITS LAST ONE IS. The Wryn's Keep (704) entrance is sectors 1, 2
// and 3 raised one second apart by a counter (`plan.sectors`, `plan.sequence_ms`), so the event
// worth waiting for is the LAST sector's, and it arrives `sequence_ms` after the press. The event
// window is widened by exactly that much: the fixed 1.5s gave up before the third sector had
// even been asked to move, and every press read "no matching opening event". The animation that
// follows is the slow part (76 units at speed 16 is 4.85s, the operator's "3-5s for guild hall
// doors"), and it is waited out from that event, never guessed.
export async function waitForDoorOpen(c, plan, { since, cancelled = () => false,
  now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)),
  eventTimeoutMs = 1500 } = {}) {
  const began = now(), room = c.room?.id;
  const sectors = plan.sectors?.length ? plan.sectors : [plan.sector];
  const lastSector = sectors[sectors.length - 1];
  const eventWindowMs = eventTimeoutMs + Math.max(0, Number(plan.sequence_ms) || 0);
  const stopped = () => cancelled() || c.room?.id !== room;
  const matches = e => e.sector === lastSector && e.height === plan.to_height &&
    (e.room == null || e.room === room);
  // A sector of the run that is KNOWN to be somewhere other than open.
  const shut = () => sectors.some(s => {
    const latest = c.room?.sectorHeights?.get(s);
    return latest && latest.height !== plan.to_height;
  });
  let event = null;
  while (!stopped() && now() - began < eventWindowMs) {
    const reply = await c.waitFor({ since, kinds: ['sector-height'], match: matches,
      timeoutMs: Math.min(100, eventWindowMs - (now() - began)) });
    event = reply?.events?.find(matches);
    if (event) break;
  }
  if (stopped()) return { opened: false, reason: 'movement cancelled' };
  if (!event) return { opened: false, reason: 'no matching opening event' +
    (sectors.length > 1 ? ` (sector ${lastSector}, the last of ${sectors.join('+')})` : '') };
  if (!Number.isFinite(event.speed) || event.speed < 0)
    return { opened: false, reason: 'door animation speed unknown' };
  const duration = event.speed === 0 ? 0 :
    Math.ceil(Math.abs(plan.to_height - plan.from_height) * 1000 / event.speed) + 100;
  const started = event.at ?? now();
  // Never claim completion beyond the known open window, or wait without a bound.
  if (!Number.isFinite(duration) || duration > Math.min(plan.within_ms ?? 8000, 8000))
    return { opened: false, reason: 'door animation exceeds its opening window' };
  const until = started + duration;
  while (!stopped() && now() < until) {
    if (shut()) return { opened: false, reason: 'door closed before its animation settled' };
    await sleep(Math.min(100, until - now()));
  }
  if (stopped()) return { opened: false, reason: 'movement cancelled' };
  if (shut()) return { opened: false, reason: 'door closed before crossing' };
  return { opened: true, animation_ms: duration, waited_ms: now() - began };
}

// A PRESS THE SERVER REFUSED IS NOT A DOOR THAT STAYED SHUT.
// `UserGo` (user.kod:5657) answers "You are unable to go anywhere." when PFLAG_NO_MOVE is
// set -- which `ResetPlayerFlagList` (player.kod:1162) does for as long as the character
// is RESTING -- and never reaches the room's SomethingTryGo at all. From the door's side
// that is indistinguishable from a slow door, so without this a seated character reports
// "no matching opening event" for ever. Kermit and Robin did, 1,900 times, 2026-09-24.
export const CANT_GO = /unable to go anywhere/i;
export function refusedToGo(c, since) {
  const events = c.eventsSince?.(since) ?? (c.events ?? []).filter(e => e.seq > since);
  return events.some(e => e.kind === 'message' && CANT_GO.test(String(e.text ?? '')));
}
