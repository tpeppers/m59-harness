#!/usr/bin/env node
// Read-only room totals from one explicit fleet ledger directory.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const MINUTE_MS = 60_000;
const SAMPLE_INTERVAL_MS = 5 * MINUTE_MS;
const increment = (counts, key) => { counts[key] = (counts[key] ?? 0) + 1; };
const timestamp = t => t == null ? null : new Date(t).toISOString();
const latest = (a, b) => a == null ? b : Math.max(a, b);

function vitalsPair(value) {
  if (typeof value !== 'string' || !/^\d+\/\d+$/.test(value)) return null;
  const [current, max] = value.split('/').map(Number);
  return max > 0 ? { current, max } : null;
}

export function summarizeFarmRoom({ samples, events, source }, { room, end, minutes, minVigor }) {
  const from = end - minutes * MINUTE_MS;
  const inWindow = r => Number.isFinite(r?.t) && r.t >= from && r.t < end;
  const observations = {
    connected: 0, offline: 0, health_unknown: 0, full_health: 0,
    ready_proxy: 0, ready_unknown: 0,
    full_health_by_activity: Object.create(null),
    ready_proxy_by_activity: Object.create(null),
  };
  const byCreature = Object.create(null), byCharacter = new Map(), sampleTimes = new Set();
  let lastRecord = null, lastRoomSample = null, recordedKills = 0, humanKills = 0, unlocatedKills = 0;
  const rowFor = character => {
    if (!byCharacter.has(character)) byCharacter.set(character, { character, kills: 0, connected_samples: 0,
      full_health_samples: 0, ready_proxy_samples: 0, ready_proxy_wall_samples: 0, latest_room_sample: null });
    return byCharacter.get(character);
  };
  // Callers pass already deduplicated events. Keep off-map and unknown-room kills out of the total.
  for (const e of events) {
    if (!inWindow(e)) continue;
    lastRecord = latest(lastRecord, e.t);
    if (e.kind !== 'killed' || !e.character) continue;
    if (!Number.isInteger(e.room_num)) { unlocatedKills++; continue; }
    if (e.room_num !== room) continue;
    recordedKills++;
    if (e.human === true) humanKills++;
    increment(byCreature, e.creature || 'unknown');
    rowFor(e.character).kills++;
  }
  const seen = new Set();
  for (const s of samples) {
    if (!inWindow(s) || s.type !== 'sample' || !s.character) continue;
    lastRecord = latest(lastRecord, s.t);
    if (s.room_num !== room) continue;
    const identity = `${s.t}|${s.character}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    sampleTimes.add(s.t);
    lastRoomSample = latest(lastRoomSample, s.t);
    const row = rowFor(s.character);
    const activity = s.activity || 'unknown';
    const hp = vitalsPair(s.health), vigor = vitalsPair(s.vigor_of);
    const isOffline = activity === 'NOT IN GAME';
    if (!row.latest_room_sample || row.latest_room_sample.t <= s.t)
      row.latest_room_sample = { t: s.t, health: isOffline ? null : s.health ?? null, activity };
    if (isOffline) { observations.offline++; continue; }
    if (!hp) { observations.health_unknown++; continue; }
    observations.connected++;
    row.connected_samples++;
    if (hp.current < hp.max) continue;
    observations.full_health++;
    row.full_health_samples++;
    increment(observations.full_health_by_activity, activity);
    if (s.has_weapon === false || (vigor && vigor.current < minVigor)) continue;
    if (s.has_weapon !== true || !vigor) { observations.ready_unknown++; continue; }
    observations.ready_proxy++;
    row.ready_proxy_samples++;
    if (/^holding (?:a )?(?:proven )?safe spot$/i.test(activity)) row.ready_proxy_wall_samples++;
    increment(observations.ready_proxy_by_activity, activity);
  }
  const current = lastRecord != null && end - lastRecord <= SAMPLE_INTERVAL_MS;
  return {
    room, from: timestamp(from), to: timestamp(end), minutes,
    source: { ...source, latest_window_record: timestamp(lastRecord), recent_evidence: current },
    kills: { recorded: recordedKills, per_30m: current ? +(recordedKills * 30 / minutes).toFixed(2) : null,
      keeper: recordedKills - humanKills, human: humanKills, by_creature: byCreature, unlocated_fleet_kills: unlocatedKills },
    observations: { ...observations, rounds: sampleTimes.size, latest_room_sample: timestamp(lastRoomSample), min_vigor: minVigor },
    characters: [...byCharacter.values()].sort((a, b) => b.kills - a.kills || a.character.localeCompare(b.character)),
    notes: [
      'Kills are ledger receipts in the exact room. This report has no server-side spawn count.',
      'Ready proxy means full HP, a weapon carried and the chosen vigor floor. It cannot prove a keeper was free to fight.',
      'Activity labels are snapshots, not time spent swinging or idling. A fighting label can include approaching or pulling.',
    ],
  };
}

export function roomKillReceipts(events, dedupeKills) {
  const byRoom = new Map();
  for (const e of events) {
    if (e?.kind !== 'killed') continue;
    const room = e.room_num ?? null;
    if (!byRoom.has(room)) byRoom.set(room, []);
    byRoom.get(room).push(e);
  }
  return [...byRoom.values()].flatMap(rows => dedupeKills(rows));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const { values } = parseArgs({ options: {
      room: { type: 'string' }, 'ledger-dir': { type: 'string' }, fleet: { type: 'string' },
      minutes: { type: 'string', default: '30' }, 'min-vigor': { type: 'string', default: '130' },
      end: { type: 'string' }, help: { type: 'boolean' },
    } });
    if (values.help) {
      console.log('node tools/m59-farm-room-report.mjs --fleet prod --ledger-dir <history dir> --room 552');
      console.log('Options: --minutes 30 --min-vigor 130 --end <ISO timestamp with time zone>');
    } else {
      const room = Number(values.room), minutes = Number(values.minutes), minVigor = Number(values['min-vigor']);
      const end = values.end == null ? Date.now() : Date.parse(values.end);
      if (!values['ledger-dir'] || !Number.isInteger(room) || room <= 0 || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440 ||
          !Number.isInteger(minVigor) || minVigor < 0 || minVigor > 200 || !Number.isFinite(end) ||
          (values.end && !/(?:Z|[+-]\d\d:\d\d)$/i.test(values.end)))
        throw new Error('expected a ledger directory, positive room number, minutes 1–1440, vigor 0–200 and a zoned end time');
      const { readLedger, dedupeKills, HUMAN_DEDUPE_MS } = await import('./m59-ledger.mjs');
      const ledger = readLedger({ dir: resolve(values['ledger-dir']), now: end, sinceMs: minutes * MINUTE_MS + HUMAN_DEDUPE_MS });
      const receipts = roomKillReceipts(ledger.events.filter(e => e.t < end), dedupeKills);
      const events = [...ledger.events.filter(e => e.kind !== 'killed'), ...receipts];
      const report = summarizeFarmRoom({ ...ledger, events }, { room, end, minutes, minVigor });
      console.log(JSON.stringify(report, null, 2));
      if (!report.source.recent_evidence) process.exitCode = 1;
    }
  } catch (e) {
    console.error(`farm room report: ${e.message}`);
    process.exitCode = 1;
  }
}
