#!/usr/bin/env node
// WHAT IS IN THE BANK, WRITTEN DOWN THE MOMENT THE BANKER SAYS IT.
//
//   node tools/m59-bank.mjs                  every character, every account, and the total
//   node tools/m59-bank.mjs <character>      one character, with its history
//   node tools/m59-bank.mjs --backfill       fold old recordings and postmortems in
//   node tools/m59-bank.mjs --json           the same, as JSON
//
// WHY THIS FILE EXISTS.
//
// A bank balance is the only money a death cannot take, which makes it the number that
// says whether the fleet is actually getting anywhere. It was also the one number
// nothing kept. There is no packet for it: the server sends the balance as PROSE from
// an NPC's mouth (`Lm_bnkr_balance`, monster.kod:136) and never again, so the only way
// to read one is to walk a character to a counter and ask. Twenty-one characters, each
// several minutes from a bank, to answer a question about money.
//
// So the balance was surviving only by accident, in whatever flight recording or
// postmortem happened to be open when a deposit landed. That is not a record: the
// recorder keeps a bounded number of windows per character and prunes the rest, and a
// postmortem exists only if the character DIED. Asked "how much has the fleet banked",
// the honest answer was one character's balance, kept because it died shortly after
// banking, and the recording that also held it had already been deleted.
//
// The fix is not to poll. It is to notice that the number goes past on the wire every
// time anybody banks anything, and to write it down when it does. One file per
// character, same shape and the same reasoning as substrate/abilities/ — the record
// costs nothing to keep and cannot be reconstructed once it is gone.
//
// WHAT THE BANKER ACTUALLY SAYS (monster.kod:136-148, verbatim):
//
//   Lm_bnkr_balance            "You have %i shillings in your account."
//   Lm_bnkr_did_deposit        "Thank you for your deposit.  You now have %i shillings in your account."
//   Lm_bnkr_not_enough_withdraw"But you only have %i shillings in your account!"
//   Lm_bnkr_no_account         "You have no money to withdraw!"
//   Lm_bnkr_did_withdraw       "Here are your %i shillings. Thank you for your business."
//   Lm_bnkr_not_enough_deposit "But you only have %i shillings in your possession!"
//
// THE FOURTH AND SIXTH LINES ARE THE TRAPS, and they pull in opposite directions.
//
// A WITHDRAWAL DOES NOT REPORT THE NEW BALANCE. It reports the amount handed over. So
// "NPCs say the new balance aloud" is true of deposits and balance checks and false of
// the one operation that makes the number go DOWN. Recording %i from a withdrawal as
// the balance would write the wrong number confidently — the exact failure this file is
// meant to prevent. A withdrawal is therefore recorded as arithmetic against the last
// observed balance and flagged `observed: false`, so a stale-but-honest number is
// distinguishable from one the banker actually said.
//
// And "in your POSSESSION" is the purse, not the account. It differs from the account
// line by one word in the middle of a sentence, so every pattern here anchors on
// "in your account" rather than on "shillings".
//
// WHICH ACCOUNT. There are two, and a character's money is not fungible between them
// (`FindBankByNum`, system.kod:1333). The bank is identified by the SPEAKER, because
// the speaker is in the sentence and the room name is not:
//
//   Skivlat      Tos        viBank = BID_TOS      = 1   TsBanker.kod:44
//   Yevitan      Jasper     viBank = BID_TOS      = 1   jsbanker.kod:36
//   Setag'lib    Barloque   viBank = BANK_BASIC   = 1   bqbanker.kod:30
//   Huital ko'Nosak Ko'catan viBank = BID_KOCATAN = 2   kcbanker.kod:40
//
// BANK_BASIC and BID_TOS are both 1 (blakston.khd:1275-1284), so BARLOQUE PAYS INTO THE
// TOS ACCOUNT — three towns share one balance, not the two this repository used to say.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const BANK_DIR = process.env.M59_BANK_DIR || here('../substrate/banks');

// Enough to see where the money came from without the file growing without bound.
const MAX_HISTORY = 300;

const safeName = (s) => String(s || 'unknown').replace(/[^A-Za-z0-9_-]/g, '');
const fileFor = (character) => join(BANK_DIR, `${safeName(character)}.json`);

// ------------------------------------------------------------------ the banks

export const BANKERS = [
  { re: /\bskivlat\b/i,        banker: 'Skivlat',         town: 'Tos',      bank: 1 },
  { re: /\byevitan\b/i,        banker: 'Yevitan',         town: 'Jasper',   bank: 1 },
  { re: /\bsetag'?lib\b/i,     banker: "Setag'lib",       town: 'Barloque', bank: 1 },
  { re: /\bhuital\b/i,         banker: "Huital ko'Nosak", town: "Ko'catan", bank: 2 },
];

// The account NAME is the key in the file, and it names every town that pays into it so
// that reading the file does not require remembering that Barloque is not its own bank.
export const ACCOUNTS = {
  1: 'jasper-tos-barloque',
  2: 'kocatan',
};
export const accountOf = (bank) => ACCOUNTS[bank] ?? `bank-${bank}`;

// Which bank a line came from. Falls back to the room, and then to nothing — a balance
// we cannot attribute is worse than useless, because it would be added to the wrong
// account, so `null` here means the caller must not record it as a balance.
export function bankFromLine(text, roomName = null) {
  const t = String(text || '');
  const said = BANKERS.find(b => b.re.test(t));
  if (said) return { ...said, how: 'speaker' };
  const r = String(roomName || '');
  if (/hungry vault/i.test(r)) return { banker: null, town: "Ko'catan", bank: 2, how: 'room' };
  if (/royal bank of jasper/i.test(r)) return { banker: null, town: 'Jasper', bank: 1, how: 'room' };
  if (/royal bank of tos/i.test(r)) return { banker: null, town: 'Tos', bank: 1, how: 'room' };
  return null;
}

// ------------------------------------------------------------------ the parse
//
// Order matters. "in your account" is the anchor for every authoritative reading, and
// the withdrawal line is matched separately because its number means something else.

const RE_ACCOUNT = /have\s+([\d,]+)\s+shillings?\s+in\s+your\s+account/i;
const RE_DEPOSITED = /thank you for your deposit/i;
const RE_ONLY_HAVE = /but you only have/i;
const RE_WITHDREW = /here are your\s+([\d,]+)\s+shillings?/i;
const RE_NO_ACCOUNT = /you have no money to withdraw/i;

const n = (s) => Number(String(s).replace(/,/g, ''));

// Read one line of banker prose. Returns null for anything that is not a statement
// about an account — including "in your possession", which is the purse.
export function readBankerLine(text) {
  const t = String(text || '');
  if (!t) return null;

  const acct = RE_ACCOUNT.exec(t);
  if (acct) {
    return {
      balance: n(acct[1]),
      observed: true,
      kind: RE_DEPOSITED.test(t) ? 'deposit'
          : RE_ONLY_HAVE.test(t) ? 'refused-withdraw'
          : 'balance',
    };
  }
  // "You have no money to withdraw!" is a balance of zero, stated. It is the only way
  // an empty account ever announces itself, and reading it as "no information" would
  // leave a character's last non-zero balance standing after it emptied the account.
  if (RE_NO_ACCOUNT.test(t)) return { balance: 0, observed: true, kind: 'balance' };

  // The withdrawal. The number is what came OUT, not what is left.
  const w = RE_WITHDREW.exec(t);
  if (w) return { withdrew: n(w[1]), observed: false, kind: 'withdraw' };

  return null;
}

// ------------------------------------------------------------------ the record

export function emptyBook(character) {
  return { character: character ?? null, version: 1, accounts: {}, history: [] };
}

export function loadBook(character) {
  try { return { ...emptyBook(character), ...JSON.parse(readFileSync(fileFor(character), 'utf8')) }; }
  catch { return emptyBook(character); }
}

export function saveBook(book) {
  if (!book?.character) return null;                 // never write an "unknown.json"
  try {
    mkdirSync(BANK_DIR, { recursive: true });
    const f = fileFor(book.character);
    writeFileSync(f, JSON.stringify(book, null, 2));
    return f;
  } catch { return null; }                            // a failed write must not stop play
}

export const listCharacters = () => {
  try { return readdirSync(BANK_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)); }
  catch { return []; }
};

// Fold one line of banker prose into the book. Returns the entry written, or null if
// the line said nothing about an account or could not be attributed to a bank.
//
// `at` is passed in rather than taken from the clock so that a backfill from a
// recording files each entry under the time it actually happened.
export function noteBankerLine(book, text, { at = Date.now(), room = null, roomName = null } = {}) {
  const read = readBankerLine(text);
  if (!read) return null;
  const where = bankFromLine(text, roomName);
  if (!where) return null;                            // unattributable: do not guess a bank

  const key = accountOf(where.bank);
  const prev = book.accounts[key] || null;

  let balance = read.balance, observed = read.observed;
  if (read.kind === 'withdraw') {
    // Arithmetic, not observation. Without a previous balance there is nothing to
    // subtract from, and inventing one would be worse than admitting we do not know.
    if (prev?.balance == null) return null;
    balance = Math.max(0, prev.balance - read.withdrew);
    observed = false;
  }

  const entry = {
    at, balance, observed, kind: read.kind,
    bank: where.bank, account: key,
    banker: where.banker ?? null, town: where.town ?? null,
    ...(read.withdrew != null ? { withdrew: read.withdrew } : {}),
    ...(room != null ? { room } : {}),
    ...(roomName ? { room_name: roomName } : {}),
    ...(prev?.balance != null && prev.balance !== balance ? { was: prev.balance } : {}),
    said: String(text).slice(0, 200),
  };

  // THE SAME SENTENCE, SEEN TWICE, IS ONE EVENT. A postmortem keeps the banker's line
  // both in the keeper's decision log and in its transcript, and a backfill re-run
  // reads a file it has already read. Neither is a second deposit, and a history full
  // of phantom duplicates makes "how did this balance get here" unreadable.
  const same = book.history.find(h => h.at === at && h.balance === balance &&
                                      h.kind === entry.kind && h.account === key);
  if (same) return same;

  // OLD NEWS MUST NOT OVERWRITE NEW NEWS. A backfill walks files in whatever order the
  // directory hands them over, and the live hook can be running at the same time.
  if (!prev || at >= (prev.at ?? 0)) book.accounts[key] = entry;

  // The history is the audit trail, so it keeps entries the accounts map rejected —
  // and stays in time order regardless of what order they arrived in.
  book.history.push(entry);
  book.history.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  if (book.history.length > MAX_HISTORY) book.history = book.history.slice(-MAX_HISTORY);
  return entry;
}

// The convenience wrapper the broker uses: load, fold, save, return what was written.
export function record(character, text, ctx = {}) {
  if (!character) return null;
  const book = loadBook(character);
  const entry = noteBankerLine(book, text, ctx);
  if (!entry) return null;
  saveBook(book);
  return entry;
}

// What one character has, per account, most recent first.
export function balancesFor(character) {
  const book = loadBook(character);
  return Object.entries(book.accounts)
    .map(([account, e]) => ({ account, ...e }))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

// EVERYTHING, AND THE TOTAL. This is the call the fleet report wants.
//
// The total sums the LATEST balance per character per account. It is deliberately not
// "the sum of every entry" — accounts are stateful, and a character that deposited
// three times has one balance, not three.
export function fleetTotal() {
  const rows = [];
  for (const character of listCharacters()) {
    for (const b of balancesFor(character)) rows.push({ character, ...b });
  }
  const total = rows.reduce((t, r) => t + (r.balance || 0), 0);
  const observed = rows.filter(r => r.observed).reduce((t, r) => t + (r.balance || 0), 0);
  return {
    rows: rows.sort((a, b) => (b.balance || 0) - (a.balance || 0)),
    total, observed_total: observed,
    characters_with_a_balance: new Set(rows.filter(r => r.balance > 0).map(r => r.character)).size,
  };
}

// ------------------------------------------------------------------ backfill
//
// The balances that were caught by accident before this file existed. Recordings get
// pruned and postmortems only exist where somebody died, so this is a one-off sweep of
// what happens to have survived — not a substitute for the live hook.
//
// A recording is named after the AGENT and a postmortem after the CHARACTER, and the
// account belongs to the character. So the agent map has to come from somewhere; the
// broker knows it, and without the broker the recordings are skipped and said to be.
export function backfill({ substrate = here('../substrate'), agentToCharacter = {} } = {}) {
  const out = { scanned: 0, written: 0, skipped_no_character: [], files: [] };
  const books = new Map();
  const bookOf = (ch) => { if (!books.has(ch)) books.set(ch, loadBook(ch)); return books.get(ch); };

  const INTERESTING = /in your account|no money to withdraw|Here are your/i;

  // A RECORDING IS ONE EVENT PER LINE, so the timestamp sits on the line with the prose.
  const scanRecordings = (dir, characterOf) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const f of names) {
      if (!f.endsWith('.jsonl')) continue;
      let txt;
      try { txt = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
      if (!INTERESTING.test(txt)) continue;
      out.scanned++;
      const character = characterOf(f);
      if (!character) { out.skipped_no_character.push(f); continue; }
      // COUNT WHAT LANDED, not what matched. The same sentence appears more than once
      // in these files and noteBankerLine folds the repeats into one entry, so counting
      // matches would report a backfill twice the size of the record it produced.
      const before = bookOf(character).history.length;
      for (const line of txt.split('\n')) {
        if (!INTERESTING.test(line)) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        noteBankerLine(bookOf(character), ev.text ?? '', { at: ev.at ?? 0 });
      }
      const wrote = bookOf(character).history.length - before;
      if (wrote) { out.written += wrote; out.files.push({ file: f, character, entries: wrote }); }
    }
  };

  // A POSTMORTEM IS A DOCUMENT, not a stream, and it keeps the banker's line TWICE —
  // once in the keeper's decision log, which is timestamped, and once in the transcript,
  // which is not. Walking the parsed object rather than the raw text is what lets each
  // reading keep the time it actually happened: the `at` of the nearest enclosing object
  // carries down, and the death's own timestamp is the last resort. Read as flat text
  // instead, every entry lands at the epoch and the history sorts into nonsense.
  const scanPostmortems = (dir) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const f of names) {
      if (!f.endsWith('.json')) continue;
      let doc;
      try {
        const raw = readFileSync(join(dir, f), 'utf8');
        if (!INTERESTING.test(raw)) continue;
        doc = JSON.parse(raw);
      } catch { continue; }
      out.scanned++;
      const character = doc.character || f.split('-')[0] || null;
      if (!character) { out.skipped_no_character.push(f); continue; }
      const before = bookOf(character).history.length;
      const walk = (node, at) => {
        if (typeof node === 'string') {
          if (INTERESTING.test(node)) noteBankerLine(bookOf(character), node, { at });
          return;
        }
        if (Array.isArray(node)) { for (const x of node) walk(x, at); return; }
        if (node == null || typeof node !== 'object') return;
        const mine = Number.isFinite(node.at) && node.at > 1e12 ? node.at : at;
        for (const [k, v] of Object.entries(node)) if (k !== 'at') walk(v, mine);
      };
      walk(doc, Number.isFinite(doc.at) ? doc.at : 0);
      const wrote = bookOf(character).history.length - before;
      if (wrote) { out.written += wrote; out.files.push({ file: f, character, entries: wrote }); }
    }
  };

  scanPostmortems(join(substrate, 'postmortems'));
  scanRecordings(join(substrate, 'recordings'), f => agentToCharacter[f.split('-')[0]] || null);

  for (const book of books.values()) saveBook(book);
  return out;
}

// ------------------------------------------------------------------ the CLI

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

async function agentMapFromBroker() {
  const port = process.env.M59_BROKER_PORT || 8901;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                             params: { name: 'fleet', arguments: {} } }),
    });
    const j = await r.json();
    const f = JSON.parse(j.result.content[0].text);
    return Object.fromEntries((f.fleet || []).map(c => [c.agent, c.character]));
  } catch { return null; }
}

const age = (at) => {
  if (!at) return '?';
  const m = Math.round((Date.now() - at) / 60000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

if (isMain) {
  const args = process.argv.slice(2);
  const wantJson = args.includes('--json');
  const rest = args.filter(a => !a.startsWith('--'));

  if (args.includes('--backfill')) {
    const map = await agentMapFromBroker();
    if (!map) console.error('[bank] broker not reachable — postmortems only, recordings skipped ' +
                            '(they are named after the agent, and only the broker knows which ' +
                            'character that is)');
    const r = backfill({ agentToCharacter: map || {} });
    console.log(`scanned ${r.scanned} file(s), wrote ${r.written} entry(s)`);
    for (const f of r.files) console.log(`  ${f.character.padEnd(12)} ${f.entries}  ${f.file}`);
    if (r.skipped_no_character.length)
      console.log(`  skipped ${r.skipped_no_character.length} file(s): could not name the character`);
  }

  if (rest.length) {
    const character = rest[0];
    const book = loadBook(character);
    if (wantJson) { console.log(JSON.stringify(book, null, 2)); }
    else {
      console.log(`${book.character ?? character}`);
      const accts = Object.entries(book.accounts);
      if (!accts.length) console.log('  no balance on record');
      for (const [k, e] of accts)
        console.log(`  ${k.padEnd(20)} ${String(e.balance).padStart(7)}  ` +
                    `${e.observed ? 'observed' : 'derived '}  ${age(e.at)}  (${e.kind})`);
      if (book.history.length) {
        console.log('\n  history, oldest first');
        for (const h of book.history)
          console.log(`    ${new Date(h.at).toISOString()}  ${String(h.balance).padStart(7)}  ` +
                      `${h.kind.padEnd(16)} ${h.account}${h.observed ? '' : '  (derived)'}`);
      }
    }
  } else if (!args.includes('--backfill') || wantJson) {
    const t = fleetTotal();
    if (wantJson) { console.log(JSON.stringify(t, null, 2)); }
    else if (!t.rows.length) {
      console.log('nothing on record yet. The balance is only ever prose from a banker, so it is ' +
                  'written down when one speaks — run --backfill to sweep what old recordings caught.');
    } else {
      console.log('character     account               balance  read          when');
      for (const r of t.rows)
        console.log(`${r.character.padEnd(13)} ${r.account.padEnd(21)} ${String(r.balance).padStart(7)}  ` +
                    `${(r.observed ? 'observed' : 'derived').padEnd(12)}  ${age(r.at)}`);
      console.log(`\ntotal ${t.total} shillings banked across ${t.characters_with_a_balance} character(s)`);
      if (t.observed_total !== t.total)
        console.log(`${t.observed_total} of that was stated by a banker; the rest is arithmetic ` +
                    `after a withdrawal, which does not report the new balance`);
    }
  }
}
