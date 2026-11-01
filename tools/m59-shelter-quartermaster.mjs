#!/usr/bin/env node
// Same-room redistribution for a fleet shelter.  This file deliberately has no
// dependency on the keeper/autopilot implementation: it surveys through broker
// JSON-RPC and delegates the already-verified trade handshake to `supply`.
//
// Safety boundaries:
//   * room 39 is hard-coded; another --room is refused
//   * every supply call says who_travels=neither
//   * both characters must be full-health, quiet, and mutually visible
//   * equipped/possibly-equipped items and each donor's baseline are retained
//   * dry-run is the default
//   * --go fails closed unless inventory exposes the server's raw object tag.  An
//     older KeeperProxy coerces ordinary objects to amount=1; without the tag a
//     non-stack can be encoded as a NumberItem and an offer is not safe to send.
//
// Examples:
//   node tools/m59-shelter-quartermaster.mjs --once all
//   node tools/m59-shelter-quartermaster.mjs --once food --go
//   node tools/m59-shelter-quartermaster.mjs --watch

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { foodValue } from './m59-items.mjs';
import { armourKind, armourScore, isCursed, isJunk, weaponScore } from './m59-skills.mjs';
import { rowHumanHeld } from './m59-spectate-route.mjs';

export const SHELTER_ROOM = 39;
export const PHASE_CADENCE_MS = Object.freeze({
  food: 5 * 60_000,
  weapons: 10 * 60_000,
  gear: 15 * 60_000,
});
export const PHASE_ORDER = Object.freeze(['food', 'weapons', 'gear']);

const VALUES = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../substrate/m59-values.json', import.meta.url), 'utf8')).values ?? {};
  } catch {
    return {};
  }
})();

const key = value => String(value ?? '').trim().toLowerCase();
const valueOf = name => Number(VALUES[key(name)]) || 0;
const quantityOf = item => Number.isSafeInteger(item?.amount) && item.amount >= 1 ? item.amount : 1;

function healthPair(value) {
  if (value && typeof value === 'object') {
    const now = Number(value.value ?? value.current);
    const max = Number(value.max);
    return Number.isFinite(now) && Number.isFinite(max) && max > 0 ? [now, max] : null;
  }
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(String(value ?? '').trim());
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function equippedRows(row) {
  const source = row.equipment?.equipped ?? row.equipped ?? row.equippedNames ?? [];
  return (Array.isArray(source) ? source : []).map(entry => typeof entry === 'string'
    ? { id: null, name: entry }
    : { id: Number.isInteger(entry?.id) ? entry.id : null,
        name: entry?.name ?? entry?.nameRsc ?? '' });
}

function activeKeeperJob(job) {
  if (!job || typeof job !== 'object') return false;
  if (job.busy === true || job.running === true || Number.isFinite(Number(job.running_for_s)))
    return true;
  // Completed/cancelled jobs are retained as receipts. Anything else with a named
  // action is still ambiguous and therefore active for redistribution purposes.
  if (!job.last_action) return false;
  return job.ok !== true && job.cancelled !== true && !Number.isFinite(Number(job.took_s));
}

function keeperEvidenceReason(row, room) {
  const samples = Array.isArray(row.keeperSamples) ? row.keeperSamples : [];
  if (samples.length < 2) return 'two fresh keeper-side quiet samples are required';
  for (const sample of samples) {
    if (!String(sample?.source ?? '').toLowerCase().includes('keeper'))
      return 'keeper-side telemetry source is unproven';
    const age = Number(sample?.as_of_ms);
    if (!Number.isFinite(age) || age < 0 || age > 5_000)
      return 'keeper-side telemetry is stale or has no age';
    if (sample?.in_game !== true || sample?.connected !== true)
      return 'keeper reports the character disconnected or out of game';
    if (Number(sample?.room?.num) !== room) return `keeper reports outside room ${room}`;
    const hp = healthPair(sample?.hp);
    if (!hp || hp[0] !== hp[1]) return 'keeper does not report full health';
    if (sample?.target != null || sample?.goap?.target != null || sample?.goap?.action != null ||
        sample?.goap?.goal != null || activeKeeperJob(sample?.job))
      return 'keeper reports active work, movement, or a target';
    if (!Number.isFinite(Number(sample?.you?.col)) || !Number.isFinite(Number(sample?.you?.row)))
      return 'keeper position is unknown';
  }
  const first = samples[0], last = samples[samples.length - 1];
  if (Number(first.room?.num) !== Number(last.room?.num) ||
      Number(first.you?.col) !== Number(last.you?.col) ||
      Number(first.you?.row) !== Number(last.you?.row))
    return 'keeper moved during the quiet check';
  return null;
}

function safetyReason(row, room) {
  if (row.in_game === false) return 'not in game';
  if (Number(row.room_num) !== room) return `outside room ${room}`;
  const hp = healthPair(row.health ?? row.hp);
  if (!hp) return 'health is unknown';
  if (hp[0] !== hp[1]) return `not at full health (${hp[0]}/${hp[1]})`;
  if (row.recent_hurt || Number(row.hurt?.lost_10m) > 0) return 'recently hurt';
  if (row.committed) return 'committed to another job';
  if (rowHumanHeld(row)) return 'under human control';
  if (row.parked) return 'parking is in progress';
  // Unknown is not empty.  In particular, a KeeperProxy that has not published its
  // use list cannot tell us which sword or shield is equipped, so it cannot safely
  // participate at either end of a redistribution decision.
  if ((row.equipmentKnown ?? row.equipment?.known) !== true) return 'equipment state is unknown';
  const activity = key(row.activity);
  if (!activity) return 'activity is unknown';
  if (!/(^|\b)(idle|resting|waiting|safe wall)(\b|$)/.test(activity))
    return `not quiet (${row.activity})`;
  const load = Number(row.loadPercent ?? row.pack?.percent);
  if (!Number.isFinite(load)) return 'pack load is unknown';
  if (load >= 75) return 'pack is already at least 75% full';
  const keeperProblem = keeperEvidenceReason(row, room);
  if (keeperProblem) return keeperProblem;
  return null;
}

function normaliseRow(row, room) {
  const inventory = (Array.isArray(row.inventory) ? row.inventory : [])
    .filter(item => Number.isInteger(item?.id) && key(item?.name))
    .map(item => ({ ...item, name: String(item.name), quantity: quantityOf(item) }));
  const byId = new Map(inventory.map(item => [item.id, item]));
  const exactEquippedIds = new Set();
  const ambiguousEquippedNames = new Set();
  for (const entry of equippedRows(row)) {
    if (entry.id != null && byId.has(entry.id)) exactEquippedIds.add(entry.id);
    else if (key(entry.name)) ambiguousEquippedNames.add(key(entry.name));
  }
  for (const item of inventory) {
    // KeeperProxy currently publishes equipped names but not their object ids.  In
    // that case every carried object with that name is withheld: choosing one of two
    // identical maces would otherwise be a coin flip over the wielded one.
    item.equipped_or_ambiguous = exactEquippedIds.has(item.id) ||
      ambiguousEquippedNames.has(key(item.name));
    item.protected = item.protected === true || item.equipped_or_ambiguous;
  }
  const visibleSource = row.visibleCharacters ?? row.visible ?? [];
  const visible = new Set((Array.isArray(visibleSource) ? visibleSource : []).map(key).filter(Boolean));
  return {
    raw: row,
    agent: String(row.agent ?? ''),
    character: String(row.character ?? row.agent ?? ''),
    inventory,
    visible,
    excluded: safetyReason(row, room),
    equipmentKnown: row.equipmentKnown ?? row.equipment?.known ?? null,
  };
}

function canExchange(from, to) {
  return from.agent !== to.agent && from.visible.has(key(to.character)) &&
    to.visible.has(key(from.character));
}

function appendTransfer(transfers, phase, from, to, item, amount, stack) {
  let transfer = transfers.find(candidate => candidate.phase === phase &&
    candidate.from === from.agent && candidate.to === to.agent);
  if (!transfer) {
    transfer = {
      phase,
      from: from.agent,
      from_character: from.character,
      to: to.agent,
      to_character: to.character,
      room: SHELTER_ROOM,
      who_travels: 'neither',
      what: [],
      items: [],
    };
    transfers.push(transfer);
  }
  transfer.what.push(stack ? { id: item.id, amount } : item.id);
  transfer.items.push({ id: item.id, name: item.name, amount,
    ...(item.slot ? { slot: item.slot } : {}),
    ...(Number.isFinite(item.score) ? { score: item.score } : {}) });
}

function foodState(row) {
  const foods = row.inventory.map(item => {
    const value = foodValue(item.name);
    return value && !item.broken ? { ...item, nutrition: value.nutrition,
      available: item.quantity } : null;
  }).filter(Boolean);
  return { row, foods, nutrition: foods.reduce((sum, item) =>
    sum + item.nutrition * item.available, 0) };
}

function planFood(rows, transfers, { foodReserve }) {
  const states = rows.map(foodState);
  const recipients = states.filter(state => state.nutrition < foodReserve)
    .sort((a, b) => a.nutrition - b.nutrition || a.row.agent.localeCompare(b.row.agent));

  for (const recipient of recipients) {
    while (recipient.nutrition < foodReserve) {
      const donors = states.filter(donor => donor !== recipient &&
        donor.nutrition > foodReserve && canExchange(donor.row, recipient.row) &&
        donor.foods.some(item => item.available > 0 && !item.protected));
      donors.sort((a, b) => (b.nutrition - foodReserve) - (a.nutrition - foodReserve) ||
        a.row.agent.localeCompare(b.row.agent));
      const donor = donors[0];
      if (!donor) break;

      // Low-value, small servings first minimizes what is tied up in a failed offer
      // and avoids overshooting the recipient's baseline unnecessarily.
      const choices = donor.foods.filter(item => item.available > 0 && !item.protected)
        .sort((a, b) => valueOf(a.name) - valueOf(b.name) ||
          a.nutrition - b.nutrition || a.id - b.id);
      let moved = false;
      for (const item of choices) {
        const spareNutrition = donor.nutrition - foodReserve;
        const deficit = foodReserve - recipient.nutrition;
        const canSpare = Math.floor(spareNutrition / item.nutrition);
        if (canSpare < 1) continue;
        const amount = Math.min(item.available, canSpare,
          Math.max(1, Math.ceil(deficit / item.nutrition)));
        if (amount < 1) continue;
        appendTransfer(transfers, 'food', donor.row, recipient.row, item, amount, true);
        item.available -= amount;
        const nutrition = amount * item.nutrition;
        donor.nutrition -= nutrition;
        recipient.nutrition += nutrition;
        moved = true;
        if (recipient.nutrition >= foodReserve) break;
      }
      if (!moved) break;
    }
  }
}

function gearEntry(item, category) {
  if (item.broken || item.protected || isJunk(item.name) || isCursed(item.name)) return null;
  if (category === 'weapons') {
    const score = weaponScore(item.name);
    return score > 0 ? { ...item, category, slot: 'weapon', score } : null;
  }
  const kind = armourKind(item.name);
  if (!kind || !['armour', 'shield'].includes(kind.slot)) return null;
  return { ...item, category: kind.slot, slot: kind.slot, score: armourScore(kind) };
}

function allGear(row, category) {
  return row.inventory.map(item => {
    if (item.broken || isJunk(item.name) || isCursed(item.name)) return null;
    if (category === 'weapons') {
      const score = weaponScore(item.name);
      return score > 0 ? { ...item, category, slot: 'weapon', score } : null;
    }
    const kind = armourKind(item.name);
    if (!kind || !['armour', 'shield'].includes(kind.slot)) return null;
    return { ...item, category: kind.slot, slot: kind.slot, score: armourScore(kind) };
  }).filter(Boolean);
}

function planGearCategory(rows, transfers, { phase, category, reserve }) {
  const states = rows.map(row => {
    const held = allGear(row, category).filter(item => category === 'weapons' || item.slot === category);
    const movable = held.map(item => gearEntry(item, category))
      .filter(item => item && (category === 'weapons' || item.slot === category))
      .sort((a, b) => a.score - b.score || valueOf(a.name) - valueOf(b.name) || a.id - b.id);
    return { row, count: held.length, movable };
  });
  const recipients = states.filter(state => state.count < reserve)
    .sort((a, b) => a.count - b.count || a.row.agent.localeCompare(b.row.agent));

  for (const recipient of recipients) {
    while (recipient.count < reserve) {
      const donors = states.filter(donor => donor !== recipient && donor.count > reserve &&
        donor.movable.length && canExchange(donor.row, recipient.row));
      donors.sort((a, b) => (b.count - reserve) - (a.count - reserve) ||
        a.row.agent.localeCompare(b.row.agent));
      const donor = donors[0];
      if (!donor) break;
      const item = donor.movable.shift();
      appendTransfer(transfers, phase, donor.row, recipient.row, item, 1, false);
      donor.count--;
      recipient.count++;
    }
  }
}

function phasesOf(value) {
  const phase = key(value || 'all');
  if (phase === 'all') return [...PHASE_ORDER];
  if (phase === 'armor' || phase === 'armour' || phase === 'armour+shields' || phase === 'armor+shields')
    return ['gear'];
  if (!PHASE_ORDER.includes(phase)) throw new Error(`unknown phase ${value}; use food, weapons, gear, or all`);
  return [phase];
}

export function planShelterRedistribution(inputRows, options = {}) {
  const room = Number(options.room ?? SHELTER_ROOM);
  if (room !== SHELTER_ROOM)
    throw new Error(`shelter quartermaster is confined to room ${SHELTER_ROOM}; refused room ${room}`);
  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const settings = {
    foodReserve: Math.max(0, finite(options.foodReserve, 60)),
    weaponReserve: Math.max(1, Math.floor(finite(options.weaponReserve, 1))),
    armourReserve: Math.max(1, Math.floor(finite(options.armourReserve, 1))),
    shieldReserve: Math.max(1, Math.floor(finite(options.shieldReserve, 1))),
  };
  const all = (Array.isArray(inputRows) ? inputRows : []).map(row => normaliseRow(row, room));
  const rows = all.filter(row => !row.excluded && row.agent && row.character);
  const transfers = [];
  for (const phase of phasesOf(options.phase)) {
    if (phase === 'food') planFood(rows, transfers, settings);
    else if (phase === 'weapons') planGearCategory(rows, transfers,
      { phase, category: 'weapons', reserve: settings.weaponReserve });
    else {
      planGearCategory(rows, transfers,
        { phase, category: 'armour', reserve: settings.armourReserve });
      planGearCategory(rows, transfers,
        { phase, category: 'shield', reserve: settings.shieldReserve });
    }
  }
  return {
    room,
    phase: phasesOf(options.phase),
    who_travels: 'neither',
    settings,
    participants: rows.length,
    excluded: all.filter(row => row.excluded).map(row => ({
      agent: row.agent, character: row.character, reason: row.excluded })),
    transfers,
  };
}

// A positive result is deliberately stronger than "the requested id exists".  The
// server's tag decides whether an id must carry a parallel quantity; amount alone
// cannot distinguish an ordinary object from a one-item stack on an old proxy.
export function validateExactTransferContract(inputRows, transfers = null) {
  const rows = Array.isArray(inputRows) ? inputRows : [];
  const byAgent = new Map(rows.map(row => [String(row.agent), row]));
  const problems = [];
  const selected = transfers ?? rows.flatMap(row => (row.inventory ?? []).map(item => ({
    from: row.agent,
    what: [item?.tag === 1 ? { id: item.id, amount: quantityOf(item) } : item.id],
  })));
  let checked = 0;
  for (const transfer of selected) {
    const row = byAgent.get(String(transfer.from));
    if (!row) { problems.push(`missing donor snapshot ${transfer.from}`); continue; }
    const inventory = Array.isArray(row.inventory) ? row.inventory : [];
    for (const spec of transfer.what ?? []) {
      const id = Number(typeof spec === 'object' ? spec.id : spec);
      const item = inventory.find(candidate => candidate.id === id);
      checked++;
      if (!item) { problems.push(`${transfer.from}: item ${id} is absent`); continue; }
      if (!Object.prototype.hasOwnProperty.call(item, 'tag') || ![0, 1].includes(item.tag)) {
        problems.push(`${transfer.from}: item ${id} (${item.name}) has no authoritative object tag`);
        continue;
      }
      if (item.tag === 1) {
        if (!Number.isSafeInteger(item.amount) || item.amount < 1)
          problems.push(`${transfer.from}: stack ${id} has no raw positive amount`);
        if (!(spec && typeof spec === 'object' && Number.isSafeInteger(spec.amount) &&
              spec.amount >= 1 && spec.amount <= item.amount))
          problems.push(`${transfer.from}: stack ${id} lacks an exact bounded transfer amount`);
      } else if (spec && typeof spec === 'object') {
        problems.push(`${transfer.from}: non-stack ${id} was given a quantity`);
      }
    }
  }
  if (!checked) problems.push('no item was available to prove the transfer encoding contract');
  return { ok: problems.length === 0, checked, problems: [...new Set(problems)] };
}

export function createSingleFlight(worker) {
  let tail = Promise.resolve();
  let active = 0;
  let maxActive = 0;
  const run = (...args) => {
    const result = tail.then(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      try { return await worker(...args); }
      finally { active--; }
    });
    tail = result.catch(() => undefined);
    return result;
  };
  run.stats = () => ({ active, maxActive });
  return run;
}

// --------------------------------------------------------------------------- CLI

function cliArg(argv, name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const next = argv[index + 1];
  return next && !next.startsWith('--') ? next : true;
}

function playerNames(view) {
  return (view?.objects ?? []).filter(object => object?.is_player === true ||
    (Number.isInteger(object?.flags) && (object.flags & 0x04)))
    .map(object => object.name).filter(Boolean);
}

function percentFromCarry(carry) {
  if (!carry?.known || !carry?.load?.exact || !(carry.weight_max > 0)) return null;
  return Math.max(carry.load.weight / carry.weight_max, carry.load.bulk / carry.bulk_max) * 100;
}

async function mapLimit(values, limit, fn) {
  const out = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      out[index] = await fn(values[index], index);
    }
  }));
  return out;
}

function makeRpc(port) {
  let id = 0;
  const url = `http://127.0.0.1:${port}/`;
  return async (name, args = {}, timeoutMs = 90_000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
          params: { name, arguments: args } }),
      });
      if (!response.ok) throw new Error(`${name}: broker returned HTTP ${response.status}`);
      const reply = await response.json();
      if (reply.error) throw new Error(`${name}: ${reply.error.message ?? JSON.stringify(reply.error)}`);
      const text = reply.result?.content?.[0]?.text;
      if (reply.result?.isError) throw new Error(`${name}: ${text}`);
      try { return JSON.parse(text); } catch { return text; }
    } finally {
      clearTimeout(timer);
    }
  };
}

async function readRts(port, agents, fleet = 'prod') {
  const query = new URLSearchParams({ fleet, agents: agents.join(',') });
  const response = await fetch(`http://127.0.0.1:${port}/rts/v1/read?${query}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`RTS read returned HTTP ${response.status}`);
  const body = await response.json();
  if (body?.read_only !== true) throw new Error('RTS survey did not identify itself as read-only');
  return body;
}

async function collectShelterSnapshot(rpc, { port, fleetName = 'prod' } = {}) {
  const fleet = await rpc('fleet', {});
  const candidates = (fleet?.fleet ?? []).filter(row => row.in_game !== false &&
    Number(row.room_num) === SHELTER_ROOM);
  const agents = candidates.map(row => String(row.agent));
  const quietStarted = Date.now();
  const before = await readRts(port, agents, fleetName);
  const surveyed = await mapLimit(candidates, 4, async row => {
    try {
      const inventory = await rpc('inventory', { agent: row.agent });
      const [equipment, view] = await Promise.all([
        rpc('equipment', { agent: row.agent, refresh: false }),
        rpc('look', { agent: row.agent }),
      ]);
      return {
        ...row,
        inventory: inventory?.items ?? [],
        equipment,
        equipmentKnown: equipment?.known === true,
        visibleCharacters: playerNames(view),
        loadPercent: row.pack?.percent ?? percentFromCarry(inventory?.carry),
      };
    } catch (error) {
      return { ...row, inventory: [], visibleCharacters: [],
        health: null, survey_error: String(error?.message ?? error) };
    }
  });
  const remaining = 2_200 - (Date.now() - quietStarted);
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
  const after = await readRts(port, agents, fleetName);
  return surveyed.map(row => ({
    ...row,
    keeperSamples: [before?.looks?.[row.agent] ?? null, after?.looks?.[row.agent] ?? null],
  }));
}

function concisePlan(plan, mode, extra = {}) {
  return {
    at: new Date().toISOString(),
    mode,
    room: plan.room,
    phase: plan.phase,
    participants: plan.participants,
    transfers: plan.transfers,
    excluded: plan.excluded,
    ...extra,
  };
}

async function runCli(argv = process.argv.slice(2)) {
  const once = cliArg(argv, 'once', null);
  const watch = argv.includes('--watch');
  const go = argv.includes('--go');
  const room = Number(cliArg(argv, 'room', SHELTER_ROOM));
  if (room !== SHELTER_ROOM)
    throw new Error(`--room must be ${SHELTER_ROOM}; this tool never routes or serves another room`);
  if (!!once === watch)
    throw new Error('choose exactly one of --once <food|weapons|gear|all> or --watch');
  const port = Number(cliArg(argv, 'port', 8901));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid --port');
  const options = {
    room,
    foodReserve: Number(cliArg(argv, 'food-reserve', 60)),
    weaponReserve: Number(cliArg(argv, 'weapon-reserve', 1)),
    armourReserve: Number(cliArg(argv, 'armour-reserve', 1)),
    shieldReserve: Number(cliArg(argv, 'shield-reserve', 1)),
  };
  const rpc = makeRpc(port);
  const snapshot = () => collectShelterSnapshot(rpc, {
    port,
    fleetName: String(cliArg(argv, 'fleet', 'prod')),
  });

  const executePhase = async phase => {
    let rows = await snapshot();
    let plan = planShelterRedistribution(rows, { ...options, phase });
    if (!go) {
      console.log(JSON.stringify(concisePlan(plan, 'dry-run'), null, 2));
      return plan;
    }

    // This is intentionally before the first `supply` call.  On the current public
    // inventory shape it refuses because tag is not exposed; that is a safe and useful
    // result, not an invitation to add an override flag.
    const contract = validateExactTransferContract(rows, plan.transfers);
    if (!contract.ok) {
      console.log(JSON.stringify(concisePlan(plan, 'refused-before-mutation', {
        supplied: 0,
        reason: 'exact KeeperProxy transfer encoding could not be proven',
        contract,
      }), null, 2));
      return { ...plan, refused: true, contract };
    }

    const attempted = new Set();
    const results = [];
    const maxTransfers = Math.max(1, Number(cliArg(argv, 'max-transfers', 24)) || 24);
    for (let count = 0; count < maxTransfers; count++) {
      // Re-survey after every hand-over.  Food may have been eaten and equipment may
      // have changed while the last trade completed; a stale reserve is not a reserve.
      rows = count === 0 ? rows : await snapshot();
      plan = planShelterRedistribution(rows, { ...options, phase });
      const next = plan.transfers.find(transfer => {
        const signature = `${transfer.phase}:${transfer.from}:${transfer.to}:${JSON.stringify(transfer.what)}`;
        if (attempted.has(signature)) return false;
        attempted.add(signature);
        return true;
      });
      if (!next) break;
      const exact = validateExactTransferContract(rows, [next]);
      if (!exact.ok) {
        results.push({ transfer: next, supplied: false, refused: true, contract: exact });
        break;
      }
      const result = await rpc('supply', {
        from: next.from,
        to: next.to,
        what: next.what,
        who_travels: 'neither',
        walk_ms: 0,
      }, 150_000).catch(error => ({ supplied: false, reason: String(error?.message ?? error) }));
      results.push({ transfer: next, result });
      if (!result?.supplied) continue;
    }
    console.log(JSON.stringify({ at: new Date().toISOString(), mode: 'live', room,
      phase, supplied: results.filter(entry => entry.result?.supplied).length, results }, null, 2));
    return results;
  };

  const runOne = createSingleFlight(executePhase);
  if (once) {
    for (const phase of phasesOf(once)) await runOne(phase);
    return;
  }

  if (go) {
    // Fail immediately rather than arming a scheduler that discovers five minutes
    // later that it cannot prove its wire contract.  This survey is read-only.
    const rows = await snapshot();
    const contract = validateExactTransferContract(rows);
    if (!contract.ok) {
      console.log(JSON.stringify({ at: new Date().toISOString(), mode: 'refused-before-watch',
        supplied: 0, reason: 'exact KeeperProxy transfer encoding could not be proven', contract }, null, 2));
      return;
    }
  }

  const next = Object.fromEntries(PHASE_ORDER.map(phase =>
    [phase, Date.now() + PHASE_CADENCE_MS[phase]]));
  console.log(JSON.stringify({ mode: go ? 'live-watch' : 'dry-run-watch', room,
    next: Object.fromEntries(PHASE_ORDER.map(phase => [phase, new Date(next[phase]).toISOString()])),
    note: 'one phase at a time; all supply calls use who_travels=neither' }));
  for (;;) {
    const dueAt = Math.min(...Object.values(next));
    await new Promise(resolve => setTimeout(resolve, Math.max(50, Math.min(1000, dueAt - Date.now()))));
    const now = Date.now();
    for (const phase of PHASE_ORDER) {
      if (next[phase] > now) continue;
      await runOne(phase);
      do { next[phase] += PHASE_CADENCE_MS[phase]; } while (next[phase] <= Date.now());
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch(error => {
    console.error(`shelter quartermaster: ${error.message}`);
    process.exitCode = 1;
  });
}
