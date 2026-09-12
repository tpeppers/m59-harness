#!/usr/bin/env node
// ONE CHECKPOINT, SEVERAL WAYS TO REACH IT.
//
//   import { checkpoint, reach, STRATEGIES } from './m59-establish.mjs';
//
//   const armed = checkpoint('the fleet is at the feast hall, armed', {
//     holds: async (ctx) => /* every raider in room 40 wielding a MAGIC weapon */,
//     establish: {
//       dm:     async (ctx) => { ... },        // force it. Lab only, seconds.
//       played: async (ctx) => { ... },        // walk and buy it. Works on prod, twenty minutes.
//       scene:  'dukes-feast-hall',            // a captured room, rebuilt wholesale.
//     },
//     cost: { dm: 'free', played: 'expensive', scene: 'cheap' },
//   });
//
// ============================================================ WHY THIS IS ONE THING AND NOT FOUR
//
// The operator's framing, 2026-09-11, and it is the whole design: **DM-forcing a configuration
// and playing your way into it are two routes to the SAME checkpoint.** One is faster and one is
// faithful; the destination is identical. Once that is said out loud, four things this repository
// had been treating as separate collapse into one shape:
//
//   dm      the maintenance socket. Absolute, instant, and a lab instrument only.
//   played  the errand. Slow, but it is the thing we are actually trying to be able to do.
//   scene   a captured room replayed (m59-scene.mjs). The wholesale version of `dm`.
//   shadow  m59-shadow.mjs `dress`. A scene load scoped to CHARACTERS rather than a room --
//           which is why the shadow fleet has never cloned anybody's surroundings: it was
//           written as its own thing rather than as one of these.
//
// ============================================================ AND `holds` IS WHAT MAKES IT HONEST
//
// THE SECOND `holds` IS THE ENTIRE POINT. A shortcut you cannot check is not a shortcut, it is a
// different experiment wearing the same name. Forcing a configuration by fiat and then asserting
// the SAME predicate the slow route would have satisfied is the only thing that makes the fast
// route evidence about the slow one.
//
// So `reach()` is:
//
//   1. ask `holds`. If it already holds, run NOTHING. Re-running an establish that was not
//      needed is how a scene gets clobbered by its own setup.
//   2. choose a strategy that is actually available here (`dm` needs a loopback admin socket).
//   3. run it.
//   4. ASK `holds` AGAIN, and refuse if it still does not hold.
//
// Step 4 is not belt and braces. The server never says no -- `UtilGoNearSquare` returns 1 for a
// square that does not exist, because it searches outward and finds something standable -- so
// "the DM command succeeded" and "the character is where I asked" are different facts, and only
// one of them is the checkpoint.
//
// ============================================================ UNKNOWN, AND WHEN IT MAY BE IGNORED
//
// `holds` may answer unknown, and it must be allowed to: the fact that decides "is this weapon
// enchanted" is not on the wire at all. The rule, which the peer session running the raid and
// this one arrived at from opposite directions:
//
//   **unknown refuses -- UNLESS establishing is free and idempotent, in which case just
//   establish.** Asking is not always the cheapest way to find out. Casting at an already
//   enchanted weapon is refused in CanPayCosts BEFORE cost (persench.kod:76), so the write is
//   cheaper and more authoritative than the read, and refusing on unknown there would burn an
//   evening asking questions the game will not answer.
//
// `'free'` therefore REQUIRES a citation, because it is the only value that changes behaviour.
// Unsupported, it is an author being optimistic about their own code.
import { isLoopbackHost, adminTarget } from './m59-dm.mjs';
import { fidelity, permits, recordGap, FIDELITY_COST } from './m59-fidelity.mjs';

export const HOLDS = true;
export const UNKNOWN = null;

/** Costs, cheapest first. Only `free` establishes on an unknown. */
export const COSTS = Object.freeze(['free', 'cheap', 'expensive', 'irreversible']);
export const STRATEGIES = Object.freeze(['dm', 'scene', 'shadow', 'played']);

/** Is this way of establishing available on this machine at all? */
export function strategyAvailable(which, env = process.env) {
  if (which === 'dm' || which === 'scene' || which === 'shadow') {
    const t = adminTarget(env);
    return isLoopbackHost(t.host)
      ? { ok: true }
      : { ok: false, why: `${which} configures the world over the DM socket, and the admin ` +
                          `target is ${t.host}:${t.port} — not this machine` };
  }
  return { ok: true };      // `played` is the errand, and the errand runs anywhere.
}

/**
 * Declare a checkpoint. Validates at construction, because a malformed one discovered while a
 * fleet is standing in a boss room is a malformed one discovered too late.
 */
export function checkpoint(name, { holds, establish = {}, cost = {}, citation = {} } = {}) {
  if (!name) throw new Error('a checkpoint needs a name');
  if (typeof holds !== 'function')
    throw new Error(`checkpoint "${name}": holds must be a function — a checkpoint is a ` +
                    `predicate plus a way to establish it, never a saved blob`);
  const ways = Object.keys(establish).filter(k => establish[k] != null);
  if (!ways.length)
    throw new Error(`checkpoint "${name}": declares no way to establish it. A predicate with no ` +
                    `establish is an assertion, which is a different thing and wants a verify step`);
  for (const w of ways)
    if (!STRATEGIES.includes(w))
      throw new Error(`checkpoint "${name}": unknown strategy "${w}". Known: ${STRATEGIES.join(', ')}`);
  for (const [w, c] of Object.entries(cost)) {
    if (!COSTS.includes(c))
      throw new Error(`checkpoint "${name}": unknown cost "${c}" for ${w}. Known: ${COSTS.join(', ')}`);
    // THE ONE VALUE THAT CHANGES BEHAVIOUR IS THE ONE THAT HAS TO BE SUPPORTED.
    if (c === 'free' && !citation[w])
      throw new Error(`checkpoint "${name}": cost.${w} is 'free', which is the only value that ` +
                      `lets an UNKNOWN establish without asking. Give citation.${w} — a ` +
                      `kod/path/file.kod:line showing the operation is refused before it costs ` +
                      `anything. Unsupported, 'free' is optimism.`);
  }
  return Object.freeze({ __checkpoint: true, name, holds, establish, cost, citation, ways });
}

/** Is this a checkpoint rather than a plain setup function? */
export const isCheckpoint = (x) => !!(x && typeof x === 'object' && x.__checkpoint === true);

const verdict = (r) => (r === HOLDS ? 'holds'
  : (r === UNKNOWN || r === undefined) ? 'unknown' : 'does-not-hold');

/**
 * Get the world to the checkpoint, or say exactly why not.
 *
 * `run` is injected for `scene` and `shadow` so this module opens no socket and a test needs no
 * server: `run(which, value, ctx)` is handed the strategy name and whatever the checkpoint
 * declared for it.
 */
export async function reach(cp, ctx = {}, { prefer = null, allowUnknown = false,
                                            env = process.env, run = null,
                                            fidelity: mode = null, ledger = null } = {}) {
  const log = [];
  const say = (m) => { log.push(m); return m; };
  // A RUN WITHOUT A DECLARED MODE IS A SCRATCHPAD RUN, and says so rather than silently claiming
  // the strictest or the loosest. `anything` is the honest default: no claim is being made.
  const fid = mode ?? fidelity('anything');
  const gaps = ledger ?? [];

  // 1. ALREADY THERE? Then run nothing at all.
  // ASKED THROUGH ONE HELPER, BECAUSE A SYNCHRONOUS THROW ESCAPES Promise.resolve().catch().
  // `Promise.resolve(cp.holds(ctx))` evaluates holds BEFORE there is a promise to attach a
  // catch to, so a predicate that throws synchronously — which is most of them, since most are
  // plain arrow functions — took down the caller instead of being scored unknown. Caught by the
  // test for "a holds that throws is unknown", which is the case it exists for.
  const ask = async () => {
    try { return await cp.holds(ctx); }
    catch (e) { return { __threw: e.message }; }
  };

  const before = await ask();
  if (before?.__threw)
    return { ok: false, log, gaps, why: `holds threw before anything ran: ${before.__threw}`,
             ran: null, verdict: 'unknown' };
  const v0 = verdict(before);
  if (v0 === 'holds') {
    say(`${cp.name}: already holds — nothing to do`);
    return { ok: true, log, gaps, ran: null, verdict: 'holds', establishedBy: null };
  }

  // 2. WHICH WAY, AND IS IT AVAILABLE HERE?
  const order = prefer ? [prefer, ...cp.ways.filter(w => w !== prefer)] : [...cp.ways];
  const refusals = [];
  let chosen = null;
  for (const w of order) {
    if (!cp.establish[w]) { refusals.push(`${w}: not declared`); continue; }
    const av = strategyAvailable(w, env);
    if (!av.ok) { refusals.push(av.why); continue; }
    // AND THE MODE GETS A VETO, WHICH IS THE POINT OF prod-faithful. A DM shortcut is refused
    // here rather than taken and footnoted: a run that teleports and then reports success has
    // answered a question nobody asked. Naming it in concede[] is how a caller says they meant it.
    const p = permits(fid, w, { label: cp.name });
    if (!p.ok) { refusals.push(p.why); continue; }
    chosen = w; break;
  }
  if (!chosen)
    return { ok: false, log, verdict: v0, ran: null, gaps,
             why: `${cp.name}: no way to establish it here.\n  ${refusals.join('\n  ')}` };

  // 3. UNKNOWN REFUSES UNLESS ESTABLISHING IS FREE.
  if (v0 === 'unknown') {
    const c = cp.cost[chosen] ?? 'expensive';
    if (c !== 'free' && !allowUnknown)
      return { ok: false, log, gaps, verdict: 'unknown', ran: null,
               why: `${cp.name}: cannot tell whether it holds, and establishing it by "${chosen}" ` +
                    `is ${c} rather than free — so this refuses rather than paying for something ` +
                    `that may already be true. Pass allowUnknown to spend it anyway.` };
    say(`${cp.name}: unknown, and "${chosen}" is free (${cp.citation[chosen]}) — establishing`);
  }

  // 4. RUN IT.
  const what = cp.establish[chosen];
  try {
    if (typeof what === 'function') await what(ctx);
    else if (typeof run === 'function') await run(chosen, what, ctx);
    else throw new Error(`strategy "${chosen}" is declarative (${JSON.stringify(what)}) and ` +
                         `reach() was given no run() to carry it out`);
    say(`${cp.name}: established by ${chosen}`);
    // WRITTEN DOWN NOW, NOT RECONSTRUCTED LATER. A shortcut is only attributable if it is recorded
    // beside the checkpoint it closed, at the moment it closed it.
    const p = permits(fid, chosen, { label: cp.name });
    if (FIDELITY_COST[chosen] !== 'none' || v0 === 'unknown')
      recordGap(gaps, { checkpoint: cp.name, strategy: chosen, label: cp.name,
                        cost: p.cost, boughtIn: p.boughtIn, why: p.why,
                        unknownWaived: v0 === 'unknown' && allowUnknown });
  } catch (e) {
    return { ok: false, log, gaps, verdict: v0, ran: chosen,
             why: `${cp.name}: establishing by ${chosen} failed: ${e.message}` };
  }

  // 5. AND ASK AGAIN. The step that makes the shortcut evidence about the long way.
  const after = await ask();
  if (after?.__threw)
    return { ok: false, log, gaps, ran: chosen, verdict: 'unknown',
             why: `${cp.name}: established by ${chosen}, but holds threw afterwards: ${after.__threw}` };
  const v1 = verdict(after);
  if (v1 === 'holds') {
    say(`${cp.name}: confirmed after ${chosen}`);
    return { ok: true, log, gaps, ran: chosen, verdict: 'holds', establishedBy: chosen };
  }
  return { ok: false, log, gaps, ran: chosen, verdict: v1,
           why: `${cp.name}: ran "${chosen}" and it STILL does not hold` +
                (v1 === 'unknown'
                  ? ' — and cannot be read, so the shortcut cannot be confirmed. The server ' +
                    'never says no: a command that returned success is not a world in the ' +
                    'state you asked for.'
                  : `: ${String(after)}`) };
}

export function formatReach(r) {
  const head = r.ok ? `ok — ${r.establishedBy ? `established by ${r.establishedBy}` : 'already held'}`
                    : `REFUSED — ${r.why}`;
  return [head, ...r.log.map(l => `  ${l}`)].join('\n');
}
