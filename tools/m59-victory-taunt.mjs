#!/usr/bin/env node
// A VICTORY TAUNT: WHEN THE FLEET WINS A PVP BATTLE, ONE CHARACTER BROADCASTS ONE LINE OF ITS OWN.
//
//   node tools/m59-victory-taunt.mjs --fleet prod             # watch, and taunt each new win once
//   node tools/m59-victory-taunt.mjs --fleet prod --dry-run   # the same, saying what it WOULD send
//   node tools/m59-victory-taunt.mjs --fleet prod --once      # one look, then exit
//   node tools/m59-victory-taunt.mjs --fleet prod --status    # recent wins, and who would speak now
//   node tools/m59-victory-taunt.mjs --fleet prod --lines     # every character's lines
//
// Operator, 2026-10-17, after Floyd killed Morpheus at the Bastion: every battle the PvP record calls
// `won`, the character that landed the LAST kill broadcasts one of its own lines. If that character
// cannot be named, has no lines, is human-piloted or cannot afford the broadcast, the strongest
// character that can afford it speaks instead, with ITS own line.
//
// WHAT A WIN IS belongs to m59-pvp.mjs and is not re-derived here: kills and no deaths of ours,
// within one battle. A win is taunted only once it has SETTLED — `settle_ms` of quiet since its last
// contact — because the battle is still open for ten minutes and a death of ours inside that turns
// `won` into `traded`. The cheap poll reads only the PvP log; a candidate is re-checked against the
// full report (the ledger's deaths too) before anybody speaks, so a death the log missed still
// counts against the win.
//
// THE LINES ARE THIS MACHINE'S, not the repository's: they name a fleet's characters and speak for
// them on a shared server, so they live in `substrate/victory-taunts.json` (gitignored), and
// `substrate/victory-taunts.example.json` carries the shape. Silence — no file — means no taunts.
//
// A BROADCAST COSTS MANA: `TryBroadcast` (player.kod:3173) charges max_mana * percent / 100 + 1 and
// refuses, in prose, below that. The percent is a server setting we cannot read (settings.kod:148
// defaults it to 50), so `broadcast_mana_percent` in the file is our guess at it; a refusal anyway
// is detected from the reply and the next candidate tries. At most `max_attempts` speak per win.
//
// State (`substrate/victory-taunt-state.json`, gitignored as runtime) records every battle already
// answered, so a restart never re-taunts. On a first start every win already in the record is marked
// answered without speaking: a taunt three hours late is not a taunt.

import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pvpReport } from './m59-pvp.mjs';
import { normName } from './m59-war.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..', '..');
export const TAUNT_FILE = (env = process.env) => env.M59_TAUNT_FILE ?? join(HERE, 'substrate', 'victory-taunts.json');
export const STATE_FILE = (env = process.env) => env.M59_TAUNT_STATE ?? join(HERE, 'substrate', 'victory-taunt-state.json');
export const LOG_FILE = (env = process.env) => env.M59_TAUNT_LOG ?? join(HERE, 'substrate', 'victory-taunt.jsonl');

export const DEFAULTS = Object.freeze({
  settle_ms: 60_000,            // quiet after the last contact before a win counts as settled
  max_age_ms: 30 * 60_000,      // a win older than this is never taunted
  broadcast_mana_percent: 50,   // settings.kod:148's default; prod's own value is unreadable
  max_attempts: 3,              // speakers tried per win before giving up
  poll_ms: 15_000,
  channel: 'broadcast',
});

// ------------------------------------------------------------------ the lines

/**
 * The taunt file -> { lines: Map(normName -> {name, lines[]}), settings }. A file that will not
 * parse is an error, not an empty book: it says so rather than going quiet.
 */
export function parseTaunts(text) {
  const j = JSON.parse(text);
  const book = j.characters ?? j;
  const lines = new Map();
  for (const [name, list] of Object.entries(book)) {
    if (name.startsWith('_') || !Array.isArray(list)) continue;
    const clean = list.map(s => String(s).replace(/~/g, '').trim()).filter(Boolean);
    if (clean.length) lines.set(normName(name), { name, lines: clean });
  }
  const settings = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (j.settings?.[k] != null) settings[k] = j.settings[k];
  return { lines, settings };
}

export function loadTaunts(file = TAUNT_FILE()) {
  if (!existsSync(file)) return { lines: new Map(), settings: { ...DEFAULTS }, missing: true };
  return parseTaunts(readFileSync(file, 'utf8'));
}

/** One of a character's lines, never the one it used last time when it has another. */
export function pickLine(lines, lastIndex = null, rand = Math.random) {
  if (!lines?.length) return null;
  if (lines.length === 1) return { index: 0, text: lines[0] };
  if (lastIndex == null || lastIndex >= lines.length) { const i = Math.floor(rand() * lines.length); return { index: i, text: lines[i] }; }
  let i = Math.floor(rand() * (lines.length - 1));
  if (i >= lastIndex) i++;
  return { index: i, text: lines[i] };
}

// ------------------------------------------------------------------ which win, which speaker

/** The battles that are wins, settled, recent, and not yet answered. Oldest first. */
export function pendingWins(battles, answered, { now = Date.now(), settle_ms = DEFAULTS.settle_ms, max_age_ms = DEFAULTS.max_age_ms } = {}) {
  return battles.filter(b => b.result === 'won' && !answered.has(b.id) &&
      now - b.end >= settle_ms && now - b.end <= max_age_ms)
    .sort((a, b) => a.start - b.start);
}

/** The character that made the battle's last kill, or null when no kill names one of ours. */
export function lastKiller(battle) {
  const kills = (battle.events ?? []).filter(e => e.kind === 'death' && e.enemy_death && !e.context && e.killer)
    .sort((a, b) => a.at - b.at);
  return kills.at(-1)?.killer ?? null;
}

const frac = s => { const m = /^\s*(-?\d+)\s*\/\s*(\d+)/.exec(String(s ?? '')); return m ? [Number(m[1]), Number(m[2])] : null; };

/** A `fleet` row -> what choosing a speaker needs. */
export function speakerFacts(row) {
  const mana = frac(row.mana), hp = frac(row.health);
  return { agent: row.agent, character: row.character, level: Number(row.level) || 0,
    mana: mana?.[0] ?? (Number.isFinite(row.mana_now) ? row.mana_now : null), max_mana: mana?.[1] ?? null,
    max_hp: hp?.[1] ?? 0, piloted: !!row.piloted, online: row.room_num != null || row.room != null };
}

export const broadcastCost = (maxMana, percent) => Math.max(1, Math.floor(maxMana * percent / 100) + 1);

/**
 * Who speaks, in order of preference: the last killer, then everyone else strongest first
 * (level, then max health). Each must be online, not human-piloted, have lines, and afford it.
 * Returns [{agent, character, why, ...}]; `skipped` says why the killer was passed over.
 */
export function speakerOrder({ killer, fleet, lines, percent = DEFAULTS.broadcast_mana_percent }) {
  const facts = fleet.map(speakerFacts);
  const why = f => !f.online ? 'not in the game' : f.piloted ? 'human-piloted'
    : !lines.has(normName(f.character)) ? 'has no lines'
    : f.mana == null || f.max_mana == null ? 'mana unknown'
    : f.mana < broadcastCost(f.max_mana, percent) ? `mana ${f.mana}/${f.max_mana} < ${broadcastCost(f.max_mana, percent)}`
    : null;
  const out = [];
  let skipped = null;
  const k = killer ? facts.find(f => normName(f.character) === normName(killer) || normName(f.agent) === normName(killer)) : null;
  if (k) { const w = why(k); if (w) skipped = { character: k.character, why: w }; else out.push({ ...k, why: 'last kill' }); }
  else if (killer) skipped = { character: killer, why: 'not in the fleet' };
  const rest = facts.filter(f => f !== k && !why(f))
    .sort((a, b) => (b.level - a.level) || (b.max_hp - a.max_hp) || a.character.localeCompare(b.character));
  for (const f of rest) out.push({ ...f, why: killer ? 'strongest with mana (killer passed over)' : 'strongest with mana (no killer named)' });
  return { order: out, skipped };
}

/** A broadcast reply -> did it go out. The server refuses in prose and echoes what it sends. */
export function broadcastWent(reply) {
  if (!reply || reply.error) return false;
  const said = (reply.messages ?? []).join(' ');
  if (/not enough mana|too tired to broadcast|can't broadcast|cannot broadcast|prevented from broadcasting|squelch/i.test(said)) return false;
  return reply.echoed != null || reply.spoken != null;
}

// ------------------------------------------------------------------ state

export function readState(file = STATE_FILE()) {
  try { const j = JSON.parse(readFileSync(file, 'utf8')); return { answered: new Map(Object.entries(j.answered ?? {})), last_line: j.last_line ?? {}, primed: !!j.primed }; }
  catch { return { answered: new Map(), last_line: {}, primed: false }; }
}
export function writeState(state, file = STATE_FILE()) {
  mkdirSync(dirname(file), { recursive: true });
  // Keep a week of answers: more than any battle can stay open, small enough to read.
  const cutoff = Date.now() - 7 * 86_400_000;
  const answered = Object.fromEntries([...state.answered].filter(([, v]) => (v?.at ?? Date.now()) >= cutoff));
  writeFileSync(file + '.tmp', JSON.stringify({ primed: true, answered, last_line: state.last_line }, null, 2));
  renameSync(file + '.tmp', file);
}
const logRow = (row) => { try { appendFileSync(LOG_FILE(), JSON.stringify({ at: Date.now(), ...row }) + '\n'); } catch {} };

// ------------------------------------------------------------------ one round

/**
 * One look at the record. `call(tool, args)` is the broker; everything is injectable for the test.
 * Returns what it did, one entry per win considered.
 */
export async function round({ call, report, fullReport, taunts, state, now = Date.now(), dryRun = false, rand = Math.random, say = () => {} }) {
  const s = taunts.settings;
  const done = [];
  if (!taunts.lines.size) return done;
  let wins = pendingWins(report().battles, state.answered, { now, ...s });
  if (!wins.length) return done;
  // The cheap read found a win. Re-read with the ledger before anyone opens their mouth.
  const full = fullReport();
  const confirmed = new Map(full.battles.map(b => [b.id, b]));
  for (const w of wins) {
    const b = confirmed.get(w.id);
    if (!b || b.result !== 'won') {
      state.answered.set(w.id, { at: now, result: b?.result ?? 'gone', spoke: null });
      done.push({ battle: w.id, spoke: null, why: `full report says ${b?.result ?? 'no such battle'}` });
      continue;
    }
    const killer = lastKiller(b);
    const fleet = (await call('fleet', {}))?.fleet ?? [];
    const { order, skipped } = speakerOrder({ killer, fleet, lines: taunts.lines, percent: s.broadcast_mana_percent });
    const enemies = b.enemies.map(e => e.name).join(', ');
    let spoke = null; const tried = [];
    for (const cand of order.slice(0, s.max_attempts)) {
      const entry = taunts.lines.get(normName(cand.character));
      const line = pickLine(entry.lines, state.last_line[normName(cand.character)] ?? null, rand);
      if (dryRun) { spoke = { ...cand, line: line.text, dry_run: true }; break; }
      let reply;
      try { reply = await call('say', { agent: cand.agent, type: s.channel, text: line.text }); }
      catch (e) { reply = { error: e.message }; }
      tried.push({ character: cand.character, ok: broadcastWent(reply), error: reply?.error ?? null, messages: reply?.messages ?? [] });
      if (broadcastWent(reply)) {
        state.last_line[normName(cand.character)] = line.index;
        spoke = { ...cand, line: line.text };
        break;
      }
    }
    const row = { battle: b.id, enemies, rooms: b.rooms, killer, skipped, tried,
      spoke: spoke ? { character: spoke.character, agent: spoke.agent, why: spoke.why, line: spoke.line } : null,
      dry_run: dryRun || undefined };
    // A dry run remembers in memory only, so it says each win once and changes nothing on disk.
    state.answered.set(b.id, { at: now, result: 'won', spoke: spoke?.character ?? null, dry_run: dryRun || undefined });
    if (!dryRun) logRow(row);
    say(spoke ? `${new Date(now).toISOString()} won vs ${enemies}: ${spoke.character} (${spoke.why}) ${dryRun ? 'WOULD broadcast' : 'broadcast'} "${spoke.line}"`
      : `${new Date(now).toISOString()} won vs ${enemies}: nobody could speak (killer ${killer ?? '?'}${skipped ? `: ${skipped.why}` : ''}; ${order.length} candidates)`);
    done.push(row);
  }
  return done;
}

// ---------------------------------------------------------------------------- CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const { resolveFleet } = await import('./m59-fleetpath.mjs');
  const { controlRpc } = await import('./m59-control-client.mjs');
  const { fleet, stateFile } = resolveFleet(argv);
  const broker = arg('--broker', 'http://127.0.0.1:8901');
  const dryRun = argv.includes('--dry-run');
  const say = (m) => console.log(m);
  const taunts = loadTaunts(arg('--taunts', TAUNT_FILE()));
  if (argv.includes('--lines')) {
    for (const { name, lines } of taunts.lines.values()) { console.log(name); for (const l of lines) console.log(`  - ${l}`); }
    process.exit(0);
  }
  if (taunts.missing) { console.error(`no taunt file at ${arg('--taunts', TAUNT_FILE())} — copy substrate/victory-taunts.example.json and fill it in`); process.exit(2); }
  const call = async (name, args) => controlRpc(broker, name, args);
  // Refuse a broker that is not holding this fleet: a taunt from the wrong fleet is someone else's voice.
  const h = await fetch(broker + '/health').then(r => r.json()).catch(() => null);
  if (!h) { console.error(`no broker answering on ${broker}`); process.exit(3); }
  if ((h.fleet ?? '') !== fleet) { console.error(`broker on ${broker} holds "${h.fleet}", not "${fleet}" — refusing`); process.exit(3); }
  const report = () => pvpReport({ days: 1, stateFile, ledger: [], alarms: [] });
  const fullReport = () => pvpReport({ days: 1, stateFile, alarms: [] });
  const state = readState();
  if (argv.includes('--status')) {
    const rep = fullReport();
    for (const b of rep.battles.filter(b => b.result === 'won').slice(0, 5))
      console.log(`${new Date(b.start).toISOString()} won vs ${b.enemies.map(e => e.name).join(', ')}  last kill ${lastKiller(b) ?? '?'}  ${state.answered.has(b.id) ? `answered (${state.answered.get(b.id).spoke ?? 'nobody'})` : 'unanswered'}`);
    const { order } = speakerOrder({ killer: null, fleet: (await call('fleet', {})).fleet ?? [], lines: taunts.lines, percent: taunts.settings.broadcast_mana_percent });
    console.log(`would speak now, no killer named: ${order.slice(0, 3).map(o => `${o.character} (L${o.level}, mana ${o.mana}/${o.max_mana})`).join(', ') || 'nobody'}`);
    // No process.exit after a fetch: on Windows it trips a libuv assertion on the way out.
  } else {
  if (!state.primed && !argv.includes('--backfill')) {
    for (const b of fullReport().battles) if (b.result === 'won') state.answered.set(b.id, { at: b.end, result: 'won', spoke: null, primed: true });
    if (!dryRun) writeState(state);
    say(`primed: ${state.answered.size} earlier win(s) marked answered without a taunt`);
  }
  const once = async () => {
    try {
      const fresh = loadTaunts(arg('--taunts', TAUNT_FILE()));   // edits to the lines apply live
      const done = await round({ call, report, fullReport, taunts: fresh.missing ? taunts : fresh, state, dryRun, say });
      if (done.length && !dryRun) writeState(state);
    } catch (e) { say(`${new Date().toISOString()} round failed: ${e.message}`); }
  };
  say(`victory taunts for fleet ${fleet}: ${taunts.lines.size} characters, ${[...taunts.lines.values()].reduce((s, e) => s + e.lines.length, 0)} lines${dryRun ? ' (dry run)' : ''}`);
  await once();
  if (!argv.includes('--once')) setInterval(once, taunts.settings.poll_ms);
  }
}
