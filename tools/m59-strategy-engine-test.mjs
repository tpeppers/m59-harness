#!/usr/bin/env node
// FARMING STRATEGY FILES — offline, no socket, no roster.
//
//   node tools/m59-strategy-engine-test.mjs
//
// What this pins (docs/m59-strategies.md):
//   * the three committed examples load, and say what they mean;
//   * a bad file — will not parse, names a protected key at any depth, carries a bad value, a hook
//     that is not a function, a name that is not its file, nothing at all — is REFUSED, and the
//     character keeps its posture (nothing applied; or the previous good version on a reload);
//   * keys apply while the keeper owns their faculty and YIELD (no write at all) while a bot or a
//     lease holds it — then return when the lease ends. No flip-flop, ever;
//   * every write is credited: policy_sources says who set each key; status says what each key
//     shadows; unassigning gives every key back;
//   * a hook that throws, rejects or overruns is disabled and the keeper carries on; hooks do not
//     run while a bot holds `work`; ctx.set is faculty-gated and refuses survival keys;
//   * hot reload on a file change, no restart;
//   * the policy key exists in the default object, round-trips through the keeper's push merge,
//     is carried as a NAME only, and the broker validates it;
//   * survival is untouched: flee/rest thresholds and the protected four never move.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = mkdtempSync(join(tmpdir(), 'm59-strategy-engine-test-'));
const DIR = join(tmp, 'farm-strategies');
mkdirSync(DIR, { recursive: true });
process.env.M59_FARM_STRATEGY_DIR = DIR;
process.env.M59_LEDGER_DIR = join(tmp, 'ledger');
process.env.M59_PVP_HOLD_DIR = join(tmp, 'holds');

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
};

let engine, schema, sources, Autopilot;
try {
  engine = await import('./m59-strategy-engine.mjs');
  schema = await import('./m59-strategy-schema.mjs');
  sources = await import('./m59-policy-sources.mjs');
  ({ Autopilot } = await import('./m59-autopilot.mjs'));
} catch (e) {
  ok('the strategy modules load', false, e.message);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}
const { FarmStrategyEngine, loadFarmStrategy, FARM_STRATEGY_EXAMPLES } = engine;
const { PolicySourceBook } = sources;

let tick = Date.parse('2026-10-02T12:00:00Z') / 1000;
function writeStrategy(name, body, dir = DIR) {
  const f = join(dir, `${name}.mjs`);
  writeFileSync(f, body);
  tick += 10;                                   // a distinct mtime per write: hot reload keys on it
  utimesSync(f, tick, tick);
  return f;
}
const strat = (name, inner) => `export default { name: '${name}', ${inner} };\n`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ the examples
console.log('the committed examples');
{
  const ex = {};
  for (const n of ['qor-acid-touch-trees', 'wand-farmer-spiders-first', 'cv-skeletons'])
    ex[n] = await loadFarmStrategy(n, { dir: FARM_STRATEGY_EXAMPLES });
  ok('all three examples load and validate', Object.values(ex).every(r => r.ok),
     Object.values(ex).filter(r => !r.ok).map(r => `${r.name}: ${r.why}`).join('; '));
  const q = ex['qor-acid-touch-trees'].strategy?.desired ?? {};
  ok('qor-acid-touch-trees: bare hands + acid touch through the CENTRAL touch support, living tree, 536',
     q.touchSpell === 'acid touch' && q.hunt === 'living tree' && q.assignedRoom === 536 && q.roam === false,
     JSON.stringify(q));
  const w = ex['wand-farmer-spiders-first'].strategy?.desired ?? {};
  ok('wand-farmer: spider + living tree, spider first, loot_only spider: purple mushroom, 537, protect wand + berry',
     JSON.stringify(w.hunt) === '["spider","living tree"]' && w.huntPriority?.[0] === 'spider'
     && JSON.stringify(w.lootOnly) === '{"spider":["purple mushroom"]}' && w.assignedRoom === 537
     && w.protectedItems?.includes('wand') && w.protectedItems?.includes('entroot berry'), JSON.stringify(w));
  const cv = ex['cv-skeletons'].strategy?.desired ?? {};
  ok('cv-skeletons: skeletons and zombies, blunt first, confined to 39 and the bridge room 38',
     cv.hunt.includes('battered skeleton') && cv.hunt.includes('zombie') && cv.weaponPriority?.[0] === 'hammer'
     && JSON.stringify(cv.confineRooms) === '[39,38]' && cv.assignedRoom === 39, JSON.stringify(cv));
  ok('no example sets a survival, rest or war key', Object.values(ex).every(r =>
     !Object.keys(r.strategy.desired).some(k => /flee|rest|pvp|war|defend/i.test(k))));
  const examplesDir = resolve(FARM_STRATEGY_EXAMPLES), farmDir = resolve(HERE, '..', 'substrate', 'farm-strategies');
  const travel = await import('./m59-strategies.mjs');
  ok('the examples live BESIDE the directory the loader reads, never inside it',
     dirname(examplesDir) === dirname(farmDir) && examplesDir !== farmDir);
  ok('...and the farm directory is not the travel strategies directory (two systems, two loaders)',
     resolve(travel.STRATEGY_DIR) !== farmDir && !farmDir.startsWith(resolve(travel.STRATEGY_DIR) + '\\')
     && !farmDir.startsWith(resolve(travel.STRATEGY_DIR) + '/'));
  const gi = readFileSync(join(HERE, '..', '.gitignore'), 'utf8');
  ok('substrate/farm-strategies/ is gitignored; the examples directory is not',
     /^\/substrate\/farm-strategies\/$/m.test(gi) && !/^\/substrate\/farm-strategies\.example/m.test(gi));
}

// ------------------------------------------------------------------ refusals
console.log('a bad file is refused, with its reason');
{
  const cases = [
    ['broken-syntax', 'export default { name: "broken-syntax", hunt: [ };', /did not load/],
    ['wants-flee', strat('wants-flee', `hunt: 'spider', fleeBelow: 0.1`), /fleeBelow is survival/],
    ['nested-rest', strat('nested-rest', `hunt: 'spider', vigor: { fightAbove: 50, restBelow: 0.2 }`), /vigor\.restBelow is survival/],
    ['wants-war', strat('wants-war', `hunt: 'spider', defendAgainstPlayers: false`), /war\/PvP/],
    ['wants-mode', strat('wants-mode', `hunt: 'spider', mode: 'farm'`), /not a strategy key/],
    ['bad-touch', strat('bad-touch', `weapons: { touchSpell: 'acid tuoch' }`), /touch_spell must be one of/],
    ['bad-priority', strat('bad-priority', `hunt: 'spider', huntPriority: 'spider'`), /ordered LIST/],
    ['bad-hook', strat('bad-hook', `hunt: 'spider', hooks: { onPass: 5 }`), /must be a function/],
    ['empty', strat('empty', ``), /declares no field and no hook/],
    ['bad-item', strat('bad-item', `protect: ['definitely not an item xyz']`), /protect:/],
  ];
  for (const [name, body, why] of cases) {
    writeStrategy(name, body);
    const r = await loadFarmStrategy(name);
    ok(`${name}: refused`, r.ok === false && why.test(r.why ?? ''), r.why);
  }
  writeStrategy('wrong-name', strat('right-name', `hunt: 'spider'`));
  const wn = await loadFarmStrategy('wrong-name');
  ok('a name that is not its file is refused (the assignment names the file)', !wn.ok && /does not match its file/.test(wn.why));
  const missing = await loadFarmStrategy('no-such-strategy');
  ok('a missing file is refused, and says where strategies live', !missing.ok && /does not exist/.test(missing.why));
  const esc = await loadFarmStrategy('../strategies/blink-escape');
  ok('a name cannot climb out of the directory (no path, no dot-dot)', !esc.ok && /must be a strategy name/.test(esc.why));
  writeStrategy('extra-keys', strat('extra-keys', `hunt: 'spider', colour: 'red', weapons: { sharpness: 3 }`));
  const ex = await loadFarmStrategy('extra-keys');
  ok('an unrecognised key is REPORTED, not applied and not fatal', ex.ok && ex.unrecognised.includes('colour')
     && ex.unrecognised.includes('weapons.sharpness') && !('colour' in ex.strategy.desired), JSON.stringify(ex.unrecognised));
}

// ------------------------------------------------------------------ a fake keeper
function fakeHost(policy = {}) {
  const claims = new Map();
  const notes = [];
  const book = new PolicySourceBook();
  const events = []; let evSeq = 0;
  const client = {
    get evSeq() { return evSeq; },
    eventsSince: (since = 0) => events.filter(e => e.seq > since),
    say(text) { events.push({ seq: ++evSeq, kind: 'message', text }); },
    vitals: () => ({ health: { value: 50, max: 60 }, mana: { value: 30, max: 40 }, vigor: { value: 150, max: 200 } }),
    inventory: [{ name: 'entroot berry', amount: 2 }, { name: 'wand' }],
    rsc: { get: () => '' },
  };
  const touch = { active: true, snapshot() { return { active: this.active }; } };
  const host = {
    policy: { hunt: 'living tree', huntPriority: null, lootOnly: null, assignedRoom: 536, roam: true,
              protectedItems: ['elderberry'], fleeBelow: 0.4, restBelow: 0.7, touchSpell: null,
              farmStrategy: null, ...policy },
    claims, notes, policySources: book, combat: null,
    facultyOwner(f) { if (this.combat && f !== 'survival') return `combat:${this.combat}`;
                      return claims.get(f) ?? 'keeper'; },
    note(what, data) { notes.push({ what, data }); },
    s: { name: 't1', client, world: { room: { num: 537 } } },
    touchState: () => touch,
  };
  host.client = client; host.touch = touch;
  book.mark(Object.keys(host.policy), 'roster');        // the boot orders, as the keeper credits them
  return host;
}

writeStrategy('wf', strat('wf', `
  hunt: ['spider', 'living tree'], huntPriority: ['spider', 'living tree'],
  lootOnly: { spider: ['purple mushroom'] }, protect: ['wand', 'entroot berry'],
  confine: { station: 537, roam: false }`));

// ------------------------------------------------------------------ apply
console.log('applied while the keeper owns the faculties');
{
  const h = fakeHost();
  const e = new FarmStrategyEngine(h);
  const before = JSON.stringify(h.policy);
  ok('nothing assigned: converge is a no-op and status is null', (await e.converge()) === null
     && JSON.stringify(h.policy) === before);
  h.policy.farmStrategy = 'wf';
  const st = await e.converge('policy push');
  ok('assigned: every declared key is applied', JSON.stringify(h.policy.hunt) === '["spider","living tree"]'
     && h.policy.huntPriority[0] === 'spider' && h.policy.lootOnly.spider[0] === 'purple mushroom'
     && h.policy.assignedRoom === 537 && h.policy.roam === false, JSON.stringify(h.policy));
  ok('protect is ADDITIVE: the roster\'s elderberry stays protected', JSON.stringify(h.policy.protectedItems)
     === '["elderberry","wand","entroot berry"]', JSON.stringify(h.policy.protectedItems));
  ok('status: applied, per key file/effective/applied/shadowing', st.state === 'applied'
     && st.keys.hunt.applied === true && st.keys.hunt.shadowing.value === 'living tree'
     && st.keys.hunt.shadowing.source === 'roster' && st.keys.assignedRoom.faculty === 'movement'
     && st.keys.lootOnly.faculty === 'economy', JSON.stringify(st.keys.hunt));
  ok('source attribution: hunt was set by the strategy, flee is still the roster\'s',
     h.policySources.sourceOf('hunt').source === 'strategy:wf' && h.policySources.sourceOf('fleeBelow').source === 'roster');
  ok('the survival thresholds never moved', h.policy.fleeBelow === 0.4 && h.policy.restBelow === 0.7);
  ok('ordersView takes the overlay back out (nothing of the file is persisted)',
     e.ordersView().hunt === 'living tree' && e.ordersView().assignedRoom === 536
     && JSON.stringify(e.ordersView().protectedItems) === '["elderberry"]');
  ok('a note says what was applied', h.notes.some(n => n.what === 'farm strategy applied'));

  // Another writer (a broker push re-imposing the roster's whole policy) — the file answers again.
  h.policy.hunt = 'living tree';
  h.policySources.mark('hunt', 'policy', { by: 'broker pid 1' });
  await e.converge('policy push');
  ok('a push of the old value is re-answered at once while the keeper owns work (one answer per key)',
     JSON.stringify(h.policy.hunt) === '["spider","living tree"]' && e.reasserts === 1
     && e.status().keys.hunt.shadowing.source === 'policy');

  // Unassign: every key goes back to what it shadowed.
  h.policy.farmStrategy = null;
  await e.converge('policy push');
  ok('unassigned: each key gets back what it was shadowing', h.policy.hunt === 'living tree'
     && h.policy.assignedRoom === 536 && h.policy.roam === true && h.policy.huntPriority === null
     && JSON.stringify(h.policy.protectedItems) === '["elderberry"]', JSON.stringify(h.policy));
  ok('...and the source book says so', h.policySources.sourceOf('assignedRoom').source === 'roster'
     && h.policySources.sourceOf('hunt').restored_from === 'strategy:wf');
}

// ------------------------------------------------------------------ yield
console.log('yielded while a bot or lease holds the faculty — and never fought over');
{
  const h = fakeHost({ farmStrategy: 'wf' });
  const e = new FarmStrategyEngine(h);
  h.claims.set('work', 'dum');
  await e.converge('pass');
  ok('work held by dum: hunt and huntPriority are NOT written', h.policy.hunt === 'living tree'
     && h.policy.huntPriority === null);
  ok('...movement and economy still apply (the keeper owns them)', h.policy.assignedRoom === 537
     && h.policy.lootOnly?.spider?.[0] === 'purple mushroom');
  const st = e.status();
  ok('status: partly yielded, and names the holder per key', st.state === 'partly yielded'
     && st.keys.hunt.yielded_to === 'dum' && st.keys.hunt.applied === false && st.keys.assignedRoom.yielded_to === null);
  ok('a note says it is yielding and to whom', h.notes.some(n => n.what === 'farm strategy yielding to the faculty holder'
     && n.data.holders.includes('dum')));
  // The bot writes hunt; the strategy must not touch it, pass after pass.
  let writes = 0;
  for (let i = 0; i < 6; i++) {
    h.policy.hunt = i % 2 ? 'spider' : 'zombie';            // the bot changes its mind
    const was = h.policy.hunt;
    await e.converge('pass');
    if (h.policy.hunt !== was) writes++;
  }
  ok('six passes under the bot: zero strategy writes to its keys (no flip-flop)', writes === 0);
  const s2 = new PolicySourceBook();
  ok('a push landing while a bot holds the faculty is credited to the bot',
     sources.sourceForPush('hunt', { facultyOf: k => schema.KEY_FACULTY[k], ownerOf: f => f === 'work' ? 'dum' : 'keeper' }) === 'bot:dum'
     && sources.sourceForPush('hunt', { facultyOf: k => schema.KEY_FACULTY[k], ownerOf: () => 'keeper' }) === 'policy'
     && sources.sourceForPush('fleeBelow', { facultyOf: k => schema.KEY_FACULTY[k] ?? null, ownerOf: () => 'dum' }) === 'policy');
  h.claims.delete('work');
  await e.converge('pass');
  ok('lease over: the file\'s value returns, once', JSON.stringify(h.policy.hunt) === '["spider","living tree"]'
     && h.notes.some(n => n.what === 'farm strategy resumed its keys'));
  h.combat = 77;
  h.policy.hunt = 'zombie';
  await e.converge('pass');
  ok('the keeper\'s OWN combat is not a holder: the strategy still answers', JSON.stringify(h.policy.hunt) === '["spider","living tree"]');
  h.combat = null;
  h.claims.set('work', 'inert:errand');
  ok('an errand (inert) is a holder', e.heldBy('work') === 'inert:errand');
}

// ------------------------------------------------------------------ refused, keep the posture
console.log('a refused file keeps the posture');
{
  writeStrategy('broken', 'export default { name: "broken", hunt: [ ;');
  const h = fakeHost({ farmStrategy: 'broken' });
  const e = new FarmStrategyEngine(h);
  const before = JSON.stringify(h.policy);
  const st = await e.converge('pass');
  ok('first load refused: NOTHING is applied (not an empty policy)', JSON.stringify(h.policy) === before
     && st.state === 'refused' && /existing posture/.test(st.refused.keeping));
  ok('...and it is noted with the reason', h.notes.some(n => n.what === 'farm strategy refused' && /did not load/.test(n.data.why)));
  const n0 = h.notes.length;
  await e.converge('pass'); await e.converge('pass');
  ok('an unchanged broken file is not re-imported or re-noted every pass', h.notes.length === n0);
}

// ------------------------------------------------------------------ hot reload
console.log('hot reload: no keeper restart');
{
  writeStrategy('hot', strat('hot', `hunt: 'spider', confine: { station: 537 }`));
  const h = fakeHost({ farmStrategy: 'hot' });
  const e = new FarmStrategyEngine(h);
  await e.converge('pass');
  ok('v1 applied', h.policy.hunt === 'spider' && h.policy.assignedRoom === 537);
  writeStrategy('hot', strat('hot', `hunt: 'living tree', huntPriority: ['living tree']`));
  await e.converge('pass');
  ok('v2 picked up on the next pass after the file changed', h.policy.hunt === 'living tree'
     && h.policy.huntPriority?.[0] === 'living tree' && e.reloads === 1);
  ok('a key the new version dropped goes back to what it shadowed', h.policy.assignedRoom === 536);
  writeStrategy('hot', 'export default { name: "hot", hunt: [ ;');
  await e.converge('pass');
  const st = e.status();
  ok('a broken edit is refused and the PREVIOUS GOOD version stays in force', h.policy.hunt === 'living tree'
     && st.refused && /previous version/.test(st.refused.keeping) && st.state === 'applied');
  writeStrategy('hot', strat('hot', `hunt: 'zombie'`));
  await e.converge('pass');
  ok('fixed again: reloaded, refusal cleared', h.policy.hunt === 'zombie' && e.status().refused === null && e.reloads === 2);
  rmSync(join(DIR, 'hot.mjs'));
  await e.converge('pass');
  ok('the file deleted: refused, and the last good posture is kept', h.policy.hunt === 'zombie'
     && /does not exist/.test(e.status().refused?.why ?? ''));
}

// ------------------------------------------------------------------ hooks
console.log('hooks: isolated, timed, and only while the keeper owns work');
{
  writeStrategy('hooky', strat('hooky', `hunt: 'spider', hooks: {
    onPass(ctx) { ctx.memory.passes = (ctx.memory.passes ?? 0) + 1; if (ctx.memory.passes === 2) throw new Error('boom'); },
    onKill(ctx, k) { return Promise.reject(new Error('async boom')); },
    beforeSwing(ctx, s) { const t = Date.now(); while (Date.now() - t < 15) {} },
    onCombatLine(ctx, l) { (ctx.memory.lines ??= []).push(l.parsed.kind); },
    onServerMessage(ctx, m) { (ctx.memory.msgs ??= []).push(m.text);
      if (/switch/.test(m.text)) ctx.set('huntPriority', ['spider']);
      if (/recast/.test(m.text)) ctx.requestTouchRecast('test');
      if (/survive/.test(m.text)) ctx.set('fleeBelow', 0); },
  }`));
  const h = fakeHost({ farmStrategy: 'hooky' });
  const e = new FarmStrategyEngine(h, { budgetMs: 5 });
  h.client.say('history: You killed the spider.');               // before attach: never replayed
  await e.converge('pass');
  ok('onPass ran', e.memory.passes === 1 && e.status().hooks.onPass.calls === 1);
  await e.converge('pass');
  ok('a hook that THROWS is disabled, noted, and the pass carries on', /threw: boom/.test(e.status().hooks.onPass.disabled ?? '')
     && h.notes.some(n => n.what === 'farm strategy hook disabled') && h.policy.hunt === 'spider');
  await e.converge('pass');
  ok('...and is not called again', e.memory.passes === 2);
  e.dispatch('onKill', { creature: 'spider' });
  await sleep(5);
  ok('a hook whose promise REJECTS is disabled', /rejected: async boom/.test(e.status().hooks.onKill.disabled ?? ''));
  for (let i = 0; i < 3; i++) e.dispatch('beforeSwing', { target: 'spider' });
  ok('a hook over its time budget three times is disabled', /budget/.test(e.status().hooks.beforeSwing.disabled ?? ''));
  ok('history before the engine attached is skipped', !(e.memory.lines ?? []).length);
  h.client.say('~bYour mace crushes the spider.');
  h.client.say('Welcome to the forest.');
  await e.converge('pass');
  ok('a combat line goes to onCombatLine, parsed', JSON.stringify(e.memory.lines) === '["my-swing"]');
  ok('any other line goes to onServerMessage', JSON.stringify(e.memory.msgs) === '["Welcome to the forest."]');
  h.client.say('please switch');
  await e.converge('pass');
  ok('ctx.set applies a directional key at once, credited to the strategy and marked as a hook',
     h.policy.huntPriority?.[0] === 'spider' && h.policySources.sourceOf('huntPriority').hook === true
     && e.status().keys.huntPriority.set_by_hook === true);
  h.touch.active = true;
  h.client.say('please recast');
  await e.converge('pass');
  ok('ctx.requestTouchRecast marks the CENTRAL touch state stale', h.touch.active === false);
  h.client.say('please survive');
  await e.converge('pass');
  ok('ctx.set of a survival key throws inside the hook: the hook is disabled, flee is untouched',
     h.policy.fleeBelow === 0.4 && /not a strategy field/.test(e.status().hooks.onServerMessage.disabled ?? ''));

  // Hooks do not run while a bot holds work.
  writeStrategy('counter', strat('counter', `hunt: 'spider', hooks: { onPass(ctx) { ctx.memory.n = (ctx.memory.n ?? 0) + 1; } }`));
  const h2 = fakeHost({ farmStrategy: 'counter' });
  const e2 = new FarmStrategyEngine(h2);
  h2.claims.set('work', 'dum');
  await e2.converge('pass'); await e2.converge('pass');
  ok('while a bot holds work, hooks are skipped and counted', !e2.memory.n && e2.status().hooks.onPass.skipped_held === 2);
  h2.claims.delete('work');
  await e2.converge('pass');
  ok('...and run again when the keeper has it back', e2.memory.n === 1);
  const ctx = e2.ctx();
  let mutated = true;
  try { ctx.policy.hunt = 'x'; mutated = ctx.policy.hunt === 'x'; } catch { mutated = false; }
  ok('a hook sees a frozen COPY of the policy: it cannot write around the gate', !mutated && h2.policy.hunt === 'spider');
  ok('ctx.pack() reads the pack by name and amount', ctx.pack().find(i => i.name === 'entroot berry')?.amount === 2);
}

// ------------------------------------------------------------------ the keeper itself
console.log('in the keeper: the policy key, the push, status, survival');
{
  writeStrategy('wf2', strat('wf2', `hunt: ['spider', 'living tree'], huntPriority: ['spider'], confine: { station: 537 }`));
  const s = { name: 't1', live: true, client: null, world: { room: { num: 537 } }, need: () => null,
              pacer: { submit: async (_k, fn) => fn() } };
  const ap = new Autopilot(s, { mode: 'farm', policy: { hunt: 'living tree', assignedRoom: 536 } });
  ok('farmStrategy is a key of the default policy object (so a push is reflected)',
     Object.hasOwn(ap.policy, 'farmStrategy') && ap.policy.farmStrategy === null);
  ok('farmStrategy is not the existing `strategy` key (a STRATEGIES pattern)', Object.hasOwn(ap.policy, 'strategy')
     && 'strategy' !== 'farmStrategy');
  ok('status: farm_strategy null with none assigned, policy_sources present', ap.status().farm_strategy === null
     && ap.status().policy_sources?.hunt?.source === 'roster');
  const survival = { fleeBelow: ap.policy.fleeBelow, restBelow: ap.policy.restBelow,
                     defend: ap.policy.defendAgainstPlayers, pvp: ap.policy.pvpReturnDelayMs };
  // The keeper's POST /policy: Object.assign(autopilot.policy, fields), then applyFarmStrategy.
  Object.assign(ap.policy, { farmStrategy: 'wf2' });
  await ap.applyFarmStrategy('policy push');
  const st = ap.status();
  ok('a pushed farmStrategy round-trips and is applied without a restart',
     JSON.stringify(ap.policy.hunt) === '["spider","living tree"]' && ap.policy.assignedRoom === 537
     && st.farm_strategy?.state === 'applied', JSON.stringify(st.farm_strategy?.state));
  ok('status answers "why is t1 hunting spiders": policy_sources.hunt = strategy:wf2',
     st.policy_sources.hunt.source === 'strategy:wf2' && st.farm_strategy.keys.hunt.shadowing.value === 'living tree');
  ok('survival and war keys are exactly as they were', ap.policy.fleeBelow === survival.fleeBelow
     && ap.policy.restBelow === survival.restBelow && ap.policy.defendAgainstPlayers === survival.defend
     && ap.policy.pvpReturnDelayMs === survival.pvp);
  ok('the protected four are still the keeper\'s', ['identity', 'mortality', 'survival', 'recovery']
     .every(f => ap.facultyStatus()[f] === 'keeper'));
  ok('policyForOrders (what persists) carries the assignment and not the overlay',
     ap.policyForOrders().farmStrategy === 'wf2' && ap.policyForOrders().hunt === 'living tree'
     && ap.policyForOrders().assignedRoom === 536);
  ap.claimFaculties({ faculties: ['work'], by: 'dum', leaseMs: 60_000 });
  ap.policy.hunt = 'zombie';
  await ap.applyFarmStrategy('pass');
  ok('a real claim: the keeper\'s farm strategy yields work to dum', ap.policy.hunt === 'zombie'
     && ap.status().farm_strategy.keys.hunt.yielded_to === 'dum' && ap.status().farm_strategy.state === 'partly yielded');
  const refuse = ap.claimFaculties({ faculties: ['survival'], by: 'dum' });
  ok('...and a strategy changes nothing about what a bot may take: survival is still refused', refuse.granted.length === 0);
  ap.releaseFaculties({ faculties: ['work'], by: 'dum' });
  Object.assign(ap.policy, { farmStrategy: null });
  await ap.applyFarmStrategy('policy push');
  ok('unassigned through a push: the orders come back', ap.policy.assignedRoom === 536 && ap.status().farm_strategy === null);

  const src = readFileSync(join(HERE, 'm59-autopilot.mjs'), 'utf8');
  ok('passOnce converges the strategy before anything else decides',
     /async passOnce\(\) \{\s*const s = this\.s;[\s\S]{0,400}await this\.applyFarmStrategy\('pass'\);/.test(src));
  ok('the swing and the kill dispatch the hooks', /this\.farmStrategyHook\('beforeSwing'/.test(src)
     && (src.match(/this\.farmStrategyHook\('onKill'/g) ?? []).length === 2);
  ok('the keeper binds the engine and names no spell, creature or room for it',
     !/farmStrategy[^\n]*(acid|spider|living tree|skeleton|536|537)/i.test(src));

  const keeper = readFileSync(join(HERE, 'm59-keeper-process.mjs'), 'utf8');
  ok('the keeper /policy merge credits changed keys and re-converges the strategy',
     /Object\.assign\(autopilot\.policy, fields\);[\s\S]{0,1200}markChanged[\s\S]{0,800}applyFarmStrategy\?\.\('policy push'\)/.test(keeper));
  ok('a rejoin credits roster/carry and converges before start()',
     /markChanged\(beforeJoin, autopilot\.policy/.test(keeper) && /applyFarmStrategy\?\.\('join'\);[\s\S]{0,80}autopilot\.start\(\)/.test(keeper));

  const carry = await import('./m59-keeper-carry.mjs');
  const c = carry.captureCarry({ agent: 't1', character: 'Kermit', pid: 1, reason: 'handoff', claims: null, busy: null,
    bootPolicy: { hunt: 'living tree' }, livePolicy: { hunt: 'living tree', farmStrategy: 'wf2' } });
  const adopt = carry.policyToAdopt(c, { hunt: 'living tree' });
  ok('the CARRY moves the assignment by name and nothing of the file', adopt.fields.farmStrategy === 'wf2'
     && !('huntPriority' in adopt.fields) && Object.keys(adopt.fields).length === 1, JSON.stringify(adopt.fields));

  const broker = readFileSync(join(HERE, 'm59-broker.mjs'), 'utf8');
  ok('the broker schema declares farm_strategy', /farm_strategy: \{ type: \['string', 'null'\],/.test(broker));
  ok('the setter loads and validates the file, refusing with the reason',
     /const r = await loadFarmStrategy\(String\(a\.farm_strategy\)\.trim\(\)\);\s*if \(!r\.ok\) return \{ started: false, reason: `farm_strategy refused: \$\{r\.why\}`/.test(broker)
     && /p\.policy\.farmStrategy = r\.name;/.test(broker));
  ok('the broker persists the orders, not the overlay', (broker.match(/rememberAutopilot\([^)]*policyForOrders/g) ?? []).length === 2);
  const { reflectPolicy } = await import('./m59-policy-controls.mjs');
  const fakeTool = { schema: { properties: { farm_strategy: { type: ['string', 'null'] } } },
                     run: () => 'p.policy.farmStrategy = r.name' };
  const spec = reflectPolicy(fakeTool, [ap.policy]).find(sp => sp.id === 'farm_strategy');
  ok('policy_control reflects it onto policy.farmStrategy', spec?.policy === 'farmStrategy');
}

// ------------------------------------------------------------------ the leak (2026-10-03/04)
// Floyd (t16) and Animal (t10): icky-cave-orc-clear unassigned, spareCreatures ["spider"] and
// confineRooms [27] stayed for ever, status showing shadowing {value: ["spider"], source: "carry"}.
// The broker seeded its order from the EFFECTIVE policy, persisted it and pushed it whole; the
// keeper merged it into its order copy; the next rejoin's engine took the file's value for what it
// was shadowing. These cases drive that chain with a real Autopilot and the keeper's merge rule.
console.log('the leak: a strategy\'s keys must not become orders');
{
  const { ordersFromStatus, strategyResidue, RESIDUE_KEEP } = engine;
  const { policyDefaults } = await import('./m59-autopilot.mjs');
  writeStrategy('ick', strat('ick', `hunt: ['orc'], spare: ['spider'],
    confine: { station: 27, rooms: [27], roam: false }`));
  const mkSession = () => ({ name: 't16', live: true, client: null, world: { room: { num: 27 } }, need: () => null,
                             pacer: { submit: async (_k, fn) => fn() } });
  // The keeper process: an order copy (`policy`, what the carry and every rejoin re-impose) and the
  // Autopilot. `keeperPush` is the /policy merge exactly as m59-keeper-process.mjs does it now.
  const roster = { hunt: 'living tree', assignedRoom: 536, roam: true };
  let orderCopy = { ...roster };
  let ap = new Autopilot(mkSession(), { mode: 'farm', policy: { ...orderCopy } });
  const keeperPush = async (fields) => {
    const pushed = { ...fields };
    const echo = ap.farmStrategyPushEcho(pushed);
    const orderFields = { ...pushed }, live = { ...pushed };
    for (const k of echo.echo) { delete orderFields[k]; delete live[k]; }
    for (const k of echo.restated) delete live[k];
    Object.assign(orderCopy, orderFields);
    Object.assign(ap.policy, live);
    await ap.applyFarmStrategy('policy push');
    return echo;
  };
  await keeperPush({ farmStrategy: 'ick' });
  ok('assigned: the file is in force live', JSON.stringify(ap.policy.spareCreatures) === '["spider"]'
     && JSON.stringify(ap.policy.confineRooms) === '[27]' && ap.policy.assignedRoom === 27 && ap.policy.roam === false);

  // An OLD broker (or anything holding the port) read the effective policy and pushed it all back.
  const effective = { ...ap.status().policy };
  const echo = await keeperPush(effective);
  ok('the keeper recognises the file\'s own values in a push as an echo, not orders',
     ['spareCreatures', 'confineRooms', 'assignedRoom', 'roam', 'hunt'].every(k => echo.echo.includes(k)),
     JSON.stringify(echo));
  ok('...and keeps them out of its order copy (so out of the carry and the next rejoin)',
     orderCopy.spareCreatures === undefined && orderCopy.confineRooms === undefined
     && orderCopy.assignedRoom === 536 && orderCopy.roam === true && orderCopy.hunt === 'living tree',
     JSON.stringify(orderCopy));
  ok('...and the live overlay is untouched, with no reassert churn', ap.policy.assignedRoom === 27
     && ap._farmStrategy.reasserts === 0);

  // A restatement of what the file shadows is an order, and already the one underneath.
  const re = await keeperPush({ assignedRoom: 536, hunt: 'living tree' });
  ok('a push restating the shadowed order lands in the order copy, not over the overlay',
     re.restated.includes('assignedRoom') && re.restated.includes('hunt') && ap.policy.assignedRoom === 27
     && orderCopy.assignedRoom === 536 && ap._farmStrategy.reasserts === 0, JSON.stringify(re));

  // The NEW broker seeds from the orders.
  const st = ap.status();
  ok('status publishes policy_orders: the orders with the overlay taken out', st.policy_orders
     && st.policy_orders.spareCreatures == null && st.policy_orders.confineRooms == null
     && st.policy_orders.assignedRoom === 536 && st.policy_orders.farmStrategy === 'ick',
     JSON.stringify(st.policy_orders && { s: st.policy_orders.spareCreatures, a: st.policy_orders.assignedRoom }));
  const fromNew = ordersFromStatus(st);
  const { policy_orders: _po, ...oldShape } = st;          // what a keeper predating the fix reports
  const fromOld = ordersFromStatus(oldShape);
  ok('ordersFromStatus: policy_orders when present', fromNew.assignedRoom === 536 && fromNew.spareCreatures == null);
  ok('ordersFromStatus: an OLDER keeper\'s status is undone through farm_strategy.keys[].shadowing',
     fromOld.assignedRoom === 536 && fromOld.spareCreatures == null && fromOld.roam === true
     && fromOld.hunt === 'living tree' && fromOld.farmStrategy === 'ick', JSON.stringify(
       { a: fromOld.assignedRoom, s: fromOld.spareCreatures, r: fromOld.roam, h: fromOld.hunt }));
  ok('ordersFromStatus: a yielded key (not applied) keeps its effective value',
     ordersFromStatus({ policy: { hunt: 'zombie' }, farm_strategy: { keys: { hunt: { applied: false,
       shadowing: { value: 'living tree' } } } } }).hunt === 'zombie');
  ok('ordersFromStatus: no status is no orders, never an empty policy', ordersFromStatus(null) === null
     && ordersFromStatus({}) === null);

  // A REJOIN from the clean order copy, then unassign: everything goes back.
  ap = new Autopilot(mkSession(), { mode: 'farm', policy: { ...orderCopy } });
  await ap.applyFarmStrategy('join');
  ok('after a rejoin the engine shadows the ORDERS, not the file', ap.status().farm_strategy.keys
     .spareCreatures.shadowing.value == null && ap.status().farm_strategy.keys.assignedRoom.shadowing.value === 536);
  await keeperPush({ ...ordersFromStatus(ap.status()), farmStrategy: null });
  ok('unassigned: spareCreatures, confineRooms, the station and roam all come back',
     ap.policy.spareCreatures == null && ap.policy.confineRooms == null && ap.policy.assignedRoom === 536
     && ap.policy.roam === true && ap.policy.hunt === 'living tree' && ap.policy.farmStrategy === null,
     JSON.stringify({ s: ap.policy.spareCreatures, c: ap.policy.confineRooms, a: ap.policy.assignedRoom }));
  ok('...and the order copy never held the file\'s values', orderCopy.spareCreatures == null
     && orderCopy.confineRooms == null && orderCopy.farmStrategy === null);

  // THE OLD DAMAGE: an order copy that already carries the file's values (what prod had). The
  // engine cannot know, so it "restores" the file's value — which is why the unassignment itself
  // checks for residue.
  orderCopy = { ...roster, spareCreatures: ['spider'], confineRooms: [27], farmStrategy: 'ick' };
  ap = new Autopilot(mkSession(), { mode: 'farm', policy: { ...orderCopy } });
  await ap.applyFarmStrategy('join');
  ok('(the mechanism) a contaminated order copy is what the engine shadows, source roster/carry',
     JSON.stringify(ap.status().farm_strategy.keys.spareCreatures.shadowing.value) === '["spider"]');
  new Autopilot(mkSession());                         // autopilotFor builds one with no orders
  const dflt = policyDefaults();
  ok('policyDefaults(): the pristine default object, captured from an orderless Autopilot',
     dflt && Object.hasOwn(dflt, 'spareCreatures') && dflt.spareCreatures === null && dflt.roam === false
     && dflt.hunt === null, JSON.stringify(dflt && { s: dflt.spareCreatures, r: dflt.roam }));
  const ick = (await loadFarmStrategy('ick')).strategy;
  const res = strategyResidue({ orders: ordersFromStatus(ap.status()), desired: ick.desired, defaults: dflt });
  ok('strategyResidue: the leaked spare and confine go back to the default',
     Object.hasOwn(res.reset, 'spareCreatures') && res.reset.spareCreatures === null
     && Object.hasOwn(res.reset, 'confineRooms') && res.reset.confineRooms === null, JSON.stringify(res.reset));
  ok('...a station/roam the operator had (536, roam) is not residue', !Object.hasOwn(res.reset, 'assignedRoom')
     && !Object.hasOwn(res.reset, 'roam'));
  const res2 = strategyResidue({ orders: { hunt: ['orc'], spareCreatures: ['spider'], roam: false, protectedItems: ['wand'] },
    desired: { hunt: ['orc'], spareCreatures: ['spider'], roam: false, protectedItems: ['wand'] },
    defaults: dflt, explicit: ['spareCreatures'] });
  ok('strategyResidue: an argument in the same call wins; hunt is kept and reported; protect is additive; ' +
     'a key whose default IS the file\'s value is left alone',
     !Object.hasOwn(res2.reset, 'spareCreatures') && res2.kept.includes('hunt') && RESIDUE_KEEP.includes('hunt')
     && !Object.hasOwn(res2.reset, 'protectedItems') && !Object.hasOwn(res2.reset, 'roam'), JSON.stringify(res2));
  Object.assign(orderCopy, res.reset);
  await keeperPush({ ...ordersFromStatus(ap.status()), ...res.reset, farmStrategy: null });
  ok('an unassignment that carries the residue reset clears the old damage live and in the orders',
     ap.policy.spareCreatures == null && ap.policy.confineRooms == null && orderCopy.spareCreatures == null
     && ap.policy.assignedRoom === 536, JSON.stringify({ s: ap.policy.spareCreatures, c: ap.policy.confineRooms }));

  // spare_creatures: set and clear, round-tripped through the keeper push.
  const spare = schema.fieldFor('spare');
  ok('spare_creatures normalises like the strategy field: names lower-cased, [] and null clear',
     JSON.stringify(spare.normalize(['Spider', 'spider '])) === '["spider"]' && spare.normalize([]) === null
     && spare.normalize(null) === null);
  let threw = false; try { spare.normalize('spider'); } catch { threw = true; }
  ok('...and a non-list is refused, not coerced', threw);
  const s2 = mkSession();
  const ap2 = new Autopilot(s2, { mode: 'farm', policy: { hunt: 'orc' } });
  ok('spareCreatures is NAMED in the default object (a keeper push of it is not dropped)',
     Object.hasOwn(ap2.policy, 'spareCreatures'));
  Object.assign(ap2.policy, { spareCreatures: spare.normalize(['spider']) });
  ok('a pushed spare list reaches the session\'s attack veto', JSON.stringify(s2.sparePatterns()) === '["spider"]');
  Object.assign(ap2.policy, { spareCreatures: spare.normalize([]) });
  ok('a pushed [] clears it', s2.sparePatterns() === null);

  const broker = readFileSync(join(HERE, 'm59-broker.mjs'), 'utf8');
  ok('the broker seeds a keeper-backed order from the ORDERS, never the effective policy',
     /p\.policy = ordersFromStatus\(live\.autopilot_status\)/.test(broker)
     && !/p\.policy = \{ \.\.\.live\.autopilot_status\.policy \};/.test(broker));
  ok('the broker declares spare_creatures and sets it through the strategy field\'s normaliser',
     /spare_creatures: \{ type: \['array', 'null'\]/.test(broker)
     && /p\.policy\.spareCreatures = farmStrategyField\('spare'\)\.normalize\(a\.spare_creatures \?\? null\)/.test(broker));
  ok('an unassignment checks for residue and reports farm_strategy_released',
     /strategyResidue\(\{ orders: p\.policyForOrders/.test(broker) && /out\.farm_strategy_released = farmStrategyReleased/.test(broker));
  const { reflectPolicy } = await import('./m59-policy-controls.mjs');
  const tool = { schema: { properties: { spare_creatures: { type: ['array', 'null'] } } },
                 run: () => 'p.policy.spareCreatures = x' };
  ok('policy_control reflects spare_creatures onto policy.spareCreatures',
     reflectPolicy(tool, [ap2.policy]).find(sp => sp.id === 'spare_creatures')?.policy === 'spareCreatures');
  const keeper = readFileSync(join(HERE, 'm59-keeper-process.mjs'), 'utf8');
  ok('the keeper /policy keeps an echo out of its order copy and a restatement off the overlay',
     /farmStrategyPushEcho\?\.\(pushed\)/.test(keeper) && /Object\.assign\(policy, orderFields\);/.test(keeper)
     && /for \(const k of strategyEcho\.restated\) delete fields\[k\];/.test(keeper));
}

console.log(`\n${pass} passed, ${fail} failed`);
try { rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
