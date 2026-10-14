#!/usr/bin/env node
// m59-pvp-strategy-test.mjs — MODULAR PVP STRATEGIES (tools/m59-pvp-strategy.mjs), and the keeper's half
// of them in CombatMode.
//
//   node tools/m59-pvp-strategy-test.mjs
//
// Offline. Opens no socket, starts no broker, touches no roster: the war book, alarms, grudges, PvP log,
// strategy directories and assignment file all live in a scratch directory set before the first import.
//
// The order, operator 2026-10-13: modular PvP strategies (engage, flee, ...) chosen per character through
// private mappings, with the current behaviour left as the default. What this pins:
//   - silence is the old behaviour: no assignment, no module, `default`, a typo, a throw, a slow or async
//     decide -- every one of them answers null and CombatMode does exactly what pvp-rooms-test pins;
//   - the assignment: agent beats character beats default, `null` stops the fall-through, names ignore case;
//   - the module search: local directory first, then M59_PVP_STRATEGY_PATH, then the dirs file; a name with
//     a path in it is refused; a module is reloaded when its file changes, without a restart;
//   - the closed decision set, and flee_to's room and hold validation;
//   - flee_to on a hit: the body is taken, the router walks to the room, the flight ends on arrival and the
//     keeper holds there; a hit on the road does not restart it and a war engagement does not preempt it;
//   - flee_to on a sighting (player_seen), at most once per player per room per window;
//   - already in the room: no flight, only the hold;
//   - a flight that does not arrive backs off; an operator's combat order is never preempted;
//   - engage lifts pvp_rooms for this room only: return fire where the list refused it;
//   - a menagerie host is never assigned anything; Autopilot.travel refuses keeper journeys out of a hold.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

const BOOKS = mkdtempSync(join(tmpdir(), 'm59-pvp-strategy-'));
process.env.M59_WAR_FILE = join(BOOKS, 'war.json');
process.env.M59_WAR_ALARM_FILE = join(BOOKS, 'war-alarms.jsonl');
process.env.M59_GRUDGE_FILE = join(BOOKS, 'grudges.json');
process.env.M59_PVP_HOLD_DIR = join(BOOKS, 'holds');
process.env.M59_PVP_DIR = join(BOOKS, 'pvp');
const LOCAL = join(BOOKS, 'local'), PRIVATE = join(BOOKS, 'private'), EXTRA = join(BOOKS, 'extra');
for (const d of [LOCAL, PRIVATE, EXTRA]) mkdirSync(d, { recursive: true });
const ENV = { M59_PVP_STRATEGY_DIR: LOCAL, M59_PVP_STRATEGY_PATH: PRIVATE,
  M59_PVP_STRATEGY_DIRS_FILE: join(BOOKS, 'dirs.json'), M59_PVP_STRATEGY_FILE: join(BOOKS, 'assign.json') };
writeFileSync(ENV.M59_PVP_STRATEGY_DIRS_FILE, JSON.stringify({ dirs: [EXTRA, join(BOOKS, 'missing')] }));

const ps = await import('./m59-pvp-strategy.mjs');
const war = await import('./m59-war.mjs');
const { CombatMode } = await import('./m59-combat-mode.mjs');
const { OF } = await import('./m59-parse.mjs');
const { bodyAuthority } = await import('./m59-body-command.mjs');
const { bindPacketScope } = await import('./m59-packet-scope.mjs');

let passed = 0, failed = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { passed++; console.log('  ok   ' + what); }
  else { failed++; console.log('  FAIL ' + what + (extra ? ' -- ' + extra : '')); }
};
const throwsLike = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

// ------------------------------------------------------------------ the assignment

console.log('the assignment');
{
  const book = { default: 'bastion', characters: { Camilla: { strategy: 'skirmish', options: { x: 1 } }, Loial: null },
    agents: { t9: 'runner' } };
  const r = (agent, character) => ps.resolveAssignment(book, { agent, character });
  ok('no book: nothing', ps.resolveAssignment(null, { agent: 't1' }) === null);
  ok('the default reaches anyone unnamed', r('t1', 'Kermit')?.strategy === 'bastion');
  ok('a character entry beats the default, options carried', r('t2', 'camilla')?.strategy === 'skirmish'
    && r('t2', 'camilla').options.x === 1);
  ok('an agent entry beats the character entry', r('t9', 'Camilla')?.strategy === 'runner');
  ok('null stops the fall-through: explicitly the default behaviour', r('hk1', 'Loial') === null);
  ok('a malformed entry is an error, not silence', throwsLike(() => ps.normalizeEntry(42), /assignment is/)
    && throwsLike(() => ps.normalizeEntry({ strategy: 'x', options: [] }), /options/));
}

console.log('the decision set');
{
  const v = d => ps.validateDecision(d);
  ok('null, "default" and {do:"default"} are silence', v(null).decision === null && v('default').decision === null
    && v({ do: 'default' }).decision === null && !v({ do: 'default' }).error);
  ok('an unknown verb is reported, never guessed at', v({ do: 'logoff' }).decision === null && /unknown decision/.test(v({ do: 'logoff' }).error));
  ok('engage is a decision', v('engage').decision?.do === 'engage');
  ok('flee_to needs a real room', v({ do: 'flee_to' }).error && v({ do: 'flee_to', room: 1 }).error && v({ do: 'flee_to', room: 'x' }).error);
  const f = v({ do: 'flee_to', room: 38, hold_ms: 99 * 3600_000 }).decision;
  ok('flee_to carries the room; the hold is clamped to the ceiling', f?.room === 38 && f.hold_ms === ps.MAX_HOLD_MS
    && f.max_ms === ps.DEFAULT_FLIGHT_MS && f.hold_orders === false, JSON.stringify(f));
  ok('hold_orders is carried only when it is literally true', v({ do: 'flee_to', room: 38, hold_orders: true }).decision.hold_orders === true
    && v({ do: 'flee_to', room: 38, hold_orders: 'yes' }).decision.hold_orders === false);
  ok('a negative hold is refused', !!v({ do: 'flee_to', room: 38, hold_ms: -1 }).error);
}

console.log('the module search');
{
  const mod = (dir, name, body) => writeFileSync(join(dir, `${name}.mjs`), body);
  mod(PRIVATE, 'shared', "export default { decide: () => ({ do: 'flee_to', room: 2 }) };");
  mod(LOCAL, 'shared', "export default { decide: () => ({ do: 'flee_to', room: 38 }) };");
  mod(EXTRA, 'extra-only', "export default { decide: () => 'engage' };");
  const dirs = ps.pvpStrategyDirs({ env: ENV });
  ok('local, then the path, then the dirs file', dirs[0] === LOCAL && dirs[1] === PRIVATE && dirs[2] === EXTRA, dirs.join(' | '));
  ok('the local file of the same name overrides the private one', ps.findPvpStrategy('shared', { env: ENV }) === join(LOCAL, 'shared.mjs'));
  ok('a dirs-file directory is searched', ps.findPvpStrategy('extra-only', { env: ENV }) === join(EXTRA, 'extra-only.mjs'));
  ok('a name with a path in it is refused', ps.findPvpStrategy('../local/shared', { env: ENV }) === null
    && ps.findPvpStrategy('a/b', { env: ENV }) === null);
}

console.log('the host');
{
  const assign = book => writeFileSync(ENV.M59_PVP_STRATEGY_FILE, JSON.stringify(book));
  writeFileSync(join(LOCAL, 'seen.mjs'),
    "export default { decide(m, f, o) { return m === 'player_seen' && f.player === o.enemy ? { do: 'flee_to', room: o.room, hold_ms: 1000 } : null; } };");
  assign({ characters: { Us: { strategy: 'seen', options: { enemy: 'Morpheus', room: 38 } } } });
  const h = new ps.PvpStrategyHost({ fleet: 'test', agent: 't1', character: 'Us', env: ENV });
  ok('before the first load: silence', h.decide('player_seen', { player: 'Morpheus' }) === null);
  await h.refresh();
  ok('loaded from the local directory', h.status().loaded && h.status().strategy === 'seen', JSON.stringify(h.status()));
  const d = h.decide('player_seen', { player: 'Morpheus', room: 576 });
  ok('the module answers with its options; the strategy name is attached', d?.do === 'flee_to' && d.room === 38
    && d.hold_ms === 1000 && d.strategy === 'seen', JSON.stringify(d));
  ok('a moment outside the set is never asked', h.decide('died', { player: 'Morpheus' }) === null);
  ok('a player the module does not name: silence', h.decide('player_seen', { player: 'Bob' }) === null);
  // Reloaded when the file changes, no restart.
  writeFileSync(join(LOCAL, 'seen.mjs'), "export default { decide: () => ({ do: 'flee_to', room: 714 }) };");
  const later = new Date(Date.now() + 5000); utimesSync(join(LOCAL, 'seen.mjs'), later, later);
  await h.refresh();
  ok('an edited module is reloaded on the next refresh', h.decide('player_seen', { player: 'X' })?.room === 714);
  // Bad modules: a throw, a promise, a bad verb. Each is silence; three strikes stand it down.
  writeFileSync(join(LOCAL, 'bad.mjs'), "export default { decide(m, f) { if (f.player === 'T') throw new Error('boom'); " +
    "if (f.player === 'P') return Promise.resolve('engage'); if (f.player === 'V') return { do: 'dance' }; return 'engage'; } };");
  assign({ default: 'bad' });
  const b = new ps.PvpStrategyHost({ fleet: 'test', agent: 't2', character: 'Them', env: ENV });
  await b.refresh();
  ok('a bad verb is silence and reported', b.decide('player_seen', { player: 'V' }) === null && /unknown decision/.test(b.status().error));
  ok('a good answer still works', b.decide('player_seen', { player: 'G' })?.do === 'engage');
  ok('a throw is silence and a strike', b.decide('player_seen', { player: 'T' }) === null && b.strikes === 1);
  ok('a promise is silence and a strike', b.decide('player_seen', { player: 'P' }) === null && b.strikes === 2);
  b.decide('player_seen', { player: 'T' });
  ok('three strikes stand the module down', b.decide('player_seen', { player: 'G' }) === null);
  const host = new ps.PvpStrategyHost({ fleet: 'test', agent: 'hk1', character: 'Them', isHost: true, env: ENV });
  await host.refresh();
  ok('a menagerie host is never given a strategy, even by a default', host.decide('player_seen', { player: 'G' }) === null
    && !host.status().loaded);
  assign({ default: 'nonexistent' });
  const n = new ps.PvpStrategyHost({ fleet: 'test', agent: 't3', character: 'X', env: ENV });
  await n.refresh();
  ok('an assigned module that does not exist: silence, and it says where it looked',
    n.decide('player_seen', { player: 'G' }) === null && /no strategy module/.test(n.status().error ?? ''));
}

// ------------------------------------------------------------------ CombatMode, end to end

const P = OF.PLAYER | OF.ATTACKABLE;
const OURS = new Set(['us', 'statler']);
const reset = () => {
  writeFileSync(process.env.M59_WAR_FILE, JSON.stringify({ format: 'm59-war/1', enemy_guilds: {}, members: {} }));
  writeFileSync(process.env.M59_WAR_ALARM_FILE, ''); writeFileSync(process.env.M59_GRUDGE_FILE, '{}');
};
function fixture({ room = 576, pvpRooms = [38], strategy = null, travel = 'arrive' } = {}) {
  let clock = Date.now();
  const sent = [], lines = [], travels = [], timers = new Map(); let timerId = 0;
  const c = { selfId: 1, self: { id: 1, nameRsc: 1, row: 5, col: 5, flags: OF.SAFETY },
    room: { id: 3800, objects: new Map() },
    rsc: new Map([[1, 'Us'], [2, 'Morpheus'], [3, 'Bob']]), spells: [], hp: 100,
    vitals() { return { health: { value: this.hp, max: 100 } }; },
    stand() { sent.push('stand'); }, face() { sent.push('face'); }, attack(id) { sent.push(`attack:${id}`); },
    look(id) { sent.push(`look:${id}`); },
    safety(on) { sent.push('safety:' + on); this.self.flags = on ? OF.SAFETY : 0; } };
  const s = { name: 'Us', client: c, live: true, combatEpoch: 0, movementGeneration: 0, fightGeneration: 0,
    job: null, need: () => c, recorder: { line: (kind, row) => lines.push({ kind, ...row }) },
    world: { room: { num: room }, geometry: { rows: 50, cols: 70, standable: () => true,
      path: (r, col, tr, tc) => ({ found: true, steps: [{ row: r + Math.sign(tr - r), col: col + Math.sign(tc - col) }] }) } },
    cancelMovement() { this.movementGeneration++; },
    async travel(to, opts) {
      travels.push({ to, opts });
      if (travel === 'arrive') { s.world.room.num = to; return { arrived: true }; }
      return { arrived: false, reason: 'no route' };
    },
    async step(col, row) { return this.pacer.submit('move', () => { sent.push(`move:r${row}c${col}`); c.self.row = row; c.self.col = col; }); } };
  s.pacer = { async submit(kind, fn) { const a = bodyAuthority(s), run = bindPacketScope(kind, a.bind(fn));
    await Promise.resolve(); a.guard(); return run(); } };
  const keeper = { policy: { fleeBelow: 0.4, pvpRooms }, revive() {} };
  const mode = s.combat = new CombatMode(s, { keeper: () => keeper, now: () => clock,
    schedule(fn) { const id = ++timerId; timers.set(id, fn); return id; }, unschedule: id => timers.delete(id) });
  mode.character = () => 'Us';
  mode.fleetmate = n => OURS.has(String(n).toLowerCase());
  mode.warEligibility = () => true;
  const asked = [];
  if (strategy) mode.pvpStrategy = { decide(moment, facts) { asked.push({ moment, ...facts }); return strategy(moment, facts); } };
  return { s, c, sent, lines, travels, keeper, mode, asked, advance(ms) { clock += ms; } };
}
const put = (f, id, flags) => f.c.room.objects.set(id, { id, nameRsc: id, row: 5, col: 6, flags });
const hitBy = f => f.mode.event({ kind: 'message', text: "Morpheus's scimitar cleaves you." });
// A bastion, in the module's own terms: flee to 38 from anywhere else on a hit or on Morpheus.
const bastion = (moment, f) => f.room === 38 ? null
  : (moment === 'attacked_by_player' || f.player === 'Morpheus') ? { do: 'flee_to', room: 38, hold_ms: 600_000, hold_orders: true, max_ms: 600_000, strategy: 'bastion' } : null;

console.log('combat mode: silence is the old behaviour');
{
  reset(); const f = fixture({ room: 576 });
  put(f, 2, P); hitBy(f); await f.mode.tick();
  ok('no strategy: outside pvp_rooms the hit is not answered and the body is not taken',
    !f.mode.active && f.s.movementGeneration === 0 && !f.travels.length, f.sent.join());
}
{
  reset(); const f = fixture({ room: 576, strategy: () => null });
  put(f, 2, P); hitBy(f); await f.mode.tick();
  ok('a strategy that answers null: the same', !f.mode.active && !f.travels.length);
  ok('...but it was asked, with the facts', f.asked.some(a => a.moment === 'attacked_by_player' && a.player === 'Morpheus'
    && a.room === 576 && a.pvp_allowed_here === false && a.health_pct === 100), JSON.stringify(f.asked));
}

console.log('combat mode: flee_to on a hit');
{
  reset(); const f = fixture({ room: 576, strategy: bastion });
  put(f, 2, P); hitBy(f);
  ok('the body is taken for the flight', f.mode.active?.flight?.room === 38 && f.mode.active.phase === 'fleeing'
    && f.s.movementGeneration > 0, JSON.stringify(f.mode.status().flight));
  ok('the attacked alarm still goes out', war.readAlarms().some(a => a.enemy === 'Morpheus' && a.basis === 'attacked'));
  hitBy(f);
  ok('a second blow does not restart the flight', f.lines.filter(l => l.event === 'pvp_strategy_flight').length === 1);
  ok('a war engagement does not preempt it', f.mode.beginWar('Morpheus', { basis: 'war_flag', room: 576 }) === false
    && f.mode.active?.flight);
  await f.mode.tick();
  ok('the router walked to the bastion', f.travels.length === 1 && f.travels[0].to === 38
    && /pvp_strategy/.test(JSON.stringify(f.travels[0].opts.origin)), JSON.stringify(f.travels));
  ok('the flight ends on arrival', !f.mode.active && f.mode.lastFlight?.outcome === 'arrived', JSON.stringify(f.mode.lastFlight));
  ok('and the keeper holds there', f.keeper.pvpStrategyHold?.room === 38 && f.keeper.pvpStrategyHold.until > Date.now(),
    JSON.stringify(f.keeper.pvpStrategyHold));
  ok('the hold carries the strategy\'s hold_orders', f.keeper.pvpStrategyHold?.orders === true);
  ok('a decision line names the strategy and the room', f.lines.some(l => l.event === 'pvp_strategy_decision'
    && l.strategy === 'bastion' && l.to === 38 && l.moment === 'attacked_by_player'));
  ok('status reports the strategy and the last flight', f.mode.status().pvp_strategy?.last_flight?.room === 38);
}
{
  reset(); const f = fixture({ room: 38, strategy: bastion });
  put(f, 2, P); hitBy(f); await f.mode.tick();
  ok('in the bastion: no flight; pvp_rooms decides, and 38 is listed, so return fire as before',
    !f.travels.length && !!f.mode.active?.pvp && f.sent.includes('attack:2'), f.sent.join());
  f.mode.stop('test');
}
{
  reset(); const f = fixture({ room: 38, strategy: () => ({ do: 'flee_to', room: 38, hold_ms: 1000, strategy: 's' }) });
  put(f, 2, P); hitBy(f);
  ok('flee_to the room already stood in: no flight, only the hold', !f.mode.active?.flight && f.keeper.pvpStrategyHold?.room === 38);
  f.mode.stop('test');
}
{
  reset(); const f = fixture({ room: 576, strategy: bastion, travel: 'fail' });
  put(f, 2, P); hitBy(f); await f.mode.tick();
  ok('a flight that cannot arrive ends, and says why', !f.mode.active && f.mode.lastFlight?.outcome === 'stopped'
    && /no route/.test(f.mode.lastFlight.end_reason), JSON.stringify(f.mode.lastFlight));
  hitBy(f);
  ok('and backs off before the next one', !f.mode.active?.flight && f.travels.length === 1);
  f.advance(20_000); hitBy(f);
  ok('after the backoff it flies again', !!f.mode.active?.flight);
  f.mode.stop('test');
}
{
  reset(); const f = fixture({ room: 576, strategy: bastion });
  f.mode.active = { id: 'op', order: { action: 'kill', target: 'X' }, client: f.c, phase: 'waiting' };
  ok("an operator's combat order is never preempted by a strategy", f.mode.beginFlight({ do: 'flee_to', room: 38 }, 'Morpheus', 'attacked') === false
    && f.mode.active.id === 'op');
}

console.log('combat mode: flee_to on a sighting');
{
  reset(); const f = fixture({ room: 576, strategy: bastion });
  put(f, 3, P); f.mode.event({ kind: 'appeared', id: 3 });
  ok('a stranger the strategy does not name: nothing', !f.mode.active && f.asked.some(a => a.moment === 'player_seen' && a.player === 'Bob'));
  const before = f.asked.length;
  f.mode.event({ kind: 'changed', id: 3 });
  ok('asked at most once per player per room per window', f.asked.length === before);
  put(f, 2, P); f.mode.event({ kind: 'appeared', id: 2 });
  ok('Morpheus in the room: the flight starts without a blow', f.mode.active?.flight?.trigger === 'sighted'
    && f.mode.active.flight.threat === 'Morpheus');
  ok('the sighting alarm goes out', war.readAlarms().some(a => a.enemy === 'Morpheus' && a.basis === 'sighted'));
  ok('a hostile verdict is part of the facts', f.asked.find(a => a.player === 'Morpheus')?.hostile === false);
  await f.mode.tick();
  ok('and it lands in 38', f.s.world.room.num === 38 && f.mode.lastFlight?.outcome === 'arrived');
}

console.log('combat mode: engage');
{
  reset(); const f = fixture({ room: 576, pvpRooms: [38], strategy: (m, x) => x.room === 576 ? { do: 'engage', strategy: 'brawl' } : null });
  put(f, 2, P); hitBy(f); await f.mode.tick();
  ok('engage lifts our room list here: return fire where pvp_rooms refused it',
    !!f.mode.active?.pvp && f.sent.includes('attack:2'), f.sent.join());
  f.mode.stop('test');
  f.s.world.room.num = 577;
  ok('and only in that room', !!f.mode.pvpRoomsRefusal());
}

console.log('the keeper');
{
  const src = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'latin1');
  const i = src.indexOf('  async travel(room, opts) {');
  const body = src.slice(i, src.indexOf('\n  }\n', i));
  ok('Autopilot.travel refuses a keeper journey out of a strategy hold, and an explicit order only under hold_orders',
    /pvpStrategyHold/.test(body) && /\(!explicitOrder \|\| hold\.orders === true\) && Number\(room\) !== Number\(hold\.room\)/.test(body));
  // And the gate itself, run: the hold check sits right after the confinement, so a fake that passes the
  // gates before it reaches it. Driven through the real method with everything ahead of it stubbed.
  {
    const { Autopilot } = await import('./m59-autopilot.mjs');
    const notes = [];
    const fake = { policy: {}, s: { world: { room: { num: 38 } } }, suspendedJourney: null,
      note: (what, data) => notes.push({ what, ...data }),
      pvpReturnGate: () => null, approachLegs: async () => null, travelInterrupted: () => null,
      eatBeforeTravel: async () => null };
    const tryTravel = async (hold, opts) => { fake.pvpStrategyHold = hold; notes.length = 0;
      try { return await Autopilot.prototype.travel.call(fake, 599, opts); } catch (e) { return { threw: e.message }; } };
    const until = Date.now() + 60_000;
    const kept = await tryTravel({ room: 38, until, orders: false }, {});
    ok('a keeper journey out of the hold is refused, held: true', kept?.held === true && kept.refused === true, JSON.stringify(kept));
    const order = await tryTravel({ room: 38, until, orders: false }, { explicitOrder: true });
    ok('an explicit order passes a plain hold', order?.held !== true, JSON.stringify(order));
    const strong = await tryTravel({ room: 38, until, orders: true }, { explicitOrder: true });
    ok('hold_orders refuses the explicit order too (a director would walk the unit back out)',
      strong?.held === true && notes.some(n => n.orders_held === true && n.explicit === true), JSON.stringify(strong));
    const expired = await tryTravel({ room: 38, until: Date.now() - 1, orders: true }, { explicitOrder: true });
    ok('an expired hold is cleared and refuses nothing', expired?.held !== true && fake.pvpStrategyHold === null, JSON.stringify(expired));
  }
  const kp = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'latin1');
  ok('the keeper process gives every character a host, refreshed off the event path, hosts marked',
    /new PvpStrategyHost\(\{[^}]*isHost: isHostCharacter/.test(kp) && /pvpStrategy\.refresh\(\)/.test(kp));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
