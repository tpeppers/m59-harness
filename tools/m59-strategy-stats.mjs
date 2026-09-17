// OPT-IN DETAILED KEEPER RECORDS.
//
// The fleet ledger remains the small, permanent history. This is the deliberately
// short-lived companion for questions that need individual trips and transactions.
// Every record carries the unit's selected retention (24h by default); readers enforce
// it exactly and the hourly rotation rewrites the daily spool so expired lines leave disk.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
         renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fleetName, strategyStatsDirFor } from './m59-fleetpath.mjs';
import { isTravelTrip } from './m59-travel-kind.mjs';

const HOUR = 3_600_000;
const DIR = strategyStatsDirFor(fleetName());
const FILE = /^keeper-stats-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const safeName = value => String(value || 'unknown').replace(/[^A-Za-z0-9_-]/g, '');
const fileFor = at => join(DIR, `keeper-stats-${new Date(at).toISOString().slice(0, 10)}.jsonl`);
let lastRotation = 0;

export function detailSettings(policy = {}, category = null) {
  const settings = policy?.strategyStats;
  if (settings?.enabled) {
    if (category && settings[category] !== true) return null;
    return settings;
  }
  // These two strategies are themselves an explicit opt-in and their usefulness depends
  // on proving the coordination happened. Keep their small event stream even when the
  // broad Detailed strategy stats switch is off; it uses the same 24h rotation and 2h UI.
  const auto = category === 'farm_cleanup' ? policy?.farmCleanup?.enabled
             : category === 'farm_delivery' ? policy?.farmDelivery?.enabled
             // OVERFARMING IS ITS OWN EVIDENCE. The whole claim of the strategy is that the
             // pack that came home is worth more than the one a greedy lap would have
             // carried, and that comparison exists only in this record — an overfarm running
             // with its stream switched off is a bet nobody is settling.
             : category === 'overfarm' ? policy?.overfarm?.enabled
             // GUILD-HALL RUNS RECORD WHENEVER guild_wants IS ON, for the reason the whole
             // category exists: three chests sat unchanged for days while the planner asked
             // for 45 orc teeth on every trip, and nothing on disk could say whether a trip
             // had happened, whether the door had opened, or whether a `put` was refused.
             // `this.note()` goes to an in-memory buffer a keeper restart empties.
             : category === 'guild_chest' ? policy?.guildWants?.enabled : false;
  return auto ? { enabled: true, retention_hours: 24, default_window_hours: 2,
    [category]: true } : null;
}

function rotate(at = Date.now()) {
  lastRotation = at;
  if (!existsSync(DIR)) return;
  for (const name of readdirSync(DIR).filter(value => FILE.test(value))) {
    const path = join(DIR, name);
    const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).filter(raw => {
      try {
        const row = JSON.parse(raw);
        return row.at + Math.max(1, Math.min(168, Number(row.retention_hours) || 24)) * HOUR >= at;
      } catch { return false; }
    });
    if (!rows.length) { unlinkSync(path); continue; }
    const next = rows.join('\n') + '\n';
    if (next === readFileSync(path, 'utf8')) continue;
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, next);
    renameSync(tmp, path);
  }
}

export function recordStrategyStat(character, category, event, detail = {}, settings = {}) {
  if (!character || !settings?.enabled || settings[category] !== true) return null;
  const at = Date.now();
  const retention = Math.max(1, Math.min(168, Number(settings.retention_hours) || 24));
  const row = { ...detail, at, iso: new Date(at).toISOString(), type: 'strategy-stat',
    character, category, event, retention_hours: retention };
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(fileFor(at), JSON.stringify(row) + '\n');
    if (at - lastRotation >= HOUR) rotate(at);
  } catch (error) {
    console.error('[strategy-stats] ' + error.message);
  }
  return row;
}

export function saveVaultSnapshot(character, snapshot = {}) {
  if (!character) return null;
  try {
    const dir = join(DIR, 'vault-latest');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${safeName(character)}.json`);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ character, ...snapshot }, null, 2) + '\n');
    renameSync(tmp, path);
    return path;
  } catch (error) {
    console.error('[vault-cache] ' + error.message);
    return null;
  }
}

export function readVaultSnapshots() {
  const dir = join(DIR, 'vault-latest');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.json')).flatMap(name => {
    try { return [JSON.parse(readFileSync(join(dir, name), 'utf8'))]; }
    catch { return []; }
  }).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

export function readStrategyStats({ hours = 2, at = Date.now() } = {}) {
  if (!existsSync(DIR)) return [];
  const windowHours = Math.max(0.25, Math.min(168, Number(hours) || 2));
  const cutoff = at - windowHours * HOUR;
  const rows = [];
  for (const name of readdirSync(DIR).filter(value => FILE.test(value)).sort().slice(-8)) {
    for (const raw of readFileSync(join(DIR, name), 'utf8').split('\n')) {
      if (!raw) continue;
      try {
        const row = JSON.parse(raw);
        if (row.at >= cutoff && row.at + (Number(row.retention_hours) || 24) * HOUR >= at)
          rows.push(row);
      } catch { /* keep reading after one torn line */ }
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}

const sum = (rows, field) => rows.reduce((n, row) => n + (Number(row[field]) || 0), 0);

export function strategyStatsReport({ hours = 2 } = {}) {
  const rows = readStrategyStats({ hours });
  const categoryRows = category => rows.filter(row => row.category === category);
  const records = values => values.slice().reverse().slice(0, 200);
  // Historical rows predate the source-side split between trips and zoning. Filter
  // those here too, otherwise the page stays inflated until the retention window ages
  // out even though new direct map changes are no longer recorded as travel.
  const travel = categoryRows('travel').filter(isTravelTrip);
  const fighting = categoryRows('fighting');
  const trading = categoryRows('trading');
  const vault = categoryRows('vault_accumulation');
  const cleanup = categoryRows('farm_cleanup');
  const delivery = categoryRows('farm_delivery');
  const fightMs = sum(fighting, 'duration_ms');
  const safeMs = sum(fighting, 'safe_spot_ms');
  return {
    window_hours: Math.max(0.25, Math.min(168, Number(hours) || 2)),
    retention: 'per selected unit; 24h by default',
    travel: { trips: travel.length, duration_ms: sum(travel, 'duration_ms'),
      damage: sum(travel, 'damage'), safe_spot_stops: sum(travel, 'safe_spot_stops'), records: records(travel) },
    fighting: { sessions: fighting.length, duration_ms: fightMs, damage: sum(fighting, 'damage'),
      safe_spot_ms: safeMs, safe_spot_pct: fightMs ? +(100 * safeMs / fightMs).toFixed(1) : null,
      records: records(fighting) },
    trading: { sessions: trading.length, duration_ms: sum(trading, 'duration_ms'),
      earned: sum(trading, 'earned'), spent: sum(trading, 'spent'), banked: sum(trading, 'banked'),
      records: records(trading) },
    vault: { deposits: vault.filter(row => row.event === 'deposit').length,
      items_deposited: vault.filter(row => row.event === 'deposit')
        .flatMap(row => row.deposited ?? []).reduce((n, item) => n + (Number(item.amount) || 1), 0),
      latest: readVaultSnapshots(), records: records(vault) },
    farm_cleanup: { runs: cleanup.length, dropped: sum(cleanup, 'dropped_count') ||
        cleanup.reduce((n, row) => n + (row.dropped?.length ?? 0), 0),
      picked: cleanup.reduce((n, row) => n + (row.picked ?? []).reduce((m, item) => m + (Number(item.amount) || 1), 0), 0),
      picked_value: sum(cleanup, 'value'),
      protected_picked: cleanup.reduce((n, row) => n + (row.protected ?? []).reduce((m, item) => m + (Number(item.amount) || 1), 0), 0),
      refused: cleanup.reduce((n, row) => n + (row.refused?.length ?? 0), 0), records: records(cleanup) },
    farm_delivery: { trips: delivery.length,
      farmers: delivery.reduce((n, row) => n + (row.delivered?.length ?? 0), 0),
      herbs_bought: delivery.reduce((n, row) => n + (Number(row.bought?.herb) || 0), 0),
      elderberries_bought: delivery.reduce((n, row) => n + (Number(row.bought?.elderberry) || 0), 0),
      herbs_delivered: delivery.reduce((n, row) => n + (row.delivered ?? [])
        .reduce((m, rec) => m + (Number(rec.delivered?.herb) || 0), 0), 0),
      elderberries_delivered: delivery.reduce((n, row) => n + (row.delivered ?? [])
        .reduce((m, rec) => m + (Number(rec.delivered?.elderberry) || 0), 0), 0),
      herbs_retained: delivery.reduce((n, row) => n + (Number(row.retained?.herb) || 0), 0),
      elderberries_retained: delivery.reduce((n, row) => n + (Number(row.retained?.elderberry) || 0), 0),
      records: records(delivery) },
  };
}
