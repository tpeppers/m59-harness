// Observed spell objects, not baked scenery. Source: Meridian59 kod/object/
// active/wallelem{,/wallfire,/wallltng,/poisfogc}.kod and passive/{fogcloud,
// psporec,shrinfog}.kod. Wall elements affect their own square (piRange=0).
// Caster, immunity, spell power and expiry are NOT carried by these objects.
import { OF, MOVEON, moveOn } from './m59-parse.mjs';

export function groundEffect(object, lookup = () => null) {
  if (!object || (object.flags & (OF.PLAYER | OF.GETTABLE))) return null;
  const name = String(lookup(object.nameRsc) ?? object.name ?? '').trim();
  const icon = String(lookup(object.icon) ?? object.icon_file ?? '').toLowerCase();
  const notify = moveOn(object.flags ?? 0) === MOVEON.NOTIFY;
  let kind, harmful = true, certainty = 'known', radius = 0, avoidRadius = 0, periodic = null;
  if (/^(wall of fire|firewall)$/i.test(name) || /(?:^|[\\/])woflame\.bgf$/.test(icon)) kind = 'firewall';
  else if (/^wall of lightning$/i.test(name) || /(?:^|[\\/])wolightn\.bgf$/.test(icon)) kind = 'lightning_wall';
  else if (/^web$/i.test(name) || /(?:^|[\\/])webspell\.bgf$/.test(icon)) { kind = 'web'; periodic = false; }
  else if (/^patch of bramble$/i.test(name)) kind = 'brambles';
  else if (/^(thick fog|poison fog|acidic fog)$/i.test(name) || /(?:^|[\\/])poisoncl\.bgf$/.test(icon)) {
    kind = notify ? 'poison_or_spore_cloud' : 'fog';
    // ActiveSporeCloud is wire-identical to PoisonFogCloud. SporeBurst bounds
    // its range to 1..3; reserve the possible area, without claiming its radius.
    if (notify) { radius = null; avoidRadius = 3; certainty = 'ambiguous'; }
    // Ordinary fog, spores and poison share appearance. Do not invent immunity.
    if (!notify) { harmful = null; certainty = 'ambiguous'; }
  } else if (notify && (object.flags & OF.NOEXAMINE) && !(object.flags & OF.ATTACKABLE)) {
    kind = 'unknown_ground_effect'; harmful = null; certainty = 'unknown'; radius = null;
  } else return null;
  if (!Number.isFinite(object.row) || !Number.isFinite(object.col)) return null;
  return { id: object.id, kind, name, row: object.row, col: object.col,
    radius, avoid_radius: avoidRadius, harmful, avoid: harmful !== false, certainty,
    caster: null, expires_at: null, immunity: 'unknown',
    periodic: ['firewall', 'lightning_wall', 'brambles'].includes(kind) ? true : periodic };
}

export function groundEffects(client) {
  const lookup = id => client?.rsc?.get?.(id);
  return [...(client?.room?.objects?.values?.() ?? [])]
    .map(o => groundEffect(o, lookup)).filter(Boolean);
}

export function groundEffectSquares(client) {
  const squares = new Set();
  for (const effect of groundEffects(client)) if (effect.avoid)
    for (let dr = -effect.avoid_radius; dr <= effect.avoid_radius; dr++)
      for (let dc = -effect.avoid_radius; dc <= effect.avoid_radius; dc++)
        if (Math.hypot(dr, dc) <= effect.avoid_radius) squares.add(`${effect.row + dr},${effect.col + dc}`);
  return squares;
}

export function effectsAt(client, point) {
  return groundEffects(client).filter(e => e.avoid &&
    Math.hypot(e.row - point?.row, e.col - point?.col) <= e.avoid_radius);
}

// Segment/square intersection in protocol fine coordinates. Checking only the
// endpoint lets a coalesced move jump across a firewall. A body already in an
// effect may leave it; it may not enter a different effect on the way out.
export function groundEffectOnSegment(client, from, to) {
  if (!from || !to) return null;
  const a = { x: from.x ?? from.col * 64 + 32, y: from.y ?? from.row * 64 + 32 };
  const b = { x: to.x ?? to.col * 64 + 32, y: to.y ?? to.row * 64 + 32 };
  if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return null;
  for (const effect of groundEffects(client)) {
    if (!effect.avoid) continue;
    if (effect.avoid_radius > 0) {
      const fromDistance = Math.hypot(Math.floor(a.y / 64) - effect.row, Math.floor(a.x / 64) - effect.col);
      const toDistance = Math.hypot(Math.floor(b.y / 64) - effect.row, Math.floor(b.x / 64) - effect.col);
      const cx = effect.col * 64 + 32, cy = effect.row * 64 + 32;
      const outward = (a.x - cx) * (b.x - a.x) + (a.y - cy) * (b.y - a.y) >= 0;
      if (fromDistance <= effect.avoid_radius && toDistance > fromDistance && outward) continue;
      for (let dr = -effect.avoid_radius; dr <= effect.avoid_radius; dr++)
        for (let dc = -effect.avoid_radius; dc <= effect.avoid_radius; dc++) {
          if (Math.hypot(dr, dc) > effect.avoid_radius) continue;
          const tile = { ...effect, row: effect.row + dr, col: effect.col + dc, avoid_radius: 0 };
          if (intersectsTile(a, b, tile)) return effect;
        }
      continue;
    }
    const inside = p => Math.floor(p.x / 64) === effect.col && Math.floor(p.y / 64) === effect.row;
    if (inside(a) && !inside(b)) continue;
    if (intersectsTile(a, b, effect)) return effect;
  }
  return null;
}

function intersectsTile(a, b, effect) {
    let low = 0, high = 1;
    for (const [axis, square] of [['x', effect.col], ['y', effect.row]]) {
      const start = square * 64, end = start + 64 - 1e-7, d = b[axis] - a[axis];
      if (d === 0) { if (a[axis] < start || a[axis] > end) { high = -1; break; } }
      else {
        const t1 = (start - a[axis]) / d, t2 = (end - a[axis]) / d;
        low = Math.max(low, Math.min(t1, t2)); high = Math.min(high, Math.max(t1, t2));
      }
    }
    return low <= high;
}
