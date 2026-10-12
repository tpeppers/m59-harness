// Client-observed pursuit, not the server's hidden poTarget/STATE_CHASE.
// KOD can also move toward a master/ally, flee, or wander. Never certify no aggro.
import { OF } from './m59-parse.mjs';

const point = o => o && !o.predicted && Number.isFinite(o.x) && Number.isFinite(o.y);
export class MonsterAttention {
  constructor({ ttlMs = 6000 } = {}) { this.ttlMs = ttlMs; this.reset(); }
  reset() { this.rows = new Map(); this.players = new Set(); }
  remove(id) { this.rows.delete(id); this.players.delete(id); }
  reconcile(objects) {
    this.players = new Set([...objects.values()].filter(o=>o.flags&OF.PLAYER).map(o=>o.id));
    for (const [id,row] of this.rows) if (!objects.has(id) || objects.get(id).nameRsc !== row.nameRsc) this.remove(id);
  }
  move(monster, before, objects, selfId, now = Date.now()) {
    if (!(monster?.flags & OF.ATTACKABLE) || monster.flags & OF.PLAYER
        || !point(before) || !point(monster)) return;
    const dx = monster.x - before.x, dy = monster.y - before.y, length = Math.hypot(dx, dy);
    if (length < 4 || length > 128) return; // stillness and discontinuities prove nothing
    let row = this.rows.get(monster.id);
    if (!row || row.nameRsc !== monster.nameRsc || now - row.at > this.ttlMs)
      row = { samples: [], at: now, nameRsc: monster.nameRsc };
    const candidates = [];
    this.players = new Set([...objects.values()].filter(o=>o.flags&OF.PLAYER).map(o=>o.id));
    for (const player of objects.values()) {
      if (!(player.flags & OF.PLAYER) && player.id !== selfId || !point(player)
          || now - (player.posAt ?? 0) > this.ttlMs) continue;
      const vx = player.x - before.x, vy = player.y - before.y, distance = Math.hypot(vx, vy);
      if (distance < 16 || distance > 12 * 64) continue;
      const alignment = (dx * vx + dy * vy) / (length * distance);
      const closing = distance - Math.hypot(player.x - monster.x, player.y - monster.y);
      if (alignment >= 0.75 && closing >= Math.min(4, length / 2)) candidates.push(player.id);
    }
    // Each packet contributes once, including moves away from all observed players.
    row.samples.push({ at: now, candidates });
    row.samples = row.samples.filter(s => now - s.at <= this.ttlMs).slice(-8);
    row.at = now; this.rows.set(monster.id, row);
  }
  view(id, selfId, now = Date.now()) {
    const row = this.rows.get(id), samples = row?.samples.filter(s => now - s.at <= this.ttlMs) ?? [];
    const counts = new Map();
    for (const sample of samples) for (const player of sample.candidates)
      counts.set(player, (counts.get(player) ?? 0) + 1);
    const targets = [...counts].filter(([, n]) => n >= 3 && n / samples.length >= 0.75)
      .map(([player_id, n]) => ({ player_id, closing_samples: n }));
    const enoughTime = samples.length >= 3 && samples.at(-1).at - samples[0].at >= 500;
    const plausible = enoughTime ? targets : [];
    const unique = plausible.length === 1 ? plausible[0].player_id : null;
    return { aggro_at_me: unique === selfId ? true : null,
      aggro_any: plausible.length ? true : null,
      players: [...new Set([...this.players,selfId])].filter(id=>id!=null).map(player_id=>({player_id,
        closing_samples:counts.get(player_id)??0,aggro_at_player:unique===player_id?true:null})),
      confidence: unique != null ? 'inferred' : plausible.length ? 'ambiguous' : 'unknown',
      basis: 'repeated server-observed movement toward fresh, confirmed player positions; hidden target not transmitted',
      observed_at: row?.at ?? null, samples: samples.length };
  }
}
