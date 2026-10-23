// Offline guard for THE farmBuff SEAM (Autopilot.farmBuffContext / farmBuffAsk / farmBuffPass / castSelfSpell,
// the 'farmBuff' strategy hook, Session.rejoin's offline wait). Opens no socket.
//
//   node tools/m59-farm-buff-test.mjs
//
// Operator, 2026-10-12: a self-buff tactic for the lupogg hunters (when to cast it, being back on the safe
// spot before it ends, logging off to wait out what its end brings) is PRIVATE. The tactic lives in
// substrate/strategies/; this file pins only the seam: what the question carries, the closed set of answers
// and what each one does, that silence and nonsense do nothing, and the call sites.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OF } from './m59-parse.mjs';
import { Autopilot } from './m59-autopilot.mjs';
import { HOOKS } from './m59-strategies.mjs';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };
const AUTOPILOT = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
const GAME = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');

function keeper({ answer = null, self = { col: 20, row: 20 }, hold = { room: 112, col: 20, row: 20 }, mana = 40 } = {}) {
  const asked = [], casts = [], reconnects = [], walks = [];
  const names = { 1: "Kara'hol's curse", 2: 'entroot berry', 3: 'lupogg', 4: 'giant rat' };
  const c = { selfId: 7, evSeq: 0, self, rsc: { get: k => names[k] ?? '' },
    spells: [{ id: 501, nameRsc: 1 }],
    inventory: [{ id: 9, nameRsc: 2, amount: 12 }],
    enchantments: () => [{ name: 'Hold' }],
    events: [{ kind: 'message', at: Date.now() - 1000, text: 'Your body freezes as total exhaustion grips your limbs.' },
             { kind: 'message', at: Date.now() - 300_000, text: 'old news' }],
    vitals: () => ({ health: { value: 70, max: 70 }, mana: { value: mana, max: 60 } }),
    cast: (id, t) => { casts.push({ id, t }); mana -= 9; }, waitFor: async () => ({ events: [] }) };
  const ap = Object.create(Autopilot.prototype);
  ap.policy = { farmStrategy: 'qor-lupogg-sewers', spareCreatures: ['giant rat'] };
  ap.tally = {}; ap.note = () => {}; ap.recordCast = () => {}; ap.who = () => 'Janice';
  ap.hold = hold;
  ap.inReachOfUs = () => [{ id: 30, nameRsc: 3, flags: OF.ATTACKABLE }, { id: 31, nameRsc: 4, flags: OF.ATTACKABLE }];
  ap.reconnect = async (why, opts) => { reconnects.push({ why, opts }); return { ok: true }; };
  ap.s = { name: 't7', client: c, world: { room: { num: 112 } }, pacer: { submit: async (k, f) => f() },
    _askStrategies: async (hook, ctx) => { asked.push({ hook, ctx }); return answer ? { strategy: 'karahols-curse', answer } : null; } };
  return { ap, asked, casts, reconnects, walks };
}

await ok('the hook is a known strategy hook', () => assert.ok(HOOKS.includes('farmBuff')));

await ok('the question: vitals, enchantments, held, unspared reach, the wall and the walk to it, pack, spells, heard', async () => {
  const { ap, asked } = keeper({ self: { col: 23, row: 20 } });
  await ap.farmBuffAsk('before_pull', { target_id: 30 });
  const { hook, ctx } = asked[0];
  assert.equal(hook, 'farmBuff');
  assert.equal(ctx.phase, 'before_pull');
  assert.equal(ctx.target_id, 30);
  assert.equal(ctx.farm_strategy, 'qor-lupogg-sewers');
  assert.equal(ctx.held, true);
  assert.equal(ctx.in_reach, 1, 'the spared rat is not counted');
  assert.deepEqual(ctx.safe_spot, { col: 20, row: 20 });
  assert.equal(ctx.at_safe_spot, false);
  assert.ok(ctx.eta_to_safe_spot_ms > 0);
  assert.equal(ctx.pack['entroot berry'], 12);
  assert.ok(ctx.spells.includes("kara'hol's curse"));
  assert.equal(ctx.heard.length, 1, 'only the last two minutes');
});

await ok('silence and nonsense do nothing', async () => {
  for (const answer of [null, 'cast it', 42]) {
    const k = keeper({ answer });
    const r = await k.ap.farmBuffAsk('pass');
    assert.equal(r, null);
    assert.equal(k.casts.length + k.reconnects.length, 0);
  }
});

await ok('cast: a known spell at our own id, landed by mana spent, at most once in ten seconds', async () => {
  const k = keeper({ answer: { cast: "kara'hol's curse", why: 'starting' } });
  const r = await k.ap.farmBuffAsk('before_pull');
  assert.deepEqual(k.casts, [{ id: 501, t: [7] }]);
  assert.equal(r.cast.landed, true);
  await k.ap.farmBuffAsk('before_pull');
  assert.equal(k.casts.length, 1);
  const u = keeper({ answer: { cast: 'blind' } });
  assert.equal((await u.ap.farmBuffAsk('pass')).cast.landed, false, 'an unknown spell is not cast');
  assert.equal(u.casts.length, 0);
});

await ok('logoff: offline for for_ms (clamped 1-60 s), then back; the pass is over', async () => {
  const k = keeper({ answer: { logoff: { for_ms: 7000 }, why: 'waiting out the hold' } });
  assert.equal(await k.ap.farmBuffPass(), true);
  assert.deepEqual(k.reconnects[0].opts, { offlineMs: 7000 });
  const big = keeper({ answer: { logoff: { for_ms: 10 * 60_000 } } });
  await big.ap.farmBuffAsk('pass');
  assert.equal(big.reconnects[0].opts.offlineMs, 60_000);
});

await ok('no_engage refuses the pull before walking out; go_to_safe_spot only when off it', async () => {
  const pull = AUTOPILOT.slice(AUTOPILOT.indexOf('  async pull(want) {'));
  const ask = pull.indexOf("const fb = await this.farmBuffAsk('before_pull'");
  assert.ok(ask > 0 && ask < pull.indexOf('await s.walkTo(approach.col'));
  assert.ok(pull.includes("if (fb?.no_engage) return { pulled: false, why: `${fb.strategy}: ${fb.why ?? 'not now'}` };"));
  const onSpot = keeper({ answer: { go_to_safe_spot: true, no_engage: true } });
  const r = await onSpot.ap.farmBuffAsk('pass');
  assert.equal(r.went, undefined, 'already on the spot: no walk');
  assert.equal(r.no_engage, true);
});

await ok('the call sites, and the session can stay offline', () => {
  const flee = AUTOPILOT.slice(AUTOPILOT.indexOf('  async passFleeAndRest(ctx) {'));
  const buffCall=flee.indexOf('if (await this.farmBuffPass().catch(() => false)) return HANDLED;');
  assert.ok(buffCall>=0&&buffCall<flee.indexOf('// 2. In danger.'),'buff hook still precedes ordinary danger decisions, after protected recovery');
  assert.ok(AUTOPILOT.includes("await this.farmBuffAsk('before_swing', { target: engageName }).catch(() => null);"));
  assert.ok(AUTOPILOT.includes('const r = await this.s.rejoin(why, { offlineMs }).then('));
  assert.ok(GAME.includes("async rejoinConnection(why = 'unspecified', { offlineMs = 0 } = {}) {"));
  assert.ok(GAME.includes('Math.max(800, Math.min(60_000, Number(offlineMs) || 0))'));
  assert.ok(!/castEngageBuff|engageBuff/.test(AUTOPILOT), 'the public engage-buff tactic is gone');
});

console.log(`\n${n} passed`);
