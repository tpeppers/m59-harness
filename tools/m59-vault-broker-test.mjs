#!/usr/bin/env node
// Offline: the vault broker's gate, ticket book and capacity split.
//
//   node tools/m59-vault-broker-test.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gate, loadConfig, TicketBook, parseItems, freeRoom, whatFits, RANK_SIR } from './m59-vault-broker.mjs';

let passed = 0, failed = 0;
const ok = (what, cond, detail = '') => { if (cond) { passed++; console.log(`  ok   ${what}`); }
  else { failed++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); } };
const dir = mkdtempSync(join(tmpdir(), 'vault-broker-'));

try {
  const rows = [{ agent: 't3', health: '75/75' }, { agent: 't2', health: '75/75' }, { agent: 'hk2', health: '21/21' }];
  const cfg = { enabled: true, hall: 714, manager: 't3', go_between: 't2' };
  const facts = { hallOwned: true, passwordKnown: true, ranks: { t3: 3, t2: 3 } };

  console.log('\nthe gate');
  ok('two lords who can enter, a hall we own, the password known: runs', gate(cfg, rows, facts).ok);
  ok('a hall we do not own refuses', !gate(cfg, rows, { ...facts, hallOwned: false }).ok);
  ok('ownership UNKNOWN refuses too — a gate that guesses open is no gate',
     /could not confirm/.test(gate(cfg, rows, { ...facts, hallOwned: null }).why.join()));
  ok('no password refuses', !gate(cfg, rows, { ...facts, passwordKnown: false }).ok);
  ok('an apprentice manager cannot open the main door',
     /opens from rank 2/.test(gate(cfg, rows, { ...facts, ranks: { t3: RANK_SIR - 1, t2: 3 } }).why.join()));
  ok('a character under 30 is kept out by the guardian angel',
     /guardian angel/.test(gate({ ...cfg, go_between: 'hk2' }, rows, { ...facts, ranks: { t3: 3, hk2: 3 } }).why.join()));
  ok('one character cannot be both', /two characters/.test(gate({ ...cfg, go_between: 't3' }, rows, facts).why.join()));

  console.log('\nthe config');
  const f = join(dir, 'vb.json');
  writeFileSync(f, JSON.stringify({ manager: 't3', go_between: 't2', bogus: 1, _note: 'x' }));
  const c = loadConfig(f);
  ok('names read, defaults kept', c.manager === 't3' && c.inn === 106 && c.hall === 714);
  ok('an unknown key is reported, not applied', c.problems.some(p => /bogus/.test(p)) && c.bogus === undefined);
  ok('no file is a problem, not a crash', loadConfig(join(dir, 'none.json')).problems.length === 1);

  console.log('\nthe ticket book');
  const book = new TicketBook(join(dir, 'h', 'tickets.json'));
  const t = book.request({ kind: 'deposit', from: 'hk2', items: parseItems('emerald:40, long sword'), where: 106 });
  ok('a deposit is filed with an id', t.id === 'vb-1' && t.items[0].amount === 40 && t.items[1].amount === 1);
  ok('and is open', book.open().length === 1);
  book.update(t.id, { status: 'done' });
  ok('done leaves the open list', book.open().length === 0);
  let threw = false; try { book.request({ kind: 'steal', from: 'x', items: [{ item: 'a', amount: 1 }] }); } catch { threw = true; }
  ok('only deposit and withdraw', threw);
  const old = book.request({ kind: 'withdraw', from: 'hk3', items: [{ item: 'elderberry', amount: 100 }], now: 0, ttlMs: 10 });
  ok('an expired open ticket is not served', !book.open().some(x => x.id === old.id));

  console.log('\nwhat fits');
  const room = freeRoom({ pack: { weight: 1000, bulk: 1800, max: 2400, exact: true } }, 0.1);
  ok('free room keeps the spare share empty', room.weight === 1160 && room.bulk === 360, JSON.stringify(room));
  ok('an inexact pack is no room', freeRoom({ pack: { weight: 1, bulk: 1, max: 10, exact: false } }) === null);
  const weigh = n => ({ emerald: { weight: 1, bulk: 2 }, 'long sword': { weight: 150, bulk: 100 } })[n] ?? null;
  const split = whatFits([{ item: 'emerald', amount: 100 }, { item: 'long sword', amount: 3 }, { item: 'mystery', amount: 1 }],
    { weight: 1000, bulk: 300 }, weigh);
  ok('bulk binds: 100 emeralds take 200 bulk, one sword the last 100',
     JSON.stringify(split.take) === JSON.stringify([{ item: 'emerald', amount: 100 }, { item: 'long sword', amount: 1 }]),
     JSON.stringify(split));
  ok('what does not fit waits, and an unknown weight is never guessed',
     split.leave.some(x => x.item === 'long sword' && x.amount === 2) && split.leave.some(x => x.item === 'mystery'));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
