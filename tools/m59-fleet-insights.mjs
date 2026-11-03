// Read-only operations reports. No game calls, orders, roster passwords or fleet ownership.
import { openSync, readSync, closeSync, fstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { activityReport, mergeActivityCasts } from './m59-activity-report.mjs';

export const stamp = r => typeof r === 'number' ? r : Number(r?.t) || (typeof r?.at === 'number' ? r.at : Date.parse(r?.at ?? r?.iso ?? '')) || 0;
const key = s => String(s ?? '').toLowerCase().trim();
const numeric = n => n != null && Number.isFinite(Number(n)) ? Number(n) : null;
const json = (p, fallback = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
const files = p => { try { return readdirSync(p); } catch { return []; } };
const safe = s => /^[a-z0-9_-]+$/i.test(s);

/** Bounded tail with coverage metadata; a partial first row is never parsed. */
export function readRows(file, maxBytes = 4_000_000) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size, length = Math.min(maxBytes, size), buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    let text = buf.toString('utf8');
    if (size > length) text = text.slice(text.indexOf('\n') + 1);
    let malformed = 0;
    const rows = text.split('\n').filter(s => s.trim()).flatMap(s => { try { return [JSON.parse(s)]; } catch { malformed++; return []; } });
    return { rows, truncated: size > length, malformed, missing: false };
  } catch { return { rows: [], truncated: false, malformed: 0, missing: true }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function percentile(values, p) {
  const a = values.filter(v => typeof v === 'number' && Number.isFinite(v) && v >= 0).sort((x, y) => x - y);
  return a.length ? a[Math.max(0, Math.ceil(p * a.length) - 1)] : null;
}

/** Spell ability points per wall-clock hour. Atrophy remains visible and reduces ETA rate. */
export function practiceReport({ people = [], now = Date.now(), hours = 2 } = {}) {
  const since = now - hours * 3_600_000;
  const rows = [], plans = [];
  for (const p of people) {
    const events = (p.events ?? []).filter(e => stamp(e) <= now).sort((a, b) => stamp(a) - stamp(b));
    const latestStart = events.filter(e => e.kind === 'run_start').at(-1);
    if (latestStart?.goals?.until) {
      const goal = latestStart.goals.until;
      const reads = events.filter(e => e.kind === 'run_start' && e.goals?.until === goal && e.school === latestStart.school && e.gate?.known && stamp(e) >= since && numeric(e.gate.have) != null && numeric(e.gate.need) != null);
      const first = reads[0], last = reads.at(-1), gap = numeric(last?.gate?.gap);
      const span = first && last ? stamp(last) - stamp(first) : 0;
      const changedGate = reads.some(e => e.gate.need !== last?.gate.need);
      const rate = span > 0 ? (last.gate.have - first.gate.have) / span * 3600000 : null;
      const reason = p.live?.piloted ? 'Human pilot' : !last ? 'No gate observations' : last.gate.open || gap === 0 ? 'Gate reached' : now - stamp(last) > 5 * minuteMs ? 'No recent gate observation' : changedGate ? 'Learning requirement changed' : reads.length < 2 || span < 5 * minuteMs ? 'Need two gate reads over five minutes' : rate == null || rate <= 0 ? 'No positive net gate progress' : gap == null ? 'Remaining points unread' : null;
      plans.push({ agent: p.agent, character: p.character, goal, school: latestStart.school, have: numeric(last?.gate.have), need: numeric(last?.gate.need), gap, rate, etaMs: reason == null ? gap / rate * 3600000 : null, reason, at: last ? stamp(last) : stamp(latestStart), untilKnown: latestStart.goals.until_known === true });
    }
    const configured = new Map();
    const add = (name, source, target = null) => {
      if (!name) return;
      const was = configured.get(key(name));
      configured.set(key(name), { source: was?.target != null && target == null ? was.source : source, target: numeric(target) ?? was?.target ?? null });
    };
    for (const t of p.order?.trainings ?? []) if (t.kind === 'spell') add(t.name, 'standing order', t.target ?? t.to ?? 99);
    if (p.live?.policy?.practiceSpells?.enabled !== false)
      for (const s of p.live?.policy?.practiceSpells?.spells ?? []) add(typeof s === 'string' ? s : s.name, 'keeper practice');
    if (p.live?.policy?.touchSpell) add(p.live.policy.touchSpell, 'farming touch');
    // Runner goals are explicit telemetry; old command text is never guessed into a goal.
    for (const t of latestStart?.goals?.abilities ?? []) add(t.name, 'FleetScript goal', t.to);
    const recent = events.filter(e => stamp(e) >= since);
    for (const e of recent) if (e.spell && ['cast', 'improve'].includes(e.kind) && !configured.has(key(e.spell))) add(e.spell, 'recorded practice');
    for (const e of p.keeperEvents ?? []) if (stamp(e) >= since && stamp(e) <= now && !configured.has(key(e.spell))) add(e.spell, 'recorded keeper practice');
    for (const e of p.nativeCasts ?? []) if (stamp(e) >= since && stamp(e) <= now && !configured.has(key(e.spell))) add(e.spell, 'broker spell use');
    for (const h of p.book?.history ?? []) if (h.kind === 'spell' && stamp({ t: h.at }) >= since && h.at <= now && !configured.has(key(h.name))) add(h.name, 'observed ability change');
    for (const [name, config] of configured) {
      const bookEntry = Object.entries(p.book?.spells ?? {}).find(([n]) => key(n) === name)?.[1];
      const mine = recent.filter(e => key(e.spell ?? e.name ?? String(e.training ?? '').replace(/^spell:/, '')) === name);
      const hist = (p.book?.history ?? []).filter(h => h.kind === 'spell' && key(h.name) === name && h.at >= since && h.at <= now);
      // Both sources describe the same changes. Prefer the pushed book, never add them.
      const changes = (hist.length ? hist : mine.filter(e => e.kind === 'improve')).map(e => ({ at: Number(e.at ?? e.t), delta: Number(e.to) - Number(e.from), from: Number(e.from), to: Number(e.to) })).filter(e => Number.isFinite(e.delta));
      const gained = changes.reduce((n, e) => n + Math.max(0, e.delta), 0), lost = changes.reduce((n, e) => n + Math.max(0, -e.delta), 0);
      const trainedCasts = mine.filter(e => e.kind === 'cast');
      const keeperCasts = (p.keeperEvents ?? []).filter(e => key(e.spell) === name && stamp(e) >= since && stamp(e) <= now);
      const native = (p.nativeCasts ?? []).filter(e => key(e.spell) === name && stamp(e) >= since && stamp(e) <= now);
      const casts = mergeActivityCasts(native, trainedCasts, keeperCasts);
      const outcomes = { success: 0, fizzle: 0, broken: 0, refused: 0, unknown: 0 };
      casts.forEach(e => outcomes[e.outcome in outcomes ? e.outcome : 'unknown']++);
      const firstObservation = numeric(bookEntry?.first);
      const cappedHistoryStart = (p.book?.history?.length ?? 0) >= 400 ? Math.min(...p.book.history.map(h => Number(h.at)).filter(Number.isFinite)) : since;
      const observationStart = Math.max(since, firstObservation ?? since, cappedHistoryStart);
      const spanHours = Math.max(0, now - observationStart) / 3_600_000;
      const rate = spanHours > 0 ? (gained - lost) / spanHours : null;
      const latestChange = changes.at(-1);
      const current = numeric(bookEntry?.ability) ?? numeric(latestChange?.to);
      const lastAt = Math.max(0, ...mine.map(stamp), ...casts.map(stamp), ...changes.map(e => e.at));
      const status = p.status, fresh = status && now - Number(status.at) >= 0 && now - Number(status.at) < 180_000 && key(status.training?.name) === name;
      const snapshotFresh = !!p.live && Number(p.live.snapshot_age_ms ?? Infinity) < 60_000;
      const isConfigured = ['standing order', 'keeper practice', 'farming touch', 'FleetScript goal'].includes(config.source);
      const state = p.live?.piloted ? 'Human pilot' : fresh ? status.active ? status.limited_on ? 'Limited' : 'Active' : 'Paused' : snapshotFresh && isConfigured ? 'Configured' : lastAt && now - lastAt < 180_000 ? 'Recent activity' : 'No recent evidence';
      const target = config.target;
      const runnerEnded = config.source === 'FleetScript goal' && events.some(e => e.kind === 'run_end' && e.run === latestStart?.run);
      const etaReason = target == null ? 'No target recorded' : current == null ? 'Ability unread' : current >= target ? 'Target reached' : runnerEnded ? 'Last recorded runner ended' : rate == null || rate <= 0 ? 'No positive net advancement' : changes.length < 2 || spanHours < 1 / 12 ? 'Need at least two changes over five minutes' : ['Human pilot', 'Paused', 'No recent evidence'].includes(state) ? 'Training activity is not current' : null;
      const etaMs = etaReason == null ? (target - current) / rate * 3_600_000 : null;
      rows.push({ agent: p.agent, character: p.character, spell: name, source: config.source, current, target, gained, lost, rate, spanHours, attempts: casts.length, castSource: native.length ? 'broker telemetry + earlier legacy records' : trainedCasts.length ? 'training ledger' : 'keeper ledger', outcomes, successPct: casts.length ? outcomes.success / casts.length * 100 : null, state, limit: fresh ? status.limited_on ?? status.why ?? null : native.at(-1)?.reason ?? null, lastAt: lastAt || null, bookAt: numeric(bookEntry?.at), etaMs, etaReason, changes });
    }
  }
  return { now, hours, rows, plans, summary: { characters: new Set(rows.map(r => r.agent)).size, spells: new Set(rows.map(r => r.spell)).size, gained: rows.reduce((n, r) => n + r.gained, 0), lost: rows.reduce((n, r) => n + r.lost, 0), attempts: rows.reduce((n, r) => n + r.attempts, 0) } };
}

const minuteMs = 60_000;

// The old collector timestamps collection, not completion. Its HH:mm:ss times
// are UTC run-log clocks. Recover the date from the timestamp encoded in its log name.
export function courierEndTime(r) {
  if (!r.log || !/^\d\d:\d\d:\d\d$/.test(r.ended ?? '')) return stamp(r);
  const suffix = r.log.match(/-([a-z0-9]+)\.log$/)?.[1];
  const start = suffix ? parseInt(suffix, 36) : NaN;
  if (!Number.isFinite(start) || start < 1_600_000_000_000 || start > 4_000_000_000_000) return 0;
  const seconds = r.ended.split(':').reduce((n, s) => n * 60 + Number(s), 0);
  let end = Math.floor(start / 86_400_000) * 86_400_000 + seconds * 1000;
  if (end < start - 1000) end += 86_400_000;
  return end;
}

/** Parse existing FleetScript loop output without executing or importing a local script. */
export function parseCourierRun(log, text) {
  const lines = text.split('\n');
  const done = lines.find(l => /^\d\d:\d\d:\d\d .*: \d+\/\d+ completed/.test(l));
  if (!done) return null;
  const timed = lines.filter(l => /^\d\d:\d\d:\d\d /.test(l));
  const actors = new Set(timed.map(l => l.match(/^\d\d:\d\d:\d\d ([a-z]+\d+) /)?.[1]).filter(Boolean));
  if (actors.size !== 1) return null; // a multi-character run cannot be attributed to one courier
  const actor = [...actors][0];
  const legs = []; let leg = null;
  const seconds = s => s.split(':').reduce((n, v) => n * 60 + Number(v), 0);
  for (const l of timed) {
    const walk = l.match(/^(\d\d:\d\d:\d\d) \S+ walking (\d+) -> (\d+)/);
    if (walk) leg = { from: Number(walk[2]), to: Number(walk[3]), start: walk[1] };
    const end = l.match(/^(\d\d:\d\d:\d\d) \S+ step \d+ \(walk\) (ok|failed: (.*))/);
    if (end && leg) { legs.push({ from: leg.from, to: leg.to, secs: (seconds(end[1]) - seconds(leg.start) + 86400) % 86400, ok: end[2] === 'ok', why: end[3] ?? null }); leg = null; }
  }
  const fail = timed.map(l => l.match(/step \d+ \(\w+\) failed: (.*)/)?.[1]).filter(Boolean).at(-1);
  return { kind: 'lap_end', log, agent: actor, started: timed[0]?.slice(0, 8), ended: done.slice(0, 8), completed: /: 1\/1 completed/.test(done), legs, why: fail ?? null };
}

export function courierReport({ events = [], active = [], pvp = [], coveredDays = [], now = Date.now(), hours = 24, agent = null, character = null, members = [] } = {}) {
  const since = now - hours * 3_600_000, ends = new Map(), starts = new Map();
  const transfers = events.filter(r => r.kind === 'transfer' && stamp(r) >= since && stamp(r) <= now);
  for (const r of events) {
    if (r.kind === 'lap_start' && r.lap) starts.set(r.lap, r);
    if (r.kind === 'lap_end') { const id = r.log ?? r.run ?? r.lap; if (id) ends.set(id, { ...ends.get(id), ...r }); }
  }
  const trips = [...ends].flatMap(([id, r]) => {
    const ended = courierEndTime(r);
    if (!ended || ended < since || ended > now) return [];
    const start = starts.get(r.lap);
    let duration = numeric(r.duration_ms);
    if (duration == null && r.started && r.ended && /^\d\d:\d\d:\d\d$/.test(r.started) && /^\d\d:\d\d:\d\d$/.test(r.ended)) {
      const sec = s => s.split(':').reduce((n, v) => n * 60 + Number(v), 0);
      duration = ((sec(r.ended) - sec(r.started) + 86400) % 86400) * 1000;
    }
    if (duration == null && start && ended >= stamp(start)) duration = ended - stamp(start);
    const actor = r.agent ?? agent, person = members.find(m => m.agent === actor)?.character ?? r.character ?? character;
    return [{ id, script: r.script ?? null, native: r.native === true, runKey: r.run_key ?? null, agent: actor, character: person, ended, duration, ok: r.completed === true, why: r.why ?? r.failed ?? null, refusals: r.transfer_refusals?.length ?? 0, legs: (r.legs ?? []).map(l => ({ from: l.from, to: l.to, ok: l.ok, duration: numeric(l.secs) == null ? null : l.secs * 1000, why: l.why ?? null })) }];
  }).sort((a, b) => b.ended - a.ended);
  const durations = trips.filter(t => t.ok && t.duration != null).map(t => t.duration);
  const routes = new Map();
  for (const t of trips) for (const l of t.legs) {
    const k = `${l.from} → ${l.to}`, g = routes.get(k) ?? { route: k, samples: [], failures: 0, count: 0 };
    g.count++; if (!l.ok) g.failures++; else if (l.duration != null) g.samples.push(l.duration); routes.set(k, g);
  }
  // last_outcome is repeated in later milestones. Count the incoming hit once,
  // using its own timestamp, never sum cumulative attacker tallies.
  const hits = new Map();
  for (const r of pvp) {
    const o = r.last_outcome;
    if (r.kind !== 'combat' || o?.direction !== 'incoming' || o.outcome !== 'hit' || !o.at) continue;
    const at = Number(o.at);
    if (at < since || at > now) continue;
    const id = `${key(r.observer)}|${at}|${key(o.character)}|${o.text ?? ''}`;
    hits.set(id, { at, character: r.observer });
  }
  const hitRows = [...hits.values()];
  const coverage = new Set(coveredDays);
  const inTransit = new Map();
  for (const t of trips) {
    const start = t.duration == null ? null : t.ended - t.duration;
    const rows = start == null ? [] : hitRows.filter(h => key(h.character) === key(t.character) && h.at >= start && h.at <= t.ended);
    const days = start == null ? [] : Array.from({ length: Math.floor(t.ended / 86400000) - Math.floor(start / 86400000) + 1 }, (_, i) => new Date((Math.floor(start / 86400000) + i) * 86400000).toISOString().slice(0, 10));
    t.pvpHits = rows.length;
    t.contact = rows.length ? 'PvP hit' : days.length && days.every(d => coverage.has(d)) ? 'Quiet' : 'Unmeasured';
    rows.forEach(h => inTransit.set(`${h.character}|${h.at}`, h));
  }
  for (const t of active) {
    const rows = hitRows.filter(h => key(h.character) === key(t.character) && h.at >= t.started && h.at <= now);
    t.pvpHits = rows.length; rows.forEach(h => inTransit.set(`${h.character}|${h.at}`, h));
  }
  const courierNames = new Set([character, ...trips.map(t => t.character), ...active.map(t => t.character)].filter(Boolean).map(key));
  const courierHits = hitRows.filter(h => courierNames.has(key(h.character)));
  const hourly = new Map();
  for (const h of courierHits) { const hour = Math.floor(h.at / 3600000) * 3600000; const b = hourly.get(hour) ?? { hour, hits: 0, inTransit: 0 }; b.hits++; if (inTransit.has(`${h.character}|${h.at}`)) b.inTransit++; hourly.set(hour, b); }
  return { now, hours, trips, active, routes: [...routes.values()].map(r => ({ route: r.route, count: r.count, failures: r.failures, p50: percentile(r.samples, .5), p90: percentile(r.samples, .9) })).sort((a, b) => b.failures - a.failures || (b.p90 ?? 0) - (a.p90 ?? 0)),
    recentTransfers: transfers.slice(-30).reverse().map(r => ({ at: stamp(r), from: r.from, to: r.to, item: r.item, moved: r.moved, asked: r.asked, ok: r.ok === true, dir: r.dir, room: r.room, why: r.why })),
    hourly: [...hourly.values()].sort((a, b) => b.hour - a.hour),
    summary: { completed: trips.filter(t => t.ok).length, total: trips.length, successPct: trips.length ? trips.filter(t => t.ok).length / trips.length * 100 : null, p50: percentile(durations, .5), p75: percentile(durations, .75), p90: percentile(durations, .9), timed: durations.length, transferTotal: transfers.length, transferSuccess: transfers.filter(t => t.ok).length, moved: transfers.reduce((n, t) => n + Math.max(0, Number(t.moved) || 0), 0), quiet: trips.filter(t => t.contact === 'Quiet').length, pvpTrips: trips.filter(t => t.contact === 'PvP hit').length, unmeasured: trips.filter(t => t.contact === 'Unmeasured').length, pvpHits: courierHits.length, inTransitHits: inTransit.size, hitHours: hourly.size, lastAt: Math.max(0, ...trips.map(t => t.ended), ...transfers.map(stamp)) || null } };
}

/** Only caller-supplied fleet members are read. Never enumerate ability books or load a password roster. */
export function collectInsights({ root, fleet = '', live = [], characters = null, now = Date.now(), hours = 24, activityDir = null } = {}) {
  if (!root || (fleet && !safe(fleet))) throw new Error('An explicit root and valid fleet are required');
  const sub = join(root, 'substrate'), history = join(sub, 'history', fleet || 'default', 'training');
  const roster = characters ?? live.map(r => ({ agent: r.agent, character: r.character }));
  const coverage = [];
  const activityRows = [], activityPath = activityDir || join(sub, 'history', fleet || 'default', 'activity');
  for (const file of files(activityPath).filter(f => /^\d{4}-\d\d-\d\d\.jsonl$/.test(f))) {
    const t = Date.parse(file.slice(0, 10));
    if (t + 86400000 < now - (hours + 24) * 3600000 || t > now) continue;
    const log = cachedRows(join(activityPath, file), 12_000_000, () => true);
    activityRows.push(...log.rows);
    if (log.truncated || log.malformed) coverage.push(`Shared activity ${file}: partial retained telemetry; missing starts remain unmeasured.`);
  }
  const native = activityReport(activityRows, { characters: roster, fleet, now });
  native.active = native.active.filter(r => r.lastAt >= now - hours * 3600000);
  const ledgerRoot = join(sub, 'history', fleet || 'default'), keeperEvents = [];
  for (const file of files(ledgerRoot).filter(f => /^fleet-\d{4}-\d\d-\d\d\.jsonl$/.test(f))) {
    const t = Date.parse(file.slice(6, 16));
    if (t + 86400000 < now - hours * 3600000 || t > now) continue;
    const path = join(ledgerRoot, file), log = cachedRows(path, 12_000_000, r => r.kind === 'cast' && /practice/i.test(r.why ?? ''));
    keeperEvents.push(...log.rows.map(r => ({ ...r, outcome: r.ok === false ? 'refused' : r.mana_cost > 0 || r.made?.length ? 'success' : 'unknown' })));
    if (log.truncated) coverage.push(`${file}: practice-cast coverage is limited to its latest 12 MB.`);
  }
  const people = roster.filter(p => safe(p.agent) && p.character).map(p => {
    const log = readRows(join(history, `${p.agent}.jsonl`));
    if (log.truncated || log.malformed) coverage.push(`${p.character}: training log tail${log.truncated ? ' is bounded to 4 MB' : ''}${log.malformed ? `; ${log.malformed} incomplete rows skipped` : ''}`);
    const book = json(join(sub, 'abilities', `${p.character.replace(/[^A-Za-z0-9_-]/g, '')}.json`));
    if ((book?.history?.length ?? 0) >= 400 && Number(book.history[0].at) > now - hours * 3600000) coverage.push(`${p.character}: ability history is capped at 400 changes; its rate uses the retained observation span.`);
    return { ...p, live: live.find(l => l.agent === p.agent), events: [...log.rows.filter(e => !e.character || e.character === p.character), ...native.training.filter(e => e.character === p.character && e.agent === p.agent)], nativeCasts: native.casts.filter(e => e.character === p.character && e.agent === p.agent), keeperEvents: keeperEvents.filter(e => e.character === p.character), book, status: json(join(history, `${p.agent}.status.json`)), order: json(join(sub, 'training', fleet || 'default', `${encodeURIComponent(p.character).replace(/\*/g, '%2A').replace(/\./g, '%2E')}.json`)) };
  });
  // The pigeon file is legacy and unscoped. Accept it only if its declared
  // courier (source's agents=) belongs to this exact roster. Never assume hk2.
  let courierAgent = null;
  try { courierAgent = readFileSync(join(sub, 'fleetscripts', 'zheng-he-lap.mjs'), 'utf8').match(/agents=([a-z0-9]+)/)?.[1] ?? null; } catch {}
  const courier = roster.find(p => p.agent === courierAgent);
  const pigeon = courier ? readRows(join(sub, 'courier-pigeon.jsonl'), 12_000_000) : { rows: [], missing: true };
  if (pigeon.truncated) coverage.push('Courier history is bounded to the latest 12 MB.');
  if (!courier) coverage.push('No courier script assigned to this roster; unscoped pigeon history excluded.');
  const practice = practiceReport({ people, hours, now });
  const loops = join(sub, 'history', fleet || 'default', 'loops');
  const runCacheKey = `${root}|${fleet}`;
  const cache = runCaches.get(runCacheKey) ?? new Map(); runCaches.set(runCacheKey, cache);
  const logs = files(loops).filter(f => /courier|zheng-he-lap/.test(f) && /-[a-z0-9]+\.log$/.test(f) && !/-repeat\.log$/.test(f));
  const runRows = [];
  for (const log of logs) {
    const t = parseInt(log.match(/-([a-z0-9]+)\.log$/)[1], 36);
    if (t < now - (hours + 24) * 3600000 || t > now) continue;
    let r = cache.get(log);
    if (!r) { try { r = parseCourierRun(log, readFileSync(join(loops, log), 'utf8')); } catch {} if (r) cache.set(log, r); }
    if (r && roster.some(p => p.agent === r.agent)) runRows.push(r);
  }
  const pvpDir = join(sub, 'pvp', fleet || 'default');
  const pvp = [], coveredDays = [];
  for (const file of files(pvpDir).filter(f => /^\d{4}-\d\d-\d\d\.jsonl$/.test(f))) {
    const day = file.slice(0, 10), t = Date.parse(day);
    if (t + 86400000 < now - (hours + 24) * 3600000 || t > now) continue;
    const log = cachedRows(join(pvpDir, file), 12_000_000, r => r.kind === 'combat' && r.last_outcome?.direction === 'incoming' && r.last_outcome?.outcome === 'hit');
    pvp.push(...log.rows);
    if (!log.missing && !log.truncated && !log.malformed) coveredDays.push(day);
    else coverage.push(`PvP record ${day} is partial; quiet classification is unavailable for that day.`);
  }
  const courierAgents = new Set([courier?.agent, ...runRows.map(r => r.agent), ...native.trips.map(r => r.agent), ...native.active.map(r => r.agent)].filter(Boolean));
  const legacyEvents = [...pigeon.rows, ...runRows].filter(r => {
    if (r.kind !== 'lap_end' || !r.log) return true;
    const ended = courierEndTime(r), actor = r.agent ?? courier?.agent;
    const script = r.log.replace(/-[a-z0-9]+\.log$/, '');
    return !native.trips.some(n => n.agent === actor && n.script?.replace(/ \([^)]*\)$/, '') === script && n.started_at <= ended && Math.abs(n.t - ended) < 120000);
  });
  const couriers = courierReport({ events: [...legacyEvents, ...native.trips, ...native.transfers], active: native.active, pvp, coveredDays, hours, now, agent: courier?.agent, character: courier?.character, members: roster });
  couriers.summary.lastAt = Math.max(couriers.summary.lastAt ?? 0, ...native.active.map(r => r.lastAt)) || null;
  couriers.stock = native.stock.filter(r => r.at >= now - hours * 3600000).slice(-25).reverse();
  const standing = courier ? json(join(sub, 'courier-requests.json'), {}) : {};
  const requests = roster.flatMap(p => Object.entries(standing[p.agent] ?? {}).filter(([, n]) => Number(n) > 0).map(([item, target]) => ({ character: p.character, agent: p.agent, item, target: Number(target) })));
  return { fleet: fleet || 'default', now, hours, practice, couriers, requests, coverage, sources: { trainingCharacters: people.filter(p => p.events.length).length, abilityBooks: people.filter(p => p.book).length, pigeonMissing: pigeon.missing, courier: courier ? { agent: courier.agent, character: courier.character } : null, courierAgents: [...courierAgents], runLogs: runRows.length, activityRows: native.rows, pvpDays: coveredDays.length }, characters: roster.length };
}

const runCaches = new Map();
const dailyCaches = new Map();
function cachedRows(path, maxBytes, filter) {
  let version;
  try { const s = statSync(path); version = `${s.size}|${s.mtimeMs}`; } catch { return { rows: [], missing: true }; }
  const old = dailyCaches.get(path);
  if (old?.version === version) return old.log;
  const log = readRows(path, maxBytes); log.rows = log.rows.filter(filter);
  dailyCaches.set(path, { version, log });
  if (dailyCaches.size > 100) dailyCaches.delete(dailyCaches.keys().next().value);
  return log;
}
