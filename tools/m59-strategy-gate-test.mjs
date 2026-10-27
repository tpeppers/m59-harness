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
//   * THE ESCALATION LADDER: an unmet requirement or a tripped floor never just stops. It diagnoses (weapons re-read),
//     asks a desk and KEEPS FARMING, falls back to the file's `otherwise` (or this machine's default) when no desk
//     can or does fix it, comes back by itself when the requirement is met, survives a handoff, and stands down
//     ONLY when there is no fallback at all; it yields while a bot holds `work`;
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
  write: (a, o) => m.set(a, JSON.stringify(o)), clear: a => m.delete(a),
  clearAll: agent => { for (const k of [...m.keys()]) if (k.startsWith(`${agent}~`)) m.delete(k); } }; };

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

console.log('the engine: the escalation ladder');
process.env.M59_FARM_OTHERWISE_FILE = join(tmp, 'otherwise.json');
let mtick = Date.parse('2026-10-26T12:00:00Z') / 1000;
function writeStrategy(name, body) {
  const f = join(DIR, `${name}.mjs`); writeFileSync(f, body); mtick += 10; utimesSync(f, mtick, mtick); return f;
}
writeStrategy('trolls', `export default { name: 'trolls', hunt: 'troll', confine: { station: 599, roam: false },
  requires: { magicWeapon: true }, floor: { kills: 1, minutes: 30 }, otherwise: 'spiders' };\n`);
writeStrategy('spiders', `export default { name: 'spiders', hunt: 'baby spider', confine: { station: 534, roam: true } };\n`);
writeStrategy('nofallback', `export default { name: 'nofallback', hunt: 'troll', floor: { kills: 1, minutes: 30 } };\n`);
{
  const r = await loadFarmStrategy('trolls');
  ok('a file with requires, floor and otherwise loads', r.ok && r.strategy.requires?.magicWeapon && r.strategy.floor?.minutes === 30
     && r.strategy.otherwise === 'spiders', r.why ?? '');
  writeStrategy('bad-floor', `export default { name: 'bad-floor', hunt: 'troll', floor: { minutes: 1 } };\n`);
  const b = await loadFarmStrategy('bad-floor');
  ok('a bad floor refuses the whole file', !b.ok && /floor/.test(b.why), b.why);
  writeStrategy('selfish', `export default { name: 'selfish', hunt: 'troll', otherwise: 'selfish' };\n`);
  ok('otherwise cannot name itself', !(await loadFarmStrategy('selfish')).ok);
}
function host({ weapons, claims = new Map(), assigned = 'trolls' } = {}) {
  const notes = [], requests = [];
  const h = { notes, requests, claims, rereads: 0,
    policy: { hunt: null, assignedRoom: null, roam: true, farmStrategy: assigned, fleeBelow: 0.4 },
    facultyOwner(f) { return claims.get(f) ?? 'keeper'; },
    note(what, data) { notes.push({ what, data }); },
    weaponMagicStatus: () => ({ weapons: h.weapons }),
    rereadWeapons() { h.rereads++; h.weapons = h.weapons.map(w => ({ ...w, bypasses_nonmagic: null })); },
    huntRoomCheck: () => null,
    weapons,
    s: { name: 't7', client: { inventory: [], rsc: { get: () => '' } }, world: { room: { num: 599 } },
         joints: { effects: { request: q => requests.push(q) } } } };
  return h;
}
const MAGIC = [{ name: 'long sword', bypasses_nonmagic: true }];
const MUNDANE = [{ name: 'long sword', bypasses_nonmagic: false }];
async function tick(e, now, step = 6_000) { now.t += step; await e.converge('pass'); return e.gate(); }
{
  // 1. An unmet requirement with a desk remedy: ask, KEEP FARMING; the desk answers; the escalation clears.
  const now = { t: 5_000_000 };
  const h = host({ weapons: MUNDANE });
  const e = new FarmStrategyEngine(h, { now: () => now.t, floorStore: memStore() });
  await e.converge('pass');
  let g = e.gate();
  ok('mundane weapons: awaiting a desk, NOT stood down', g?.escalation?.stage === 'awaiting_desk' && g.blocked === null, JSON.stringify(g));
  ok('the board is asked for a dedication', h.requests.length === 1 && h.requests[0].service === 'dedicate' && h.requests[0].target === 't7',
     JSON.stringify(h.requests));
  ok('h.policy still serves the assignment while waiting', e.serving === 'trolls');
  h.weapons = MAGIC;
  g = await tick(e, now);
  ok('the dedication arrives: the escalation clears', !g.escalation && g.blocked === null, JSON.stringify(g));
  ok('and that is noted', h.notes.some(n => n.what === 'farm strategy escalation cleared'));
}
{
  // 2. The desk does not answer in time: the fallback strategy is served, and the assignment comes back by itself.
  const now = { t: 6_000_000 };
  const h = host({ weapons: MUNDANE });
  const store = memStore();
  const e = new FarmStrategyEngine(h, { now: () => now.t, floorStore: store });
  await e.converge('pass'); e.gate();
  now.t += 16 * 60_000; e.gateCache = null;
  let g = e.gate();
  ok('an unanswered request falls back', g?.escalation?.stage === 'fallback' && g.escalation.to === 'spiders', JSON.stringify(g?.escalation));
  await e.converge('pass');
  ok('the fallback file is served; the assignment is unchanged', e.serving === 'spiders' && h.policy.farmStrategy === 'trolls'
     && h.policy.hunt === 'baby spider', `${e.serving} ${h.policy.hunt}`);
  ok('status says it is serving the fallback', e.status()?.serving === 'spiders');
  // A new keeper process (handoff) picks the fallback up from the store.
  const h2 = host({ weapons: MUNDANE }); const e2 = new FarmStrategyEngine(h2, { now: () => now.t, floorStore: store });
  await e2.converge('pass');
  ok('a handoff keeps serving the fallback', e2.serving === 'spiders' && h2.policy.hunt === 'baby spider');
  h.weapons = MAGIC;
  g = await tick(e, now);
  await e.converge('pass');
  ok('a magic weapon arrives later: back to the assignment by itself', !e.escalation && e.serving === 'trolls' && h.policy.hunt === 'troll',
     `${e.serving} ${h.policy.hunt} ${JSON.stringify(e.escalation)}`);
}
{
  // 3. The floor trips with magic weapons: weapons re-read, no cause found, no desk: the fallback.
  const now = { t: 7_000_000 };
  const h = host({ weapons: MAGIC });
  const e = new FarmStrategyEngine(h, { now: () => now.t, floorStore: memStore() });
  await e.converge('pass');
  for (let i = 0; i < 31; i++) { now.t += 60_000; e.farming(); }
  e.gateCache = null;
  let g = e.gate();
  ok('a tripped floor DIAGNOSES first, it does not stop', g?.escalation?.stage === 'diagnosing' && g.blocked === null, JSON.stringify(g));
  ok('and forces every weapon to be read again', h.rereads === 1);
  h.weapons = MAGIC;                                        // the sweep reads them: still magic
  g = await tick(e, now);
  ok('weapons still magic, no curse, room spawns: no desk remedy, so the fallback', g?.escalation?.stage === 'fallback'
     && /weapons are magic/.test(g.escalation.why), JSON.stringify(g?.escalation));
}
{
  // 4. The floor trips because the dedication LAPSED: re-read finds it, the desk is asked, the farm keeps going.
  const now = { t: 8_000_000 };
  const h = host({ weapons: MAGIC });
  const e = new FarmStrategyEngine(h, { now: () => now.t, floorStore: memStore() });
  await e.converge('pass');
  for (let i = 0; i < 31; i++) { now.t += 60_000; e.farming(); }
  e.gateCache = null; e.gate();
  h.weapons = MUNDANE;                                      // the fresh read says the enchantment is gone
  const g = await tick(e, now);
  ok('a lapsed dedication found by the re-read: awaiting a desk', g?.escalation?.stage === 'awaiting_desk'
     && g.escalation.service === 'dedicate', JSON.stringify(g?.escalation));
  const before = e.floor.state(now.t).window_farming_min;
  for (let i = 0; i < 5; i++) { now.t += 60_000; e.farming(); }
  ok('the floor clock is paused while the desk is pending', e.floor.state(now.t).window_farming_min === before);
  ok('and the farm is not blocked', e.gate()?.blocked == null);
}
{
  // 5. A cursed weapon: the remedy is an uncurse.
  const now = { t: 9_000_000 };
  const h = host({ weapons: MAGIC });
  h.weaponMagicStatus = () => ({ weapons: h.weapons, curse_suspect: { name: 'cursed mace' } });
  const e = new FarmStrategyEngine(h, { now: () => now.t, floorStore: memStore() });
  await e.converge('pass');
  for (let i = 0; i < 31; i++) { now.t += 60_000; e.farming(); }
  e.gateCache = null; e.gate(); h.weapons = MAGIC;
  const g = await tick(e, now);
  ok('a cursed weapon asks for an uncurse', g?.escalation?.service === 'uncurse', JSON.stringify(g?.escalation));
}
{
  // 6. STOPPING ONLY WHEN NOTHING ELSE IS LEFT: no desk remedy and no fallback.
  const now = { t: 10_000_000 };
  const h = host({ weapons: MAGIC, assigned: 'nofallback' });
  const e = new FarmStrategyEngine(h, { now: () => now.t, floorStore: memStore() });
  await e.converge('pass');
  for (let i = 0; i < 31; i++) { now.t += 60_000; e.farming(); }
  e.gateCache = null; e.gate(); h.weapons = MAGIC;
  let g = await tick(e, now);
  // A FLAG, NOT A CANCEL (operator, 2026-10-27): a quiet floor with nothing to escalate to warns and keeps farming.
  ok('no remedy, no otherwise, no machine default: a warning, the farm keeps running, and it says how it unblocks',
     g?.blocked === null && g?.escalation?.stage === 'warning' && /no fallback/.test(g.escalation.why)
     && /clears itself at the next kill/.test(g.escalation.unblock), JSON.stringify(g));
  // ...and the first kill clears the flag.
  e.floor.st.total_kills = Number(g.escalation.kills_at) + 1; e.gateCache = null;
  g = await tick(e, now);
  ok('the first kill after the warning clears it', !g?.escalation, JSON.stringify(g?.escalation ?? null));
  writeFileSync(process.env.M59_FARM_OTHERWISE_FILE, JSON.stringify({ strategy: 'spiders' }));
  const h2 = host({ weapons: MAGIC, assigned: 'nofallback' });
  const e2 = new FarmStrategyEngine(h2, { now: () => now.t, floorStore: memStore() });
  await e2.converge('pass');
  for (let i = 0; i < 31; i++) { now.t += 60_000; e2.farming(); }
  e2.gateCache = null; e2.gate(); h2.weapons = MAGIC;
  g = await tick(e2, now);
  ok("with this machine's default catch-all, it falls back there instead", g?.escalation?.stage === 'fallback' && g.escalation.to === 'spiders',
     JSON.stringify(g?.escalation));
}
{
  // 7. A bot holding work: the gate yields, the clock does not run.
  const now = { t: 11_000_000 };
  const h = host({ weapons: MAGIC });
  const e = new FarmStrategyEngine(h, { now: () => now.t, floorStore: memStore() });
  await e.converge('pass');
  h.claims.set('work', 'bot:dum');
  const g = e.gate();
  ok('while a bot holds work the gate yields', g?.blocked === null && g.yielded_to === 'bot:dum', JSON.stringify(g));
  const before = e.floor.state(now.t).window_farming_min;
  now.t += 60_000; e.farming(); now.t += 60_000; e.farming();
  ok('and the floor clock does not advance under the bot', e.floor.state(now.t).window_farming_min === before);
  e.dispatch('onKill', { creature: 'troll', room: 599 });
  ok('a kill is still counted, with no onKill hook', e.floor.state(now.t).total_kills === 1);
}
{
  const h = host({ weapons: [{ name: 'long sword', bypasses_nonmagic: null }] });
  const e = new FarmStrategyEngine(h, { floorStore: memStore() });
  await e.converge('pass');
  ok('unread weapons start no escalation', !e.gate()?.escalation && h.requests.length === 0);
}
{
  writeStrategy('plain', `export default { name: 'plain', hunt: 'troll' };\n`);
  const h = host({ weapons: [], assigned: 'plain' });
  const e = new FarmStrategyEngine(h, { floorStore: memStore() });
  await e.converge('pass');
  ok('a file with none of it has no gate (silence is the old behaviour)', e.gate() === null && !('gate' in (e.status() ?? {})));
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
