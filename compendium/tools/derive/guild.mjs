// derive/guild.mjs -- the guild chest: the plan the hall is kept to, and the sales that keep it.
//
// The page is assets/guild.js over four harness endpoints (tools/m59-compendium.mjs):
//   GET  /_guildchest          the board: every chest against the plan, the sell plan, the jobs
//   POST /_guildplan           save plan edits (the endpoint the old guild-hall sheet uses)
//   POST /_guildsale/plan      save the standing sell plan
//   GET  /_guildsale/couriers  who could carry a sale now, ranked (tools/m59-guild-sale.mjs)
//   POST /_guildsale/dry       a sale walked on paper: reads everything, moves nothing
//   POST /_guildsale/jobs      sell now, or at a time — the server's scheduler launches it
//   POST /_guildsale/cancel    a scheduled sale that has not started
// Served as files it says so and draws nothing: there is no chest to show without the harness.

export const meta = {
  id: 'guild', title: 'Guild Chest', dir: 'guild', order: 3, nav: true,
  blurb: 'What the guild hall\'s chests are planned to hold, what is over and under, and the sales that make room.',
};

export function build() {
  const indexHtml = `<div class="gc-head">
  <div>
    <h1>Guild chest</h1>
    <p class="lede">The plan the hall's chests are kept to, read against what is in them — and the
    sales that make room, with a courier and a place for the money.</p>
  </div>
  <div class="gc-tools"><button type="button" class="btn" id="gcRefresh">Refresh</button></div>
</div>
<div class="gc-status" id="gcStatus" role="status"></div>

<section class="gc-sec">
  <h2>The chests</h2>
  <div class="gc-chests" id="gcChests"></div>
</section>

<section class="gc-sec">
  <div class="gc-sec-h">
    <h2>The plan</h2>
    <div class="gc-tabs" id="gcTabs" role="tablist" aria-label="Chest"></div>
  </div>
  <div id="gcPlan"></div>
</section>

<section class="gc-sec" id="gcSaleSec">
  <h2>Sell</h2>
  <div class="gc-sale">
    <div class="gc-sale-a">
      <h3>What to sell</h3>
      <div id="gcLines"></div>
      <div class="gc-add">
        <input id="gcAddItem" list="gcItemList" placeholder="item" autocomplete="off" spellcheck="false" aria-label="Item to sell">
        <input id="gcAddAmt" type="number" min="1" step="1" value="1" aria-label="Amount">
        <button type="button" class="btn" id="gcAddLine">Add</button>
        <button type="button" class="btn" id="gcFillEvict" title="Every first-planned eviction that some merchant buys">Add the planned evictions</button>
      </div>
      <h3>Where the money goes</h3>
      <div class="gc-proceeds" id="gcProceeds"></div>
      <div class="gc-row"><button type="button" class="btn" id="gcSavePlan">Save sell plan</button><span class="gc-note" id="gcPlanMsg"></span></div>
    </div>
    <div class="gc-sale-b">
      <h3>Courier</h3>
      <div class="gc-row">
        <select id="gcCourier" aria-label="Courier"><option value="auto">Automatic — best available</option></select>
        <button type="button" class="btn" id="gcFind">Find couriers</button>
        <label class="gc-check"><input type="checkbox" id="gcBorrow"> may borrow one from its training</label>
      </div>
      <div id="gcCouriers" class="gc-couriers"></div>
      <h3>Go</h3>
      <div class="gc-go">
        <button type="button" class="btn" id="gcDry">Dry run</button>
        <button type="button" class="btn primary" id="gcNow">Sell now…</button>
        <span class="gc-at"><input type="datetime-local" id="gcAt" aria-label="Sell at"><button type="button" class="btn" id="gcLater">Sell at…</button></span>
      </div>
      <pre class="gc-log" id="gcDryLog" hidden></pre>
    </div>
  </div>
</section>

<section class="gc-sec">
  <h2>Sales</h2>
  <div id="gcJobs"></div>
</section>

<datalist id="gcItemList"></datalist>
<dialog class="gc-dialog" id="gcDialog"><div id="gcDialogBody"></div></dialog>

<details class="gc-rules">
  <summary>How this page reads the chests, and what a sale does</summary>
  <p><strong>The bar.</strong> A chest holds 24,000 bulk (chest.kod:29). <em>Kept</em> is stock the
  plan wants, up to its target. <em>Surplus</em> is planned stock above target. <em>Unplanned</em> is stock
  no plan line names. <em>Reserved</em> is room the plan is holding for stock that has not arrived — it
  looks free and is not. Bulk is from the item table; an item it cannot size counts zero, so a
  chest can be fuller than it reads. Everything is from each chest's last reading, which is
  as old as it says.</p>
  <p><strong>Evictions</strong> are in the order things would leave: unplanned stock first, then surplus,
  cheapest per bulk first within each (tools/m59-chest-eviction.mjs). Shillings never leave.</p>
  <p><strong>A sale</strong> is one courier: it walks to the hall, puts its own guild drop-off in first —
  that is the room in its pack — draws what fits, sells each item to the merchant who buys it
  (Barloque first), and repeats, up to six trips (tools/m59-chest-evict-run.mjs). Then the
  money: banked by the courier at Tos or Jasper (there is no banker in Barloque), handed to a
  named character at that bank who banks it, or put back into the hall — as shillings in a chest,
  or as rent credit with Frular. Only what the sale raised moves; the courier keeps the purse it
  came with. One sale runs at a time. A dry run reads everything and moves nothing.</p>
  <p><strong>The courier</strong> must be able to open the chests (rank sir in the vault-desk config, or
  seen opening them), be over 30 max health, not be driven by anything else, and not be desk
  staff while the vault desk is open. Then: nearest to the hall first; a character already
  carrying guild wants is preferred; one that would need many trips pays for them.</p>
</details>`;
  return { indexHtml, pages: [], scripts: ['guild.js'], styles: ['guild.css'] };
}
