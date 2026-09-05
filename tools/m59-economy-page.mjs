// /economy — THE SUPPLY CHAIN, ON ONE PAGE, BECAUSE IT ONLY HAS TO BREAK IN ONE PLACE.
//
//   loot -> shillings -> elderberry + herbs -> `create food` -> vigor -> kills
//
// Every arrow in that chain fails silently. A purse spent down produces no message; a
// pack with one elderberry in it produces no message; `create food` without its reagents
// REFUSES SILENTLY and the keeper journals a cast that made nothing. The first visible
// symptom is a fleet fighting at 40% vigor several hours later, and by then the cause is
// off the end of every log that would have shown it.
//
// So the page leads with the totals, and then says how each one was measured — see
// m59-economy.mjs for why the three quantities have three different kinds of evidence
// behind them and why the page must never flatten that.
import { economy, SHORT_BELOW , foodHeld} from './m59-economy.mjs';
import { resolveFleet } from './m59-fleetpath.mjs';
import { lore } from './m59-dashboard.mjs';
import { esc, ago, num, NAV, STYLE, TREEMAP_JS, FACET_WIRING_JS } from './m59-page-chrome.mjs';
import { StorageCache, packFullness, GUILD_CHEST_SLOTS, VAULT_BULK_MAX, CHEST_BULK_MAX,
         BOOKMAKERS_CHESTS } from './m59-storage.mjs';

const { label: FLEET_LABEL } = resolveFleet();

const EXTRA_STYLE = `
  /* THE TREND, AS SMALL AS IT CAN BE AND STILL MEAN SOMETHING. A stock with no history
     cannot answer "is the fleet getting richer", which is the only question anybody
     actually asks of an economy. */
  .sparks { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:1rem; }
  .spark { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:.8rem 1rem; }
  .spark .k { color:var(--dim); font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; }
  .foodwrap { display:flex; gap:1.2rem; align-items:flex-start; flex-wrap:wrap; margin:.6rem 0 1rem; }
  .foodpie { flex:0 0 190px; }
  .foodpie svg { width:190px; height:190px; display:block; }
  .foodlegend { flex:1 1 320px; border-collapse:collapse; font-size:.85rem; }
  .foodlegend th, .foodlegend td { padding:.22rem .5rem; text-align:left; }
  .foodlegend th { font-weight:600; color:var(--dim); border-bottom:1px solid var(--line); }
  .foodlegend tfoot td { border-top:1px solid var(--line); font-weight:600; }
  .foodlegend .n { text-align:right; font-variant-numeric:tabular-nums; }
  .swatch { display:inline-block; width:.7rem; height:.7rem; border-radius:2px;
            margin-right:.45rem; vertical-align:-1px; }
  .spark .v { font-size:1.3rem; font-weight:600; font-variant-numeric:tabular-nums; }
  .spark svg { width:100%; height:52px; display:block; margin-top:.35rem; overflow:visible; }
  .spark .line { fill:none; stroke:var(--accent); stroke-width:2; stroke-linejoin:round; }
  .spark .area { fill:color-mix(in srgb, var(--accent) 14%, transparent); stroke:none; }
  .spark .delta { font-size:.75rem; }
  .row-short td { background:color-mix(in srgb, var(--edge) 9%, transparent); }

  /* A METER, NOT A BAR CHART. These are fractions of a hard server ceiling, so the scale
     is fixed at 0-100 and the colour is the only thing that moves: a pack at 96% is about
     to start refusing pickups and DELETING spell-made weapons, which is worth seeing from
     across the room. */
  .meter { display:flex; align-items:center; gap:.5rem; }
  .meter .track { position:relative; flex:1; min-width:70px; height:8px; border-radius:99px;
                  background:color-mix(in srgb, var(--edge) 22%, transparent); overflow:hidden; }
  .meter .fill { position:absolute; inset:0 auto 0 0; border-radius:99px; background:var(--accent); }
  .meter .fill.warn { background:var(--warn,#c98a15); }
  .meter .fill.bad  { background:var(--bad,#c0392b); }
  .meter .pc { font-variant-numeric:tabular-nums; font-size:.75rem; color:var(--dim); min-width:3.2em; text-align:right; }
  .meter.unknown .track { background:repeating-linear-gradient(90deg,
      color-mix(in srgb, var(--edge) 18%, transparent) 0 4px, transparent 4px 8px); }

  /* The per-character drill-in. A details element rather than script: the page has to work with no
     JavaScript at all, and a table row that expands is the one interaction that genuinely
     needs no more than the browser already does. */
  tr.drill > td { padding:0; border-top:0; }
  tr.drill details { margin:0; }
  tr.drill summary { cursor:pointer; padding:.35rem 1rem; color:var(--dim); font-size:.78rem; }
  tr.drill summary:hover { color:var(--fg); }
  tr.drill .inner { padding:.2rem 1rem 1rem 1rem; display:grid;
                    grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:1rem; }
  tr.drill .box { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:.7rem .9rem; }
  tr.drill .box h4 { margin:0 0 .45rem 0; font-size:.74rem; text-transform:uppercase;
                     letter-spacing:.06em; color:var(--dim); font-weight:600; }
  tr.drill .items { font-size:.8rem; line-height:1.5; }
  tr.drill .items .none { color:var(--dim); font-style:italic; }
  .chests { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:1rem; }
  .chest { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:.8rem 1rem; }
  .chest.empty { border-style:dashed; opacity:.72; }
  .chest h3 { margin:0 0 .3rem 0; font-size:.85rem; }
`;

const storage = new StorageCache();

// 0-100 with a fixed scale, and null renders as a hatched track rather than as zero —
// "nobody has looked" and "it is empty" are opposite facts about a store.
function meter(percent, title = '') {
  if (percent == null)
    return `<span class="meter unknown" title="${esc(title || 'never read')}">` +
           `<span class="track"></span><span class="pc">—</span></span>`;
  const cls = percent >= 90 ? 'bad' : percent >= 70 ? 'warn' : '';
  return `<span class="meter" title="${esc(title)}"><span class="track">` +
         `<span class="fill ${cls}" style="width:${Math.min(100, percent)}%"></span></span>` +
         `<span class="pc">${percent}%</span></span>`;
}

const itemList = (items, empty) => !items || !items.length
  ? `<div class="items"><span class="none">${esc(empty)}</span></div>`
  : `<div class="items">${items.slice(0, 40).map(i =>
      `${esc(i.name)}${(i.amount ?? 1) > 1 ? ` <span class="dim">x${i.amount}</span>` : ''}`).join(', ')}` +
    `${items.length > 40 ? ` <span class="dim">and ${items.length - 40} more</span>` : ''}</div>`;

// A polyline and a wash under it. No script and no library: this is four numbers of
// context, and the page has to open on a phone with no internet behind it.
function spark(points, { w = 260, h = 52 } = {}) {
  const vals = points.map(p => p.value);
  if (vals.length < 2) return '<div class="dim" style="font-size:.78rem">not enough history yet</div>';
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = i => (i / (vals.length - 1)) * w;
  const y = v => h - ((v - lo) / span) * (h - 4) - 2;
  const line = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">
    <polygon class="area" points="0,${h} ${line} ${w},${h}"></polygon>
    <polyline class="line" points="${line}"></polyline>
  </svg>`;
}

function sparkCard(label, points, unit) {
  const vals = points.map(p => p.value);
  const now = vals[vals.length - 1] ?? null;
  const then = vals[0] ?? null;
  const d = now != null && then != null ? now - then : null;
  return `
  <div class="spark">
    <div class="k">${esc(label)}</div>
    <div class="v">${num(now)} <span class="dim" style="font-size:.7em">${esc(unit)}</span></div>
    ${spark(points)}
    <div class="delta ${d > 0 ? 'good' : d < 0 ? 'bad' : 'dim'}">${
      d == null ? '' : `${d > 0 ? '+' : ''}${num(d)} over the window`}</div>
  </div>`;
}

// WHERE A NUMBER CAME FROM, IN ONE PILL. `live` is the inventory this second, `sample`
// is the ledger, `cast` is what a caster stated it was holding when it last tried — see
// m59-economy.mjs. A page that shows all three as plain numbers is a page that will get
// a two-hour-old figure read as current.
function sourcePill(from, at) {
  if (!from) return '<span class="dim">—</span>';
  if (from === 'live') return '<span class="pill obs" title="the inventory, this second">live</span>';
  if (from === 'sample')
    return `<span class="pill" title="the newest ledger sample">${esc(ago(at))}</span>`;
  return `<span class="pill inf" title="no sample carries this character yet — this is what it ` +
         `stated it was holding when it last cast, ${esc(ago(at))}">cast ${esc(ago(at))}</span>`;
}

// A PIE, DRAWN AS SVG ON THE SERVER, because this page has no JavaScript and should not
// start having any for one chart. Every other figure here is server-rendered and readable
// with the broker down; a chart that needs a script to appear is a chart that is blank in
// exactly the situations somebody is reading this page urgently.
//
// ONE SLICE PER KIND. A 100% slice cannot be drawn as an arc — the start and end points
// coincide and the path collapses — so a single kind is drawn as a plain circle. That is
// not a rare edge here: a fleet that has just come back from the Duke's tables is usually
// carrying one thing.
function foodPie(kinds, { size = 190 } = {}) {
  const total = kinds.reduce((n, k) => n + k.value, 0);
  if (!total) return '';
  const r = size / 2, cx = r, cy = r;
  const hue = i => Math.round((i * 360) / Math.max(1, kinds.length));
  const fill = i => `hsl(${hue(i)} 55% 55%)`;
  if (kinds.length === 1)
    return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="all of it is ${esc(kinds[0].name)}">` +
           `<circle cx="${cx}" cy="${cy}" r="${r - 1}" fill="${fill(0)}"></circle></svg>`;
  let at = -Math.PI / 2;                       // start at twelve o'clock
  const slices = kinds.map((k, i) => {
    const sweep = (k.value / total) * Math.PI * 2;
    const x1 = cx + (r - 1) * Math.cos(at), y1 = cy + (r - 1) * Math.sin(at);
    at += sweep;
    const x2 = cx + (r - 1) * Math.cos(at), y2 = cy + (r - 1) * Math.sin(at);
    const large = sweep > Math.PI ? 1 : 0;
    const pct = Math.round((k.value / total) * 100);
    return `<path d="M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} ` +
           `A ${r - 1} ${r - 1} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" ` +
           `fill="${fill(i)}"><title>${esc(k.name)}: ${k.value} (${pct}%)</title></path>`;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="food carried, by kind">${slices}</svg>`;
}

function foodLegend(kinds, showEarned = false) {
  const total = kinds.reduce((n, k) => n + k.value, 0) || 1;
  const hue = i => Math.round((i * 360) / Math.max(1, kinds.length));
  return kinds.map((k, i) => `
    <tr>
      <td><span class="swatch" style="background:hsl(${hue(i)} 55% 55%)"></span>${esc(k.name)}</td>
      <td class="n">${num(k.value)}</td>
      ${showEarned ? `<td class="n ${k.earned ? 'good' : 'dim'}">${num(k.earned)}</td>` : ''}
      <td class="n dim">${Math.round((k.value / total) * 100)}%</td>
      <td class="n dim" title="vigor per item, from the game's own Food table">${k.nutrition}</td>
      <td class="n dim" title="how many characters are carrying any">${k.holders}</td>
    </tr>`).join('');
}

export function renderEconomy({ hours = 168, live = null, characters = null } = {}) {
  const e = economy({ sinceMs: hours * 3600 * 1000, live, characters });
  const t = e.totals;
  // Read off the live rows' own `pack_items`, so it costs no packet and is exactly as fresh
  // as the rest of the page. With `live: null` — a standalone read of the record — there is
  // no pack to count and the section says so rather than reporting a starving fleet.
  const food = foodHeld(live);

  const FACETS = {
    wealth: {
      children: e.by_wealth.map(x => {
        const r = e.rows.find(r => r.character === x.name);
        return { ...x, children: [{ name: 'purse', value: r?.purse ?? 0 },
                                  { name: 'banked', value: r?.banked ?? 0 }]
                                 .filter(c => c.value > 0) };
      }),
      total: t.wealth, unit: 'shillings', drill: 'purse and bank',
      note: 'Everything the fleet is worth, by character. Click one to split it into the ' +
            'half a death takes and the half it cannot. A purse is the risk: the payout ' +
            'from a signet ring sitting on the fleet\'s most fragile character is exactly ' +
            'what dying is for.',
      empty: 'no money on record — nobody has been seen at a counter and no sample carries a purse',
    },
    reagents: {
      children: e.by_reagents.map(x => {
        const r = e.rows.find(r => r.character === x.name);
        return { ...x, children: [{ name: 'elderberry', value: r?.elderberry ?? 0 },
                                  { name: 'herbs', value: r?.herbs ?? 0 }].filter(c => c.value > 0) };
      }),
      total: t.elderberry + t.herbs, unit: 'reagents', drill: 'what kind',
      note: 'THE FLEET IS NEVER SHORT OF REAGENTS IN TOTAL — IT IS SHORT OF THEM IN THE ' +
            'RIGHT POCKETS. `create food` spends 2 ElderBerry and 2 Herbs FROM THE CASTER, ' +
            'so a hundred elderberries on a character that never casts feeds nobody. The ' +
            'lopsided rectangles are the errand: see `supply` and m59-reagents.mjs.',
      empty: 'nothing has reported a pack yet',
    },
    spend: {
      children: e.spend.by_kind, total: e.spend.total, unit: 'shillings',
      note: 'What the money actually bought, from `bought` events. Nothing here does not ' +
            'mean nothing was bought before this window — and it may mean the fleet is ' +
            'casting rather than shopping, which is the plan working rather than failing.',
      empty: 'nothing was bought in this window',
    },
  };

  // The pack is measured from the live inventory when the broker passed one in; a stored
  // sample carries no item list, so a character nobody is holding renders its pack meter
  // hatched rather than at zero.
  const liveOf = new Map((live || []).map(x => [x.character, x]));
  const rows = e.rows.map(r => {
    const l = liveOf.get(r.character) ?? null;
    const vault = storage.readVault(r.character);
    // THE ROW'S OWN FIGURE, not a second computation from a different input. The pack
    // needs might for the ceiling and the item list for the load, and neither survives
    // into a stored sample — so the broker computes it where the client is in hand and
    // this renders what it was given. A character nobody is holding has no pack reading
    // and renders hatched, which is the honest answer rather than 0%.
    const pack = l?.pack ?? null;
    return `
    <tr${r.short ? ' class="row-short"' : ''}>
      <td class="name">${esc(r.character)}</td>
      <td class="num">${r.purse == null ? '<span class="dim">—</span>' : num(r.purse)}</td>
      <td class="num">${r.banked == null
          ? '<span class="guess" title="nobody has taken this character to a counter — this is not a balance of zero">never asked</span>'
          : num(r.banked)}</td>
      <td>${r.banked == null ? '' : r.banked_observed
          ? '<span class="pill obs" title="a banker said this out loud">said</span>'
          : '<span class="pill inf" title="a withdrawal reports the amount handed over, not the new balance, so this figure is arithmetic against the last stated one">derived</span>'}
        ${r.banked_at ? `<span class="dim" style="font-size:.72rem">${esc(ago(r.banked_at))}</span>` : ''}</td>
      <td class="num ${(r.elderberry ?? 0) < SHORT_BELOW ? 'bad' : ''}">${r.elderberry == null ? '—' : r.elderberry}</td>
      <td class="num ${(r.herbs ?? 0) < SHORT_BELOW ? 'bad' : ''}">${r.herbs == null ? '—' : r.herbs}</td>
      <td class="num ${r.casts_possible ? '' : 'bad'}">${r.casts_possible}</td>
      <td>${sourcePill(r.reagents_from, r.reagents_at)}</td>
      <td>${meter(pack?.percent ?? null, pack
          ? `pack ${pack.bulk} bulk / ${pack.weight} weight against ${pack.max}, ${pack.binding}-bound`
          : 'no live inventory for this character — the stored sample carries totals, not an item list')}</td>
      <td>${meter(vault?.fullness?.percent ?? null, vault
          ? `${vault.fullness.bulk} of ${VAULT_BULK_MAX} bulk on deposit`
          : 'no withdrawal list has been requested for this character')}</td>
    </tr>
    <tr class="drill"><td colspan="10"><details>
      <summary>${esc(r.character)} — pack and vault</summary>
      <div class="inner">
        <div class="box">
          <h4>pack ${pack ? `· ${pack.percent}% · ${pack.binding}-bound` : ''}</h4>
          ${pack ? `<div class="dim" style="font-size:.75rem">${pack.bulk} bulk / ${pack.weight} weight
             against a ceiling of ${pack.max} (1700 + might*20)${pack.exact ? '' : ' — LOWER BOUND, some items are not in the weight table'}</div>` : ''}
          <div class="dim" style="font-size:.75rem">${l?.carrying != null
             ? esc(String(l.carrying)) + ' stack(s) in the pack'
             : 'no live reading — this character is not being held by the broker right now'}</div>
          <!-- WHAT IS IN IT, not just how much of it there is. A pack meter at 94% is a
               question and this is the answer to it: the reader deciding what to sell,
               bank or drop needs the names, and asking for them per character was an
               inventory call on the wire for a list the row already carries. Grouped by
               name by the broker, biggest first.
               The three empty cases are DIFFERENT and must not render alike — an empty
               pack is a fact, an unheld character is the absence of one, and a row with
               no such field at all is a broker older than this page. Same rule the
               hatched meter follows. -->
          ${itemList(l?.pack_items, !l
             ? 'no item list — this character is not being held by the broker right now, and a stored sample carries totals rather than names'
             : Array.isArray(l.pack_items) ? 'nothing in the pack'
             : 'the broker holding this character is running code that does not report the item list — restart it and this fills in')}
        </div>
        <div class="box">
          <h4>vault ${vault ? `· ${vault.fullness.percent}%` : ''}</h4>
          ${vault ? `<div class="dim" style="font-size:.75rem">${vault.fullness.bulk} of ${VAULT_BULK_MAX} bulk
             · read ${esc(ago(vault.observed_at))}</div>` : ''}
          ${itemList(vault?.items, 'never read — a vault states its contents only when a withdrawal is requested')}
        </div>
      </div>
    </details></td></tr>`;
  }).join('');

  const spendRows = e.spend.by_kind.map(k => `
    <tr>
      <td class="name">${lore(k.name)}</td>
      <td class="num">${k.items}</td>
      <td class="num">${num(k.value)}</td>
      <td class="num dim">${k.items ? Math.round(k.value / k.items) : '—'}</td>
    </tr>`).join('');

  const declinedRows = e.spend.declined.slice(0, 8).map(d => `
    <tr><td>${esc(d.why)}</td><td class="num dim">${d.times}</td></tr>`).join('');

  const purseUnknown = e.characters - t.purse_known;
  // A SPARKLINE OF ONE POINT IS A DOT, AND THREE PANELS OF DOTS READ AS A BROKEN PAGE
  // RATHER THAN AS A YOUNG RECORD. Two readings is the minimum that can be a line, so
  // below that the section says what it is waiting for instead of drawing nothing.
  const hasTrend = e.series.filter(s => s.purse || s.elderberry || s.herbs).length > 1;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Economy — ${esc(FLEET_LABEL)} fleet</title>
<meta http-equiv="refresh" content="60">
<style>${STYLE}${EXTRA_STYLE}</style>
</head><body><div class="wrap">
  <h1>Economy</h1>
  <div class="sub">Shillings in hand, shillings in the bank, and the reagents that turn
    one into vigor · last ${hours}h · ${esc(FLEET_LABEL)} fleet</div>
  ${NAV('economy')}

  <div class="cards">
    <div class="card"><div class="k">worth, all in</div><div class="v">${num(t.wealth)}</div>
      <div class="n">shillings across ${e.characters} character(s)</div></div>
    <!-- Orange, not red. Money in a purse is money AT RISK, which is worth marking, but it
         is not a fault — red on this page is reserved for a character that cannot cast. -->
    <div class="card"><div class="k">in purses</div><div class="v ${t.purse ? 'warn' : 'dim'}">${num(t.purse)}</div>
      <div class="n">what a death takes${purseUnknown ? ` · ${purseUnknown} not read` : ''}</div></div>
    <div class="card"><div class="k">banked</div><div class="v good">${num(t.banked)}</div>
      <div class="n">what it cannot · ${t.banked_known} of ${e.characters} seen at a counter</div></div>
    <div class="card"><div class="k">elderberry</div><div class="v">${num(t.elderberry)}</div>
      <div class="n">the scarce half of the recipe</div></div>
    <div class="card"><div class="k">herbs</div><div class="v">${num(t.herbs)}</div>
      <div class="n">the abundant half</div></div>
    <div class="card"><div class="k">meals castable</div><div class="v">${num(t.casts_possible)}</div>
      <div class="n">2 + 2 a cast, from the caster's own pack</div></div>
    <!-- THE ONE STOCK ON THIS PAGE THAT IS NOT MONEY. Resting stops awarding vigor at 80 of
         200 and everything above it has to be EATEN, so a fleet with no food fights at a
         fraction of its strength however rich it is. Red at zero, deliberately: it is the
         same severity as a character that cannot cast. -->
    <div class="card"><div class="k">food available</div>
      <div class="v ${food.total ? 'good' : 'bad'}">${num(food.total)}</div>
      <div class="n">${food.baseline
        ? `<b>${num(food.earned)} earned</b> · ${num(food.baseline)} hand-placed · `
        : ''}${food.kinds.length} kind(s) · ${food.fed} of ${food.characters} carrying any${
        food.unread ? ` · ${food.unread} pack(s) not read` : ''}</div></div>
    <div class="card"><div class="k">short of something</div>
      <div class="v ${t.short ? 'bad' : 'good'}">${t.short}</div>
      <div class="n">under ${SHORT_BELOW} of a reagent — three castings</div></div>
  </div>

  <h2>What is there to eat?</h2>
  <div class="sub">Every meal the fleet is carrying, by kind, totalled across all characters ·
    what counts as food is the game's own Food class tree, not a list written here — which
    matters, because four of this world's five mushrooms are casting reagents and only two
    are edible.${food.baseline ? ` · <b>earned</b> is what the fleet's own errands brought
    back: held minus what <code>substrate/food-baseline.json</code> declares was placed by
    hand. The two are shown side by side and never netted, because a total that has quietly
    had a number taken out of it is one nobody can check.` : ''}</div>
  ${food.total ? `
  <div class="foodwrap">
    <div class="foodpie">${foodPie(food.kinds)}</div>
    <table class="foodlegend">
      <thead><tr><th>kind</th><th class="n">held</th>${food.baseline
        ? '<th class="n" title="held, minus what substrate/food-baseline.json declares was put there by hand">earned</th>' : ''}<th class="n">share</th>
        <th class="n">vigor ea.</th><th class="n">holders</th></tr></thead>
      <tbody>${foodLegend(food.kinds, !!food.baseline)}</tbody>
      <tfoot><tr><td>total</td><td class="n">${num(food.total)}</td>${food.baseline
        ? `<td class="n good">${num(food.earned)}</td>` : ''}<td class="n dim">100%</td>
        <td class="n dim" title="vigor if every bite were eaten — the stomach admits 100 at a sitting and drains about 7.2 a minute, so this is vigor the fleet could eat its way to, not vigor it has">${num(food.nutrition)}</td>
        <td class="n dim">${food.fed}</td></tr></tfoot>
    </table>
  </div>` : `
  <div class="empty">${live
    ? 'the fleet is carrying nothing edible. Vigor above the resting cap of 80 comes only ' +
      'from eating, so every character is capped there until something is cooked or the ' +
      'Duke\'s tables are visited.'
    : 'no live pack reading — this page was rendered from the record alone, which does not ' +
      'carry pack contents. An unread pack is not an empty one.'}</div>`}

  <h2>Is it moving?</h2>
  ${hasTrend ? `
  <div class="sub">Hourly, and each point is the LAST reading in its hour rather than a
    mean — these are stocks, and an average balance describes nothing that ever existed.</div>
  <div class="sparks">
    ${sparkCard('shillings in purses', e.series.map(s => ({ at: s.at, value: s.purse })), 'sh')}
    ${sparkCard('elderberry held', e.series.map(s => ({ at: s.at, value: s.elderberry })), 'held')}
    ${sparkCard('herbs held', e.series.map(s => ({ at: s.at, value: s.herbs })), 'held')}
  </div>` : `
  <div class="panel"><div class="caveat" style="margin:0">
    <b>No history to draw yet.</b> The stock figures above are a reading of right now; the
    trend needs the ledger to have sampled a purse and a pack more than once, and the
    ledger only carries them while the broker is running code that writes them down.
    Nothing here can be backfilled — an inventory is not announced, so a count that was
    never written down is simply gone. Expect a line within a few hours of the next
    broker restart.
  </div></div>`}

  <div class="panel" style="margin-top:1.25rem">
    <div class="facets">
      <button data-facet="wealth" class="on">Where the money is</button>
      <button data-facet="reagents">Where the reagents are</button>
      <button data-facet="spend">What was bought</button>
      <button id="tm-back" style="display:none">← all</button>
    </div>
    <svg id="tm"></svg>
    <div class="caveat" id="facet-note"></div>
  </div>

  <!-- THE GUILD, WHICH IS THE ONE PART OF THIS PAGE THAT IS NOT ABOUT A CHARACTER.
       Rent has a SIGN and the sign is the whole meaning: positive is a DEBT and the hall
       is lost to arrears if it is not cleared, negative is credit. parseRentLine already
       reads Frular's two different sentences correctly; this only has to not flatten them
       back together. -->
  <h2>Guild hall</h2>
  <div class="sub" style="margin-top:-.4rem">Rent, and what is in the chests · none of this
    is pushed by the server, so every figure is the last thing somebody was told</div>
  ${(() => {
    const rent = storage.readRent();
    if (!rent) return `<p class="dim">Nobody has asked Frular about rent. He states it out
      loud and never mentions it again (gcreator.kod:180), so it has to be asked for in
      person at room ${esc(String(700))} — <code>guild action=status</code>.</p>`;
    if (rent.in_guild === false)
      return `<p class="dim">The character who asked belongs to no guild, so there is no
        rent to report. <span class="dim">asked ${esc(ago(rent.observed_at))}</span></p>`;
    const owed = rent.due != null && rent.due > 0;
    const credit = rent.due != null && rent.due < 0;
    return `<div class="cards">
      <div class="card"><div class="k">${owed ? 'rent owed' : credit ? 'rent credit' : 'rent'}</div>
        <div class="v ${owed ? 'bad' : credit ? 'good' : 'dim'}">${rent.due == null ? '?' :
          owed ? num(rent.due) : credit ? '+' + num(-rent.due) : '0'}</div>
        <div class="n">${rent.due == null
            ? 'he said something this page could not parse — deliberately not shown as zero'
            : owed ? 'shillings owed — positive is a DEBT and the hall is lost to arrears'
            : credit ? 'shillings in hand against future rent' : 'nothing owed'}</div></div>
      ${rent.hours_left != null ? `<div class="card"><div class="k">hours to pay</div>
        <div class="v ${rent.hours_left <= 1 ? 'bad' : rent.hours_left <= 6 ? 'warn' : ''}">${rent.hours_left}</div>
        <div class="n">before the arrears deadline</div></div>` : ''}
      <div class="card"><div class="k">asked</div><div class="v" style="font-size:1rem">${esc(ago(rent.observed_at))}</div>
        <div class="n">${rent.asked_by ? 'by ' + esc(rent.asked_by) : 'by somebody'}</div></div>
    </div>
    ${rent.said ? `<p class="dim" style="font-size:.78rem">He said: &ldquo;${esc(rent.said)}&rdquo;</p>` : ''}`;
  })()}

  <h3>Chests</h3>
  <div class="sub" style="margin-top:-.4rem">A chest is ${num(CHEST_BULK_MAX)} BULK and no
    weight limit at all (chest.kod:29) — so it is the one store in the game that a heavy
    haul does not fill. The Bookmaker's hall builds ${BOOKMAKERS_CHESTS}
    (guildh14.kod:518,520,522); a hall may hold ${GUILD_CHEST_SLOTS}, so there are
    ${GUILD_CHEST_SLOTS} slots here and an unused one says so rather than being hidden.</div>
  <div class="chests">
    ${storage.allChests().map(ch => ch.never_opened
      ? `<div class="chest empty"><h3>chest ${ch.slot}</h3>
           <div class="dim" style="font-size:.8rem">never opened — nothing has looked inside
           this slot. That is not the same as empty.</div></div>`
      : `<div class="chest"><h3>chest ${ch.slot}</h3>
           ${meter(ch.fullness.percent, `${ch.fullness.bulk} of ${CHEST_BULK_MAX} bulk`)}
           <div class="dim" style="font-size:.75rem;margin:.35rem 0">
             ${ch.items.length} stack(s) · ${ch.fullness.bulk} bulk ·
             opened ${esc(ago(ch.observed_at))}${ch.opened_by ? ' by ' + esc(ch.opened_by) : ''}</div>
           ${itemList(ch.items, 'empty')}</div>`).join('')}
  </div>

  <h2>Every character</h2>
  <div class="sub">Rows tinted orange are under ${SHORT_BELOW} of a reagent and cannot cast
    their way out of an empty larder. <em>meals</em> is how many <em>create food</em> this
    character could cast right now, which is the only thing the reagents are for.</div>
  <div class="panel scroller" style="padding:.25rem .5rem">
  <table>
    <thead><tr><th>character</th><th class="num">purse</th><th class="num">banked</th>
      <th>balance</th><th class="num">elder</th><th class="num">herbs</th>
      <th class="num" title="create food castings this character could pay for out of its own pack">meals</th>
      <th title="live is the inventory this second; a time is how old the reading is">pack read</th>
      <th title="weight and bulk both cap at 1700 + might*20, and the pack is full when EITHER is reached — this is the worse of the two">pack full</th>
      <th title="a vault is bulk-only and 3000 per depositor, not per vault">vault full</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="8" class="empty">nothing on record yet</td></tr>'}</tbody>
  </table>
  </div>

  ${purseUnknown ? `
  <div class="caveat">
    <b>${purseUnknown} character(s) have no purse reading.</b> A purse is not announced by
    anything — unlike a bank balance, which a banker says out loud — so the only record of
    one is the ledger sample, and the sample only carries it while the broker is running
    code that writes it down. Restart the broker
    (<code>node tools/m59-service.mjs restart --fleet ${esc(FLEET_LABEL)}</code>) and the
    column fills in within five minutes. The bank and reagent columns do not depend on it.
  </div>` : ''}

  <h2>What the money bought</h2>
  ${e.spend.total ? `
  <div class="panel scroller" style="padding:.25rem .5rem">
  <table>
    <thead><tr><th>kind</th><th class="num">items</th><th class="num">spent</th>
      <th class="num">each</th></tr></thead>
    <tbody>${spendRows}</tbody>
  </table>
  </div>` : `
  <div class="panel"><div class="empty">nothing was bought in this window.<br>
    <span class="dim" style="font-size:.85rem">That is not necessarily a fault: the fleet's
    supply plan is to CAST its food rather than buy it, and nothing here can buy prepared
    food at all — a merchant's list is filtered through the shareable set, which holds
    elderberry and herbs and nothing else.</span></div></div>`}

  ${declinedRows ? `
  <h2>Why a purchase did not happen</h2>
  <div class="sub">The thing no log of purchases can tell you.</div>
  <div class="panel scroller" style="padding:.25rem .5rem">
  <table><thead><tr><th>reason</th><th class="num">times</th></tr></thead>
  <tbody>${declinedRows}</tbody></table>
  </div>` : ''}

  <div class="caveat" style="margin-top:1.5rem">${esc(e.read_this_way)}</div>
</div>
<script>
var FACETS = ${JSON.stringify(FACETS)};
${TREEMAP_JS}
${FACET_WIRING_JS}
pickFacet('wealth');
</script>
</body></html>`;
}
