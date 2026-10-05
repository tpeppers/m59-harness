// Offline guard for Autopilot.saleProtectedNames: a co-op reagent the hall chests are short of
// (versus the guild plan) is kept from every MERCHANT, and only from merchants.
//
// Operator, 2026-10-05: purple mushrooms "never sell unless overstocked versus plan on the hall
// chests". The co-op deposit filter (protectedItemNames) must NOT gain them -- that is the
// 2026-09-17 deadlock, unsellable and undepositable at once.
//
//   node tools/m59-saleprotect-test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-saleprotect-'));
const planFile = join(dir, 'guild-plan.json');
mkdirSync(join(dir, 'storage', 'chests'), { recursive: true });
process.env.M59_GUILD_PLAN = planFile;
process.env.M59_STORAGE_DIR = join(dir, 'storage');

const want = (item, target) => ({ item, target });
writeFileSync(planFile, JSON.stringify({ chests: {
  r18c2: { items: [want('purple mushroom', 142), want('red mushroom', 142), want('emerald', 10)] },
} }));
// One chest, read at its square: purple SHORT (38 of 142), red OVER (434), emerald met.
writeFileSync(join(dir, 'storage', 'chests', 'r18c2.json'), JSON.stringify({ slot: 'r18c2', row: 18, col: 2,
  room: 714, items: [{ name: 'purple mushroom', amount: 38 }, { name: 'red mushroom', amount: 434 },
                     { name: 'emerald', amount: 800 }], observed_at: Date.now() }));

// The store gate: a cached rent answer saying the fleet is in a guild (Frular's reading).
writeFileSync(join(dir, 'storage', 'rent.json'), JSON.stringify({ in_guild: true, credit: 6462, observed_at: Date.now() }));

const { Autopilot } = await import('./m59-autopilot.mjs');
const call = (policy) => Autopilot.prototype.saleProtectedNames.call({
  policy, protectedItemNames: () => ['entroot berry'],
});
const coop = { enabled: true, reagents: ['purple mushroom', 'red mushroom', 'emerald'] };

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`ok ${name}`); };

ok('a co-op reagent the hall is short of is kept from the merchant', () => {
  const names = call({ reagentCoop: coop }).map(x => x.toLowerCase());
  assert.ok(names.includes('purple mushroom'), names.join(','));
});
ok('a co-op reagent the hall has more than the plan of is sellable', () => {
  const names = call({ reagentCoop: coop }).map(x => x.toLowerCase());
  assert.ok(!names.includes('red mushroom') && !names.includes('emerald'), names.join(','));
});
ok('the ordinary keep list is still in it', () => {
  assert.ok(call({ reagentCoop: coop }).includes('entroot berry'));
});
ok('a short item that is NOT a co-op reagent is left to guild wants, not added here', () => {
  const names = call({ reagentCoop: { enabled: true, reagents: ['red mushroom'] } }).map(x => x.toLowerCase());
  assert.ok(!names.includes('purple mushroom'));
});
ok('no co-op: exactly the ordinary keep list', () => {
  assert.deepEqual(call({ reagentCoop: null }), ['entroot berry']);
});
ok('the deposit filter is untouched: protectedItemNames does not call it', () => {
  const src = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  const at = src.indexOf('  protectedItemNames() {');
  assert.ok(at > 0 && !src.slice(at, src.indexOf('\n  }\n', at)).includes('saleProtectedNames'));
  assert.equal((src.match(/skills\.sellAll\(s, \{[^}]*?protect: this\.saleProtectedNames\(\)/gs) ?? []).length, 3,
    'all three keeper sale paths use the sale list');
});

console.log(`\n${n} passed`);
