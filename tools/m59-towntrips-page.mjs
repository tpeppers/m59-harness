// /economy/trips — EVERY TOWN TRIP, ITEM BY ITEM, FILTERABLE. The page half of m59-towntrips.mjs.
//
// Operator, 2026-10-05: town trip records should carry "pack going in, buying selling, pack going
// out, so a summary can be generated and reviewed/filtered on criteria, and/or linked to from the
// economy tab". The filters are query parameters so a link can carry them:
//   /economy/trips?item=purple&since=7d&agent=t12&purpose=food&sold=1
import { esc, num, NAV, STYLE } from './m59-page-chrome.mjs';
import { pairTrips, filterTrips, totalsByItem, moneyTotals, readTripEvents, parseSince } from './m59-towntrips.mjs';
import { TRADE_KINDS } from './m59-towntrip-ledger.mjs';

const KIND_LABEL = { sold: 'sold', bought: 'bought', vaulted: 'vaulted', guild_deposited: 'into the hall', withdrawn: 'out of the hall' };

const EXTRA = `
  form.filters { display:flex; gap:.6rem; flex-wrap:wrap; align-items:end; margin:.6rem 0 1rem; }
  form.filters label { display:flex; flex-direction:column; font-size:.75rem; color:var(--dim); }
  form.filters input, form.filters select { font:inherit; padding:.2rem .4rem; }
  td.items { font-size:.8rem; max-width:34rem; }
  td.items b { color:var(--dim); font-weight:600; }
`;

const list = (obj, k = 6) => Object.entries(obj ?? {}).sort((a, b) => (b[1]?.amount ?? 0) - (a[1]?.amount ?? 0))
  .slice(0, k).map(([n, r]) => `${esc(n)} ${num(r.amount)}${r.shillings ? ` <span class="dim">(${num(r.shillings)}sh)</span>` : ''}`).join(', ');

/** The data both the page and the economy tab's summary read. */
export function tripsView({ fleet, since = '24h', item = null, agent = null, purpose = null, sold = false, now = Date.now() } = {}) {
  const sinceMs = parseSince(since);
  const trips = filterTrips(pairTrips(readTripEvents({ fleet, sinceMs, now })), { agent, item, purpose, sold })
    .filter(t => (t.completed_at ?? 0) >= now - sinceMs)
    .sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0));
  return { trips, totals: totalsByItem(trips, item), money: moneyTotals(trips), itemised: trips.filter(t => t.itemised).length };
}

/** A few lines for the /economy page, linking here. */
export function tripsSummaryHtml({ fleet, since = '24h' } = {}) {
  let v;
  try { v = tripsView({ fleet, since }); } catch (e) { return `<div class="panel dim">town trips unavailable: ${esc(e.message)}</div>`; }
  const sold = Object.entries(v.totals).filter(([, o]) => o.sold).sort((a, b) => b[1].sold_sh - a[1].sold_sh).slice(0, 6)
    .map(([n, o]) => `<a href="/economy/trips?item=${encodeURIComponent(n)}&since=${since}">${esc(n)}</a> ${num(o.sold)} (${num(o.sold_sh)}sh)`).join(', ');
  return `<div class="panel">
    <p><a href="/economy/trips?since=${since}"><b>${num(v.trips.length)} town trip(s)</b> in the last ${esc(since)}</a>
      · ${num(v.itemised)} with an item record (pack in, sold, bought, vaulted, guild hall in/out, bank, pack out).
      Banked ${num(v.money.banked)}, drawn from the bank ${num(v.money.bank_withdrawn)}.</p>
    ${sold ? `<p>Most sold: ${sold}</p>` : `<p class="dim">No itemised sale yet in this window.</p>`}
  </div>`;
}

export function renderTownTrips({ fleet, label = fleet, query = new URLSearchParams() } = {}) {
  const q = k => query.get(k) || null;
  const since = q('since') ?? '24h', item = q('item'), agent = q('agent'), purpose = q('purpose'), sold = query.get('sold') === '1';
  const v = tripsView({ fleet, since, item, agent, purpose, sold });
  const rows = v.trips.map(t => {
    const tr = t.trade ?? {};
    const parts = !t.itemised ? '<span class="dim">no item record — trip predates the ledger</span>'
      : [...TRADE_KINDS.filter(k => Object.keys(tr[k] ?? {}).length).map(k => `<b>${KIND_LABEL[k]}</b> ${list(tr[k])}`),
         ...(tr.banked || tr.bank_withdrawn ? [`<b>bank</b> in ${num(tr.banked ?? 0)}, out ${num(tr.bank_withdrawn ?? 0)}`] : [])]
          .join('<br>') || '<span class="dim">no trade recorded</span>';
    const delta = t.itemised ? Object.entries(t.pack_delta ?? {}).slice(0, 8)
      .map(([n, d]) => `${esc(n)} ${d > 0 ? '+' : ''}${num(d)}`).join(', ') : '';
    return `<tr><td>${esc(new Date(t.completed_at).toISOString().slice(5, 16).replace('T', ' '))}</td>
      <td>${esc(t.character ?? t.agent)}</td><td>${esc(t.purpose ?? '?')}/${esc(t.trigger ?? '?')}</td>
      <td>${esc(t.to_name ?? t.to ?? '?')}</td><td class="num">${t.net_shillings == null ? '—' : num(t.net_shillings)}</td>
      <td class="items">${parts}</td><td class="items">${delta || '<span class="dim">—</span>'}</td></tr>`;
  }).join('');
  const totals = Object.entries(v.totals).sort((a, b) => b[1].sold_sh - a[1].sold_sh).slice(0, 40)
    .map(([n, o]) => `<tr><td><a href="?item=${encodeURIComponent(n)}&since=${esc(since)}">${esc(n)}</a></td>
      <td class="num">${num(o.sold)}</td><td class="num">${num(o.sold_sh)}</td><td class="num">${num(o.bought)}</td>
      <td class="num">${num(o.bought_sh)}</td><td class="num">${num(o.vaulted)}</td><td class="num">${num(o.guild_deposited)}</td>
      <td class="num">${num(o.withdrawn)}</td></tr>`).join('');
  const val = k => esc(q(k) ?? '');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Town trips — ${esc(label)} fleet</title>
<style>${STYLE}${EXTRA}</style>
</head><body><div class="wrap">
  <h1>Town trips</h1>
  <div class="sub">Pack going in, what was sold and bought, vaulted, put into and taken out of the guild hall, banked, and the pack coming out ·
    <a href="/economy">back to Economy</a> · ${esc(label)} fleet</div>
  ${NAV('economy')}
  <form class="filters" method="get">
    <label>since<input name="since" value="${esc(since)}" size="5"></label>
    <label>item<input name="item" value="${val('item')}" placeholder="purple"></label>
    <label>agent / character<input name="agent" value="${val('agent')}" size="10"></label>
    <label>purpose<input name="purpose" value="${val('purpose')}" size="8"></label>
    <label>only trips that sold<select name="sold"><option value="">no</option><option value="1"${sold ? ' selected' : ''}>yes</option></select></label>
    <button>filter</button>
  </form>
  <p>${num(v.trips.length)} trip(s), ${num(v.itemised)} with an item record. Shillings: earned ${num(v.money.earned)},
    spent ${num(v.money.spent)}, banked ${num(v.money.banked)}, drawn from the bank ${num(v.money.bank_withdrawn)}.
    <span class="dim">"pack change" is the pack coming out minus the pack going in — what actually moved,
    including anything no trade path reported (a co-op deposit, a hand-off, a meal).</span></p>
  ${totals ? `<h2>Totals by item</h2><div class="panel scroller" style="padding:.25rem .5rem"><table>
    <thead><tr><th>item</th><th class="num">sold</th><th class="num">sh</th><th class="num">bought</th>
      <th class="num">sh</th><th class="num">vaulted</th><th class="num">into the hall</th><th class="num">out of the hall</th></tr></thead>
    <tbody>${totals}</tbody></table></div>` : ''}
  <h2>Trips</h2>
  <div class="panel scroller" style="padding:.25rem .5rem"><table>
    <thead><tr><th>finished</th><th>who</th><th>purpose/trigger</th><th>to</th><th class="num">net</th>
      <th>trade</th><th>pack change</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7" class="dim">no trips match</td></tr>'}</tbody></table></div>
</div></body></html>`;
}
