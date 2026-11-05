// /dum and /harness -- THE TWO AUTOMATION LOOPS, VISIBLE BESIDE THE FLEET THEY MOVE.
//
// DUM owns directional interventions. The harness owns the keeper's second-by-second
// activity. They run on different clocks and neither total makes sense buried inside a
// different application, so these two read-only boards put both in the broker dashboard's
// ordinary navigation beside Tougher and Economy.

import { readFileSync, existsSync } from 'node:fs';
import { resolveFleet } from './m59-fleetpath.mjs';
import { ago, esc, heroLink, NAV, STYLE } from './m59-page-chrome.mjs';

const { label: FLEET_LABEL } = resolveFleet();

// The AI director is an OPTIONAL external process (tools/m59-ai-director.mjs). When
// it is running it writes substrate/ai-director-status.json once per pass; this
// board reads that file directly so the page does not need to know the director's
// port or even whether it is on the same host. A missing or stale file means
// "stopped", which is rendered as such and not as an error.
const DIRECTOR_STATUS_PATH = new URL('../substrate/ai-director-status.json', import.meta.url);
const DIRECTOR_STALE_MS = 5 * 60 * 1000;

const NEEDS_OPERATOR_PATH = new URL('../substrate/needs-operator.json', import.meta.url);

function readNeedsOperator() {
  try {
    if (!existsSync(NEEDS_OPERATOR_PATH)) return {};
    return JSON.parse(readFileSync(NEEDS_OPERATOR_PATH, 'utf8')) ?? {};
  } catch { return {}; }
}

function readDirectorStatus() {
  try {
    if (!existsSync(DIRECTOR_STATUS_PATH)) return { running: false, reason: 'no status file' };
    const raw = JSON.parse(readFileSync(DIRECTOR_STATUS_PATH, 'utf8'));
    if (!raw?.running) return { running: false, reason: 'stopped', stopped_at: raw?.stopped_at ?? null };
    const lastMs = raw.last_pass ? Date.parse(raw.last_pass) : 0;
    const ageMs = lastMs ? Date.now() - lastMs : null;
    const stale = ageMs != null && ageMs > DIRECTOR_STALE_MS;
    return { running: !stale, stale,
      pid: raw.pid ?? null, last_pass: raw.last_pass ?? null,
      last_assessment: raw.last_assessment ?? '',
      directives_issued: Number(raw.directives_issued) || 0,
      errors: Number(raw.errors) || 0,
      age_ms: ageMs };
  } catch (e) {
    return { running: false, reason: 'status file unreadable: ' + e.message };
  }
}

const EXTRA_STYLE = `
  .metric-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(135px,1fr));
                 gap:.75rem; margin-bottom:1.5rem; }
  .metric-grid .card .v { font-variant-numeric:tabular-nums; }
  .metric-columns { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem; }
  .metric-list { min-width:0; }
  .metric-list table { min-width:0; }
  .metric-list td:last-child, .metric-list th:last-child { text-align:right; }
  .activity-table td:not(:first-child), .activity-table th:not(:first-child) {
    text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums;
  }
  .status-note { margin:0 0 1.25rem; }
  .window { display:flex; gap:.35rem; flex-wrap:wrap; margin:0 0 1.25rem; }
  .window a { text-decoration:none; color:var(--dim); border:1px solid var(--line);
              border-radius:999px; padding:.25rem .7rem; font-size:.78rem; }
  .window a.on { color:#fff; background:var(--accent); border-color:var(--accent); }
  details.record { border-top:1px solid var(--line); padding:.55rem 0; }
  details.record:first-child { border-top:0; }
  details.record summary { cursor:pointer; display:flex; gap:.6rem; align-items:baseline; }
  details.record summary .when { color:var(--dim); font-size:.76rem; margin-left:auto; white-space:nowrap; }
  details.record .inside { padding:.55rem .4rem .2rem; color:var(--fg); }
  details.record table { min-width:0; margin-top:.45rem; }
  .section-note { color:var(--dim); font-size:.8rem; margin:-.25rem 0 .65rem; }
  @media (max-width:700px) { .metric-columns { grid-template-columns:1fr; } }
  .operator-alert { background:#3d0000; border:1px solid #8b0000; border-radius:6px;
                    padding:.75rem 1rem; margin-bottom:1.25rem; }
  .operator-alert h3 { color:#ff6b6b; margin:0 0 .5rem; font-size:1rem; }
  .operator-alert table { width:100%; }
  .operator-alert td, .operator-alert th { padding:.2rem .5rem; text-align:left; }
  .operator-alert th { color:#ff9999; font-weight:600; font-size:.8rem; }
  .operator-alert td { color:#ffcccc; font-size:.85rem; }
  .operator-alert td:nth-child(3), .operator-alert th:nth-child(3) { text-align:right; }
`;

const count = value => Number.isFinite(Number(value)) ? Number(value) : 0;

export function durationLabel(seconds) {
  const total = Math.max(0, Math.round(count(seconds)));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

const metricCard = (label, value, note = '') => `
  <div class="card"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div>${
    note ? `<div class="n">${esc(note)}</div>` : ''}</div>`;

const metricRows = rows => (Array.isArray(rows) ? rows : []).map(row => `
  <tr><td>${esc(row.name)}</td><td class="num">${count(row.count).toLocaleString('en-GB')}</td></tr>`).join('');

const windowLinks = (path, hours) => `<div class="window"><span class="dim">window</span>${
  [2, 6, 24].map(value => `<a href="${path}?hours=${value}"${Number(hours) === value ? ' class="on"' : ''}>${value}h</a>`).join('')}</div>`;
const stamp = at => at ? new Date(at).toLocaleString() : 'unknown time';
const detail = (summary, at, body) => `<details class="record"><summary><strong>${esc(summary)}</strong>` +
  `<span class="when">${esc(stamp(at))}</span></summary><div class="inside">${body}</div></details>`;
const itemLabel = items => (items ?? []).length
  ? items.map(item => `${item.amount ?? 1}× ${item.name ?? item.what ?? 'item'}`).join(', ') : 'none';
const emptyDetail = 'No detailed records in this window. Enable "Detailed strategy stats" for selected units to begin collecting them.';

export function renderDumBoard({ metrics = null, details = null, hours = 2, error = null } = {}) {
  const m = metrics ?? {};
  const d = details ?? {};
  const byRule = metricRows(m.by_rule);
  const byKind = metricRows(m.by_kind);
  const since = m.since ? new Date(m.since).toLocaleString() : null;
  const through = m.through ? ago(m.through) : null;
  const crateRecords = (d.crate?.records ?? []).map(row => detail(
    `${row.character ?? row.agent ?? 'unknown'} * ${row.found ? `found ${itemLabel(row.reward)}` : row.reached ? 'rummaged; nothing ready' : 'did not reach the mechanic'}`,
    row.at,
    `<div><strong>reward:</strong> ${esc(itemLabel(row.reward))}</div>` +
    `<div><strong>result:</strong> ${esc(row.stopped ?? (row.reached ? 'crate answered' : 'no crate response'))}</div>` +
    ((row.transcript ?? []).length ? `<div class="log">${row.transcript.map(line => `<div>${esc(line)}</div>`).join('')}</div>` : '')
  )).join('');
  const foodRecords = (d.create_food?.records ?? []).map(row => detail(
    `${row.character ?? row.agent ?? 'unknown'} * ${row.event === 'attempt' ? `created ${itemLabel(row.created)}` : `blocked by ${(row.readiness?.blocked_by ?? []).join(', ') || 'unknown'}`}`,
    row.at,
    `<div><strong>food aboard:</strong> ${esc(row.readiness?.meals ?? '--')} * <strong>mana:</strong> ${esc(row.readiness?.mana ?? '--')}</div>` +
    `<div><strong>reagents:</strong> ${esc(JSON.stringify(row.readiness?.reagents ?? {}))}</div>` +
    (row.cast ? `<div><strong>cast:</strong> ${esc(row.cast.what_the_mana_says ?? row.cast.reason ?? 'sent')}</div>` : '')
  )).join('');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DUM bot -- ${esc(FLEET_LABEL)} fleet</title>
<meta http-equiv="refresh" content="30">
<style>${STYLE}${EXTRA_STYLE}</style>
</head><body><div class="wrap">
  <h1>DUM bot</h1>
  <div class="sub">Directional strategy interventions * ${esc(FLEET_LABEL)} fleet * refreshes every 30s</div>
  ${NAV('dum')}
  ${windowLinks('/dum', hours)}
  ${error ? `<div class="caveat status-note"><strong>DUM observability is unavailable.</strong> ${esc(error)}</div>` : ''}
  ${!error && !metrics ? '<div class="caveat status-note">Waiting for the DUM process to report.</div>' : ''}
  <div class="metric-grid">
    ${metricCard('triggered', count(m.interventions_triggered).toLocaleString('en-GB'))}
    ${metricCard('applied', count(m.interventions_applied).toLocaleString('en-GB'))}
    ${metricCard('no change', count(m.interventions_no_change).toLocaleString('en-GB'))}
    ${metricCard('verify failures', count(m.verification_failures).toLocaleString('en-GB'))}
    ${metricCard('findings', count(m.findings).toLocaleString('en-GB'))}
    ${metricCard('errors', count(m.errors).toLocaleString('en-GB'))}
  </div>
  <div class="metric-columns">
    <section class="panel metric-list"><h2 style="margin-top:0">Interventions by rule</h2>
      <table><thead><tr><th>rule</th><th>times</th></tr></thead><tbody>${byRule ||
        '<tr><td colspan="2" class="empty">no rule has intervened in this process</td></tr>'}</tbody></table>
    </section>
    <section class="panel metric-list"><h2 style="margin-top:0">Interventions by action</h2>
      <table><thead><tr><th>action</th><th>times</th></tr></thead><tbody>${byKind ||
        '<tr><td colspan="2" class="empty">no action has been recorded in this process</td></tr>'}</tbody></table>
    </section>
  </div>
  <h2>Crate checks</h2>
  <div class="metric-grid">
    ${metricCard('checks', count(d.crate?.checks).toLocaleString('en-GB'))}
    ${metricCard('finds', count(d.crate?.finds).toLocaleString('en-GB'))}
    ${metricCard('items received', count(d.crate?.rewards).toLocaleString('en-GB'))}
  </div>
  <div class="panel">${crateRecords || `<div class="empty">${esc(emptyDetail)}</div>`}</div>
  <h2>Create Food to keep Fed</h2>
  <div class="metric-grid">
    ${metricCard('casts attempted', count(d.create_food?.attempts).toLocaleString('en-GB'))}
    ${metricCard('foods created', count(d.create_food?.produced).toLocaleString('en-GB'))}
    ${metricCard('resource blocks', count(d.create_food?.blocked).toLocaleString('en-GB'))}
  </div>
  <div class="metric-columns">
    <section class="panel metric-list"><h2 style="margin-top:0">Why creation was blocked</h2>
      <table><thead><tr><th>requirement</th><th>times</th></tr></thead><tbody>${metricRows(d.create_food?.blocked_by) ||
        '<tr><td colspan="2" class="empty">no blocked attempts</td></tr>'}</tbody></table></section>
    <section class="panel">${foodRecords || `<div class="empty">${esc(emptyDetail)}</div>`}</section>
  </div>
  <div class="caveat">These are current-process counters${since ? ` since ${esc(since)}` : ''}${
    through ? ` * last updated ${esc(through)}` : ''}. Detailed records are opt-in, retained per selected unit (24h default), and this view is ${esc(hours)}h. This page is read-only.</div>
</div></body></html>`;
}

const TIME_FIELDS = [
  ['fighting_s', 'Fighting'],
  ['recovering_s', 'Recovering'],
  ['zoning_s', 'Zoning'],
  ['travelling_s', 'Travelling'],
  ['trading_s', 'Trading'],
  ['stalled_s', 'Stalled'],
  ['active_s', 'Active'],
];

export function keeperActivity(fleet = []) {
  const rows = (Array.isArray(fleet) ? fleet : []).map(unit => ({
    agent: unit.agent ?? '',
    character: unit.character ?? unit.agent ?? 'unknown',
    activity: unit.activity ?? '--',
    time: Object.fromEntries(TIME_FIELDS.map(([key]) => [key, count(unit.time?.[key])])),
  }));
  const totals = Object.fromEntries(TIME_FIELDS.map(([key]) =>
    [key, rows.reduce((sum, row) => sum + row.time[key], 0)]));
  return { rows, totals };
}

export function renderHarnessBoard({ fleet = [], details = null, hours = 2, error = null } = {}) {
  const { rows, totals } = keeperActivity(fleet);
  const d = details ?? {};
  const coord = (Array.isArray(fleet) ? fleet : []).map(unit => unit.coordination ?? {});
  const cleanupNow = coord.reduce((out, row) => {
    const value = row.farm_cleanup ?? {};
    for (const key of ['runs', 'dropped', 'picked', 'picked_value', 'protected_picked', 'refused'])
      out[key] += count(value[key]);
    return out;
  }, { runs: 0, dropped: 0, picked: 0, picked_value: 0, protected_picked: 0, refused: 0 });
  const deliveryNow = coord.reduce((out, row) => {
    const value = row.farm_delivery ?? {};
    out.trips += count(value.trips); out.farmers_polled += count(value.farmers_polled);
    out.failed += count(value.failed); out.pending += value.pending ? 1 : 0;
    for (const key of ['requested', 'bought', 'delivered', 'retained'])
      for (const kind of ['herb', 'elderberry']) out[key][kind] += count(value[key]?.[kind]);
    return out;
  }, { trips: 0, farmers_polled: 0, failed: 0, pending: 0,
    requested: { herb: 0, elderberry: 0 }, bought: { herb: 0, elderberry: 0 },
    delivered: { herb: 0, elderberry: 0 }, retained: { herb: 0, elderberry: 0 } });
  const activitySeconds = totals.fighting_s + totals.recovering_s + totals.zoning_s + totals.travelling_s +
    totals.trading_s + totals.stalled_s;
  const fightingShare = activitySeconds ? +(100 * totals.fighting_s / activitySeconds).toFixed(1) : null;
  const body = rows.map(row => `
    <tr><td class="name">${heroLink(row.character)}</td>${TIME_FIELDS.map(([key]) =>
      `<td>${esc(durationLabel(row.time[key]))}</td>`).join('')}<td>${esc(row.activity)}</td></tr>`).join('');
  const mapTable = maps => `<div class="scroller"><table><thead><tr><th>map</th><th>duration</th><th>damage</th><th>safe</th></tr></thead><tbody>${
    (maps ?? []).map(map => `<tr><td>${esc(map.name ?? 'map')} (${esc(map.room ?? '--')})</td>` +
      `<td>${esc(durationLabel((map.duration_ms ?? 0) / 1000))}</td><td>${esc(map.damage ?? 0)}</td>` +
      `<td>${map.from_safe_spot == null ? '--' : map.from_safe_spot ? 'yes' : 'no'}</td></tr>`).join('') ||
      '<tr><td colspan="4" class="empty">no per-map rows</td></tr>'}</tbody></table></div>`;
  const travelRecords = (d.travel?.records ?? []).map(row => detail(
    `${row.character ?? row.agent ?? 'unknown'} * ${row.arrived ? 'arrived' : 'stopped'} after ${durationLabel((row.duration_ms ?? 0) / 1000)} * ${row.damage ?? 0} damage`,
    row.at, `<div><strong>destination:</strong> ${esc(row.to ?? '--')} * <strong>safe-spot stops:</strong> ${esc(row.safe_spot_stops ?? 0)}</div>${mapTable(row.maps)}`)).join('');
  const fightRecords = (d.fighting?.records ?? []).map(row => detail(
    `${row.character ?? row.agent ?? 'unknown'} * ${durationLabel((row.duration_ms ?? 0) / 1000)} fighting * ${row.safe_spot_pct ?? 0}% from proven safe spots`,
    row.at, `<div><strong>target:</strong> ${esc(row.target ?? '--')} * <strong>damage:</strong> ${esc(row.damage ?? 0)}</div>${mapTable(row.maps)}`)).join('');
  const tradeRecords = (d.trading?.records ?? []).map(row => detail(
    `${row.character ?? row.agent ?? 'unknown'} * earned ${count(row.earned).toLocaleString('en-GB')} * spent ${count(row.spent).toLocaleString('en-GB')} * banked ${count(row.banked).toLocaleString('en-GB')}`,
    row.at, `<div><strong>room:</strong> ${esc(row.room_name ?? row.room ?? '--')} * <strong>duration:</strong> ${esc(durationLabel((row.duration_ms ?? 0) / 1000))}</div>` +
      `<div><strong>sold:</strong> ${esc(itemLabel(row.sold))}</div><div><strong>bought:</strong> ${esc(itemLabel(row.bought))}</div>`)).join('');
  const vaultRecords = (d.vault?.latest ?? []).map(row => detail(
    `${row.character ?? 'unknown'} * ${count((row.items ?? []).reduce((n, item) => n + (Number(item.amount) || 1), 0)).toLocaleString('en-GB')} vaulted items in latest read`,
    row.at, `<div>${esc(itemLabel(row.items))}</div>`)).join('');
  const cleanupRecords = (d.farm_cleanup?.records ?? []).map(row => detail(
    `${row.character ?? row.agent ?? 'unknown'} Â* picked ${count((row.picked ?? []).length)} floor stack(s) worth about ${count(row.value).toLocaleString('en-GB')}`,
    row.at, `<div><strong>dropped:</strong> ${esc(itemLabel(row.dropped))}</div>` +
      `<div><strong>picked:</strong> ${esc(itemLabel(row.picked))}</div>` +
      `<div><strong>protected first:</strong> ${esc(itemLabel(row.protected))} Â* <strong>refused:</strong> ${esc((row.refused ?? []).length)}</div>`)).join('');
  const deliveryRecords = (d.farm_delivery?.records ?? []).map(row => detail(
    `${row.character ?? row.agent ?? 'unknown'} Â* delivered ${(row.delivered ?? []).reduce((n, rec) => n + count(rec.delivered?.herb) + count(rec.delivered?.elderberry), 0)} reagents to room ${row.to_room ?? 'â€"'}`,
    row.at, `<div><strong>bought:</strong> herbs ${esc(row.bought?.herb ?? 0)}, elderberries ${esc(row.bought?.elderberry ?? 0)}</div>` +
      `<div><strong>retained:</strong> herbs ${esc(row.retained?.herb ?? 0)}, elderberries ${esc(row.retained?.elderberry ?? 0)}</div>` +
      `<div class="log">${(row.delivered ?? []).map(rec => `<div>${esc(rec.character ?? rec.agent ?? 'farmer')}: requested ${esc(JSON.stringify(rec.requested ?? {}))}; delivered ${esc(JSON.stringify(rec.delivered ?? {}))}${rec.why ? `; ${esc(rec.why)}` : ''}</div>`).join('')}</div>`)).join('');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harness -- ${esc(FLEET_LABEL)} fleet</title>
<meta http-equiv="refresh" content="30">
<style>${STYLE}${EXTRA_STYLE}</style>
</head><body><div class="wrap">
  <h1>Harness</h1>
  <div class="sub">Keeper activity clock * ${esc(FLEET_LABEL)} fleet * ${rows.length} unit(s) * refreshes every 30s</div>
  ${NAV('harness')}
  ${windowLinks('/harness', hours)}
  ${(() => {
    const alerts = Object.entries(readNeedsOperator());
    if (!alerts.length) return '';
    const rows = alerts.map(([char, info]) => {
      const secs = Number(info.stalled_seconds) || 0;
      return `<tr>
        <td><strong>${esc(char)}</strong></td>
        <td>${esc(info.reason ?? '—')}</td>
        <td>${secs > 0 ? esc(durationLabel(secs)) : '—'}</td>
        <td>${info.room != null ? esc(String(info.room)) : '—'}</td>
        <td>${esc(info.hunt ?? '—')}</td>
        <td>${info.at ? esc(new Date(info.at).toLocaleTimeString()) : '—'}</td>
      </tr>`;
    }).join('');
    return `<div class="operator-alert">
      <h3>&#9888; Needs operator attention — ${alerts.length} character(s)</h3>
      <table><thead><tr>
        <th>character</th><th>reason</th><th>stalled</th><th>room</th><th>hunt</th><th>since</th>
      </tr></thead><tbody>${rows}</tbody></table>
    </div>`;
  })()}
  ${error ? `<div class="caveat status-note"><strong>Keeper activity is unavailable.</strong> ${esc(error)}</div>` : ''}
  <div class="metric-grid">${TIME_FIELDS.map(([key, label]) =>
    metricCard(label, durationLabel(totals[key]), `across ${rows.length} keeper(s)`) ).join('')}</div>
  <h2>Keeper time by unit</h2>
  <div class="panel scroller" style="padding:.25rem .5rem">
    <table class="activity-table"><thead><tr><th>unit</th>${TIME_FIELDS.map(([, label]) =>
      `<th>${esc(label)}</th>`).join('')}<th>now</th></tr></thead>
      <tbody>${body || '<tr><td colspan="9" class="empty">no keeper rows are available</td></tr>'}</tbody></table>
  </div>
  <h2>Travel trips</h2>
  <div class="metric-grid">
    ${metricCard('trips', count(d.travel?.trips).toLocaleString('en-GB'))}
    ${metricCard('trip time', durationLabel(count(d.travel?.duration_ms) / 1000))}
    ${metricCard('damage taken', count(d.travel?.damage).toLocaleString('en-GB'))}
    ${metricCard('safe-spot stops', count(d.travel?.safe_spot_stops).toLocaleString('en-GB'))}
  </div>
  <div class="panel">${travelRecords || `<div class="empty">${esc(emptyDetail)}</div>`}</div>
  <h2>Fighting sessions</h2>
  <div class="metric-grid">
    ${metricCard('sessions', count(d.fighting?.sessions).toLocaleString('en-GB'))}
    ${metricCard('fighting time', durationLabel(count(d.fighting?.duration_ms) / 1000))}
    ${metricCard('damage taken', count(d.fighting?.damage).toLocaleString('en-GB'))}
    ${metricCard('from safe spots', d.fighting?.safe_spot_pct == null ? '--' : `${d.fighting.safe_spot_pct}%`)}
  </div>
  <div class="panel">${fightRecords || `<div class="empty">${esc(emptyDetail)}</div>`}</div>
  <h2>Trading sessions</h2>
  <div class="metric-grid">
    ${metricCard('sessions', count(d.trading?.sessions).toLocaleString('en-GB'))}
    ${metricCard('earned', count(d.trading?.earned).toLocaleString('en-GB'), 'shillings')}
    ${metricCard('spent', count(d.trading?.spent).toLocaleString('en-GB'), 'shillings')}
    ${metricCard('banked', count(d.trading?.banked).toLocaleString('en-GB'), 'shillings')}
  </div>
  <div class="panel">${tradeRecords || `<div class="empty">${esc(emptyDetail)}</div>`}</div>
  <h2>Vault accumulation</h2>
  <div class="metric-grid">
    ${metricCard('deposit sessions', count(d.vault?.deposits).toLocaleString('en-GB'))}
    ${metricCard('items deposited', count(d.vault?.items_deposited).toLocaleString('en-GB'))}
    ${metricCard('vaults read', count(d.vault?.latest?.length).toLocaleString('en-GB'))}
  </div>
  <div class="panel">${vaultRecords || `<div class="empty">${esc(emptyDetail)}</div>`}</div>
  <h2>Farm clean-up</h2>
  <div class="section-note">Current-session counters survive without the broad detailed-stat switch; drill-ins rotate from disk for 24h.</div>
  <div class="metric-grid">
    ${metricCard('clean-up runs', cleanupNow.runs.toLocaleString('en-GB'))}
    ${metricCard('dead gear dropped', cleanupNow.dropped.toLocaleString('en-GB'))}
    ${metricCard('items picked', cleanupNow.picked.toLocaleString('en-GB'))}
    ${metricCard('estimated value', cleanupNow.picked_value.toLocaleString('en-GB'))}
    ${metricCard('protected items', cleanupNow.protected_picked.toLocaleString('en-GB'))}
  </div>
  <div class="panel">${cleanupRecords || `<div class="empty">No farm clean-up trip has completed in this window.</div>`}</div>
  <h2>Farm delivery</h2>
  <div class="metric-grid">
    ${metricCard('courier trips', deliveryNow.trips.toLocaleString('en-GB'))}
    ${metricCard('farmers polled', deliveryNow.farmers_polled.toLocaleString('en-GB'))}
    ${metricCard('herbs delivered', deliveryNow.delivered.herb.toLocaleString('en-GB'))}
    ${metricCard('elderberries delivered', deliveryNow.delivered.elderberry.toLocaleString('en-GB'))}
    ${metricCard('cargo retained', (deliveryNow.retained.herb + deliveryNow.retained.elderberry).toLocaleString('en-GB'))}
    ${metricCard('fleet fighting share', fightingShare == null ? 'â€"' : `${fightingShare}%`, 'current keeper process')}
  </div>
  <div class="panel">${deliveryRecords || `<div class="empty">No farm delivery has completed in this window.</div>`}</div>
  <h2>AI director</h2>
  ${(() => {
    const d = readDirectorStatus();
    const card = (k, v, n = '') => metricCard(k, v, n);
    const state = d.running ? (d.stale ? 'stale' : 'running')
                 : (d.reason ? `stopped (${d.reason})` : 'stopped');
    const lastSeen = d.last_pass ? new Date(d.last_pass).toLocaleString() : '\u2014';
    const age = d.age_ms != null ? durationLabel(d.age_ms / 1000) : '\u2014';
    const assessment = d.last_assessment || '(no assessment recorded yet)';
    return `
      <div class="metric-grid">
        ${card('status', state)}
        ${card('last pass', lastSeen)}
        ${card('age', age)}
        ${card('directives issued', (d.directives_issued ?? 0).toLocaleString('en-GB'))}
        ${card('errors', (d.errors ?? 0).toLocaleString('en-GB'))}
        ${card('pid', d.pid ?? '\u2014')}
      </div>
      <div class="panel"><div><strong>last assessment:</strong> ${esc(assessment)}</div></div>`;
  })()}
  <div class="caveat">The top clock is current-process. Drill-ins are opt-in disk records, retained per selected unit (24h default), and this view is ${esc(hours)}h. Damage comes from the server-pushed hit record, not net health change, so healing cannot erase it.</div>
</div></body></html>`;
}
