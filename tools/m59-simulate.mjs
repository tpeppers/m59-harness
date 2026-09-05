#!/usr/bin/env node
// SIMULATE THIS FLEET FIGHTING THAT THING, AND WRITE DOWN WHAT HAPPENED.
//
//   node tools/m59-simulate.mjs --target "queen spider" --room 35
//   node tools/m59-simulate.mjs --target "ghost" --room 210 --mirror
//   node tools/m59-simulate.mjs --room 35 --list          what is in that room, nothing else
//   node tools/m59-simulate.mjs --room 35 --respawn QueenGenTimer   restock the room, then fight
//
// The question this answers is "can the fleet take X, and at what cost" — asked on a server
// where the answer is cheap, before anyone walks twenty-one characters somewhere to find out.
// So it teleports rather than travels: getting there is a DIFFERENT question, and mixing the
// two means a failed approach reads as a lost fight.
//
// ============================================================================
// LOCAL ONLY, AND THE CHECK IS THE ONE FROM m59-mirror.mjs.
// ============================================================================
//
// Placement is `UtilGoNearSquare` over the unauthenticated maintenance socket, and the
// combat policy it installs turns off every rung of the survival ladder. Pointed at prod
// that is not a simulation, it is twenty-one characters walked into a monster with their
// safeties removed. The guard checks the broker's URL AND what its sessions are actually
// connected to, because a local broker holding a remote fleet is exactly what prod looks
// like from this machine.
//
// ============================================================================
// WHAT IT DOES, IN ORDER
// ============================================================================
//
//   1. refuse anything that is not loopback, twice
//   2. optionally mirror prod's sheets onto the local fleet (--mirror), so the fight is
//      fought by characters with prod's attributes, skills, percentages and max health
//   3. find the target in the room, BY CLASS, from the room's own contents list
//   4. snapshot every character's policy, then install the fight-to-the-death one
//   5. place the fleet in a ring around the target, on squares the BSP says are standable
//   6. start one listener per character on `wait_for_event`, which is the only way the
//      world reaches an agent, and keep every sentence it hears
//   7. swing: adjacent characters attack, the rest step in on the mover's own rule, and
//      anyone wedged for 30s is lifted into a free square in reach
//   8. stop on a win (the target is gone), a loss (nobody left standing in the room), or
//      the time limit
//   9. put every character's policy back
//  10. write the combat report, to the terminal and to a self-contained HTML page
//
// ============================================================================
// WHY THE REPORT COUNTS WHAT IT COUNTS
// ============================================================================
//
// "We lost" and "we won" are both cheap to observe and neither tells you what to change.
// The three numbers that do are: how much of the incoming damage came from the TARGET
// rather than from everything else in the room, how many of our swings actually landed,
// and how many characters were ever in reach at once. A fleet that loses to the room
// rather than to the boss needs a different plan from one that loses to the boss.
//
// Every sentence the server sent is classified, and anything that matches nothing is kept
// in `unclassified` and printed. A parser that silently drops what it does not recognise
// reports a clean fight in which half the damage was invisible.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dm from './m59-dm.mjs';
import { refuseUnlessLocal, brokerHostOf, sessionHostsOf } from './m59-mirror.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);

// ---------------------------------------------------------------- the broker
let SEQ = 0;
function makeRpc(url) {
  return (name, args = {}, ms = 45000) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++SEQ, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(ms) })
      .then(r => r.json())
      .then(j => {
        if (j.result?.isError) return { error: j.result.content[0].text };
        try { return JSON.parse(j.result.content[0].text); }
        catch { return j.result?.content?.[0]?.text ?? j; }
      })
      .catch(e => ({ error: e.message }));
}

// ---------------------------------------------------------------- geometry
//
// Placement and stepping are asked of the SAME modules the broker moves on. A simulator
// that computes its own geometry is a second opinion about the map rather than a look at
// the one in play — and it would put characters in walls, which the server accepts.
let RoomGeometry = null;
const MAPFILE = path.join(REPO, 'substrate', 'm59-map.json');
const GEO = new Map();
async function geometry(room) {
  if (!RoomGeometry) ({ RoomGeometry } = await import('./m59-roo.mjs'));
  if (!GEO.has(room)) {
    try {
      const map = JSON.parse(fs.readFileSync(MAPFILE, 'utf8')).rooms;
      const g = RoomGeometry.fromJSON(map[String(room)].roo);
      // WITHOUT THE STEP MASK THIS INVENTS CLIFFS, and a simulator that thinks the floor
      // is a cliff reports a fleet that would not close as a fleet that could not fight.
      try { g.attachStepMask(g.buildStepMask()); } catch { /* no mask available */ }
      GEO.set(room, g);
    } catch { GEO.set(room, null); }
  }
  return GEO.get(room);
}
const standable = (g, r, c) => { try { return !!g?.standable(r, c); } catch { return false; } };
const steps = (g, from, to) => { try { return !!g?.moverStepLands(from.row, from.col, to.row, to.col); } catch { return false; } };

const NEIGHBOURS = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];

// One step towards something, on the rule the mover enforces rather than on "is there
// floor there". Rooms are terraced: in the Spider Nest the square that is closest is
// regularly one the server refuses as a fall (512 units against a 384 step ceiling), and
// the way down off a shelf often goes away from the target first. Bounded BFS, no I/O.
export function nextStep(g, from, to, occupied, { depth = 14 } = {}) {
  const key = s => s.row + ',' + s.col;
  const start = { row: from.row, col: from.col };
  const seen = new Map([[key(start), null]]);
  let frontier = [start];
  let best = { sq: start, d: Math.hypot(start.row - to.row, start.col - to.col) };
  for (let hop = 0; hop < depth && frontier.length; hop++) {
    const next = [];
    for (const cur of frontier) {
      for (const [dr, dc] of NEIGHBOURS) {
        const sq = { row: cur.row + dr, col: cur.col + dc };
        const k = key(sq);
        if (seen.has(k) || !steps(g, cur, sq)) continue;
        if (occupied.has(k) && k !== key(to)) continue;   // a body is not a wall, but you cannot END on one
        seen.set(k, cur);
        next.push(sq);
        const d = Math.hypot(sq.row - to.row, sq.col - to.col);
        if (d < best.d) best = { sq, d };
      }
    }
    frontier = next;
  }
  if (best.sq === start) return null;
  let node = best.sq;
  for (;;) {
    const parent = seen.get(key(node));
    if (!parent) return null;
    if (parent.row === start.row && parent.col === start.col) return node;
    node = parent;
  }
}

// Standable squares within `reach` of a point, nearest first, excluding the point itself.
export function slotsAround(g, at, reach) {
  const out = [];
  const R = Math.ceil(reach);
  for (let r = at.row - R; r <= at.row + R; r++)
    for (let c = at.col - R; c <= at.col + R; c++) {
      if (r === at.row && c === at.col) continue;
      const d = Math.hypot(r - at.row, c - at.col);
      if (d > reach + 0.01 || !standable(g, r, c)) continue;
      out.push({ row: r, col: c, d });
    }
  return out.sort((a, b) => a.d - b.d);
}

// ---------------------------------------------------------------- the room, off the DM socket
//
// Two commands give id, row and col for EVERYTHING in a room, which is why positions are
// read here rather than with a broker call per character. The maintenance socket also does
// not queue behind twenty-one keepers that are busy swinging.
export async function roomContents(roomObj) {
  const head = await dm.dm([`show object ${roomObj}`]);
  const listId = /plActive\s+= LIST (\d+)/.exec(head)?.[1];
  if (!listId) return [];
  const raw = await dm.dm([`show list ${listId}`]);
  const rows = [];
  let cur = null;
  for (const line of String(raw).split(/\r?\n/).map(l => l.replace(/^:\s?/, '').trim())) {
    if (line === '[') { cur = []; continue; }
    if (line === ']') {
      if (cur && /^OBJECT \d+/.test(cur[0] || ''))
        rows.push({ id: Number(cur[0].split(' ')[1]),
                    row: Number((cur[2] || '').split(' ')[1]),
                    col: Number((cur[3] || '').split(' ')[1]) });
      cur = null; continue;
    }
    if (cur) cur.push(line);
  }
  return rows.filter(r => Number.isFinite(r.row) && Number.isFinite(r.col));
}

// Classes for a set of objects, one batch.
export async function classesOf(ids) {
  if (!ids.length) return {};
  const cmds = ids.map(i => `show object ${i}`);
  const blocks = dm.split(await dm.dm(cmds), cmds);
  const out = {};
  ids.forEach((id, i) => { out[id] = (/is CLASS (\w+)/.exec(blocks[i] || '') || [])[1] ?? null; });
  return out;
}

// ---------------------------------------------------------------- classifying what was said
//
// The server narrates a fight in sentences. These are the shapes that matter, and anything
// that matches none of them is KEPT rather than dropped — an unclassified line is a hole in
// the report and has to be visible as one.
// A LINE IS EITHER PERSONAL OR A BROADCAST, AND COUNTING A BROADCAST PER LISTENER IS HOW
// ONE DEATH BECOMES EIGHT. "### Cccc was just killed by a queen spider." was heard by
// every character in the room, so it arrived eight times in one run; the fleet did not lose
// eight characters. Broadcasts are deduplicated globally and attributed to the character
// NAMED IN THE SENTENCE, never to whoever happened to hear it.
const BROADCAST = [
  { kind: 'fleet_death', re: /^###\s+(\S+?)\s+was just killed by\s+(?:a |an |the )?(.+?)\.?\s*$/i },
  { kind: 'target_slain', re: /^(\S+?)\s+has valiantly slain\s+(?:the |a |an )?(.+?)!?\s*$/i },
];
const OUTGOING = [
  { kind: 'hit',    re: /^Your\b.*\b(?:hits?|bashes|slashes|cuts?|smashes|strikes?|pierces|stabs?|slices?|crushes|bites|pokes|chops|rips|tears|thrusts?|whacks?|clubs?)\b/i },
  { kind: 'miss',   re: /^You miss\b|^Your\b.*\bmisses\b/i },
  { kind: 'dodged', re: /\b(?:dodges|avoids|evades|parries|blocks|deflects)\s+your\s+attack/i },
];
// The victim's own narration. `bites you`, `bites you several times`, `devours you with her
// attack` — the verb list cannot be closed, so the shape is "<somebody> <verb> you".
const INCOMING = [
  { kind: 'dodged', re: /^You\s+(?:dodge|avoid|evade|parry|block|deflect)\b.*?\b(?:the\s+)?(.+?)['’]?s?\s+attack/i, whoAt: 1 },
  { kind: 'miss',   re: /^(?:The |A |An )?(.+?)\s+(?:misses you|swings at you and misses|fails to)\b/i, whoAt: 1 },
  { kind: 'hit',    re: /^(?:The |A |An )?(.+?)\s+\w+(?:s|es)?\s+you\b/i, whoAt: 1 },
];
const CONDITION = /^(?:The\s+)?(.+?)\s+is\s+(slightly wounded|clearly injured|seriously wounded|badly hurt|weak, and near death|nearly dead|barely hurt)/i;
const OWN_DEATH = /^You are dead, poor soul|^You have died\b/i;
// Not combat, not noise: the game telling a character it has stopped learning here. Kept
// out of `unclassified` so that bucket stays a signal that the parser is missing something.
const CHATTER = /holds no more lessons|practiced all you can|training seems to have stagnated|You feel|You sense/i;

export function classify(text, targetName) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const named = s => String(s ?? '').replace(/^(the|a|an)\s+/i, '').replace(/[.!]$/, '').trim().toLowerCase() || null;
  const isTarget = who => !!(who && targetName && (who.includes(targetName.toLowerCase()) || targetName.toLowerCase().includes(who)));

  for (const p of BROADCAST) {
    const m = p.re.exec(t);
    if (m) return { dir: 'broadcast', kind: p.kind, who: m[1], other: named(m[2]), text: t };
  }
  for (const p of OUTGOING) if (p.re.test(t)) return { dir: 'out', kind: p.kind, text: t };
  const cond = CONDITION.exec(t);
  if (cond && isTarget(named(cond[1]))) return { dir: 'condition', kind: cond[2].toLowerCase(), text: t };
  if (OWN_DEATH.test(t)) return { dir: 'own_death', kind: 'death', text: t };
  for (const p of INCOMING) {
    const m = p.re.exec(t);
    if (!m) continue;
    const who = named(m[p.whoAt]);
    return { dir: 'in', kind: p.kind, from: who, target: isTarget(who), text: t };
  }
  if (CHATTER.test(t)) return { dir: 'note', kind: 'note', text: t };
  return { dir: 'other', kind: 'unclassified', text: t };
}

// ---------------------------------------------------------------- the report
const COUNTERS = ['swings', 'hits', 'misses', 'dodged_by_target', 'incoming_target',
                  'incoming_target_hits', 'incoming_other', 'incoming_other_hits', 'unclassified'];

export function summarise(state) {
  const per = {};
  const blank = () => ({
    swings: 0, hits: 0, misses: 0, dodged_by_target: 0,
    incoming_target: 0, incoming_target_hits: 0,
    incoming_other: 0, incoming_other_hits: 0,
    incoming_by: {}, died_at: null, killed_by: null, unclassified: 0,
  });
  // Deduped: keyed on the sentence itself, which is how the same broadcast reaches
  // twenty-one listeners and still counts once.
  const broadcasts = new Map();
  const condition = [];
  const unknown = new Map();

  for (const [agent, lines] of Object.entries(state.log)) {
    const p = per[agent] = blank();
    for (const l of lines) {
      const c = classify(l.text, state.target.name);
      if (!c) continue;
      if (c.dir === 'broadcast') {
        if (!broadcasts.has(c.text)) broadcasts.set(c.text, { ...c, at: l.at });
        continue;
      }
      if (c.dir === 'condition') { condition.push({ at: l.at, kind: c.kind, text: c.text }); continue; }
      if (c.dir === 'out') {
        p.swings++;
        if (c.kind === 'hit') p.hits++;
        else if (c.kind === 'miss') p.misses++;
        else p.dodged_by_target++;
      } else if (c.dir === 'in') {
        const bucket = c.target ? 'target' : 'other';
        p[`incoming_${bucket}`]++;
        if (c.kind === 'hit') p[`incoming_${bucket}_hits`]++;
        if (c.from) p.incoming_by[c.from] = (p.incoming_by[c.from] ?? 0) + 1;
      } else if (c.dir === 'other') {
        p.unclassified++;
        unknown.set(c.text, (unknown.get(c.text) ?? 0) + 1);
      }
    }
    p.died_at = state.deaths.get(agent) ?? null;
  }

  // Deaths and the killing blow, from the broadcasts — the server names both.
  const byName = Object.fromEntries(Object.entries(state.characters).map(([a, c]) => [c, a]));
  const deaths = [];
  let killer = null;
  for (const b of broadcasts.values()) {
    if (b.kind === 'fleet_death') {
      deaths.push({ character: b.who, agent: byName[b.who] ?? null, by: b.other, at: b.at });
      const a = byName[b.who];
      if (a && per[a]) per[a].killed_by = b.other;
    } else if (b.kind === 'target_slain') killer = { character: b.who, at: b.at };
  }

  const total = blank();
  total.incoming_by = {};
  for (const p of Object.values(per)) {
    for (const k of COUNTERS) total[k] += p[k];
    for (const [who, n] of Object.entries(p.incoming_by))
      total.incoming_by[who] = (total.incoming_by[who] ?? 0) + n;
  }
  return {
    per, total, killer,
    deaths: deaths.sort((a, b) => a.at - b.at),
    condition: condition.sort((a, b) => a.at - b.at),
    unknown: [...unknown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
  };
}

function html(state, sum) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const secs = Math.round((state.ended - state.started) / 1000);
  const t = sum.total;
  const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '—');
  const rows = Object.entries(sum.per).sort((a, b) => b[1].hits - a[1].hits).map(([agent, p]) => `
    <tr class="${p.died_at ? 'dead' : ''}">
      <td>${esc(state.characters[agent] ?? agent)}</td>
      <td class="n">${state.levels[agent] ?? '—'}</td>
      <td class="n">${p.swings}</td><td class="n">${p.hits}</td>
      <td class="n">${pct(p.hits, p.swings)}</td>
      <td class="n">${p.incoming_target}</td><td class="n">${p.incoming_other}</td>
      <td>${p.died_at ? new Date(p.died_at).toISOString().slice(11, 19) + (p.killed_by ? ` · ${esc(p.killed_by)}` : '') : 'survived'}</td>
    </tr>`).join('');
  const byWho = Object.entries(t.incoming_by).sort((a, b) => b[1] - a[1])
    .map(([w, n]) => `<tr><td>${esc(w)}</td><td class="n">${n}</td></tr>`).join('');
  const rel = at => ((at - state.started) / 1000).toFixed(0) + 's';
  const fell = sum.deaths.map(d =>
    `<tr><td>${rel(d.at)}</td><td>${esc(d.character)}</td><td>${esc(d.by)}</td></tr>`).join('');
  const cond = sum.condition.map(c =>
    `<tr><td>${rel(c.at)}</td><td>${esc(c.kind)}</td></tr>`).join('');
  const unk = sum.unknown.map(([text, n]) =>
    `<tr><td class="n">${n}</td><td>${esc(text)}</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>Combat results — ${esc(state.target.name)}</title>
<style>
 :root{--bg:#faf9f7;--ink:#1a1a1a;--dim:#6b6b6b;--line:#e0ddd8;--win:#1f7a3d;--loss:#a3232b;--card:#fff}
 @media (prefers-color-scheme:dark){:root{--bg:#16181c;--ink:#e8e6e3;--dim:#9b9b9b;--line:#2c2f35;--win:#54c47f;--loss:#f0656f;--card:#1d2025}}
 body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 -apple-system,Segoe UI,system-ui,sans-serif}
 main{max-width:74rem;margin:0 auto;padding:2rem 1.25rem 4rem}
 h1{font-size:1.6rem;margin:0 0 .25rem} .sub{color:var(--dim);margin:0 0 1.5rem}
 .verdict{font-size:1.15rem;font-weight:650;padding:.6rem .9rem;border-radius:.5rem;display:inline-block;margin-bottom:1.5rem}
 .verdict.win{background:color-mix(in srgb,var(--win) 14%,transparent);color:var(--win)}
 .verdict.loss{background:color-mix(in srgb,var(--loss) 14%,transparent);color:var(--loss)}
 .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.75rem;margin-bottom:2rem}
 .tile{background:var(--card);border:1px solid var(--line);border-radius:.5rem;padding:.75rem .9rem}
 .tile b{display:block;font-size:1.5rem;font-weight:650;font-variant-numeric:tabular-nums}
 .tile span{color:var(--dim);font-size:.8rem}
 h2{font-size:1rem;margin:2rem 0 .6rem;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}
 .scroll{overflow-x:auto;border:1px solid var(--line);border-radius:.5rem;background:var(--card)}
 table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
 th,td{padding:.42rem .7rem;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
 th{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);font-weight:600}
 td.n{text-align:right} tr:last-child td{border-bottom:0} tr.dead td:first-child::after{content:" †";color:var(--loss)}
 code{background:color-mix(in srgb,var(--ink) 7%,transparent);padding:.1rem .3rem;border-radius:.25rem}
 ul{margin:.3rem 0 0;padding-left:1.1rem;color:var(--dim)}
</style>
<main>
<h1>${esc(state.characters_count)} v ${esc(state.target.name)}</h1>
<p class="sub">${esc(state.roomName)} (room ${state.room}) · ${secs}s · ${new Date(state.started).toISOString().replace('T', ' ').slice(0, 19)}Z</p>
<div class="verdict ${state.won ? 'win' : 'loss'}">${state.won ? 'FLEET WINS' : 'FLEET LOSES'} — ${esc(state.verdict)}</div>
<div class="tiles">
 <div class="tile"><b>${t.swings}</b><span>swings by the fleet</span></div>
 <div class="tile"><b>${t.hits}</b><span>landed (${pct(t.hits, t.swings)})</span></div>
 <div class="tile"><b>${t.incoming_target}</b><span>swings from ${esc(state.target.name)}</span></div>
 <div class="tile"><b>${t.incoming_other}</b><span>swings from everything else</span></div>
 <div class="tile"><b>${state.deaths.size}/${state.characters_count}</b><span>fleet dead</span></div>
 <div class="tile"><b>${state.peakInReach}</b><span>most in reach at once</span></div>
</div>
<h2>Per character</h2>
<div class="scroll"><table>
<tr><th>character</th><th>lvl</th><th>swings</th><th>hits</th><th>hit rate</th><th>hit by target</th><th>hit by others</th><th>died</th></tr>
${rows}
</table></div>
<h2>Who was hitting us</h2>
<div class="scroll"><table><tr><th>attacker</th><th>swings at the fleet</th></tr>${byWho || '<tr><td colspan=2>nothing landed a line</td></tr>'}</table></div>

<h2>Who fell, and to what</h2>
<div class="scroll"><table><tr><th>at</th><th>character</th><th>killed by</th></tr>${fell || '<tr><td colspan=3>nobody died</td></tr>'}</table></div>

<h2>The target, as the server described it</h2>
<div class="scroll"><table><tr><th>at</th><th>condition</th></tr>${cond || '<tr><td colspan=2>never described — it was never hurt enough to narrate</td></tr>'}</table></div>
${sum.killer ? `<p>Killing blow: <b>${esc(sum.killer.character)}</b> at ${rel(sum.killer.at)}.</p>` : ''}

${unk ? `<h2>Lines the parser did not recognise</h2>
<div class="scroll"><table><tr><th>n</th><th>sentence</th></tr>${unk}</table></div>` : ''}

<h2>How to read this</h2>
<ul>
 <li><b>Swings from ${esc(state.target.name)}</b> against <b>swings from everything else</b> is the one number that changes the plan: a fleet losing to the room needs a different answer from one losing to the boss.</li>
 <li><b>Most in reach at once</b> is the real width of the fight. The rest of the fleet is queueing, whatever the headcount says.</li>
 <li>Room-wide sentences (a death, the killing blow) are heard by every character present and are counted <b>once</b>. Personal ones — what hit <em>you</em> — are counted per character, and a character stops hearing anything the moment it dies, so incoming totals are a floor rather than a census.</li>
 <li>${t.unclassified} line(s) matched no pattern and were counted nowhere${unk ? ', and are listed above' : ''}. If that number is large the parser is missing a sentence shape, not the fleet.</li>
 <li>Placement was by teleport. This says nothing about whether the fleet could get here.</li>
</ul>
</main>`;
}

// ---------------------------------------------------------------- the run
async function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const brokerUrl = arg('--broker', process.env.M59_CONTROL_URL || 'http://127.0.0.1:8971/');
  const room = Number(arg('--room', 35));
  const targetWanted = arg('--target', 'queen');
  const minutes = Number(arg('--minutes', 10));
  const reach = Number(arg('--reach', 1.45));       // a mace at 2.2 squares is "too far away to hit"
  const outFile = arg('--html', path.join(REPO, 'substrate', 'simulations',
                                          `${new Date().toISOString().replace(/[:.]/g, '-')}-room${room}.html`));
  const rpc = makeRpc(brokerUrl);

  // 1. LOCAL ONLY.
  const hosts = await sessionHostsOf(brokerUrl).catch(() => null);
  const refusal = refuseUnlessLocal({ brokerUrl, sessionHosts: hosts });
  if (refusal) {
    console.error('REFUSING TO SIMULATE.');
    console.error(`  ${refusal}`);
    console.error('  This places characters over the maintenance socket and turns off their');
    console.error('  survival ladder. Against a live fleet that is not a simulation.');
    process.exit(2);
  }
  const health = await (await fetch(new URL('/health', brokerUrl))).json();
  const characters = health.session_characters ?? {};
  const agents = Object.keys(characters).sort();
  if (!agents.length) { console.error('that broker is holding nobody'); process.exit(1); }
  console.error(`local broker ${brokerHostOf(brokerUrl)}, ${agents.length} character(s)`);

  // 3. THE TARGET, found by class in the room's own contents.
  const roomObj = await dm.roomObject(room);
  if (roomObj == null) { console.error(`no room ${room} on this server`); process.exit(1); }
  const bodies = await roomContents(roomObj);
  const classes = await classesOf(bodies.map(b => b.id));
  if (argv.includes('--list')) {
    const counts = {};
    for (const b of bodies) counts[classes[b.id] ?? '?'] = (counts[classes[b.id] ?? '?'] ?? 0) + 1;
    console.log(`room ${room}: ` + Object.entries(counts).map(([k, v]) => `${k} x${v}`).join(', '));
    for (const b of bodies) console.log(`  ${b.id} ${classes[b.id]} r${b.row}c${b.col}`);
    process.exit(0);
  }
  const want = targetWanted.replace(/[^a-z]/gi, '').toLowerCase();
  let hit = bodies.find(b => String(classes[b.id] ?? '').toLowerCase().includes(want));

  // A BOSS YOU JUST KILLED IS NOT THERE TO FIGHT AGAIN FOR AN HOUR, AND A TEST YOU CAN ONLY
  // RUN ONCE IS NOT A TEST. Every monster room owns the timer that restocks it, so
  // `--respawn` names the kod message to send the ROOM so that timer runs now: the Spider
  // Nest's is `QueenGenTimer` (nest1.kod:86), whose own docstring is "Check if there's a
  // queen spider in room. If not, make one.", and which is otherwise on a one-HOUR clock.
  // Nothing is guessed and nothing is created out of thin air — the room restocks itself by
  // its own rule, and the operator names the message because only the room's source knows it.
  const respawn = arg('--respawn');
  if (!hit && respawn) {
    console.error(`nothing matching "${targetWanted}" here — sending room ${room} its own ${respawn}`);
    await dm.dm([`send object ${roomObj} ${respawn}`]);
    await sleep(1500);
    const again = await roomContents(roomObj);
    const cls2 = await classesOf(again.map(b => b.id));
    hit = again.find(b => String(cls2[b.id] ?? '').toLowerCase().includes(want));
    if (hit) { bodies.length = 0; bodies.push(...again); Object.assign(classes, cls2); }
  }
  if (!hit) {
    console.error(`nothing in room ${room} has a class matching "${targetWanted}".`);
    console.error(`See what is there:  node tools/m59-simulate.mjs --room ${room} --list`);
    process.exit(1);
  }
  const target = { id: hit.id, row: hit.row, col: hit.col, cls: classes[hit.id], name: targetWanted };
  console.error(`target: ${target.cls} object ${target.id} at r${target.row}c${target.col}`);

  // 2. MIRROR, if asked. Done here rather than by hand so one command is the whole test.
  if (argv.includes('--mirror')) {
    const { execFileSync } = await import('node:child_process');
    console.error('mirroring prod sheets onto this fleet...');
    execFileSync(process.execPath, [path.join(HERE, 'm59-mirror.mjs'), 'fleet',
                                    '--broker', brokerUrl, '--i-mean-it'], { stdio: 'inherit' });
  }

  // 4. POLICY. Snapshotted first: this strips every safety these characters have and the
  //    way back is what they were carrying, not the defaults.
  const before = {};
  for (const a of agents) {
    const s = await rpc('autopilot', { agent: a, action: 'status' });
    before[a] = s?.policy ?? null;
  }
  const stash = path.join(REPO, 'substrate', 'simulations',
                          `policy-before-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(stash), { recursive: true });
  fs.writeFileSync(stash, JSON.stringify(before, null, 1));
  console.error(`policy snapshot -> ${path.relative(REPO, stash)}`);

  // `doomed_in_*_below` refuses a literal 0 ("a fraction between 0 and 1"), so they go to
  // 0.01 and the real switch is panic_logoff, which the schema calls the master over both.
  const ARM = {
    action: 'start', flee_below: 0, rest_below: 0,
    panic_logoff: false, break_out_via_logoff: false,
    doomed_in_open_below: 0.01, doomed_in_spot_below: 0.01,
    use_safe_spots: false, require_safe_wall: false,   // PAIRED: false alone is coerced back
    retreat_to_inn: false, ask_for_help: false,
    threat_ceiling: { mode: 'flat', value: 200 }, fight_rounds: 200,
  };
  for (const a of agents) {
    const r = await rpc('autopilot', { agent: a, ...ARM });
    if (r?.error) console.error(`${a}: policy refused — ${r.error}`);
  }
  // Read one back: a push reply is not a policy.
  const check = await rpc('autopilot', { agent: agents[0], action: 'status' });
  console.error(`armed (${agents[0]}: flee ${check?.policy?.fleeBelow}, panicLogoff ${check?.policy?.panicLogoff})`);

  // 5. PLACE.
  const g = await geometry(room);
  if (!g) console.error(`no baked geometry for room ${room} — placing without a floor check`);
  const ring = slotsAround(g, target, 3.5);
  const ids = await dm.resolve(agents.map(a => characters[a]));
  const placeCmds = [];
  agents.forEach((a, i) => {
    const spot = ring[i % Math.max(1, ring.length)];
    const id = ids[characters[a]];
    if (id != null && spot) placeCmds.push(dm.relocateCmd(id, roomObj, spot.row, spot.col));
  });
  if (placeCmds.length) await dm.dm(placeCmds);
  console.error(`placed ${placeCmds.length} around ${target.cls}; ${ring.length} standable square(s) within 3.5`);

  // 6. LISTEN. MCP is request/response: the world only reaches an agent that asks.
  const state = {
    room, roomName: (await dm.dm([`show object ${roomObj}`])).match(/is CLASS (\w+)/)?.[1] ?? `room ${room}`,
    target, characters, levels: {}, log: Object.fromEntries(agents.map(a => [a, []])),
    deaths: new Map(), started: Date.now(), ended: 0, won: false, verdict: '', peakInReach: 0,
    characters_count: agents.length,
  };
  for (const a of agents) {
    const s = await rpc('status', { agent: a, brief: true });
    state.levels[a] = s?.hp?.max ?? null;
  }
  let listening = true;
  const listeners = agents.map(async a => {
    let since;
    while (listening) {
      const r = await rpc('wait_for_event', { agent: a, kinds: ['message'], timeout_ms: 5000, ...(since != null ? { since } : {}) }, 20000);
      if (r?.error) { await sleep(1000); continue; }
      since = r.cursor ?? r.since ?? since;
      for (const ev of r.events ?? []) {
        const text = ev.text ?? ev.message ?? ev.string ?? '';
        if (text) state.log[a].push({ at: ev.at ?? Date.now(), text });
      }
    }
  });

  // 7. SWING.
  const deadline = Date.now() + minutes * 60_000;
  const progress = new Map();
  console.error(`${now()} engaging — up to ${minutes} minute(s)`);
  while (Date.now() < deadline) {
    const live = await roomContents(roomObj);
    const byId = new Map(live.map(b => [b.id, b]));
    const here = agents.filter(a => byId.has(ids[characters[a]]));
    for (const a of agents) {
      if (!byId.has(ids[characters[a]]) && !state.deaths.has(a)) {
        state.deaths.set(a, Date.now());
        console.error(`${now()} ${characters[a]} is down — ${state.deaths.size}/${agents.length}`);
      }
    }
    const t = byId.get(target.id);
    if (!t) { state.won = true; state.verdict = `${target.cls} is no longer in the room`; break; }
    if (!here.length) { state.verdict = 'nobody left standing in the room'; break; }

    const occupied = new Set(live.map(b => b.row + ',' + b.col));
    const inReach = [];
    const swings = [];
    for (const a of here) {
      const me = byId.get(ids[characters[a]]);
      const d = Math.hypot(me.row - t.row, me.col - t.col);
      if (d <= reach) {
        inReach.push(a);
        // NO `stop_below`: it is refused outright unless it is between 0.05 and 0.95, and a
        // refused call is not a swing. Omitted is what "never break off" means to this tool.
        swings.push(rpc('attack', { agent: a, target: target.id, swings: 2 }, 40000).then(r => [a, r]));
        progress.set(a, { d, at: Date.now() });
        continue;
      }
      const p = progress.get(a);
      if (!p || d < p.d - 0.4) progress.set(a, { d, at: Date.now() });
      else if (Date.now() - p.at > 30000) {
        // Wedged. Lifted, and SAID so — a silent teleport makes the walker look better
        // than it is, and "could the fleet close" is half of what this measures.
        const free = slotsAround(g, t, 3).find(s => !occupied.has(s.row + ',' + s.col));
        if (free) {
          await dm.dm([dm.relocateCmd(ids[characters[a]], roomObj, free.row, free.col)]);
          occupied.add(free.row + ',' + free.col);
          progress.set(a, { d: 1, at: Date.now() });
          console.error(`${now()} ${characters[a]} was wedged ${d.toFixed(1)} out — lifted to r${free.row}c${free.col}`);
          continue;
        }
      }
      const step = nextStep(g, me, t, occupied);
      if (step) {
        occupied.delete(me.row + ',' + me.col);
        occupied.add(step.row + ',' + step.col);
        rpc('walk_to', { agent: a, row: step.row, col: step.col, max_steps: 2 }, 15000).catch(() => {});
      }
    }
    state.peakInReach = Math.max(state.peakInReach, inReach.length);
    if (swings.length) {
      // The attack replies carry our own outgoing lines, which the event stream does not
      // always surface — kept alongside what the listeners heard.
      for (const [a, r] of await Promise.all(swings))
        for (const msg of r?.messages ?? []) state.log[a].push({ at: Date.now(), text: msg });
    }
    await sleep(700);
  }
  if (!state.verdict) state.verdict = 'the time limit ran out';
  state.ended = Date.now();
  listening = false;
  await Promise.allSettled(listeners);

  // 9. POLICY BACK.
  for (const a of agents) {
    const p = before[a];
    if (!p) continue;
    await rpc('autopilot', { agent: a, action: 'start',
      flee_below: p.fleeBelow, rest_below: p.restBelow,
      panic_logoff: p.panicLogoff, break_out_via_logoff: p.breakOutViaLogoff,
      use_safe_spots: p.useSafeSpots, require_safe_wall: p.requireSafeWall,
      ...(p.threatCeiling ? { threat_ceiling: p.threatCeiling } : {}),
      ...(Number.isFinite(p.doomedInSpotBelow) ? { doomed_in_spot_below: p.doomedInSpotBelow } : {}),
    });
  }
  console.error('policy restored');

  // 10. REPORT.
  const sum = summarise(state);
  const t = sum.total;
  const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '—');
  console.log('');
  console.log(`=== ${agents.length} v ${target.cls} in ${state.roomName} (room ${room}) ===`);
  console.log(`${state.won ? 'FLEET WINS' : 'FLEET LOSES'} — ${state.verdict}` +
              `   ${Math.round((state.ended - state.started) / 1000)}s`);
  console.log(`fleet swings      ${t.swings}  (${t.hits} landed ${pct(t.hits, t.swings)}, ` +
              `${t.misses} missed, ${t.dodged_by_target} dodged)`);
  console.log(`incoming, target  ${t.incoming_target}  (${t.incoming_target_hits} landed)`);
  console.log(`incoming, others  ${t.incoming_other}  (${t.incoming_other_hits} landed)`);
  console.log(`dead              ${sum.deaths.length || state.deaths.size}/${agents.length}` +
              (sum.deaths.length ? '  ' + sum.deaths.map(d => `${d.character}<-${d.by}`).join(', ') : ''));
  if (sum.killer) console.log(`killing blow      ${sum.killer.character}`);
  console.log(`most in reach     ${state.peakInReach}  of ${agents.length}`);
  if (t.unclassified) console.log(`unclassified      ${t.unclassified} line(s) — counted nowhere, see the page`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, html(state, sum));
  fs.writeFileSync(outFile.replace(/\.html$/, '.json'),
                   JSON.stringify({ ...state, deaths: [...state.deaths], summary: sum }, null, 1));
  console.log(`\nreport: ${outFile}`);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'm59-simulate.mjs') {
  main().catch(e => { console.error(e); process.exit(1); });
}
