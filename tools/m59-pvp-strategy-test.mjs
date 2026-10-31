#!/usr/bin/env node
import { readToolSource } from './autopilot/source.mjs';
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
//   - aggress (player_seen) makes an attackable stranger a war-book hostile, basis aggressor, safety on, inside
//     pvp_rooms only; never a fleet-mate, never a non-ATTACKABLE body, never a refused target; it expires;
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
process.env.M59_PLAYER_HEALTH_FILE = join(BOOKS, 'player-health.jsonl');
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
  const w = v({ do: 'flee_to', room: 599, via: 598, row: 3, col: 65 }).decision;
  ok('flee_to carries a way in and a post', w?.via === 598 && w.row === 3 && w.col === 65, JSON.stringify(w));
  ok('...and without them carries neither', !('via' in f) && !('row' in f) && !('col' in f));
  ok('a way in that is the room itself, or not a room, is refused', !!v({ do: 'flee_to', room: 599, via: 599 }).error
    && !!v({ do: 'flee_to', room: 599, via: 1 }).error && !!v({ do: 'flee_to', room: 599, via: 'x' }).error);
  ok('a post is a whole square, given together', !!v({ do: 'flee_to', room: 599, row: 3 }).error
    && !!v({ do: 'flee_to', room: 599, row: 3, col: 6.5 }).error);
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
  writeFileSync(join(LOCAL, 'old.mjs'), "export default { decide: () => 'engage' };");
  writeFileSync(join(LOCAL, 'next.mjs'), "export default { moments: ['player_seen', 'alarm_elsewhere'], decide: () => 'engage' };");
  assign({ agents: { t5: 'old', t6: 'next' } });
  const old = new ps.PvpStrategyHost({ fleet: 'test', agent: 't5', character: 'A', env: ENV }); await old.refresh();
  const nxt = new ps.PvpStrategyHost({ fleet: 'test', agent: 't6', character: 'B', env: ENV }); await nxt.refresh();
  ok('alarm_elsewhere is opt-in: a module that does not list it is never asked',
    old.decide('alarm_elsewhere', { player: 'G' }) === null && old.decide('player_seen', { player: 'G' })?.do === 'engage');
  ok('a module that lists its moments hears exactly those', nxt.decide('alarm_elsewhere', { player: 'G' })?.do === 'engage'
    && nxt.decide('attacked_by_player', { player: 'G' }) === null);
  assign({ default: 'bad' });
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

console.log('combat mode: flee_to by way of a neighbour, to a post');
{
  // UKGOTH, 2026-10-20. Its NE corner is reached only from the Cragged Mountains (598): entered from 589 or 2 a
  // fled body lands on the far island. So the flight walks to 598 planning AROUND 599, steps in, and posts.
  const ukgoth = () => ({ do: 'flee_to', room: 599, via: 598, row: 3, col: 65, hold_ms: 600_000, hold_orders: true, strategy: 'bastion' });
  reset(); const f = fixture({ room: 579, strategy: ukgoth });
  const walks = []; f.s.walkTo = async (col, row) => { walks.push({ col, row }); return { arrived: true }; };
  put(f, 2, P); hitBy(f);
  ok('the flight carries its way in and its post', f.mode.active?.flight?.via === 598 && f.mode.active.flight.post?.row === 3);
  await f.mode.tick();
  ok('it walks to the way in first, planning around the bastion', f.travels.length === 2 && f.travels[0].to === 598
    && JSON.stringify(f.travels[0].opts.avoid) === '[599]', JSON.stringify(f.travels.map(t => [t.to, t.opts.avoid])));
  ok('then steps in, asking to land near the post', f.travels[1].to === 599 && f.travels[1].opts.arriveNear?.col === 65
    && f.travels[1].opts.arriveNear.row === 3);
  ok('and walks to the post', walks.length === 1 && walks[0].col === 65 && walks[0].row === 3, JSON.stringify(walks));
  ok('it ends arrived, held, and says how it came in', f.mode.lastFlight?.outcome === 'arrived' && f.keeper.pvpStrategyHold?.room === 599
    && f.mode.lastFlight.via_result?.arrived === true && f.mode.lastFlight.post?.arrived === true, JSON.stringify(f.mode.lastFlight));
  ok('the way in is a combat line', f.lines.some(l => l.event === 'pvp_strategy_flight_via' && l.via === 598 && l.arrived === true));
}
{
  reset(); const f = fixture({ room: 598, strategy: () => ({ do: 'flee_to', room: 599, via: 598, strategy: 'bastion' }) });
  put(f, 2, P); hitBy(f); await f.mode.tick();
  ok('already standing in the way in: one step, straight in', f.travels.length === 1 && f.travels[0].to === 599
    && !f.travels[0].opts.arriveNear && f.mode.lastFlight?.outcome === 'arrived', JSON.stringify(f.travels));
}
{
  reset(); const f = fixture({ room: 579, strategy: () => ({ do: 'flee_to', room: 599, via: 598, strategy: 'bastion' }) });
  const plain = f.s.travel.bind(f.s);
  f.s.travel = async (to, opts) => to === 598 ? (f.travels.push({ to, opts }), { arrived: false, reason: 'no route' }) : plain(to, opts);
  put(f, 2, P); hitBy(f); await f.mode.tick();
  ok('a way in that fails is recorded, and the flight goes straight in', f.travels.map(t => t.to).join() === '598,599'
    && f.mode.lastFlight?.outcome === 'arrived' && f.mode.lastFlight.via_result?.arrived === false
    && /no route/.test(f.mode.lastFlight.via_result.reason), JSON.stringify(f.mode.lastFlight));
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

console.log('the sortie decision');
{
  const v = d => ps.validateDecision(d);
  ok('sortie needs a home that is a room and not its own room', !!v({ do: 'sortie', room: 2 }).error
    && !!v({ do: 'sortie', room: 2, home: 2 }).error && !!v({ do: 'sortie', room: 2, home: 1 }).error);
  const d = v({ do: 'sortie', room: 2, home: 38, row: 4, col: 42 }).decision;
  ok('sortie carries room, home, square and the default clocks', d?.do === 'sortie' && d.room === 2 && d.home === 38
    && d.row === 4 && d.col === 42 && d.max_ms === ps.DEFAULT_SORTIE_MS && d.idle_ms === ps.DEFAULT_SORTIE_IDLE_MS
    && d.home_hold_ms === 0, JSON.stringify(d));
  ok('a square is row AND col, whole squares', !!v({ do: 'sortie', room: 2, home: 38, row: 4 }).error
    && !!v({ do: 'sortie', room: 2, home: 38, row: 4.5, col: 3 }).error);
  ok('max_ms is clamped to the sortie ceiling', v({ do: 'sortie', room: 2, home: 38, max_ms: 99 * 3600_000 }).decision.max_ms === ps.SORTIE_MAX_MS);
  ok('no square is a whole-map sortie', !('row' in v({ do: 'sortie', room: 2, home: 38 }).decision));
}

console.log('combat mode: sortie');
const HOSTILE = P | OF.ENEMY;
const runner = (m, x) => x.sortie_room ? null
  : (x.room === 38 && x.hostile) ? { do: 'sortie', room: 2, home: 38, row: 4, col: 42, max_ms: 120_000, idle_ms: 20_000,
      home_hold_ms: 60_000, strategy: 'double-down' } : null;
const walker = f => { const walks = []; f.s.walkTo = async (col, row) => { walks.push({ row, col }); f.c.self.row = row; f.c.self.col = col; return { arrived: true }; }; return walks; };
{
  reset(); const f = fixture({ room: 38, pvpRooms: [38], strategy: runner }); const walks = walker(f);
  put(f, 2, HOSTILE); f.mode.event({ kind: 'appeared', id: 2 });
  ok('a hostile entering the bastion sends the runner OUT: the body is taken as a flight',
    f.mode.active?.flight?.room === 2 && f.mode.active.flight.sortie && f.mode.sortie?.phase === 'going',
    JSON.stringify(f.mode.status().pvp_strategy));
  ok('the facts counted the hostile', f.asked.some(a => a.hostiles_here === 1 && a.allies_here === 0), JSON.stringify(f.asked));
  ok('the walk out ignores the fight it is leaving: no war engagement preempts it',
    f.mode.beginWar('Morpheus', { basis: 'war_flag', room: 38 }) === false && !!f.mode.active?.flight);
  f.c.room.objects.clear();
  await f.mode.tick();
  ok('the router walked to the sortie map, then to the post square', f.travels.at(-1)?.to === 2 && walks.at(-1)?.row === 4 && walks.at(-1)?.col === 42,
    JSON.stringify({ travels: f.travels.map(t => t.to), walks }));
  ok('posted: no active order, sortie posted', !f.mode.active && f.mode.sortie?.phase === 'posted' && f.mode.sortie.post?.arrived === true, JSON.stringify(f.mode.status().pvp_strategy));
  ok('our room list is lifted in the sortie map (pvp_rooms is [38])', f.mode.pvpRoomsRefusal() === null);
  ok('the keeper is held in the sortie map, explicit orders too', f.keeper.pvpStrategyHold?.room === 2 && f.keeper.pvpStrategyHold.orders === true);
  put(f, 2, HOSTILE); Object.assign(f.c.room.objects.get(2), { row: 4, col: 43 }); hitBy(f); await f.mode.tick();
  ok('a hit in the sortie map is answered with return fire', !!f.mode.active?.pvp && f.sent.includes('attack:2'), f.sent.join());
  f.mode.stop('test'); f.c.room.objects.clear();
  f.advance(10_000); f.mode.sortieTick();
  ok('still posted inside idle_ms', f.mode.sortie?.phase === 'posted');
  f.advance(25_000); f.mode.sortieTick();
  ok('quiet for idle_ms: the sortie ends and the body walks home as a flight', !f.mode.sortie && f.mode.lastSortie?.phase === 'ended'
    && /no hostile/.test(f.mode.lastSortie.end_reason) && f.mode.active?.flight?.room === 38, JSON.stringify(f.mode.lastSortie));
  ok('the sortie hold and the lifted room list are gone', !f.keeper.pvpStrategyHold?.sortie && !f.mode.strategyEngage?.sortie);
  await f.mode.tick();
  ok('home, and held there for home_hold_ms', f.s.world.room.num === 38 && f.keeper.pvpStrategyHold?.room === 38);
}
{
  reset(); const f = fixture({ room: 38, pvpRooms: [38], strategy: runner }); walker(f);
  put(f, 2, HOSTILE); f.mode.event({ kind: 'appeared', id: 2 }); f.c.room.objects.clear(); await f.mode.tick();
  f.s.world.room.num = 599; f.mode.sortieTick();
  ok('ONE MAP OUT: a body anywhere else ends the sortie and walks home, never onward',
    !f.mode.sortie && /left the sortie map for 599/.test(f.mode.lastSortie?.end_reason) && f.mode.active?.flight?.room === 38);
  await f.mode.tick();
  ok('and the walk is to home, not further', f.travels.map(t => t.to).join() === '2,38', f.travels.map(t => t.to).join());
}
{
  const retreat = (m, x) => x.sortie_room === 2 && x.room === 2 && x.health_pct < 40 && x.allies_here + 1 <= x.hostiles_here
    ? { do: 'flee_to', room: 38, hold_ms: 60_000, strategy: 'double-down' } : runner(m, x);
  reset(); const f = fixture({ room: 38, pvpRooms: [38], strategy: retreat }); walker(f);
  put(f, 2, HOSTILE); f.mode.event({ kind: 'appeared', id: 2 }); f.c.room.objects.clear(); await f.mode.tick();
  f.c.hp = 30; put(f, 2, HOSTILE); hitBy(f);
  ok('a flee_to decided during a sortie replaces it: the retreat', !f.mode.sortie && /replaced by a flight to 38/.test(f.mode.lastSortie?.end_reason)
    && f.mode.active?.flight?.room === 38 && !f.mode.active.flight.sortie, JSON.stringify(f.mode.status().pvp_strategy));
  f.mode.stop('test');
}
{
  reset(); const f = fixture({ room: 2, pvpRooms: [38], strategy: (m, x) => ({ do: 'sortie', room: 2, home: 38, strategy: 'd' }) });
  put(f, 2, HOSTILE); hitBy(f); await f.mode.tick();
  ok('a sortie decided in its own map posts in place and the hit is still answered',
    f.mode.sortie?.phase === 'posted' && !f.travels.length && f.sent.includes('attack:2'), f.sent.join() + ' ' + JSON.stringify(f.mode.status()));
  f.mode.stop('test');
}

console.log('combat mode: a guard waits for the fight at home (wait_home_fight)');
{
  const guard = wait => (m, x) => x.sortie_room ? null : (x.room === 38 && x.hostile)
    ? { do: 'sortie', room: 2, home: 38, row: 4, col: 42, idle_ms: 20_000, wait_home_fight: wait, strategy: 'double-down' } : null;
  ok('wait_home_fight is carried only when literally true', ps.validateDecision({ do: 'sortie', room: 2, home: 38, wait_home_fight: true }).decision.wait_home_fight === true
    && ps.validateDecision({ do: 'sortie', room: 2, home: 38, wait_home_fight: 'yes' }).decision.wait_home_fight === false);
  for (const wait of [true, false]) {
    reset(); const f = fixture({ room: 38, pvpRooms: [38], strategy: guard(wait) }); walker(f);
    put(f, 2, HOSTILE); f.mode.event({ kind: 'appeared', id: 2 }); f.c.room.objects.clear(); await f.mode.tick();
    // The fight goes on in 38 for 50 s; the guard in 2 sees nobody, but hears the room's alarms every 10 s.
    for (let i = 0; i < 5; i++) {
      f.advance(10_000);
      f.mode.onWarAlarm({ at: Date.now() + (i + 1) * 10_000 + 0, room: 38, reporter: 'Statler', enemy: 'Morpheus', basis: 'engaged' });
      f.mode.alarmRoomAt.set(38, f.mode.now());   // the fixture clock, not the wall clock, is the keeper's now
      f.mode.sortieTick();
    }
    if (wait) ok('wait_home_fight: still posted after 50 s of fighting at home', f.mode.sortie?.phase === 'posted', JSON.stringify(f.mode.lastSortie));
    else ok('without it: home after idle_ms, whatever the fight at home', !f.mode.sortie && /no hostile/.test(f.mode.lastSortie?.end_reason), JSON.stringify(f.mode.lastSortie));
    if (wait) {
      f.mode.alarmRoomAt.set(599, f.mode.now());
      f.advance(25_000); f.mode.sortieTick();
      ok('a fight in some OTHER map does not hold it; home quiet for idle_ms ends it', !f.mode.sortie && /no hostile/.test(f.mode.lastSortie?.end_reason), JSON.stringify(f.mode.lastSortie));
    }
    f.mode.stop?.('test');
  }
}

console.log('combat mode: alarm_elsewhere');
{
  reset(); const f = fixture({ room: 38, pvpRooms: [38] });
  ok('no strategy: an alarm from another map is only a report', f.mode.onWarAlarm({ at: Date.now(), room: 2, reporter: 'Statler', enemy: 'Morpheus', basis: 'engaged' }) === false
    && !f.travels.length && !f.mode.active);
}
{
  const insider = (m, x) => m === 'alarm_elsewhere' && x.alarm_room === 2 && x.hostiles_here === 0
    ? { do: 'sortie', room: 2, home: 38, idle_ms: 20_000, strategy: 'double-down' } : null;
  reset(); const f = fixture({ room: 38, pvpRooms: [38], strategy: insider }); walker(f);
  ok('a bare sighting next door is never asked', f.mode.onWarAlarm({ at: Date.now(), room: 2, reporter: 'Statler', enemy: 'Morpheus', basis: 'sighted' }) === false
    && !f.asked.length);
  ok('a fight next door asks the strategy, which sorties', f.mode.onWarAlarm({ at: Date.now(), room: 2, reporter: 'Statler', enemy: 'Morpheus', basis: 'engaged' }) === true
    && f.asked.some(a => a.moment === 'alarm_elsewhere' && a.alarm_room === 2 && a.reporter === 'Statler' && a.player === 'Morpheus')
    && f.mode.sortie?.room === 2, JSON.stringify(f.asked));
  const n = f.asked.length;
  f.mode.onWarAlarm({ at: Date.now(), room: 2, reporter: 'Statler', enemy: 'Morpheus', basis: 'attacked' });
  ok('asked at most once per map and enemy per window', f.asked.length === n);
  await f.mode.tick();
  ok('and it lands in the fight next door', f.s.world.room.num === 2 && f.mode.sortie?.phase === 'posted', JSON.stringify(f.mode.status()));
}

console.log('groans: health bands off the pain sound');
{
  const ph = await import('./m59-player-health.mjs');
  const { parseAudio } = await import('./m59-audio-observations.mjs');
  ok('the eight pain sounds are the four bands; anything else is not a groan',
    ph.groanBand('ouchm1')?.band === 1 && ph.groanBand('ouchf4')?.band === 4 && ph.groanBand('ouchf4').gender === 'f'
    && ph.groanBand('ouchm5') === null && ph.groanBand('hit') === null && ph.groanBand(null) === null);
  ok('the bands are the kod thresholds (GetOuchSound: >75, >50, >25, else)',
    ph.GROAN_BANDS[1].min_pct === 76 && ph.GROAN_BANDS[2].max_pct === 75 && ph.GROAN_BANDS[3].max_pct === 50 && ph.GROAN_BANDS[4].max_pct === 25);
  const b = Buffer.alloc(25); b.writeUInt32LE(901, 0); b.writeUInt32LE(2, 4); b[8] = 0;
  const a = parseAudio(170, b, new Map([[901, 'ouchm3.wav']]));
  ok('a BP_PLAY_WAVE of ouchm3 names its source object and reads band 3', a?.source === 2 && ph.groanBand(a.stem)?.band === 3, JSON.stringify(a));
  const src = readToolSource(new URL('./m59-client.mjs', import.meta.url), 'utf8');
  ok('the client emits it as a groan event with the source', /this\.emit\('groan', \{ source: a\.source, band: g\.band/.test(src));
  ph.resetHealthCache();
  const t0 = Date.now();
  ok('recorded once a second per player and band', ph.recordGroan({ name: 'Morpheus', band: 2, at: t0 }) === true
    && ph.recordGroan({ name: 'Morpheus', band: 2, at: t0 + 10 }) === false);
  ph.recordGroan({ name: 'Morpheus', band: 4, room: 38, reporter: 'Us', at: t0 + 20 });
  const h = ph.latestHealth('morpheus', { now: t0 + 1000 });
  ok('the latest reading wins, by name in any case', h?.band === 4 && h.max_pct === 25 && h.room === 38 && h.age_ms === 980, JSON.stringify(h));
  ok('an old reading is no reading', ph.latestHealth('Morpheus', { now: t0 + 200_000, maxAgeMs: 120_000 }) === null);
  ok('nobody heard: null', ph.latestHealth('Bob', { now: t0 + 1000 }) === null);
  ph.resetHealthCache();
}
{
  reset(); const ph = await import('./m59-player-health.mjs'); ph.resetHealthCache();
  const f = fixture({ room: 38, strategy: () => null });
  put(f, 2, P | OF.ENEMY); put(f, 1, P);
  f.mode.event({ kind: 'groan', source: 2, band: 3 });
  f.mode.event({ kind: 'groan', source: 1, band: 1 });
  ok('CombatMode records a groan from a player who is not ours, never our own', ph.latestHealth('Morpheus')?.band === 3
    && ph.latestHealth('Us') === null && f.mode.lastGroan?.name === 'Morpheus');
  f.mode.event({ kind: 'appeared', id: 2 });
  ok('and the strategy sees it as player_health', f.asked.some(a => a.player === 'Morpheus' && a.player_health?.band === 3 && a.player_health.max_pct === 50),
    JSON.stringify(f.asked.map(a => a.player_health)));
  ph.resetHealthCache();
}

console.log('combat mode: hold_fire');
{
  const v = d => ps.validateDecision(d);
  ok('hold_fire is a decision with a bounded window', v('hold_fire').decision?.ms === ps.HOLD_FIRE_MS
    && v({ do: 'hold_fire', ms: 10 * 60_000 }).decision.ms === ps.HOLD_FIRE_MAX_MS && !!v({ do: 'hold_fire', ms: -1 }).error);
  reset(); const f = fixture({ room: 38, pvpRooms: [38], strategy: (m, x) => x.player === 'Morpheus' ? { do: 'hold_fire', ms: 6000, strategy: 'd' } : null });
  put(f, 2, P | OF.ENEMY); f.mode.event({ kind: 'appeared', id: 2 });
  ok('a held hostile is not engaged on sight', !f.mode.active?.pvp, JSON.stringify(f.mode.status().war));
  ok('nor by a fleet-mate\'s alarm in this room', f.mode.onWarAlarm({ at: Date.now(), room: 38, reporter: 'Statler', enemy: 'Morpheus', basis: 'engaged' }) === false);
  hitBy(f); await f.mode.tick();
  ok('but a hit is still answered: hold_fire never stops return fire', !!f.mode.active?.pvp && f.sent.includes('attack:2'), f.sent.join());
  f.mode.stop('test');
  f.advance(7000);
  ok('the hold lapses unless decided again', f.mode.fireHeld('Morpheus') === false);
}
{
  reset(); const f = fixture({ room: 38, pvpRooms: [38], strategy: () => null });
  put(f, 2, P | OF.ENEMY); f.mode.event({ kind: 'appeared', id: 2 });
  ok('without hold_fire the same hostile IS engaged on sight (the control)', !!f.mode.active?.pvp, JSON.stringify(f.mode.status().war));
  f.mode.stop('test');
}

console.log('combat mode: aggress');
{
  // Operator, 2026-10-31: a member of an aggressor guild who is ALSO attackable under the faction-shield rules
  // is a target. The STRATEGY decides that; the harness only carries it through the war response, safety on.
  const v = d => ps.validateDecision(d);
  ok('aggress is a decision with a bounded window', v('aggress').decision?.ms === ps.AGGRESS_MS
    && v({ do: 'aggress', ms: 99 * 60_000 }).decision.ms === ps.AGGRESS_MAX_MS && !!v({ do: 'aggress', ms: 0 }).error
    && !!v({ do: 'aggress', ms: 'x' }).error);
  ok('an unknown verb is still refused, a near miss included', v({ do: 'aggresss' }).decision === null
    && /unknown decision/.test(v({ do: 'aggresss' }).error) && v({ do: 'attack' }).decision === null);
}
const aggr = (who = 'Bob', ms = 30_000) => (m, x) => m === 'player_seen' && x.player === who ? { do: 'aggress', ms, strategy: 'aggr', why: 'aggressor guild, shield-attackable' } : null;
{
  reset(); const f = fixture({ room: 38, pvpRooms: [38], strategy: aggr() });
  put(f, 3, P); f.mode.event({ kind: 'appeared', id: 3 });
  ok('an attackable stranger the strategy names is engaged on sight, the scan it was decided in',
    !!f.mode.active?.pvp && f.mode.active.pvp.attackers.some(a => a.character === 'Bob'), JSON.stringify(f.mode.status().war));
  ok('with verdict basis aggressor', f.mode.status().war.last?.basis === 'aggressor' && f.mode.status().war.last.enemy === 'Bob');
  ok('safety stays ON: a war engagement keeps it', f.mode.active?.keepSafety === true);
  ok('the room hears it as an engagement alarm, basis aggressor', war.readAlarms().some(a => a.enemy === 'Bob' && a.basis === 'aggressor'));
  ok('the decision is remembered and reported', f.mode.aggressor('Bob')?.strategy === 'aggr'
    && f.mode.status().pvp_strategy?.aggress?.bob?.until > Date.now());
  await f.mode.tick();
  ok('and the attack goes out with safety never lowered', f.sent.includes('attack:3') && !f.sent.some(x => x === 'safety:false'), f.sent.join());
  // The server refuses the blow (Bob was not attackable after all): remembered, and not re-engaged here.
  f.mode.event({ kind: 'message', text: 'Hey! You almost hit Bob! Good thing your safety was on!' });
  await f.mode.tick();
  ok('a server refusal is remembered for this room', !!f.mode.targetRefused('Bob'), JSON.stringify(f.mode.refusedStatus()));
  f.mode.stop('test'); f.advance(6000);
  f.mode.event({ kind: 'changed', id: 3 });
  ok('and the refused target is not re-engaged, aggress or not', !f.mode.active?.pvp && f.asked.filter(a => a.player === 'Bob').length >= 2
    && !f.sent.some(x => x === 'safety:false'), JSON.stringify(f.mode.status().war));
}
{
  reset(); const f = fixture({ room: 38, pvpRooms: [38], strategy: () => null });
  put(f, 3, P); f.mode.event({ kind: 'appeared', id: 3 });
  ok('without aggress the same stranger is NOT engaged (the control)', !f.mode.active?.pvp && !f.mode.aggress.size);
}
{
  reset(); const f = fixture({ room: 576, pvpRooms: [38], strategy: aggr() });
  put(f, 3, P); f.mode.event({ kind: 'appeared', id: 3 });
  ok('outside pvp_rooms aggress lifts nothing: no engagement', !f.mode.active?.pvp, JSON.stringify(f.mode.status().war));
  ok('...only a sighting, reported as one', war.readAlarms().some(a => a.enemy === 'Bob' && a.basis === 'sighted')
    && f.mode.status().war.last?.basis === 'sighted' && !!f.mode.pvpRoomsRefusal());
}
{
  reset(); const f = fixture({ room: 38, pvpRooms: [38], strategy: () => ({ do: 'aggress', strategy: 'everyone' }) });
  f.c.rsc.set(4, 'Statler');
  put(f, 4, P); f.mode.event({ kind: 'appeared', id: 4 });
  ok('a fleet-mate is never asked about, never a target', !f.mode.active?.pvp && !f.asked.some(a => a.player === 'Statler'));
  ok('...and cannot be made one by hand', f.mode.noteAggress('Statler', { do: 'aggress' }) === null && f.mode.aggressor('Statler') === null);
  f.mode.aggress.set('statler', { until: Date.now() + 60_000 });
  f.mode.event({ kind: 'changed', id: 4 });
  ok('...not even with an entry forced into the window', !f.mode.active?.pvp && f.mode.aggressor('Statler') === null);
}
{
  reset(); const f = fixture({ room: 38, pvpRooms: [38], strategy: aggr() });
  put(f, 3, OF.PLAYER); f.mode.event({ kind: 'appeared', id: 3 });
  ok('not ATTACKABLE: not engaged, though the window is open', !f.mode.active?.pvp && !!f.mode.aggressor('Bob'));
  f.advance(1000); put(f, 3, P); f.mode.event({ kind: 'changed', id: 3 });
  ok('the window outlives the throttled consult: attackable a second later, engaged without being asked again',
    !!f.mode.active?.pvp && f.asked.filter(a => a.player === 'Bob' && a.moment === 'player_seen').length === 1, JSON.stringify(f.mode.status().war));
  f.mode.stop('test');
}
{
  let first = true;
  reset(); const f = fixture({ room: 38, pvpRooms: [38],
    strategy: (m, x) => { if (m !== 'player_seen' || x.player !== 'Bob') return null; const d = first ? { do: 'aggress', ms: 10_000, strategy: 'aggr' } : null; first = false; return d; } });
  put(f, 3, OF.PLAYER); f.mode.event({ kind: 'appeared', id: 3 });
  ok('the decision opens the window', !!f.mode.aggressor('Bob'));
  f.advance(10_001); put(f, 3, P); f.mode.event({ kind: 'changed', id: 3 });
  ok('it expires after ms unless decided again', !f.mode.active?.pvp && f.mode.aggressor('Bob') === null
    && f.asked.filter(a => a.player === 'Bob' && a.moment === 'player_seen').length === 2 && f.asked.at(-1).aggressor === false);
}
{
  reset(); const f = fixture({ room: 38, pvpRooms: [38], strategy: aggr() });
  f.mode.refuseTarget('Bob', { why: 'safety' });
  put(f, 3, P); f.mode.event({ kind: 'appeared', id: 3 });
  ok('a target already refused here is not engaged', !f.mode.active?.pvp);
}
{
  reset(); const f = fixture({ room: 38, pvpRooms: [38],
    strategy: (m, x) => x.player === 'Bob' ? (m === 'player_seen' ? { do: 'hold_fire', ms: 6000, strategy: 'h' } : null) : null });
  f.mode.noteAggress('Bob', { do: 'aggress', ms: 30_000 });
  put(f, 3, P); f.mode.event({ kind: 'appeared', id: 3 });
  ok('hold_fire still wins over an aggress in force', !f.mode.active?.pvp && f.mode.fireHeld('Bob'));
}
{
  reset(); const f = fixture({ room: 38, pvpRooms: [38], strategy: (m) => m === 'attacked_by_player' ? { do: 'aggress', strategy: 'x' } : null });
  put(f, 2, P); hitBy(f); await f.mode.tick();
  ok('aggress answered on a blow is silence: ordinary return fire, no window', !!f.mode.active?.pvp && f.sent.includes('attack:2')
    && f.mode.aggressor('Morpheus') === null);
  f.mode.stop('test');
}

console.log('the keeper');
{
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'latin1');
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
  const kp = readToolSource(new URL('./m59-keeper-process.mjs', import.meta.url), 'latin1');
  ok('the keeper process gives every character a host, refreshed off the event path, hosts marked',
    /new PvpStrategyHost\(\{[^}]*isHost: isHostCharacter/.test(kp) && /pvpStrategy\.refresh\(\)/.test(kp));
}

console.log('the joust decision');
{
  const v = d => ps.validateDecision(d);
  const d = v({ do: 'joust' }).decision;
  ok('joust has defaults: one swing, 6 s, 4 squares, 60 s', d?.do === 'joust' && d.swings === 1 && d.period_ms === ps.JOUST_PERIOD_MS
    && d.gap === 4 && d.ms === ps.JOUST_MS, JSON.stringify(d));
  ok('the period is clamped into its band', v({ do: 'joust', period_ms: 10 }).decision.period_ms === ps.JOUST_MIN_PERIOD_MS
    && v({ do: 'joust', period_ms: 1e9 }).decision.period_ms === ps.JOUST_MAX_PERIOD_MS);
  ok('swings is 0..5 whole, gap 2..10', !!v({ do: 'joust', swings: 6 }).error && !!v({ do: 'joust', swings: 1.5 }).error
    && !!v({ do: 'joust', gap: 1 }).error && v({ do: 'joust', swings: 0 }).decision?.swings === 0);
  ok('ms is clamped to the ceiling', v({ do: 'joust', ms: 1e12 }).decision.ms === ps.JOUST_MAX_MS);
}

console.log('combat mode: joust');
{
  let answer = { do: 'joust', period_ms: 4000, swings: 1, gap: 4, ms: 60_000, strategy: 'fleeta' };
  reset(); const f = fixture({ room: 38, pvpRooms: [38], strategy: () => answer });
  put(f, 2, P); hitBy(f);
  ok('a joust decision rides on return fire', !!f.mode.active?.pvp && f.mode.active.pvp.joust?.phase === 'exchange'
    && f.mode.active.pvp.joust.period_ms === 4000, JSON.stringify(f.mode.active?.pvp?.joust));
  ok('the fight records where it started', f.mode.active.pvp.start_health === 100);
  await f.mode.tick();
  ok('the first exchange swings', f.sent.filter(x => x === 'attack:2').length === 1, f.sent.join());
  const moves = () => f.sent.filter(x => x.startsWith('move:')).length;
  f.advance(1100); await f.mode.tick();
  const t = f.c.room.objects.get(2);
  ok('its swing sent, the body backs away instead of swinging again', f.mode.active.pvp.joust.phase === 'evade'
    && f.mode.active.pvp.joust.exchanges === 1 && moves() === 1 && f.sent.filter(x => x === 'attack:2').length === 1, f.sent.join());
  ok('away from the attacker', Math.hypot(f.c.self.row - t.row, f.c.self.col - t.col) > 1, JSON.stringify(f.c.self));
  for (let i = 0; i < 6; i++) { f.advance(200); await f.mode.tick(); }
  ok('still evading inside the period, never swinging', f.mode.active.pvp.joust.phase === 'evade'
    && f.sent.filter(x => x === 'attack:2').length === 1);
  const far = Math.hypot(f.c.self.row - t.row, f.c.self.col - t.col);
  ok('it stops once it is gap squares clear', far >= 4, String(far));
  hitBy(f);
  const facts = f.asked.at(-1);
  ok('the next blow asks again, with the fight so far', facts.pvp_episode?.start_health === 100 && facts.pvp_episode.joust?.exchanges === 1
    && facts.pvp_episode.attackers.includes('Morpheus'), JSON.stringify(facts.pvp_episode));
  f.advance(2000); await f.mode.tick();
  ok('the period is up: the next exchange begins', f.mode.active.pvp.joust.phase === 'exchange', JSON.stringify(f.mode.active.pvp.joust));
  for (let i = 0; i < 12 && f.sent.filter(x => x === 'attack:2').length < 2; i++) { f.advance(300); await f.mode.tick(); }
  ok('and it closes and swings again', f.sent.filter(x => x === 'attack:2').length === 2, f.sent.join());
  answer = null; hitBy(f);
  ok('any other answer ends the joust: ordinary return fire', !!f.mode.active?.pvp && f.mode.active.pvp.joust === null
    && f.lines.some(l => l.event === 'pvp_joust_ended'));
  f.mode.stop('test');
}
{
  reset(); const f = fixture({ room: 576, pvpRooms: [38], strategy: () => ({ do: 'joust', period_ms: 6000, swings: 1, gap: 4, ms: 60_000, strategy: 'fleeta' }) });
  put(f, 2, P); hitBy(f); await f.mode.tick();
  ok('a joust lifts our room list as engage does: it fights where pvp_rooms refused', !!f.mode.active?.pvp?.joust
    && f.sent.includes('attack:2'), f.sent.join());
  f.mode.stop('test');
}
{
  reset(); const f = fixture({ room: 38, pvpRooms: [38], strategy: () => ({ do: 'joust', period_ms: 6000, swings: 0, gap: 3, ms: 60_000, strategy: 'fleeta' }) });
  put(f, 2, P); hitBy(f);
  for (let i = 0; i < 8; i++) { f.advance(500); await f.mode.tick(); }
  ok('swings 0 only evades', !f.sent.includes('attack:2') && f.sent.some(x => x.startsWith('move:')), f.sent.join());
  f.mode.stop('test');
}
{
  const { joustRetreat } = await import('./m59-combat-mode.mjs');
  const room = (rows, cols) => ({ rows, cols, standable: (r, c) => r >= 1 && c >= 1 && r <= rows && c <= cols });
  const r = joustRetreat(room(20, 20), { row: 10, col: 10 }, { row: 10, col: 9 }, 4);
  ok('a retreat square is gap clear of the attacker', r && Math.hypot(r.row - 10, r.col - 9) >= 4, JSON.stringify(r));
  ok('and on the far side of us from him', r.col > 10, JSON.stringify(r));
  const corner = joustRetreat(room(20, 20), { row: 2, col: 2 }, { row: 3, col: 3 }, 4);
  ok('backed into a corner, it slips along a wall rather than into the corner', corner && !(corner.row === 1 && corner.col === 1)
    && Math.hypot(corner.row - 3, corner.col - 3) >= 4, JSON.stringify(corner));
  ok('no geometry: no square', joustRetreat(null, { row: 1, col: 1 }, { row: 2, col: 2 }, 4) === null);
}

console.log('combat mode: a rescue ambush');
{
  const { normalizeCombatOrder } = await import('./m59-combat-mode.mjs');
  const base = { action: 'ambush', target: 'Morpheus', map: 38, position: { row: 5, col: 7 } };
  ok('rescue is carried on an ambush', normalizeCombatOrder({ ...base, rescue: true }).rescue === true
    && !('rescue' in normalizeCombatOrder(base)));
  ok('rescue is boolean and not a keep-off', throwsLike(() => normalizeCombatOrder({ ...base, rescue: 'yes' }), /rescue must be boolean/)
    && throwsLike(() => normalizeCombatOrder({ ...base, rescue: true, keepoff: 'rush' }), /different orders/));
  reset(); const f = fixture({ room: 576, pvpRooms: [38] });
  f.s.world.map = { rooms: { 38: { rows: 50, cols: 70 } } };
  f.keeper.policy.confineRooms = [576];
  const r = f.mode.issue({ ...base, rescue: true, position: { row: 5, col: 6 } });
  ok('a rescue is accepted outside the confinement', !!f.mode.active && f.mode.active.order.rescue === true, JSON.stringify(r));
  const plain = f.s.travel.bind(f.s);
  f.s.travel = async (to, opts) => { const res = await plain(to, opts); put(f, 2, P); return res; };
  await f.mode.tick();
  ok('it travels to the fight', f.travels.at(-1)?.to === 38 && f.s.world.room.num === 38, JSON.stringify(f.travels.map(t => t.to)));
  for (let i = 0; i < 6 && !f.sent.includes('attack:2'); i++) { f.advance(1100); f.mode.event({ kind: 'moved', id: 2 }); await f.mode.tick(); }
  ok('and engages the attacker already standing there (a plain ambush would wait for an entry)',
    f.lines.some(l => l.event === 'rescue_arrived') && f.sent.includes('attack:2'), f.sent.join() + ' ' + f.mode.active?.phase);
  f.mode.stop('test');
}


console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
