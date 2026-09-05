#!/usr/bin/env node
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

// The run lock writes a real file; give it a scratch directory before importing the module.
const LOCK_DIR = mkdtempSync(join(tmpdir(), 'm59-fs-'));
process.env.M59_RUNLOCK_DIR = LOCK_DIR;
process.env.M59_CONTROL_URL = 'http://127.0.0.1:1/';   // never actually reached

const { fleetScript, walk, shop, bank, verify, sell, vault, VAULT_KEEP,
        foodIn, nonFoodIn, splitFood, FOOD_KEEP, purseOf } =
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
                      // Rooms the router cannot get to. Room 114 — the Barloque vaultman's
                      // office — was one of these for two of three couriers on 2026-09-02.
                      unreachable = new Set(),
                      shopItems = [{ id: 7, name: 'herb' }, { id: 8, name: 'elderberry' }],
                      // What the vaultman does with a deposit. The default is a counter that
                      // takes what it is offered; pass one that stores nothing to check the
                      // step does not read that as a failure.
                      vault = null } = {}) {
  const sent = [];
  globalThis.fetch = async (_url, opts) => {
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
                  hp, gold: null };
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
    else payload = { ok: true };
    return { json: async () => ({ result: { content: [{ text: JSON.stringify(payload) }] } }) };
  };
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
  const r = await fleetScript({ name: 'mixed', fleet: 'testfleet', agents: ['a1', 'a2'],
    steps: [walk(54)], onLog: quiet });
  ok('the hurt one stops', r.results.a1.ok === false);
  ok('the healthy one still completes', r.results.a2.ok === true);
  ok('and the run reports partial success', r.ok === true);
}

console.log('\na banker refusal is prose, not an error');
{
  fakeBroker({ rooms: { a1: 54 } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
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
  const { trapCheck, KNOWN_TRAPS } = await import('./m59-fleetscript.mjs');

  ok('Ukgoth is on the list, with the reason an operator needs',
     /Relic of Qor/.test(KNOWN_TRAPS[599] ?? ''), KNOWN_TRAPS[599]);

  const why = trapCheck([walk(54), walk(599)]);
  ok('a plan that walks into it is refused', !!why, String(why));
  ok('and the refusal names the room and the mechanic',
     /599/.test(why ?? '') && /Relic of Qor/.test(why ?? ''));

  ok('an ordinary plan is not refused', trapCheck([walk(54), walk(39)]) === null);

  // Standing in one is the case that cost us: the errand cannot finish from there, and
  // retrying is what turned a stranding into hours of shuffling.
  const standing = trapCheck([walk(39)], { standingIn: 599 });
  ok('a character already standing in one is refused too', !!standing, String(standing));
  ok('and is told to get out first rather than to try again',
     /Get it out first/.test(standing ?? ''));
  ok('but only when the plan would actually walk it somewhere',
     trapCheck([], { standingIn: 599 }) === null);

  // THE RESCUE HAS TO BE ABLE TO GO IN. Refusing every trip into a trap would mean the only
  // way to recover a stranded character is a hand-written script — which is the thing this
  // file exists to stop being necessary.
  ok('a declared rescue may go in', trapCheck([walk(599)], { allowTraps: true }) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
