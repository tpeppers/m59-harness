// The third way out of a room, and the one that is invisible to every other tool.
//
// There are not two exit mechanisms in this game, there are three:
//
//   plEdge_Exits   walking past the row/col bounds        — data, in the room object
//   plExits        standing on an exact square and `go`   — data, in the room object
//   SomethingMoved a room class overriding the move hook  — CODE, in the .kod file
//
// The third is the one that bit. Marion has no plEdge_Exits at all and its plExits
// are four shops and a locked crypt gate, so every data source — the maintenance
// socket, the map build, the room object itself — agrees the town has no way out.
// It has two. They are written as coordinate tests in an overridden SomethingMoved:
//
//    if (new_row < 32) and (new_col > 66)   -> RID_C4      % the northeast sliver
//    if (new_row > 83) and (new_col > 48)   -> RID_C5      % the southeast sliver
//
// Walk into either corner of the square and the room hands you to its neighbour.
// Nothing about that is discoverable at runtime short of walking every square, which
// is why twenty-three characters sat in a town that data said was sealed.
//
// So: read the source. For each room class, find the SomethingMoved override, pull
// out every branch that ends in a jump to a DIFFERENT room, and record the condition
// that triggers it. The geometry can then turn a condition into a square to walk to.
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// RID_FOO = 534 out of blakston.khd, so a branch naming RID_C4 becomes room 534.
export function loadRids(khdPath) {
  const rids = new Map();
  for (const line of readFileSync(khdPath, 'utf8').split('\n')) {
    const m = /^\s*(RID_[A-Z0-9_]+)\s*=\s*(\d+)/.exec(line);
    if (m) rids.set(m[1], Number(m[2]));
  }
  return rids;
}

// Pull one method body out of a kod class by brace matching.
function methodBody(src, name) {
  const at = src.search(new RegExp('^\\s*' + name + '\\s*\\(', 'm'));
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(open + 1, i); }
  }
  return null;
}

// "(new_row < 32) and (new_col > 66)" -> [{axis:'row',op:'<',value:32}, ...]
function parseCondition(text) {
  const out = [];
  const re = /new_(row|col)\s*(<=|>=|<|>|=)\s*(\d+)/g;
  let m;
  while ((m = re.exec(text))) out.push({ axis: m[1], op: m[2] === '=' ? '==' : m[2], value: Number(m[3]) });
  return out;
}

// Every branch of SomethingMoved that hands the mover to another room.
export function codeExitsFor(src, rids) {
  const body = methodBody(src, 'SomethingMoved');
  if (!body) return [];
  const out = [];
  // Each `if (...) { ... }` at any depth; brace-match the consequent so nested
  // blocks do not truncate it.
  const ifRe = /\bif\s*([^{]*?)\s*\{/g;
  let m;
  while ((m = ifRe.exec(body))) {
    const cond = parseCondition(m[1]);
    if (!cond.length) continue;
    let depth = 1, i = m.index + m[0].length;
    for (; i < body.length && depth; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') depth--;
    }
    const block = body.slice(m.index + m[0].length, i);
    const rid = /FindRoomByNum\s*,?\s*#num\s*=\s*(RID_[A-Z0-9_]+)/.exec(block);
    if (!rid) continue;                       // #where=self is a nudge, not an exit
    const to = rids.get(rid[1]);
    if (to == null) continue;
    const arrive = /#new_row\s*=\s*(\d+)\s*,\s*#new_col\s*=\s*(\d+)/.exec(block);
    out.push({
      to, rid: rid[1], when: cond,
      arrive: arrive ? { row: Number(arrive[1]), col: Number(arrive[2]) } : null,
    });
  }
  return out;
}

const satisfies = (c, row, col) => {
  const v = c.axis === 'row' ? row : col;
  return c.op === '<' ? v < c.value : c.op === '>' ? v > c.value
       : c.op === '<=' ? v <= c.value : c.op === '>=' ? v >= c.value : v === c.value;
};

// Equality tests on the SAME axis are alternatives, not conjunctions. The source
// writes a two-square-wide doorway as `(new_col = 46) or (new_col = 47)`, and
// flattening that into an AND makes the region empty — the exit then looks like it
// exists but can never be stood in, which is worse than not knowing about it.
// Inequalities on one axis still AND together: `row > 14` and `row < 18` is a band.
export const inRegion = (when, row, col) => {
  for (const axis of ['row', 'col']) {
    const cs = when.filter(c => c.axis === axis);
    if (!cs.length) continue;
    const eqs = cs.filter(c => c.op === '==');
    const ineqs = cs.filter(c => c.op !== '==');
    if (eqs.length && !eqs.some(c => satisfies(c, row, col))) return false;
    if (ineqs.length && !ineqs.every(c => satisfies(c, row, col))) return false;
  }
  return true;
};

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.kod')) out.push(p);
  }
  return out;
}

// Scan every room class and index the result by room number.
export function buildCodeExits({ kodRoot, mapFile, outFile }) {
  const rids = loadRids(join(kodRoot, 'include', 'blakston.khd'));
  const map = JSON.parse(readFileSync(mapFile, 'utf8'));
  const byCls = new Map();
  for (const r of Object.values(map.rooms)) if (r.cls) byCls.set(r.cls.toLowerCase(), r);

  const found = {};
  let scanned = 0, unmatched = [];
  for (const file of walk(join(kodRoot, 'object', 'active', 'holder', 'room'))) {
    const src = readFileSync(file, 'utf8');
    const cls = /^\s*([A-Za-z0-9_]+)\s+is\s+[A-Za-z0-9_]+/m.exec(src)?.[1];
    if (!cls) continue;
    scanned++;
    const exits = codeExitsFor(src, rids);
    if (!exits.length) continue;
    const room = byCls.get(cls.toLowerCase());
    if (!room) { unmatched.push(cls); continue; }
    found[room.num] = exits.map(e => ({ ...e, from_name: room.name }));
  }

  const out = { rooms: found,
                stats: { classes_scanned: scanned, rooms_with_code_exits: Object.keys(found).length,
                         unmatched_classes: unmatched } };
  if (outFile) writeFileSync(outFile, JSON.stringify(out));
  return out;
}

let cached;
export function loadCodeExits(file) {
  if (cached !== undefined) return cached;
  try { cached = JSON.parse(readFileSync(file, 'utf8')); } catch { cached = null; }
  return cached;
}

if (process.argv[1]?.endsWith('m59-codeexits.mjs')) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const kod = process.env.M59_KOD || 'C:/code/meridian59/kod';
  if (!existsSync(kod)) { console.error('no kod source at ' + kod); process.exit(1); }
  const idx = buildCodeExits({ kodRoot: kod, mapFile: root + 'substrate/m59-map.json',
                               outFile: root + 'substrate/m59-codeexits.json' });
  console.log(JSON.stringify({ ...idx.stats, unmatched_classes: idx.stats.unmatched_classes.length }));
  const map = JSON.parse(readFileSync(root + 'substrate/m59-map.json', 'utf8'));
  for (const [num, exits] of Object.entries(idx.rooms))
    console.log(`  ${num} ${map.rooms[num]?.name}`.padEnd(46) +
      exits.map(e => `-> ${e.to} (${map.rooms[e.to]?.name ?? '?'}) when ` +
        e.when.map(c => `${c.axis}${c.op}${c.value}`).join(' and ')).join(' | '));
}
