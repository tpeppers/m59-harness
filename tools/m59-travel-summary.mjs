// Pure reporting over durable events and the bounded per-character transit books.
// Destinations of failed journeys are never counted as maps visited.
export const TRAVEL_METHODS = {
  chalice: 'Chalice rides', rescue: 'Rescue casts', elusion: 'Elusion casts',
  portal: 'Portals', underworld: 'Underworld exits',
};
const finite = n => typeof n === 'number' && Number.isFinite(n);
const mapNumber = n => finite(n) && n > 0 ? n : null;
const count = n => finite(n) && n >= 0 ? n : 0;

export function travelSummary({ events = [], samples = [], books = [], characters = null,
  since = 0, now = Date.now() } = {}) {
  const people = new Map(), maps = new Map(), intervals = new Map();
  const allowed = who => who && (!characters || characters.has(who));
  const inWindow = t => finite(t) && t >= since && t <= now;
  const person = who => {
    if (!people.has(who)) people.set(who, { character: who, maps: new Set(), entries: 0,
      journeys: 0, arrived: 0, failed: 0, unknown: 0, journey_ms: 0,
      crossings: 0, issues: 0, collisions: 0, stuck_ms: 0,
      methods: Object.fromEntries(Object.keys(TRAVEL_METHODS).map(k => [k, 0])) });
    return people.get(who);
  };
  const room = (num, name) => {
    num = mapNumber(num);
    if (num === null) return null;
    if (!maps.has(num)) maps.set(num, { room: num, name: name || `Map ${num}`,
      characters: new Set(), crossings: 0, successful: 0, failed: 0, unknown: 0,
      issues: 0, collisions: 0, ms: 0, times: [], stuck_ms: 0, stuck_episodes: 0 });
    const r = maps.get(num);
    if (name) r.name = name;
    return r;
  };
  const seen = (p, num, name) => {
    const r = room(num, name);
    if (r) { p.maps.add(r.room); r.characters.add(p.character); }
    return r;
  };
  for (const who of characters ?? []) person(who);
  for (const s of samples) if (allowed(s.character) && inWindow(s.t))
    seen(person(s.character), s.room_num, s.room);
  // New wire-level cast events supersede the old partial cast log from that point on.
  const castStarts = new Map();
  for (const e of events) if (allowed(e.character) && inWindow(e.t) && e.kind === 'travel_cast') {
    const key = `${e.character}\0${e.spell}`;
    castStarts.set(key, Math.min(castStarts.get(key) ?? Infinity, e.t));
  }
  for (const e of events) {
    if (!allowed(e.character) || !inWindow(e.t)) continue;
    const p = person(e.character);
    if (e.kind === 'travel_journey' || e.kind === 'zone_change') {
      p.journeys++;
      p[e.arrived === true ? 'arrived' : e.arrived === false ? 'failed' : 'unknown']++;
      p.journey_ms += count(e.ms);
      seen(p, e.from); seen(p, e.ended_in);
      if (e.arrived === true) seen(p, e.to);
    }
    if (e.kind === 'travel_map_entered') {
      seen(p, e.room, e.room_name);
      if (e.from !== null && e.from !== e.room) p.entries++;
    }
    if (e.kind === 'chalice' && e.what === 'landed') {
      p.methods.chalice++; seen(p, e.landed_in);
    }
    if (e.kind === 'travel_method' && ['portal', 'underworld'].includes(e.method)) {
      p.methods[e.method]++; seen(p, e.room, e.room_name);
    }
    const spell = String(e.spell ?? '').toLowerCase();
    if (['rescue', 'elusion'].includes(spell) && (e.kind === 'travel_cast' ||
      (e.kind === 'cast' && e.t < (castStarts.get(`${e.character}\0${spell}`) ?? Infinity))))
      p.methods[spell]++;
    if (['stuck_backed_up', 'wedge_gave_up'].includes(e.kind) && count(e.wedged_for_ms)) {
      const r = seen(p, e.room, e.room_name);
      if (!r) continue;
      const key = `${p.character}\0${r.room}`;
      const group = intervals.get(key) ?? { p, r, spans: [] };
      group.spans.push([Math.max(since, e.t - e.wedged_for_ms), e.t]);
      intervals.set(key, group);
    }
  }
  let oldestTransit = null, transitRecords = 0;
  for (const book of books) {
    if (!allowed(book.character)) continue;
    const p = person(book.character);
    for (const t of book.transits ?? []) {
      if (!inWindow(t.at)) continue;
      const r = seen(p, t.room, t.room_name);
      if (!r) continue;
      transitRecords++;
      oldestTransit = Math.min(oldestTransit ?? t.at, t.at);
      p.crossings++; r.crossings++;
      r[t.ok === true ? 'successful' : t.ok === false ? 'failed' : 'unknown']++;
      if (t.ok === true) seen(p, t.to, t.to_name);
      // A failed intended destination is not the room the character reached.
      if (t.landed_in != null) seen(p, t.landed_in);
      const collisions = (t.refusals ?? []).filter(x => /collision/i.test(x.why ?? x.reason ?? '')).length;
      const issue = t.ok === false || (t.refusals?.length ?? 0) > 0 || t.tried > 1;
      if (issue) { p.issues++; r.issues++; }
      p.collisions += collisions; r.collisions += collisions;
      if (finite(t.ms) && t.ms >= 0) { r.ms += t.ms; r.times.push(t.ms); }
    }
  }
  // Overlapping watchdog observations describe the same time stuck. Union them;
  // summing the age of a repeated wedge would multiply its cost on every retry.
  for (const { p, r, spans } of intervals.values()) {
    spans.sort((a, b) => a[0] - b[0]);
    let start = null, end = null;
    const flush = () => { if (start !== null) { p.stuck_ms += end - start; r.stuck_ms += end - start; r.stuck_episodes++; } };
    for (const [a, b] of spans) {
      if (start === null) { start = a; end = b; }
      else if (a <= end) end = Math.max(end, b);
      else { flush(); start = a; end = b; }
    }
    flush();
  }
  const rows = [...people.values()].map(p => ({ ...p, maps: p.maps.size,
    method_types: Object.values(p.methods).filter(n => n > 0).length }))
    .sort((a, b) => b.journeys - a.journeys || a.character.localeCompare(b.character));
  const rooms = [...maps.values()].map(r => {
    const sorted = r.times.sort((a, b) => a - b);
    return { ...r, characters: r.characters.size, times: undefined,
      issue_rate: r.crossings ? r.issues / r.crossings : null,
      median_ms: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
      p90_ms: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .9))] : null };
  }).sort((a, b) => b.crossings - a.crossings || a.room - b.room);
  return { characters: rows, maps: rooms, transitRecords, oldestTransit,
    cleanBusy: rooms.filter(r => r.crossings >= 5 && r.unknown === 0 && r.issues === 0 && r.stuck_ms === 0)[0] ?? null };
}
