#!/usr/bin/env node
// GIVE THE WALLS ANOTHER CHANCE, because the last test was conducted from the wrong
// place.
//
//   node tools/m59-safespot-retest.mjs --dry-run     # what it would clear
//   node tools/m59-safespot-retest.mjs               # clear them, keeping a backup
//   node tools/m59-safespot-retest.mjs --only-unheld # only squares that never held
//
// A failure in the book means "we stood here, did not swing, and were hit anyway",
// which is sound evidence and is treated as permanent — one failure and the square is
// never recommended again. The asymmetry is deliberate: being wrong about a bad spot
// costs a character, being wrong about a good one costs a walk.
//
// THE EVIDENCE WAS COLLECTED FROM THE WRONG POSITION. The safe-spot mechanic is finer
// than the movement grid — it lives in the BSP walls and the angles — and a square is
// entered by walkTo, which aims at the CENTRE of the square (col*64+32). A spot that
// works by hugging a wall can be most of a square away from that centre. Only a
// remembered spot carried a fine position, and a square gets a remembered position by
// holding first, so EVERY FIRST TEST of every candidate was made from the middle of
// the floor rather than against the wall.
//
// That is a mechanism for manufacturing false failures out of good walls, and the
// shape of the data matches: of 431 recorded failures, 74% happened against a SINGLE
// attacker, and 98 of them are on squares that had also successfully held. A square
// that both holds and fails against one attacker is not a bad square; it is a square
// tested from two different places.
//
// takeSafeSpot now aims at the wall on first contact, so those readings were taken
// under conditions that no longer apply. Clearing them is not forgetting evidence, it
// is discarding a measurement whose method was wrong. `held` history is kept — that
// evidence was always valid, because holding is holding wherever you stood.
// A THIRD DISCRIMINATOR, AND THE ONLY ONE THAT HANDS THE SQUARE BACK UNTESTED.
//
//   node tools/m59-safespot-retest.mjs --untested --dry-run
//
// The pardon below clears the failure and KEEPS `held`, on the sound reasoning that
// holding is holding wherever you stood. That is right for a measurement retired because
// of where the character was standing. It is wrong for this one: takeSafeSpot inherits
// `proven` from a clean held record, so a pardoned square is rested on immediately, and
// what is being undone here is precisely a judgement we no longer trust.
//
// The cause is packet timing. A blow resolved on the server while we were still a square
// short can arrive after we have reported standing on the spot, and observe() blamed the
// square for it — permanently. SETTLE_GRACE_MS in m59-autopilot.mjs closed that in
// August 2026; everything retired before it was judged without it.
//
// The signature is a square that had PROVED itself and then went out on at most one
// point of damage, which is what a single late packet looks like. Of 1969 squares on
// record, 1467 were discredited; 519 of those had held first, and 309 of THOSE went out
// on a single point. They come back as untested — eligible, unproven, and made to earn
// their twelve quiet seconds again with a character standing on them.
import { selectForRetest, reinstateUntested } from './m59-safespots.mjs';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const arg = (n) => process.argv.includes('--' + n);
const argVal = (n) => { const i = process.argv.indexOf('--' + n); return i < 0 ? null : process.argv[i + 1]; };
const DRY = arg('dry-run');
const ONLY_UNHELD = arg('only-unheld');
// DELETE THE PHANTOMS, RATHER THAN PARDONING THEM.
//
//   node tools/m59-safespot-retest.mjs --phantoms --dry-run
//
// A pardon (above) says "this failure was measured badly". These were not measured at
// all. restBroken() used to condemn whatever square a character was standing on when a
// rest was interrupted, without checking that anything was next to it — so a character
// crossing a town, sitting down, and being interrupted by something that is not an
// attack wrote a failure against a paving stone. 130 of the book's 474 failures were
// written that way, 116 of them in five rooms with nothing hostile in them.
//
// The signature is exact and cannot collide with a real reading, because observe() and
// the death path both refuse to record with nothing adjacent: attackers zero AND the
// damage equal to the failure count, which is restBroken's hardcoded `damage: 1` per
// call. A genuine failure has a measured loss and something that did the losing.
//
// These are DELETED rather than zeroed. A pardoned square is a real square whose
// verdict was withdrawn and which is worth re-testing; a phantom is a square nobody
// ever tested, and leaving a record behind implies a visit that did not happen.
const PHANTOMS = arg('phantoms');
const isPhantom = r => (r.failed || 0) >= 1 && (r.most_attackers || 0) === 0 &&
                       (r.damage_taken || 0) === (r.failed || 0);

// THE BETTER DISCRIMINATOR, FOUND LATER: WHEN the failure was recorded.
//
// This tool was written on the theory that failures were positioning artefacts — the
// square was entered at its centre rather than against the wall. That theory turned out
// to be wrong: fine coordinates are invisible to the server's reach test, which is
// SquaredDistanceTo on SQUARE coordinates (nomoveon.kod:121), so where in the square a
// character stood never mattered.
//
// What WAS wrong is bigger. The model that chose these squares counted the eight
// neighbours as "who can hit you", when reach is a disc of radius 3 — up to 28 squares —
// filtered by line of sight. It rated 94% of squares identically, correlated with the
// observed hold rate at r=0.41, and approved six of the seven squares that got a
// character killed. Every failure recorded under it is a measurement taken with a broken
// instrument: not a bad square, a badly chosen one.
//
// So --before <iso|ms> clears only the failures older than a given moment, which is how
// you retire the judgements of a superseded model without discarding the ones the
// corrected model has since made. Those newer failures are real evidence and are kept.
const BEFORE = (() => {
  const v = argVal('before');
  if (!v) return null;
  const t = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(t)) { console.error(`--before: cannot read "${v}" as a time`); process.exit(1); }
  return t;
})();

const FILE = fileURLToPath(new URL('../substrate/m59-safespots.json', import.meta.url));
if (!existsSync(FILE)) { console.error('no safe-spot book at ' + FILE); process.exit(1); }

const book = JSON.parse(readFileSync(FILE, 'utf8'));
const rooms = book.rooms || {};

let cleared = 0, kept = 0, squares = 0, alsoHeld = 0;
const perRoom = {};

// --untested: hand back the squares retired by packet timing, as untested. See the note
// at the top of this file for why this one zeroes `held` where the pardon below keeps it.
if (arg('untested')) {
  const maxDamage = Number(argVal('max-damage') ?? 1);
  const total = Object.values(rooms).reduce((n, s) => n + Object.keys(s).length, 0);

  // SELECT AGAINST ONE BOOK, WRITE TO ANOTHER.
  //
  //   --from <file>   choose the squares using this snapshot instead of the live book
  //
  // The evidence that identifies this subset is `damage_taken`, and the pardon above
  // zeroes it. So once the pardon has run over a book the subset is no longer visible in
  // it — not because those squares are fine, but because the number that told them apart
  // is gone. Selecting from a snapshot taken before the pardon recovers it:
  //
  //   git show <commit>:substrate/m59-safespots.json > /tmp/before.json
  //   node tools/m59-safespot-retest.mjs --untested --from /tmp/before.json
  //
  // Squares in the snapshot that are missing from the live book are reported rather than
  // created: a square nobody has recorded since is not one to invent a history for.
  const fromFile = argVal('from');
  let refRooms = rooms;
  if (fromFile) {
    try { refRooms = (JSON.parse(readFileSync(fromFile, 'utf8')).rooms) || {}; }
    catch (e) { console.error(`--from: cannot read ${fromFile}: ${e.message}`); process.exit(1); }
  }

  const all = selectForRetest(refRooms, { maxDamage });
  const picked = [], missing = [];
  for (const p of all) {
    if (rooms[p.room]?.[p.key]) picked.push(p); else missing.push(p);
  }
  const per = {};
  for (const p of picked) per[p.room] = (per[p.room] || 0) + 1;

  console.log(`${total} squares in the book across ${Object.keys(rooms).length} rooms`);
  if (fromFile)
    console.log(`selected against ${fromFile} (${all.length} match), applying to the live book`);
  if (missing.length)
    console.log(`  ${missing.length} selected square(s) are not in the live book — skipped, not created`);
  console.log(`${picked.length} square(s) ${DRY ? 'would be' : ''} handed back as UNTESTED ` +
              `(held before failing, and lost <= ${maxDamage})`);
  for (const [room, n] of Object.entries(per).sort((a, b) => b[1] - a[1]))
    console.log(`  room ${String(room).padStart(5)}: ${n}`);
  if (DRY) { console.log('\ndry run — nothing written'); process.exit(0); }

  // THE BROKER HOLDS THIS BOOK IN MEMORY AND WRITES IT FROM THERE. safeSpotBook() is a
  // singleton inside that process and save() serialises whatever it currently holds, so
  // an edit made underneath a running broker is not merged — it is overwritten the next
  // time any character proves or disproves a square, and nothing reports that it was.
  // The modes below only print a reminder to restart; this one refuses, because a silent
  // revert of a 309-square change is not something to find out about by noticing.
  let up = null;
  try {
    const r = await fetch('http://127.0.0.1:8901/health', { signal: AbortSignal.timeout(1500) });
    up = await r.json();
  } catch { /* nothing listening: safe to write */ }
  if (up?.ok && !arg('force')) {
    console.error(`\nREFUSING: a broker is up (pid ${up.pid}, fleet "${up.fleet}") holding this book.`);
    console.error('  It would overwrite this edit the next time a square is proved or disproved.');
    console.error(`  node tools/m59-service.mjs stop --fleet ${up.fleet || 'prod'}`);
    console.error('  then re-run with --untested, then start it again.');
    process.exit(2);
  }

  // The record REWRITTEN is the live one; the history KEPT is the snapshot's, because
  // the live one's failure numbers were already cleared by the pardon.
  for (const p of picked)
    rooms[p.room][p.key] = reinstateUntested(rooms[p.room][p.key], {
      from: p.rec,
      why: fromFile ? 'retired before SETTLE_GRACE_MS existed; selected from ' + fromFile
                    : 'retired before SETTLE_GRACE_MS existed',
    });
  const bak = FILE.replace(/\.json$/, '.before-untest.json');
  copyFileSync(FILE, bak);
  writeFileSync(FILE, JSON.stringify(book, null, 0));
  console.log(`\nwritten. backup: ${bak}`);
  console.log(`${picked.length} square(s) are untested again. They are NOT trusted: each has to`);
  console.log('hold for 12s with something adjacent before any character rests on it.');
  process.exit(0);
}

if (PHANTOMS) {
  let gone = 0, heldToo = 0, emptied = [];
  for (const [room, spots] of Object.entries(rooms)) {
    for (const [k, rec] of Object.entries(spots)) {
      squares++;
      if (!isPhantom(rec)) continue;
      // A square that ALSO held is a real square with a phantom failure on top. Strip
      // the failure and keep the square; deleting it would throw away a proven wall.
      if ((rec.held || 0) > 0) {
        heldToo++;
        if (!DRY) { rec.failed = 0; rec.damage_taken = 0; }
      } else {
        gone++;
        if (!DRY) delete spots[k];
      }
      perRoom[room] = (perRoom[room] || 0) + 1;
    }
    // A ROOM WITH NO RECORDS IS NOT A ROOM WE KNOW ABOUT. Deleting the phantoms leaves
    // six empty room objects behind, and save() serialises them, so every count of "how
    // many rooms does the book cover" reads 27 when 21 rooms have anything in them at
    // all. Functionally inert — recall() hands back an empty Map, which behaves exactly
    // like an unknown room — but it is a number in a ledger that is wrong, and this
    // ledger has already cost us enough by being believed.
    if (!Object.keys(spots).length) { emptied.push(room); if (!DRY) delete rooms[room]; }
  }
  console.log(`${squares} squares in the book across ${Object.keys(rooms).length} rooms`);
  console.log(`${gone} phantom record(s) ${DRY ? 'would be' : ''} deleted, ` +
              `${heldToo} phantom failure(s) stripped from squares that had also held`);
  for (const [room, n] of Object.entries(perRoom).sort((a, b) => b[1] - a[1]))
    console.log(`  room ${String(room).padStart(5)}: ${n}`);
  if (emptied.length)
    console.log(`  rooms left with no records at all: ${emptied.join(', ')} — every square ` +
                'they held was a phantom, so the book never really knew anything about them');
  if (DRY) { console.log('\ndry run — nothing written'); process.exit(0); }
  const bak = FILE.replace(/\.json$/, '.before-phantom-purge.json');
  copyFileSync(FILE, bak);
  writeFileSync(FILE, JSON.stringify(book, null, 0));
  console.log(`\nwritten. backup: ${bak}`);
  console.log('The broker holds this book in memory — restart it so the change takes effect:');
  console.log('  node tools/m59-service.mjs restart --fleet prod');
  process.exit(0);
}

for (const [room, spots] of Object.entries(rooms)) {
  for (const rec of Object.values(spots)) {
    squares++;
    if (!(rec.failed > 0)) continue;
    // --only-unheld is the cautious half: squares that failed AND never held are the
    // ones with no positive evidence at all, so leaving them out keeps the change to
    // the squares we have direct reason to doubt.
    if (ONLY_UNHELD && rec.held > 0) { kept++; continue; }
    // Newer than the cutoff means it was judged by the corrected model, and that is
    // evidence rather than an artefact. A record with no timestamp is left alone too:
    // unknown is not the same as old, and this only ever removes evidence.
    if (BEFORE != null && !(rec.at > 0 && rec.at < BEFORE)) { kept++; continue; }
    if (rec.held > 0) alsoHeld++;
    cleared++;
    perRoom[room] = (perRoom[room] || 0) + 1;
    if (!DRY) {
      // Keep the history rather than erasing it: what was measured, and that the
      // measurement was retired, both matter to whoever reads this next.
      rec.failed_before_wallhug = (rec.failed_before_wallhug || 0) + rec.failed;
      rec.failed = 0;
      rec.damage_taken = 0;
      rec.retested_at = 0;      // no clock in here; the keeper stamps it when it next holds
    }
  }
}

console.log(`${squares} squares in the book across ${Object.keys(rooms).length} rooms`);
console.log(`${cleared} failure record(s) ${DRY ? 'would be' : ''} cleared` +
            (kept ? ` (${kept} kept)` : ''));
if (BEFORE != null)
  console.log(`  only failures recorded before ${new Date(BEFORE).toISOString()} — anything ` +
              'newer was judged by the corrected reach model and is real evidence');
if (!ONLY_UNHELD) console.log(`  of those, ${alsoHeld} are squares that had ALSO held — a square ` +
                              'that both holds and fails is the clearest sign the failure was the ' +
                              'measurement rather than the wall');
const top = Object.entries(perRoom).sort((a, b) => b[1] - a[1]).slice(0, 8);
for (const [room, n] of top) console.log(`  room ${String(room).padStart(5)}: ${n}`);

if (DRY) { console.log('\ndry run — nothing written'); process.exit(0); }

const backup = FILE.replace(/\.json$/, `.before-retest.json`);
copyFileSync(FILE, backup);
writeFileSync(FILE, JSON.stringify(book, null, 0));
console.log(`\nwritten. backup: ${backup}`);
console.log('The broker holds this book in memory — restart it so the change takes effect:');
console.log('  node tools/m59-service.mjs restart --fleet prod');
