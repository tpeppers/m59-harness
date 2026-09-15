#!/usr/bin/env node
// CHECKPOINTS: SKIP TO A STEP BY ESTABLISHING ITS POSTCONDITION, NOT BY REPLAYING IT.
//
// Written as a proposal for FleetScratch's `skipTo` / `runUntil`, and used here by the boss
// raid. The whole idea is one sentence: a checkpoint is a PREDICATE plus a way to ESTABLISH
// it, and never a saved blob of state.
//
// ============================================================================
// WHY NOT A SNAPSHOT, WHICH IS THE OBVIOUS DESIGN
// ============================================================================
//
// Because the world moves while you iterate, so replaying the earlier steps is not merely
// slow — it is NOT IDEMPOTENT, and a recorded state is stale before you read it back.
// Measured across five boss-raid attempts on 2026-09-11, each 16-30 minutes, every one of
// which re-walked the fleet from the beginning:
//
//   * CONJURED WEAPONS EVAPORATE. 10 of 21 raiders wielded `create weapon` conjures on a
//     1-24h decay timer. One expired mid-session -- "Your scimitar disappears in a puff of
//     smoke" -- taking with it an enchantment that cost 17 mana, 3 elderberry and an orc
//     tooth. "The fleet is armed" was TRUE at 00:10 and FALSE at 01:30 with nothing run.
//   * KEEPERS ROAM. A raid that believed it was setting out from the castle door began with
//     raiders in rooms 101 and 585, whose routes cross Ukgoth, a known trap room.
//   * KEEPERS RE-EQUIP. A weapon enchanted at one checkpoint was replaced in the hand by
//     another of the same name before the next, and the raid went in swinging mundane steel
//     at a boss that resists it by 90%.
//
// Every one of those is a postcondition that decayed on its own. A snapshot would have
// restored a memory of it and walked the fleet in believing a lie.
//
// ============================================================================
// THE FOUR RULES, EACH OF WHICH COST A SESSION TO LEARN
// ============================================================================
//
// 1. ALWAYS VERIFY AFTER ESTABLISHING, AND NEVER TRUST WHAT `establish` RETURNS. The worst
//    bug of that session was a verifier that decided a spell had landed because the mana and
//    the reagents were gone. `enchant weapon` charges up front and then holds a 30-second
//    trance that the keeper's own resting broke every time, so the cost was paid and nothing
//    landed -- three casts, three reported successes, zero enchanted weapons. An `establish`
//    that reports success is making the same claim the failed verifier made.
//
// 2. `holds` IS RE-EVALUATED EVERY TIME, AND ITS ANSWER IS NEVER CACHED. That is the entire
//    difference between this and a snapshot. It also means `holds` must be CHEAP.
//
// 3. UNKNOWN IS A THIRD ANSWER. `holds` may return null, and null is not false. The reason
//    is concrete: the server does not rename an enchanted weapon, so no prod-safe read can
//    say whether one is enchanted. Coerced to false it re-casts every pass and burns the
//    reagents; coerced to true it walks a fleet at a boss unarmed.
//
//    BUT UNKNOWN ONLY HAS TO REFUSE WHEN ESTABLISHING IS EXPENSIVE. That sharpening is the
//    FleetScratch session's, and it is right: if `establish` is free and idempotent, then an
//    unknown postcondition should simply be established, because doing so costs nothing and
//    answers the question authoritatively. Refusing there makes an operator type something to
//    no purpose, and an override nobody needs is an override nobody reads.
//
//    So a checkpoint declares the cost of its OWN establish, with the citation that makes the
//    claim checkable -- `establishCost: 'free'` is a claim about the game, not a preference,
//    and persench.kod:76 raising already-in-effect inside CanPayCosts, BEFORE the cost is
//    taken, is what backs it for every personal enchantment. `allowUnknown` then stays for the
//    genuinely expensive cases, which is where an operator should have to decide.
//
// 4. NEVER KEY A CHECKPOINT ON AN OBJECT ID. Ids recycle within hours: object 7605 stopped
//    being one character's scimitar and became another's short sword mid-session, and 7397
//    became a Lupogg. Checkpoints are expressed over CHARACTERS and PREDICATES.

/**
 * WHAT IT COSTS TO ESTABLISH THIS POSTCONDITION, which decides what an unknown answer does.
 *
 *   free         costs nothing when it turns out to be unnecessary, and is idempotent. The
 *                bar is high: "the game refuses it before taking payment" and not "it is
 *                quick". Declaring this REQUIRES a citation.
 *   cheap        costs something small and repeatable — a walk, a read, a few seconds.
 *   expensive    spends reagents, money, or a mana cycle.
 *   irreversible cannot be undone: a death, a sale, a cursed weapon wielded.
 *
 * Only `free` establishes on unknown. Everything else refuses and says so, which is where
 * `allowUnknown` earns its keep.
 */
export const ESTABLISH_COSTS = Object.freeze(['free', 'cheap', 'expensive', 'irreversible']);

/** `holds` may answer yes, no, or "I cannot tell" — and the third is not the second. */
export const HELD = 'held';
export const ESTABLISHED = 'established';
export const UNKNOWN = 'unknown';
export const FAILED = 'failed';
export const NO_ESTABLISH = 'no_way_to_establish';

/**
 * One checkpoint.
 *
 * `holds(ctx)`      -> true | false | null (null = cannot tell)
 * `establish(ctx)`  -> anything; its return is IGNORED on purpose. Rule 1.
 * `perishable`      -> documentation, and a hint to the report: this one decays on its own,
 *                      so holding it once says nothing about holding it later.
 */
export function checkpoint(name, { holds, establish = null, perishable = false,
                                   establishCost = 'expensive', cites = '',
                                   describe = '' } = {}) {
  if (typeof name !== 'string' || !name) throw new Error('a checkpoint needs a name');
  if (typeof holds !== 'function')
    throw new Error(`checkpoint "${name}" needs a holds() — a checkpoint with no ` +
                    'postcondition is a step, and steps are what we are trying not to replay');
  if (establish != null && typeof establish !== 'function')
    throw new Error(`checkpoint "${name}": establish must be a function or null`);
  if (!ESTABLISH_COSTS.includes(establishCost))
    throw new Error(`checkpoint "${name}": establishCost must be one of ` +
                    `${ESTABLISH_COSTS.join(', ')} — got ${JSON.stringify(establishCost)}`);
  // A FREE CLAIM NEEDS ITS CITATION. "Free" is the only cost that changes behaviour — it lets
  // an unknown postcondition be established without asking anybody — so it is the one that has
  // to be checkable. Unsupported, it is just an author being optimistic about their own code.
  if (establishCost === 'free' && !String(cites).trim())
    throw new Error(`checkpoint "${name}": establishCost 'free' needs a cites: — the kod or ` +
                    'code that makes it free. An unsupported claim of free is how an unknown ' +
                    'postcondition gets established for nothing in particular.');
  return Object.freeze({ name, holds, establish, perishable: !!perishable,
                         establishCost, cites, describe });
}

/** An ordered chain. Order matters: reaching one means reaching every earlier one. */
export function chain(...checkpoints) {
  const flat = checkpoints.flat();
  const seen = new Set();
  for (const c of flat) {
    if (!c?.name) throw new Error('chain() takes checkpoint() results');
    if (seen.has(c.name)) throw new Error(`duplicate checkpoint "${c.name}"`);
    seen.add(c.name);
  }
  return Object.freeze(flat);
}

const outcomeOf = async (cp, ctx, { allowUnknown, dryRun }) => {
  let before;
  try { before = await cp.holds(ctx); }
  catch (e) { return { outcome: FAILED, why: `holds() threw: ${e.message}` }; }

  if (before === true) return { outcome: HELD, why: 'already true' };
  // UNKNOWN ESTABLISHES ONLY WHEN ESTABLISHING IS FREE. Free means the game refuses it before
  // taking payment, so asking when the answer is already yes costs nothing — which makes the
  // cast itself a better answer than the read that could not tell.
  const freeToAsk = cp.establishCost === 'free' && !!cp.establish;
  if (before === null && !allowUnknown && !freeToAsk)
    return { outcome: UNKNOWN,
             why: `holds() could not tell, and unknown is not false. Establishing this is ` +
                  `${cp.establishCost}, so it is not done on a guess — pass allowUnknown to ` +
                  'establish anyway, or answer it another way' };

  if (!cp.establish)
    return { outcome: NO_ESTABLISH,
             why: before === null ? 'holds() could not tell and there is no establish()'
                                  : 'does not hold and there is no establish()' };
  if (dryRun)
    return { outcome: ESTABLISHED, dry: true,
             why: before === null ? 'would establish (currently unknown)' : 'would establish' };

  try { await cp.establish(ctx); }
  catch (e) { return { outcome: FAILED, why: `establish() threw: ${e.message}` }; }

  // RULE 1. The whole point: ask the world again rather than believe establish().
  let after;
  try { after = await cp.holds(ctx); }
  catch (e) { return { outcome: FAILED, why: `holds() threw after establish: ${e.message}` }; }
  if (after === true) return { outcome: ESTABLISHED, why: 'established and verified' };
  if (after === null)
    return { outcome: UNKNOWN,
             why: 'establish() ran and holds() still cannot tell — nothing here can say ' +
                  'whether it worked, so it is reported rather than assumed' };
  return { outcome: FAILED, why: 'establish() ran and the postcondition is still false' };
};

/**
 * Reach `name`: for each checkpoint up to and including it, hold it or establish it.
 *
 * STOPS AT THE FIRST ONE IT CANNOT REACH, and says which. A partial skip that carried on
 * would put the fleet at a later step with an earlier postcondition missing, which is the
 * single most expensive way for this to be wrong — it is how a raid walks into a boss room
 * believing it is armed.
 */
export async function reach(cps, name, ctx = {}, { allowUnknown = false, dryRun = false,
                                                   onStep = null } = {}) {
  const list = Array.isArray(cps) ? cps : chain(cps);
  const idx = list.findIndex(c => c.name === name);
  if (idx < 0)
    return { reached: false, at: null, steps: [],
             why: `no checkpoint called "${name}" — this chain has: ${list.map(c => c.name).join(', ')}` };

  const steps = [];
  for (const cp of list.slice(0, idx + 1)) {
    const r = await outcomeOf(cp, ctx, { allowUnknown, dryRun });
    const row = { name: cp.name, perishable: cp.perishable, ...r };
    steps.push(row);
    onStep?.(row);
    if (r.outcome === FAILED || r.outcome === UNKNOWN || r.outcome === NO_ESTABLISH)
      return { reached: false, at: cp.name, steps,
               why: `stopped at "${cp.name}": ${r.why}` };
  }
  return { reached: true, at: name, steps };
}

/**
 * Run the chain forward from wherever it already is, stopping BEFORE `name`.
 * `runUntil(chain, 'action')` is "get everything ready and then stop", which is the shape
 * of every rehearsal: prepare fully, look at it, and decide whether to commit.
 */
export async function runUntil(cps, name, ctx = {}, opts = {}) {
  const list = Array.isArray(cps) ? cps : chain(cps);
  const idx = list.findIndex(c => c.name === name);
  if (idx < 0)
    return { reached: false, at: null, steps: [],
             why: `no checkpoint called "${name}" — this chain has: ${list.map(c => c.name).join(', ')}` };
  if (idx === 0) return { reached: true, at: null, steps: [], why: `"${name}" is first; nothing to do` };
  return reach(list.slice(0, idx), list[idx - 1].name, ctx, opts);
}

/** What a chain says about itself right now, without establishing anything. */
export async function survey(cps, ctx = {}) {
  const list = Array.isArray(cps) ? cps : chain(cps);
  const rows = [];
  for (const cp of list) {
    let h;
    try { h = await cp.holds(ctx); }
    catch (e) { rows.push({ name: cp.name, state: FAILED, why: e.message }); continue; }
    rows.push({ name: cp.name, perishable: cp.perishable,
                state: h === true ? HELD : h === null ? UNKNOWN : 'not yet',
                can_establish: !!cp.establish, establish_cost: cp.establishCost,
                cites: cp.cites, describe: cp.describe });
  }
  return rows;
}

export function report(result) {
  const out = [];
  out.push(result.reached ? `REACHED ${result.at}` : `DID NOT REACH: ${result.why}`);
  out.push('');
  for (const s of result.steps ?? []) {
    const mark = s.outcome === HELD ? 'held      '
      : s.outcome === ESTABLISHED ? (s.dry ? 'would do  ' : 'established')
      : s.outcome === UNKNOWN ? 'UNKNOWN   ' : 'FAILED    ';
    out.push(`  ${mark} ${String(s.name).padEnd(18)} ${s.perishable ? '(perishable) ' : ''}${s.why ?? ''}`);
  }
  if (!result.reached)
    out.push('', 'Nothing after the stopping point was attempted — a partial skip would put the ' +
                 'fleet at a later step with an earlier postcondition missing.');
  return out.join('\n');
}
