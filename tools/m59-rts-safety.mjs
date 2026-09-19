// Shape checks for spells sent through the RTS control surface.
//
// THE SPELL ALLOWLIST WAS RETIRED, DELIBERATELY, 2026-09-19, ON THE OPERATOR'S INSTRUCTION:
// "Let's retire the RTS safety allowlist -- we've progressed far enough we can cast on other
// players at will."
//
// WHAT IT USED TO BE, so nobody has to reconstruct it from a diff: a fail-closed `SAFE_SPELLS`
// map holding exactly three names — create food, create weapon, blink — each
// `{targets: 0, target_mode: 'none'}`, read through `rtsSafeSpellRule(name, targets)`, plus
// `rtsSpellTargetAllowed(rule, …)` with modes 'none' | 'self' | 'pve' of which only 'none' was
// ever reachable. Anything else was refused 409 "is not classified as safe for RTS casting". It
// also filtered the RTS spell LIST in m59-rts-contract.mjs, so a fleet character appeared to know
// three spells however many it actually had.
//
// WHAT WAS GIVEN UP. An autonomous keeper may now aim ANY spell the character really knows at ANY
// object it can see, a player included. That covers the harmful ones — the attack spells, mana
// bomb, and Earthquake, which was this module's own cited counterexample for why a zero-target
// arity does not imply a harmless spell. The blast radius is no longer bounded here. It is
// bounded by what the fleet is told to cast, and by `requireRtsLocalCaller` below — a DIFFERENT
// control, untouched, answering "may this caller drive a character at all" rather than "what may
// it cast".
//
// WHAT IS KEPT, because it was never policy. The server states each spell's target count on the
// wire (`numTargets`). Sending a targeted packet for a zero-target spell — or an untargeted one
// for a spell that wants a target — is a malformed packet rather than a policy question, and the
// client has no business emitting either. That check stays, and it is now all this part does.
// Every identity and staleness check at the call sites stays too: those guard against a spell or
// target changing underfoot between intent and packet, which retiring a policy does not make safe.
export function rtsCastArityOk(targets, hasTarget) {
  if (!Number.isSafeInteger(targets) || targets < 0) return false;
  return targets === 0 ? !hasTarget : !!hasTarget;
}

// THE CONTROL PLANE IS LOCAL; THE GAME SERVER NEED NOT BE.
//
// The broker's JSON-RPC transport carries every RTS write, has no authentication of
// its own, and M59_BIND can deliberately bind it to a LAN interface — so being able to
// reach it is not authority to drive a character. Reads are already refused off-loopback
// at the socket regardless of that bind; this is the same statement for writes, and it
// is what replaced the old rule that the GAME server had to be a local lab. That rule
// was a blast-radius proxy rather than a check: it conflated "the commander is on this
// machine" with "the target is disposable", and it made a shared remote server
// undrivable for no security gain.
//
// A caller is local when its transport says so: stdio is a pipe from the process that
// spawned the broker, and an HTTP request must have arrived from loopback on a loopback
// Host header. Absent or malformed context is refused — a control tool that cannot tell
// where it came from has no business sending a Meridian packet.
export function rtsCallerIsLocal(caller) {
  return !!caller && caller.local === true && typeof caller.transport === 'string' &&
    caller.transport.length > 0;
}

export function requireRtsLocalCaller(caller) {
  if (!rtsCallerIsLocal(caller))
    throw new Error('RTS control is accepted only from this machine: the broker\'s ' +
      'JSON-RPC transport is unauthenticated and may be bound beyond loopback');
  return caller;
}

// Run the authority chain synchronously inside a pacer callback. Callers provide
// closures over broker state so this module stays independent of sessions and
// autopilots. Ordering matters: a packet never reaches action validation unless its
// endpoint, keeper, room, and token owner are still authoritative; an owned cancel
// then wins over a target/item race and produces cancellation telemetry.
export function rtsPacketAuthorityCheck({ packet, detail = null, endpoint, keeper, room,
                                           owner, cancelled, validate = null }) {
  endpoint();
  keeper();
  room(packet);
  owner(packet);
  if (cancelled()) return true;
  if (typeof validate === 'function') validate(packet, detail);
  return false;
}

export function rtsCleanupAuthorityCheck({ packet, endpoint, keeper, room, owner }) {
  endpoint();
  keeper();
  room(packet);
  owner(packet);
}

// Background RTS jobs are exposed as renderer telemetry after they finish. An owned
// cancellation is authoritative even when the underlying helper returned an ordinary
// result (attack stops its loop) or threw while unwinding (recovery cleanup can lose
// authority). Never let those races turn a user-requested stop into `ok` or `failed`.
export function rtsJobReport(job, now = Date.now()) {
  if (!job) return undefined;
  const elapsed = Math.max(0, Math.round(((job.finishedAt || now) - job.startedAt) / 1000));
  if (!job.done) {
    return {
      busy: job.label,
      running_for_s: elapsed,
      ...(job.cancelled || job.cancelRequestedAt ? { stopping: true } : {}),
    };
  }
  const cancelled = job.cancelled === true || job.cancelRequestedAt != null ||
    job.result?.cancelled === true || job.result?.recovery?.cancelled === true;
  const commerceResult = typeof job.kind === 'string' && job.kind.startsWith('commerce:') && job.result
    ? {
        commerce_result: {
          kind: job.result.kind ?? job.kind.slice('commerce:'.length),
          quote_id: job.result.quote_id ?? null,
          committed: job.result.committed === true,
          verification_failed: job.result.verification_failed === true,
          state: job.result.state ?? null,
          evidence: job.result.evidence ?? null,
        },
      }
    : {};
  return {
    last_action: job.label,
    took_s: elapsed,
    // `ok` MEANT "THE FUNCTION RETURNED", WHICH IS NOT WHAT ANY READER THINKS IT MEANS.
    //
    // A journey that gives up resolves normally -- `{arrived:false, reason:'...'}` is a
    // return value, not a throw -- so it landed in the `ok: true` default below and the job
    // reported success. Measured on shadow: `travel to 2` from inside Ukgoth answered
    // `{last_action:'walk to room 2', took_s:0, ok:true}` while the character did not move a
    // square, from four different starting positions, and every instrument above this one
    // repeated the claim. It is the same class of mistake as `busy` being absent and read as
    // false: a field whose failure mode is looking fine.
    //
    // A result that carries `arrived` is a movement job, and for those `arrived` IS the
    // outcome. Anything else keeps the old meaning, because a commerce or errand job has no
    // such field and its own verification is handled above.
    ...(cancelled ? { cancelled: true }
      : job.error ? { failed: job.error }
      : job.result?.verification_failed === true || job.result?.committed === false
        ? { failed: 'server outcome could not be verified; no success was claimed' }
      : job.result && job.result.arrived === false
        ? { failed: job.result.reason ?? job.result.note ?? 'did not arrive, and gave no reason' }
      : { ok: true }),
    ...commerceResult,
  };
}
