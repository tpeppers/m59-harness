import {classifyCombatLine} from './m59-combatlog.mjs';

const key = name => String(name ?? '').trim().toLowerCase();

// Prose names an attacker but carries no object id. Only a unique visible name
// can establish that the selected body, rather than its namesake, retaliated.
export function blockerRetaliated(lines, name, names) {
  if (names.filter(n => key(n) === key(name)).length !== 1) return false;
  return lines.some(line => {
    const swing = classifyCombatLine(line);
    return swing?.kind === 'enemy-swing' && !swing.loose && key(swing.other) === key(name);
  });
}

// This filter is additional to the normal safe-wall, player path, occupancy and
// return-route tests. Coarse geometry here describes MONSTER staging only.
export function lureRefugeFilter(geo, origin, blocker, quarryReach) {
  const dc = blocker.col - origin.col, dr = blocker.row - origin.row;
  if (!Number.isFinite(dc + dr) || Math.hypot(dc, dr) < 0.25 || !quarryReach) return () => false;
  const linked = (a, b) => geo.openDirections(a.row, a.col, {fine:false})
    .some(d => a.row + d.dr === b.row && a.col + d.dc === b.col);
  return (col, row) => {
    if (Math.hypot(col-origin.col, row-origin.row) < 4
        || (col-origin.col)*dc + (row-origin.row)*dr >= 0) return false;
    const reach = quarryReach(col, row);
    if (!reach?.reachable || !reach.attack_position) return false;
    const p = reach.attack_position;
    if (Math.hypot(p.col-origin.col, p.row-origin.row) < 3) return false;
    // A connected, bidirectional 2x2 landing beside the refuge gives the chasing
    // body somewhere to stand outside a one-body-wide needle.
    for (const rr of [p.row-1,p.row]) for (const cc of [p.col-1,p.col]) {
      const cells = [{row:rr,col:cc},{row:rr,col:cc+1},
        {row:rr+1,col:cc+1},{row:rr+1,col:cc}];
      if (!cells.every(q => geo.walkable(q.row,q.col))) continue;
      if (cells.every((q,i) => linked(q,cells[(i+1)%4]) && linked(cells[(i+1)%4],q))) return true;
    }
    return false;
  };
}
