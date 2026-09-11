#!/usr/bin/env node
import { readFileSync } from 'node:fs';
// THE GUARANTEES THE COMPILER MAKES, PINNED. Offline: no broker, no server, no network —
// every call is answered by a fake, so this is safe to run while a live fleet is playing.
//
//   node tools/m59-fleetscript-test.mjs
//
// Each case here is a mistake a real ad-hoc script made against the prod fleet on
// 2026-09-02. If one of these fails, that mistake is available again.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The run lock writes a real file; give it a scratch directory before importing the module.
const LOCK_DIR = mkdtempSync(join(tmpdir(), 'm59-fs-'));
process.env.M59_RUNLOCK_DIR = LOCK_DIR;
process.env.M59_CONTROL_URL = 'http://127.0.0.1:1/';   // never actually reached

const { stateFileFor } = await import('./m59-fleetpath.mjs');
const { fleetScript, walk, walkTo, shop, bank, verify, sell, vault, VAULT_KEEP, leaveRaza,
        foodIn, nonFoodIn, splitFood, FOOD_KEEP, purseOf, isTransportFailure } =
  await import('./m59-fleetscript.mjs');

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};

// ---------------------------------------------------------------- the fake broker
//
// One place that answers every tool the compiler uses, driven by a per-agent script of
// states. `sent` records every call so a test can assert on what was NOT sent, which is
// where most of these bugs lived.
function fakeBroker({ rooms = {}, health = {}, inventory = {}, dead = new Set(),
                      // WHERE THE SAFE SPOTS ARE, and whether we are standing in one. Shaped
                      // like the broker's own answer: `in_a_safe_spot_now` is either false or
                      // an object carrying `works`, and every candidate square carries the
                      // book's verdict as `tested`.
                      safeNow = false, safeSpots = [], walkLands = true,
                      // WHERE EACH BODY IS STANDING, and what a `walk_to` does to it. The
                      // square matters because `walkTo` judges the walk on the world rather
                      // than on the reply — see the `walk_to` case in runStep. `onWalkTo` is
                      // handed {agent, col, row, positions, rooms} and may move the body,
                      // move it somewhere else entirely, or do nothing at all (a stall).
                      positions = {}, onWalkTo = null,
                      // Rooms the router cannot get to. Room 114 — the Barloque vaultman's
                      // office — was one of these for two of three couriers on 2026-09-02.
                      unreachable = new Set(),
                      shopItems = [{ id: 7, name: 'herb' }, { id: 8, name: 'elderberry' }],
                      // What the vaultman does with a deposit. The default is a counter that
                      // takes what it is offered; pass one that stores nothing to check the
                      // step does not read that as a failure.
                      vault = null,
                      // Whether the museum portal actually takes. The tool reports `left`,
                      // and the step is required NOT to believe it - see the room readback.
                      leftRaza = true,
                      // What this broker says it is holding. undefined = the right roster;
                      // a path = a DIFFERENT fleet's; null = a broker that will not say.
                      // WHAT THE GUILD TOOL ANSWERS. A function so a case can make the
                      // server refuse in the way it really does: `ok:false` with prose and
                      // no error, which is what fourteen guild verbs look like when the
                      // caller lacks the bit (user.kod:4848).
                      guildReply = null,
                      healthState = undefined } = {}) {
  const sent = [], rested = [];
  globalThis.fetch = async (_url, opts) => {
    // GUARANTEE 11 asks the broker which roster it is holding, before anything else. A
    // fleetScript run that could not answer that question refuses, so the fake has to be a
    // broker that answers it — which is the point: the suite now exercises the check on
    // every single run rather than in one bespoke case.
    if (!opts || opts.method !== 'POST') {
      const state = healthState === undefined ? stateFileFor('testfleet') : healthState;
      return { json: async () => (state === null ? {} : { ok: true, fleet: 'testfleet', state }) };
    }
    const body = JSON.parse(opts.body);
    const { name, arguments: a } = body.params;
    sent.push({ name, ...a });
    const agent = a.agent;
    let payload = {};
    if (name === 'status') {
      const hp = health[agent] ?? { value: 50, max: 50 };
      payload = { where: { num: rooms[agent], name: dead.has(agent) ? 'The Underworld' : 'room' },
                  // Production returns null here — the money is a `shilling` stack in the
                  // pack, not a scalar on the character. Mirroring that is the point.
                  hp, gold: null, you: positions[agent] ?? null };
    } else if (name === 'travel') {
      // A refused destination leaves the character where it was, which is what the real
      // thing does: travel is a request, and arriving is a separate observation.
      if (!unreachable.has(a.to)) rooms[agent] = a.to;
      payload = { started: true };
    }
    else if (name === 'travel_estimate') payload = { ms: 1000, hops: 2 };
    else if (name === 'inventory') payload = { items: inventory[agent] ?? [] };
    else if (name === 'shop') payload = a.buy_ids ? { bought: [] } : { items: shopItems };
    else if (name === 'bank') payload = { banker_said: ['Skivlat hands it over.'] };
    else if (name === 'sell_all') payload = { sold: [], not_offered: [] };
    else if (name === 'container') payload = { ok: true };
    else if (name === 'vault') payload = vault ?? {
      ok: true, action: 'deposit', vaultman: "Obert Cair'bre",
      wanted: [].concat(a.items ?? []),
      deposited: [].concat(a.items ?? []).map(n => ({ name: n, amount: 1 })),
      refused: [], stored: [].concat(a.items ?? []).length, vaultman_said: [] };
    else if (name === 'safe_spots') payload = { room: { num: rooms[agent] ?? 39, name: 'room' },
      in_a_safe_spot_now: safeNow, spots: safeSpots };
    else if (name === 'walk_to') {
      if (walkLands) safeNow = { at: { col: a.col, row: a.row }, works: true };
      if (onWalkTo) {
        // THE REPLY AND THE BODY ARE TWO DIFFERENT THINGS. `onWalkTo` may throw to model
        // the broker's 60-second RPC cap, which is what production does on any in-room walk
        // longer than a minute while the keeper goes on walking.
        const r = onWalkTo({ agent, col: a.col, row: a.row, positions, rooms });
        if (r && r.throws) throw new Error('The operation was aborted due to timeout');
      }
      payload = { arrived: walkLands };
    }
    else if (name === 'rest_up') { rested.push(agent); payload = { ok: true }; }
    // The portal, as the server behaves: it moves the character out of 1011-1018, or it
    // does not and says so. `leftRaza: false` models a portal that did not take.
    else if (name === 'leave_raza') {
      if (leftRaza) rooms[agent] = 39;
      payload = { left: leftRaza, log: [] };
    }
    else if (name === 'guild') payload = guildReply
      ? guildReply({ ...a })
      : { ok: true, name: a.name, price: 5000, guild: { name: a.name, rank: 'master' },
          messages: [] };
    else payload = { ok: true };
    return { json: async () => ({ result: { content: [{ text: JSON.stringify(payload) }] } }) };
  };
  sent.rested = rested;
  return sent;
}
const quiet = () => {};

console.log('one driver per fleet');
{
  const sent = fakeBroker({ rooms: { a1: 39 } });
  const first = await fleetScript({ name: 'first', fleet: 'testfleet', agents: ['a1'],
    steps: [verify(async () => true)], onLog: quiet });
  ok('a run completes and releases its lock', first.ok);

  // THE RIVAL HAS TO BE A DIFFERENT PROCESS. takeRunLock deliberately lets the SAME pid
  // re-enter its own claim — otherwise a tool could not call fleetScript twice — so holding
  // the lock in-process proves nothing. The lock also corroborates the pid against its start
  // time, so an invented number reads as stale and is taken over rather than refused. The
  // only honest rival is a real live process, so spawn one and name it in the lock.
  const { spawn } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const rival = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 700));
  const startedAt = Number(execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${rival.pid}"; ` +
    '[long](([datetimeoffset]$p.CreationDate).ToUnixTimeMilliseconds())'],
    { encoding: 'utf8' }).trim());
  writeFileSync(join(LOCK_DIR, 'run-testfleet.lock'), JSON.stringify(
    { pid: rival.pid, startedAt, at: Date.now(), fleet: 'testfleet',
      label: 'a pretend run', argv: 'node -e ...' }));

  const before = sent.length;
  const second = await fleetScript({ name: 'second', fleet: 'testfleet', agents: ['a1'],
    steps: [verify(async () => true)], onLog: quiet });
  ok('a second run is REFUSED while another process holds it', second.refused === true);
  ok('and it names the holder so an operator can act', second.holder?.label === 'a pretend run');
  ok('and it sent nothing at all to the fleet',
     !sent.slice(before).some(c => c.name === 'travel' || c.name === 'shop'),
     JSON.stringify(sent.slice(before).map(c => c.name)));
  rival.kill();
}

console.log('\nthe body is held for the whole errand');
{
  const sent = fakeBroker({ rooms: { a1: 39 } });
  await fleetScript({ name: 'held', fleet: 'testfleet', agents: ['a1'],
    steps: [walk(54)], onLog: quiet });
  const busyAt = sent.findIndex(c => c.name === 'autopilot' && c.action === 'busy');
  const freeAt = sent.findIndex(c => c.name === 'autopilot' && c.action === 'free');
  const travelAt = sent.findIndex(c => c.name === 'travel');
  ok('busy is sent before any movement', busyAt >= 0 && busyAt < travelAt);
  ok('and free is sent after it', freeAt > travelAt);
}
{
  // A step that fails must still free the body. Six characters were left "driven" this way,
  // which made the Castle patrol re-send orders on every pass for ever.
  const sent = fakeBroker({ rooms: { a1: 39 } });
  await fleetScript({ name: 'failing', fleet: 'testfleet', agents: ['a1'],
    steps: [verify(async () => false, 'deliberate')], onLog: quiet });
  ok('a FAILED errand still frees the body',
     sent.some(c => c.name === 'autopilot' && c.action === 'free'));
}

console.log('\na journey has a health floor, and a hurt character WAITS at it');
{
  // A HURT CHARACTER IS EARLY, NOT DISQUALIFIED. The first version refused anything below
  // the floor, which turned a 2.5% shortfall into a cancelled errand — Rizzo was turned away
  // from a shopping trip at 39 of 40. The floor stays (an inn heals free, the road does not);
  // the answer to being under it is to wait.
  const hp = { value: 20, max: 44 };
  const sent = fakeBroker({ rooms: { a1: 39 }, health: { a1: hp } });
  // The keeper heals it while it holds the body — which is the point of handing it back.
  const healer = setInterval(() => { hp.value = Math.min(44, hp.value + 12); }, 60);
  const r = await fleetScript({ name: 'heals', fleet: 'testfleet', agents: ['a1'],
    steps: [walk(54)], pollMs: 40, healMs: 4000, onLog: quiet });
  clearInterval(healer);
  ok('a hurt character heals and then sets out', r.results.a1.ok === true);
  ok('and it travelled after healing, not before', sent.some(c => c.name === 'travel'));
  // THE BODY GOES BACK TO THE KEEPER TO HEAL. `busy` makes the keeper inert, so resting
  // while holding it would rest with the survival ladder switched off in a monster room.
  const freed = sent.findIndex(c => c.name === 'autopilot' && c.action === 'free');
  const travelled = sent.findIndex(c => c.name === 'travel');
  ok('the body is handed back before the healing wait', freed >= 0 && freed < travelled);
  ok('and re-held before the journey', sent.slice(freed, travelled)
    .some(c => c.name === 'autopilot' && c.action === 'busy'));
}
{
  // Some rooms prevent rest, and a character at its ceiling will not improve by being
  // watched. Either is worth reporting rather than burning the whole budget in silence.
  const sent = fakeBroker({ rooms: { a1: 39 }, health: { a1: { value: 1, max: 44 } } });
  const r = await fleetScript({ name: 'cannot heal', fleet: 'testfleet', agents: ['a1'],
    steps: [walk(54)], pollMs: 30, healMs: 600, onLog: quiet });
  ok('a character that cannot heal gives up rather than waiting for ever',
     r.results.a1.ok === false);
  ok('and says what stopped it',
     /stopped improving|did not reach the floor/.test(r.results.a1.why ?? ''), r.results.a1.why);
  ok('and never set out hurt', !sent.some(c => c.name === 'travel'));
}
{
  const sent = fakeBroker({ rooms: { a1: 202 }, health: { a1: { value: 44, max: 44 } } });
  await fleetScript({ name: 'healed', fleet: 'testfleet', agents: ['a1'], steps: [walk(39)],
    onLog: quiet });
  ok('a healthy character sets out with no healing detour',
     sent.some(c => c.name === 'travel') &&
     !sent.some(c => c.name === 'autopilot' && c.action === 'revive'));
}
{
  // UNKNOWN IS NOT PERMISSION AND IS NOT SOMETHING RESTING FIXES: a health we cannot read
  // usually means the keeper is not answering at all, which is exactly when a journey must
  // not start. This caught a character whose keeper process had become a Windows corpse.
  const sent = fakeBroker({ rooms: { a1: 202 }, health: { a1: { value: null, max: null } } });
  const r = await fleetScript({ name: 'unknown', fleet: 'testfleet', agents: ['a1'],
    steps: [walk(39)], healMs: 400, pollMs: 30, onLog: quiet });
  ok('unknown health refuses without even trying to heal',
     r.results.a1.ok === false && !sent.some(c => c.name === 'travel') &&
     !sent.some(c => c.name === 'autopilot' && c.action === 'revive'));
}
console.log('\na dead character is not walked at');
{
  const sent = fakeBroker({ rooms: { a1: 1 }, dead: new Set(['a1']) });
  // reviveMs is tiny here on purpose: death is no longer terminal (the keeper is given a
  // chance to walk the body out and the shopping resumes on banked funds), so without a bound
  // this test would sit through the full five-minute recovery budget.
  const r = await fleetScript({ name: 'dead', fleet: 'testfleet', agents: ['a1'],
    pollMs: 5, reviveMs: 120,
    steps: [walk(39), shop('Frisconar', [{ match: /herb/, amount: 10 }])], onLog: quiet });
  ok('the errand stops at a death it cannot recover from', r.results.a1.ok === false);
  ok('and the steps after it never run', !sent.some(c => c.name === 'shop'));
}

console.log('\npurchases are read back from the pack');
{
  // A handshake that moves nothing is the commonest failure at a counter and reports success.
  fakeBroker({ rooms: { a1: 53 }, inventory: { a1: [] } });
  const r = await fleetScript({ name: 'empty buy', fleet: 'testfleet', agents: ['a1'],
    steps: [shop('Frisconar', [{ match: /herb/, amount: 150 }])], onLog: quiet });
  ok('a purchase that moved nothing is a FAILURE', r.results.a1.ok === false);
  ok('and says so', /nothing entered the pack/.test(r.results.a1.why ?? ''), r.results.a1.why);
}
{
  let bought = false;
  const inv = { a1: [] };
  fakeBroker({ rooms: { a1: 53 }, inventory: inv });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    // The /health probe guarantee 11 makes is a GET with no body; only POSTs are RPC.
    if (!o || o.method !== 'POST') return realFetch(u, o);
    const b = JSON.parse(o.body);
    if (b.params.name === 'shop' && b.params.arguments.buy_ids) {
      bought = true; inv.a1 = [{ name: 'herb', amount: 150 }];
    }
    return realFetch(u, o);
  };
  const r = await fleetScript({ name: 'real buy', fleet: 'testfleet', agents: ['a1'],
    steps: [shop('Frisconar', [{ match: /herb/, amount: 150 }])], onLog: quiet });
  ok('a purchase that landed is a success', bought && r.results.a1.ok === true);
}

console.log('\none agent failing does not fail the others');
{
  fakeBroker({ rooms: { a1: 39, a2: 39 }, health: { a1: { value: 1, max: 44 } } });
  // healMs AND pollMs, LIKE EVERY OTHER HURT-CHARACTER CASE IN THIS FILE. Without them this
  // case took the 300-SECOND default: a1 is at 1 of 44, the health floor sends it to rest,
  // and the fake never heals anybody — so the suite sat here for five minutes and read as a
  // hang, which is how it was reported. Three cases above already pass a short one.
  //
  // Same disease as the `budgetFloorMs` note in m59-fleetscript.mjs: a real constant applied
  // to a fake that can never satisfy it. "Untestable code is where bugs live" covers slow
  // tests too — a suite nobody will sit through is a suite nobody runs.
  const r = await fleetScript({ name: 'mixed', fleet: 'testfleet', agents: ['a1', 'a2'],
    steps: [walk(54)], pollMs: 30, healMs: 400, onLog: quiet });
  ok('the hurt one stops', r.results.a1.ok === false);
  ok('the healthy one still completes', r.results.a2.ok === true);
  ok('and the run reports partial success', r.ok === true);
}

console.log('\na banker refusal is prose, not an error');
{
  fakeBroker({ rooms: { a1: 54 } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    // Only POSTs are RPC; guarantee 11's /health probe is a bodyless GET.
    if (!o || o.method !== 'POST') return realFetch(u, o);
    const b = JSON.parse(o.body);
    if (b.params.name === 'bank')
      return { json: async () => ({ result: { content: [{ text: JSON.stringify(
        { banker_said: ["But you only have 393 shillings in your account!"] }) }] } }) };
    return realFetch(u, o);
  };
  const r = await fleetScript({ name: 'poor', fleet: 'testfleet', agents: ['a1'],
    steps: [bank('withdraw', 5000)], onLog: quiet });
  ok('a refusal spoken as a sentence is caught as a failure', r.results.a1.ok === false);
}

console.log('\nTHE PURSE IS THE RECEIPT, NOT THE BANKER\u2019S SENTENCE');
{
  // Measured 2026-09-10 at the Royal Bank of Jasper: "Yevitan tells you, 'Here are your 2500
  // shillings.'" and the purse read 0 for THIRTY SECONDS afterwards. A caller that withdrew
  // and then sized a purchase against what it was carrying saw an empty purse, concluded the
  // withdrawal had failed, and walked to the merchant with three shillings.
  const withPurse = (creditsAfter) => {
    let calls = 0;
    const inv = { a1: [] };
    fakeBroker({ rooms: { a1: 54 }, inventory: inv });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u, o) => {
      if (!o || o.method !== 'POST') return realFetch(u, o);
      const b = JSON.parse(o.body);
      if (b.params.name === 'bank') {
        calls = 0;
        return { json: async () => ({ result: { content: [{ text: JSON.stringify(
          { banker_said: ["Yevitan tells you, \"Here are your 2500 shillings.\""] }) }] } }) };
      }
      if (b.params.name === 'inventory') {
        // The pack arrives on an event: empty for the first N reads, then credited.
        const items = (creditsAfter != null && calls++ >= creditsAfter)
          ? [{ name: 'shilling', amount: 2500 }] : [];
        return { json: async () => ({ result: { content: [{ text: JSON.stringify({ items }) }] } }) };
      }
      return realFetch(u, o);
    };
    return () => { globalThis.fetch = realFetch; };
  };

  let restore = withPurse(2);
  let r = await fleetScript({ name: 'slowpurse', fleet: 'testfleet', agents: ['a1'],
    steps: [bank('withdraw', 2500)], onLog: quiet, packSettleMs: 8000, pollMs: 200 });
  restore();
  ok('a withdrawal the purse eventually shows is a PASS, not a timeout', r.results.a1.ok === true);

  restore = withPurse(null);            // the purse never moves
  r = await fleetScript({ name: 'nopurse', fleet: 'testfleet', agents: ['a1'],
    steps: [bank('withdraw', 2500)], onLog: quiet, packSettleMs: 1500, pollMs: 200 });
  restore();
  ok('a banker who says yes while the purse never moves is NOT a success',
     r.results.a1.ok === false);
  ok('and the outcome names what was actually observed',
     JSON.stringify(r.results.a1).includes('counter_moved_nothing'));
}

console.log('\nA DROPPED SOCKET IS NOT AN ANSWER, AND ONLY A READ MAY BE ASKED TWICE');
{
  // 2026-09-11: three runs of the same errand died at step 0 with "could not read the
  // character" while an identical `status` from another process answered 200 throughout.
  // Node hands out keep-alive sockets the broker has already closed and does not retry a
  // POST, so the reset arrives in seven milliseconds — and `observe()` catches everything
  // and answers null, which the walk step reports as an unreadable body.
  const reset = () => Object.assign(new TypeError('fetch failed'),
                                    { cause: new Error('read ECONNRESET') });
  ok('a reset socket is a transport failure', isTransportFailure(reset()));
  ok('so is a hang-up', isTransportFailure(new TypeError('socket hang up')));
  ok('a TIMEOUT is not — the broker had the question, and asking twice spends the budget twice',
     !isTransportFailure(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
  ok('nor is an abort',
     !isTransportFailure(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  ok('nor is an ordinary refusal spoken by the broker',
     !isTransportFailure(new Error('unknown tool "t7"')));

  // AND THE RETRY IS A READ’S PRIVILEGE. A reset cannot say whether the request was
  // delivered, so a repeated withdrawal is a second withdrawal, not a retry. The fake
  // broker stays underneath: only the RPC POSTs are made to fail, so guarantee 11's
  // bodyless /health probe still answers and the script gets as far as the counter.
  const calls = [];
  fakeBroker({ rooms: { a1: 54 }, inventory: { a1: [{ name: 'shilling', amount: 2500 }] } });
  const base = globalThis.fetch;
  const flaky = (failFirst) => {
    let n = 0;
    globalThis.fetch = async (u, o) => {
      if (!o || o.method !== 'POST') return base(u, o);
      calls.push(JSON.parse(o.body).params.name);
      if (n++ < failFirst)
        throw Object.assign(new TypeError('fetch failed'), { cause: new Error('read ECONNRESET') });
      return base(u, o);
    };
  };

  flaky(2);
  let r = await fleetScript({ name: 'flakyread', fleet: 'testfleet', agents: ['a1'],
    steps: [walk(54)], onLog: quiet });
  ok('a walk survives two reset sockets, because a read may be asked again',
     r.results.a1.ok === true, JSON.stringify(r.results.a1));

  calls.length = 0;
  flaky(1);
  r = await fleetScript({ name: 'flakybank', fleet: 'testfleet', agents: ['a1'],
    steps: [bank('withdraw', 10)], onLog: quiet, packSettleMs: 800, pollMs: 200 });
  ok('a BANK call is never repeated after a reset — a second withdrawal is not a retry',
     calls.filter(c => c === 'bank').length <= 1,
     `bank calls: ${calls.filter(c => c === 'bank').length}`);
}


console.log('\nA REST HAPPENS IN A SAFE SPOT, OR IT DOES NOT HAPPEN');
{
  // Waldorf, 2026-09-08: four deaths in one day, every one `strategy: fieldrest`, three with
  // `in_safe_spot: false` in a room holding six hostiles, at 5-10 health of 51. The survival
  // ladder is quiet during a rest BY DESIGN — resting presupposes you walked somewhere
  // unhittable first — so nothing reacted. restUntil does abort on damage, but on a 3s poll,
  // and from six health one skeleton hit lands first.
  const { rest } = await import('./m59-fleetscript.mjs');
  const trip = (steps, name) => fleetScript({ name, fleet: 'testfleet', agents: ['a1'],
    steps, pollMs: 30, healMs: 400, onLog: quiet });

  let sent = fakeBroker({ rooms: { a1: 39 }, safeNow: { at: { col: 21, row: 7 }, works: true } });
  let r = await trip([rest()], 'rest-here');
  ok('a character already in a working spot rests where it stands',
     r.results.a1.ok === true && r.results.a1.state['0:rest'].outcome === 'rested_in_place',
     JSON.stringify(r.results.a1));
  ok('and does not walk anywhere to do it', !sent.some(x => x.name === 'walk_to'));

  // THE GEOMETRY'S ORDER IS THE ORDER, AND THE BOOK NO LONGER REORDERS IT.
  //
  // This pair used to assert the opposite: that a square the book called `holds` was walked
  // to ahead of the geometry's own first choice, and that one it called `does not work` was
  // struck out entirely. Both tiers read a failure column that is 89% mis-recorded
  // retaliation (`failed_via: "fight"` on 5,187 of 6,652 events) and fleet crowding, so the
  // promotion preferred whichever square twenty-one characters piled onto in August and the
  // filter hid sound walls. `safe_spots` no longer publishes `tested` at all.
  sent = fakeBroker({ rooms: { a1: 39 }, safeNow: false, safeSpots: [
    { col: 5, row: 5, can_reach_you: 0 }, { col: 21, row: 7, can_reach_you: 0 } ] });
  r = await trip([rest()], 'rest-move');
  ok('a character in the open walks to a spot before resting',
     r.results.a1.state['0:rest'].outcome === 'rested_after_moving',
     JSON.stringify(r.results.a1.state['0:rest']));
  const walk = sent.find(x => x.name === 'walk_to');
  ok('and it takes the square the GEOMETRY ranked first, not one with a history',
     walk && walk.col === 5 && walk.row === 5, JSON.stringify(walk));

  // A square carrying the retired book's worst verdict is now an ordinary candidate, because
  // that verdict was never evidence about the wall. What still refuses a rest is an EMPTY
  // list — the geometry offering nothing — which is the real "nowhere safe" and is below.
  sent = fakeBroker({ rooms: { a1: 39 }, safeNow: false,
    safeSpots: [{ col: 9, row: 9, tested: 'does not work', can_reach_you: 0 }] });
  r = await trip([rest()], 'rest-stale-verdict');
  ok('a square the retired book condemned is taken on its geometry anyway',
     r.results.a1.state['0:rest'].outcome === 'rested_after_moving',
     JSON.stringify(r.results.a1.state['0:rest']));

  sent = fakeBroker({ rooms: { a1: 39 }, safeNow: false, safeSpots: [] });
  r = await trip([rest()], 'rest-bad');
  ok('a room the geometry offers NO wall in refuses the rest',
     r.results.a1.ok === false && r.results.a1.state['0:rest'].outcome === 'nowhere_safe_to_rest',
     JSON.stringify(r.results.a1.state['0:rest']));
  ok('and nothing sat down', !sent.rested.length);

  sent = fakeBroker({ rooms: { a1: 39 }, safeNow: false, walkLands: false,
    safeSpots: [{ col: 21, row: 7, can_reach_you: 0 }] });
  r = await trip([rest()], 'rest-miss');
  ok('a walk that did not land leaves the character standing, not resting',
     r.results.a1.state['0:rest'].outcome === 'could_not_reach_safe_spot',
     JSON.stringify(r.results.a1.state['0:rest']));
  ok('and still nothing sat down', !sent.rested.length);

  sent = fakeBroker({ rooms: { a1: 39 }, safeNow: false, safeSpots: [] });
  r = await trip([rest({ unsafe: true })], 'rest-bare');
  ok('unsafe: true without a reason is refused',
     r.results.a1.state['0:rest'].outcome === 'unsafe_needs_reason',
     JSON.stringify(r.results.a1.state['0:rest']));

  sent = fakeBroker({ rooms: { a1: 39 }, safeNow: false, safeSpots: [] });
  r = await trip([rest({ unsafe: { reason: 'pulling a body out of 599; nowhere here is safe' } })], 'rest-waived');
  ok('a reasoned waiver rests anyway, and says what it waived',
     r.results.a1.ok === true && /599/.test(r.results.a1.state['0:rest'].waived || ''),
     JSON.stringify(r.results.a1.state['0:rest']));
}

console.log('\nany script can ask what in a pack is food, without deciding for itself');
{
  // THE SAME MISTAKE HAS NOW BEEN MADE IN FOUR PLACES BY FOUR HANDS, each with a word list:
  // smartloot filed spider eye, grapes and fortune cookies as sellable stock; the sell
  // circuit's keep list and the street giveaway's each named two of the SEVEN foods the
  // Duke's tables hand out, so the other five were sold in Barloque or left in the road.
  // Six hundred spider eyes among them, at nutrition 9 — the same as a slice of pork.
  //
  // These helpers exist so the fifth script does not have to make it. They ask `foodValue`,
  // which reads the game's own Food class tree.
  const pack = [
    { name: 'spider eye', amount: 600 }, { name: 'slice of pork', amount: 12 },
    { name: 'Inky-cap mushroom', amount: 3 }, { name: 'red mushroom', amount: 9 },
    { name: 'shilling', amount: 1208 }, { name: 'battle axe', amount: 1 },
  ];
  const split = splitFood(pack);
  ok('the spider eye is food', split.food.some(f => f.name === 'spider eye'));
  ok('and so is the Inky-cap, at fifty a bite',
     split.food.some(f => f.name === 'Inky-cap mushroom' && f.nutrition === 50));
  ok('a red mushroom is NOT — four of the five are reagents',
     split.other.some(i => i.name === 'red mushroom'));
  ok('counts the stacks, not the entries', split.meals === 615, String(split.meals));
  ok('and what the whole larder is worth if eaten', split.vigor === 600 * 9 + 12 * 9 + 3 * 50,
     String(split.vigor));

  // MONEY IS NOT FOOD AND IS NOT FILTERED AWAY. A caller asking for non-food nearly always
  // means "everything that is not a meal", which includes the purse; `purseOf` answers the
  // other question. Two questions, two answers, and neither pretends to be the other.
  ok('money lands in non-food', nonFoodIn(pack).some(i => /shilling/i.test(i.name)));
  ok('and purseOf still answers the money question', purseOf(pack) === 1208);

  // The string form callers get from some tools.
  ok('a bare list of names works too', foodIn(['spider eye', 'battle axe']).length === 1);
  ok('an empty pack is empty, not a crash', splitFood([]).meals === 0 && splitFood().meals === 0);
}

console.log('\nFOOD_KEEP is derived, so a keep list cannot drift from the game');
{
  ok('it holds every food the game has', FOOD_KEEP.length === 22, String(FOOD_KEEP.length));
  const holds = n => FOOD_KEEP.some(k => n.toLowerCase().includes(k.toLowerCase()));
  for (const meal of ['spider eye', 'slice of pork', 'bowl of soup', 'drumstick',
                      'bunch of grapes', 'goblet of ale', 'fortune cookie', 'edible mushroom'])
    ok('spares ' + meal, holds(meal));
  // AND THE FAILURE IN THE OTHER DIRECTION, which is the one that costs money: a `mushroom`
  // entry would hold all five and four of them are reagents the herbalist buys.
  for (const stock of ['mushroom', 'red mushroom', 'blue mushroom'])
    ok('still sells ' + stock, !holds(stock));
}

console.log('\nthe vault step deposits, which it did not do for as long as it existed');
{
  // IT CALLED THE WRONG TOOL AND SAID `ok` EVERY TIME.
  //
  // `container` is BP_SEND_OBJECT_CONTENTS: it LOOKS INSIDE a box, and its schema is
  // {agent, target, slot}. The vault step called it with {action:'deposit', container, items},
  // so all three were ignored, `target` arrived undefined, the tool answered
  // `nothing here matches "undefined"` - which is not a throw, so the catch never fired -
  // nothing left the pack, and the step returned {ok:true, vaulted:0}. Every vault step ever
  // run reported success having stored nothing. A silence that reads as success is this
  // game's whole failure mode, and this was one of ours.
  const sent = fakeBroker({ rooms: { a1: 114 } });
  const r = await fleetScript({ name: 'deposit', fleet: 'testfleet', agents: ['a1'],
    steps: [vault('vaultman', ['ring of invisibility'])], onLog: quiet });
  ok('it calls `vault`, the tool that actually deposits', sent.some(c => c.name === 'vault'));
  ok('and never `container`, which cannot', !sent.some(c => c.name === 'container'));
  const call = sent.find(c => c.name === 'vault');
  ok('as a deposit', call?.action === 'deposit', JSON.stringify(call));
  ok('naming the items rather than object ids',
     Array.isArray(call?.items) && call.items.includes('ring of invisibility'),
     JSON.stringify(call?.items));
  ok('the step succeeds when something was stored', r.results.a1.ok === true, r.results.a1.why);
}
{
  // A PACK WITH NOTHING WORTH VAULTING IS NOT A FAILED VAULT TRIP. It is the ordinary case for
  // a character whose loot was all sellable, and it must not stop a plan before the shops it
  // was on its way to.
  fakeBroker({ rooms: { a1: 114 },
               vault: { ok: false, action: 'deposit', wanted: ['wand'], deposited: [],
                        refused: [], stored: 0, vaultman_said: [] } });
  const r = await fleetScript({ name: 'nothing to store', fleet: 'testfleet', agents: ['a1'],
    steps: [vault('vaultman', ['wand'])], onLog: quiet });
  ok('an empty deposit is still ok', r.results.a1.ok === true, r.results.a1.why);
}
{
  // A VAULTMAN WHO REFUSES IS NOT AN EMPTY PACK, and the two must not report the same thing.
  // He says why out loud and returns nothing, which on the wire looks exactly like success.
  fakeBroker({ rooms: { a1: 114 },
               vault: { ok: false, action: 'deposit', wanted: ['wand'], deposited: [],
                        refused: ['wand'], stored: 0,
                        vaultman_said: ['I have no room for that.'] } });
  const r = await fleetScript({ name: 'refused', fleet: 'testfleet', agents: ['a1'],
    steps: [vault('vaultman', ['wand'])], onLog: quiet });
  ok('a refusal is reported as a failure', r.results.a1.ok === false, JSON.stringify(r.results.a1));
}

console.log('\nvault before sell, checked before anything walks');
{
  // sell_all offers the merchant everything it will take, so a vault AFTER a sell is a vault
  // of whatever the merchant did not want. The mistake is invisible afterwards: the sale
  // reports success either way, and the ring of invisibility is simply gone.
  const sent = fakeBroker({ rooms: { a1: 53 } });
  const r = await fleetScript({ name: 'wrong order', fleet: 'testfleet', agents: ['a1'],
    steps: [sell('Fehr\'loi Qan'), vault('vaultman')], onLog: quiet });
  ok('a plan that sells before vaulting is REFUSED', r.results.a1.ok === false);
  ok('and says which steps clash', /vaults AFTER/.test(r.results.a1.why ?? ''), r.results.a1.why);
  // Refused BEFORE the counter, not at it — the loot must still be in the pack.
  ok('and nothing was sold', !sent.some(c => c.name === 'sell_all'));
}
{
  const sent = fakeBroker({ rooms: { a1: 53 } });
  const r = await fleetScript({ name: 'right order', fleet: 'testfleet', agents: ['a1'],
    steps: [vault('vaultman'), sell('Fehr\'loi Qan')], onLog: quiet });
  ok('vault then sell is allowed', r.results.a1.ok === true);
}
{
  // A script may ADD to the keep list and may not narrow it. The commonest way to lose a
  // vault item is a keep list written for one errand that forgot the standing one.
  const sent = fakeBroker({ rooms: { a1: 53 } });
  await fleetScript({ name: 'own keep', fleet: 'testfleet', agents: ['a1'],
    steps: [sell('Fehr\'loi Qan', { keep: ['turkey leg'], noVault: true })], onLog: quiet });
  const call = sent.find(c => c.name === 'sell_all');
  ok('a script\'s own keep is merged with the standing list',
     call.keep.includes('turkey leg') && VAULT_KEEP.every(k => call.keep.includes(k)),
     JSON.stringify(call.keep));
  // The two that would hurt most: the reagents the errand exists to fetch, and the loot
  // that is worth more vaulted than sold.
  ok('and it protects the reagents and the keepers',
     call.keep.includes('elderberry') && call.keep.includes('herb') &&
     call.keep.includes('ring of invisibility') && call.keep.includes('rose'));
  ok('and holds a weapon and a spare back', call.max_weapons === 2);
}

{
  // NOT EVERY TRIP CAN VAULT — the vaults are in Barloque and Ko'catan only, so a Tos errand
  // physically cannot, and that is a fine thing to do. What is not fine is doing it by
  // omission: 'I decided the keep list is enough' and 'I forgot' produce the same plan.
  const sent = fakeBroker({ rooms: { a1: 53 } });
  const r = await fleetScript({ name: 'unacknowledged', fleet: 'testfleet', agents: ['a1'],
    steps: [sell('Frisconar')], onLog: quiet });
  ok('a sell with no vault and no acknowledgement is REFUSED', r.results.a1.ok === false);
  ok('and names the way to say it on purpose',
     /noVault/.test(r.results.a1.why ?? ''), r.results.a1.why);
  ok('and sold nothing', !sent.some(c => c.name === 'sell_all'));

  const r2 = await fleetScript({ name: 'acknowledged', fleet: 'testfleet', agents: ['a1'],
    steps: [sell('Frisconar', { noVault: true })], onLog: quiet });
  ok('and the acknowledgement lets it through', r2.results.a1.ok === true);
}

console.log('a leg that fails is not an errand that fails');
{
  // ZOOT, 2026-09-02, AND THE REASON THIS FILE EXISTS. He reached Barloque carrying seven
  // long swords, a wand and a knight's shield. The walk to the vault at room 114 failed
  // three times, the whole plan returned on that step, and he was left standing in a foreign
  // town with every item still on him — the sale, the bank stop and the shopping never
  // happened. An hour later DUM recalled him home, still loaded, and from the outside it
  // looked like the bot had abandoned its mission. It had not. This compiler dropped him.
  const sent = fakeBroker({
    rooms: { a1: 39 },
    unreachable: new Set([114]),
    inventory: { a1: [{ id: 1, name: 'long sword' }, { id: 2, name: 'wand' }] },
  });
  const r = await fleetScript({
    name: 'stranded', fleet: 'testfleet', agents: ['a1'], onLog: quiet,
    pollMs: 5, budgetFloorMs: 20, budgetCapMs: 60,
    steps: [
      walk(114, { optional: true }), vault('vault', undefined, { optional: true }),
      walk(113), sell("Fehr'loi Qan", { noVault: true }),
      walk(39, { always: true }),
    ],
  });
  ok('an unreachable OPTIONAL stop does not end the errand', r.results.a1.ok === true,
     JSON.stringify(r.results.a1));
  ok('the sale that pays for the trip still happens',
     sent.some(c => c.name === 'sell_all'));
  ok('and the character is not left holding the cargo', r.results.a1.unsold === false);

  // AND THE SKIPPED LEG TAKES ITS OWN STEPS WITH IT. The vault deposit was going to happen
  // AT room 114; running it from wherever we actually stand offers the keepers to whoever is
  // in that room, which on this route is a blacksmith who buys weapons.
  ok('the deposit that needed that room is skipped too',
     !sent.some(c => c.name === 'container'));
}

console.log('an abandoned errand still comes home');
{
  // The other half of Zoot. Even with legs, a MANDATORY step can fail — and the worst place
  // to stop is a foreign town, because that is where the roads that killed four characters
  // this week begin. `always` is the promise that the last walk runs anyway.
  // Start him where Zoot actually was: room 102, South Barloque. Starting at home would
  // have made this test pass for the wrong reason — compiledWalk returns immediately when
  // the character is already in the destination, so no travel is sent and 'came home'
  // would be indistinguishable from 'never left'.
  const sent = fakeBroker({ rooms: { a1: 102 }, unreachable: new Set([113]) });
  const r = await fleetScript({
    name: 'unwind', fleet: 'testfleet', agents: ['a1'], onLog: quiet,
    pollMs: 5, budgetFloorMs: 20, budgetCapMs: 60,
    steps: [walk(113), sell("Fehr'loi Qan", { noVault: true }), walk(39, { always: true })],
  });
  ok('the errand reports the failure', r.results.a1.ok === false);
  ok('and names the step that failed', r.results.a1.at === 0, JSON.stringify(r.results.a1));
  ok('and SAYS the cargo is still aboard', r.results.a1.unsold === true);
  ok('but the character is walked home regardless',
     sent.some(c => c.name === 'travel' && c.to === 39));
  ok('and nothing was sold in the wrong town', !sent.some(c => c.name === 'sell_all'));
}

console.log('death loses the cargo, not the errand');
{
  // GONZO AND CLIFFORD, 2026-09-02, both dead on the road to Barloque. My first fix ended the
  // whole errand on death. The operator corrected it: "death interrupts the selling portion,
  // but technically for our purposes you can still go to Tos, buy the reagents (using banked
  // funds) and return to Castle Victoria." What death destroys is the PACK — the loot and the
  // purse are on the floor where they fell. The bank balance is untouched, and the bank is
  // most of the way to being the point of the trip.
  const dead = new Set(['a1']);
  const sent = fakeBroker({ rooms: { a1: 39 }, dead,
                            inventory: { a1: [{ id: 1, name: 'long sword' }] } });
  setTimeout(() => dead.delete('a1'), 60);   // the keeper walks it out of the Underworld
  const r = await fleetScript({
    name: 'died-then-shopped', fleet: 'testfleet', agents: ['a1'], onLog: quiet,
    pollMs: 5, budgetFloorMs: 20, budgetCapMs: 60, reviveMs: 4000,
    steps: [
      walk(113, { optional: true }), sell("Fehr'loi Qan", { noVault: true }),
      walk(54), bank('withdraw', 5540, { optional: true }),
      walk(53), shop('Frisconar', [{ match: /elder/i, amount: 40 }]),
      walk(39, { always: true }),
    ],
  });
  ok('the selling is abandoned', !sent.some(c => c.name === 'sell_all'));
  ok('but the bank is still visited', sent.some(c => c.name === 'bank'));
  ok('and the reagents are still bought', sent.some(c => c.name === 'shop' && c.buy_ids));
  ok('and the character still comes home', sent.some(c => c.name === 'travel' && c.to === 39));
  ok('the errand records that it died', r.results.a1.state && r.results.a1.ok !== undefined);
}

console.log('a death it never comes back from does end the errand');
{
  // The bound matters: without it a corpse that the keeper cannot recover holds the claim for
  // ever, and a held body is one nothing else will step in to help.
  const sent = fakeBroker({ rooms: { a1: 39 }, dead: new Set(['a1']) });
  const r = await fleetScript({
    name: 'never-came-back', fleet: 'testfleet', agents: ['a1'], onLog: quiet,
    pollMs: 5, budgetFloorMs: 20, budgetCapMs: 60, reviveMs: 120,
    steps: [walk(113), sell("Fehr'loi Qan", { noVault: true }), walk(39, { always: true })],
  });
  ok('the errand ends', r.results.a1.ok === false);
  ok('and says it died and did not recover',
     /did not recover/.test(r.results.a1.why ?? ''), r.results.a1.why);
  ok('and sold nothing on the way', !sent.some(c => c.name === 'sell_all'));
}

console.log('an unknown purse is not an empty one');
{
  // This broker returns `gold: null` for every character — the money is a `shilling` stack in
  // the pack. `Number(null ?? 0)` turned that into a confident 0, and the resupply script then
  // asked the banker for the whole bill on behalf of a courier already carrying it. A banker
  // refusal is a sentence, so the errand ended at the counter and the courier came home with
  // nothing. Reported by a peer session before either of my runs got far enough to hit it.
  fakeBroker({ rooms: { a1: 39 } });
  const { observe, purseOf } = await import('./m59-fleetscript.mjs');
  const at = await observe('a1');
  ok('a null gold reads as null, not as zero', at.gold === null, JSON.stringify(at.gold));
  ok('and the purse is summed off the pack instead',
     purseOf([{ name: 'shilling', amount: 5602 }, { name: 'long sword' }]) === 5602);
  ok('an empty pack is an honest zero', purseOf([]) === 0);
}

console.log('a bank that says no does not end the shopping');
{
  // The whole trip exists to bring reagents home. A courier that cannot top up can still
  // spend what it is carrying, and 40 elderberry beats nothing because the banker said no.
  const sent = fakeBroker({ rooms: { a1: 54 },
    inventory: { a1: [{ id: 1, name: 'shilling', amount: 300 }] } });
  globalThis.fetch = (orig => async (url, opts) => {
    // Only POSTs are RPC; guarantee 11's /health probe is a bodyless GET.
    if (!opts || opts.method !== 'POST') return orig(url, opts);
    const body = JSON.parse(opts.body);
    if (body.params.name === 'bank')
      return { json: async () => ({ result: { content: [{ text: JSON.stringify(
        { banker_said: 'But you only have 12 shillings in your account!' }) }] } }) };
    return orig(url, opts);
  })(globalThis.fetch);
  const r = await fleetScript({
    name: 'poor', fleet: 'testfleet', agents: ['a1'], onLog: quiet,
    pollMs: 5, budgetFloorMs: 20, budgetCapMs: 60,
    steps: [bank('withdraw', 5540, { optional: true }), walk(53),
            shop('Frisconar', [{ match: /elder/i, amount: 40 }])],
  });
  ok('the banker refusal is recorded as a failed step',
     r.results.a1.state['0:bank'].ok === false);
  ok('but it does not end the errand there',
     r.results.a1.at !== 0, JSON.stringify(r.results.a1.at));
  ok('and the shop is still reached', sent.some(c => c.name === 'shop' && c.buy_ids));
}

rmSync(LOCK_DIR, { recursive: true, force: true });
console.log('');
console.log('a banker that names the balance is quoting, not refusing');
{
  // t11, 2026-09-03: asked for 5,540 against a balance of 5,313, was refused, and — because
  // the bank step is optional so a poor courier can still spend what it carries — walked on
  // to the apothecary with an empty purse and bought nothing. 227 shillings short, on a trip
  // that had already cost a death. The refusal names the answer; take it.
  fakeBroker({ rooms: { a1: 54 } });
  const asks = [];
  globalThis.fetch = (orig => async (url, opts) => {
    // Only POSTs are RPC; guarantee 11's /health probe is a bodyless GET.
    if (!opts || opts.method !== 'POST') return orig(url, opts);
    const body = JSON.parse(opts.body);
    if (body.params.name === 'bank') {
      const asked = Number(body.params.arguments.amount);
      asks.push(asked);
      const said = asked > 5313
        ? 'But you only have 5313 shillings in your account!'
        : 'Skivlat hands it over.';
      return { json: async () => ({ result: { content: [{ text: JSON.stringify({ banker_said: said }) }] } }) };
    }
    return orig(url, opts);
  })(globalThis.fetch);
  const r = await fleetScript({
    name: 'quoted', fleet: 'testfleet', agents: ['a1'], onLog: quiet,
    pollMs: 5, budgetFloorMs: 20, budgetCapMs: 60,
    steps: [bank('withdraw', 5540, { optional: true })],
  });
  ok('the withdrawal succeeds on the retry', r.results.a1.ok === true, JSON.stringify(r.results.a1));
  ok('it asked twice: the bill, then the balance the banker named',
     asks.length === 2 && asks[0] === 5540 && asks[1] === 5313, JSON.stringify(asks));
}

console.log('a walk to a non-room is refused before anything moves');
{
  // Logged live as `t11 walking 53 -> null, budget 490s`. The step that brings a courier home
  // is `always`, so a null destination burns the whole budget at the end of a paid-for errand.
  const sent = fakeBroker({ rooms: { a1: 53 } });
  const r = await fleetScript({
    name: 'nowhere', fleet: 'testfleet', agents: ['a1'], onLog: quiet,
    pollMs: 5, budgetFloorMs: 20, budgetCapMs: 60,
    steps: [walk(null, { always: true })],
  });
  ok('the errand fails rather than walking to null', r.results.a1.ok === false);
  ok('and says the destination is not a room',
     /not a room number/.test(r.results.a1.why ?? ''), r.results.a1.why);
  ok('and no travel was ever sent', !sent.some(c => c.name === 'travel'));
}

// ---------------------------------------------------------------- rooms that keep characters
{
  console.log('\na room we know traps characters is refused before anything walks');
  const { trapCheck, KNOWN_TRAPS, TRAP_WAY_OUT,
          routeCrossesTrap: crossesTrap } = await import('./m59-fleetscript.mjs');

  ok('Ukgoth is on the list, with the reason an operator needs',
     /Relic of Qor/.test(KNOWN_TRAPS[599] ?? ''), KNOWN_TRAPS[599]);

  const why = trapCheck([walk(54), walk(599)]);
  ok('a plan that walks into it is refused', !!why, String(why));
  ok('and the refusal names the room and the mechanic',
     /599/.test(why ?? '') && /Relic of Qor/.test(why ?? ''));

  ok('an ordinary plan is not refused', trapCheck([walk(54), walk(39)]) === null);

  // STANDING IN ONE IS NOT REFUSED ANY MORE, AND THIS IS THE ASSERTION THAT FLIPPED.
  //
  // It used to refuse, on the reasoning that the errand could not finish from there. Measured
  // 2026-09-10, which is what changed my mind: a character standing in the Ukgoth gutters was
  // asked -- through its own keeper -- for a route to room 2, and it answered the nine-hop way
  // round unprompted (599->589->579->578->576->587->597->598->599->2). The router is already
  // right, and positionally right: it declines the north door three rows above the body and
  // comes the whole way round to re-enter from 598, whose landing square can reach it.
  //
  // So the refusal was not protecting the character, it was stranding it -- with a message
  // addressed to an operator who is asleep. Operator, the same night: 'There is no reason for
  // anyone to get stuck in the gutter, that's the point of the gutter, to clean out people so
  // they continue on naturally.'
  ok('a character standing in a trap is NOT refused -- the router plans the way out',
     trapCheck([walk(39)], { standingIn: 599 }) === null);
  ok('and that is true of every trap entry, not just 599',
     Object.keys(KNOWN_TRAPS).every(r =>
       trapCheck([walk(39)], { standingIn: Number(r) }) === null));

  // TRANSIT IS ADVISORY; A DESTINATION IS STILL A REFUSAL. This is the distinction the old
  // check did not draw, and it is why it grounded the fleet the hour it started working: the
  // ONLY road to Castle Victoria runs through 599, so refusing transit refuses the destination.
  const transit = crossesTrap([{ from: 598, to: 599 }, { from: 599, to: 2 }]);
  ok('a route through a trap is still REPORTED', !!transit && transit.room === 599);
  ok('but it is marked advisory, which is what stops it being a refusal',
     transit?.advisory === true);
  ok('and a clean route still reports nothing',
     crossesTrap([{ from: 54, to: 39 }]) === null);
  ok('aiming an errand AT a trap is still refused, because that is a deliberate act',
     !!trapCheck([walk(599)]));

  // The way out is kept as a measurement for diagnostics. It must NOT be used to pre-empt the
  // router: it is room-level, and a body on TOP of 599 is one hop from Castle Victoria, so
  // walking it to 589 first would send it around the whole loop for nothing. That was the
  // first version of this fix and it was wrong.
  ok('every trap records the exit that actually works',
     Object.keys(KNOWN_TRAPS).every(r => Number.isFinite(TRAP_WAY_OUT[Number(r)])));
  ok('599 leaves south to 589', TRAP_WAY_OUT[599] === 589);
  ok('49 leaves north to 593', TRAP_WAY_OUT[49] === 593);
  // MATCHED ON A SUBSCRIPT, NOT THE NAME. The first version tested for `TRAP_WAY_OUT`
  // anywhere after compiledWalk and failed on the COMMENT inside it that explains why the
  // walker must not use it -- the second time in one session that an assertion could not tell
  // code from a comment about code. A read is `TRAP_WAY_OUT[...]`; prose is not.
  ok('and nothing in the walker READS it, so it cannot pre-empt the router',
     !/TRAP_WAY_OUT\s*\[/.test(
       readFileSync(new URL('./m59-fleetscript.mjs', import.meta.url), 'utf8')
         .split('async function compiledWalk')[1] ?? ''));
  ok('but only when the plan would actually walk it somewhere',
     trapCheck([], { standingIn: 599 }) === null);

  // THE RESCUE HAS TO BE ABLE TO GO IN. Refusing every trip into a trap would mean the only
  // way to recover a stranded character is a hand-written script — which is the thing this
  // file exists to stop being necessary.
  ok('a declared rescue may go in', trapCheck([walk(599)], { allowTraps: true }) === null);

  // GUARANTEE 12. THE DESTINATION TEST WAS NEVER THE WHOLE TEST.
  //
  // 2026-09-09: `walk(39)` — Castle Victoria upstairs, an ordinary room — was planned from
  // Jasper as 382 -> 350 -> 568 -> 567 -> 566 -> 576 -> 587 -> 597 -> 598 -> 599 -> 2 -> 38
  // -> 39. Every assertion above passes on that plan, because 599 is not the destination and
  // the body was not standing in it. Six trolls killed a 20-health caster on the way.
  const { routeCrossesTrap } = await import('./m59-fleetscript.mjs');
  const deadly = [382, 350, 568, 567, 566, 576, 587, 597, 598, 599, 2, 38, 39];
  ok('a plan aimed at an ordinary room is still allowed by the destination test',
     trapCheck([walk(39)]) === null);
  ok('but the ROUTE it would take is refused', routeCrossesTrap(deadly)?.room === 599);
  ok('and the refusal carries the reason the operator needs',
     /Relic of Qor/.test(routeCrossesTrap(deadly)?.why ?? ''));
  ok('a clear road is not refused',
     routeCrossesTrap([382, 350, 568, 567, 566, 576, 587, 27]) === null);

  // The router answers in more than one shape depending on who was asked, and a check that
  // only understands one of them is a check that silently passes everything.
  ok('hops as {room} objects are read', routeCrossesTrap([{ room: 599 }])?.room === 599);
  ok('hops as {to} objects are read', routeCrossesTrap([{ to: 599 }])?.room === 599);
  ok('an unreadable route is not a trap claim', routeCrossesTrap(null) === null);
  ok('an empty route is not a trap claim', routeCrossesTrap([]) === null);
}


console.log('');
console.log('the vault reads its own shelf back and takes out what is over the cap');
{
  // THE CAP TABLE WAS DOCUMENTATION. `evictionPlan` and `CAPS` lived in the fleet's
  // vault-strategy.mjs, read authoritatively, and had NO CALLER anywhere -- so an operator
  // who wrote 'keep only 120 nerudite arrows per person' had written a comment. This wires
  // it to the one moment it can act: standing at the vaultman, just after a deposit.
  process.env.M59_VAULT_STRATEGY =
    fileURLToPath(new URL('./fixtures/vault-strategy-fixture.mjs', import.meta.url));
  const sent = fakeBroker({ rooms: { a1: 114 },
    // One payload serves both calls: the deposit path reads `stored`, the list path `items`.
    vault: { ok: true, vaultman: 'Obert', stored: 1, deposited: [], refused: [],
             items: [{ name: 'orc tooth', amount: 137 },
                     { name: 'inky-cap mushroom', amount: 80 },
                     { name: 'emerald', amount: 4 }] },
    shopItems: [{ id: 21, name: 'orc tooth' }, { id: 22, name: 'inky-cap mushroom' }] });
  const r = await fleetScript({ name: 'evict', fleet: 'testfleet', agents: ['a1'],
    steps: [vault('vaultman', ['orc tooth']), sell('smith')], onLog: quiet });
  const bought = sent.filter(c => c.name === 'shop' && c.buy_ids).flatMap(c => c.buy_ids);

  ok('it withdraws exactly the surplus, not the stockpile',
     bought.find(b => b.id === 21)?.amount === 37, JSON.stringify(bought));
  ok('one over a different cap comes out too',
     bought.find(b => b.id === 22)?.amount === 30, JSON.stringify(bought));
  ok('and an item with no cap at all is never touched', bought.length === 2,
     'emerald has no cap: ' + JSON.stringify(bought));

  // SELL IS THE DEFAULT AND THE KEEP LIST HAS TO STAND ASIDE FOR IT. Without this the
  // surplus rides the whole circuit protected by the very list that put it in the vault.
  const sale = sent.find(c => c.name === 'sell_all');
  ok('the sell step un-keeps what was evicted to sell',
     !(sale?.keep ?? []).some(n => /orc tooth/i.test(n)), JSON.stringify(sale?.keep));
  // The keep list holds NAME FRAGMENTS, not full names -- `inky` is the entry that protects
  // an Inky-cap mushroom. A `carry` disposition must leave that fragment untouched.
  ok('but keeps what was evicted to CARRY -- inky-caps are food, not surplus',
     (sale?.keep ?? []).some(n => /^inky/i.test(n)), JSON.stringify(sale?.keep));
  ok('and the vault step still reports success', r.results.a1.ok === true, r.results.a1.why);
  delete process.env.M59_VAULT_STRATEGY;
}

console.log('');
console.log('the shipped keep-unbuyable default, on its own terms');
{
  // TESTED AS A MODULE, NOT THROUGH THE LOADER. Whether the loader reaches it depends on
  // whether THIS machine has a fleet of its own -- this one does -- so asserting the
  // default's behaviour through the loader would pass or fail on a checkout detail.
  const d = await import('./vault-strategies/keep-unbuyable.mjs');
  ok('half the vault each, derived from bulk rather than written down',
     d.CAPS['dark angel feather'] === 375 && d.CAPS['blue dragon scale'] === 150,
     JSON.stringify(d.CAPS));
  const plan = d.evictionPlan([{ name: 'dark angel feather', amount: 400 },
                               { name: 'blue dragon scale', amount: 120 },
                               { name: 'emerald', amount: 9 }]);
  const row = (n) => plan.plan.find(r => r.name === n);
  ok('an unbuyable keeper is trimmed to its cap', row('dark angel feather')?.evict === 25);
  ok('and one under its cap is left entirely alone', !row('blue dragon scale'));
  ok('anything a merchant restocks comes out in full', row('emerald')?.evict === 9);
  ok('and the reason says which half of the rule it was',
     /buyable somewhere/.test(row('emerald')?.why ?? ''), row('emerald')?.why);
}

console.log('');
console.log('and the vault step evicts through it end to end');
{
  process.env.M59_VAULT_STRATEGY =
    fileURLToPath(new URL('./vault-strategies/keep-unbuyable.mjs', import.meta.url));
  const sent = fakeBroker({ rooms: { a1: 114 },
    vault: { ok: true, vaultman: 'Obert', stored: 1, deposited: [], refused: [],
             items: [{ name: 'dark angel feather', amount: 400 },
                     { name: 'emerald', amount: 9 }] },
    shopItems: [{ id: 31, name: 'dark angel feather' }, { id: 32, name: 'emerald' }] });
  const r = await fleetScript({ name: 'default-strategy', fleet: 'testfleet', agents: ['a1'],
    steps: [vault('vaultman', ['dark angel feather'])], onLog: quiet });
  const bought = sent.filter(c => c.name === 'shop' && c.buy_ids).flatMap(c => c.buy_ids);
  ok('the surplus feathers are withdrawn', bought.find(b => b.id === 31)?.amount === 25,
     JSON.stringify(bought));
  ok('and the buyable stock in full', bought.find(b => b.id === 32)?.amount === 9,
     JSON.stringify(bought));
  ok('and the step succeeds', r.results.a1.ok === true, r.results.a1.why);
  delete process.env.M59_VAULT_STRATEGY;
}

console.log('');
console.log('a strategy that will not load leaves the vault alone rather than failing');
{
  process.env.M59_VAULT_STRATEGY = 'C:/nonexistent/vault-strategy.mjs';
  const sent = fakeBroker({ rooms: { a1: 114 } });
  const r = await fleetScript({ name: 'broken-strategy', fleet: 'testfleet', agents: ['a1'],
    steps: [vault('vaultman', ['ring of invisibility'])], onLog: quiet });
  ok('the deposit still happens', sent.some(c => c.name === 'vault' && c.action === 'deposit'));
  ok('nothing is bought back', !sent.some(c => c.name === 'shop' && c.buy_ids));
  ok('and the step still succeeds', r.results.a1.ok === true, r.results.a1.why);
  delete process.env.M59_VAULT_STRATEGY;
}

console.log('');
console.log('');
console.log('the broker you talk to must be holding the fleet you named');
{
  // THE TWO COME FROM UNRELATED PLACES. The fleet name is --fleet/M59_FLEET; the broker is
  // M59_CONTROL_URL, which DEFAULTS TO 8901. On this machine 8901 is production, so
  // `M59_FLEET=shadow` with no control URL names shadow, takes shadow's run lock, prints
  // "fleet shadow" in every line, and drives prod. Done for real on 2026-09-09; it was
  // harmless only because the agent name did not exist on the other side.
  const sent = fakeBroker({ rooms: { a1: 39 }, healthState: 'C:/somewhere/else/prod.json' });
  let threw = null;
  try {
    await fleetScript({ name: 'wrong broker', fleet: 'testfleet', agents: ['a1'],
      steps: [walk(39)], onLog: quiet });
  } catch (e) { threw = e; }
  ok('a broker holding a DIFFERENT roster is refused', threw !== null);
  ok('and the refusal names both paths, because a fleet is its roster file',
     /WRONG BROKER/.test(threw?.message ?? '') && /prod\.json/.test(threw?.message ?? ''));
  ok('and it says how to fix it', /M59_CONTROL_URL/.test(threw?.message ?? ''));
  ok('and nothing at all was sent to that broker',
     !sent.some(x => x.name === 'travel'), JSON.stringify(sent.map(x => x.name)));
}
{
  // SILENCE IS A QUESTION, NOT A FLEET. The same third answer m59-which.mjs had to grow:
  // the busiest broker is the slowest to reply and it is always the one that matters, so
  // "could not ask" must never round to "close enough".
  const sent = fakeBroker({ rooms: { a1: 39 }, healthState: null });
  let threw = null;
  try {
    await fleetScript({ name: 'silent broker', fleet: 'testfleet', agents: ['a1'],
      steps: [walk(39)], onLog: quiet });
  } catch (e) { threw = e; }
  ok('a broker that will not say what it holds is refused, not assumed', threw !== null);
  ok('and it says it is refusing rather than guessing',
     /Refusing rather than guessing/.test(threw?.message ?? ''));
  ok('and nothing was sent', !sent.some(x => x.name === 'travel'));
}
{
  // AND IT IS WAIVABLE BY NAME, like every other guarantee here - a lab harness pointing a
  // script at a stand-in broker is a real thing to want.
  const sent = fakeBroker({ rooms: { a1: 39 }, healthState: 'C:/somewhere/else/prod.json' });
  const r = await fleetScript({ name: 'deliberate', fleet: 'testfleet', agents: ['a1'],
    unsafe: { reason: 'pointing at a stand-in broker on purpose', waives: ['brokerHoldsFleet'] },
    steps: [walk(101)], onLog: quiet });
  ok('naming the waiver lets it through', r.results.a1.ok === true);
  // Somewhere it is NOT already standing: walk(39) from room 39 is correctly a no-op and
  // would have proved nothing about whether the guarantee was waived.
  ok('and the journey actually ran', sent.some(x => x.name === 'travel' && x.to === 101));
}

console.log('leaving the newbie zone is a step, not a travel');
{
  // RAZA HAS NO DOOR. `travel` answers `started: true, hops: 0` for a character in the Raza
  // Inn and moves nobody - the only way out is a two-touch portal in the Grand Museum. The
  // point of the verb is that FleetScript can SAY this at all; the point of these
  // assertions is that it does not believe the tool's own answer.
  const sent = fakeBroker({ rooms: { a1: 1011 } });
  const r = await fleetScript({ name: 'grad', fleet: 'testfleet', agents: ['a1'],
    steps: [leaveRaza(), walk(101)], onLog: quiet });
  ok('a character in Raza leaves through the museum portal', r.results.a1.ok === true,
     JSON.stringify(r.results.a1));
  ok('and the leave_raza tool was the thing that did it',
     sent.some(x => x.name === 'leave_raza' && x.agent === 'a1'));
  ok('and the onward leg is a SEPARATE walk, so it keeps the health floor and the trap check',
     sent.some(x => x.name === 'travel' && x.to === 101));
  ok('the tool is never asked to do the onward journey itself',
     !sent.some(x => x.name === 'leave_raza' && x.then_travel_to !== undefined));
}
{
  // A PORTAL THAT DID NOT TAKE MUST NOT READ AS SUCCESS. The tool says `left: false` and the
  // character is still in 1011; either alone would be enough, and the step is required to
  // check the ROOM rather than the reply.
  const sent = fakeBroker({ rooms: { a1: 1011 }, leftRaza: false });
  const r = await fleetScript({ name: 'stuck', fleet: 'testfleet', agents: ['a1'],
    steps: [leaveRaza(), walk(101)], onLog: quiet });
  ok('a portal that did not take is a FAILED step', r.results.a1.ok === false);
  ok('and it says which room the character is still in',
     /still in the newbie zone \(room 1011\)/.test(r.results.a1.why ?? ''), r.results.a1.why);
  ok('and the onward journey never starts', !sent.some(x => x.name === 'travel' && x.to === 101));
}
{
  // IDEMPOTENT, so it is safe at the head of any errand that might be handed a character
  // that graduated last week.
  const sent = fakeBroker({ rooms: { a1: 39 } });
  const r = await fleetScript({ name: 'already', fleet: 'testfleet', agents: ['a1'],
    steps: [leaveRaza()], onLog: quiet });
  ok('a character already outside Raza is skipped', r.results.a1.ok === true);
  ok('and the portal is not touched at all', !sent.some(x => x.name === 'leave_raza'));
}

// ---------------------------------------------------------------- walkTo
//
// THE INCIDENT, 2026-09-10 06:18:57Z. Marco Polo (20 max health) was walked across room 587
// with `act('walk_to', ...)` and it came back
//
//     { error: "The operation was aborted due to timeout", timed_out_after_ms: 60000 }
//
// The 60 seconds is the BROKER's cap on its own RPC to the keeper — not fleetScript's, and
// not the walk's budget. The keeper was still walking. `act` scored it as a step failure,
// the script unwound, the lease went back, and a fragile caster was unheld in the Twisted
// Wood inside the minute. Every case below is that failure, or the ones next to it.
console.log('\nwalkTo judges the walk on the world, not on the reply');
{
  // The body moves one square per poll while the RPC has already given up.
  const positions = { a1: { row: 30, col: 40 } };
  const sent = fakeBroker({
    rooms: { a1: 587 }, positions,
    onWalkTo: ({ agent }) => {
      const toward = (from, to, by) => from > to ? Math.max(to, from - by)
                                                 : Math.min(to, from + by);
      const step = () => {
        const p = positions[agent];
        if (!p) return;
        p.row = toward(p.row, 16, 4);
        p.col = toward(p.col, 4, 8);
        if (p.row !== 16 || p.col !== 4) setTimeout(step, 5).unref?.();
      };
      setTimeout(step, 5).unref?.();
      return { throws: true };          // the broker's 60s cap, faithfully
    },
  });
  const r = await fleetScript({ name: 'walkto', fleet: 'testfleet', agents: ['a1'],
    steps: [walkTo(4, 16, { pollMs: 20, deadlineMs: 8000 })], onLog: quiet });
  ok('an RPC that times out is not a failed walk', r.results.a1.ok === true);
  ok('and the step reports arrival, read off the world',
     r.results.a1.state['0:walk_to'].outcome === 'arrived');
  ok('the walk was issued exactly once',
     sent.filter(x => x.name === 'walk_to').length === 1,
     `${sent.filter(x => x.name === 'walk_to').length} walk_to calls`);
}

console.log('\nwalkTo takes the slack it is given, and no more');
{
  // Two squares off on both axes. That is inside the mana-node meld box, which is a 5x5
  // BOX and not a radius: abs(drow) < 3 AND abs(dcol) < 3, per axis (mananode.kod:177).
  const positions = { a1: { row: 25, col: 51 } };
  fakeBroker({ rooms: { a1: 27 }, positions });
  const r = await fleetScript({ name: 'slack', fleet: 'testfleet', agents: ['a1'],
    steps: [walkTo(53, 23, { within: 2, pollMs: 20, deadlineMs: 3000 })], onLog: quiet });
  ok('two squares off on both axes is inside a within:2 walk', r.results.a1.ok === true);

  fakeBroker({ rooms: { a1: 27 }, positions: { a1: { row: 25, col: 51 } } });
  const exact = await fleetScript({ name: 'exact', fleet: 'testfleet', agents: ['a1'],
    steps: [walkTo(53, 23, { pollMs: 20, deadlineMs: 900, stallMs: 200 })], onLog: quiet });
  ok('and the same square is NOT an arrival when no slack was asked for',
     exact.results.a1.ok === false);
}

console.log('\na stall is re-issued once and then measured, never asked a third time');
{
  const sent = fakeBroker({ rooms: { a1: 599 }, positions: { a1: { row: 4, col: 63 } } });
  const r = await fleetScript({ name: 'stall', fleet: 'testfleet', agents: ['a1'],
    steps: [walkTo(27, 1, { pollMs: 20, stallMs: 100, deadlineMs: 8000 })], onLog: quiet });
  ok('a body that never moves fails the step', r.results.a1.ok === false);
  ok('and it is reported as a stall rather than as a timeout',
     r.results.a1.state['0:walk_to'].outcome === 'stalled');
  ok('exactly two walk_to calls — the first and ONE re-issue',
     sent.filter(x => x.name === 'walk_to').length === 2,
     `${sent.filter(x => x.name === 'walk_to').length} walk_to calls`);
  ok('the re-issue stands the character up first, because a resting body cannot move',
     sent.some(x => x.name === 'rest' && x.stand === true));
  // A `walk_to` whose RPC timed out is NOT a walk that stopped. Issuing another on top of it
  // makes two orders fight for one body, and a re-plan then computes a route from a square
  // the body has already left. Room 39, 2026-09-10: three rounds of exactly that.
  ok('and it CANCELS the walk that is still running before issuing another',
     sent.some(x => x.name === 'cancel_movement'));
  ok('the cancel comes before the second walk_to, not after it', (() => {
    const cancel = sent.findIndex(x => x.name === 'cancel_movement');
    const walks = sent.map((x, i) => [x.name, i]).filter(([n]) => n === 'walk_to').map(([, i]) => i);
    return cancel > walks[0] && cancel < walks[1];
  })());
  ok('and the refusal names the tool that measures the ground instead of guessing',
     /m59-exitreport/.test(r.results.a1.state['0:walk_to'].why ?? ''));
}

console.log('\na trigger square is a walk whose SUCCESS is leaving the room');
{
  // Room 587 rows 15-17 x cols 1-6: h7.kod's SomethingMoved puts the body in room 27 at
  // r57c46. Arriving on the square and staying there is the failure case.
  const positions = { a1: { row: 20, col: 20 } };
  const rooms = { a1: 587 };
  fakeBroker({ rooms, positions,
    onWalkTo: ({ agent }) => { setTimeout(() => { rooms[agent] = 27; positions[agent] = { row: 57, col: 46 }; }, 30).unref?.(); },
  });
  const r = await fleetScript({ name: 'trigger', fleet: 'testfleet', agents: ['a1'],
    steps: [walkTo(4, 16, { leaveRoom: true, room: 587, pollMs: 20, deadlineMs: 4000 })],
    onLog: quiet });
  ok('being moved out of the room is the success', r.results.a1.ok === true);
  ok('and it says so rather than claiming an arrival',
     r.results.a1.state['0:walk_to'].outcome === 'left_the_room');

  // The same square, with nothing happening. A trigger that does not fire must not read as
  // a completed walk — that is the difference between "the door is gone" and "I arrived".
  fakeBroker({ rooms: { a1: 587 }, positions: { a1: { row: 16, col: 4 } } });
  const dud = await fleetScript({ name: 'dud trigger', fleet: 'testfleet', agents: ['a1'],
    steps: [walkTo(4, 16, { leaveRoom: true, room: 587, pollMs: 20, deadlineMs: 2000 })],
    onLog: quiet });
  ok('standing on a trigger that does not fire is a FAILURE, not an arrival',
     dud.results.a1.ok === false &&
     /did not fire/.test(dud.results.a1.state['0:walk_to'].why ?? ''));
}

console.log('\nA ROOM NUMBER THAT ARRIVED AS A STRING IS STILL A ROOM NUMBER');
{
  // MEASURED 2026-09-10, on the guild gather. Eight of twenty-one characters failed with
  // `did not reach 382 in three attempts` in a room they were ALREADY STANDING IN. The early
  // return was `at.room === to`, `at.room` is a number off the wire, and the caller had passed
  // `room` through from a command line -- so `382 === '382'` was false, the walk was re-issued
  // to the body's own room, the router correctly answered `no hops` (there is no route from a
  // room to itself), and the whole budget burned three times over.
  //
  // The log line was `walking 382 -> 382`, which is the bug printing itself in full and still
  // being easy to miss. Refusing the string would only have moved the failure to the caller: a
  // command line is where every string-shaped number in this repository comes from.
  fakeBroker({ rooms: { a1: 382 }, positions: { a1: { row: 20, col: 20 } } });
  const already = await fleetScript({ name: 'string dest', fleet: 'testfleet', agents: ['a1'],
    steps: [walk('382')], onLog: quiet });
  ok('a body already in the destination succeeds even when the destination is a string',
     already.results.a1.ok === true);

  // And it must still actually travel when it IS somewhere else, rather than coercing its way
  // into a false arrival.
  const rooms2 = { a1: 587 };
  fakeBroker({ rooms: rooms2, positions: { a1: { row: 20, col: 20 } },
    onTravel: ({ agent }) => { setTimeout(() => { rooms2[agent] = 382; }, 30).unref?.(); } });
  const moved = await fleetScript({ name: 'string dest walk', fleet: 'testfleet', agents: ['a1'],
    steps: [walk('382', { pollMs: 20 })], onLog: quiet });
  ok('and a string destination it has to travel to still arrives properly',
     moved.results.a1.ok === true);
}

console.log('\nand an ordinary walk that ends in a different room is a failure');
{
  const positions = { a1: { row: 20, col: 20 } };
  const rooms = { a1: 587 };
  fakeBroker({ rooms, positions,
    onWalkTo: ({ agent }) => { setTimeout(() => { rooms[agent] = 27; }, 30).unref?.(); },
  });
  const r = await fleetScript({ name: 'wandered', fleet: 'testfleet', agents: ['a1'],
    steps: [walkTo(4, 16, { room: 587, pollMs: 20, deadlineMs: 4000 })], onLog: quiet });
  ok('a body that ended up somewhere else did not do what was asked',
     r.results.a1.ok === false);
  ok('and the reason names the room it actually ended in',
     /room 27/.test(r.results.a1.state['0:walk_to'].why ?? ''));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
