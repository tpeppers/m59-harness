// derive/party.mjs -- the fleet as a party: every character at once, then one at a time.
//
// The planner (derive/planner.mjs) is the client's own panel, rebuilt, for ONE character's
// whole loadout — gear, carry list, sell rules. This page is the layer above it: which
// schools and Weaponcraft levels each character is heading for, read against what it
// already knows, with similar characters drawn next to each other so a fleet of twenty-four
// can be managed as a handful of builds rather than twenty-four forms.
//
// It writes the same file the planner writes — `substrate/loadouts/<character>.json` — but
// through `/_plan`, which replaces only the `plan` and leaves every other field as it is on
// disk at that moment. `/_loadout` normalises the whole file, which drops fields it does not
// know and clips long notes; a school change must not cost the operator's notes on armour.
//
// THE LEARNING ARITHMETIC IS NOT HERE. It is `assets/learn.js`, inlined from
// `tools/learn.mjs` by derive/planner.mjs, and this page calls
// `RemainingRequiredToLearnNewSkills` — the character-level function that counts
// GetNumAtLevel off the catalogue, as the server does (system.kod:1693), rather than off
// what the character happens to know.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, esc } from '../lib.mjs';

export const meta = {
  id: 'party', title: 'Party', dir: 'party', order: 1, nav: true,
  blurb: 'The whole fleet as a party: what every character knows, what it is heading for, and what to train next.',
};

export function build() {
  let data = null;
  try { data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'planner.json'), 'utf8')); }
  catch { /* reported below */ }
  if (!data) {
    return {
      indexHtml: `<h1>Party</h1>
<p class="lede">This page needs <code>data/planner.json</code>. Run
<code>node tools/m59-planner-data.mjs</code> in the harness and rebuild.</p>`,
      pages: [], scripts: [], styles: [],
    };
  }
  const c = data.learning?.cites ?? {};
  const indexHtml = `<div class="pt-head">
  <div>
    <h1>Party</h1>
    <p class="lede">Every character in the fleet, side by side. Pick one to plan its schools;
    similar builds sit together so you can set one and copy it across.</p>
  </div>
  <div class="pt-tools">
    <label class="pt-sort">Arrange by
      <select id="ptSort">
        <option value="build">build</option>
        <option value="name">name</option>
        <option value="level">hit points</option>
        <option value="intellect">intellect</option>
        <option value="budget">points left</option>
      </select>
    </label>
    <button type="button" class="btn" id="ptRefresh" title="Read every character from the broker again">Refresh</button>
  </div>
</div>

<div class="pt-status" id="ptStatus" role="status"></div>
<div class="pt-roster" id="ptRoster" aria-label="Fleet roster"></div>

<section class="pt-sheet" id="ptSheet" hidden aria-live="polite"></section>

<dialog class="pt-dialog" id="ptDialog"><div id="ptDialogBody"></div></dialog>

<details class="pt-rules">
  <summary>How the numbers on this page are worked out</summary>
  <p><strong>Learn points.</strong> Every character has one budget across seven tracks: the
  six schools plus Weaponcraft, which pools every weapon skill. A track costs points for the
  <em>highest</em> level held in it, 1 / 2 / 4 / 6 / 8 / 10 for levels 1–6
  (<code>vlLevelPoints</code>, kod/util/system.kod:414). Everything below that level is free.
  Blink does not count. The budget is
  <code>16 + floor(14 × intellect / 5) / 7</code>, rounded down, which is 32 at intellect 40 and
  36 at 50 — the most <code>PlayerCanLearn</code> will ever allow, because past it the
  requirement exceeds three spells at 99%. Base intellect only; an intellect charm buys nothing
  here.</p>
  <p><strong>Ready to learn.</strong> The first ability at a new level needs the
  <em>best three</em> abilities you hold one level below, in the same track, to add up to the
  requirement: <code>7 × points-after + 185 − floor(14 × intellect / 5)</code>, never below 75.
  When the level below has only one or two abilities in the whole game, the requirement is
  divided by 3 or multiplied by ⅔. Once you hold one ability at level 3 or above in a track,
  the rest of that level is free. Constants: <code>POINTS_SLOPE</code> ${esc(c.POINTS_SLOPE ?? '')},
  <code>MIN_NEEDED_TO_ADVANCE</code> ${esc(c.MIN_NEEDED_TO_ADVANCE ?? '')},
  <code>MAX_LEARN_POINTS</code> ${esc(c.MAX_LEARN_POINTS ?? '')}.</p>
  <p><strong>Not modelled, and worth knowing.</strong> Level-3 spells in Kraanan, Faren,
  Shal’ille and Qor need that school's disciple quest, once. Shal’ille needs karma ≥ +10 per
  level and Qor ≤ −10 per level, so one character cannot plan both. Every point spent outside
  a school slows improvement inside it, one-for-one.</p>
  <p><strong>Saving</strong> writes <code>substrate/loadouts/&lt;character&gt;.json</code> —
  only its <code>plan</code>, through <code>/_plan</code>. Everything else in the file is read
  from disk at that moment and written back as it was, notes included. The keeper reads it on its next pass: the plan becomes the order it buys in.
  Gear and the carry list are edited in the <a href="../planner/index.html">loadout planner</a>.</p>
</details>

<div class="pt-dock" id="ptDock" hidden>
  <div class="pt-dock-in">
    <span id="ptDockText"></span>
    <span class="grow"></span>
    <button type="button" class="btn" id="ptDiscard">Discard changes</button>
    <button type="button" class="btn primary" id="ptReview">Review &amp; save…</button>
  </div>
</div>`;
  return {
    indexHtml, pages: [],
    // learn.js is written by derive/planner.mjs; it is the one copy of the arithmetic.
    scripts: ['learn.js', 'party.js'],
    styles: ['party.css'],
  };
}
