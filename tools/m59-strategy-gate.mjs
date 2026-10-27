// A FARMING STRATEGY SAYS WHAT A BODY NEEDS, AND HOW MUCH IT MUST KILL TO BE WORTH KEEPING.
//
//   requires: { magicWeapon: true, items: ['purple mushroom'], request: { service: 'dedicate' } }
//   floor:    { kills: 1, minutes: 30 }
//
// Operator, 2026-10-26, of a troll crew that ground Ukgoth for six hours with weapons that could not
// hurt a troll: that "should be at-worst a bounce-back of 'cannot be assigned without a way to get weapons
// dedicated' if it was going to end up sitting for 6 hours waiting". Two halves, because the first one will
// not catch everything:
//
//   REQUIRES is checked when the strategy is ASSIGNED (the broker refuses it, naming what is missing, unless
//   the call says accept: ["requires_unmet"]) and on every pass after (a weapon breaks, an enchantment
//   lapses). While it is unmet the farm STANDS DOWN: no quarry is chosen, survival is untouched, and if the
//   file names a `request` the fleet's service board is asked for it (tools/rpg/requests.mjs), so the desk
//   that can fix it hears about it without anybody reading a status line.
//
//   THE FLOOR is the catch-all. Every `minutes` of FARMING time (passes that reached the hunt; resting in an
//   inn under a lockdown is not farming) must contain at least `kills` kills, or the farm stands down and
//   says why. It catches the weapon case and every case nobody has thought of yet: a room that stopped
//   spawning, a quarry that is out of reach, a pull that never lands. It is per file and off by default
//   (silence is the old behaviour). It is persisted per character (substrate/.strategy-floor/), so a keeper
//   restart or handoff neither forgives a tripped floor nor restarts the clock. Re-assigning the strategy,
//   or editing its file, is how an operator says "try again".
//
// Pure apart from the floor's small store. No client, no keeper.
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FLOOR_DIR = process.env.M59_STRATEGY_FLOOR_DIR || join(HERE, '..', 'substrate', '.strategy-floor');
// A gap longer than this between two farming passes is not farming (the keeper was resting, travelling,
// held, or down), so it is not added to the clock.
export const FARMING_GAP_MS = 120_000;

const REQUIRE_KEYS = ['magicWeapon', 'items', 'request'];
const DEFAULT_REQUEST = { magicWeapon: 'dedicate' };

/** Validate `requires`. Throws with the reason; returns the normal form or null. */
export function normalizeRequires(v) {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('requires must be an object such as { magicWeapon: true }');
  const bad = Object.keys(v).filter(k => !REQUIRE_KEYS.includes(k));
  if (bad.length) throw new Error(`requires: ${bad.join(', ')} not known (known: ${REQUIRE_KEYS.join(', ')})`);
  const out = {};
  if (v.magicWeapon !== undefined) {
    if (typeof v.magicWeapon !== 'boolean') throw new Error('requires.magicWeapon must be true or false');
    if (v.magicWeapon) out.magicWeapon = true;
  }
  if (v.items !== undefined) {
    if (!Array.isArray(v.items) || !v.items.length || v.items.some(x => typeof x !== 'string' || !x.trim()))
      throw new Error('requires.items must be a non-empty list of item names');
    out.items = [...new Set(v.items.map(x => x.trim().toLowerCase()))];
  }
  if (v.request !== undefined && v.request !== null) {
    const r = typeof v.request === 'string' ? { service: v.request } : v.request;
    if (!r || typeof r !== 'object' || typeof r.service !== 'string' || !r.service.trim())
      throw new Error('requires.request must name a service, e.g. { service: "dedicate" }');
    const ttl = r.ttl_min == null ? 15 : Number(r.ttl_min);
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > 240) throw new Error('requires.request.ttl_min must be 1..240');
    out.request = { service: r.service.trim().toLowerCase(), ttl_min: ttl };
  } else if (v.request === null) out.request = null;
  if (!out.magicWeapon && !out.items) throw new Error('requires names nothing to check (magicWeapon or items)');
  return out;
}

/** Validate `floor`. Throws with the reason; returns the normal form or null. */
export function normalizeFloor(v) {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('floor must be { kills, minutes }');
  const bad = Object.keys(v).filter(k => !['kills', 'minutes'].includes(k));
  if (bad.length) throw new Error(`floor: ${bad.join(', ')} not known (kills, minutes)`);
  const kills = Number(v.kills ?? 1), minutes = Number(v.minutes);
  if (!Number.isInteger(kills) || kills < 1 || kills > 1000) throw new Error('floor.kills must be a whole number from 1');
  if (!Number.isFinite(minutes) || minutes < 5 || minutes > 720) throw new Error('floor.minutes must be from 5 to 720');
  return { kills, minutes };
}

/**
 * Does this body meet the file's requirements?
 *   facts: { weapons: [{ name, bypasses_nonmagic: true|false|null, broken }], pack: [name] }
 *   -> { met: true | false | null, unmet: [{ need, why }], unknown: [{ need, why }] }
 * `met: null` means it cannot be told yet (the weapons have not been read since the keeper started): that is
 * not a pass and not a refusal, and is reported as unknown.
 */
export function requiresVerdict(req, facts = {}) {
  const unmet = [], unknown = [];
  if (!req) return { met: true, unmet, unknown };
  if (req.magicWeapon) {
    const ws = Array.isArray(facts.weapons) ? facts.weapons : null;
    if (!ws) unknown.push({ need: 'magicWeapon', why: 'the keeper has not reported its weapons' });
    else {
      const usable = ws.filter(w => !w.broken);
      if (usable.some(w => w.bypasses_nonmagic === true)) { /* met */ }
      else if (usable.some(w => w.bypasses_nonmagic == null))
        unknown.push({ need: 'magicWeapon', why: `${usable.filter(w => w.bypasses_nonmagic == null).length} weapon(s) not read yet` });
      else unmet.push({ need: 'magicWeapon', why: usable.length
        ? `none of ${usable.length} weapon(s) carried is magic (${usable.map(w => w.name).filter(Boolean).join(', ')})`
        : 'no usable weapon is carried' });
    }
  }
  if (req.items) {
    const pack = Array.isArray(facts.pack) ? facts.pack.map(n => String(n).toLowerCase()) : null;
    if (!pack) unknown.push({ need: 'items', why: 'the pack has not been read' });
    else {
      const missing = req.items.filter(i => !pack.some(p => p === i || p.includes(i)));
      if (missing.length) unmet.push({ need: 'items', why: `not carried: ${missing.join(', ')}` });
    }
  }
  return { met: unmet.length ? false : unknown.length ? null : true, unmet, unknown };
}

/** The service to ask the board for while a requirement is unmet, or null. */
export function requestFor(req, verdict) {
  if (!req || verdict?.met !== false) return null;
  if (req.request === null) return null;
  if (req.request) return req.request;
  for (const u of verdict.unmet) if (DEFAULT_REQUEST[u.need]) return { service: DEFAULT_REQUEST[u.need], ttl_min: 15 };
  return null;
}

/** Facts for requiresVerdict from a keeper's autopilot_status (the broker's view of a keeper-backed body). */
export function factsFromStatus(st, pack = null) {
  const wm = st?.weapon_magic;
  return { weapons: Array.isArray(wm?.weapons) ? wm.weapons : null, pack: Array.isArray(pack) ? pack : null };
}

// ------------------------------------------------------------------------------------ the floor's store
const safe = a => String(a ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
export function fileStore(dir = FLOOR_DIR) {
  const path = agent => join(dir, `${safe(agent)}.json`);
  return {
    read(agent) { try { return JSON.parse(readFileSync(path(agent), 'utf8')); } catch { return null; } },
    write(agent, obj) {
      try {
        mkdirSync(dir, { recursive: true });
        const p = path(agent), tmp = `${p}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(obj) + '\n'); renameSync(tmp, p);
      } catch { /* a floor that cannot persist still works for this process */ }
    },
    clear(agent) { try { unlinkSync(path(agent)); } catch {} },
  };
}
/** Forget a character's floor (the broker calls this when a strategy is assigned: "try again"). */
export function resetFloor(agent, store = fileStore()) { store.clear(agent); }

/**
 * The kill-rate floor for one character running one strategy. The clock advances only on farming passes
 * (`farming(now)`), a kill is `kill(now)`, and a window of `minutes` farming minutes with fewer than `kills`
 * kills TRIPS it. A tripped floor stays tripped until the strategy is re-assigned or its file changes.
 */
export class KillFloor {
  constructor({ floor, agent, strategy, version = null, store = fileStore(), now = Date.now() }) {
    this.floor = floor; this.agent = agent; this.strategy = strategy; this.version = version; this.store = store;
    const saved = store.read(agent);
    const same = saved && saved.strategy === strategy && saved.version === version
      && saved.kills_per === floor.kills && saved.minutes === floor.minutes;
    this.st = same ? saved : { strategy, version, kills_per: floor.kills, minutes: floor.minutes,
      window_ms: 0, window_kills: 0, total_kills: 0, last_kill_at: null, last_farm_at: null, tripped: null, since: now };
    this.st.last_farm_at = null;           // a new process never counts the gap since the old one
    this.savedAt = 0;
    if (!same) this.save(now, true);
  }

  save(now, force = false) {
    if (!force && now - this.savedAt < 30_000) return;
    this.savedAt = now;
    this.store.write(this.agent, this.st);
  }

  farming(now = Date.now()) {
    const st = this.st;
    if (st.tripped) return this.state(now);
    if (st.last_farm_at != null) {
      const dt = now - st.last_farm_at;
      if (dt > 0 && dt <= FARMING_GAP_MS) st.window_ms += dt;
    }
    st.last_farm_at = now;
    if (st.window_ms >= this.floor.minutes * 60_000) {
      if (st.window_kills < this.floor.kills) {
        st.tripped = { at: now, kills: st.window_kills, minutes: this.floor.minutes,
          why: `${st.window_kills} kill(s) in ${this.floor.minutes} farming minutes, under the floor of ${this.floor.kills}` };
        this.save(now, true);
        return this.state(now);
      }
      st.window_ms = 0; st.window_kills = 0;
    }
    this.save(now);
    return this.state(now);
  }

  kill(now = Date.now()) {
    const st = this.st;
    st.window_kills++; st.total_kills++; st.last_kill_at = now;
    this.save(now, true);
  }

  state(now = Date.now()) {
    const st = this.st;
    return { kills: this.floor.kills, minutes: this.floor.minutes,
      window_farming_min: Math.round(st.window_ms / 6000) / 10, window_kills: st.window_kills,
      total_kills: st.total_kills, last_kill_ago_min: st.last_kill_at ? Math.round((now - st.last_kill_at) / 6000) / 10 : null,
      tripped: st.tripped };
  }
}
