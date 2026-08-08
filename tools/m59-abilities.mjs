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

// --------------------------------------------------------------- the whole fleet
//
// THE ONE QUESTION THESE FILES EXIST TO ANSWER IS "IS PRACTICE WORKING", AND IT IS NOT A
// QUESTION ABOUT ONE CHARACTER. An ability number on its own says nothing — 42 in mace
// fighting is either good or terrible depending on what the other twenty are at, and
// whether it was 38 this morning. Both comparisons need every book at once.
//
// ATROPHY IS THE HALF NOBODY WOULD GO LOOKING FOR. What you stop using decays when the
// advancement window rolls over, and a number that quietly went DOWN produces no event,
// no message and no complaint. It is in the history exactly as a gain is — `by` is
// negative — and it is separated out here rather than netted off, because a fleet that
// gained 40 points and lost 38 is a fleet standing still, and one number cannot say so.
export function fleetAbilities({ sinceMs = 7 * 24 * 3600 * 1000 } = {}) {
  const cutoff = sinceMs ? Date.now() - sinceMs : 0;
  const books = listCharacters().map(loadBook).filter(b => b.character);

  // name -> the row on the ability sheet. Keyed by name across the whole fleet, because
  // the interesting comparison is one skill down twenty-one characters.
  const abilities = new Map();
  const changes = [];

  for (const b of books) {
    for (const kind of ['skills', 'spells']) {
      for (const [name, v] of Object.entries(b[kind] || {})) {
        const a = abilities.get(name) ?? { name, kind: kind === 'skills' ? 'skill' : 'spell',
                                           held: [], advanced: 0, atrophied: 0 };
        a.held.push({ character: b.character, ability: v.ability ?? null, best: v.best ?? null,
                      at: v.at ?? null,
                      // Peaked higher than it stands: this one has decayed since.
                      decayed: v.best != null && v.ability != null && v.best > v.ability });
        abilities.set(name, a);
      }
    }
    for (const c of b.history || []) {
      if (!c?.at || c.at < cutoff) continue;
      changes.push({ ...c, character: b.character });
    }
  }

  for (const c of changes) {
    const a = abilities.get(c.name);
    if (!a) continue;                      // advanced then forgotten: nothing to file it under
    if (c.by > 0) a.advanced += c.by; else a.atrophied += -c.by;
  }

  const rows = [...abilities.values()].map(a => {
    const nums = a.held.map(h => h.ability).filter(n => n != null);
    const best = a.held.filter(h => h.ability != null)
                       .sort((x, y) => y.ability - x.ability)[0] ?? null;
    return {
      name: a.name, kind: a.kind,
      characters: a.held.length,
      // The numbers themselves, sorted, so a page can draw the spread rather than a mean
      // that hides one character at 90 and twenty at 5.
      values: nums.slice().sort((x, y) => y - x),
      mean: nums.length ? Math.round(nums.reduce((t, n) => t + n, 0) / nums.length) : null,
      best: best?.ability ?? null, best_character: best?.character ?? null,
      advanced: a.advanced, atrophied: a.atrophied,
      decayed: a.held.filter(h => h.decayed).length,
      held: a.held.sort((x, y) => (y.ability ?? -1) - (x.ability ?? -1)),
    };
  }).sort((x, y) => (y.advanced - x.advanced) || (y.best ?? 0) - (x.best ?? 0));

  const perCharacter = books.map(b => {
    const mine = changes.filter(c => c.character === b.character);
    const nums = [...Object.values(b.skills || {}), ...Object.values(b.spells || {})]
      .map(v => v.ability).filter(n => n != null);
    return {
      character: b.character,
      skills: Object.keys(b.skills || {}).length,
      spells: Object.keys(b.spells || {}).length,
      total_ability: nums.reduce((t, n) => t + n, 0),
      best: nums.length ? Math.max(...nums) : null,
      advanced: mine.filter(c => c.by > 0).reduce((t, c) => t + c.by, 0),
      atrophied: mine.filter(c => c.by < 0).reduce((t, c) => t - c.by, 0),
      // The safety-net age, not the truth: the server pushes every change, so a book
      // read an hour ago is still current. Shown so a character whose pushes stopped
      // arriving is distinguishable from one that simply is not practising.
      read_at: Math.max(b.read_at?.skills || 0, b.read_at?.spells || 0) || null,
    };
  }).sort((a, b) => b.advanced - a.advanced || b.total_ability - a.total_ability);

  // Treemap facets. `value` is POINTS OF ABILITY, not events: three separate +1s and one
  // +3 are the same amount of progress and should be the same rectangle.
  //
  // `child` is the OTHER dimension, and it has to be passed rather than derived. The
  // first version picked it off the sign — characters when gaining, abilities when
  // losing — so drilling into a character on the "who advanced" map split it by
  // character and every rectangle was the one already clicked. It renders perfectly and
  // is simply the same number twice, which is why the test asks what the children are
  // rather than that there are some.
  const facet = (pick, child, sign) => {
    const m = new Map();
    for (const c of changes) {
      if (sign > 0 ? !(c.by > 0) : !(c.by < 0)) continue;
      const k = pick(c);
      if (k == null) continue;
      const e = m.get(k) ?? { name: k, value: 0, children: new Map() };
      e.value += Math.abs(c.by);
      const sub = child(c);
      if (sub != null) e.children.set(sub, (e.children.get(sub) || 0) + Math.abs(c.by));
      m.set(k, e);
    }
    return [...m.values()].map(e => ({
      name: e.name, value: e.value,
      children: [...e.children].sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })),
    })).sort((a, b) => b.value - a.value);
  };

  const gained = changes.filter(c => c.by > 0).reduce((t, c) => t + c.by, 0);
  const lost = changes.filter(c => c.by < 0).reduce((t, c) => t - c.by, 0);

  return {
    window_hours: +(sinceMs / 3600000).toFixed(1),
    characters: books.length,
    skills: rows.filter(r => r.kind === 'skill').length,
    spells: rows.filter(r => r.kind === 'spell').length,
    // Net, and both halves of it. See the header: netting alone hides a standstill.
    advanced: gained, atrophied: lost, net: gained - lost,
    changes_recorded: changes.length,
    abilities: rows,
    by_character: perCharacter,
    by_ability_gained: facet(c => c.name, c => c.character, +1),
    by_character_gained: facet(c => c.character, c => c.name, +1),
    by_ability_lost: facet(c => c.name, c => c.character, -1),
    recent: changes.sort((a, b) => b.at - a.at),
    read_this_way:
      'These numbers are PUSHED, not polled: the server sends BP_STAT for one slot on ' +
      'every change (player.kod:7343), so the book is current unless the character was ' +
      'logged out. A first sighting is not advancement and is deliberately absent from ' +
      'the history — the window shows what MOVED, so a fresh character shows nothing ' +
      'rather than appearing to have learned everything it knows. A negative change is ' +
      'atrophy and is real: what you stop using decays when the advancement window rolls ' +
      'over, silently.',
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
