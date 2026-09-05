// A FLEET ERRAND, DECLARED — AND THE SAFETIES COMPILED IN RATHER THAN REMEMBERED.
//
//   import { fleetScript, walk, bank, shop, verify } from './m59-fleetscript.mjs';
//
//   await fleetScript({
//     name: 'bulk resupply',
//     agents: ['t16', 't20'],
//     steps: [ walk(54), bank('withdraw', ({ need }) => need), walk(53),
//              shop('Frisconar', [{ match: /herb/, amount: 150 }]), walk(39) ],
//   });
//
// WHY THIS EXISTS. Over one day, five separate ad-hoc scripts drove this fleet, and each one
// re-implemented the same handful of concerns and got a DIFFERENT subset of them wrong:
//
//   * no run lock, so three processes drove the same characters at once and every collision
//     surfaced as "movement cancelled by a newer command" — the sentence a genuine survival
//     interrupt produces, which is what made it expensive to find;
//   * no `busy`, so the keeper cancelled a walk home for its own town errand and the
//     character carrying the fleet's entire reagent stock wandered into Barloque;
//   * a fixed ten-second wait against journeys whose p90 is 317-740 seconds, reported as
//     "could not reach any of 373, 53, 104" — indistinguishable from there being no shop;
//   * re-issuing `travel` while the character was still walking, which the keeper refuses,
//     so every retry made it worse;
//   * a fixed sleep rather than a poll, so a courier that arrived in ninety seconds sat out
//     the remaining five minutes and one that died was watched for five minutes as a corpse;
//   * no health gate, so a recall walked a character out of the inn it was healing in at
//     1 of 44 health, straight back down the road that had just killed it;
//   * trusting the purchase call instead of reading the pack, when a handshake that moves
//     nothing is the commonest failure at a counter;
//   * and a `finally` that never ran because the process was force-killed, leaving six
//     characters stuck "driven" — which made the patrol re-send orders every pass for ever.
//
// None of those are interesting. All of them are mandatory. So they stop being the author's
// problem: a script DECLARES what it wants done and this compiles the guarantees around it.
//
// THE GUARANTEES, and none of them is optional:
//
//   1. ONE DRIVER PER FLEET. Takes the m59-runlock claim, refuses with the holder's pid,
//      label, age and argv, exits 3. Parallelism lives INSIDE one locked run, because what
//      contends is two drivers on the same character, not two characters.
//   2. THE BODY IS HELD. Every agent is marked `busy` for the whole errand and freed in a
//      finally AND on signals AND on uncaught exceptions — the three ways today's scripts
//      leaked a stuck character.
//   3. A JOURNEY HAS A HEALTH FLOOR. No walk begins below `minHealth` (default 1 — full),
//      matching the harness's own travel_start_health. Unknown health is not permission.
//   4. WAITS ARE THE JOURNEY'S OWN LENGTH. Budgets come from travel_estimate p90, polled,
//      exiting the moment the character arrives or dies. Never a fixed sleep.
//   5. TRAVEL IS ASYNCHRONOUS. Issued once per attempt and never re-issued while the
//      character is still walking.
//   6. RESULTS ARE READ BACK. A step may declare `verify`, and the recorded outcome is what
//      the world says afterwards, not what the call claimed.
//   7. THE BOT'S LEASE IS TAKEN, AND THE JOURNEY IN FLIGHT IS CANCELLED. `busy` is
//      broker-side and does not stop the process holding the socket, and a bot re-decides
//      about every thirty seconds — so every agent's work, movement and economy are leased
//      off the keeper for the errand and heartbeaten, while identity, mortality, survival
//      and recovery stay where they belong. Then the journey already running is cancelled,
//      because a claim takes the faculties and not the body. See `holdKeeper`.
//   8. A ROOM WE KNOW TRAPS CHARACTERS IS REFUSED BEFORE ANYTHING WALKS. Some rooms cannot
//      be left by any route the bake knows — because leaving needs an item, a spoken word or
//      a mechanic no collision map models. Walking into one is unrecoverable without an
//      operator. `KNOWN_TRAPS` names them with the reason; see `trapCheck`.
//
// EVERY ONE OF THOSE IS A MISTAKE SOMEBODY MADE TWICE. That is the entry criterion, and the
// reason to reach for this file rather than write a script: when a trap gets written down in
// CLAUDE.md it still has to be REMEMBERED, and the record of this fleet is that it is not.
// So when a fleet operation goes wrong for a reason a rule already covered, the fix is a
// guarantee in here that refuses before anything walks — not another paragraph.
//
// A step that fails ends THAT AGENT's errand and no other's. One courier dying is not the
// operation failing, which is the difference between a fleet tool and a script.
import { takeRunLock } from './m59-runlock.mjs';
import { fleetName } from './m59-fleetpath.mjs';

const RPC = () => process.env.M59_CONTROL_URL || 'http://127.0.0.1:8901/';
let seq = 0;

/** One broker call. Kept private so a step cannot bypass the pacing or the timeout. */
async function call(name, args = {}, ms = 180_000) {
  const r = await fetch(RPC(), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call',
                           params: { name, arguments: args } }),
    signal: AbortSignal.timeout(ms),
  });
  const d = await r.json();
  try { return JSON.parse(d.result.content[0].text); } catch { return d.result?.content?.[0]?.text ?? d; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- reading a character
//
// One place that knows how to ask "where is it, how hurt is it, is it dead". Every script
// today wrote its own and they disagreed: one read `st.room.id` (which does not exist), one
// trusted the fleet board's `activity: idle` for characters that were demonstrably walking.
/**
 * WHAT THIS CHARACTER CAN ACTUALLY SPEND, read off the pack because that is where money is.
 * Callers that already hold an inventory should sum it themselves rather than call this —
 * it costs a round trip, so it does not belong in a poll loop.
 */
export function purseOf(items = []) {
  return (items || []).filter(i => /shilling/i.test(i.name || ''))
                      .reduce((n, i) => n + (i.amount || 1), 0);
}

export async function observe(agent) {
  const s = await call('status', { agent }, 40_000).catch(() => null);
  const hp = s?.hp && Number.isFinite(s.hp.value) && s.hp.max > 0 ? s.hp.value / s.hp.max : null;
  const roomName = s?.where?.name ?? s?.room?.name ?? '';
  return {
    ok: Boolean(s),
    room: s?.where?.num ?? s?.room?.num ?? null,
    roomName,
    // NULL IS NOT ZERO, AND ON THIS BROKER `status.gold` IS ALWAYS NULL. The money is not a
    // scalar on the character — it is a `shilling` stack in the pack, which is why the fleet
    // row builds `purse` by summing the inventory. `Number(null ?? 0)` turned "I do not know"
    // into a confident 0, and the resupply script then computed `withdraw = bill - 0` and
    // asked the banker for the full 5,540 on behalf of a courier already carrying it. A
    // banker refusal is a SENTENCE, so that ends the errand at the counter and the courier
    // walks home with nothing — the exact failure the operator was complaining about, just
    // relocated from Barloque to Tos. Callers that need the money read the pack; see
    // `purse()`. Reported by a peer session, 2026-09-03.
    // `Number(null)` is 0 and 0 is finite, so an isFinite guard alone lets the exact value
    // it was written to catch straight through. The null has to be tested first.
    gold: s?.gold == null || !Number.isFinite(Number(s.gold)) ? null : Number(s.gold),
    health: hp,
    hpText: s?.hp ? `${s.hp.value}/${s.hp.max}` : '?',
    // A character in the Underworld is dead however its hit points read on the way in.
    dead: s?.hp?.value === 0 || /underworld/i.test(roomName),
    busy: s?.busy ?? null,
  };
}

/** What the character is carrying. Separate from observe() because a pack read is a second
 *  call and most steps do not need one — but a script that ROUTES by cargo does, and it must
 *  ask before the plan is built rather than discovering it at the counter. */
export async function pack(agent) {
  const inv = await call('inventory', { agent }, 60_000).catch(() => ({ items: [] }));
  return inv.items ?? [];
}

// ---------------------------------------------------------------- rooms that keep characters
//
// A COLLISION MAP CANNOT SEE A LOCK. Every trap here is a room our geometry says is fine and
// the game does not, so no amount of routing work finds them — they are learned by stranding
// somebody, and the only way they stop costing us is by being written down where the code
// reads them rather than where a person has to remember them.
//
// Keyed by room number; the value is what an operator needs to hear.
export const KNOWN_TRAPS = Object.freeze({
  // 2026-09-04: three characters spent hours shuffling two squares here on the castle
  // patrol's route. The baked map offers three ways out (south 589, east 598, north 2 to
  // Outside Castle Victoria) and a region flood from their square says all three are
  // reachable. Their own keepers reported ONE — `exits: [{to: 589, direction: "south"}]` —
  // and the operator's word is that going back up needs a Relic of Qor and a spoken phrase.
  // So the north exit our router kept planning through does not exist for us, and a walk
  // aimed at it never ends.
  599: 'Ukgoth, Holy Land of Trolls — leaving northward to Castle Victoria needs a Relic of ' +
       'Qor and a spoken phrase. The baked map offers three exits and only the SOUTH one ' +
       '(to 589) is real for us; a plan through the north exit walks for ever.',
});

/**
 * Refuse a plan that walks into a room we know keeps characters, and say so about a
 * character already standing in one.
 *
 * Returns `null` when the plan is fine, or the sentence to refuse it with. `allowTraps`
 * exists for the errand that is deliberately going in to fetch somebody out — it has to be
 * written down at the call site, because "I know about the trap" and "I forgot" otherwise
 * produce the same script.
 */
export function trapCheck(plan = [], { standingIn = null, allowTraps = false } = {}) {
  if (allowTraps) return null;
  const into = plan.find(s => s?.do === 'walk' && KNOWN_TRAPS[Number(s.to)]);
  if (into) return `walks to room ${into.to} — ${KNOWN_TRAPS[Number(into.to)]} ` +
                   `Pass { allowTraps: true } if this errand is the rescue.`;
  const here = Number(standingIn);
  if (KNOWN_TRAPS[here] && plan.some(s => s?.do === 'walk'))
    return `is standing in room ${here} — ${KNOWN_TRAPS[here]} ` +
           `Get it out first; an errand started from here will not finish.`;
  return null;
}

// ---------------------------------------------------------------- the step vocabulary

export const walk = (to, opts = {}) => ({ do: 'walk', to, ...opts });
export const bank = (action, amount, opts = {}) => ({ do: 'bank', action, amount, ...opts });
export const shop = (seller, lines, opts = {}) => ({ do: 'shop', seller, lines, ...opts });
// SELL BEFORE YOU BUY. A character leaving a farm room is carrying the loot it earned
// there, the town it is walking to is where that loot is worth money, and the money is
// what pays for the reagents — so the sale is free: no extra journey, no extra room.
// `keep` holds back what the errand still needs (its reagents above all, which several
// merchants will happily buy back off you).
// WHAT MUST SURVIVE A SELL_ALL, whatever else goes.
//
// `sell_all` offers the merchant everything it will take, so anything worth keeping has to be
// named before the counter, not after. This is the floor under every sell step: the reagents
// the errand exists to fetch, the food that gets a character home, and the loot that is worth
// more in a vault than in a purse. A script may add to it and may not silently drop it.
//
// Read off the Castle Victoria loot survey: wands and scrolls have their spoil timer disabled
// (piGoBadTime = -1), so they keep for ever; the ring of invisibility only spends charges
// while worn; gems stack and cost one shilling a point to vault. The temporary attributes —
// shrouded, enchanted, glowing, holy/unholy/fiery/icy/shock/acid — are deliberately NOT here:
// they expire on a 1-24h timer that keeps running in the vault, so they are worth selling.
export const VAULT_KEEP = Object.freeze([
  'herb', 'elderberry', 'inky', 'flask',
  'wand', 'scroll', 'rose', 'ring of invisibility', 'mystic sword', 'true lute',
  'dragon scale', 'angel feather', 'shrunken head',
  'emerald', 'sapphire', 'diamond', 'ruby',
]);

// `{ noVault: true }` acknowledges that this trip cannot or will not vault, and is
// REQUIRED when no vault() precedes the sell — see the plan check in fleetScript.
export const sell = (merchant, opts = {}) => ({ do: 'sell', merchant, ...opts });

// PUT THE KEEPERS SOMEWHERE THEY CANNOT BE SOLD OR DROPPED ON DEATH. Vaults are in Barloque
// and Ko'catan only, so a trip that does not pass one CANNOT vault — which is exactly why the
// keep list above is the real protection and this step is the bonus. Everything a character
// dies holding is on the floor where it fell; a vault is the only thing that is not.
export const vault = (vaultman, items = VAULT_KEEP, opts = {}) =>
  ({ do: 'vault', vaultman, items, ...opts });
export const act = (tool, args, opts = {}) => ({ do: 'act', tool, args, ...opts });
export const verify = (fn, why) => ({ do: 'verify', fn, why });

// ---------------------------------------------------------------- healing before a journey
//
// A HURT CHARACTER IS NOT DISQUALIFIED, IT IS EARLY. The first version refused anything
// below the floor, which turned a 2.5% shortfall into a cancelled errand: Rizzo was turned
// away from a shopping trip at 39 of 40. The floor is right — the harness's own
// travel_start_health defaults to full, because an inn or a safe wall heals for free and
// the road does not — but the answer to being below it is to WAIT, not to give up.
//
// AND THE KEEPER DOES THE HEALING, NOT THIS. That is the part worth being careful about:
// `busy` makes the keeper INERT on purpose, so a script that sits and rests while holding
// the body is resting with the survival ladder switched off, in a room that may generate
// monsters. The keeper already knows how to find a wall nothing can reach, sit behind it,
// and stand up again — it is the one-second clock's whole job. So the body is HANDED BACK
// for the duration and re-claimed once it is well.
//
// The cost of handing it back is that something else may move the character meanwhile;
// that is fine and is why the walk re-observes afterwards rather than assuming.
async function healToFloor(ctx, agent, floor, budgetMs) {
  const at0 = await observe(agent);
  if (at0.dead) return { ok: false, why: 'dead' };
  ctx.log(agent, `at ${at0.hpText}, below the ${floor} floor — handing back to the keeper to heal`);

  // Give the body back so the survival ladder and the safe-wall book are live again.
  await call('autopilot', { agent, action: 'free' }, 30_000).catch(() => {});
  await call('autopilot', { agent, action: 'revive' }, 30_000).catch(() => {});

  const until = Date.now() + budgetMs;
  let best = at0.health ?? 0, stalledSince = Date.now();
  try {
    while (Date.now() < until) {
      await sleep(ctx.pollMs);
      const now = await observe(agent);
      if (now.dead) return { ok: false, why: 'died while healing' };
      if (now.health != null && now.health >= floor) {
        ctx.log(agent, `healed to ${now.hpText} — setting out`);
        return { ok: true };
      }
      // NOT IMPROVING IS ITS OWN ANSWER. Some rooms prevent rest, and a character at its
      // ceiling is not going to get better by being watched; either is worth reporting
      // rather than burning the whole budget in silence.
      if (now.health != null && now.health > best + 0.01) { best = now.health; stalledSince = Date.now(); }
      else if (Date.now() - stalledSince > Math.min(120_000, budgetMs / 2))
        return { ok: false, why: `health stopped improving at ${now.hpText} (floor ${floor})` };
    }
    const end = await observe(agent);
    return { ok: false, why: `did not reach the floor in ${Math.round(budgetMs / 1000)}s ` +
                            `(${end.hpText}, floor ${floor})` };
  } finally {
    // Take it back either way: the caller still owns this errand and an unheld body is one
    // the patrol will re-task out from under the next step.
    await call('autopilot', { agent, action: 'busy', kind: 'fleetscript',
      label: ctx.name }, 30_000).catch(() => {});
  }
}

// ---------------------------------------------------------------- the compiled walk
//
// Rules 3, 4 and 5 live here together because they are one behaviour: do not set out hurt,
// wait the road's own length, and do not shout at a character that is already walking.
async function compiledWalk(ctx, agent, to, { minHealth }) {
  // A WALK TO A NON-ROOM IS A REFUSAL, NOT A JOURNEY.
  //
  // Logged live on 2026-09-03: `t11 walking 53 -> null, budget 490s`. A destination that is
  // not a room number cannot be reached, cannot be planned, and — because this is the step
  // that brings a courier home, and that step is `always` — burns the entire budget doing
  // nothing at the end of an errand that has already been paid for. Whatever produced the
  // null (I could not reproduce it from the current script; `home` resolves to 39 through
  // both the dry and the live path), a compiled plan holding one should say so at once
  // instead of asking the mover to walk to it.
  if (to == null || !Number.isFinite(Number(to)))
    return { ok: false, why: `the plan asked for a walk to ${JSON.stringify(to)}, ` +
                             'which is not a room number' };
  for (let attempt = 0; attempt < 3; attempt++) {
    const at = await observe(agent);
    if (!at.ok) return { ok: false, why: 'could not read the character' };
    if (at.room === to) return { ok: true, room: to };
    if (at.dead) return { ok: false, why: 'died', dead: true };
    if (at.health == null)
      // UNKNOWN IS STILL NOT PERMISSION, and it is not something resting fixes: a health we
      // cannot read usually means the keeper is not answering at all, which is exactly when
      // a journey must not start. This caught a character whose keeper process had died.
      return { ok: false, why: 'health is unreadable — not setting out', hurt: true };
    if (at.health < minHealth) {
      const healed = await healToFloor(ctx, agent, minHealth, ctx.healMs);
      if (!healed.ok) return { ok: false, why: `could not reach the health floor: ${healed.why}`,
                               hurt: true, dead: /died|dead/.test(healed.why) };
      continue;   // re-observe: it may have been moved while the keeper held it
    }

    const est = await call('travel_estimate', { from: at.room, to, basis: 'p90' }, 30_000)
      .catch(() => null);
    const budget = Math.min(ctx.budgetCapMs,
      Math.max(ctx.budgetFloorMs, (Number(est?.ms) || 400_000) + 90_000));
    ctx.log(agent, `walking ${at.room} -> ${to}, budget ${Math.round(budget / 1000)}s`);
    await call('travel', { agent, to, background: true, run_errands: false }, 60_000).catch(() => ({}));

    const until = Date.now() + budget;
    while (Date.now() < until) {
      await sleep(ctx.pollMs);
      const now = await observe(agent);
      if (now.room === to) return { ok: true, room: to };
      if (now.dead) return { ok: false, why: 'died en route', dead: true };
    }
  }
  return { ok: false, why: `did not reach ${to} in three attempts` };
}

/**
 * DEATH LOSES THE CARGO, NOT THE ERRAND.
 *
 * Operator correction, 2026-09-03: "death interrupts the selling portion, but technically for
 * our purposes you can still go to Tos, buy the reagents (using banked funds) and return to
 * Castle Victoria." That is right, and my first version was wrong — it ended the whole trip,
 * which throws away a journey that is still most of the way to being worth making. What death
 * actually destroys is the PACK: the loot is on the floor where it fell, and so is the purse.
 * The bank balance is untouched, and the bank is the point of the bank.
 *
 * So the body is handed back so the keeper's recovery faculty can get it out of the Underworld
 * on its own one-second clock — that decision is never ours — and this waits for it to come
 * back alive, then re-claims it and reports the purse that survived, which is normally zero.
 */
// ---------------------------------------------------------------- holding a KEEPER, not a shell
//
// `busy` DOES NOT STOP THE KEEPER DRIVING. It was never meant to: it says "an operation is in
// flight" so the fleet's stall detectors step over the character, and on a keeper-backed broker
// it is set on the broker's own shell object, which is not the thing holding the socket. The
// keeper's `/state` has no busy field at all.
//
// So for most of 2026-09-02 this runner and twenty-one keepers were steering the same bodies.
// A peer session measured it: t12 reached the Tos bank at 06:41:49, its own confine (roam:false,
// home 39) walked it back toward Castle Victoria, and the runner re-issued the walk from room 38
// — a second crossing of the killing ground for nothing. t11 went nowhere in twelve minutes
// because its keeper was homing while the runner believed it was walking to 54. And the keeper's
// economy stayed live throughout, banking t12's purse from 5,602 down to walking_money 1,000 the
// moment it stood next to a teller, which is why the errand's own withdrawal arithmetic kept
// coming out wrong.
//
// THE FIX IS NOT `stop`. `Autopilot.stop()` without `hard` calls `goInert`, which puts out the
// survival ladder — and walking an inert character across these roads is exactly what killed
// Cccc on 2026-08-21. An errand may do that inside a town; a journey across the Cragged
// Mountains may not.
//
// What reaches the real driver AND leaves the ladder armed is the faculty lease the keeper
// process exposes itself: `commander_claim` takes work, movement and economy and leaves the four
// protected ones — identity, mortality, survival, recovery — with the keeper, which is the
// boundary this repository is built around. The keeper caps the lease at 30s, so it has to be
// heartbeaten; that cap is the point, because a runner that dies stops beating and the character
// is its keeper's again within half a minute.
const KEEPER_FACULTIES = Object.freeze(['work', 'movement', 'economy']);
const KEEPER_LEASE_MS = 30_000;        // the keeper's own ceiling; asking for more is clamped
const KEEPER_BEAT_MS = 10_000;

let keeperPortsPromise = null;
/**
 * Which port is whose. SCANNED, never computed: a keeper can be re-allocated off its default
 * slot, and a broker that guesses a port and commands whoever answers is a failure this
 * repository has already paid for. Every keeper names itself on `/live`, and the write path
 * refuses an order addressed to a different agent, so a wrong guess is refused rather than obeyed.
 */
async function keeperPorts(fleet) {
  if (keeperPortsPromise) return keeperPortsPromise;
  keeperPortsPromise = (async () => {
    const found = new Map();
    let band;
    try {
      const mod = await import('./runtime/keeper-bands.mjs');
      band = mod.lookupKeeperBand(fleet);
    } catch { return found; }
    if (!band) return found;
    const probes = [];
    for (let port = band.base; port <= band.end; port++)
      probes.push(fetch(`http://127.0.0.1:${port}/live`, { signal: AbortSignal.timeout(700) })
        .then(r => r.ok ? r.json() : null)
        // THE WHOLE IDENTITY TUPLE, because a write must carry all three. `addressedToUs`
        // requires agent AND character AND the keeper's own pid, and supplying only the agent
        // fails the check with the memorable message `this keeper is "t13", not "t13"` — every
        // part must be present before any part is compared. `/live` hands over all three,
        // which is exactly why it is exempt from the addressing rule it enforces.
        .then(v => { if (v?.agent) found.set(String(v.agent),
          { port, character: v.character, pid: v.pid }); })
        .catch(() => {}));
    await Promise.all(probes);
    return found;
  })();
  return keeperPortsPromise;
}

async function keeperCall(who, name, args) {
  const r = await fetch(`http://127.0.0.1:${who.port}/action`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    // All three identity parts at the TOP level. The keeper checks the order is addressed to
    // it before it will even say whether the character is logged in, and a partial address is
    // refused rather than half-honoured.
    body: JSON.stringify({ name, agent: who.agent, character: who.character,
                           keeper_pid: who.pid, args }),
    signal: AbortSignal.timeout(20_000),
  });
  return r.json().catch(() => ({}));
}

/**
 * Take work, movement and economy off the keeper for the duration and keep them. Returns a
 * release function that is safe to call twice.
 */
export async function holdKeeper(ctx, agent, fleet) {
  const ports = await keeperPorts(fleet);
  const entry = ports.get(agent);
  const who = entry && { ...entry, agent };
  if (!who) {
    // NOT FATAL AND NOT SILENT. A broker-run session has no keeper process to lease from, and
    // the broker-side claim is then the whole story. Saying so matters because the difference
    // between "held" and "believed held" is the bug this whole block exists to close.
    ctx.log(agent, 'no keeper process answered on this fleet band — running against the ' +
                   'broker shell alone, so the keeper cannot be steering');
    return { ok: false, cancelJourney: async () => {}, release: async () => {} };
  }
  const claim = await keeperCall(who, 'commander_claim', {
    faculties: KEEPER_FACULTIES, by: `fleetscript:${ctx.name}`,
    lease_ms: KEEPER_LEASE_MS, why: `fleet errand: ${ctx.name}`,
  });
  const got = Object.keys(claim?.faculties ?? {}).filter(f => KEEPER_FACULTIES.includes(f));
  if (claim?.error || !got.length) {
    ctx.log(agent, `the keeper would not yield work/movement/economy: ${claim?.error ?? 'refused'}`);
    return { ok: false, cancelJourney: async () => {}, release: async () => {} };
  }
  ctx.log(agent, `holding ${got.join(', ')} on keeper :${who.port} — survival stays with the keeper`);

  // AND THE JOURNEY THAT IS ALREADY IN FLIGHT, WHICH THE CLAIM DOES NOT TOUCH.
  //
  // Taking the faculties is not taking the body. A `travelJob` started before we arrived
  // keeps running — it is a JOB, not a faculty — and every travel this errand issues then
  // comes back `"<agent> is busy: walk to Upstairs in Castle Victoria"`. The claim reports
  // full success while it happens, so it reads as a working hold that is being ignored.
  //
  // Measured on prod, 2026-09-04: three characters stranded in Ukgoth, claim granting
  // movement/work/economy every eight seconds for six minutes, and all three still walking
  // the castle patrol's route — `commander_claim` answered
  // `social: {owner: "inert:travelling to Upstairs in Castle Victoria"}`, which is the only
  // place the in-flight journey was visible at all. Adding this one call was the difference
  // between "refused: is busy" on every round and all three accepting the new destination.
  //
  // `/cancel` and not `release`: release ends the job slot AND hands the faculties back,
  // which would undo the claim we just took. This only bumps the movement generation, which
  // is what ends the walk.
  const cancelled = await fetch(`http://127.0.0.1:${who.port}/cancel`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: who.agent, character: who.character, keeper_pid: who.pid }),
    signal: AbortSignal.timeout(20_000),
  }).then(r => r.json()).catch(e => ({ error: e.message }));
  if (cancelled?.error) ctx.log(agent, `could not clear the journey in flight: ${cancelled.error}`);

  const beat = setInterval(() => {
    keeperCall(who, 'commander_heartbeat',
      { by: `fleetscript:${ctx.name}`, lease_ms: KEEPER_LEASE_MS }).catch(() => {});
  }, KEEPER_BEAT_MS);
  beat.unref?.();
  let done = false;
  return {
    ok: true,
    /**
     * STOP THE WALK WE STARTED. A runner that exits does not cancel the journey it issued:
     * `travelJob` lives in the KEEPER, so killing the runner leaves a character walking a
     * route nobody is watching any more. t10 died in the Cragged Mountains at 06:50:16Z on
     * 2026-09-03, one minute after its wave was killed, still carrying out the last travel
     * the dead runner had asked for. A stopped wave was not a stopped wave.
     *
     * The keeper's own `release` ends the job slot and the keeper hold, which is the one
     * definition of both — so this is the cancel, and it has to happen before the faculties
     * go back or the keeper inherits a journey it never chose.
     */
    cancelJourney: async why => {
      const r = await keeperCall(who, 'release', { why: why ?? 'the errand ended' })
        .catch(e => ({ error: e.message }));
      if (r?.error) ctx.log(agent, `could not cancel the journey: ${r.error}`);
      return r;
    },
    release: async () => {
      if (done) return;
      done = true;
      clearInterval(beat);
      await keeperCall(who, 'commander_release',
        { faculties: KEEPER_FACULTIES, by: `fleetscript:${ctx.name}` }).catch(() => {});
      ctx.log(agent, 'gave work, movement and economy back to the keeper');
    },
  };
}

async function recoverFromDeath(ctx, agent, budgetMs) {
  await call('autopilot', { agent, action: 'free' }, 30_000).catch(() => {});
  await call('autopilot', { agent, action: 'revive' }, 30_000).catch(() => {});
  const until = Date.now() + budgetMs;
  try {
    while (Date.now() < until) {
      await sleep(ctx.pollMs);
      const now = await observe(agent);
      if (!now.ok || now.dead) continue;
      const inv = await call('inventory', { agent }, 40_000).catch(() => ({ items: [] }));
      const purse = purseOf(inv.items || []);
      ctx.log(agent, `back on its feet in ${now.roomName || 'room ' + now.room} at ${now.hpText}` +
                     ` with ${purse}sh — the loot is gone, the bank is not`);
      return { ok: true, purse };
    }
    return { ok: false, why: `did not come back within ${Math.round(budgetMs / 1000)}s` };
  } finally {
    await call('autopilot', { agent, action: 'busy', kind: 'fleetscript',
      label: ctx.name }, 30_000).catch(() => {});
  }
}

async function runStep(ctx, agent, step, state) {
  switch (step.do) {
    case 'walk':
      return compiledWalk(ctx, agent, step.to, { minHealth: step.minHealth ?? ctx.minHealth });

    case 'bank': {
      const amount = typeof step.amount === 'function' ? step.amount(state) : step.amount;
      if (!(amount > 0)) return { ok: true, skipped: 'nothing to move' };
      const ask = async n => {
        const r = await call('bank', { agent, action: step.action, amount: n }, 60_000)
          .catch(e => ({ error: e.message }));
        // The banker answers in PROSE and a refusal is a sentence, not an error.
        const said = String(r?.banker_said ?? r?.error ?? '');
        return { said, refused: /can't|cannot|only have|no /i.test(said) };
      };
      let out = await ask(amount);
      // THE REFUSAL NAMES THE ANSWER — TAKE IT.
      //
      // "But you only have 5313 shillings in your account!" is not a wall, it is a quote. On
      // 2026-09-03 t11 asked for 5,540 against a balance of 5,313, the step was skipped as
      // optional, and it walked to the apothecary with an empty purse and bought nothing —
      // 227 shillings short of a trip that had already cost a death. Withdrawing what the
      // banker just said is there turns a wasted journey into a full load.
      const named = out.refused && /withdraw/i.test(String(step.action))
        ? out.said.match(/only have\s+([\d,]+)\s+shilling/i) : null;
      if (named) {
        const affordable = Number(named[1].replace(/,/g, ''));
        if (Number.isFinite(affordable) && affordable > 0) {
          ctx.log(agent, `the banker refused ${amount} and named ${affordable} — taking that`);
          const retry = await ask(affordable);
          if (!retry.refused)
            return { ok: true, said: retry.said.slice(0, 120), amount: affordable,
                     asked: amount, note: 'withdrew the balance the banker named' };
          out = retry;
        }
      }
      return { ok: !out.refused, said: out.said.slice(0, 120), amount,
               why: out.refused ? `banker refused: ${out.said.slice(0, 80)}` : undefined };
    }

    case 'shop': {
      const list = await call('shop', { agent, seller: step.seller }, 60_000).catch(() => null);
      const items = list?.items || [];
      const buy = [];
      for (const line of step.lines) {
        const row = items.find(i => line.match.test(i.name || ''));
        if (!row) return { ok: false, why: `${step.seller} has no row matching ${line.match}` };
        buy.push({ id: row.id, amount: line.amount });
      }
      const before = await inventoryCounts(agent, step.lines);
      const r = await call('shop', { agent, seller: step.seller, buy_ids: buy }, 600_000)
        .catch(e => ({ error: e.message }));
      // THE PACK ARRIVES ON AN EVENT, SO THE READ RIGHT AFTER THE COUNTER IS A READ OF THE
      // PAST. t12 bought 116 elderberry and 116 herbs at Frisconar's on 2026-09-03 and this
      // step reported "nothing entered the pack" two seconds later; the keeper's own state a
      // minute on showed the whole load aboard. A false negative here is worse than a slow
      // step: it unwinds a successful errand and tells an operator the supply run is broken
      // when the reagents are already in the character's hands.
      //
      // So wait for the evidence rather than for a fixed delay — first read that shows a gain
      // wins, and the timeout is only reached when nothing is ever coming.
      let after = before;
      const until = Date.now() + (ctx.packSettleMs ?? 15_000);
      while (Date.now() < until) {
        after = await inventoryCounts(agent, step.lines);
        if (after.some((n, i) => n > before[i])) break;
        await sleep(Math.min(1500, ctx.pollMs));
      }
      // RULE 6. What is in the pack now, minus what was there before. A merchant that
      // completes the handshake and hands over nothing looks like success on the wire.
      const gained = step.lines.map((l, i) => ({ match: String(l.match), got: after[i] - before[i],
                                                 asked: l.amount }));
      const anything = gained.some(g => g.got > 0);
      return { ok: anything, gained, note: r?.note ?? r?.error,
               why: anything ? undefined : 'nothing entered the pack' };
    }

    case 'sell': {
      const before = await call('inventory', { agent }, 60_000).catch(() => ({ items: [] }));
      const purse0 = (before.items || []).filter(i => /shilling/i.test(i.name || ''))
        .reduce((n, i) => n + (i.amount || 1), 0);
      const r = await call('sell_all', {
        agent, merchant: step.merchant,
        // The reagents this errand exists to fetch must never be sold back at the counter
        // that just sold them, and the food is what gets a character home alive.
        // MERGED, NEVER REPLACED. A script that passes its own `keep` is adding to the
        // floor, not choosing a different one — the commonest way to lose a vault item is a
        // narrower list written for one errand.
        keep: [...new Set([...VAULT_KEEP, ...(step.keep ?? [])])],
        min_price: step.minPrice ?? 1,
        // One wielded weapon and one spare. sell_all already keeps equipped gear and one
        // piece for an empty armour slot, which is the shape a farmer should walk home in.
        max_weapons: step.maxWeapons ?? 2,
      }, 600_000).catch(e => ({ error: e.message }));
      const after = await call('inventory', { agent }, 60_000).catch(() => ({ items: [] }));
      const purse1 = (after.items || []).filter(i => /shilling/i.test(i.name || ''))
        .reduce((n, i) => n + (i.amount || 1), 0);
      // JUDGED ON THE PURSE, not on the reply. A merchant that will not deal answers with a
      // SENTENCE spoken to the room, and `sold: []` with no error looks identical to a
      // successful sale of nothing — so the money is the only honest evidence.
      const earned = purse1 - purse0;
      const shed = (before.items || []).length - (after.items || []).length;
      return {
        ok: true,                       // selling nothing is disappointing, not a failure
        earned, shed,
        refused: r?.not_offered?.length ?? 0,
        why: earned <= 0 ? `${step.merchant} bought nothing` : undefined,
      };
    }

    // THIS STEP STORED NOTHING FOR AS LONG AS IT EXISTED, and said `ok` every time.
    //
    // It called `container` with `action:'deposit'`, and `container` has no deposit: it is
    // BP_SEND_OBJECT_CONTENTS, it LOOKS INSIDE a box, and its schema is {agent, target, slot}.
    // So `action`, `container` and `items` were all ignored, `target` arrived undefined, and
    // the tool answered `nothing here matches "undefined"` - which is not a throw, so the
    // catch never fired, `r.error` stayed undefined, nothing left the pack, and the step
    // returned `{ok:true, vaulted:0}`. A silence that reads as success is this game's whole
    // failure mode and this was one of ours.
    //
    // `vault` is the tool that actually deposits. It resolves the vaultman off the live room
    // in the keeper process rather than trusting a name from here, and it reports what left
    // the pack rather than what it sent - so the arithmetic below is the tool's now, and this
    // step is thin on purpose.
    case 'vault': {
      const r = await call('vault', { agent, action: 'deposit', items: step.items },
                           300_000).catch(e => ({ error: e.message }));
      const stored = Number(r?.stored ?? 0);
      // ok when something was stored OR when there was nothing to store. A pack with no
      // keepers in it is not a failed vault trip, and must not stop a circuit.
      const nothingToStore = !stored && !(r?.wanted?.length && r?.refused?.length);
      return { ok: stored > 0 || (!r?.error && nothingToStore),
               vaulted: stored, offered: (r?.wanted ?? step.items ?? []).length,
               deposited: r?.deposited ?? [], refused: r?.refused ?? [],
               said: r?.vaultman_said ?? [],
               why: r?.error ?? r?.reason ?? r?.note ?? null };
    }

    case 'act': {
      const r = await call(step.tool, { agent, ...step.args }, step.timeoutMs ?? 120_000)
        .catch(e => ({ error: e.message }));
      return { ok: !r?.error, result: r, why: r?.error };
    }

    case 'verify': {
      const v = await step.fn({ agent, observe, call, state });
      return { ok: Boolean(v), why: v ? undefined : (step.why || 'verification failed') };
    }

    default:
      return { ok: false, why: `unknown step "${step.do}"` };
  }
}

async function inventoryCounts(agent, lines) {
  const inv = await call('inventory', { agent }, 60_000).catch(() => ({ items: [] }));
  return lines.map(l => (inv.items || [])
    .filter(i => l.match.test(i.name || ''))
    .reduce((n, i) => n + (i.amount || 1), 0));
}

// ---------------------------------------------------------------- the compiler
//
// `steps` may be an array, or a function of the agent so each courier can compute its own
// (a withdrawal sized to what it already carries, say).
export async function fleetScript({
  name, agents, steps, fleet = fleetName(), minHealth = 1, pollMs = 8000,
  // DELIBERATELY GOING INTO A ROOM WE KNOW KEEPS CHARACTERS — a rescue, and nothing else.
  // It has to be written at the call site because "I know about the trap" and "I forgot"
  // otherwise produce exactly the same script. See KNOWN_TRAPS.
  allowTraps = false,
  // THE FLOOR UNDER A WALK'S PATIENCE, and the only reason it is a parameter: with it
  // hard-coded at three minutes, the FAILING walk took nine minutes to reach its verdict,
  // so no offline test ever covered the path where a walk gives up. That is exactly the
  // path that stranded Zoot in Barloque with his cargo. Untestable code is where bugs live.
  budgetFloorMs = 180_000, budgetCapMs = 900_000,
  // How long to keep re-reading the pack for goods that are on their way in.
  packSettleMs = 15_000,
  // How long to wait for a keeper to walk a corpse out of the Underworld before giving up.
  reviveMs = 300_000,
  // How long a character may rest before a journey. Long enough to climb a full bar
  // at the resting rate (0.29 hp/s at 80 vigor is ~3 minutes for 50 points), bounded
  // so an errand cannot wait for ever on somebody who cannot heal where it stands.
  healMs = 300_000,
  force = process.argv.includes('--force'), parallel = true,
  onLog = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a),
} = {}) {
  if (!Array.isArray(agents) || !agents.length) throw new Error('fleetScript needs agents');
  if (!steps) throw new Error('fleetScript needs steps');

  // RULE 1.
  const claim = takeRunLock(fleet, { label: `${name} [${agents.join(',')}]`, force });
  if (!claim.ok) {
    const h = claim.holder ?? {};
    onLog(`REFUSING — fleet "${fleet}" is already being driven.`);
    onLog(`  pid ${h.pid ?? '?'} | ${h.label ?? '?'} | ` +
          `${h.at ? Math.round((Date.now() - h.at) / 1000) + 's ago' : '?'}`);
    onLog(`  argv ${h.argv ?? '?'}`);
    onLog('Wait for it, stop that pid, or pass --force if you know it is dead.');
    return { ok: false, refused: true, holder: h };
  }
  if (claim.tookOverFrom) onLog(`note: took over a stale lock — ${claim.tookOverFrom.why}`);

  const ctx = { log: onLog, pollMs, minHealth, healMs, budgetFloorMs, budgetCapMs,
                reviveMs, packSettleMs, name };
  const held = new Set();

  // RULE 2, and the part every script got wrong: freeing on the abnormal exits too. A
  // force-killed run left six characters "driven", which makes the patrol re-send orders
  // every pass for ever — 15 sends across 15 passes before it was found.
  const freeAll = async () => {
    await Promise.all([...held].map(a =>
      call('autopilot', { agent: a, action: 'free' }, 30_000).catch(() => {})));
    held.clear();
  };
  // Removed again in the finally: these are per-RUN, and a long-lived process that calls
  // fleetScript repeatedly would otherwise accumulate one set per call until node warns
  // about a leak — which is a real handle leak, not just noise.
  const onSignal = () => { freeAll().finally(() => process.exit(130)); };
  const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const sig of SIGNALS) { try { process.once(sig, onSignal); } catch { /* not here */ } }
  const dropSignalHandlers = () => {
    for (const sig of SIGNALS) { try { process.off(sig, onSignal); } catch { /* fine */ } }
  };

  const results = {};
  const runOne = async agent => {
    const state = { agent, results: {} };
    // Reassigned across a death, when the legs go back to the keeper and are taken again.
    let hold = { ok: false, cancelJourney: async () => {}, release: async () => {} };
    try {
      // TWO DIFFERENT HOLDS, AND BOTH ARE NEEDED. `busy` is for the FLEET — it is what makes
      // stall detectors and supervisors step over this character. The faculty lease is for the
      // KEEPER — it is the only one of the two that stops the process holding the socket from
      // steering. Sending only the first is what put this runner and twenty-one keepers on the
      // same bodies all afternoon.
      await call('autopilot', { agent, action: 'busy', kind: 'fleetscript', label: name }, 40_000)
        .catch(() => {});
      held.add(agent);
      hold = await holdKeeper(ctx, agent, fleet);
      const plan = typeof steps === 'function' ? await steps(agent, state) : steps;

      // VAULT BEFORE SELL, CHECKED BEFORE ANYTHING WALKS.
      //
      // `sell_all` offers the merchant everything it will take, so a vault step AFTER a sell
      // is a vault of whatever the merchant did not want. The order is not a preference, it
      // is the difference between banking a ring of invisibility and selling it — and the
      // mistake is invisible afterwards, because the sale reports success either way.
      //
      // Refused up front rather than at the counter, the same contract the fleet-plan
      // interpreter keeps: a typo in step four must not be discovered by a character standing
      // in the wrong town with its loot already gone.
      // A KNOWN TRAP IS REFUSED FIRST, because every other check here is about an errand
      // going wrong and this one is about a character not coming back. Asked before the
      // first step so the refusal costs nothing, and asked per agent because where a
      // character is standing is part of the question.
      const trap = trapCheck(plan, { standingIn: (await observe(agent)).room, allowTraps });
      if (trap) {
        ctx.log(agent, `plan refused: ${trap}`);
        results[agent] = { ok: false, at: 0, step: 'trap', why: trap, state: state.results };
        return;
      }

      const firstSell = plan.findIndex(x => x.do === 'sell');
      const lastVault = plan.map(x => x.do).lastIndexOf('vault');
      if (firstSell >= 0 && lastVault > firstSell) {
        const why = `step ${lastVault} vaults AFTER step ${firstSell} sells — ` +
                    'sell_all would have offered the vault items to the merchant first';
        ctx.log(agent, `plan refused: ${why}`);
        results[agent] = { ok: false, at: lastVault, step: 'vault', why, state: state.results };
        return;
      }
      // AND A SELL WITH NO VAULT AT ALL HAS TO SAY SO OUT LOUD.
      //
      // Not every trip can vault — the vaults are in Barloque and Ko'catan only, so a Tos
      // errand physically cannot — and that is a fine thing to do. What is not fine is doing
      // it by omission, because "I decided the keep list is enough" and "I forgot" produce
      // exactly the same plan. `sell(merchant, { noVault: true })` is the acknowledgement:
      // it says the author considered the vault and is relying on VAULT_KEEP instead.
      const unacknowledged = plan.findIndex((x, i) =>
        x.do === 'sell' && !x.noVault && !plan.slice(0, i).some(p => p.do === 'vault'));
      if (unacknowledged >= 0) {
        const why = `step ${unacknowledged} sells with no vault before it — add a vault() step, ` +
                    'or sell(merchant, { noVault: true }) to say the keep list is the plan';
        ctx.log(agent, `plan refused: ${why}`);
        results[agent] = { ok: false, at: unacknowledged, step: 'sell', why, state: state.results };
        return;
      }

      // THE PLAN RUNS IN LEGS, AND AN ABANDONED ERRAND STILL COMES HOME.
      //
      // ZOOT, 2026-09-02. The walk to the Barloque vault failed three times, this loop
      // returned on the spot, and a character was left standing in a foreign town holding
      // seven long swords, a wand and the entire point of the trip. An hour later DUM
      // recalled him to Castle Victoria still carrying all of it, and from the outside that
      // read as the bot losing interest. It was not: this loop dropped him. Two separate
      // things were wrong and they need separate fixes.
      //
      // FIRST, A NICETY KILLED THE ERRAND. Vaulting is a bonus — VAULT_KEEP is what actually
      // protects those items, at the counter, and it was doing its job. The vault stop is
      // worth attempting and never worth abandoning a sale for. `optional` marks such a stop.
      // When an optional WALK fails, every step up to the next walk is skipped with it,
      // because those steps were going to happen AT the place we could not reach — running
      // them where we are standing is how a vault deposit gets offered to a blacksmith.
      //
      // SECOND, NOTHING BROUGHT HIM HOME. A failure returned before the last walk. `always`
      // marks a step that still runs while the plan is unwinding — the same shape DUM's own
      // sell circuit uses for its return leg. A trip that ends in the wrong town is worse
      // than one that ends having bought nothing, because the wrong town is where the roads
      // that killed four characters this week begin.
      let failure = null;
      for (let i = 0; i < plan.length; i++) {
        const step = plan[i], at = i;
        // Unwinding: only the steps that promised to run anyway.
        if (failure && !step.always) continue;
        // NOTHING TO SELL AND NOTHING TO VAULT once the pack is on a floor in another room.
        // The buying half of the errand is still worth finishing; the carrying half is not.
        if (state.died && (step.do === 'sell' || step.do === 'vault')) {
          ctx.log(agent, `step ${at} (${step.do}) skipped: the cargo was lost on death`);
          continue;
        }
        const r = await runStep(ctx, agent, step, state);
        state.results[`${at}:${step.do}`] = r;
        if (!r.ok) {
          // DEATH IS NOT A SKIPPED LEG, AND IT IS NOT THE END OF THE ERRAND EITHER.
          //
          // t18 died on the road to Barloque four minutes after the leg logic shipped, and
          // because the walk was marked `optional` the loop read a corpse as "could not reach
          // that room", skipped the leg, tried the next two stops and then ran the `always`
          // walk home — four orders to a body in the Underworld. `optional` is a claim about
          // a PLACE and `always` is a claim about finishing a trip; neither says whether the
          // character is alive.
          //
          // But ending the whole errand was also wrong. The pack is lost, not the journey:
          // the bank balance is untouched and the shopping is still worth doing. So the body
          // goes back to its keeper — INCLUDING the movement faculty, or the keeper cannot
          // walk it out of the Underworld — and the errand resumes once it is on its feet.
          if (r.dead) {
            ctx.log(agent, `step ${at} (${step.do}): DIED — handing the body back for recovery, ` +
                           'then finishing the shopping on banked funds');
            state.died = true;
            // Hand movement back first: recovery is the keeper's faculty and it cannot walk a
            // corpse out of the Underworld while we are holding the character's legs.
            await hold.release();
            const back = await recoverFromDeath(ctx, agent, ctx.reviveMs);
            if (back.ok) hold = await holdKeeper(ctx, agent, fleet);
            if (!back.ok) {
              failure = { at, step: step.do, why: `died and did not recover: ${back.why}`,
                          dead: true };
              break;
            }
            // The purse died with the body, so anything sized against it has to be re-read.
            state.purse = back.purse;
            i = at - 1;          // retry the step that was interrupted, now alive
            continue;
          }
          if (step.optional) {
            let skipped = 0;
            if (step.do === 'walk')
              while (i + 1 < plan.length && plan[i + 1].do !== 'walk') { i++; skipped++; }
            ctx.log(agent, `step ${at} (${step.do}) skipped, carrying on: ${r.why ?? '?'}` +
              (skipped ? ` (and ${skipped} step(s) that needed to be there)` : ''));
            continue;
          }
          ctx.log(agent, `step ${at} (${step.do}) failed: ${r.why ?? '?'}` +
            (plan.some(x => x.always) ? ' — unwinding to the steps that always run' : ''));
          failure = { at, step: step.do, why: r.why };
          continue;
        }
        ctx.log(agent, `step ${at} (${step.do}) ok` +
          (r.gained ? ` — ${r.gained.map(g => `${g.match} +${g.got}/${g.asked}`).join(', ')}` : '') +
          (r.earned !== undefined ? ` — earned ${r.earned}sh, shed ${r.shed} stack(s)` : '') +
          (r.vaulted !== undefined ? ` — vaulted ${r.vaulted}/${r.offered ?? 0}` : ''));
      }
      // SAY WHETHER THE CARGO IS STILL ABOARD. The operator's question after a failed supply
      // run is never "which step" — it is "is my character still carrying the loot", because
      // that decides whether the next thing to do is retry or rescue.
      const sells = plan.map((x, i) => [i, x]).filter(([, x]) => x.do === 'sell');
      const unsold = sells.length > 0 &&
                     sells.every(([i, x]) => state.results[`${i}:${x.do}`] === undefined);
      results[agent] = failure
        ? { ok: false, ...failure, unsold, state: state.results }
        : { ok: true, unsold: false, state: state.results };
    } catch (e) {
      results[agent] = { ok: false, why: e.message };
      ctx.log(agent, 'ERROR', e.message);
    } finally {
      // CANCEL BEFORE HANDING BACK. Whatever ended this errand — success, a give-up after
      // three attempts, a thrown error, a Ctrl-C — the keeper may still be walking the route
      // we asked for. Handing the faculties back without cancelling gives it a journey it
      // never chose, across the roads that kill this fleet.
      await hold.cancelJourney?.('the fleet errand ended').catch(() => {});
      // Faculties second: give the character its own legs back before anything else is
      // allowed to notice it is free.
      await hold.release().catch(() => {});
      await call('autopilot', { agent, action: 'free' }, 30_000).catch(() => {});
      held.delete(agent);
    }
  };

  ctx.log(`${name}: ${agents.length} agent(s), ${parallel ? 'in parallel' : 'one at a time'}`);
  try {
    if (parallel) await Promise.all(agents.map(runOne));
    else for (const a of agents) await runOne(a);
  } finally {
    await freeAll();
    dropSignalHandlers();
    claim.release();
  }

  const ok = agents.filter(a => results[a]?.ok).length;
  ctx.log(`${name}: ${ok}/${agents.length} completed`);
  return { ok: ok > 0, results };
}
