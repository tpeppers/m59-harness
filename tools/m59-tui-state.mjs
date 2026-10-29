// Pure normalization for the terminal fleet board.
//
// Broker fleet rows intentionally keep common fields flat, while a keeper's operational
// detail is a nested status object.  The TUI historically put `/mode` under `ap` and then
// tried to read deaths/walls/threat from it; those fields were never there.  Keeping this
// merge pure makes that contract testable without starting an interactive terminal.

import { REFILL_ROOMS } from './m59-chalice.mjs';

const finite = v => Number.isFinite(Number(v)) ? Number(v) : null;

// THE CUP IN THE PACK, BY EXACT NAME. "fake chalice", "model chalice of the rain" and "The
// Emperor's Chalice" are other items (reports/chalice-of-the-rain.md, look-alikes), so a
// /chalice/ match would colour a museum ornament green. null when the keeper did not send a
// pack: not carrying one and not knowing are different answers.
export const CHALICE_NAME = 'chalice of the rain';
export function cupsIn(items) {
  if (!Array.isArray(items)) return null;
  return items
    .filter(o => String(o?.name ?? '').trim().toLowerCase() === CHALICE_NAME && o.id > 0)
    .map(o => o.id);
}

export function mergeTuiRow(row = {}, keeper = null) {
  const remote = keeper?.autopilot_status ?? null;
  const compact = row.autopilot ?? {};
  const remoteDid = remote?.did ?? {};
  const deaths24h = finite(row.deaths_24h) ?? 0;
  const deathsRun = finite(row.deaths_since_keeper_start) ??
    finite(row.deaths) ?? finite(remoteDid.deaths) ?? 0;
  const ap = {
    ...compact,
    ...(remote ?? {}),
    running: keeper?.goap?.running ?? remote?.running ?? compact.running ?? false,
    mode: keeper?.goap?.mode ?? remote?.mode ?? compact.mode ?? null,
    activity: remote?.activity ?? row.activity ?? null,
    policy: remote?.policy ?? row.policy ?? null,
    did: {
      ...remoteDid,
      kills: finite(row.kills) ?? finite(remoteDid.kills) ?? finite(compact.kills) ?? 0,
      kills_30m: finite(row.kills_30m) ?? finite(remoteDid.kills_30m) ??
        finite(compact.kills_30m) ?? 0,
      deaths: deathsRun,
      deaths_24h: deaths24h,
      deaths_in_safe_spot: finite(row.deaths_in_safe_spot) ??
        finite(remoteDid.deaths_in_safe_spot) ?? 0,
      deaths_in_proven_safe_spot: finite(row.deaths_in_proven_safe_spot) ??
        finite(remoteDid.deaths_in_proven_safe_spot) ?? 0,
      mulligans: finite(row.mulligans) ?? finite(remoteDid.mulligans) ?? 0,
      logoffs: finite(row.logoffs) ?? finite(remoteDid.logoffs) ?? 0,
    },
    last_death: remote?.last_death ?? row.last_death ?? null,
  };

  // Prefer the broker's age because an explicit fleet refresh accounts for both cache
  // layers.  Direct keeper state is the fallback when an older broker does not expose it.
  const directAge = finite(keeper?.as_of_ms);
  const brokerAge = finite(row.snapshot_age_ms);
  return {
    ...row,
    ap,
    snapshot_age_ms: brokerAge ?? directAge,
    keeper_port: keeper?.__port ?? null,
    cups: cupsIn(keeper?.items),
  };
}

export const cupKey = (agent, id) => `${agent}:${id}`;

// THE c OF w/f/c+: CAN THIS CHARACTER ESCAPE BY CHALICE WITHOUT DESTROYING THE CUP.
//
// A "safe" cup is one with at least two sips under EVERY reading of its water level: the last
// sip deletes it (chalice.kod:189), and "a few sips" is one sip on a three-cup, so the prose
// alone is not proof of two (m59-rescue.mjs `expendable`). `levels` maps cupKey(agent, id) to
// `{ safe: true | false | null }`; null and absent are both "not read yet".
//
//   held     a safe cup is in my own pack                                   green
//   room     not in mine, but an in-game fleet-mate in my room holds one     yellow
//   none     nobody here holds one, and every cup here has been read         red
//   unknown  a pack or a water level that would decide it is not known yet   dim
//
// Rooms are compared by `room_num`, the map's own number, never the live room object id,
// which is renumbered on every save. `refill` is the + : a cup dropped and picked up here
// comes back full, because the room is forest or jungle (GetShalilleBonus > 20).
export function chaliceMarks(rows = [], levels = new Map(), refillRooms = REFILL_ROOMS) {
  const safety = (agent, cups) => {
    if (cups == null) return null;
    const read = cups.map(id => levels.get(cupKey(agent, id))?.safe ?? null);
    return read.includes(true) ? true : read.includes(null) ? null : false;
  };
  const here = r => r.in_game !== false && Number.isInteger(r.room_num) && r.room_num > 0;
  const out = new Map();
  for (const r of rows) {
    const refill = Number.isInteger(r.room_num) && refillRooms.has(r.room_num);
    if (!here(r)) { out.set(r.agent, { cup: 'unknown', refill }); continue; }
    const mine = safety(r.agent, r.cups);
    if (mine === true) { out.set(r.agent, { cup: 'held', refill }); continue; }
    const mates = rows.filter(m => m !== r && here(m) && m.room_num === r.room_num)
      .map(m => safety(m.agent, m.cups));
    const cup = mates.includes(true) ? 'room'
      : mine === null || mates.includes(null) ? 'unknown' : 'none';
    out.set(r.agent, { cup, refill });
  }
  return out;
}

// THE ZONE COLUMN: "52 - Familiars". The number first because names are not unique — twenty-two
// of them name more than one room — and the name because nobody remembers what 2154 is.
export function zoneLabel(row = {}) {
  if (row.in_game === false) return '—';
  const num = Number.isInteger(row.room_num) ? row.room_num : null;
  const name = row.room ? String(row.room) : null;
  if (num == null && name == null) return '—';
  return num == null ? `? - ${name}` : name == null ? String(num) : `${num} - ${name}`;
}

export function fleetFreshness(rows = [], staleAfterMs = 10_000) {
  const ages = rows.map(r => finite(r.snapshot_age_ms)).filter(v => v != null);
  const unknown = rows.length - ages.length;
  const stale = rows.filter(r => {
    const age = finite(r.snapshot_age_ms);
    return age != null && age > staleAfterMs;
  });
  return {
    known: ages.length,
    unknown,
    stale,
    max_age_ms: ages.length ? Math.max(...ages) : null,
  };
}

