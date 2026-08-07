#!/usr/bin/env node
// HOW GOOD EACH CHARACTER IS, KEPT RATHER THAN RE-ASKED.
//
//   node tools/m59-abilities.mjs                 every character on record
//   node tools/m59-abilities.mjs <character>     one character, with its history
//
// Ability levels — the 0-100 numbers for each skill and spell — are the only signal
// that practice is working, and reading them was expensive enough that nothing read
// them often. One read is four requests out of a budget of five a second, plus 1.2s
// of settling, because the spell and skill LISTS have to be re-requested before the
// ability groups: a group-3 packet carries one slot per entry of plSpells and nothing
// that says which spell a slot is, so a stale list mislabels every number. Times
// twenty-one characters that is eighty-four requests to answer a question whose
// answer changes a few times an hour.
//
// So it is read once after login and then kept. The cache does not rot, because the
// server volunteers every change: ChangeSkillAbility calls DrawStatSkill on EVERY
// change (player.kod:7343), ahead of and regardless of its own `report` flag, and
// that sends BP_STAT for the one slot that moved. The client turns those into
// `ability` events; this file writes them down.
//
// WHY ON DISK. Three reasons, and the third is the one that matters:
//   * a broker restart currently forgets everything a character knew about itself,
//     and re-reading twenty-one characters costs the same eighty-four requests;
//   * "did that hour of farming teach it anything" needs a BEFORE, and the before is
//     gone the moment the process ends;
//   * atrophy is silent. What you stop using decays when the advancement window
//     rolls over, and a number that quietly went down is invisible without a record.
//
// One file per CHARACTER, not per agent: the agent name is which slot of the fleet
// is driving, and it is reassigned. The character is the thing that has the skills.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const ABILITY_DIR = process.env.M59_ABILITY_DIR || here('../substrate/abilities');

// How long a cached answer is served before it is re-read. This is a SAFETY NET, not
// the mechanism — the pushes are what keep it true, and this only catches a change
// that was missed because the character was logged out, or a push that never came.
export const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;

// Enough to see a trend without the file growing without bound. Each entry is one
// ability moving by one point, which is what advancement looks like.
const MAX_HISTORY = 400;

const safeName = (s) => String(s || 'unknown').replace(/[^A-Za-z0-9_-]/g, '');
const fileFor = (character) => `${ABILITY_DIR}/${safeName(character)}.json`;

export function emptyBook(character) {
  return { character: character ?? null, version: 1,
           first_seen: null, read_at: { skills: null, spells: null },
           skills: {}, spells: {}, history: [] };
}

export function loadBook(character) {
  try { return { ...emptyBook(character), ...JSON.parse(readFileSync(fileFor(character), 'utf8')) }; }
  catch { return emptyBook(character); }
}

export function saveBook(book) {
  if (!book?.character) return null;             // never write an "unknown.json"
  try {
    mkdirSync(ABILITY_DIR, { recursive: true });
    const f = fileFor(book.character);
    writeFileSync(f, JSON.stringify(book, null, 2));
    return f;
  } catch { return null; }                        // a failed write must not stop play
}

export const listCharacters = () => {
  try { return readdirSync(ABILITY_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)); }
  catch { return []; }
};

// ------------------------------------------------------------------ merging
//
// Fold what the client currently believes into the book, and say what moved.
//
// A DROP IS NOT A MISTAKE and is recorded as one of the interesting cases: abilities
// atrophy when the advancement window rolls over, so a number going down is real, and
// a store that only ever took the maximum would hide exactly the thing worth seeing.
//
// A MISSING ENTRY IS NOT A ZERO. An ability absent from `rows` was not read — the
// group may not have been asked for — and the stored value is kept. Overwriting on
// absence would wipe the book every time one of the two groups was refreshed alone.
export function mergeAbilities(book, { skills = null, spells = null } = {},
                               { why = 'read', at = Date.now(), pushed = false } = {}) {
  const changes = [];
  for (const [kind, rows] of [['skills', skills], ['spells', spells]]) {
    if (!Array.isArray(rows)) continue;
    const into = book[kind] ??= {};
    for (const r of rows) {
      if (!r?.name) continue;                     // nameless: keep the number, not the row
      const was = into[r.name];
      if (!was) {
        into[r.name] = { ability: r.ability ?? null, id: r.id ?? null,
                         first: at, at, best: r.ability ?? null };
        // A first sighting is not advancement. It is the read that established the
        // number, and logging it as a gain would make every fresh character look like
        // it had just learned everything it knows.
        continue;
      }
      was.id = r.id ?? was.id;
      if (r.ability == null || r.ability === was.ability) { was.at = at; continue; }
      changes.push({ kind: kind === 'skills' ? 'skill' : 'spell', name: r.name,
                     from: was.ability, to: r.ability, by: r.ability - was.ability, at, why, pushed });
      was.ability = r.ability;
      was.at = at;
      if (was.best == null || r.ability > was.best) was.best = r.ability;
    }
    // Only a full read resets the age. A pushed advancement proves one number is
    // current; it says nothing about the other forty, and treating it as a read would
    // let the safety-net refresh be postponed for ever by a busy character.
    if (why === 'read') book.read_at[kind] = at;
  }
  if (book.first_seen === null) book.first_seen = at;
  if (changes.length) {
    book.history = [...(book.history || []), ...changes].slice(-MAX_HISTORY);
  }
  return changes;
}

// One pushed advancement, straight from an `ability` event. Same bookkeeping as a
// merge of one row, so the two paths cannot drift.
export function noteAdvancement(book, ev, at = Date.now()) {
  if (!ev?.name) return [];
  // `what`, not `kind` — see M59Client.noteAbility. The event's `kind` is 'ability';
  // which of the two it is rides in `what`.
  const kind = ev.what === 'skill' ? 'skills' : 'spells';
  return mergeAbilities(book, { [kind]: [{ name: ev.name, id: ev.id, ability: ev.to }] },
                        { why: 'advanced', at, pushed: ev.pushed !== false });
}

// ------------------------------------------------------------------- reading
//
// The live read. Four requests and a wait, which is why everything above exists.
export async function readLive(s, { kinds = 'both', settleMs = 700 } = {}) {
  const c = s.need();
  const wantSpells = kinds !== 'skills', wantSkills = kinds !== 'spells';

  // The lists FIRST, and separately, for the reason in the header: a group-3 packet
  // is positional against plSpells and carries nothing that identifies a slot, so a
  // stale list mislabels every number in it.
  if (wantSpells) await s.pacer.submit('read', () => c.requestSpells());
  if (wantSkills) await s.pacer.submit('read', () => c.requestSkills());
  await new Promise(r => setTimeout(r, 500));
  if (wantSpells) await s.pacer.submit('read', () => c.stats(3));
  if (wantSkills) await s.pacer.submit('read', () => c.stats(4));
  await new Promise(r => setTimeout(r, settleMs));

  const known = c.abilitiesKnown();
  return {
    skills: wantSkills ? known.skills : null,
    spells: wantSpells ? known.spells : null,
    read_at: known.read_at, unnamed: known.unnamed,
    requests: (wantSpells ? 2 : 0) + (wantSkills ? 2 : 0),
  };
}

// Is what we hold good enough to answer with?
export function isFresh(c, { kinds = 'both', maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const at = c?.abilitiesAt ?? {};
  const ok = (t) => t !== null && t !== undefined && (Date.now() - t) < maxAgeMs;
  if (kinds === 'skills') return ok(at.skills);
  if (kinds === 'spells') return ok(at.spells);
  return ok(at.skills) && ok(at.spells);
}

// THE ONE CALLERS SHOULD USE. Serves the cache when it is current, reads when it is
// not, and says which it did — because "this is 20 minutes old" and "this is from
// just now" are different answers to the same question and a caller deciding whether
// practice worked needs to know which it got.
export async function ensureAbilities(s, { kinds = 'both', maxAgeMs = DEFAULT_MAX_AGE_MS,
                                           force = false } = {}) {
  const c = s.need();
  const fresh = isFresh(c, { kinds, maxAgeMs });
  let read = null;
  if (force || !fresh) read = await readLive(s, { kinds });
  const known = c.abilitiesKnown();
  return {
    ...known,
    from: read ? 'a live read' : 'the cache',
    ...(read ? { requests_spent: read.requests } : {}),
    ...(read ? {} : {
      cached_note: 'not re-read: the server pushes every ability change as it happens ' +
                   '(BP_STAT group 3/4), so this is current unless the character was ' +
                   'logged out. Pass refresh:true to force.',
    }),
  };
}

// ---------------------------------------------------------------------- cli
if (process.argv[1]?.endsWith('m59-abilities.mjs')) {
  const who = process.argv[2];
  const pct = (n) => (n == null ? '  -' : String(n).padStart(3));
  const ago = (t) => (t ? `${Math.round((Date.now() - t) / 60000)}m ago` : 'never');

  if (who) {
    const b = loadBook(who);
    if (b.first_seen === null) { console.log(`no record for "${who}". Known: ${listCharacters().join(', ') || '(none)'}`); process.exit(1); }
    console.log(`${b.character} — skills read ${ago(b.read_at.skills)}, spells ${ago(b.read_at.spells)}`);
    for (const kind of ['skills', 'spells']) {
      const rows = Object.entries(b[kind] || {}).sort((a, c) => (c[1].ability ?? -1) - (a[1].ability ?? -1));
      if (!rows.length) continue;
      console.log(`\n  ${kind}`);
      for (const [name, v] of rows)
        console.log(`    ${pct(v.ability)}  ${name}${v.best > v.ability ? `   (peaked at ${v.best} — atrophied)` : ''}`);
    }
    const h = (b.history || []).slice(-20);
    if (h.length) {
      console.log(`\n  last ${h.length} change(s), oldest first`);
      for (const c of h)
        console.log(`    ${new Date(c.at).toISOString().slice(0, 16).replace('T', ' ')}  ` +
                    `${c.name} ${c.from} -> ${c.to}${c.by < 0 ? '  (atrophy)' : ''}`);
    } else {
      console.log('\n  no changes recorded yet — nothing has advanced since the first read');
    }
  } else {
    const names = listCharacters();
    if (!names.length) { console.log(`nothing under ${ABILITY_DIR} yet — the broker writes one file per character after it logs in`); process.exit(0); }
    console.log('character    skills  spells  changes  last read');
    for (const n of names) {
      const b = loadBook(n);
      console.log(String(b.character ?? n).padEnd(12),
                  String(Object.keys(b.skills || {}).length).padStart(6),
                  String(Object.keys(b.spells || {}).length).padStart(7),
                  String((b.history || []).length).padStart(8),
                  '  ' + ago(Math.max(b.read_at.skills || 0, b.read_at.spells || 0) || null));
    }
  }
}
