// Observed spell objects, not baked scenery. Source: Meridian59 kod/object/
// active/wallelem{,/wallfire,/wallltng,/poisfogc}.kod and passive/{fogcloud,
// psporec,shrinfog}.kod. Wall elements affect their own square (piRange=0).
// Caster, immunity, spell power and expiry are NOT carried by these objects.
import { OF, MOVEON, moveOn } from './m59-parse.mjs';

// Every guild hall's `CreateHotPlates` footprint, [row, col], read off the kod
// (kod/object/active/holder/room/ghall/guildhN.kod, `lHotPlates`; the third element is the
// plate id and does not matter here). Keyed by the hall's .roo, which is how the room is known.
const PLATES = {
  guildh1: [[18,10],[17,9],[17,10],[18,9],[19,9],[19,10]],
  guildh2: [[18,29],[18,28],[17,29],[17,28],[19,29],[19,28]],
  guildh3: [[5,8],[4,8],[4,9],[5,9],[6,8],[6,9]],
  guildh4: [[43,23],[43,24],[43,25],[43,26],[43,27],[43,22],
            [42,23],[42,24],[42,25],[42,26],[42,27],[42,22]],
  guildh5: [[24,13],[24,14],[24,15],[24,20],[24,21],[24,22],[23,13],[23,14],[23,15],
            [23,20],[23,21],[23,22],[23,12],[23,16],[24,16],[24,19],[23,19],[23,23]],
  guildh6: [[11,13],[10,13],[10,14],[11,14],[12,13],[12,14]],
  guildh7: [[7,11],[6,23],[18,9],[8,12],[7,22],[18,10]],
  guildh8: [[21,8],[21,9],[21,7],[21,10],[20,8],[20,9],[20,7],[20,10]],
  guildh9: [[12,19],[12,18],[12,20],[13,18],[13,19],[13,20]],
  guildh10: [[16,11],[16,10],[15,10],[15,11],[15,12],[16,12]],
  guildh11: [[8,16],[8,15],[9,15],[9,16],[8,17],[9,17]],
  guildh12: [[37,2],[37,3],[39,4],[40,4]],
  guildh13: [[1,8],[2,8],[3,8],[4,8],[1,9],[2,9],[3,9],[4,9]],
  guildh14: [[4,28],[4,27],[4,29],[5,28],[5,27],[5,29]],
  guildh15: [[12,30],[13,30],[14,30],[12,31],[13,31],[14,31]],
};
export const GUILD_ENTRY_PLATES = Object.fromEntries(Object.entries(PLATES)
  .map(([hall, squares]) => [hall, new Set(squares.map(([r, c]) => `${r},${c}`))]));

export function groundEffect(object, lookup = () => null, { roomFile = '' } = {}) {
  if (!object || (object.flags & (OF.PLAYER | OF.GETTABLE))) return null;
  const name = String(lookup(object.nameRsc) ?? object.name ?? '').trim();
  const icon = String(lookup(object.iconRsc ?? object.icon) ?? object.icon_file ?? '').toLowerCase();
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
    // A GUILD HALL'S ENTRY SENSORS ARE NOT A HAZARD. Every guildhN.kod `CreateHotPlates` lays
    // `Hotplate` objects (MOVEON_NOTIFY | LOOK_NO, blank, "something") across its entrance, and
    // their flags/name/icon also fit the conservative unknown-spell heuristic, which then seals
    // the entrance. This used to know only guildh14 (714). The Wryn's Keep's twelve, rows 42-43
    // cols 22-27 (guildh4.kod:447), stayed `unknown_ground_effect`: the walker's avoid set was a
    // wall across the hall ON the entrance's own press squares r43c24/25, and Janice (t7, prod
    // 2026-10-01) could neither reach the press nor the exit — "coarse grid failed ... requested
    // square r43c24". Match the room resource AND the exact static footprint from the kod;
    // blank objects elsewhere remain unknown hazards, and named damaging effects above still win.
    const hallFile = /(?:^|[\\/])(guildh\d+)\.roo$/i.exec(String(roomFile))?.[1]?.toLowerCase();
    const entryPlate = !!hallFile && GUILD_ENTRY_PLATES[hallFile]?.has(`${object.row},${object.col}`) &&
      /(?:^|[\\/])blank\.bgf$/.test(icon) && /^something$/i.test(name) &&
      object.flags === (OF.NOEXAMINE | MOVEON.NOTIFY);
    if (entryPlate) { kind = 'guild_entry_trigger'; harmful = false; periodic = false; }
    else { kind = 'unknown_ground_effect'; harmful = null; certainty = 'unknown'; radius = null; }
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
    .map(o => groundEffect(o, lookup, { roomFile: lookup(client?.roomRsc) })).filter(Boolean);
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
