// A sector packet announces the destination, not completion of its animation.
// Match this door and its OPEN height; waitFor resolves even when it times out.
export async function waitForDoorOpen(c, plan, { since, cancelled = () => false,
  now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)),
  eventTimeoutMs = 1500 } = {}) {
  const began = now(), room = c.room?.id;
  const stopped = () => cancelled() || c.room?.id !== room;
  const matches = e => e.sector === plan.sector && e.height === plan.to_height &&
    (e.room == null || e.room === room);
  let event = null;
  while (!stopped() && now() - began < eventTimeoutMs) {
    const reply = await c.waitFor({ since, kinds: ['sector-height'], match: matches,
      timeoutMs: Math.min(100, eventTimeoutMs - (now() - began)) });
    event = reply?.events?.find(matches);
    if (event) break;
  }
  if (stopped()) return { opened: false, reason: 'movement cancelled' };
  if (!event) return { opened: false, reason: 'no matching opening event' };
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
    const latest = c.room?.sectorHeights?.get(plan.sector);
    if (latest && latest.height !== plan.to_height)
      return { opened: false, reason: 'door closed before its animation settled' };
    await sleep(Math.min(100, until - now()));
  }
  if (stopped()) return { opened: false, reason: 'movement cancelled' };
  const latest = c.room?.sectorHeights?.get(plan.sector);
  if (latest && latest.height !== plan.to_height)
    return { opened: false, reason: 'door closed before crossing' };
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
