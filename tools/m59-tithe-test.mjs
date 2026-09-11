#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TitheBook, parseRentHours, parseRentLine, tithePaymentPlan,
         SAY_RADIUS, squaredDistance, withinSayRange } from './m59-tithe.mjs';

const full = tithePaymentPlan({ dailyAmount: 2_000, paidToday: 0,
  saleProceeds: 3_000, purse: 4_000, walkingMoney: 1_000 });
assert.equal(full.amount, 2_000, 'the daily amount caps one payment');

const partial = tithePaymentPlan({ dailyAmount: 2_000, paidToday: 500,
  saleProceeds: 700, purse: 1_700, walkingMoney: 1_000 });
assert.equal(partial.amount, 700, 'a smaller sale makes a partial payment');

const reserve = tithePaymentPlan({ dailyAmount: 2_000, paidToday: 0,
  saleProceeds: 2_000, purse: 2_500, walkingMoney: 1_000 });
assert.equal(reserve.amount, 1_500, 'walking money is never taxed');

const noSale = tithePaymentPlan({ dailyAmount: 2_000, paidToday: 0,
  saleProceeds: 0, purse: 9_000, walkingMoney: 1_000 });
assert.equal(noSale.amount, 0, 'old purse is not sale proceeds');

assert.deepEqual(parseRentLine(['Thy guild owes 12000 coins in rent.']).due, 12_000);
assert.deepEqual(parseRentLine(['Thy guild has a positive balance of 4000 shillings.']).credit, 4_000);
assert.equal(parseRentHours(['You have 4 hours to pay.']), 4);

const dir = mkdtempSync(join(tmpdir(), 'm59-tithe-'));
try {
  const at = new Date(2026, 7, 12, 12).getTime();
  const book = new TitheBook({ agent: 'test', fleet: 'fixture', dir });
  book.record(700, { at });
  book.record(300, { at: at + 60_000 });
  assert.equal(book.paidToday(at), 1_000, 'verified partials add within a day');
  assert.equal(book.paidToday(at + 24 * 60 * 60_000), 0, 'the next local day starts unpaid');
  const reopened = new TitheBook({ agent: 'test', fleet: 'fixture', dir });
  assert.equal(reopened.paidToday(at), 1_000, 'the daily total survives restart');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// FRULAR CANNOT HEAR YOU FROM ACROSS THE ROOM, AND SILENCE IS NOT AN ANSWER.
//
// Holder.SomeoneSaid gates every hearer on SayRangeCheck (holder.kod:604): a USER talking to
// a MONSTER that is not IsFullTalk is DROPPED when SquaredDistanceTo > SAY_RADIUS. The
// constant is 50 (blakston.khd:1299) and it is compared against a SQUARED distance, so the
// reach is about seven squares — and Frular is MOB_NOMOVE|MOB_NOFIGHT|MOB_LISTEN|MOB_RECEIVE
// with no MOB_FULL_TALK (gcreator.kod:74).
//
// This is why the rent balance has never been read on this fleet: every one of the eleven
// tithes in the book records credit_after null. Measured 2026-09-11: Gonzo at col 5 row 17,
// Frular at col 7 row 5 — squared 148 against a limit of 50 — asked "rent" and heard nothing,
// on a guild that had a hall and a large credit and therefore owed a real answer.
assert.equal(SAY_RADIUS, 50, 'SAY_RADIUS is 50, blakston.khd:1299');

assert.equal(squaredDistance({ col: 5, row: 17 }, { col: 7, row: 5 }), 148,
  'the measured 2026-09-11 geometry: Gonzo to Frular');
assert.equal(withinSayRange({ col: 5, row: 17 }, { col: 7, row: 5 }), false,
  'and it is OUT of earshot — this exact stance produced the silence');

assert.equal(withinSayRange({ col: 7, row: 6 }, { col: 7, row: 5 }), true,
  'standing next to him is heard');
assert.equal(withinSayRange({ col: 7, row: 12 }, { col: 7, row: 5 }), true,
  'seven squares away is 49, just inside');
assert.equal(withinSayRange({ col: 7, row: 13 }, { col: 7, row: 5 }), false,
  'eight squares is 64, just outside — the boundary is SQUARED, not linear');

// UNKNOWN IS NOT YES. A missing position must never read as "close enough", or the caller
// says the word, hears nothing, and files that as a fact about the guild's rent.
assert.equal(withinSayRange(null, { col: 7, row: 5 }), null, 'no speaker position is unknown');
assert.equal(withinSayRange({ col: 1, row: 1 }, null), null, 'no hearer position is unknown');
assert.equal(squaredDistance({ col: null, row: null }, { col: 7, row: 5 }), null,
  'a null coordinate is unknown, not zero');

console.log('20 passed, 0 failed');
