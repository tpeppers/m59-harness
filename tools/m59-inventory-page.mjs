// /inventory — WHAT THE FLEET IS CARRYING, WITH ROOM TO ACTUALLY LIST IT.
//
// Split out of /economy on 2026-09-17 at the operator's request: "let's break apart Economy
// (food/money/banking -- w/carve out exception for elders/herbs as 'create food') separated from
// Inventory (inventory items, pack-filled %, guild chests), giving the inventory more room to
// actually list out (no '... and 20 more')."
//
// THE TRUNCATION WAS THE WHOLE PROBLEM. The economy page listed a pack as forty names and then
// "and 20 more", inside a `<details>` inside a table row — which is the right shape for a
// footnote and the wrong one for the question people were actually bringing to it. A pack meter
// at 97% is a question; the answer is the list, and an answer that stops at forty is not one.
// Nothing here caps a list.
//
// AND THE TWO PAGES ASK DIFFERENT QUESTIONS, which is the better reason to split them than
// length. /economy asks whether the chain from loot to vigor is flowing — shillings, the bank,
// and the two reagents that `create food` turns into vigor. That is why elderberry and herbs
// STAY THERE and are not repeated here: on this fleet they are not inventory, they are fuel, and
// a reader looking at the food chain should not have to hold two tabs open. This page asks the
// other question — what is in the packs, how full are they, and what is in the chests — and it
// is the page somebody opens when a hand-over failed or a pack will not take any more.
//
// MAGIC ITEMS ARE MARKED HERE AND EVERYWHERE ELSE A PACK IS LISTED. `magicTag` is in
// m59-page-chrome.mjs beside the tab bar, for the reason the tab bar is there: six boards render
// inventories and a seventh opinion about what magic means would be invisible from whichever
// copy nobody edited. What it will NOT do is guess — an item nobody has looked at has no
// description to show, and rendering that as a plain name would assert it is mundane. See
// `magicOf` in m59-magicsort.mjs for the three states and why the grade alone is not one of them.
import { economy } from './m59-economy.mjs';
import { resolveFleet } from './m59-fleetpath.mjs';
import { esc, ago, num, NAV, STYLE, magicTag } from './m59-page-chrome.mjs';
import { StorageCache, GUILD_CHEST_SLOTS, VAULT_BULK_MAX, CHEST_BULK_MAX,
         BOOKMAKERS_CHESTS } from './m59-storage.mjs';
import { loadLooks, loadList, magicOf } from './m59-magicsort.mjs';
import { guildPlan, normalisePlan } from './m59-guildwants.mjs';
import { evictionOrder } from './m59-chest-eviction.mjs';

const { label: FLEET_LABEL } = resolveFleet();

const EXTRA_STYLE = `
  .packs { display:grid; gap:1rem; }
  .pack-card { background:var(--panel); border:1px solid var(--line); border-radius:10px;
               padding:.8rem 1rem; }
  .pack-card.full { border-color:#bf616a; }
  .pack-card h3 { margin:0 0 .2rem 0; font-size:.95rem; display:flex; gap:.6rem;
                  align-items:baseline; flex-wrap:wrap; }
  .pack-card h3 .pct { font-variant-numeric:tabular-nums; font-size:.8rem; color:var(--dim); }
  .stores { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:.9rem;
            margin-top:.6rem; }
  .store h4 { margin:0 0 .3rem 0; font-size:.8rem; text-transform:uppercase;
              letter-spacing:.04em; color:var(--dim); }
  /* THE LIST IS THE POINT, so it gets the width and the wrapping rather than one clipped line. */
  .itemgrid { display:flex; flex-wrap:wrap; gap:.25rem .7rem; font-size:.82rem;
              line-height:1.5; }
  .itemgrid .it { white-space:nowrap; }
  .itemgrid .none { color:var(--dim); font-style:italic; white-space:normal; }
  .chests { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr)); gap:1rem; }
  .chest h4 { margin:.7rem 0 .25rem 0; font-size:.75rem; text-transform:uppercase;
              letter-spacing:.04em; color:var(--dim); }
  .evict { margin:0; padding-left:1.6rem; font-size:.8rem; line-height:1.45; }
  .evict .t { font-size:.7rem; color:var(--dim); }
  .hist { font-size:.78rem; line-height:1.45; }
  .hist .when { color:var(--dim); font-variant-numeric:tabular-nums; }
  .chest { background:var(--panel); border:1px solid var(--line); border-radius:10px;
           padding:.8rem 1rem; }
  .chest.empty { border-style:dashed; opacity:.72; }
  .chest h3 { margin:0 0 .3rem 0; font-size:.85rem; }
  .bar { height:6px; background:var(--line); border-radius:3px; overflow:hidden; margin:.35rem 0; }
  .bar > i { display:block; height:100%; background:#8fbcbb; }
  .bar.hatch { background:repeating-linear-gradient(45deg,var(--line),var(--line) 4px,
               transparent 4px,transparent 8px); }
`;

// 0-100 with a fixed scale, and null renders hatched rather than as zero — "nobody has looked"
// and "it is empty" are opposite facts about a store, and the same rule the economy page follows.
function bar(percent, title = '') {
  if (percent == null)
    return `<div class="bar hatch" title="${esc(title || 'nobody has looked')}"></div>`;
  const p = Math.max(0, Math.min(100, Number(percent)));
  return `<div class="bar" title="${esc(title)}"><i style="width:${p}%"></i></div>`;
}

/**
 * ONE STORE'S CONTENTS, IN FULL.
 *
 * No cap. The old list stopped at forty and said "and 20 more", which is the one thing this
 * page exists to stop doing. A stack shows its count; a magic item shows its marker and carries
 * its description in the tooltip.
 *
 * The empty cases are DIFFERENT and must not render alike: an empty pack is a fact, an unheld
 * character is the absence of one, and a row with no such field at all is a broker older than
 * this page. Same rule the hatched bar follows.
 */
function itemGrid(items, empty, ctx) {
  if (!items || !items.length)
    return `<div class="itemgrid"><span class="none">${esc(empty)}</span></div>`;
  return `<div class="itemgrid">${items.map(i => {
    const m = magicOf(i, ctx);
    const count = (i.amount ?? 1) > 1 ? ` <span class="dim">x${num(i.amount)}</span>` : '';
    return `<span class="it">${esc(i.name)}${count}${magicTag(m)}</span>`;
  }).join('')}</div>`;
}

// A RANKING, NOT A LOG. Nothing evicts from a guild chest yet: the server never does
// (chest.kod:29) and nothing in this repository withdraws by this order. So the card says
// "would give up first", and the history underneath says "left between readings", which is
// all two readings of a chest can know. See m59-chest-eviction.mjs.
const EVICT_SHOWN = 12;
function chestCard(ch, planItems, history, ctx) {
  const f = ch.fullness;
  const pctCls = f.percent >= 90 ? 'bad' : f.percent >= 70 ? 'warn' : '';
  const ev = evictionOrder(ch, planItems);
  const rows = ev.rows.slice(0, EVICT_SHOWN);
  const more = ev.rows.length - rows.length;
  const evictList = !ev.rows.length
    ? `<div class="dim" style="font-size:.78rem">nothing: every stack is within its plan target</div>`
    : `<ol class="evict">${rows.map(r => `<li>${esc(r.name)} <span class="dim">x${num(r.evict)}</span>
         <span class="t">· ${r.tier} · ${r.bulk == null ? 'bulk unknown' : `${num(r.bulk)} bulk`}
         · ${r.value_each == null ? 'no price' : `${num(r.value_each)} each`}</span></li>`).join('')}</ol>
       ${more > 0 ? `<details><summary class="dim" style="font-size:.75rem">and ${more} more, in order</summary>
         <ol class="evict" start="${EVICT_SHOWN + 1}">${ev.rows.slice(EVICT_SHOWN).map(r =>
           `<li>${esc(r.name)} <span class="dim">x${num(r.evict)}</span>
            <span class="t">· ${r.tier}</span></li>`).join('')}</ol></details>` : ''}
       <div class="dim" style="font-size:.72rem;margin-top:.2rem">evicting all of it frees
         ${num(ev.freeable_bulk)} bulk${ev.unknown_bulk.length ? ` plus ${ev.unknown_bulk.length}
         item(s) the weight table cannot size` : ''} · ${planItems ? `${planItems.length} planned item(s) kept to target`
         : 'no guild plan names this chest'}</div>`;
  const hist = !history.length
    ? `<div class="dim" style="font-size:.78rem">no change seen between readings yet. The history
         starts with the first re-reading after this was deployed.</div>`
    : `<div class="hist">${history.map(h => {
        const out = h.left.map(x => `${esc(x.name)} x${num(x.amount)}`).join(', ');
        const inn = h.arrived.map(x => `${esc(x.name)} x${num(x.amount)}`).join(', ');
        return `<div><span class="when">${esc(ago(h.at))}</span>
          ${out ? `<span class="bad">out</span> ${out}` : ''}${out && inn ? ' · ' : ''}${inn
          ? `<span class="dim">in</span> ${inn}` : ''}</div>`;
      }).join('')}</div>`;
  return `<div class="chest"><h3>${esc(ch.slot)}
      <span class="${pctCls}" style="font-weight:normal">${f.percent}%</span></h3>
    ${bar(f.percent, `${f.bulk} of ${f.max} bulk`)}
    <div class="dim" style="font-size:.75rem">${num(f.bulk)} of ${num(f.max)} bulk
      · ${num(f.max - f.bulk)} free · ${ch.items.length} stack(s)
      ${f.exact ? '' : ` · LOWER BOUND, ${f.unweighed.length} name(s) not in the weight table`}
      · read ${esc(ago(ch.observed_at))}</div>
    ${itemGrid(ch.items, 'empty', ctx)}
    <h4>would give up first</h4>
    ${evictList}
    <h4>left or arrived between readings</h4>
    ${hist}
  </div>`;
}

export function renderInventory({ hours = 168, live = null, characters = null } = {}) {
  const e = economy({ sinceMs: hours * 3600 * 1000, live, characters });
  const storage = new StorageCache();

  // READ ONCE, FOR THE WHOLE PAGE. The look cache and the keep list are files; opening them per
  // item would be a few thousand reads to render one board.
  const ctx = { looks: loadLooks(), list: loadList() };
  // THE PLAN IS READ ONCE and its problems are not this page's to print: /planner owns them. A
  // missing plan is null, and a chest with no plan ranks every stack as unplanned, which is true.
  let plan = null;
  try { const raw = guildPlan(); plan = !raw ? null : raw.chests instanceof Map ? raw : normalisePlan(raw); }
  catch { plan = null; }
  const planFor = (slot) => plan?.chests.get(slot) ?? null;

  const liveOf = new Map((live || []).map(x => [x.character, x]));
  const rows = e.rows.map(r => ({
    character: r.character,
    l: liveOf.get(r.character) ?? null,
    vault: storage.readVault(r.character),
  }));

  // WORST FIRST, because the reason somebody opens this page is that something would not fit.
  // A pack with no reading sorts last rather than as 0% — it is not the emptiest, it is unknown.
  const sorted = [...rows].sort((a, b) =>
    (b.l?.pack?.percent ?? -1) - (a.l?.pack?.percent ?? -1));

  const held = rows.filter(r => r.l?.pack).length;
  const tight = rows.filter(r => (r.l?.pack?.percent ?? 0) >= 90).length;
  const magicHeld = rows.reduce((n, r) => n +
    (r.l?.pack_items ?? []).filter(i => magicOf(i, ctx)).length +
    (r.vault?.items ?? []).filter(i => magicOf(i, ctx)).length, 0);
  const unread = rows.reduce((n, r) => n +
    (r.l?.pack_items ?? []).filter(i => magicOf(i, ctx)?.grade === 'unidentified').length, 0);

  const packCards = sorted.map(({ character, l, vault }) => {
    const pack = l?.pack ?? null;
    const full = (pack?.percent ?? 0) >= 90;
    return `
    <div class="pack-card${full ? ' full' : ''}">
      <h3>${esc(character)}
        <span class="pct">${pack ? `pack ${pack.percent}% · ${pack.binding}-bound`
                                 : 'pack not read'}</span>
        <span class="pct">${vault ? `vault ${vault.fullness.percent}%` : 'vault never read'}</span>
      </h3>
      ${bar(pack?.percent ?? null, pack
        ? `${pack.bulk} bulk / ${pack.weight} weight against ${pack.max}, ${pack.binding}-bound`
        : 'no live inventory for this character — a stored sample carries totals, not an item list')}
      <div class="stores">
        <div class="store">
          <h4>pack</h4>
          ${pack ? `<div class="dim" style="font-size:.74rem">${pack.bulk} bulk / ${pack.weight} weight
             against a ceiling of ${num(pack.max)} (1700 + might*20)${pack.exact ? ''
             : ' — LOWER BOUND, some items are not in the weight table'}</div>` : ''}
          ${itemGrid(l?.pack_items, !l
            ? 'no item list — this character is not being held by the broker right now, and a stored sample carries totals rather than names'
            : Array.isArray(l.pack_items) ? 'nothing in the pack'
            : 'the broker holding this character is running code that does not report the item list — restart it and this fills in', ctx)}
        </div>
        <div class="store">
          <h4>vault</h4>
          ${vault ? `<div class="dim" style="font-size:.74rem">${vault.fullness.bulk} of
             ${num(VAULT_BULK_MAX)} bulk · read ${esc(ago(vault.observed_at))}</div>` : ''}
          ${itemGrid(vault?.items,
            'never read — a vault states its contents only when a withdrawal is requested', ctx)}
        </div>
      </div>
    </div>`;
  }).join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Inventory — ${esc(FLEET_LABEL)} fleet</title>
<meta http-equiv="refresh" content="60">
<style>${STYLE}${EXTRA_STYLE}</style>
</head><body><div class="wrap">
  <h1>Inventory</h1>
  <div class="sub">Every pack, every vault, every chest — listed in full · ${esc(FLEET_LABEL)} fleet
    · shillings, the bank and the two <a href="/economy">create food</a> reagents live on the
    Economy page, because on this fleet they are fuel rather than cargo</div>
  ${NAV('inventory')}

  <div class="cards">
    <div class="card"><div class="k">packs read</div><div class="v">${held}</div>
      <div class="n">of ${rows.length} character(s) · the rest are not being held right now</div></div>
    <div class="card"><div class="k">at or over 90%</div>
      <div class="v ${tight ? 'warn' : ''}">${tight}</div>
      <div class="n">a full pack refuses every hand-over, on WEIGHT, and says nothing</div></div>
    <div class="card"><div class="k">magic items held</div><div class="v">${magicHeld}</div>
      <div class="n">in packs and vaults · hover any one for its description</div></div>
    <div class="card"><div class="k">awaiting a reveal</div>
      <div class="v ${unread ? 'warn' : ''}">${unread}</div>
      <div class="n">graded unidentified — ${unread ? `${unread * 3} orc teeth to read them all`
        : 'nothing in the fleet reads unidentified'}</div></div>
  </div>

  <h2>Every pack</h2>
  <div class="sub" style="margin-top:-.4rem">Fullest first, because the reason to open this page
    is usually that something would not fit. A character nobody is holding sorts LAST rather than
    as 0% — an unread pack is unknown, not empty. Nothing below is truncated.</div>
  <div class="packs">${packCards || '<div class="dim">no characters</div>'}</div>

  <h2>Guild chests</h2>
  <div class="sub" style="margin-top:-.4rem">A chest is ${num(CHEST_BULK_MAX)} BULK and no
    weight limit at all (chest.kod:29) — so it is the one store in the game that a heavy
    haul does not fill. The Bookmaker's hall builds ${BOOKMAKERS_CHESTS}
    (guildh14.kod:518,520,522) at r18c2, r18c6 and r20c4; a hall may hold ${GUILD_CHEST_SLOTS}.
    Each is named by the SQUARE it stands on rather than by a slot number — an object id is
    a handle the server recycles and a chest cannot move — so only chests somebody has
    actually looked inside appear here. There is no list of every square a chest could
    occupy, and inventing rows for the unopened ones would be inventing chests.
    <b>Nothing evicts from a chest yet</b> — a full one refuses the next deposit — so "would give
    up first" is the order the guild plan implies (not in this chest's plan, then above its
    target; least value per bulk first, unpriced last), and the history is what changed between
    two readings, whoever took it.</div>
  <div class="chests">
    ${storage.allChests().length === 0
      ? `<div class="chest empty"><h3>nothing looked in yet</h3>
           <div class="dim" style="font-size:.8rem">no chest in the hall has been opened.
           That is not the same as the hall being empty.</div></div>`
      : storage.allChests().map(ch => !ch.items
      ? `<div class="chest empty"><h3>${esc(ch.slot)}</h3>
           <div class="dim" style="font-size:.8rem">opened, but nothing has been read out of
           this chest. That is not the same as empty.</div></div>`
      : chestCard(ch, planFor(ch.slot), storage.readChestHistory(ch.slot, { limit: 8 }), ctx)).join('')}
  </div>

  <div class="sub" style="margin-top:1.2rem">Magic markers come from the server's own rarity
    grade and from ${esc(ctx.list.source?.exists ? ctx.list.source.path : 'the committed default list')}.
    A description is shown when somebody has read one — ${
      Object.keys(ctx.looks.items ?? {}).length} item name(s) have been read so far, by
    <code>m59-reveal.mjs desk --look</code>. An item with nothing read carries no marker, which
    means "nothing is known", never "it is ordinary".${ctx.looks.unreadable
      ? ` <b>The look cache at ${esc(ctx.looks.source)} will not parse (${esc(ctx.looks.unreadable)}),
          so every tooltip below is missing its description.</b>` : ''}</div>
</div></body></html>`;
}
