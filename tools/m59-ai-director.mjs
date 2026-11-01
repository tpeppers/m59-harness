#!/usr/bin/env node
// m59-ai-director.mjs -- an optional external supervisor that watches the fleet
// and can issue directives (say / tell / allhands / autopilot) through the broker.
//
// WHY THIS EXISTS.
//
// m59-goap.mjs owns the per-character plan: stop, travel, set prey, rest. None of those
// are communication. A character that has been idle for an hour, who has wandered into
// a town, who has the wrong prey and no prey to switch to -- the planner knows, and the
// planner fixes what it can fix, and then there is a fleet of people sitting in a room
// doing fine work with nobody to talk to.
//
// This director is the layer above that: a small LLM that reads the fleet summary,
// makes an assessment, and issues 0-3 directives per pass. It can shout at a character
// ("say"), tell one fleet member something privately, broadcast to the whole fleet
// ("allhands"), or steer a keeper via a small set of allowed autopilot actions.
//
// The safety boundary is in code, not in the prompt. Every outbound message runs
// through `sanitizeOutbound` from m59-inbox.mjs, every directive is validated against
// an allowlist, and irreversible autopilot actions (travel, leave, forget, drop, sell,
// buy) are blocked at execution time even if the model asks for them.
//
// NEVER imports m59-broker.mjs or m59-autopilot.mjs. It talks to the broker over HTTP
// JSON-RPC, and to the LLM router over the Anthropic SDK with a custom baseURL.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sanitizeOutbound } from './m59-inbox.mjs';
import { conflictsPath } from './m59-intel.mjs';
import { rowHumanHeld } from './m59-spectate-route.mjs';

// ============================================================================
// CONFIG
// ============================================================================

const DEFAULTS = {
  brokerPort:  8901,
  intervalSec: 30,
  model:       'qwen35-a3b-radiance',
  router:      process.env.M59_LLM_ROUTER || 'http://athena.local:8083/v1',
  maxMessage:  120,
  maxJournals: 500,
};

const JOURNAL_PATH  = new URL('../substrate/ai-director.log', import.meta.url);
const STATUS_PATH   = new URL('../substrate/ai-director-status.json', import.meta.url);
// PER FLEET, and asked of `m59-intel.mjs` rather than rebuilt here. A conflict book is an
// order to move bodies, and two fleets run on this machine — see the note there. A reader
// left on the old fixed name does not error, it just reports no conflicts for ever.
const CONFLICTS_PATH = () => pathToFileURL(conflictsPath());
const TARGETS_PATH   = new URL('../substrate/targets.json', import.meta.url);

// Closed allowlist: every directive kind is validated against this before execution.
// Adding a new kind means adding it here AND writing the dispatcher below -- the
// LLM cannot widen its own authority through the prompt.
const DIRECTIVE_KINDS = new Set(['none', 'say', 'tell', 'allhands', 'autopilot']);

// Blocked autopilot actions: irreversible or credential-touching. They look like the
// allowed ones, so the only way to be sure is a deny-list on the action name itself.
const BLOCKED_AUTOPILOT = new Set(['travel', 'leave', 'forget', 'drop', 'sell', 'buy']);
const ALLOWED_AUTOPILOT = new Set(['hunt', 'assignedRoom', 'purpose', 'goals', 'stop', 'restart']);

const RATE_LIMITS = { say_tell_per_pass: 2, autopilot_per_pass: 1 };

// ============================================================================
// CLI PARSING
// ============================================================================

export function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const consume = () => { const v = argv[++i]; return v && !v.startsWith('--') ? v : null; };
    if (a === '--broker-port') { const v = consume(); if (v) args.brokerPort = Number(v); }
    else if (a === '--interval') { const v = consume(); if (v) args.intervalSec = Math.max(10, Number(v)); }
    else if (a === '--model')    { const v = consume(); if (v) args.model = v; }
    else if (a === '--router')   { const v = consume(); if (v) args.router = v; }
    else if (a === '--dry-run')  { args.dryRun = true; }
    else if (a === '--verbose')  { args.verbose = true; }
    else if (a === '--once')     { args.once = true; }
  }
  return args;
}

// ============================================================================
// BROKER I/O -- HTTP JSON-RPC only. No imports of broker or autopilot modules.
// ============================================================================

let _id = 0;
export async function callTool(name, args = {}, brokerUrl) {
  const url = brokerUrl || `http://127.0.0.1:${DEFAULTS.brokerPort}/`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++_id, method: 'tools/call',
                           params: { name, arguments: args } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
  const text = j.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

export async function fetchFleet(brokerPort) {
  try {
    const data = await callTool('fleet', {}, `http://127.0.0.1:${brokerPort}/`);
    return data?.fleet ?? [];
  } catch {
    return [];
  }
}

// Fetch ledger-like events from the broker by asking `history` (the closest tool
// that returns a structured event stream). The broker has no /ledger HTTP endpoint,
// so the JSON-RPC channel is the only honest way to read what the fleet did.
export async function fetchRecentEvents(brokerPort, sinceMs) {
  try {
    const out = await callTool('history',
      { events_only: true, hours: Math.max(1, Math.ceil((Date.now() - sinceMs) / 3_600_000)) },
      `http://127.0.0.1:${brokerPort}/`);
    return Array.isArray(out?.events) ? out.events : [];
  } catch {
    return [];
  }
}

// ============================================================================
// FLEET SUMMARY BUILD
// ============================================================================

export function summarizeCharacter(row) {
  const healthStr = row.health;
  let healthPct = null, vigorPct = null;
  if (typeof healthStr === 'string' && healthStr.includes('/')) {
    const [v, m] = healthStr.split('/').map(Number);
    if (Number.isFinite(v) && Number.isFinite(m) && m > 0) healthPct = Math.round(100 * v / m);
  }
  const v = row.vigor;
  if (Number.isFinite(v)) {
    // No public vigor max in the row; assume 200 (a typical cap for active farmers).
    // The number is approximate -- "vigor relative to a working day" -- and the LLM
    // treats it as a hint, not a fact.
    vigorPct = Math.max(0, Math.min(100, Math.round(100 * v / 200)));
  }
  const ms = Number.isFinite(row.ms_since_moved) ? row.ms_since_moved : null;
  const busy = !!(row.parked || row.committed || rowHumanHeld(row));
  const stuck = ms != null && ms > 300_000 && !busy;
  return {
    name:           row.character ?? row.agent ?? null,
    room:           row.room_num ?? null,
    room_name:      row.room ?? null,
    health_pct:     healthPct,
    vigor_pct:      vigorPct,
    status:         row.activity ?? (row.in_game === false ? 'offline' : 'unknown'),
    hunt:           row.policy?.hunt ?? null,
    purpose:        row.policy?.purpose ?? null,
    ms_since_moved: ms,
    committed:      !!row.committed,
    stuck,
  };
}

export function buildSummary({ fleet = [], events = [], conflicts = {}, targets = {} } = {}) {
  const recentEvents = (events || [])
    .filter(e => ['killed', 'tougher', 'died', 'bought', 'sold', 'attacked_by_player'].includes(e.kind))
    .slice(-20);
  return {
    characters: (fleet || []).map(summarizeCharacter),
    recent_events: recentEvents,
    conflicts: conflicts || {},
    targets: targets || {},
  };
}

// Read the conflicts / targets files from disk (optional; missing is fine).
export function readJsonOrEmpty(path) {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch { return {}; }
}

// ============================================================================
// LLM ROUTER -- Anthropic SDK with custom baseURL.
// ============================================================================

export async function callLLM(routerBase, model, summary) {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  // The Anthropic SDK appends /v1 itself, so strip it from the base URL if present.
  const base = routerBase.replace(/\/v1\/?$/, '');
  const client = new Anthropic({ apiKey: 'local', baseURL: base });
  const system =
    'You are the AI director for a Meridian 59 fleet of player characters. ' +
    'You monitor their status and issue directives. ' +
    'Reply ONLY with valid JSON: {"assessment":"...","directives":[{"kind":"say"|"tell"|"allhands"|"autopilot"|"none","character":"name","params":{}}]}. ' +
    'The field is called "kind", not "action". Issue 0-3 directives per pass. Prefer no action over a risky one.';
  const user = JSON.stringify(summary);
  const resp = await client.messages.create({
    model, max_tokens: 1024,
    system, messages: [{ role: 'user', content: user }],
  });
  const text = (resp?.content?.[0]?.text ?? '').trim();
  return text;
}

// Strip code fences and try to parse; return null on any failure so callers can
// log and skip rather than crash the loop.
export function parseLLMResponse(raw) {
  if (!raw) return null;
  // The router sometimes returns ```json ... ``` fences even when told not to.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(cleaned); }
  catch { /* fall through */ }
  // Try to find the first { ... } block.
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  return null;
}

// ============================================================================
// DIRECTIVE VALIDATION + EXECUTION
// ============================================================================

// Template-injection guard: refuse anything that looks like a templating engine
// trying to interpolate into a payload. We never use templates here, so any
// occurrence is hostile.
function hasTemplateSyntax(text) {
  if (typeof text !== 'string') return false;
  return /\{\{/.test(text) || /\$\{/.test(text);
}

function validateFleetMember(name, roster) {
  return typeof name === 'string' && roster.has(name);
}

export function validateDirective(d, roster, counters, maxMessage) {
  if (!d || typeof d !== 'object') return { ok: false, reason: 'not an object' };
  // Normalise: small models sometimes emit `action` instead of `kind`.
  if (d.action && !d.kind) d = { ...d, kind: d.action };
  const kind = d.kind;
  if (!DIRECTIVE_KINDS.has(kind)) return { ok: false, reason: `unknown kind: ${kind}` };
  if (kind === 'none') return { ok: true };

  const params = d.params ?? {};
  const character = d.character ?? null;

  if (kind === 'allhands') {
    if (character != null) return { ok: false, reason: 'allhands is fleet-wide; character must be null' };
    if (typeof params.message !== 'string') return { ok: false, reason: 'allhands needs message' };
    if (hasTemplateSyntax(params.message)) return { ok: false, reason: 'template syntax in message' };
    if (counters.say_tell >= RATE_LIMITS.say_tell_per_pass) return { ok: false, reason: 'rate limit' };
    return { ok: true };
  }

  if (kind === 'say' || kind === 'tell') {
    if (!validateFleetMember(character, roster))
      return { ok: false, reason: `character ${character} not in fleet` };
    // Normalise: small models sometimes use `msg` or `text` instead of `message`.
    if (!params.message && (params.msg || params.text))
      d = { ...d, params: { ...params, message: params.msg ?? params.text } };
    const params2 = d.params ?? params;
    if (typeof params2.message !== 'string') return { ok: false, reason: `${kind} needs message` };
    if (hasTemplateSyntax(params.message)) return { ok: false, reason: 'template syntax in message' };
    if (kind === 'tell' && !validateFleetMember(params.to, roster))
      return { ok: false, reason: `tell target ${params.to} not in fleet` };
    if (counters.say_tell >= RATE_LIMITS.say_tell_per_pass) return { ok: false, reason: 'rate limit' };
    return { ok: true };
  }

  if (kind === 'autopilot') {
    if (!validateFleetMember(character, roster))
      return { ok: false, reason: `character ${character} not in fleet` };
    if (counters.autopilot >= RATE_LIMITS.autopilot_per_pass)
      return { ok: false, reason: 'autopilot rate limit' };
    // The autopilot tool needs an action verb; everything else is params.
    const action = params.action;
    if (!action) return { ok: false, reason: 'autopilot needs params.action' };
    if (BLOCKED_AUTOPILOT.has(action))
      return { ok: false, reason: `autopilot action ${action} is blocked` };
    if (!ALLOWED_AUTOPILOT.has(action))
      return { ok: false, reason: `autopilot action ${action} not in allowlist` };
    return { ok: true };
  }

  return { ok: false, reason: 'unreachable' };
}

// Send one validated directive through the broker. Returns true on success.
// Failures (network, refused action) are logged but never thrown -- the loop
// survives a bad pass.
export async function executeDirective(d, brokerPort) {
  const url = `http://127.0.0.1:${brokerPort}/`;
  try {
    if (d.kind === 'allhands') {
      const cleaned = sanitizeOutbound(d.params.message, 120) ?? '';
      if (!cleaned) return { ok: false, reason: 'empty after sanitize' };
      await callTool('say', { agent: d.character, type: 'broadcast', message: cleaned }, url);
      return { ok: true };
    }
    if (d.kind === 'say') {
      const cleaned = sanitizeOutbound(d.params.message, 120) ?? '';
      if (!cleaned) return { ok: false, reason: 'empty after sanitize' };
      await callTool('say', { agent: d.character, type: 'say', message: cleaned }, url);
      return { ok: true };
    }
    if (d.kind === 'tell') {
      const cleaned = sanitizeOutbound(d.params.message, 120) ?? '';
      if (!cleaned) return { ok: false, reason: 'empty after sanitize' };
      await callTool('chat', { agent: d.character, type: 'group',
                               to: d.params.to, message: cleaned }, url);
      return { ok: true };
    }
    if (d.kind === 'autopilot') {
      const { action, ...rest } = d.params;
      await callTool('autopilot', { agent: d.character, action, ...rest }, url);
      return { ok: true };
    }
    return { ok: false, reason: `unhandled kind: ${d.kind}` };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ============================================================================
// ROLLING JOURNAL
// ============================================================================

export class RollingJournal {
  constructor(maxEntries = 500, path = JOURNAL_PATH) {
    this.maxEntries = maxEntries;
    this.path = path;
    this.entries = [];
  }
  add(entry) {
    const stamped = { at: new Date().toISOString(), ...entry };
    this.entries.push(stamped);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    this.flush();
  }
  flush() {
    try {
      const body = this.entries.map(e => JSON.stringify(e)).join('\n') + '\n';
      writeFileSync(this.path, body, 'utf8');
    } catch { /* disk full / read-only: keep going in memory */ }
  }
}

// ============================================================================
// STATUS FILE -- one snapshot per pass.
// ============================================================================

export function writeStatus({ pid, lastPass, lastAssessment = '', directivesIssued = 0, errors = 0 }) {
  const body = {
    running: true, pid,
    last_pass: lastPass,
    last_assessment: lastAssessment,
    directives_issued: directivesIssued,
    errors,
  };
  try { writeFileSync(new URL(STATUS_PATH), JSON.stringify(body, null, 2), 'utf8'); }
  catch { /* best-effort */ }
}

// ============================================================================
// ONE PASS
// ============================================================================

let _lastEventAt = 0;

export async function runPass(cfg, journal, status) {
  const startedAt = Date.now();
  let directivesIssued = 0;
  let errors = 0;
  let lastAssessment = status?.lastAssessment ?? '';

  // Pull the fleet roster; everything else validates against names seen here.
  const fleet = await fetchFleet(cfg.brokerPort);
  const roster = new Set(fleet
    .map(row => row.character ?? row.agent)
    .filter(Boolean));

  // Ledger-style events: bounded lookback so the LLM sees what changed since
  // the previous pass. _lastEventAt is process-local; a fresh restart is fine
  // because the lookback defaults to one hour.
  const sinceMs = _lastEventAt > 0 ? _lastEventAt : startedAt - 3_600_000;
  const events = await fetchRecentEvents(cfg.brokerPort, sinceMs);
  if (events.length) _lastEventAt = Math.max(...events.map(e => Number(e.at) || sinceMs));

  const conflicts = readJsonOrEmpty(CONFLICTS_PATH());
  const targets   = readJsonOrEmpty(new URL(TARGETS_PATH));
  const summary = buildSummary({ fleet, events, conflicts, targets });

  if (cfg.verbose) {
    console.log('[director] fleet:', summary.characters.length,
                'events:', summary.recent_events.length);
  }

  // Ask the LLM. A bad response is logged and skipped; the loop survives.
  let parsed = null;
  try {
    const raw = await callLLM(cfg.router, cfg.model, summary);
    parsed = parseLLMResponse(raw);
    if (!parsed) {
      journal.add({ kind: 'parse_fail', raw: raw.slice(0, 240) });
      errors++;
    }
  } catch (err) {
    journal.add({ kind: 'llm_error', message: err.message });
    errors++;
    parsed = null;
  }

  if (parsed?.assessment) lastAssessment = String(parsed.assessment).slice(0, 400);

  // Execute validated directives. The counters enforce the per-pass rate
  // limits the prompt was told to respect.
  const counters = { say_tell: 0, autopilot: 0 };
  const directives = Array.isArray(parsed?.directives) ? parsed.directives.slice(0, 3) : [];
  for (const d of directives) {
    const v = validateDirective(d, roster, counters, cfg.maxMessage);
    if (!v.ok) {
      journal.add({ kind: 'reject', directive: d, reason: v.reason });
      errors++;
      continue;
    }
    if (d.kind === 'none') continue;

    // Counters advance on validation, before execution, so a directive that the
    // broker refuses still burns its rate-limit slot.
    if (d.kind === 'say' || d.kind === 'tell' || d.kind === 'allhands') counters.say_tell++;
    if (d.kind === 'autopilot') counters.autopilot++;

    if (cfg.dryRun) {
      journal.add({ kind: 'dry_run', directive: d });
      directivesIssued++;
      continue;
    }
    const res = await executeDirective(d, cfg.brokerPort);
    journal.add({ kind: res.ok ? 'directive_ok' : 'directive_fail',
                  directive: d, reason: res.reason ?? null });
    if (res.ok) directivesIssued++;
    else errors++;
  }

  // Record a structured pass summary too -- easier to grep than re-parsing the log.
  journal.add({ kind: 'pass',
    fleet_size: summary.characters.length,
    directives: directivesIssued, errors,
    assessment: lastAssessment });

  writeStatus({
    pid: process.pid,
    lastPass: new Date().toISOString(),
    lastAssessment,
    directivesIssued: status.directivesIssued + directivesIssued,
    errors: status.errors + errors,
  });

  if (cfg.verbose) console.log('[director] pass done; directives=', directivesIssued, 'errors=', errors);
  return { directivesIssued, errors, lastAssessment };
}

// ============================================================================
// CLI ENTRY -- only when this file is invoked directly.
// ============================================================================

const isMain = !!process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const cfg = parseArgs(process.argv.slice(2));
  const journal = new RollingJournal(cfg.maxJournals);
  const status = {
    pid: process.pid,
    lastPass: new Date(0).toISOString(),
    lastAssessment: '',
    directivesIssued: 0,
    errors: 0,
  };
  writeStatus(status);

  let stopping = false;
  const stop = (sig) => {
    if (stopping) return;
    stopping = true;
    journal.add({ kind: 'shutdown', signal: sig });
    writeFileSync(new URL(STATUS_PATH),
      JSON.stringify({ running: false, pid: process.pid, stopped_at: new Date().toISOString() },
        null, 2), 'utf8');
    process.exit(0);
  };
  process.on('SIGINT',  () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  try {
    while (!stopping) {
      const r = await runPass(cfg, journal, status);
      status.directivesIssued += r.directivesIssued;
      status.errors           += r.errors;
      status.lastAssessment    = r.lastAssessment;
      if (cfg.once) break;
      await new Promise(res => setTimeout(res, cfg.intervalSec * 1000));
    }
  } catch (err) {
    journal.add({ kind: 'fatal', message: err.message, stack: err.stack });
    process.exit(1);
  }
}
