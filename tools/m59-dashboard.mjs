// A page for the human. Everything else here is built for a model to read; this is
// the one thing that is not.
//
// It renders the ledger — the long, append-only record in substrate/history — as a
// single self-contained page: where every character is, what it has gained, and how
// the farming strategies compare. No dependencies, no external requests, refreshes
// itself, and works from a phone.
//
// The figure it leads with is MAX HEALTH GAINED PER HOUR. Kills are the number that
// looks like progress and is not: a kill at or below your own level fails the
// advancement test outright, so a character can kill all night and gain nothing.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { summarise, readLedger } from './m59-ledger.mjs';
import { resolveFleet } from './m59-fleetpath.mjs';

// WHICH FLEET THIS PAGE IS OF. Named on the page rather than left implicit: the
// dashboard binds to every interface and is the thing people leave open on a phone,
// and two fleets' pages are otherwise identical down to the character count. A page
// that does not say which fleet it is showing is a page that will eventually be read
// as the wrong one.
const { label: FLEET_LABEL, ledgerDir: LEDGER_DIR } = resolveFleet();

// WHERE THE COMPENDIUM PAGE FOR A ROOM LIVES.
//
// The compendium names its zone pages after the room CLASS — room 586 is class
// OutdoorsH6 and the page is zones/outdoorsh6.html — and that holds for all 264
// rooms that have a class, with no exceptions. So this is a lookup rather than a
// guess, provided you look up by NUMBER: twenty-two room NAMES name more than one
// room ("The Fields" is four different places), and a link that silently picks the
// wrong one of those is worse than no link.
const COMPENDIUM = process.env.M59_COMPENDIUM || 'http://localhost:8099';
const MAP_FILE = process.env.M59_MAP_FILE ||
  fileURLToPath(new URL('../substrate/m59-map.json', import.meta.url));

const zoneByNum = new Map(), zoneByName = new Map();
try {
  const m = JSON.parse(readFileSync(MAP_FILE, 'utf8'));
  for (const r of Object.values(m.rooms || m)) {
    if (!r?.cls) continue;
    const page = r.cls.toLowerCase();
    if (r.num != null) zoneByNum.set(Number(r.num), page);
    // Name is the fallback for old ledger samples, which did not record the number.
    if (r.name && !zoneByName.has(r.name)) zoneByName.set(r.name, page);
  }
} catch { /* no map: rooms simply render unlinked */ }

// EVERYTHING ELSE THE COMPENDIUM KNOWS ABOUT.
//
// Its pages are named by a slug — lowercase, alphanumerics only — so "acid ring" is
// items/acidring.html and "agility boon" is spells/agilityboon.html. Indexing the
// directories once at load turns "does a page exist for this?" into a lookup, which
// matters because linking to a 404 is worse than not linking: it teaches you to stop
// clicking.
const slug = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const KINDS = ['items', 'spells', 'skills', 'creatures', 'zones'];
const compendiumIndex = new Map();      // slug -> "kind/file"
try {
  const root = fileURLToPath(new URL('../compendium/', import.meta.url));
  for (const kind of KINDS) {
    let files = [];
    try { files = readdirSync(root + kind); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.html') || f === 'index.html') continue;
      const key = f.replace(/\.html$/, '');
      if (!compendiumIndex.has(key)) compendiumIndex.set(key, `${kind}/${f}`);
    }
  }
} catch { /* no compendium checked out: names render as plain text */ }

// A link if the compendium has a page, plain text if it does not.
export function lore(name, { cls = 'lore' } = {}) {
  const page = compendiumIndex.get(slug(name));
  if (!name) return '—';
  if (!page) return esc(name);
  return `<a class="${cls}" href="${COMPENDIUM}/${page}" target="_blank" rel="noopener">${esc(name)}</a>`;
}

export function roomLink(name, num) {
  const page = (num != null && zoneByNum.get(Number(num))) || zoneByName.get(name);
  if (!name) return '?';
  if (!page) return esc(name);
  return `<a class="room-link" href="${COMPENDIUM}/zones/${page}.html" target="_blank" rel="noopener">${esc(name)}</a>`;
}

// THREE BARS OF FIXED LENGTH, COLOURED PER SQUARE.
//
// A sparkline of level over a day answered a question nobody was asking at a glance.
// What you want to know looking at a fleet is who can still fight. So each bar is
// always the same width, and the colour of each square says whether that slice is
// attained, part-attained, or gone:
//
//   attained  this whole slice is filled — the value is at or above the top of it
//   orange    the value is inside this slice, so it is the one being eaten into
//   red       the value never reached this slice
//
// At 100% every square is attained; at 24% of five it is one attained, one orange,
// three red; at 1% it is orange followed by four red. The orange square is always the
// frontier, which makes a row of them scannable straight down the column.
//
// VIGOR IS THE ONE TO READ. Health says whether a character is about to die; vigor
// says whether it can farm, which is what these characters are for. Farming is combat
// OVER TIME — swinging costs half a point a swing and thirty a minute, and vigor is
// also what sets the health regeneration rate between fights — so a full-health
// character at 20 vigor is not ready for anything, it is queuing for a meal.
const BAR = 5;
function bar(value, max, kind) {
  // Keep the vital's own class even with nothing to show, so "not reported yet" is
  // still identifiably the mana column and the styling cannot silently go missing.
  if (!max || value == null)
    return `<span class="bar-cells ${kind} none" title="not reported yet">${'█'.repeat(BAR)}</span>`;
  const pct = Math.max(0, Math.min(1, value / max));
  let out = '';
  for (let i = 1; i <= BAR; i++) {
    const top = i / BAR, bottom = (i - 1) / BAR;
    // `full` is coloured per vital by the parent class — green for health and vigor,
    // blue for mana — while the frontier and the missing part stay orange and red for
    // every bar, so the shape reads the same way across all three columns.
    const cls = pct >= top ? 'full' : pct > bottom ? 'edge' : 'gone';
    out += `<span class="${cls}">█</span>`;
  }
  return `<span class="bar-cells ${kind}" title="${value}/${max} (${Math.round(pct * 100)}%)">${out}</span>`;
}

// Can it fight, and can it keep fighting? Neither is a stat — both are facts about
// what is in the pack, and both fail silently. An unarmed character punches monsters
// rather than erroring; one with no food never gets vigor back above the 80 that
// resting alone reaches, and simply farms slower for ever.
function yesno(v, { yes = 'Y', no = 'N' } = {}) {
  if (v == null) return '<span class="dim">?</span>';
  return v ? `<span class="good">${yes}</span>` : `<span class="bad">${no}</span>`;
}

// Vitals arrive from the ledger as "16/23" strings, because that is what the fleet
// snapshot reports and the ledger stores rows verbatim.
function pair(s) {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(s ?? ''));
  return m ? { value: Number(m[1]), max: Number(m[2]) } : { value: null, max: null };
}

export const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 90) return s + 's ago';
  if (s < 5400) return Math.round(s / 60) + 'm ago';
  return (s / 3600).toFixed(1) + 'h ago';
};

// `piloted` is the list of character names a desktop client is holding RIGHT NOW, passed
// in rather than read here. The page renders the ledger and the ledger is sampled every
// five minutes, so a pilot claim taken thirty seconds ago would not be in it — and "which
// one am I actually playing" is a question that is useless if it is five minutes stale.
// Passing it keeps the page's read-only property intact: it is a list of names, not a
// route to a session.
export function renderDashboard({ hours = 24, localhost = false, piloted = [] } = {}) {
  const nowPiloted = new Set([].concat(piloted).filter(Boolean).map(n => String(n).toLowerCase()));
  const sinceMs = hours * 3600 * 1000;
  const sum = summarise({ sinceMs });
  const { events } = readLedger({ sinceMs });

  // THE FLEET IS DARK, AND EVERY NUMBER BELOW IS A MEMORY.
  //
  // Worth saying loudly, and worth saying that it is only a memory — but the memory
  // is not stale in the way a cached page is stale. A character that is not in game
  // is out of the world: nothing can move it, hurt it or heal it until it logs back
  // in. So the health and the room shown here are not "what it was last time we
  // looked", they are what it still IS, and will be when the connection returns.
  //
  // The elapsed time is handed over as a number rather than a timestamp so the count
  // is immune to the viewer's clock disagreeing with this machine's — the page counts
  // up from however long it had been when it was rendered.
  // TWO WAYS TO BE IN THE DARK, and the page has to catch both.
  //
  //   every character reports "not in game"  — the broker is alive and telling us
  //   no sample has arrived for minutes      — the broker is not alive to tell us
  //
  // The second is the one that used to be invisible: with nothing writing samples,
  // every character's newest sample is a healthy one and the page reported a fleet in
  // perfect condition indefinitely. Sample age is the only signal that outlives the
  // reporter, so it is checked here rather than trusted to the reporter.
  const NO_NEWS_MS = 3 * 60 * 1000;
  const sampleAge = sum.last_sample_at ? Date.now() - sum.last_sample_at : null;
  const noNews = sampleAge != null && sampleAge > NO_NEWS_MS;
  const darkSince = sum.offline_since ?? (noNews ? sum.last_sample_at : null);
  const offlineForMs = darkSince ? Math.max(0, Date.now() - darkSince) : null;
  const why = sum.offline_since
    ? `every character reports "not in game"`
    : 'no sample has arrived — the broker may not be running';
  const offlineBanner = offlineForMs == null ? '' : `
  <div class="offline-banner" role="status">
    <span>Connection Unavailable — disconnected for <span class="clock" id="offline-clock">…</span></span>
    <span class="since">last seen ${esc(new Date(darkSince).toLocaleTimeString())} · ${esc(why)} ·
      showing each character's last known state, which is still its real one while it is logged out</span>
  </div>`;

  // CONTROLS ARE FOR THE MACHINE THE BROKER IS ON, AND NOWHERE ELSE.
  //
  // This page binds to every interface on purpose — it is meant to be read from a
  // phone — and its whole safety argument is that there is nothing here to abuse: no
  // tools, no sessions, no writes. Buttons are a write, so they are rendered only for
  // 127.0.0.1 and the POST that backs them is refused for anything else. Both halves,
  // because a hidden button is not a permission check.
  //
  // There is no Start button, and there cannot be: when the broker is down nothing is
  // serving this page. Starting is `node tools/m59-service.mjs start`, which is the
  // one thing that genuinely needs a terminal.
  const controls = !localhost ? '' : `
  <div class="controls">
    <span class="ctl-label">this machine only</span>
    <button data-act="rejoin" class="ctl">Rejoin dropped characters</button>
    <button data-act="restart" class="ctl">Restart broker</button>
    <button data-act="stop" class="ctl danger">Stop broker</button>
    <span class="ctl-msg" id="ctl-msg"></span>
  </div>`;

  const goal = 50;
  const atGoal = sum.fleet.filter(r => (r.level ?? 0) >= goal).length;
  const at30 = sum.fleet.filter(r => (r.level ?? 0) >= 30).length;

  const cmp = sum.comparison || [];
  const bestRate = Math.max(...cmp.map(c => c.levels_per_hour ?? 0), 0);

  const strategyRows = cmp.map(c => `
    <tr>
      <td class="name">${esc(c.strategy)}</td>
      <td class="num">${c.characters}</td>
      <td class="num strong">${c.levels_per_hour ?? '—'}</td>
      <td class="bar"><span style="width:${bestRate ? Math.round(100 * (c.levels_per_hour ?? 0) / bestRate) : 0}%"></span></td>
      <td class="num">${c.levels_gained}</td>
      <td class="num ${c.deaths ? 'bad' : ''}">${c.deaths}</td>
      <td class="num">${c.stalls}</td>
      <td class="num dim">${c.hours}</td>
    </tr>`).join('');

  const fleetRows = sum.fleet.map(r => {
    const hp = pair(r.health), mp = pair(r.mana), vg = pair(r.vigor);
    // AT THE CONTROLS. The keeper is stopped while a person holds a character, so this
    // row's numbers are about someone playing rather than something farming — which is
    // the one case where "stalled" and "no kills" mean nothing is wrong.
    const mine = nowPiloted.has(String(r.character ?? '').toLowerCase());
    return `
    <tr${mine ? ' class="piloted"' : ''}>
      <td class="name"><a class="hero" href="/hero/${encodeURIComponent(r.character ?? '')}">${esc(r.character)}</a>${
        mine ? '<span class="pilot-badge" title="a client on the broker machine is holding this character">you</span>' : ''}</td>
      <td class="num strong">${r.level ?? '—'}</td>
      <td class="num ${r.gained_on_strategy > 0 ? 'good' : 'dim'}">${r.gained_on_strategy > 0 ? '+' + r.gained_on_strategy : r.gained_on_strategy}</td>
      <td class="vital">${bar(hp.value, hp.max, 'hp')}<span class="vnum">${esc(r.health ?? '—')}</span></td>
      <td class="vital">${bar(mp.value, mp.max, 'mp')}<span class="vnum">${esc(r.mana ?? '—')}</span></td>
      <td class="vital">${bar(vg.value, vg.max, 'vg')}<span class="vnum">${esc(r.vigor ?? '—')}</span></td>
      <td class="num">${yesno(r.has_food)}</td>
      <td class="num">${yesno(r.has_weapon)}</td>
      <td>${esc(r.strategy ?? '—')}</td>
      <td class="num ${r.deaths ? 'bad' : 'dim'}">${r.deaths}</td>
      <td class="num dim">${r.kills ?? 0}</td>
      <!-- KILLS IN THE LAST HALF HOUR. The lifetime count answers "has this character ever
           worked", which nobody is asking: it is reset by every keeper restart, so on this
           fleet it largely measures uptime, and a character with forty kills and none since
           breakfast renders identically to one earning steadily. Zero here is the row worth
           looking at, so it is coloured rather than dimmed.

           COUNTED FROM "killed" EVENTS IN THE LEDGER, never from a keeper. This column was
           itself the bug for a while: the field was rendered here and never written by
           recordSample, so it was undefined for every character on every render and this
           red zero was the only thing the page could say — about a fleet that was killing
           things the whole time. See countKills() in m59-ledger.mjs. -->
      <td class="num ${(r.kills_30m ?? 0) > 0 ? 'good' : 'bad'}">${r.kills_30m ?? 0}</td>
      <td class="room">${roomLink(r.room, r.room_num)}</td>
      <td class="doing">${esc(r.activity ?? '—')}</td>
    </tr>`;
  }).join('');

  const eventRows = [...events].reverse().slice(0, 60).map(e => `
    <tr>
      <td class="dim">${esc(ago(e.t))}</td>
      <td class="name">${esc(e.character)}</td>
      <td class="ev ${e.kind === 'died' || e.kind === 'level_lost' ? 'bad' : e.kind === 'level_up' ? 'good' : ''}">${esc(e.kind.replace(/_/g, ' '))}</td>
      <td class="dim">${esc(Object.entries(e)
        .filter(([k]) => !['t', 'iso', 'type', 'character', 'kind'].includes(k))
        .map(([k, v]) => `${k}: ${v}`).join(' · '))}</td>
    </tr>`).join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meridian 59 — ${esc(FLEET_LABEL)} fleet</title>
<meta http-equiv="refresh" content="60">
<style>
  :root { color-scheme: light dark; --fg:#1a1a1a; --dim:#767676; --bg:#fbfbfa;
          --panel:#fff; --line:#e6e4e0; --good:#1a7f4b; --bad:#b3261e; --accent:#5b6ee1;
          --edge:#c2700a; --mana:#2563eb; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e6e3; --dim:#8b8b8b; --bg:#16161a; --panel:#1e1e24;
            --line:#2e2e36; --good:#4ade80; --bad:#f87171; --accent:#8b9bff;
            --edge:#fbaa3e; --mana:#60a5fa; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:1.5rem 1rem 4rem; background:var(--bg); color:var(--fg);
         font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 { font-size:1.4rem; margin:0 0 .25rem; letter-spacing:-.01em; }
  .sub { color:var(--dim); font-size:.85rem; margin-bottom:1.5rem; }
  .tabs { display:flex; gap:.25rem; margin:0 0 1.5rem; border-bottom:1px solid var(--line); }
  .tabs a { padding:.5rem .9rem; text-decoration:none; color:var(--dim); font-size:.9rem;
            border-bottom:2px solid transparent; margin-bottom:-1px; }
  .tabs a.on { color:var(--fg); border-bottom-color:var(--accent); font-weight:600; }
  .tabs a:hover { color:var(--fg); }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:.75rem; margin-bottom:1.75rem; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:.85rem 1rem; }
  .card .k { color:var(--dim); font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; }
  .card .v { font-size:1.6rem; font-weight:600; font-variant-numeric:tabular-nums; }
  section { background:var(--panel); border:1px solid var(--line); border-radius:10px;
            padding:1rem 1.1rem; margin-bottom:1.5rem; overflow-x:auto; }
  h2 { font-size:.95rem; margin:0 0 .2rem; }
  .note { color:var(--dim); font-size:.8rem; margin:0 0 .9rem; }
  table { width:100%; border-collapse:collapse; font-size:.86rem; }
  th { text-align:left; font-weight:600; color:var(--dim); font-size:.72rem;
       text-transform:uppercase; letter-spacing:.05em; padding:0 .5rem .45rem; white-space:nowrap; }
  td { padding:.4rem .5rem; border-top:1px solid var(--line); vertical-align:middle; }
  .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .name { font-weight:600; white-space:nowrap; }
  .strong { font-weight:600; }
  .dim { color:var(--dim); }
  .good { color:var(--good); }
  .bad { color:var(--bad); font-weight:600; }
  .room { color:var(--dim); max-width:230px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .room-link { color:var(--dim); text-decoration:none; border-bottom:1px dotted var(--line); }
  .room-link:hover { color:var(--accent); border-bottom-color:var(--accent); }
  a.hero { color:inherit; text-decoration:none; border-bottom:1px solid var(--line); }
  a.hero:hover { color:var(--accent); border-bottom-color:var(--accent); }
  /* THE ONE A PERSON IS HOLDING. A left rule and a wash rather than a colour swap, so it
     still reads at a glance on a phone in daylight and does not collide with the good/bad
     colouring the vitals already use. */
  tbody tr.piloted td { background:color-mix(in srgb, var(--accent) 12%, transparent); }
  tbody tr.piloted td:first-child { box-shadow:inset 3px 0 0 var(--accent); }
  .pilot-badge { margin-left:.5em; padding:.05em .4em; border-radius:3px; font-size:.72em;
                 font-weight:700; letter-spacing:.04em; text-transform:uppercase;
                 background:var(--accent); color:#000; vertical-align:middle; }
  .doing { color:var(--dim); max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  /* Fixed-width blocks, coloured per square. The width never varies with the value —
     the COLOUR carries it — so the column stays scannable and the orange frontier
     lines up down the page. */
  .vital { white-space:nowrap; }
  .bar-cells { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:-1px;
               font-size:1rem; }
  /* The attained colour is per vital — mana is blue so it cannot be mistaken for one
     of the two bars that mean "can this thing survive and keep swinging". The
     frontier and the missing part are orange and red in every bar, so the shape of a
     row reads identically across all three columns. */
  .bar-cells .full { color:var(--good); }
  .bar-cells.mp .full { color:var(--mana); }
  .bar-cells .edge { color:var(--edge); }
  .bar-cells .gone { color:var(--bad); opacity:.5; }
  .bar-cells.none { color:var(--line); }
  .vnum { color:var(--dim); font-size:.72rem; margin-left:.4rem;
          font-variant-numeric:tabular-nums; }
  .bar { width:110px; }
  .bar span { display:block; height:7px; border-radius:4px; background:var(--accent); min-width:2px; }
  .ev { white-space:nowrap; }
  footer { color:var(--dim); font-size:.78rem; text-align:center; }
  /* THE FLEET IS DARK. Loud, because every number under it is a memory. */
  .offline-banner { display:flex; flex-wrap:wrap; align-items:baseline; gap:.5rem .75rem;
    background:var(--bad); color:#fff; border-radius:8px; padding:.7rem .9rem; margin:0 0 1.25rem;
    font-size:.95rem; font-weight:600; }
  .offline-banner .since { font-weight:400; opacity:.9; font-size:.85rem; }
  .offline-banner .clock { font-variant-numeric:tabular-nums; }
  /* Every vital in the table is last-known rather than current while this is on. */
  .stale tbody tr td { opacity:.72; }
  .stale .vital .vnum::after { content:''; }
  .asof { color:var(--dim); font-size:.78rem; font-weight:400; }
  /* Localhost-only controls. Deliberately plain — this is plumbing, not the content. */
  .controls { display:flex; flex-wrap:wrap; align-items:center; gap:.5rem;
    background:var(--panel); border:1px solid var(--line); border-radius:8px;
    padding:.6rem .75rem; margin:0 0 1.25rem; }
  .ctl-label { color:var(--dim); font-size:.72rem; text-transform:uppercase;
    letter-spacing:.06em; margin-right:.25rem; }
  button.ctl { font:inherit; font-size:.85rem; padding:.35rem .7rem; cursor:pointer;
    color:var(--fg); background:var(--bg); border:1px solid var(--line); border-radius:6px; }
  button.ctl:hover:not(:disabled) { border-color:var(--accent); }
  button.ctl:disabled { opacity:.5; cursor:default; }
  button.ctl.danger:hover:not(:disabled) { border-color:var(--bad); color:var(--bad); }
  .ctl-msg { font-size:.82rem; color:var(--dim); }
</style></head>
<body><div class="wrap">
  <h1>Meridian 59 — ${esc(FLEET_LABEL)} fleet</h1>
  <div class="sub">last ${hours}h · ${sum.samples} samples · refreshes every 60s</div>
  <nav class="tabs">
    <a href="/" class="on">Fleet</a>
    <a href="/deaths">Post mortems</a>
    <a href="/tougher">Tougher</a>
  </nav>
${offlineBanner}
${controls}

  <div class="cards">
    <div class="card"><div class="k">characters</div><div class="v">${sum.characters}</div></div>
    <div class="card"><div class="k">levels gained</div><div class="v">${sum.total_levels_gained}</div></div>
    <div class="card"><div class="k">deaths</div><div class="v ${sum.total_deaths ? 'bad' : ''}">${sum.total_deaths}</div></div>
    <div class="card"><div class="k">past 30 hp</div><div class="v">${at30}</div></div>
    <div class="card"><div class="k">at 50 hp</div><div class="v">${atGoal}</div></div>
  </div>

  <section>
    <h2>Strategies</h2>
    <p class="note">Max health gained per hour is the comparison that matters — max health <em>is</em> the level,
      and it is what every pattern is trying to buy. Kills are not a proxy for it: a creature at or below your
      own level fails the advancement test and is worth nothing. Read deaths next; each one costs a point of
      max health outright, so a fast pattern that dies is not fast.</p>
    <table>
      <thead><tr><th>strategy</th><th class="num">chars</th><th class="num">levels/hr</th><th></th>
        <th class="num">gained</th><th class="num">deaths</th><th class="num">stalls</th><th class="num">hours</th></tr></thead>
      <tbody>${strategyRows || '<tr><td colspan="8" class="dim">no strategy data yet</td></tr>'}</tbody>
    </table>
  </section>

  <section>
    <h2>Characters</h2>
    <p class="note">Gained counts only what a character has earned <em>since its current strategy
      began</em>, so earlier history is not charged against a pattern it was never running.
      The three bars are the <em>latest</em> reading, not an average: each is always five squares
      and the colour carries the value —
      <span class="bar-cells"><span class="full">█</span></span> attained
      (<span class="bar-cells mp"><span class="full">█</span></span> for mana),
      <span class="bar-cells"><span class="edge">█</span></span> the slice being eaten into,
      <span class="bar-cells"><span class="gone">█</span></span> gone.
      <strong>Vigor is the one to read.</strong> Health says who is about to die; vigor says who can
      still farm, because farming is combat <em>over time</em> — swinging costs about thirty vigor a
      minute, and vigor is also what sets how fast health comes back between fights. A character at
      full health and low vigor is not ready, it is queuing for a meal. <em>Food?</em> and
      <em>weapon?</em> are the two things that fail silently: an unarmed character punches monsters
      instead of erroring, and one with no food never gets vigor above the 80 that resting alone
      reaches. Rooms link to the compendium.</p>
    <table class="${offlineForMs == null ? '' : 'stale'}">
      <thead><tr><th>character</th><th class="num">level</th><th class="num">gained</th>
        <th>health</th><th>mana</th><th>vigor</th>
        <th class="num">food?</th><th class="num">weapon?</th>
        <th>strategy</th><th class="num">deaths</th><th class="num">kills</th>
        <th class="num" title="kills in the last 30 minutes, counted from the ledger — the column to its left is a high-water mark over the whole window, because a keeper restart zeroes that counter">kills/30m</th><th>where</th>
        <th>doing</th></tr></thead>
      <tbody>${fleetRows || '<tr><td colspan="13" class="dim">nothing recorded yet</td></tr>'}</tbody>
    </table>
  </section>

  <section>
    <h2>What happened</h2>
    <table>
      <thead><tr><th>when</th><th>who</th><th>what</th><th>detail</th></tr></thead>
      <tbody>${eventRows || '<tr><td colspan="4" class="dim">no events yet</td></tr>'}</tbody>
    </table>
  </section>

  <footer>${esc(LEDGER_DIR)} · append-only · keyed by character name</footer>
</div>
<script>
// The disconnected-for clock. Counts up from however long it had already been when
// this page was rendered, NOT from a timestamp — the viewer is often a phone, and a
// phone whose clock is a few minutes off would otherwise show a confidently wrong
// number, or a negative one.
(function () {
  var el = document.getElementById('offline-clock');
  if (!el) return;
  var began = ${offlineForMs == null ? 'null' : offlineForMs}, t0 = Date.now();
  if (began === null) return;
  function fmt(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    var out = x + 's';
    if (h || m) out = m + 'm ' + (x < 10 ? '0' : '') + out;
    if (h) out = h + 'h ' + (m < 10 ? '0' : '') + out;
    return out;
  }
  function tick() { el.textContent = fmt(began + (Date.now() - t0)); }
  tick();
  setInterval(tick, 1000);
})();

// The localhost-only controls. Present only when this page was served to 127.0.0.1;
// the POST is checked again at the server, because a button that is merely absent is
// not a permission check.
(function () {
  var msg = document.getElementById('ctl-msg');
  var btns = document.querySelectorAll('button.ctl');
  if (!btns.length) return;
  function setBusy(on) {
    for (var i = 0; i < btns.length; i++) btns[i].disabled = on;
  }
  function run(act) {
    // Stopping and restarting are how you lose a fleet by misclick, so they ask first.
    if (act !== 'rejoin' &&
        !confirm('This will ' + act + ' the broker. Every keeper runs inside it, so all ' +
                 'characters log out until it is back. Continue?')) return;
    setBusy(true);
    msg.textContent = act + 'ing…';
    fetch('/control/' + act, { method: 'POST' })
      .then(function (r) { return r.json().catch(function () { return { ok: r.ok }; }); })
      .then(function (j) {
        msg.textContent = j && j.note ? j.note : (j && j.ok ? 'done' : 'failed');
        // A restart takes the server that is answering us with it, so do not reload
        // straight away — give it time to come back, then let the page refresh.
        var wait = act === 'rejoin' ? 2000 : 12000;
        if (act !== 'stop') setTimeout(function () { location.reload(); }, wait);
        else setBusy(false);
      })
      .catch(function (e) {
        // A restart kills the connection mid-request; that is success, not failure.
        msg.textContent = act === 'restart' ? 'broker went down — waiting for it to come back'
                                            : 'failed: ' + e.message;
        if (act === 'restart') setTimeout(function () { location.reload(); }, 12000);
        else setBusy(false);
      });
  }
  for (var i = 0; i < btns.length; i++) {
    (function (b) { b.addEventListener('click', function () { run(b.dataset.act); }); })(btns[i]);
  }
})();
</script>
</body></html>`;
}
