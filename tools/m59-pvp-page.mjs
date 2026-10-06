// m59-pvp-page.mjs -- the /pvp dashboard tab: battles against players, kills and deaths.
//
// Reads tools/m59-pvp.mjs and draws it. Everything is server-rendered and readable with the
// broker down, like every other board; the only interaction is <details>. Names real players,
// so the broker serves it on loopback only (see the /players route).

import { readFileSync } from 'node:fs';
import { NAV, STYLE, esc, ago } from './m59-page-chrome.mjs';
import { pvpReport, DEFAULT_GAP_MS } from './m59-pvp.mjs';
import { movementMapFile } from './m59-map-path.mjs';

// Room numbers to names, read once from the movement map. A page that cannot read it shows the
// number alone, which is still a correct answer.
let ROOM_NAMES = null;
function roomName(num) {
  if (ROOM_NAMES === null) {
    ROOM_NAMES = {};
    try {
      const map = JSON.parse(readFileSync(movementMapFile(), 'utf8'));
      for (const [k, r] of Object.entries(map.rooms ?? map)) if (r?.name) ROOM_NAMES[r.num ?? k] = r.name;
    } catch { /* numbers only */ }
  }
  return ROOM_NAMES[num] ?? null;
}

const utc = t => new Date(t).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
function dur(ms) {
  if (ms < 10_000) return (ms / 1000).toFixed(2).replace(/\.?0+$/, '') + ' s';
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} m ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} m`;
}
const offset = ms => `${ms < 0 ? '−' : '+'}${(Math.abs(ms) / 1000).toFixed(3)}s`;

const RESULT = {
  won: ['won', 'var(--good)'], lost: ['lost', 'var(--bad)'],
  traded: ['traded', 'var(--edge)'], skirmish: ['no deaths', 'var(--dim)'],
};

function roomsLabel(b) {
  return b.rooms.map(r => {
    const n = b.room_names[r] ?? roomName(r);
    return `${esc(n ?? 'room')} <span class="dim">${esc(r)}</span>`;
  }).join(' → ') || '<span class="dim">room unknown</span>';
}

function describe(e) {
  if (e.kind === 'death') {
    const guess = e.guess ? ' <span class="dim">(killer inferred)</span>' : '';
    const how = e.how ? ` <span class="dim">· ${esc(e.how)}</span>` : '';
    return e.our_death
      ? `<span class="bad">☠ ${esc(e.victim)}</span> killed by <b>${esc(e.killer ?? '?')}</b>${how}${guess}`
      : `<span class="good">⚔ ${esc(e.victim)}</span> killed by <b>${esc(e.killer ?? '?')}</b>${how}` +
        (e.source === 'reconstructed' && e.evidence ? ` <span class="dim">— ${esc(e.evidence)}</span>` : '');
  }
  if (e.kind === 'combat') {
    const who = `<b>${esc(e.observer ?? '?')}</b>`;
    const target = e.target ?? e.attackers?.[0]?.character ?? '?';
    switch (e.event) {
      case 'pvp_attacked': return `${who} turns on ${esc(target)}`;
      case 'triggered': return `${who} engages ${esc(target)}`;
      case 'wand_volley': return `${who} fires ${esc(e.wand ?? 'a wand')} at ${esc(target)}`;
      case 'wand_refused': return `${who}'s wand is refused <span class="dim">(nothing happens)</span>`;
      case 'pvp_outcome': {
        const lo = e.last_outcome;
        if (!lo) return `${who}: outcome`;
        const cls = lo.direction === 'outgoing' ? (lo.outcome === 'hit' ? 'good' : 'dim') : (lo.outcome === 'hit' ? 'bad' : 'dim');
        return `${who}: <span class="${cls}">${esc(lo.text ?? `${lo.direction} ${lo.outcome}`)}</span>`;
      }
      case 'finished': return `${who} stands down <span class="dim">— ${esc(e.reason ?? e.outcome ?? '')}</span>`;
      default: return `${who} ${esc(e.event)}`;
    }
  }
  if (e.kind === 'alarm') return `<b>${esc(e.observer ?? '?')}</b> raises the alarm: ${esc(e.enemies?.[0] ?? '?')} <span class="dim">(${esc(e.basis)})</span>`;
  return `${e.observer ? `<b>${esc(e.observer)}</b> ` : ''}${esc(e.text ?? e.event ?? e.kind)}`;
}

// THE SCENE, WHEN ONE WAS KEPT: who stood on which square, facing where, as one picture. Squares
// are the coarse grid (rNcM); several bodies on one square are listed together rather than drawn
// on top of each other, which is what a room with nine of ours in three squares needs.
function sceneSvg(scene) {
  const actors = scene?.actors ?? [];
  if (!actors.length) return '';
  const rows = actors.map(a => a.row), cols = actors.map(a => a.col);
  const r0 = Math.min(...rows) - 1, r1 = Math.max(...rows) + 1, c0 = Math.min(...cols) - 1, c1 = Math.max(...cols) + 1;
  const S = 46, W = (c1 - c0 + 1) * S, H = (r1 - r0 + 1) * S;
  const x = c => (c - c0) * S + S / 2, y = r => (r - r0) * S + S / 2;
  const bySquare = new Map();
  for (const a of actors) { const k = `${a.row},${a.col}`; (bySquare.get(k) ?? bySquare.set(k, []).get(k)).push(a); }
  const colour = side => side === 'enemy' ? 'var(--bad)' : side === 'ours' ? 'var(--accent)' : 'var(--dim)';
  let g = '';
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++)
    g += `<rect x="${(c - c0) * S}" y="${(r - r0) * S}" width="${S}" height="${S}" class="sq"/>`;
  for (const p of scene.paths ?? []) {
    g += `<line x1="${x(p.from.col)}" y1="${y(p.from.row)}" x2="${x(p.to.col)}" y2="${y(p.to.row)}" class="path"/>`;
  }
  let n = 0;
  const legend = [];
  for (const [, group] of bySquare) {
    const a0 = group[0];
    n++;
    const cx = x(a0.col), cy = y(a0.row);
    for (const a of group) if (Number.isFinite(a.facing)) {
      // kod angles: 0 is east and they increase CLOCKWISE as rows grow downward
      // (m59-game.mjs faceToward), so screen y takes +sin.
      const rad = a.facing * Math.PI / 180;
      g += `<line x1="${cx}" y1="${cy}" x2="${cx + Math.cos(rad) * 18}" y2="${cy + Math.sin(rad) * 18}" stroke="${colour(a.side)}" stroke-width="2" opacity=".7"/>`;
    }
    const side = group.some(a => a.side === 'enemy') ? 'enemy' : a0.side;
    g += `<circle cx="${cx}" cy="${cy}" r="9" fill="${colour(side)}"/>`;
    g += `<text x="${cx}" y="${cy + 4}" class="num">${n}</text>`;
    legend.push(`<li><b>${n}</b> <span class="dim">r${a0.row}c${a0.col}</span> ${group.map(a => `<span style="color:${colour(a.side)}">${esc(a.name)}</span>${Number.isFinite(a.facing) ? ` <span class="dim">${a.facing}°</span>` : ''}${a.note ? ` <span class="dim">— ${esc(a.note)}</span>` : ''}`).join(', ')}</li>`);
    g += `<title>${esc(group.map(a => `${a.name} r${a.row}c${a.col}${Number.isFinite(a.facing) ? ` facing ${a.facing}°` : ''}${a.note ? ` — ${a.note}` : ''}`).join('\n'))}</title>`;
  }
  return `<figure class="scene"><div class="scenebox"><svg viewBox="0 0 ${W} ${H}" width="${W}" style="max-width:100%;height:auto">${g}</svg>
    <ol class="legend">${legend.join('')}</ol></div>
    <figcaption>${esc(scene.caption ?? '')} <span class="dim">Squares r${r0 + 1}–${r1 - 1}, c${c0 + 1}–${c1 - 1}. Blue: ours. Red: enemy. Grey: bystander. Tick: facing (kod degrees, 0 = east, clockwise).</span></figcaption></figure>`;
}

function battleHtml(b, i) {
  const [label, colour] = RESULT[b.result] ?? [b.result, 'var(--dim)'];
  const foes = b.enemies.map(f => `<b>${esc(f.name)}</b>${f.guild ? ` <span class="dim">of ${esc(f.guild.replace(/^the\s+/i, ''))}</span>` : ''}`).join(', ') || '<span class="dim">unnamed</span>';
  const timeline = b.events;
  const t0 = b.start;
  const rows = timeline.map(e => `<tr${e.context ? ' class="ctx"' : ''}><td class="num">${offset(e.at - t0)}</td><td class="dim">${esc(utc(e.at).slice(11, 19))}</td><td>${e.room != null ? esc(e.room) : ''}</td><td>${describe(e)}</td></tr>`).join('');
  const oursRows = b.ours.map(o => `<tr><td>${esc(o.name)}</td><td class="num">${o.kills || ''}</td><td class="num">${o.deaths ? `<span class="bad">${o.deaths}</span>` : ''}</td><td class="num">${o.volleys || ''}</td><td class="num">${o.refused || ''}</td><td class="num">${o.hits_out || ''}</td><td class="num">${o.hits_in || ''}</td></tr>`).join('');
  const rec = b.reconstructed;
  return `<section class="panel battle" id="${esc(b.id)}">
    <div class="bhead">
      <span class="badge" style="background:${colour}">${esc(label)}</span>
      <span class="when">${esc(utc(b.start))} <span class="dim">· ${esc(ago(b.start))}</span></span>
      <span class="dur">${esc(dur(b.duration_ms))}</span>
      ${rec ? '<span class="badge recon" title="Rebuilt by hand from evidence that has since rotated away">reconstructed</span>' : ''}
    </div>
    <div class="vs">vs ${foes}</div>
    <div class="where">${roomsLabel(b)}</div>
    <div class="stats">
      <span><b class="good">${b.kills}</b> kill${b.kills === 1 ? '' : 's'}</span>
      <span><b class="bad">${b.our_deaths}</b> death${b.our_deaths === 1 ? '' : 's'}</span>
      <span><b>${b.hits_out}</b> hits landed</span>
      <span><b>${b.hits_in}</b> taken</span>
      <span><b>${b.volleys}</b> volleys${b.refused ? `, ${b.refused} refused` : ''}</span>
      <span><b>${b.ours.length}</b> of ours</span>
    </div>
    ${rec?.title ? `<p class="rtitle">${esc(rec.title)}</p>` : ''}
    ${rec?.scene ? sceneSvg(rec.scene) : ''}
    ${b.ours.length ? `<table class="ours"><thead><tr><th>Ours</th><th>Kills</th><th>Deaths</th><th>Volleys</th><th>Refused</th><th>Hits</th><th>Hit by</th></tr></thead><tbody>${oursRows}</tbody></table>` : ''}
    ${rec ? `<div class="caveat"><b>What this was rebuilt from.</b> ${esc(rec.provenance ?? '')}${rec.notes?.length ? `<ul>${rec.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</div>` : ''}
    <details${i === 0 || timeline.length <= 30 ? ' open' : ''}><summary>Timeline · ${timeline.length} events · from ${esc(b.sources.join(', '))}</summary>
      <table class="tl"><tbody>${rows}</tbody></table></details>
  </section>`;
}

export function renderPvp({ days = 7, gapMs = DEFAULT_GAP_MS, characters = null, stateFile = null, report = null } = {}) {
  const r = report ?? pvpReport({ days, gapMs, characters, stateFile });
  const t = r.totals;
  const kd = t.kills || t.our_deaths ? `${t.kills} : ${t.our_deaths}` : '—';
  const range = [1, 7, 30].map(d => `<a href="/pvp?days=${d}"${d === r.days ? ' class="on"' : ''}>${d === 1 ? '24 h' : d + ' days'}</a>`).join(' ');
  const enemies = r.enemies.map(e => `<tr><td><b>${esc(e.name)}</b></td><td class="dim">${esc((e.guild ?? '').replace(/^the\s+/i, ''))}</td>
    <td class="num">${e.battles || ''}</td><td class="num">${e.kills_on_us ? `<span class="bad">${e.kills_on_us}</span>` : ''}</td>
    <td class="num">${e.deaths_to_us ? `<span class="good">${e.deaths_to_us}</span>` : ''}</td><td class="num">${e.alarms || ''}</td>
    <td class="dim">${esc(ago(e.last))}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PvP</title>
<style>${STYLE}
  .bad { color:var(--bad); } .good { color:var(--good); } .dim { color:var(--dim); }
  .range a { margin-right:.6rem; color:var(--dim); text-decoration:none; font-size:.85rem; }
  .range a.on { color:var(--fg); font-weight:600; border-bottom:2px solid var(--accent); }
  table { border-collapse:collapse; width:100%; font-size:.85rem; }
  th { text-align:left; color:var(--dim); font-weight:500; font-size:.75rem; text-transform:uppercase;
       letter-spacing:.04em; border-bottom:1px solid var(--line); padding:.3rem .5rem; }
  td { padding:.28rem .5rem; border-bottom:1px solid var(--line); vertical-align:top; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .tablewrap { overflow-x:auto; }
  .battle .bhead { display:flex; flex-wrap:wrap; gap:.6rem; align-items:baseline; }
  .badge { color:#fff; font-size:.72rem; font-weight:600; padding:.1rem .55rem; border-radius:999px;
           text-transform:uppercase; letter-spacing:.05em; }
  .badge.recon { background:transparent; color:var(--edge); border:1px solid var(--edge); }
  .when { font-weight:600; } .dur { color:var(--dim); font-variant-numeric:tabular-nums; }
  .vs { margin:.35rem 0 .1rem; } .where { font-size:.85rem; }
  .stats { display:flex; flex-wrap:wrap; gap:.4rem 1.1rem; margin:.6rem 0; font-size:.88rem; }
  .rtitle { margin:.2rem 0 .6rem; font-style:italic; }
  table.ours { margin:.4rem 0 .8rem; max-width:640px; }
  details summary { cursor:pointer; color:var(--dim); font-size:.85rem; margin-top:.6rem; }
  table.tl td { font-size:.82rem; border-bottom:none; padding:.15rem .5rem; }
  table.tl tr.ctx td { opacity:.6; }
  .scene { margin:.4rem 0 .8rem; overflow-x:auto; }
  .scene .sq { fill:none; stroke:var(--line); }
  .scene .path { stroke:var(--bad); stroke-dasharray:4 3; stroke-width:1.5; }
  .scene .num { font:600 10px ui-sans-serif,system-ui,sans-serif; fill:#fff; text-anchor:middle; }
  .scenebox { display:flex; flex-wrap:wrap; gap:1rem; align-items:flex-start; }
  .legend { list-style:none; padding:0; margin:0; font-size:.82rem; line-height:1.7; }
  .scene figcaption { font-size:.8rem; margin-top:.3rem; }
  .caveat ul { margin:.3rem 0 0; padding-left:1.2rem; }
  @media (max-width:600px) { body { padding:1rem 16px 3rem; } .card .v { font-size:1.2rem; } }
</style></head><body><div class="wrap">
${NAV('pvp')}
<h1>PvP</h1>
<div class="sub">Battles against players: our deaths to them, our kills of them, and every volley and hit in between, grouped
  into battles by time (a battle ends after ${Math.round(r.gap_ms / 60000)} minutes of quiet) and allowed to cross maps.
  <span class="range">${range}</span></div>
<div class="cards">
  <div class="card"><div class="k">Battles</div><div class="v">${t.battles}</div><div class="n">${r.days === 1 ? 'last 24 h' : `last ${r.days} days`}</div></div>
  <div class="card"><div class="k">Kills</div><div class="v good">${t.kills}</div><div class="n">players killed by ours</div></div>
  <div class="card"><div class="k">Deaths</div><div class="v bad">${t.our_deaths}</div><div class="n">ours killed by players</div></div>
  <div class="card"><div class="k">K : D</div><div class="v">${kd}</div><div class="n">kills to deaths</div></div>
  <div class="card"><div class="k">Hits landed</div><div class="v">${t.hits_out}</div><div class="n">${t.hits_in} taken</div></div>
  <div class="card"><div class="k">Volleys</div><div class="v">${t.volleys}</div><div class="n">${t.refused} refused</div></div>
</div>
<div class="caveat">Kills, hits and volleys are recorded only from the build that added the PvP log (tools/m59-pvp.mjs); before it, the
  server's kill line was kept nowhere, so older battles show our deaths alone and read as losses whether or not they were.
  Deaths come from the ledger and go back as far as it does.</div>
<h2>Enemies</h2>
<div class="panel tablewrap">${r.enemies.length ? `<table><thead><tr><th>Player</th><th>Guild</th><th>Battles</th><th>Killed ours</th><th>Killed by ours</th><th>Alarms</th><th>Last seen</th></tr></thead><tbody>${enemies}</tbody></table>` : '<p class="dim">No enemy has been seen in this window.</p>'}</div>
<h2>Battles</h2>
${r.battles.length ? r.battles.map(battleHtml).join('\n') : '<p class="dim">No battles in this window.</p>'}
<p class="dim" style="font-size:.78rem">Sources: ${r.sources.log_rows} PvP log rows, ${r.sources.ledger_deaths} ledger deaths, ${r.sources.alarms} war alarms,
  ${r.sources.reconstructed} reconstructed battle${r.sources.reconstructed === 1 ? '' : 's'}. <a href="/pvp?days=${r.days}&format=json">JSON</a></p>
</div></body></html>`;
}
