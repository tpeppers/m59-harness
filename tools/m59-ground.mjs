// WHAT IS UNDER THIS BODY, AND CAN IT GET THERE FROM HERE — one command, no node -e block.
//
//   node tools/m59-ground.mjs hk2                     the ground under it, and every heading
//   node tools/m59-ground.mjs hk2 --to r27c20         ...and whether that square is reachable
//   node tools/m59-ground.mjs hk2 --to r27c20 --json
//   node tools/m59-ground.mjs --room 49 --at r23c17   a square, with no body involved
//
// WHY THIS EXISTS. Debugging one failed rail leg took six steps and every one was a hand-rolled
// `node -e` block with its own unit conversion: read the reply whole, convert protocol to client,
// ask the BSP for the floor at the EXACT point, trace the leg as one line and then stepped, test
// eight headings at three reaches, flood the room and ask whether the goal is in the component.
// I ran that sequence about a dozen times in one night. It is a tool.
//
// EVERY VERDICT STATES ITS OWN LIMITS, which is the lesson the night actually taught:
//
//   * REACHABILITY IS A CLAIM ABOUT A SEED, A LATTICE AND A PHASE — never about the world. A
//     64-unit flood from x = 17648 (48 mod 64) can never land on a goal at x = 0 mod 64: the grids
//     are offset for ever. That reported "goal NOT reached after 165,104 points", which reads
//     exactly like "the exit is unreachable" and would have been filed as a fact about the
//     Badlands. So the phase is printed beside the verdict, and the seed is snapped.
//   * A SQUARE IS A SUMMARY. r23c17's centre was 363 units from the body standing in it, and one
//     square in Kardde's Canyon holds four floors (3840, 6016, 6144, 6400). So this samples the
//     square finely and lists every floor in it, rather than quoting one number.
//   * THE EDGE TEST IS THE MOVER'S OWN. `traceFineMoveClient`, reached through the same geometry
//     the broker enforces, never a re-derivation — a debugging view that computes its own
//     collision is a second opinion about the map rather than a look at the one in play.
import { readFileSync } from 'node:fs';
import { sharedRoomGeometry, MAX_STEP_HEIGHT } from './m59-roo.mjs';
import { attachStepMasks } from './m59-routes.mjs';
import { finePosition, squareCentreClient, protocolToClient } from './m59-finepos.mjs';
import { cutRail, snap, LATTICE, flood, chainTo } from './m59-railcut.mjs';

export const HEADINGS = Object.freeze([
  ['N', 0, -1], ['NE', 1, -1], ['E', 1, 0], ['SE', 1, 1],
  ['S', 0, 1], ['SW', -1, 1], ['W', -1, 0], ['NW', -1, -1],
]);
export const REACHES = Object.freeze([64, 256, 512]);

let WORLD = null;
export function roomGeometry(room, { mapPath = new URL('../substrate/m59-map.json', import.meta.url) } = {}) {
  if (!WORLD) {
    WORLD = JSON.parse(readFileSync(mapPath, 'utf8'));
    attachStepMasks(WORLD);          // measure without this and you invent cliffs
  }
  const r = WORLD.rooms?.[String(room)];
  return r ? sharedRoomGeometry(r) : null;
}

export const floorAt = (geo, x, y) => {
  try { const l = geo.leafAtClient(x, y); return l?.sector ? geo.floorBaseAtClient(x, y, l) : null; }
  catch { return null; }
};
export const edgeOf = (geo) => (a, b) => {
  // A lattice flood records b, not the slide's actual endpoint. Room 45 wall 700
  // moved the body but landed below b's shelf; accepting `moved` invented a climb.
  try { const t = geo.traceFineMoveClient(a.x, a.y, b.x, b.y); return t?.arrived === true; }
  catch { return false; }
};

/** Reproduce one failed leg at its exact fine points without moving a character. */
export function traceReport(geo, from, to, { stride = 64 } = {}) {
  if (!(Number.isFinite(stride) && stride > 0)) throw new Error('stride must be positive');
  const point = p => ({ ...p, floor_client: floorAt(geo, p.x, p.y) });
  const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / stride));
  const steps = [];
  let body = from;
  for (let i = 1; i <= n; i++) {
    const aim = { x: from.x + (to.x - from.x) * i / n, y: from.y + (to.y - from.y) * i / n };
    const trace = geo.traceFineMoveClient(body.x, body.y, aim.x, aim.y);
    const landed = Number.isFinite(trace?.x) && Number.isFinite(trace?.y)
      ? { x: trace.x, y: trace.y } : body;
    steps.push({ i, from: point(body), aim: point(aim), landed: point(landed), trace });
    if (trace?.arrived !== true) break;
    body = landed;
  }
  return { units: 'client', from: point(from), to: point(to), stride,
    arrived: steps.length === n && steps.at(-1).trace?.arrived === true,
    predicate: steps.at(-1).trace?.arrived === true ? null : (steps.at(-1).trace?.reason ?? 'trace_did_not_arrive'), steps };
}

/** A bounded, exact-arrival flood into the server's meld box; never a terrain verdict. */
export function floodReport(geo, from, to, { lattice=64, cap=1500000, box=2 }={}) {
  if(![lattice,cap].every(v=>Number.isFinite(v)&&v>0))throw Error('positive lattice and cap required');
  const seed={x:snap(from.x,lattice),y:snap(from.y,lattice)},edge=edgeOf(geo);
  const bridge=Math.hypot(seed.x-from.x,seed.y-from.y)===0||edge(from,seed);
  if(!bridge)return {reached:false,predicate:'lattice_bridge_refused',from,seed,lattice,cap};
  const parent=flood(seed,{edge,bounds:{w:geo.cols*1024,h:geo.rows*1024},lattice,cap});
  let count=0,highest=null,nearest=null,best=Infinity;
  for(const key of parent.keys()){
    const [x,y]=key.split(',').map(Number),row=Math.floor(y/1024)+1,col=Math.floor(x/1024)+1;
    const floor=floorAt(geo,x,y);if(floor!=null)highest=highest==null?floor:Math.max(highest,floor);
    const d=Math.max(Math.abs(row-to.row),Math.abs(col-to.col));
    if(d<best){best=d;nearest={x,y,row,col,floor_client:floor};}
    if(d<=box)count++;
  }
  return {reached:count>0,predicate:count?'reached_box_in_model':parent.size>=cap?'search_cap':'no_box_sample_at_this_lattice',
    from,seed,to,box,lattice,cap,visited:parent.size,reached_box_samples:count,highest_floor_client:highest,nearest,
    caveat:'Offline model, exact trace endpoints, one lattice phase; no live arrival claim.',
    ...(count?{path:chainTo(parent,nearest)}:{})};
}

/** Which headings does the mover's own trace accept from this exact point, at each reach? */
export function headingsFrom(geo, point, { reaches = REACHES } = {}) {
  const edge = edgeOf(geo);
  return reaches.map((reach) => ({
    reach,
    accepted: HEADINGS.filter(([, dx, dy]) =>
      edge(point, { x: point.x + dx * reach, y: point.y + dy * reach })).map((h) => h[0]),
    refused: HEADINGS.filter(([, dx, dy]) =>
      !edge(point, { x: point.x + dx * reach, y: point.y + dy * reach })).map((h) => h[0]),
  }));
}

/** Every floor inside a square, sampled finely — because one number is a summary and often false. */
export function floorsInSquare(geo, row, col, { step = 64 } = {}) {
  const seen = new Map();
  for (let dy = 0; dy < 1024; dy += step) {
    for (let dx = 0; dx < 1024; dx += step) {
      const f = floorAt(geo, (col - 1) * 1024 + dx, (row - 1) * 1024 + dy);
      if (f != null) seen.set(f, (seen.get(f) ?? 0) + 1);
    }
  }
  return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([floor, samples]) => ({ floor, samples }));
}

/**
 * Can this point reach that point, and on whose terms? The verdict carries the seed, the lattice
 * and the phase, because without them "not reached" is indistinguishable from "unreachable".
 */
export function reachability(geo, from, to, { lattice = LATTICE } = {}) {
  const edge = edgeOf(geo);
  const cut = cutRail(from, to, { edge, bounds: { w: geo.cols * 1024, h: geo.rows * 1024 },
                                  floorAt: (x, y) => floorAt(geo, x, y), lattice });
  const phase = { fromX: from.x % lattice, fromY: from.y % lattice,
                  toX: to.x % lattice, toY: to.y % lattice };
  return {
    reached: cut.ok, legs: cut.legs ?? null, visited: cut.visited,
    seed: cut.seed, target: cut.target, bridge: cut.bridge, bridgeWalkable: cut.bridgeOk,
    lattice, phase,
    why: cut.ok ? null : cut.why,
    // THE CAVEAT IS PART OF THE ANSWER, not a footnote.
    caveat: `a ${lattice}-unit flood from a seed at (${cut.seed?.x} mod ${lattice} = ` +
            `${(cut.seed?.x ?? 0) % lattice}) only ever visits points of that phase; the seed and ` +
            `target were snapped, and the body's own ${Math.round(cut.bridge ?? 0)}-unit bridge to ` +
            `the lattice is ${cut.bridgeOk ? 'walkable' : 'NOT walkable — the rail cannot be boarded'}`,
  };
}

const parseSquare = (s) => {
  const m = /^r(\d+)c(\d+)$/i.exec(String(s ?? '').trim());
  return m ? { row: Number(m[1]), col: Number(m[2]) } : null;
};

async function main(argv) {
  const json = argv.includes('--json');
  const arg = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : null; };
  if(argv.includes('--flood')) {
    const v=String(arg('from-client')).split(',').map(Number),to=parseSquare(arg('to'));
    if(v.length!==2||!v.every(Number.isFinite)||!to||!arg('room'))throw Error('--flood requires --room N --from-client X,Y --to rNcM');
    const r=floodReport(roomGeometry(Number(arg('room'))),{x:v[0],y:v[1]},to,
      {lattice:Number(arg('lattice')??64),cap:Number(arg('cap')??1500000),box:Number(arg('box')??2)});
    console.log(JSON.stringify(r,null,2));return r.reached?0:1;
  }
  if (arg('from-client') || arg('to-client')) {
    const parse = s => { const v = String(s).split(',').map(Number); return v.length === 2 && v.every(Number.isFinite) ? { x: v[0], y: v[1] } : null; };
    const from = parse(arg('from-client')), to = parse(arg('to-client'));
    if (!arg('room') || !from || !to) throw new Error('--room N --from-client X,Y --to-client X,Y required');
    const report = traceReport(roomGeometry(Number(arg('room'))), from, to, { stride: Number(arg('stride') ?? 64) });
    console.log(JSON.stringify(report, null, 2)); return report.arrived ? 0 : 1;
  }
  const agent = argv.find((a) => !a.startsWith('--') &&
                                 argv[argv.indexOf(a) - 1] !== '--to' &&
                                 argv[argv.indexOf(a) - 1] !== '--at' &&
                                 argv[argv.indexOf(a) - 1] !== '--room');
  const roomArg = arg('room'), atArg = arg('at'), toArg = arg('to');

  let room = roomArg ? Number(roomArg) : null;
  let point = null, square = null, who = null;

  if (atArg) {
    square = parseSquare(atArg);
    if (!square || room == null) { console.log('--at rNcM needs --room N'); return 2; }
    point = squareCentreClient(square.row, square.col);
    who = `${atArg} of room ${room} (square CENTRE — a summary)`;
  } else if (agent) {
    const pos = await finePosition(agent);
    if (!pos.ok) { console.log(`${agent}: cannot read a position — ${pos.why}`); return 1; }
    room = pos.room ?? room;
    point = pos.client; square = pos.square;
    who = `${agent}${pos.character ? ` (${pos.character})` : ''} in room ${room}`;
    if (!json) console.log(`${who} at r${square.row}c${square.col}  client (${point.x},${point.y})` +
                           `  — the square centre would be off by ${pos.centreError}u`);
  } else {
    console.log('usage: node tools/m59-ground.mjs <agent> [--to rNcM] | --room N --at rNcM');
    return 2;
  }

  const geo = roomGeometry(room);
  if (!geo) { console.log(`room ${room} is not in the bake`); return 1; }

  const out = { who, room, square, point, floor: floorAt(geo, point.x, point.y),
                floorsInSquare: floorsInSquare(geo, square.row, square.col),
                headings: headingsFrom(geo, point), maxStep: MAX_STEP_HEIGHT };

  if (toArg) {
    const t = parseSquare(toArg);
    if (!t) { console.log('--to wants rNcM'); return 2; }
    // Aim at a STANDABLE point in the target square, not its centre, for the same reason.
    let goal = null;
    for (let dy = 0; dy < 1024 && !goal; dy += 64)
      for (let dx = 0; dx < 1024; dx += 64) {
        const p = { x: (t.col - 1) * 1024 + dx, y: (t.row - 1) * 1024 + dy };
        if (floorAt(geo, p.x, p.y) != null) { goal = p; break; }
      }
    out.to = { square: t, point: goal };
    out.reachability = goal ? reachability(geo, point, goal) : { reached: false, why: 'no floor anywhere in the target square' };
  }

  if (json) { console.log(JSON.stringify(out, null, 2)); return out.reachability && !out.reachability.reached ? 1 : 0; }

  console.log(`  floor under it: ${out.floor}`);
  console.log(`  floors in r${square.row}c${square.col}: ` +
              out.floorsInSquare.map((f) => `${f.floor}x${f.samples}`).join('  ') +
              (out.floorsInSquare.length > 1 ? '   <- MORE THAN ONE: the square is a false summary here' : ''));
  console.log(`  step cap ${MAX_STEP_HEIGHT} client units`);
  for (const h of out.headings)
    console.log(`  reach ${String(h.reach).padStart(3)}u: ${h.accepted.length}/8 accepted` +
                `  [${h.accepted.join(' ') || 'none'}]` +
                (h.refused.length ? `   refused [${h.refused.join(' ')}]` : ''));
  if (out.reachability) {
    const r = out.reachability;
    console.log(`\n  to r${out.to.square.row}c${out.to.square.col}: ` +
                (r.reached ? `REACHED in ${r.legs} leg(s)` : `NOT reached — ${r.why}`) +
                `  (${r.visited} points visited)`);
    console.log(`  ${r.caveat}`);
    if (!r.reached)
      console.log(`  "not reached" is a claim about THIS seed, lattice and phase. Re-ask from a ` +
                  `different seed or a finer lattice before calling it unreachable.`);
  }
  return out.reachability && !out.reachability.reached ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('m59-ground.mjs'))
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
