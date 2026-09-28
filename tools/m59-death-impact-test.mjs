import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deathImpact, countDeathImpacts, withDeathCosts } from './m59-death-impact.mjs';
import { countRecentDeaths, projectPostmortem } from './m59-death-tally.mjs';

const now = Date.now();
const loss = { character: 'Kermit', at: now, summary: { level: 32, max_hp_after: 30 } };
const free = { character: 'Kermit', at: now - 1000, summary: { level: 29, max_hp_after: 29 } };
const unknown = { character: 'Kermit', at: now - 2000, vitals: { level: 20 } };
assert.equal(deathImpact(loss).category, 'true_deaths');
assert.equal(deathImpact(free).category, 'no_hp_loss');
assert.equal(deathImpact(unknown).category, 'unknown', 'under 30 does not prove no loss');
assert.equal(deathImpact({ level: 50, max_hp_after: 51 }).category, 'unknown');
assert.equal(deathImpact({ level: 30, max_hp_after: null }).category, 'unknown');
assert.equal(deathImpact({ level: 30, max_hp_after: 30 }).under_30, false);
assert.equal(deathImpact({ max_hp_lost: '0' }).category, 'unknown');
assert.deepEqual(countDeathImpacts([loss, free, unknown]),
  { true_deaths: 1, no_hp_loss: 1, unknown: 1, under_30: 2, hp_lost: 2, total: 3 });
assert.deepEqual(countRecentDeaths([loss, free, unknown].map(projectPostmortem), { now }).get('Kermit').death_counts,
  countDeathImpacts([loss, free, unknown]));
const joined = withDeathCosts([
  { kind: 'died', character: 'Kermit', death_at: 123, level: 32 },
  { kind: 'died', character: 'Other', death_at: 123, level: 32 },
  { kind: 'death_cost', character: 'Kermit', death_at: 123, max_hp_before: 32, max_hp_after: 30, max_hp_lost: 2 },
]);
assert.equal(deathImpact(joined[0]).category, 'true_deaths');
assert.equal(deathImpact(joined[1]).category, 'unknown', 'same time in another character is not the same death');

const dir = mkdtempSync(join(tmpdir(), 'm59-death-impact-'));
process.env.M59_POSTMORTEM_DIR = dir;
process.env.M59_LEDGER_DIR = dir;
for (const [i, record] of [loss, free, unknown].entries()) writeFileSync(join(dir, `death-${i}.json`), JSON.stringify(record));
const { renderDeaths } = await import('./m59-deaths-page.mjs');
const { digest } = await import('./m59-postmortems.mjs');
const html = renderDeaths({ hours: 24, characters: new Set(['Kermit']), impact: 'true_deaths' });
assert.equal((html.match(/class="death" data-file=/g) ?? []).length, 1);
assert.ok(html.indexOf('class="k">True Deaths') < html.indexOf('class="k">No HP loss'));
assert.match(html, /−2 HP/);
assert.equal(digest('death-1.json').impact.category, 'no_hp_loss');
const { summarise } = await import('./m59-ledger.mjs');
const ledger = [{ type: 'sample', t: now - 5000, character: 'Kermit', level: 32, strategy: 'test' },
  { type: 'event', kind: 'died', t: now - 2000, character: 'Kermit', death_at: now - 2500, level: 32 },
  { type: 'event', kind: 'death_cost', t: now - 1000, character: 'Kermit', death_at: now - 2500,
    max_hp_before: 32, max_hp_after: 30, max_hp_lost: 2 }];
writeFileSync(join(dir, `fleet-${new Date(now).toISOString().slice(0,10)}.jsonl`), ledger.map(r => JSON.stringify(r)).join('\n') + '\n');
assert.equal(summarise().death_counts.true_deaths, 1, 'late cost reaches the fleet summary');
console.log('death impact: classification, late results, durable counts, filtering and digest passed');
