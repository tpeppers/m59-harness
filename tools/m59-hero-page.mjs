#!/usr/bin/env node
// EVERYTHING ABOUT ONE CHARACTER THAT THE AGENT DELIBERATELY DOES NOT SEE.
//
// The tools an agent uses are narrow on purpose. A keeper deciding whether to swing
// does not need a skill list, and paying to carry one into every decision would tax
// every decision it makes. But a person asking "why is this one doing badly?" wants
// exactly that: the whole sheet, the pack, what it can still carry, and the last few
// things it did in order.
//
// So this is the other end of the same data — read-only, assembled from state the
// broker already holds, and cross-linked into the compendium so that "wheel of cheese"
// and "blink" are things you click rather than strings you go and look up.
//
// It renders whatever it is handed and reaches for nothing itself. That matters: the
// dashboard server it is served from has no code path to a session, which is the
// property that makes it safe to point at a home network.
import { esc, lore, roomLink } from './m59-dashboard.mjs';
import { NAV } from './m59-page-chrome.mjs';

const clock = t => (t ? new Date(t).toTimeString().slice(0, 8) : '');

const STYLE = `
  :root { color-scheme: light dark; --fg:#1a1a1a; --dim:#767676; --bg:#fbfbfa;
          --panel:#fff; --line:#e6e4e0; --good:#1a7f4b; --bad:#b3261e; --accent:#5b6ee1;
          --edge:#c2700a; --mana:#2563eb; --skip:#8b8b8b; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e6e3; --dim:#8b8b8b; --bg:#16161a; --panel:#1e1e24;
            --line:#2e2e36; --good:#4ade80; --bad:#f87171; --accent:#8b9bff;
            --edge:#fbaa3e; --mana:#60a5fa; --skip:#6b6b6b; }
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:1rem 1rem 3rem; background:var(--bg); color:var(--fg);
         font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  .wrap { max-width:1200px; margin:0 auto; }
  h1 { font-size:1.4rem; margin:0; letter-spacing:-.01em; }
  h2 { font-size:.72rem; text-transform:uppercase; letter-spacing:.07em; color:var(--dim);
       margin:1.1rem 0 .4rem; font-weight:600; }
  .sub { color:var(--dim); font-size:.82rem; margin-bottom:.6rem; }
  /* The fleet tab bar, as m59-page-chrome.mjs draws it on every other board. */
  .tabs { display:flex; gap:.15rem; margin:0 0 .8rem; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  .tabs a { padding:.35rem .7rem; text-decoration:none; color:var(--dim); font-size:.82rem;
            border-bottom:2px solid transparent; margin-bottom:-1px; }
  .tabs a:hover { color:var(--fg); }
  /* THIS CHARACTER'S TABS. Its own data first, then every board narrowed to it. */
  .hhead { display:flex; gap:1rem; align-items:flex-start; justify-content:space-between; flex-wrap:wrap; }
  .hhead .who { flex:1 1 420px; }
  .hhead .faction-priority { flex:0 1 420px; margin:0; padding:.5rem .8rem; }
  .hhead .faction-priority strong { font-size:1rem; }
  .vitals { display:grid; grid-template-columns:repeat(auto-fit,minmax(118px,1fr)); gap:.5rem; margin:.7rem 0 .6rem; }
  .vitals .card { padding:.45rem .7rem; }
  .vitals .val { font-size:1.15rem; }
  .htabs { position:sticky; top:0; z-index:5; background:var(--bg); display:flex; flex-wrap:wrap;
           gap:.1rem .6rem; border-bottom:1px solid var(--line); margin-bottom:.6rem; padding-top:.2rem; }
  .htabs .grp { display:flex; flex-wrap:wrap; }
  .htabs .boards { border-left:1px solid var(--line); padding-left:.5rem; }
  .htabs a { padding:.35rem .6rem; text-decoration:none; color:var(--dim); font-size:.84rem;
             border-bottom:2px solid transparent; margin-bottom:-1px; white-space:nowrap; }
  .htabs a:hover { color:var(--fg); }
  .htabs a.on { color:var(--fg); border-bottom-color:var(--accent); font-weight:600; }
  .htabs .ct { font-size:.7rem; color:var(--dim); font-weight:400; }
  .js .hpanel { display:none; }
  .js .hpanel.on { display:block; }
  .hpanel > h2:first-child, .hpanel .cols > div > h2:first-child { margin-top:.3rem; }
  .bhead { display:flex; gap:.8rem; align-items:baseline; font-size:.85rem; margin:.2rem 0 .4rem; }
  .bhead a { margin-left:auto; color:var(--accent); text-decoration:none; font-size:.8rem; }
  .bhead .reload { font:inherit; border:1px solid var(--line); background:transparent; color:var(--dim);
                   border-radius:6px; cursor:pointer; padding:0 .45rem; }
  iframe.board { width:100%; height:70vh; border:1px solid var(--line); border-radius:10px; background:var(--bg); }
  ul.effects { margin:.2rem 0; padding-left:1.1rem; }
  .back { color:var(--accent); text-decoration:none; font-size:.85rem; }
  .faction-priority { display:flex; align-items:center; justify-content:space-between; gap:1rem;
                      margin:0 0 1rem; padding:.85rem 1rem; background:var(--panel);
                      border:2px solid var(--good); border-radius:10px; }
  .faction-priority.missing { border-color:var(--bad);
                              background:color-mix(in srgb, var(--bad) 7%, var(--panel)); }
  .faction-priority.unknown { border-color:var(--edge);
                              background:color-mix(in srgb, var(--edge) 7%, var(--panel)); }
  .faction-priority .k { color:var(--dim); font-size:.68rem; text-transform:uppercase;
                         letter-spacing:.07em; }
  .faction-priority strong { display:block; font-size:1.2rem; }
  .faction-priority p { max-width:55ch; margin:0; color:var(--dim); font-size:.82rem;
                        text-align:right; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:.5rem; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:.55rem .8rem; }
  .card .k { color:var(--dim); font-size:.68rem; text-transform:uppercase; letter-spacing:.07em; }
  .card .val { font-size:1.2rem; font-weight:600; margin-top:.05rem; }
  .card .sm { font-size:.75rem; color:var(--dim); }
  table { border-collapse:collapse; width:100%; font-size:.87rem; }
  th { text-align:left; color:var(--dim); font-weight:400; font-size:.68rem; text-transform:uppercase;
       letter-spacing:.07em; padding:.3rem .6rem .3rem 0; border-bottom:1px solid var(--line); }
  td { padding:.28rem .6rem .28rem 0; border-bottom:1px solid var(--line); vertical-align:top; }
  .num { text-align:right; font-variant-numeric:tabular-nums; }
  .dim { color:var(--dim); } .good { color:var(--good); } .bad { color:var(--bad); } .skip { color:var(--skip); }
  /* The ability number with its own size behind it. A wash rather than a separate
     column, so the table still fits a phone and the shape is still scannable down the
     page. Fixed 0-100 scale — see the comment where this is built. */
  .ability { position:relative; display:inline-block; min-width:74px; padding:.05rem .4rem;
             border-radius:4px; text-align:right; font-variant-numeric:tabular-nums; }
  .ability i { position:absolute; inset:0 auto 0 0; display:block; border-radius:4px;
               background:color-mix(in srgb, var(--good) 26%, transparent); }
  .ability b { position:relative; font-weight:600; }
  .decay { color:var(--bad); font-size:.75em; margin-left:.25em; }
  .detail { max-width:430px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  a.lore, a.room-link { color:var(--accent); text-decoration:none; border-bottom:1px dotted var(--line); }
  a.lore:hover, a.room-link:hover { border-bottom-color:var(--accent); }
  .cols { display:grid; grid-template-columns:3fr 2fr; gap:1.5rem; }
  @media (max-width:760px){
    .cols { grid-template-columns:1fr; }
    .faction-priority { align-items:flex-start; flex-direction:column; }
    .faction-priority p { text-align:left; }
  }
  .launch { display:inline-flex; align-items:center; gap:.8rem; background:var(--panel);
            border:1px solid var(--line); border-radius:10px; padding:.8rem 1.1rem; cursor:pointer;
            font:inherit; color:inherit; text-align:left; }
  .launch:hover { border-color:var(--accent); }
  .launch .ico { font-size:1.8rem; line-height:1; }
  .launch .t { font-weight:700; letter-spacing:.05em; }
  .launch .s { font-size:.73rem; color:var(--dim); }
  .warn { color:var(--edge); font-size:.82rem; max-width:62ch; }
  .free { height:6px; background:var(--line); border-radius:3px; overflow:hidden; margin-top:.35rem; }
  .free span { display:block; height:100%; background:var(--accent); }
  .goap-step { display:inline-block; background:var(--line); border-radius:4px;
    padding:.15rem .55rem; font-family:ui-monospace,monospace; font-size:.85rem; }
  .goap-arrow { color:var(--accent); margin:0 .4rem; font-weight:700; }
  .room-grid { display:grid; gap:1px; background:var(--line); border:1px solid var(--line);
    border-radius:4px; padding:2px; margin-top:.4rem; }
  .room-cell { width:8px; height:8px; background:var(--bg); border-radius:1px; }
  .room-cell.self { background:#4a9; }
  .room-cell.npc { background:#a75; }
  .room-cell.player { background:#a44; }
`;

// Render the GOAP plan: the goal the planner is chasing, the chain of
// actions it found (or the reason it found none), and the world state it
// saw when it planned. A visible plan is the only plan you can argue with.
function renderGoap(g) {
  if (!g) return '<p class="dim">No plan yet.</p>';
  const chain = (g.names && g.names.length)
    ? g.names.map((n, i) =>
        `<span class="goap-step">${esc(n)}</span>` +
        (i < g.names.length - 1 ? '<span class="goap-arrow">&rarr;</span>' : '')).join('')
    : '<span class="dim">no plan</span>';
  const status = g.found
    ? '<span class="good">found</span>'
    : `<span class="bad">${esc(g.reason ?? 'no plan')}</span>`;
  const age = g.at ? Math.max(0, Math.round((Date.now() - g.at) / 1000)) : null;
  return `<div class="cards">
    <div class="card"><div class="k">goal</div>
      <div class="val" style="font-size:1.1rem">${esc(g.goal ?? '—')}</div>
      <div class="sm">${status}${age != null ? ` · ${age}s ago` : ''}</div></div>
    <div class="card" style="grid-column:span 2"><div class="k">plan</div>
      <div class="val" style="font-size:1rem;margin-top:.2rem">${chain}</div></div>
    <div class="card" style="grid-column:span 3"><div class="k">world state when it planned</div>
      <div class="sm" style="margin-top:.3rem;font-family:ui-monospace,monospace">${esc(g.ws ?? '—')}</div></div>
  </div>`;
}

// Render a top-down room view: a grid of cells with colored markers.
// Green = self, orange = NPC, red = player. Shows where the character
// is standing relative to everything else in the room.
function renderRoomView(rv, name) {
  if (!rv || !rv.objects || !rv.objects.length) return '';
  const { cols, rows, self, objects } = rv;
  if (!cols || !rows) return '';
  // Build a set of positions for O(1) lookup.
  const cells = new Map();
  for (const o of objects) {
    if (o.col == null || o.row == null) continue;
    const key = `${o.col},${o.row}`;
    if (o.is_self) cells.set(key, 'self');
    else if (o.is_player && !cells.has(key)) cells.set(key, 'player');
    else if (!cells.has(key)) cells.set(key, 'npc');
  }
  let grid = `<div class="room-grid" style="grid-template-columns:repeat(${cols},8px)">`;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cls = cells.get(`${c},${r}`) ?? '';
      grid += `<div class="room-cell ${cls}" title="${c},${r}${cls ? ' ' + cls : ''}"></div>`;
    }
  }
  grid += '</div>';
  const count = (type) => objects.filter(o => o.is_self ? type === 'self' : o.is_player ? type === 'player' : type === 'npc').length;
  const legend = `<div class="sm" style="margin-top:.3rem">
    <span class="room-cell self" style="display:inline-block;vertical-align:middle"></span> self${self ? ` (${self.col},${self.row})` : ''} ·
    <span class="room-cell npc" style="display:inline-block;vertical-align:middle"></span> ${count('npc')} npc ·
    <span class="room-cell player" style="display:inline-block;vertical-align:middle"></span> ${count('player')} player ·
    ${cols}×${rows} grid</div>`;
  return `<h2>Room <a href="/room3d/${esc(name ?? 'character')}" style="font-size:.7rem;font-weight:normal">3D view</a></h2>${grid}${legend}`;
}

export function renderHero(h, { localhost = false } = {}) {
  if (!h) {
    return '<!doctype html><meta charset=utf-8><title>unknown character</title>' +
      '<p style="font:15px system-ui;padding:2rem">No character by that name is in the fleet. ' +
      '<a href="/fleet">Back to the fleet</a>.</p>';
  }

  const v = h.vitals || {};
  const hp = v.health || {}, mp = v.mana || {}, vg = v.vigor || {};
  const carried = h.inventory?.length ?? 0;
  const cap = h.max_carry ?? null;
  const freePct = cap ? Math.max(0, Math.round(100 * (cap - carried) / cap)) : null;
  const faction = h.faction_status || {};
  const factionLabels = { duke: 'The Duke', princess: 'The Princess', rebel: 'The Rebels' };
  const factionKnown = Object.hasOwn(factionLabels, faction.faction);
  const factionNeutral = faction.faction === 'neutral';
  const factionLabel = factionKnown ? factionLabels[faction.faction]
    : factionNeutral ? 'No faction' : 'Faction not yet known';
  const factionDetail = factionKnown
    ? `${faction.soldier ? 'Faction soldier' : 'Faction member'}${faction.observed_at
      ? ` · observed ${new Date(faction.observed_at).toLocaleString()}` : ''}`
    : factionNeutral
      ? 'Needs to join a faction. Assign the Duke, Princess, or Rebels in Faction Management.'
      : 'The player profile has not been cached yet. Inspect it before assigning a join goal.';

  const items = (h.inventory || []).map(i => `
    <tr><td>${lore(i.name)}</td>
        <td class="num dim">${i.amount ?? ''}</td>
        <td class="dim">${esc((i.can || []).join(', '))}</td></tr>`).join('');

  // WHICH SCHOOL, BY NAME — AND THE NUMBER ON THE ROW IS NOT THE NUMBER IN THE HEADER.
  //
  // This cell used to print the raw value, so the column read "spell · 2": a bare number
  // sitting beside the ability percentage, looking exactly like a second fact about how
  // good you are at it. Naming it is the fix, and the naming has a trap in it.
  //
  // `m59-parse.mjs:763` reads the spell list as `school: r.u8() - 1`, so what reaches us
  // is ALREADY ONE BELOW the constant in blakston.khd:2029-2038. Keying this table on the
  // client's value would have been a table of plausible wrong answers — every spell named
  // as the school below its own, with nothing to notice, because "create food · Qor" is a
  // perfectly sensible-looking row. It was caught by checking against a spell whose school
  // this repository already states in prose: create food is KRAANAN (m59-autopilot.mjs:905),
  // and it came out Qor.
  //
  // So the table stays keyed on the kod constant — the citable thing — and the +1 is
  // applied at the lookup, where the comment explaining it can sit next to it. Skill
  // schools start at 10 in the same enum, deliberately, so the two sets can share the
  // field without colliding.
  const SCHOOLS = { 1: "Shal'ille", 2: 'Qor', 3: 'Kraanan', 4: 'Faren',
                    5: 'Riija', 6: 'Jala', 7: 'DM command',
                    10: 'fencing', 11: 'brawling', 12: 'telepathy', 13: 'thievery' };
  // An id nothing names is shown as itself rather than dropped: a school this table has
  // not heard of is worth seeing, and silently blanking it would hide a new one for ever.
  // Kod 0 is the non-school the touch-attack pseudo-spell carries, and arrives here as -1.
  const schoolOf = (s) => {
    if (s == null) return null;
    const kod = Number(s) + 1;
    if (kod === 0) return null;
    return SCHOOLS[kod] ?? `school ${kod}`;
  };

  // HOW GOOD IS IT AT EACH ONE. The number runs 0-100 and is the only signal that
  // practice is working, so it is the column this table exists for — sorted on it, drawn
  // against a fixed 0-100 rather than against this character's own best, so a character
  // that is uniformly poor looks it.
  //
  // A blank here is not a zero. It means nobody has read that group yet, which happens
  // for a few minutes after a broker restart until the ability sweep reaches this
  // character — so it renders as "not read" rather than as a number.
  const bar = (n) => `<span class="ability"><i style="width:${Math.max(2, Math.min(100, n))}%"></i>` +
                     `<b>${n}</b></span>`;
  const abilities = [
    ...(h.skills || []).map(s => ({ ...s, kind: 'skill' })),
    ...(h.spells || []).map(s => ({ ...s, kind: 'spell' })),
  ].sort((a, b) => (b.ability ?? -1) - (a.ability ?? -1) ||
                   String(a.name).localeCompare(String(b.name)))
   .map(a => {
    // Peaked higher than it stands: what you stop using decays when the advancement
    // window rolls over, silently, and this is the only place a person would see it.
    const decayed = a.best != null && a.ability != null && a.best > a.ability;
    return `
    <tr><td>${lore(a.name)}</td>
        <td class="dim">${esc(a.kind)}${schoolOf(a.school) ? ' · ' + esc(schoolOf(a.school)) : ''}</td>
        <td class="num">${a.ability == null
            ? '<span class="dim" title="no ability read has arrived for this group yet — not the same as zero">not read</span>'
            : bar(a.ability)}${decayed
            ? ` <span class="decay" title="peaked at ${a.best}, so this one has atrophied — what you stop using decays when the advancement window rolls over">↓${a.best - a.ability}</span>`
            : ''}</td></tr>`;
  }).join('');

  const stats = Object.entries(h.stats || {}).map(([k, val]) => `
    <tr><td class="dim">${esc(k)}</td><td class="num">${esc(val)}</td></tr>`).join('');

  const effects = (h.effects || []).map(e => `<li>${esc(e)}</li>`).join('');

  const journalRows = (n) => (h.journal || []).slice(-n).reverse().map(e => `
    <tr><td class="dim">${esc(clock(e.at))}</td>
        <td>${esc(e.what)}</td>
        <td class="dim detail">${esc(Object.entries(e)
          .filter(([k]) => !['at', 'pass', 'what'].includes(k))
          .map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x) : x}`)
          .join(' · '))}</td></tr>`).join('');

  const trials = (h.trials || []).slice(-14).reverse().map(t => `
    <tr><td class="dim">${esc(clock(t.at))}</td>
        <td class="${!t.counted ? 'skip' : /HIT/.test(t.verdict) ? 'bad' : 'good'}">${esc(t.verdict)}</td>
        <td class="dim">${t.window_s ?? '?'}s · hp ${t.health_before ?? '?'}→${t.health_after ?? '?'} · ${t.adjacent_at_start} adj</td></tr>`).join('');

  const name = h.name ?? '?';
  const href = encodeURIComponent(name);

  // ONE CHARACTER, EVERY BOARD. Operator, 2026-11-04: the hero page as a single page with
  // tabs, and a tab for each fleet board showing that board's data for this character only.
  // The board tabs are the boards THEMSELVES, framed with `?who=<name>&embed=1` — the broker
  // narrows the data and m59-page-filter.mjs hides the chrome — rather than a second
  // rendering of each one here, because a summary written twice is a summary that disagrees
  // with its source the first time either is changed. They load when first opened: some of
  // these boards cost the broker real work, and nobody opens all fifteen.
  //
  // /pvp and /communications name strangers and are served on loopback only, so their tabs
  // are offered only where they would load.
  const BOARDS = [
    ['deaths', 'Post mortems', '/deaths'],
    ['tougher', 'Tougher', '/tougher'],
    ['travel', 'Travel', '/travel'],
    ['skills', 'Skills', '/skills'],
    ['practice', 'Spell practice', '/practice'],
    ['couriers', 'Couriers', '/couriers'],
    ['economy', 'Economy', '/economy'],
    ['inventory', 'Inventory', '/inventory'],
    ['stats', 'Build', '/stats'],
    ['faction', 'Factions', '/faction'],
    ['maximums', 'Maximums', '/maximums'],
    ['harness', 'Harness', '/harness'],
    ['dum', 'DUM bot', '/dum'],
    ...(localhost ? [['pvp', 'PVP', '/pvp'], ['communications', 'Comms', '/communications']] : []),
  ];
  const boardSrc = (path) => `${path}?who=${href}&embed=1`;
  const fullSrc = (path) => `${path}?who=${href}`;
  const OWN = [
    ['overview', 'Overview'],
    ['pack', `Pack <span class="ct">${carried}</span>`],
    ['abilities', `Abilities <span class="ct">${(h.skills?.length ?? 0) + (h.spells?.length ?? 0)}</span>`],
    ['log', 'Log'],
    ['play', 'Play'],
  ];

  const ownPanel = (key, body) => `<section class="hpanel" id="p-${key}" data-own="1">${body}</section>`;
  const boardPanel = ([key, label, path]) => `<section class="hpanel" id="p-${key}">
    <div class="bhead"><b>${esc(label)}</b> <span class="dim">for ${esc(name)}</span>
      <a href="${fullSrc(path)}" target="_top">open the full board ↗</a>
      <button type="button" class="reload" data-reload="${key}" title="reload this tab">↻</button></div>
    <iframe class="board" data-src="${boardSrc(path)}" title="${esc(label)} for ${esc(name)}" loading="lazy"></iframe>
    <noscript><a href="${fullSrc(path)}">${esc(label)} for ${esc(name)}</a></noscript>
  </section>`;

  const overview = `
  <div class="cols">
    <div>
      <h2>GOAP plan</h2>
      ${h.goap ? renderGoap(h.goap) : '<p class="dim">Not running the GOAP keeper.</p>'}

      <h2>Safe spot</h2>
      ${h.safe_spot ? `<div class="cards">
        <div class="card"><div class="k">standing at</div>
          <div class="val" style="font-size:1.05rem">${h.safe_spot.at.col}, ${h.safe_spot.at.row}</div>
          <div class="sm">${h.safe_spot.works
            ? '<span class="good">holds under attack</span>' : 'untested'}</div></div>
        <div class="card"><div class="k">on us</div>
          <div class="val">${h.threat?.in_swing_range ?? 0}</div>
          <div class="sm">${h.threat?.camped_on_us ?? 0} camped${
            (h.threat?.what || []).length ? ' · ' + esc(h.threat.what.join(', ')) : ''}</div></div>
        <div class="card" style="grid-column:1/-1"><div class="k">evidence</div>
          <div class="sm" style="margin-top:.2rem">${esc(h.safe_spot.evidence)}</div></div>
       </div>` : '<p class="dim">Not holding one.</p>'}
      ${trials ? `<table style="margin-top:.6rem">
        <thead><tr><th>time</th><th>reading</th><th>inputs</th></tr></thead>
        <tbody>${trials}</tbody></table>` : ''}

      <h2>Survival</h2>
      <div class="cards">
        <div class="card"><div class="k">deaths</div><div class="val ${h.deaths ? 'bad' : ''}">${h.deaths ?? 0}</div>
          <div class="sm"><a href="#deaths">post mortems →</a></div></div>
        <div class="card"><div class="k">in a safe spot</div>
          <div class="val ${h.deaths_in_safe_spot ? 'bad' : 'good'}">${h.deaths_in_safe_spot ?? 0}</div>
          <div class="sm">${h.deaths_in_proven_safe_spot ?? 0} in a proven one</div></div>
        <div class="card"><div class="k">mulligans</div><div class="val">${h.mulligans ?? 0}</div>
          <div class="sm">fights re-taken from full</div></div>
        <div class="card"><div class="k">logoffs</div><div class="val">${h.logoffs ?? 0}</div>
          <div class="sm">deaths avoided by disconnecting</div></div>
      </div>
    </div>
    <div>
      ${h.room_view ? renderRoomView(h.room_view, h.name) : ''}
      ${effects ? `<h2>Status effects</h2><ul class="dim effects">${effects}</ul>` : ''}
      <h2>Stats</h2>
      <table><tbody>${stats || '<tr><td class="dim">none reported</td></tr>'}</tbody></table>
      <h2>Latest</h2>
      <table data-nofilter><tbody>${journalRows(6) || '<tr><td colspan="3" class="dim">nothing yet</td></tr>'}</tbody></table>
      <div class="sm"><a href="#log">the whole log →</a></div>
    </div>
  </div>`;

  const play = localhost ? `
    <button class="launch" onclick="grab()">
      <span class="ico">&#128481;</span>
      <span><span class="t">START AS ${esc(String(name).toUpperCase())}</span><br>
      <span class="s">copies a PowerShell command that launches the client logged in as this
      character, then injects the agent DLL so the MCP can drive it too</span></span>
    </button>
    <p class="sub" style="margin-top:.6rem">
      or <a class="lore" href="/hero/${href}/start.ps1">download start.ps1</a></p>
    <script>
      async function grab() {
        const r = await fetch('/hero/${href}/start.ps1');
        const t = await r.text();
        try {
          await navigator.clipboard.writeText(t);
          alert('The script is on your clipboard. Save it as start.ps1 and run it,\\nor use the download link.');
        } catch (e) { window.prompt('Copy this script:', t); }
      }
    </script>`
    : `<p class="warn">Withheld. This page is reachable from the network and the launcher carries
       the account password in plain text, so it is only offered to a browser running on the
       machine the broker is on. Open <code>http://127.0.0.1</code> rather than the LAN address
       to get it.</p>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} — Meridian 59</title>
<style>${STYLE}</style>
<script>document.documentElement.classList.add('js')</script></head>
<body><div class="wrap">
  ${NAV('')}
  <header class="hhead">
    <div class="who">
      <h1>${esc(name)}</h1>
      <div class="sub">${esc(h.agent ?? '')} · ${esc(h.strategy ?? 'no strategy')} ·
        ${h.in_game ? 'in game' : '<span class="bad">not in game</span>'} ·
        ${roomLink(h.room?.name, h.room?.num)}
        ${h.room ? `<a href="/room3d/${esc(h.name)}" style="font-size:.75rem;margin-left:6px">3D view</a>` : ''}
        ${h.position ? `<span class="dim">(col ${h.position.col}, row ${h.position.row})</span>` : ''}
        · <b>${esc(h.activity ?? '—')}</b></div>
    </div>
    <section class="faction-priority ${factionNeutral ? 'missing' : factionKnown ? 'member' : 'unknown'}"
             aria-label="Faction status">
      <div><span class="k">Faction</span><strong>${esc(factionLabel)}</strong></div>
      <p>${esc(factionDetail)}</p>
    </section>
  </header>

  <div class="vitals">
    <div class="card"><div class="k">health</div>
      <div class="val">${hp.value ?? '—'}<span class="sm"> / ${hp.max ?? '—'}</span></div>
      <div class="sm" title="max health is the level">${h.ceiling != null ? `cap ${h.ceiling}` : 'max = level'}</div></div>
    <div class="card"><div class="k">mana</div>
      <div class="val">${mp.value ?? '—'}<span class="sm"> / ${mp.max ?? '—'}</span></div></div>
    <div class="card"><div class="k">vigor</div>
      <div class="val">${vg.value ?? '—'}<span class="sm"> / ${vg.scale_max ?? 200}</span></div>
      <div class="sm">${vg.rested === true ? 'rested' : vg.rest_threshold != null
        ? `rests to ${vg.rest_threshold}` : ''}</div></div>
    <div class="card"><div class="k">carrying</div>
      <div class="val">${carried}<span class="sm"> / ${cap ?? '?'}</span></div>
      ${freePct != null ? `<div class="free"><span style="width:${100 - freePct}%"></span></div>` : '<div class="sm">no keeper limit</div>'}</div>
    <div class="card"><div class="k">stamina</div><div class="val">${h.stamina ?? '—'}</div></div>
    <div class="card"><div class="k">deaths</div><div class="val ${h.deaths ? 'bad' : ''}">${h.deaths ?? 0}</div></div>
  </div>

  <nav class="htabs" aria-label="${esc(name)}">
    <span class="grp">${OWN.map(([k, l]) => `<a href="#${k}" data-tab="${k}">${l}</a>`).join('')}</span>
    <span class="grp boards">${BOARDS.map(([k, l]) => `<a href="#${k}" data-tab="${k}">${esc(l)}</a>`).join('')}</span>
  </nav>

  ${ownPanel('overview', overview)}
  ${ownPanel('pack', `<table><thead><tr><th>item</th><th class="num">n</th><th>can</th></tr></thead>
    <tbody>${items || '<tr><td colspan="3" class="dim">nothing at all</td></tr>'}</tbody></table>`)}
  ${ownPanel('abilities', `<table><thead><tr><th>name</th><th>kind</th>
    <th class="num" title="ability, 0-100 — the only signal that practice is working">at</th></tr></thead>
    <tbody>${abilities || '<tr><td colspan="3" class="dim">none known</td></tr>'}</tbody></table>`)}
  ${ownPanel('log', `<table><thead><tr><th>time</th><th>what</th><th>detail</th></tr></thead>
    <tbody>${journalRows(30) || '<tr><td colspan="3" class="dim">nothing yet</td></tr>'}</tbody></table>`)}
  ${ownPanel('play', play)}
  ${BOARDS.map(boardPanel).join('')}

  <footer class="sub" style="margin-top:2rem">live from the broker · this character's own tabs refresh every 20s;
    a board tab refreshes on its own clock</footer>
</div>
<script>
(function () {
  var tabs = document.querySelectorAll('.htabs [data-tab]');
  var cur = null;
  function show(key) {
    var panel = document.getElementById('p-' + key);
    if (!panel) { key = 'overview'; panel = document.getElementById('p-overview'); }
    cur = key;
    document.querySelectorAll('.hpanel').forEach(function (p) { p.classList.toggle('on', p === panel); });
    tabs.forEach(function (t) { t.classList.toggle('on', t.dataset.tab === key); });
    var f = panel.querySelector('iframe[data-src]');
    if (f && !f.getAttribute('src')) f.src = f.dataset.src;
    if (location.hash.slice(1) !== key) history.replaceState(null, '', '#' + key);
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (a && document.getElementById('p-' + a.getAttribute('href').slice(1))) {
      e.preventDefault(); show(a.getAttribute('href').slice(1)); window.scrollTo(0, document.querySelector('.htabs').offsetTop - 8);
    }
    var r = e.target.closest && e.target.closest('[data-reload]');
    if (r) { var fr = document.querySelector('#p-' + r.dataset.reload + ' iframe'); if (fr) fr.src = fr.dataset.src; }
  });
  window.addEventListener('hashchange', function () { show(location.hash.slice(1)); });
  // A framed board says how tall it is (m59-page-filter.mjs), so it never scrolls inside a scroll.
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || !e.data.m59height) return;
    document.querySelectorAll('iframe.board').forEach(function (f) {
      if (f.contentWindow === e.source) f.style.height = Math.max(200, e.data.m59height + 12) + 'px';
    });
  });
  // The old page refreshed itself every 20s. Now only this character's own tabs do, and only
  // while somebody is looking — reloading a framed board every 20s would re-run it for nothing.
  setInterval(function () {
    var p = document.getElementById('p-' + cur);
    if (!document.hidden && p && p.dataset.own) location.reload();
  }, 20000);
  show(location.hash.slice(1) || 'overview');
})();
</script>
</body></html>`;
}

// The launcher itself. Two steps that are otherwise done by hand every time: start
// the client already logged in as this character, and inject the agent DLL so the
// same character can also be driven through the MCP.
//
// /U /W /H /P are the client's own switches, and /Q skips the splash.
export function startScript(h, { repo, host, port }) {
  const c = h.credentials || {};
  return `# Start Meridian 59 as ${h.name} and hand the client to the agent DLL.
#
# Generated by the fleet dashboard. It contains a password in plain text, which is
# why the page only offers it to a browser on this machine — treat the file the same
# way and delete it when you are done.

$client = "${(h.client_path || 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Meridian 59\\Meridian.exe').replace(/"/g, '`"')}"
if (-not (Test-Path $client)) { Write-Error "client not found at $client"; exit 1 }

Start-Process -FilePath $client -ArgumentList @(
  '/H:${host}', '/P:${port}', '/U:${c.account ?? ''}', '/W:${c.password ?? ''}', '/Q'
)

# The client has to be up before anything can be injected into it, and it has to be
# the FOREGROUND window afterwards or it ignores movement entirely: HandleKeys returns
# early unless GetFocus() is the client, so a minimised client accepts turns and drops
# every step.
Start-Sleep -Seconds 6
& powershell -NoProfile -ExecutionPolicy Bypass -File "${repo}\\tools\\m59-inject.ps1"

Write-Host ""
Write-Host "Launched as ${h.name}. Keep the client window focused for movement to work."
`;
}
