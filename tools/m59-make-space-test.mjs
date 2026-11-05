// MAKE SPACE AND THE SALE PLAN VIEW, OFFLINE. tools/m59-make-space.mjs, Autopilot ownSalePlan /
// salePlanView / makeSpaceNow (autopilot/shopping.mjs) and the unarmed hook unarmedMakeSpace
// (autopilot/pass-combat.mjs), against a fake client and the REAL inventorySalePlan. No socket,
// no roster. Pins: only sale-plan rows are dropped; least value per unit of the short dimension
// first; partial stacks; the 400 cap; short_by when the plan cannot cover it; never money,
// equipped, protected, food or the keep list; each drop verified by a re-read; sale_plan has no
// side effects and shows exactly what make_space chooses from; the hook drops then re-arms and is
// rate-bounded.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'm59-make-space-test-'));
process.env.M59_FLEET = 'make-space-offline-test';
process.env.M59_LEDGER_DIR = join(scratch, 'ledger');
process.env.M59_INVENTORY_INTENT_DIR = join(scratch, 'intent');

const { Session } = await import('./m59-game.mjs');
const { Autopilot } = await import('./m59-autopilot.mjs');
const MS = await import('./m59-make-space.mjs');
const { UNARMED_MAKE_SPACE_EVERY_MS } = await import('./autopilot/pass-combat.mjs');
const { autopilotSource } = await import('./autopilot/source.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`); }
};

// A pack with 75 bulk free (might 0 -> 1700 max). Values per bulk: fairy wing 2.8, red mushroom
// 5.6, purple mushroom 11.2, emerald 21, web moss unknown. Herbs are on the keep list, the spider
// eyes are food, the leather armour is worn, the shillings are money.
function fixture({ protect = [], dropRefuses = new Set(), heldBack = new Set(), packOverride = null } = {}) {
  const s = new Session('MakeSpaceTester');
  let seq = 0, id = 100;
  const events = [], drops = [], wire = [];
  const item = (name, amount) => ({ id: ++id, nameRsc: name, amount });
  const inventory = packOverride ?? [
    item('leather armor', 0), item('herb', 300), item('fairy wing', 10), item('red mushroom', 10),
    item('purple mushroom', 10), item('emerald', 50), item('web moss', 10), item('shilling', 500),
    item('spider eye', 5),
  ];
  const c = {
    me: { name: 'MakeSpaceTester' }, selfId: 1, inventory, room: { objects: new Map() },
    using: new Set([inventory[0].id]),
    rsc: { get: n => n || '' }, stat: k => (k === 'might' ? 0 : null),
    get evSeq() { return seq; },
    requestInventory() { wire.push('inventory'); events.push({ seq: ++seq, kind: 'inventory' }); },
    waitFor: async ({ since = 0, kinds = [] }) => ({ events: events.filter(e => e.seq > since && kinds.includes(e.kind)) }),
    drop(specs) {
      wire.push('drop');
      for (const spec of specs) {
        const sid = typeof spec === 'number' ? spec : spec.id;
        const o = c.inventory.find(x => x.id === sid);
        if (!o || dropRefuses.has(c.rsc.get(o.nameRsc))) continue;
        const n = typeof spec === 'number' ? (o.amount || 1) : spec.amount;
        drops.push({ name: c.rsc.get(o.nameRsc), amount: n });
        o.amount -= n;
        if (!(o.amount > 0)) c.inventory = c.inventory.filter(x => x.id !== sid);
      }
    },
  };
  s.client = c; s.need = () => c; s.pacer = { submit: async (_k, fn) => fn() }; s.world = { room: { num: 54 } };
  const ledger = [], notes = [];
  const ap = Object.assign(Object.create(Autopilot.prototype), {
    s, policy: { maxWeapons: null }, notes,
  });
  // Instance overrides of the keeper's own answers; the methods under test are the prototype's.
  ap.protectedItemNames = () => protect;
  ap.loadout = () => null;
  ap.weaponPriorityNow = () => null;
  ap.heldBackIds = () => heldBack;
  ap.islandSaleRelease = null; ap.saleLoadout = null;
  ap.ledgerEvent = (kind, d) => ledger.push({ kind, ...d });
  ap.note = (...a) => notes.push(a);
  return { s, c, ap, drops, ledger, wire, notes };
}

// --- the target and the pure chooser
{
  ok('cap: 1000 bulk clamps to 400', MS.makeSpaceTarget({ bulk: 1000 }).bulk === 400);
  ok('cap: weight 401 clamps to 400, bulk absent is 0',
     MS.makeSpaceTarget({ weight: 401 }).weight === 400 && MS.makeSpaceTarget({ weight: 401 }).bulk === 0);
  ok('cap: negative and junk are 0', MS.makeSpaceTarget({ bulk: -5, weight: 'x' }).bulk === 0 &&
     MS.makeSpaceTarget({ bulk: -5, weight: 'x' }).weight === 0);
  const row = (id, name, amount, extra = {}) => MS.annotateRow({ id, name, amount, sale_amount: amount,
    recommended: true, blocked: null, queued: true, state: 'sell', role: 'other', ...extra });
  const rows = [row(1, 'purple mushroom', 10), row(2, 'fairy wing', 10), row(3, 'web moss', 10), row(4, 'red mushroom', 10)];
  const r = MS.chooseDrops(rows, { free: { bulk: 0, weight: 999 }, need: { bulk: 70, weight: 0 } });
  ok('least value per bulk first, then the next, partial last',
     r.picks.map(p => `${p.amount} ${p.row.name}`).join(',') === '10 fairy wing,4 red mushroom', JSON.stringify(r.picks.map(p => [p.row.name, p.amount])));
  const r2 = MS.chooseDrops(rows, { free: { bulk: 0, weight: 999 }, need: { bulk: 400, weight: 0 } });
  ok('unknown value is dropped only after every known one',
     r2.picks.at(-1).row.name === 'web moss' && r2.short_by.bulk === 400 - 150 - 30, JSON.stringify(r2.short_by));
  const r3 = MS.chooseDrops([row(5, 'emerald', 50, { recommended: false })], { free: { bulk: 0, weight: 0 }, need: { bulk: 10 } });
  ok('a row the plan does not recommend is never chosen', r3.picks.length === 0 && r3.short_by.bulk === 10);
  const r4 = MS.chooseDrops([row(6, 'emerald', 50, { blocked: 'wanted by the fleet' })], { free: { bulk: 0, weight: 0 }, need: { bulk: 10 } });
  ok('a blocked row is never chosen', r4.picks.length === 0);
  const r5 = MS.chooseDrops([row(7, 'emerald', 50, { sale_amount: 3 })], { free: { bulk: 0, weight: 0 }, need: { bulk: 10 } });
  ok('never more of a stack than the plan would sell', r5.picks[0].amount === 3 && r5.short_by.bulk === 7);
  const r6 = MS.chooseDrops([row(8, 'shilling', 500), row(9, 'spider eye', 5, { role: 'food' }),
    row(10, 'arrows', 50), row(11, 'leather armor', 1, { equipped: true })], { free: { bulk: 0, weight: 0 }, need: { bulk: 50 } });
  ok('never money, food, arrows or worn gear, even if a row says sell', r6.picks.length === 0);
  const r7 = MS.chooseDrops(rows, { free: { bulk: 500, weight: 500 }, need: { bulk: 70 } });
  ok('already enough room drops nothing', r7.picks.length === 0 && r7.short_by.bulk === 0);
}

// --- the real sale plan, the read-only view
{
  const f = fixture();
  const before = JSON.stringify(f.c.inventory);
  const v = f.ap.salePlanView();
  ok('sale_plan: ok and one row per pack stack', v.ok === true && v.rows.length === 9, JSON.stringify(v.error ?? v.rows.length));
  const by = n => v.rows.find(r => r.name === n);
  const fields = ['id', 'name', 'amount', 'sale_amount', 'role', 'recommended', 'blocked', 'reason', 'unit', 'unit_value', 'droppable', 'drop_block'];
  ok('sale_plan: rows carry the documented fields', v.rows.every(r => fields.every(k => k in r)));
  ok('sale_plan: per-unit bulk/weight and value', by('fairy wing').unit.bulk === 5 && by('fairy wing').unit_value === 14);
  ok('sale_plan: herbs (keep list), spider eye (food), armour (worn), shillings (money) are not droppable',
     ['herb', 'spider eye', 'leather armor', 'shilling'].every(n => by(n).droppable === false),
     ['herb', 'spider eye', 'leather armor', 'shilling'].map(n => `${n}:${by(n).drop_block}`).join('; '));
  ok('sale_plan: the sale goods are droppable',
     ['fairy wing', 'red mushroom', 'purple mushroom', 'emerald'].every(n => by(n).droppable === true),
     ['fairy wing', 'red mushroom', 'purple mushroom', 'emerald'].map(n => `${n}:${by(n).drop_block}`).join('; '));
  ok('sale_plan: totals of sell vs keep vs droppable', v.totals.sell.stacks >= 4 && v.totals.keep.units > 0 &&
     v.totals.droppable.bulk === 50 + 50 + 50 + 50 + (by('web moss').droppable ? 30 : 0), JSON.stringify(v.totals));
  ok('sale_plan: capacity says 75 bulk free', v.capacity?.free?.bulk === 75, JSON.stringify(v.capacity));
  ok('sale_plan: no side effects — no drop, no packet, pack unchanged, no ledger row',
     f.drops.length === 0 && f.wire.length === 0 && JSON.stringify(f.c.inventory) === before && f.ledger.length === 0);
}

// --- make space, end to end on the real plan
{
  const f = fixture();
  const r = await f.ap.makeSpaceNow({ bulk: 120 });
  ok('120 bulk: 45 short, 9 of 10 fairy wings dropped (partial stack)',
     r.ok === true && r.dropped.length === 1 && r.dropped[0].name === 'fairy wing' && r.dropped[0].amount === 9,
     JSON.stringify(r));
  ok('freed and short_by are reported', r.freed.bulk === 45 && r.short_by.bulk === 0 && r.needed.bulk === 120);
  ok('the drop was verified off the pack', f.c.inventory.find(o => o.nameRsc === 'fairy wing')?.amount === 1);
  ok('ledger make_space row with the list', f.ledger.length === 1 && f.ledger[0].kind === 'make_space' &&
     f.ledger[0].dropped[0].name === 'fairy wing');
}
{
  const f = fixture();
  const r = await f.ap.makeSpaceNow({ bulk: 1000 });
  const names = new Set(r.dropped.map(d => d.name));
  ok('1000 asks for 400: clamped', r.needed.bulk === 400);
  ok('short_by when the plan cannot cover it, and ok is false', r.ok === false && r.short_by.bulk > 0, JSON.stringify(r.short_by));
  ok('never shillings, herbs, food or the worn armour',
     !['shilling', 'herb', 'spider eye', 'leather armor'].some(n => names.has(n)) &&
     f.c.inventory.some(o => o.nameRsc === 'leather armor') && f.c.inventory.find(o => o.nameRsc === 'shilling').amount === 500,
     [...names].join(','));
  ok('least valuable first: fairy wing before red before purple before emerald',
     r.dropped.map(d => d.name).slice(0, 4).join(',') === 'fairy wing,red mushroom,purple mushroom,emerald',
     r.dropped.map(d => d.name).join(','));
}
{
  const f = fixture({ protect: ['fairy wing'] });
  const r = await f.ap.makeSpaceNow({ bulk: 120 });
  ok('a protected name is never dropped; the next cheapest goes instead',
     !r.dropped.some(d => d.name === 'fairy wing') && r.dropped[0]?.name === 'red mushroom', JSON.stringify(r.dropped));
}
{
  const f2 = fixture();
  const fw2 = f2.c.inventory.find(o => o.nameRsc === 'fairy wing');
  f2.ap.heldBackIds = () => new Set([fw2.id]);
  const r = await f2.ap.makeSpaceNow({ bulk: 100 });
  ok('a held-back id (enchanted, just delivered) is never dropped', !r.dropped.some(d => d.name === 'fairy wing'));
}
{
  const f = fixture({ dropRefuses: new Set(['fairy wing']) });
  const r = await f.ap.makeSpaceNow({ bulk: 120 });
  ok('a drop the server did not take frees nothing and is reported refused',
     r.refused_items?.some(x => x.name === 'fairy wing') && !r.dropped.some(d => d.name === 'fairy wing') && r.short_by.bulk === 45,
     JSON.stringify(r));
}
{
  const f = fixture();
  f.c.using = null;          // equipment unknown: every plan row is blocked
  const r = await f.ap.makeSpaceNow({ bulk: 120 });
  ok('unknown equipment drops nothing', r.dropped.length === 0 && f.drops.length === 0 && r.ok === false);
}
{
  const f = fixture();
  const r = await f.ap.makeSpaceNow({});
  ok('no target is refused without a packet', r.refused === 'no target' && f.wire.length === 0);
  f.c.trade = { theirs: [] };
  const r2 = await f.ap.makeSpaceNow({ bulk: 50 });
  ok('an open trade is refused without a drop', r2.refused === 'trading' && f.drops.length === 0);
}

// --- the unarmed hook
{
  const f = fixture();
  let armCalls = 0;
  f.ap.armSelf = async () => { armCalls++; f.c.using.add(999); f.c.inventory.push({ id: 999, nameRsc: 'scimitar', amount: 0 }); return true; };
  f.ap.facultyHeld = () => false;
  f.ap.progress = () => {};
  const t0 = 1_000_000_000;
  const first = await f.ap.unarmedMakeSpace(f.c, t0);
  ok('hook: drops sale-plan items for the weapon (+margin), then re-arms', first === true && armCalls === 1 &&
     f.ledger[0]?.needed?.bulk === 80 && f.ledger[0].dropped.every(d => !['herb', 'shilling', 'spider eye'].includes(d.name)),
     JSON.stringify(f.ledger[0]));
  const again = await f.ap.unarmedMakeSpace(f.c, t0 + 60_000);
  ok('hook: rate-bounded — a second call inside the window does nothing', again === false && armCalls === 1 && f.ledger.length === 1);
  const later = await f.ap.unarmedMakeSpace(f.c, t0 + UNARMED_MAKE_SPACE_EVERY_MS);
  ok('hook: allowed again after the window', armCalls === 2 && later === true, `${armCalls} ${later}`);
  const g = fixture();
  g.ap.facultyHeld = f => f === 'economy';
  g.ap.armSelf = async () => { throw new Error('must not be called'); };
  ok('hook: a bot holding the economy faculty is left alone', (await g.ap.unarmedMakeSpace(g.c, t0)) === false && g.drops.length === 0);
  const h = fixture({ packOverride: [{ id: 1, nameRsc: 'herb', amount: 420 }] });
  let hArm = 0; h.ap.armSelf = async () => { hArm++; return false; }; h.ap.facultyHeld = () => false;
  ok('hook: nothing on the plan to drop -> no re-arm, falls through', (await h.ap.unarmedMakeSpace(h.c, t0)) === false && hArm === 0 && h.drops.length === 0);
}
{
  const src = autopilotSource();
  const at = src.indexOf("if (blocker === 'room') {");
  const branch = src.slice(at, src.indexOf("this.note('unarmed and cannot hold what the spell would make'", at));
  ok("hook: the 'room' branch makes space before the town trip, and still opens the trip",
     /unarmedMakeSpace\(/.test(branch) && branch.indexOf('unarmedMakeSpace(') < branch.indexOf('bankRun()'));
}

// --- the wiring: keeper op, broker tools, fleetscript
{
  const { readFileSync } = await import('node:fs');
  const kp = readFileSync(new URL('./m59-keeper-process.mjs', import.meta.url), 'utf8');
  ok("keeper op: case 'sale_plan' answers salePlanView and 'make_space' answers makeSpaceNow",
     /case 'sale_plan':[\s\S]{0,400}salePlanView\(\)/.test(kp) && /case 'make_space':[\s\S]{0,400}makeSpaceNow\(/.test(kp));
  const br = readFileSync(new URL('./m59-broker.mjs', import.meta.url), 'utf8');
  ok("broker: sale_plan and make_space forward to the keeper op",
     /name: 'sale_plan'[\s\S]{0,2000}keeperAction\(s\.name, s\._index, 'sale_plan'/.test(br) &&
     /name: 'make_space'[\s\S]{0,2500}keeperAction\(s\.name, s\._index, 'make_space'/.test(br));
  const { script } = await import('./fleetscripts/make-space.mjs');
  let threw = null;
  try { await script.steps({ agent: 't19', bulk: 401 }); } catch (e) { threw = e.message; }
  ok('fleetscript: refuses more than 400', /at most 400/.test(threw ?? ''), threw);
  threw = null;
  try { await script.steps({ agent: 't19' }); } catch (e) { threw = e.message; }
  ok('fleetscript: refuses no target', /bulk= and\/or weight=/.test(threw ?? ''), threw);
  const steps = await script.steps({ agent: 't19', bulk: 70 });
  const sent = [];
  const call = async (tool, args) => { sent.push([tool, args]); return { ok: true, needed: { bulk: 70, weight: 0 },
    freed: { bulk: 10, weight: 4 }, dropped: [{ name: 'fairy wing', amount: 2 }], short_by: { bulk: 0, weight: 0 } }; };
  const log = console.log; console.log = () => {};
  let res; try { res = await steps[0].fn({ call }); } finally { console.log = log; }
  ok('fleetscript: one in-place step, no walking, calls make_space with the target',
     steps.length === 1 && steps[0].do === 'verify' && res === true && sent.length === 1 &&
     sent[0][0] === 'make_space' && sent[0][1].agent === 't19' && sent[0][1].bulk === 70 && !('weight' in sent[0][1]));
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
