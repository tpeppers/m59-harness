#!/usr/bin/env node
// A MEAL IS ON THE LEDGER — offline, into a scratch ledger.
//
//   node tools/m59-ate-event-test.mjs
//
// Operator, 2026-09-27: the troll crew's food should go net-positive once it is fighting again, so
// food eaten has to be countable against `looted` rows. Nothing recorded a meal before this.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'ate-ledger-'));
process.env.M59_LEDGER_DIR = dir;
const { Autopilot } = await import('./m59-autopilot.mjs');
const { readLedger } = await import('./m59-ledger.mjs');

let passed = 0, failed = 0;
const ok = (what, cond, detail = '') => { if (cond) { passed++; console.log(`  ok   ${what}`); }
  else { failed++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); } };

try {
  const r = { who: () => 'Piggy', s: { world: { room: { num: 599 } } } };
  r.recordAte = Autopilot.prototype.recordAte.bind(r);
  r.recordAte({ ate: ['loaf of bread', 'loaf of bread', 'meat pie'], vigor: { before: 78, after: 148 } },
    'stocking up');
  r.recordAte({ ate: [] }, 'mid-hunt');
  r.recordAte(null, 'mid-hunt');
  const ev = readLedger({ sinceMs: 60_000 });
  const rows = (Array.isArray(ev) ? ev : ev.events ?? []).filter(e => e.kind === 'ate');
  ok('one row per food per sitting', rows.length === 2, JSON.stringify(rows));
  const bread = rows.find(e => e.item === 'loaf of bread');
  ok('the amount is per item', bread?.amount === 2 && rows.find(e => e.item === 'meat pie')?.amount === 1);
  ok('with the sitting\'s vigor, the character and the room',
     bread?.vigor_before === 78 && bread?.vigor_after === 148 && bread?.character === 'Piggy' && bread?.room === 599);
  ok('and why it was eaten', bread?.how === 'stocking up');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
