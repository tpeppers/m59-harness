#!/usr/bin/env node
// A FARMING STRATEGY'S `requires` AND KILL-RATE `floor` -- offline, no socket, no roster.
//
//   node tools/m59-strategy-gate-test.mjs
//
// What this pins (tools/m59-strategy-gate.mjs, docs/m59-strategies.md "What the body needs"):
//   * requires and floor validate, and a bad one refuses the whole file;
//   * requiresVerdict: a known magic weapon meets magicWeapon; all-mundane is UNMET and names the weapons;
//     unread weapons are UNKNOWN (null), never a pass and never a refusal; a broken magic weapon does not count;
//   * the floor's clock advances only on farming passes, a gap over two minutes is not farming, a window
//     with too few kills TRIPS it, enough kills roll it over, and the saved floor survives a new process on
//     the same file but not an edited file;
//   * the engine stands the farm down on an unmet requirement or a tripped floor, asks the service board once
//     per ttl, counts kills with or without an onKill hook, and yields its gate while a bot holds `work`;
//   * the hazard is named, so the broker's refusal says how to accept it.
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'm59-strategy-gate-test-'));
const DIR = join(tmp, 'farm-strategies');
mkdirSync(DIR, { recursive: true });
process.env.M59_FARM_STRATEGY_DIR = DIR;
process.env.M59_STRATEGY_FLOOR_DIR = join(tmp, 'floor');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
};
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const gate = await import('./m59-strategy-gate.mjs');
const { FarmStrategyEngine, loadFarmStrategy } = await import('./m59-strategy-engine.mjs');
const { HAZARDS, refusal } = await import('./m59-hazards.mjs');
const { normalizeRequires, normalizeFloor, requiresVerdict, requestFor, KillFloor, FARMING_GAP_MS } = gate;

const memStore = () => { const m = new Map(); return { m, read: a => m.has(a) ? JSON.parse(m.get(a)) : null,
  write: (a, o) => m.set(a, JSON.stringify(o)), clear: a => m.delete(a) }; };

console.log('validation');
ok('requires { magicWeapon: true } normalises', JSON.stringify(normalizeRequires({ magicWeapon: true })) === '{"magicWeapon":true}');
ok('requires with an unknown key is refused', /not known/.test(throws(() => normalizeRequires({ magicWepon: true })) ?? ''));
ok('requires that names nothing is refused', /names nothing/.test(throws(() => normalizeRequires({ request: 'dedicate' })) ?? ''));
ok('requires.request as a string becomes { service, ttl_min }',
   normalizeRequires({ magicWeapon: true, request: 'Dedicate' }).request?.service === 'dedicate');
ok('floor { kills: 1, minutes: 30 } normalises', JSON.stringify(normalizeFloor({ kills: 1, minutes: 30 })) === '{"kills":1,"minutes":30}');
ok('floor under five minutes is refused', /5 to 720/.test(throws(() => normalizeFloor({ kills: 1, minutes: 2 })) ?? ''));
ok('floor kills defaults to 1', normalizeFloor({ minutes: 30 }).kills === 1);

console.log('requiresVerdict');
const R = { magicWeapon: true };
ok('a known magic weapon meets it', requiresVerdict(R, { weapons: [{ name: 'long sword', bypasses_nonmagic: true }] }).met === true);
const mundane = requiresVerdict(R, { weapons: [{ name: 'long sword', bypasses_nonmagic: false }, { name: 'hammer', bypasses_nonmagic: false }] });
ok('all-mundane is UNMET and names the weapons', mundane.met === false && /long sword, hammer/.test(mundane.unmet[0].why), JSON.stringify(mundane));
ok('an unread weapon is UNKNOWN, not met and not unmet',
   requiresVerdict(R, { weapons: [{ name: 'long sword', bypasses_nonmagic: null }] }).met === null);
ok('no weapon report at all is UNKNOWN', requiresVerdict(R, {}).met === null);
ok('a BROKEN magic weapon does not count',
   requiresVerdict(R, { weapons: [{ name: 'long sword', bypasses_nonmagic: true, broken: true }] }).met === false);
ok('items: a missing item is unmet', requiresVerdict({ items: ['purple mushroom'] }, { pack: ['wand'] }).met === false);
ok('items: carried is met', requiresVerdict({ items: ['purple mushroom'] }, { pack: ['Purple Mushroom'] }).met === true);
ok('an unmet magicWeapon asks for a dedication by default', requestFor(R, mundane)?.service === 'dedicate');
ok('request: null asks for nothing', requestFor({ magicWeapon: true, request: null }, mundane) === null);
ok('a met requirement asks for nothing', requestFor(R, { met: true, unmet: [] }) === null);

console.log('the kill-rate floor');
{
  const store = memStore(); const MIN = 60_000; let t = 1_000_000;
  const f = new KillFloor({ floor: { kills: 2, minutes: 30 }, agent: 't1', strategy: 'trolls', version: 1, store, now: t });
  for (let i = 0; i < 29; i++) { t += MIN; f.farming(t); }
  ok('29 farming minutes, no kills: not tripped yet', !f.state(t).tripped);
  t += 10 * MIN; f.farming(t);
  ok('a ten-minute gap (resting, travelling) is not counted', f.state(t).window_farming_min < 30 && !f.state(t).tripped,
     JSON.stringify(f.state(t)));
  f.kill(t);
  for (let i = 0; i < 3; i++) { t += MIN; f.farming(t); }
  const s = f.state(t);
  ok('one kill in 30 farming minutes, floor 2: TRIPPED, and it says why', !!s.tripped && /1 kill\(s\) in 30 farming minutes/.test(s.tripped.why), JSON.stringify(s));
  t += MIN; f.farming(t); f.kill(t);
  ok('a tripped floor stays tripped through more kills', !!f.state(t).tripped);
  const again = new KillFloor({ floor: { kills: 2, minutes: 30 }, agent: 't1', strategy: 'trolls', version: 1, store, now: t });
  ok('a new process on the same file reads the trip back (a handoff does not forgive it)', !!again.state(t).tripped);
  const edited = new KillFloor({ floor: { kills: 2, minutes: 30 }, agent: 't1', strategy: 'trolls', version: 2, store, now: t });
  ok('an edited file starts clean', !edited.state(t).tripped);
  gate.resetFloor('t1', store);
  const fresh = new KillFloor({ floor: { kills: 2, minutes: 30 }, agent: 't1', strategy: 'trolls', version: 1, store, now: t });
  ok('resetFloor (the broker, on an explicit assignment) forgets it', !fresh.state(t).tripped);

  const g = new KillFloor({ floor: { kills: 1, minutes: 10 }, agent: 't2', strategy: 's', version: 1, store: memStore(), now: 0 });
  let u = 0;
  for (let i = 0; i < 25; i++) { u += MIN; g.farming(u); if (i % 5 === 0) g.kill(u); }
  ok('a farmer killing every five minutes never trips a 1-per-10 floor', !g.state(u).tripped, JSON.stringify(g.state(u)));
  ok('FARMING_GAP_MS is two minutes', FARMING_GAP_MS === 120_000);
}

console.log('the engine');
let mtick = Date.parse('2026-10-26T12:00:00Z') / 1000;
function writeStrategy(name, body) {
  const f = join(DIR, `${name}.mjs`); writeFileSync(f, body); mtick += 10; utimesSync(f, mtick, mtick); return f;
}
writeStrategy('trolls', `export default { name: 'trolls', hunt: 'troll', confine: { station: 599, roam: false },
  requires: { magicWeapon: true }, floor: { kills: 1, minutes: 30 } };\n`);
{
  const r = await loadFarmStrategy('trolls');
  ok('a file with requires and floor loads', r.ok && r.strategy.requires?.magicWeapon && r.strategy.floor?.minutes === 30, r.why ?? '');
  writeStrategy('bad-floor', `export default { name: 'bad-floor', hunt: 'troll', floor: { minutes: 1 } };\n`);
  const b = await loadFarmStrategy('bad-floor');
  ok('a bad floor refuses the whole file', !b.ok && /floor/.test(b.why), b.why);
}
function host({ weapons, claims = new Map() } = {}) {
  const notes = [], requests = [];
  return { notes, requests, claims,
    policy: { hunt: null, assignedRoom: null, roam: true, farmStrategy: 'trolls', fleeBelow: 0.4 },
    facultyOwner(f) { return claims.get(f) ?? 'keeper'; },
    note(what, data) { notes.push({ what, data }); },
    weaponMagicStatus: () => ({ weapons }),
    s: { name: 't7', client: { inventory: [], rsc: { get: () => '' } }, world: { room: { num: 599 } },
         joints: { effects: { request: q => requests.push(q) } } } };
}
{
  let now = 5_000_000;
  const h = host({ weapons: [{ name: 'long sword', bypasses_nonmagic: false }] });
  const e = new FarmStrategyEngine(h, { now: () => now, floorStore: memStore() });
  await e.converge('pass');
  const g = e.gate();
  ok('mundane weapons: the farm is STOOD DOWN by requires', g?.blocked?.by === 'requires' && /long sword/.test(g.blocked.why), JSON.stringify(g));
  ok('and the service board is asked for a dedication, once', h.requests.length === 1 && h.requests[0].service === 'dedicate'
     && h.requests[0].target === 't7', JSON.stringify(h.requests));
  now += 6_000; e.gate(); now += 6_000; e.gate();
  ok('not asked again inside its ttl', h.requests.length === 1);
  now += 16 * 60_000; e.gate();
  ok('asked again after the ttl', h.requests.length === 2);
  ok('status carries the gate', e.status()?.gate?.blocked?.by === 'requires');
  ok('the stand-down is noted once', h.notes.filter(n => n.what === 'farm strategy stood down').length === 1);

  h.weaponMagicStatus = () => ({ weapons: [{ name: 'long sword', bypasses_nonmagic: true }] });
  now += 6_000;
  ok('a dedicated weapon clears it', e.gate()?.blocked === null);
  ok('and the clearing is noted', h.notes.some(n => n.what === 'farm strategy may farm again'));

  // The floor, through the engine: farming passes, then a kill through dispatch with no onKill hook.
  for (let i = 0; i < 20; i++) { now += 60_000; e.farming(); }
  e.dispatch('onKill', { creature: 'troll', room: 599 });
  ok('a kill is counted with no onKill hook', e.floor.state(now).total_kills === 1);
  for (let i = 0; i < 61; i++) { now += 60_000; e.farming(); }
  const g2 = e.gate();
  ok('a window with its kill rolls over; the next 30 farming minutes with no kill: STOOD DOWN by the floor', g2?.blocked?.by === 'floor' && /Re-assign/.test(g2.blocked.why), JSON.stringify(g2));

  h.claims.set('work', 'bot:dum');
  now += 6_000;
  const g3 = e.gate();
  ok('while a bot holds work the gate yields (the file is not in force)', g3?.blocked === null && g3.yielded_to === 'bot:dum', JSON.stringify(g3));
  const before = e.floor.state(now).window_farming_min;
  now += 60_000; e.farming();
  ok('and the floor clock does not advance under the bot', e.floor.state(now).window_farming_min === before);
}
{
  const h = host({ weapons: [{ name: 'long sword', bypasses_nonmagic: null }] });
  const e = new FarmStrategyEngine(h, { floorStore: memStore() });
  await e.converge('pass');
  ok('unread weapons do not stand the farm down', e.gate()?.blocked === null && e.gate()?.requires?.met === null);
  ok('and ask for nothing', h.requests.length === 0);
}
{
  writeStrategy('plain', `export default { name: 'plain', hunt: 'troll' };\n`);
  const h = host({ weapons: [] }); h.policy.farmStrategy = 'plain';
  const e = new FarmStrategyEngine(h, { floorStore: memStore() });
  await e.converge('pass');
  ok('a file with neither has no gate (silence is the old behaviour)', e.gate() === null && !('gate' in (e.status() ?? {})));
}

console.log('the hazard');
ok('requires_unmet is a named hazard', typeof HAZARDS.requires_unmet === 'string');
ok('its refusal says how to accept it', /accept: \["requires_unmet"\]/.test(refusal('requires_unmet', 'x')));

console.log('the keeper binding');
{
  const { readToolSource } = await import('./autopilot/source.mjs');
  const src = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const i = src.indexOf('if (this.farmStrategyGate()?.blocked) return HANDLED;');
  ok('passFarm stands down on the gate', i > 0);
  ok('below the meal (a stood-down body still eats)', i > src.indexOf("if (await this.provision(plan, v) === 'ate') return HANDLED;"));
  ok('and the floor clock advances only past the gate', src.indexOf('this.farmStrategyFarming();') > i);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
