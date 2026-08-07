#!/usr/bin/env node
// WATCH THE SAFE-SPOT EXPERIMENTS AS THEY HAPPEN, AND DISAGREE WITH THEM.
//
//   node tools/m59-spotwatch.mjs [--broker 8901] [--port 8903]
//   then open http://127.0.0.1:8903
//
// The keeper decides whether a square is a working safe spot by standing in it and
// seeing whether anything lands. That is a measurement, and measurements are wrong in
// ways their own summaries cannot show — so this page does not lead with the verdict.
// It leads with THE READINGS: every window the keeper adjudicated, what it saw, and
// why it counted or was thrown away.
//
// The discards are the important half. If this is broken it will be broken there: a
// window dropped as "we swung" that nobody swung in, a grace period believed over
// while the server was still holding the monsters back, an "adjacent monster" that was
// a corpse. A log of conclusions would hide every one of those.
//
// So: stand next to the character in the real client, watch the same moment, and press
// DISPUTE on any reading that does not match what you saw. Disputes are appended to
// substrate/m59-spot-disputes.jsonl with the whole reading attached, which is enough to
// go and find the bug.
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const BROKER = `http://127.0.0.1:${arg('broker', '8901')}/`;
const PORT = Number(arg('port', '8903'));
const DISPUTES = fileURLToPath(new URL('../substrate/m59-spot-disputes.jsonl', import.meta.url));

let rpc = 0;
async function call(name, args) {
  const r = await fetch(BROKER, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call',
                           params: { name, arguments: args } }),
  });
  const j = await r.json();
  const t = j.result?.content?.[0]?.text;
  if (j.error) throw new Error(j.error.message);
  if (j.result?.isError) throw new Error(t);
  try { return JSON.parse(t); } catch { return t; }
}

// ------------------------------------------------------------------ the stream
//
// One merged, time-ordered stream of readings across the whole fleet. Keyed by
// character and timestamp so that polling the same window twice does not duplicate it
// — the keeper keeps its last dozen and we poll faster than it produces them.
const seen = new Set();
const stream = [];
const fleet = new Map();
let lastPoll = null, pollError = null;

function ingest(list) {
  for (const a of list) {
    fleet.set(a.name, {
      name: a.name, character: a.character ?? null,
      running: a.running, mode: a.mode, hunt: a.policy?.hunt,
      spot: a.safe_spot, threat: a.threat, stalled: a.stalled,
      kills: a.did?.kills ?? 0, deaths: a.did?.deaths ?? 0,
      mulligans: a.did?.mulligans ?? 0, breakouts: a.did?.breakouts ?? 0,
      logoffs: a.did?.logoffs ?? 0,
    });
    for (const t of a.trials || []) {
      const key = `${a.name}:${t.at}:${t.pass}`;
      if (seen.has(key)) continue;
      seen.add(key);
      stream.push({ ...t, who: a.name });
    }
  }
  stream.sort((x, y) => x.at - y.at);
  if (stream.length > 600) stream.splice(0, stream.length - 600);
  if (seen.size > 4000) seen.clear();      // the sort key is time; stale keys cannot recur
}

async function poll() {
  try {
    const r = await call('autopilot', { agent: 'any', action: 'list' });
    ingest(r.autopilots || []);
    lastPoll = Date.now();
    pollError = null;
  } catch (e) { pollError = e.message; }
}

// ------------------------------------------------------------------ the page

const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clock = t => new Date(t).toTimeString().slice(0, 8);

// Three kinds of reading, and the page has to make the difference obvious at a glance,
// because they mean completely different things: a conclusion drawn, a conclusion
// drawn the other way, and no conclusion at all.
const kindOf = t => !t.counted ? 'skip' : /HIT/.test(t.verdict) ? 'bad' : 'good';

function page() {
  const rows = [...fleet.values()].sort((a, b) => a.name.localeCompare(b.name));
  const live = rows.filter(r => r.running).length;
  const holding = rows.filter(r => r.spot && r.spot.works).length;
  const testing = rows.filter(r => r.spot && !r.spot.works).length;
  const counted = stream.filter(t => t.counted).length;

  return `<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>safe spot experiments</title>
<style>
 :root { color-scheme: dark; --bg:#0e1013; --fg:#d8dee6; --dim:#7a8493; --line:#232833;
         --good:#5fd39b; --bad:#ff6b6b; --skip:#5a6472; }
 body { background:var(--bg); color:var(--fg); font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;
        margin:0; padding:1rem 1.2rem 4rem; }
 h1 { font-size:15px; margin:0 0 .2rem; letter-spacing:.01em; }
 .sub { color:var(--dim); margin-bottom:1rem; max-width:70ch; }
 .tiles { display:flex; gap:1.4rem; flex-wrap:wrap; margin-bottom:1.2rem; }
 .tile b { font-size:20px; font-weight:600; display:block; }
 .tile span { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
 table { border-collapse:collapse; width:100%; margin-bottom:1.6rem; }
 th { text-align:left; color:var(--dim); font-weight:400; font-size:11px;
      text-transform:uppercase; letter-spacing:.06em; padding:.3rem .6rem .3rem 0;
      border-bottom:1px solid var(--line); }
 td { padding:.28rem .6rem .28rem 0; border-bottom:1px solid var(--line); vertical-align:top; }
 .good { color:var(--good); } .bad { color:var(--bad); } .skip { color:var(--skip); }
 .who { color:var(--fg); }
 .verdict { max-width:52ch; }
 .inputs { color:var(--dim); font-size:11px; }
 button { background:none; border:1px solid var(--line); color:var(--dim); cursor:pointer;
          font:inherit; font-size:11px; padding:.05rem .5rem; border-radius:3px; }
 button:hover { color:var(--bad); border-color:var(--bad); }
 .flagged { color:var(--bad); border-color:var(--bad); }
 .err { color:var(--bad); margin-bottom:1rem; }
 @media (max-width:640px){ .inputs{display:none} }
</style>
<h1>safe spot experiments &mdash; live</h1>
<div class=sub>Every window the keepers adjudicated, newest last. <b class=good>Green</b> counted
and held, <b class=bad>red</b> counted and was a hit, <b class=skip>grey</b> was thrown away and
says why. The grey ones are where a measurement bug would hide. If a reading does not match what
you just watched happen, dispute it &mdash; the whole reading is written to
<code>substrate/m59-spot-disputes.jsonl</code>.</div>
${pollError ? `<div class=err>broker not answering on ${esc(BROKER)}: ${esc(pollError)}</div>` : ''}
<div class=tiles>
  <div class=tile><b>${live}</b><span>keepers running</span></div>
  <div class=tile><b class=good>${holding}</b><span>in a proven spot</span></div>
  <div class=tile><b>${testing}</b><span>testing one</span></div>
  <div class=tile><b>${counted}</b><span>readings that counted</span></div>
  <div class=tile><b class=skip>${stream.length - counted}</b><span>thrown away</span></div>
</div>

<table><thead><tr><th>who</th><th>where</th><th>spot</th><th>evidence</th><th>on it</th><th>k/d</th></tr></thead><tbody>
${rows.map(r => `<tr>
  <td class=who>${esc(r.character || r.name)}</td>
  <td class=inputs>${esc(r.hunt || '-')}${r.stalled ? ' <span class=bad>stalled</span>' : ''}</td>
  <td class="${r.spot ? (r.spot.works ? 'good' : 'skip') : 'skip'}">${
    r.spot ? `${r.spot.at.col},${r.spot.at.row} ${r.spot.works ? 'HOLDS' : 'testing'}` : '&mdash;'}</td>
  <td class=inputs>${esc(r.spot ? r.spot.evidence : '')}</td>
  <td class=inputs>${r.threat ? `${r.threat.in_swing_range} in range, ${r.threat.camped_on_us} camped` : ''}</td>
  <td class=inputs>${r.kills}/${r.deaths}${r.mulligans ? ` &middot; ${r.mulligans} mull` : ''}${
    r.breakouts ? ` &middot; ${r.breakouts} out` : ''}</td>
</tr>`).join('')}
</tbody></table>

<table><thead><tr><th>time</th><th>who</th><th>at</th><th>the reading</th><th>inputs</th><th></th></tr></thead><tbody>
${stream.slice(-140).map(t => {
  const k = kindOf(t);
  const id = `${t.who}:${t.at}:${t.pass}`;
  return `<tr>
    <td class=inputs>${clock(t.at)}</td>
    <td class=who>${esc(t.who)}</td>
    <td class=inputs>${t.at_col ?? '?'},${t.at_row ?? '?'}</td>
    <td class="verdict ${k}">${esc(t.verdict)}</td>
    <td class=inputs>${t.window_s ?? '?'}s &middot; hp ${t.health_before ?? '?'}&rarr;${t.health_after ?? '?'} &middot; ${
      t.adjacent_at_start} adj${t.swung_in_window ? ' &middot; swung' : ''}${
      t.moved_in_window ? ' &middot; moved' : ''}${t.monsters_awake ? '' : ' &middot; asleep'}</td>
    <td><button data-id="${esc(id)}" onclick="dispute(this)">dispute</button></td>
  </tr>`;
}).join('')}
</tbody></table>

<script>
 let paused = false;
 async function dispute(btn) {
   paused = true;
   const note = prompt('What did you actually see? (blank is fine — the reading is attached)');
   paused = false;
   if (note === null) return;
   btn.textContent = 'disputed'; btn.className = 'flagged';
   await fetch('/dispute', { method:'POST', headers:{'content-type':'application/json'},
     body: JSON.stringify({ id: btn.dataset.id, note }) });
 }
 setInterval(() => { if (!paused) location.reload(); }, 4000);
</script>`;
}

// ------------------------------------------------------------------ serving

createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/dispute') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const { id, note } = JSON.parse(body);
      const t = stream.find(x => `${x.who}:${x.at}:${x.pass}` === id);
      mkdirSync(dirname(DISPUTES), { recursive: true });
      appendFileSync(DISPUTES, JSON.stringify({
        t: new Date().toISOString(), kind: 'dispute', by: 'human',
        note: note || null, reading: t || { id, note: 'reading had already scrolled out' },
      }) + '\n');
      console.log(`DISPUTED ${id}${note ? ': ' + note : ''}`);
    } catch (e) { console.error('could not record dispute:', e.message); }
    res.writeHead(204).end();
    return;
  }
  if (req.url === '/disputes') {
    let out = '';
    try { out = readFileSync(DISPUTES, 'utf8'); } catch { out = ''; }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(out || 'none yet');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
     .end(page());
}).listen(PORT, '127.0.0.1', () => {
  console.log(`spotwatch on http://127.0.0.1:${PORT}  (broker ${BROKER})`);
  console.log('disputes -> ' + DISPUTES);
});

await poll();
setInterval(poll, 3000);
