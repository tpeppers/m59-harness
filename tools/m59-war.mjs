#!/usr/bin/env node
// WHO WE ARE AT WAR WITH, WHO BELONGS TO THEM, AND HOW ONE CHARACTER'S FIGHT BECOMES THE ROOM'S.
//
//   node tools/m59-war.mjs                                  # the war book: enemy guilds, known members
//   node tools/m59-war.mjs --declare "Human Resistance"     # we are at war with this guild
//   node tools/m59-war.mjs --our-guild "The Second Swines"  # who "we" are, for reading declarations
//   node tools/m59-war.mjs --member "Morpheus" "Human Resistance"
//   node tools/m59-war.mjs --from-postmortems <dir>         # seed from the server's own war broadcasts
//   node tools/m59-war.mjs --peace "Human Resistance"       # stop treating that guild as an enemy
//   node tools/m59-war.mjs --alarms                         # the last few zone alarms
//
// ---------------------------------------------------------------------------
// WHY A SECOND BOOK BESIDE THE GRUDGE BOOK
//
// The grudge book remembers PEOPLE WHO HIT US, for an hour, and only ever lets us swing at one
// who is also flagged a murderer or outlaw right now. That is right for a stranger and it is
// useless in a guild war, measured 2026-09-30: 117 of the prod fleet's last 150 deaths were
// Morpheus, Rick Deckard and Wenbo of the Human Resistance, every one announced by the server as
// "... has been slaughtered by Morpheus of the Human Resistance in guild combat." A guild-war kill
// flags nobody (player.kod:4868), so all three sat in the grudge book as `player_class: normal`
// and `mayReturnFire` answered "not flagged" to every one of the 117.
//
// A war is not a grudge. It is about a GUILD rather than a person, it does not wear off after an
// hour, and it covers members who have not personally hit anybody yet. So this book keeps:
//
//   * enemy_guilds — guilds we are at war with. Written by an operator, or learned from the
//     server's own broadcasts: "in guild combat" is printed only when the two guilds are MUTUAL
//     enemies (system.kod:1564), so hearing one IS the server declaring the war.
//   * members — every player whose guild we have observed, from a look reply ("Squire of the
//     BootLickers.", player.kod:1672), a guild-combat broadcast, or an operator. REMEMBERED: a
//     member of an enemy guild seen once is assumed to still be one, which is what the operator
//     asked for.
//
// ---------------------------------------------------------------------------
// THE SERVER ALREADY SAYS WHO IS AN ENEMY, AND IT IS THE STRONGER EVIDENCE
//
// Every player object on the wire carries PLAYER_IS_ENEMY (0x02000000, `OF.ENEMY`) when its guild
// and ours are MUTUAL enemies (user.kod:2418). It is on room contents, on every create and every
// change, and it is on an INVISIBLE player too — the object is sent with its real id and name and
// a drawing-effect bit, never omitted (user.kod:2551, :7348). So the live test is a flag read, not
// a look, and needs nothing from this file. The remembered membership is the fallback for when the
// bit is absent: an illusion (a morphed player is sent as the monster, user.kod:2403), or a war the
// server stopped reporting.
//
// ---------------------------------------------------------------------------
// AND SAFETY STAYS ON, WHICH IS WHAT MAKES REMEMBERING SAFE
//
// A mutual war lets a member hit an enemy member with PFLAG_SAFETY on, and makes the attacker
// neither outlaw nor murderer (CheckStatusAndSafety, player.kod:3803-3812). So nothing in this
// path ever needs safety off. That is the whole containment argument for "assume they are still
// in the guild": if somebody has left the Human Resistance since we last saw them, the server
// refuses the swing with "Good thing your safety was on" and nobody innocent is touched. The
// combat module drops the membership's standing on that refusal (`markRefused`).
//
// ---------------------------------------------------------------------------
// THE ZONE ALARM: ONE CHARACTER'S FIGHT IS THE ROOM'S
//
// Characters in one room already see an entering enemy in the same server packet, so they react
// together with no messaging at all. What they do NOT share is the thing only the victim hears:
// the incoming-hit line naming an attacker who carries no enemy bit. So a keeper that enters PvP
// appends one line to `war-alarms-<fleet>.jsonl`, and every keeper watches that file (fs.watch,
// with a 250ms poll behind it because fs.watch is advisory) and joins the fight when the alarm
// names ITS map. No broker on the path: the prod broker's /health has been measured at 2.5s under
// load, and this is the one decision here that has to be fast.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync,
  appendFileSync, openSync, readSync, closeSync, readdirSync, watch as fsWatch } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName } from './m59-fleetpath.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..', '..');

export const ENEMY_FLAG = 0x02000000;
export const GUILDMATE_FLAG = 0x08000000;
export const PLAYER_FLAG = 0x00000004;
export const ATTACKABLE_FLAG = 0x00000008;

// A server refusal of a remembered enemy suppresses auto-engagement of that name for this long.
// The refusal means "not at war with you right now" (left the guild, newbie, war ended); ten
// minutes is long enough not to spam refused swings and short enough to notice a rejoin.
export const REFUSED_MS = 10 * 60 * 1000;
// How recent an alarm must be to act on. An alarm is about a fight happening NOW.
export const ALARM_FRESH_MS = 10_000;
// How long a look answer stands before the same name is looked at again.
export const LOOK_AGAIN_MS = 15 * 60 * 1000;

const bookFile = (envKey, stem, ext) => {
  if (process.env[envKey]) return process.env[envKey];
  let name = null;
  try { name = fleetName(); } catch { name = null; }
  return join(HERE, 'substrate', name ? `${stem}-${name}.${ext}` : `${stem}.${ext}`);
};
export const WAR_FILE = () => bookFile('M59_WAR_FILE', 'war', 'json');
export const ALARM_FILE = () => bookFile('M59_WAR_ALARM_FILE', 'war-alarms', 'jsonl');

export const normName = n => String(n ?? '').trim().replace(/\s+/g, ' ').slice(0, 64).toLowerCase();
// "The Second Swines" arrives as "of the The Second Swines", and a guild whose name has no
// article arrives as "of the Human Resistance" (GetDef + GetName, player.kod:1677). One key for
// every spelling: fold case, strip every leading "the ".
export const normGuild = g => normName(String(g ?? '').replace(/^(\s*the\s+)+/i, ''));
const stripCodes = t => String(t ?? '').replace(/~[A-Za-z]/g, '').trim();

// ------------------------------------------------------------------ the book

const EMPTY = () => ({ format: 'm59-war/1', our_guild: null, enemy_guilds: {}, members: {} });

function parseBook(text) {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
  return { ...EMPTY(), ...raw,
    enemy_guilds: raw.enemy_guilds && typeof raw.enemy_guilds === 'object' ? raw.enemy_guilds : {},
    members: raw.members && typeof raw.members === 'object' ? raw.members : {} };
}

// A READ THAT FAILS IS NOT AN EMPTY BOOK. Twenty keepers read-modify-write this file, and a
// writer that took a half-written file for an empty one would write the emptiness back and wipe
// every membership the fleet ever learned. So a mutation refuses on a bad read (`strict`), and
// a plain reader gets the last good copy it had.
function readBook({ strict = false } = {}) {
  const file = WAR_FILE();
  if (!existsSync(file)) return EMPTY();
  try { return parseBook(readFileSync(file, 'utf8')); }
  catch (e) {
    if (strict) throw new Error(`war book at ${file} will not parse (${e.message}); refusing to overwrite it`);
    return cache.value ?? EMPTY();
  }
}

function writeBook(book) {
  const file = WAR_FILE();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(book, null, 1));
  // Rename is atomic, so a reader sees the old book or the new one and never half of one. On
  // Windows it can be refused while another process holds the target open; retry briefly.
  for (let i = 0; ; i++) {
    try { renameSync(tmp, file); break; }
    catch (e) { if (i >= 20) { try { writeFileSync(file, readFileSync(tmp)); } catch {} throw e; } }
  }
  let mtime = -1;
  try { mtime = statSync(file).mtimeMs; } catch {}
  cache = { mtime, value: book, checked: Date.now(), file };
}

// Asked on every object change in a crowded room, for every player in it, so the steady-state
// cost is one stat() per STAT_MS rather than one per question. Another keeper's write reaches
// this one within STAT_MS; its own writes land in the cache immediately.
const STAT_MS = 250;
let cache = { mtime: -1, value: null, checked: 0, file: null };
export function current() {
  const file = WAR_FILE(), now = Date.now();
  if (cache.value && cache.file === file && now - cache.checked < STAT_MS) return cache.value;
  let mtime = 0;
  try { mtime = existsSync(file) ? statSync(file).mtimeMs : 0; } catch { mtime = 0; }
  if (cache.mtime !== mtime || !cache.value || cache.file !== file) cache = { mtime, value: readBook(), checked: now, file };
  else cache.checked = now;
  return cache.value;
}

function mutate(fn) {
  try {
    const book = readBook({ strict: true });
    const out = fn(book);
    writeBook(book);
    return out;
  } catch (e) { return { error: e.message }; }
}

export function setOurGuild(name) {
  return mutate(book => { book.our_guild = String(name).trim(); return book.our_guild; });
}

export function declareEnemyGuild(name, { source = 'operator', at = Date.now() } = {}) {
  const key = normGuild(name);
  if (!key) return null;
  if (current().enemy_guilds?.[key] && source !== 'operator') return current().enemy_guilds[key];
  return mutate(book => {
    if (book.our_guild && normGuild(book.our_guild) === key) return null;   // never ourselves
    const prev = book.enemy_guilds[key];
    book.enemy_guilds[key] = { name: prev?.name ?? String(name).trim().replace(/^(the\s+)+/i, ''),
      since: prev?.since ?? at, source: prev?.source ?? source, confirmed_at: at };
    return book.enemy_guilds[key];
  });
}

export function makePeace(name) {
  return mutate(book => { const key = normGuild(name); const had = key in book.enemy_guilds;
    delete book.enemy_guilds[key]; return had; });
}

/** Write down that `name` was seen to belong to `guild`. Latest observation wins. */
export function recordMembership(name, guild, { source = 'look', at = Date.now(), rank = null } = {}) {
  const key = normName(name), gkey = normGuild(guild);
  if (!key || !gkey) return null;
  const prev = current().members?.[key];
  // A repeat of what we already know is not worth a write from twenty processes: refresh
  // `last_seen` at most once a minute.
  if (prev && prev.guild_key === gkey && at - (prev.last_seen ?? 0) < 60_000 && !prev.refused_at) return prev;
  return mutate(book => {
    const p = book.members[key];
    const row = { name: String(name).trim().slice(0, 64), guild: String(guild).trim().replace(/^(the\s+)+/i, ''),
      guild_key: gkey, rank: rank ?? (p?.guild_key === gkey ? p?.rank ?? null : null),
      first_seen: p?.guild_key === gkey ? p.first_seen : at, last_seen: at, source,
      looked_at: p?.looked_at ?? null, refused_at: null,
      ...(p && p.guild_key !== gkey ? { previous_guild: p.guild } : {}) };
    book.members[key] = row;
    return row;
  });
}

/** Somebody we looked at carries no guild line. Remembered so we do not look again at once. */
export function recordUnguilded(name, { at = Date.now() } = {}) {
  const key = normName(name);
  if (!key) return null;
  return mutate(book => {
    const p = book.members[key];
    // An unguilded look does NOT erase a remembered enemy membership. The operator's rule is
    // that a member seen once stays one; a secret guild prints no line (player.kod:1672).
    book.members[key] = p ? { ...p, looked_at: at } :
      { name: String(name).trim().slice(0, 64), guild: null, guild_key: null, first_seen: at,
        last_seen: at, looked_at: at, source: 'look' };
    return book.members[key];
  });
}

export function noteLooked(name, { at = Date.now() } = {}) {
  const key = normName(name);
  if (!key) return null;
  return mutate(book => { if (book.members[key]) book.members[key].looked_at = at;
    else book.members[key] = { name: String(name).trim().slice(0, 64), guild: null, guild_key: null,
      first_seen: at, last_seen: at, looked_at: at, source: 'look_pending' };
    return book.members[key]; });
}

/** The server refused a swing at a remembered enemy: stop auto-engaging that name for a while. */
export function markRefused(name, { at = Date.now(), why = null } = {}) {
  const key = normName(name);
  if (!key || !current().members?.[key]) return null;
  return mutate(book => { const r = book.members[key]; if (!r) return null;
    r.refused_at = at; r.refused_why = why; return r; });
}

export const enemyGuilds = () => Object.values(current().enemy_guilds ?? {});
export const isEnemyGuild = g => !!current().enemy_guilds?.[normGuild(g)];
export const membership = name => current().members?.[normName(name)] ?? null;

/** Remembered as a member of a guild we are at war with, and not refused lately. */
export function rememberedEnemy(name, { now = Date.now() } = {}) {
  const m = membership(name);
  if (!m?.guild_key || !current().enemy_guilds?.[m.guild_key]) return null;
  if (m.refused_at && now - m.refused_at < REFUSED_MS) return null;
  return m;
}

/** Does this name need a look to learn its guild? */
export function needsLook(name, { now = Date.now() } = {}) {
  const m = membership(name);
  if (!m) return true;
  if (m.guild_key && current().enemy_guilds?.[m.guild_key]) return false;   // already an enemy
  return !m.looked_at || now - m.looked_at > LOOK_AGAIN_MS;
}

/**
 * IS THIS OBJECT AN ENEMY OF THE FLEET BECAUSE OF THE WAR — the question both the grudge gate
 * and the combat module ask. The fleetmate and guildmate checks come FIRST and are absolute:
 * a war can never make one of ours a target, whatever the book says.
 *
 * @returns {{hostile: boolean, basis: 'war_flag'|'remembered'|null, why: string, guild?: string}}
 */
export function warHostility(target, { fleetmate = false, now = Date.now() } = {}) {
  const flags = Number(target?.flags ?? 0) >>> 0;
  const name = target?.name ?? null;
  if (fleetmate) return { hostile: false, basis: null, why: 'one of ours' };
  if (!(flags & PLAYER_FLAG)) return { hostile: false, basis: null, why: 'not a player' };
  if (flags & GUILDMATE_FLAG) return { hostile: false, basis: null, why: 'a guildmate' };
  if (flags & ENEMY_FLAG) return { hostile: true, basis: 'war_flag',
    why: 'the server marks this player as a member of a guild at war with ours' };
  const m = name ? rememberedEnemy(name, { now }) : null;
  if (m) return { hostile: true, basis: 'remembered', guild: m.guild,
    why: `remembered as ${m.rank ? m.rank + ' ' : 'a member '}of ${m.guild} (${m.source}), ` +
         `a guild we are at war with` };
  return { hostile: false, basis: null, why: 'no war standing' };
}

// ------------------------------------------------------------------ reading the server

const FACTION_LINES = new Set([
  'a staunch servant of duke akardius.', 'firmly loyal to princess kateriina.',
  'a freedom fighter supporting jonas.', 'not a court vassal, yet affected by the meridian council.',
  'not yet concerned with affairs at the royal court.', 'elected royal justicar of the meridian.',
]);

/**
 * The guild line of a look reply's extra info (ShowExtraInfo, player.kod:1585): line one is the
 * citizenship sentence, and if the player is in a non-secret guild the next is
 * "<Rank> of the <Guild>." The faction line after it ALSO contains " of " ("A staunch servant of
 * Duke Akardius."), so it is excluded by its exact text rather than by shape.
 */
export function parseGuildLine(extra) {
  const lines = stripCodes(extra).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines.slice(1)) {
    if (FACTION_LINES.has(line.toLowerCase())) continue;
    if (/^known far and wide|is holding /i.test(line)) continue;
    const m = /^(.+?) of (?:the )?(.+)\.$/i.exec(line);
    if (m) return { rank: m[1].trim(), guild: m[2].trim() };
  }
  return null;
}

// "### Statler of the The Second Swines has been slaughtered by Morpheus of the Human Resistance
// in guild combat." (system.kod:1580-1594). Printed ONLY for mutual enemies (system.kod:1564).
const GUILD_KILL = /^#*\s*(.+?) of (?:the )?(.+?) has been slaughtered by (.+?) of (?:the )?(.+?) in guild combat\.?$/i;
export function parseGuildCombat(text) {
  const m = GUILD_KILL.exec(stripCodes(text));
  return m ? { victim: m[1].trim(), victimGuild: m[2].trim(), killer: m[3].trim(), killerGuild: m[4].trim() } : null;
}

// The three declarations (guild.kod:149-157), guild-wide to both sides. Returns the two guilds.
export function parseWarDeclaration(text) {
  const t = stripCodes(text);
  let m = /be it known that (?:the )?(.+?) and (?:the )?(.+?) are now at war/i.exec(t);
  if (m) return { a: m[1], b: m[2], mutual: true };
  m = /be it known that members of (?:the )?(.+?) are sworn enemies of (?:the )?(.+?)!?$/i.exec(t);
  if (m) return { a: m[1], b: m[2], mutual: false };
  m = /be it known that (?:the )?(.+?) have declared themselves the enemies of (?:the )?(.+?)!?$/i.exec(t);
  if (m) return { a: m[1], b: m[2], mutual: false };
  return null;
}

/**
 * Feed one server line to the book. Returns what it learned, or null. `isOurs(name)` answers
 * whether a character name is a fleetmate, which is how "our guild" is learned from a kill line
 * when nobody has set it.
 */
export function learnFromMessage(text, { isOurs = () => false, at = Date.now() } = {}) {
  const k = parseGuildCombat(text);
  if (k) {
    const ourSide = isOurs(k.victim) ? 'victim' : isOurs(k.killer) ? 'killer' : null;
    if (!ourSide) return { kind: 'guild_combat', ...k, ours: false };
    const ourGuild = ourSide === 'victim' ? k.victimGuild : k.killerGuild;
    const enemy = ourSide === 'victim' ? k.killer : k.victim;
    const enemyGuild = ourSide === 'victim' ? k.killerGuild : k.victimGuild;
    if (!current().our_guild) setOurGuild(ourGuild);
    declareEnemyGuild(enemyGuild, { source: 'guild_combat', at });
    recordMembership(enemy, enemyGuild, { source: 'guild_combat', at });
    return { kind: 'guild_combat', ...k, ours: true, enemy, enemyGuild };
  }
  const d = parseWarDeclaration(text);
  if (d) {
    const ours = current().our_guild ? normGuild(current().our_guild) : null;
    if (!ours) return { kind: 'declaration', ...d, ours: false };
    const other = normGuild(d.a) === ours ? d.b : normGuild(d.b) === ours ? d.a : null;
    if (!other) return { kind: 'declaration', ...d, ours: false };
    // Only a MUTUAL war changes what the server lets us do (IsMutualEnemy, player.kod:3805).
    // A one-sided declaration is recorded as intent and waits for the other side.
    if (d.mutual) declareEnemyGuild(other, { source: 'declaration', at });
    return { kind: 'declaration', ...d, ours: true, enemyGuild: other };
  }
  return null;
}

// ------------------------------------------------------------------ the zone alarm

/** Append one alarm. Cheap and synchronous: this is on the path to the first swing. */
export function raiseAlarm({ room, reporter, enemy, basis = 'attacked', at = Date.now() }) {
  if (!(Number(room) > 1) || !enemy) return false;
  const file = ALARM_FILE();
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Keep the file small. A reader that finds it shorter than its offset starts over, and
    // everything it re-reads is filtered by age, so truncation loses nothing that matters.
    try { if (statSync(file).size > 256 * 1024) writeFileSync(file, ''); } catch {}
    appendFileSync(file, JSON.stringify({ at, room: Number(room), reporter, enemy, basis }) + '\n');
    return true;
  } catch { return false; }
}

export function readAlarms({ since = 0 } = {}) {
  try {
    return readFileSync(ALARM_FILE(), 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(a => a && a.at >= since);
  } catch { return []; }
}

/**
 * Watch the alarm file and call `onAlarm` for each fresh line another process appends. Starts
 * at the file's current end: an alarm raised before this keeper existed is about a fight it
 * was not in. fs.watch is the fast path; the poll is there because fs.watch is advisory.
 */
export function watchAlarms(onAlarm, { pollMs = 250, now = Date.now } = {}) {
  const file = ALARM_FILE();
  try { mkdirSync(dirname(file), { recursive: true }); if (!existsSync(file)) writeFileSync(file, ''); } catch {}
  let offset = 0;
  try { offset = statSync(file).size; } catch {}
  let busy = false, closed = false;
  const drain = () => {
    if (busy || closed) return;
    busy = true;
    try {
      let size = 0;
      try { size = statSync(file).size; } catch { return; }
      if (size < offset) offset = 0;                        // truncated by a writer
      if (size === offset) return;
      const fd = openSync(file, 'r');
      const buf = Buffer.alloc(size - offset);
      try { readSync(fd, buf, 0, buf.length, offset); } finally { closeSync(fd); }
      const text = buf.toString('utf8');
      const end = text.lastIndexOf('\n');
      if (end < 0) return;                                  // a line still being written
      offset += Buffer.byteLength(text.slice(0, end + 1));
      for (const line of text.slice(0, end).split('\n')) {
        let a; try { a = JSON.parse(line); } catch { continue; }
        if (!a || now() - a.at > ALARM_FRESH_MS) continue;
        try { onAlarm(a); } catch {}
      }
    } finally { busy = false; }
  };
  let watcher = null;
  try { watcher = fsWatch(file, { persistent: false }, () => drain()); watcher.on?.('error', () => {}); } catch {}
  const timer = setInterval(drain, pollMs);
  timer.unref?.();
  return { drain, close() { closed = true; clearInterval(timer); try { watcher?.close(); } catch {} } };
}

// ------------------------------------------------------------------ seeding

/** Scan post-mortem files for the server's guild-combat broadcasts. Read-only on the files. */
export function seedFromPostmortems(dir, { isOurs, limit = 400 } = {}) {
  const files = readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, limit);
  const learned = new Map();
  for (const { f } of files) {
    let text;
    try { text = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/"(#{3}[^"]*in guild combat\.)"/g)) {
      const r = learnFromMessage(m[1], { isOurs });
      if (r?.ours) learned.set(normName(r.enemy), `${r.enemy} of ${r.enemyGuild}`);
    }
  }
  return [...learned.values()];
}

// ---------------------------------------------------------------------------- CLI
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const arg = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const fail = r => { if (r?.error) { console.error(r.error); process.exit(1); } return r; };
  if (arg('--our-guild')) { fail(setOurGuild(arg('--our-guild'))); console.log(`our guild: ${current().our_guild}`); }
  if (arg('--declare')) { fail(declareEnemyGuild(arg('--declare'))); console.log(`at war with ${arg('--declare')}`); }
  if (arg('--peace')) console.log(fail(makePeace(arg('--peace'))) ? `peace with ${arg('--peace')}` : 'was not at war with that guild');
  if (argv.includes('--member')) {
    const i = argv.indexOf('--member');
    fail(recordMembership(argv[i + 1], argv[i + 2], { source: 'operator' }));
    console.log(`${argv[i + 1]} is of ${argv[i + 2]}`);
  }
  if (arg('--from-postmortems')) {
    const { resolveFleet } = await import('./m59-fleetpath.mjs');
    const { rosterCharacterNames } = await import('./m59-party.mjs');
    const { stateFile } = resolveFleet(argv);
    const ours = new Set([...rosterCharacterNames(JSON.parse(readFileSync(stateFile, 'utf8')))].map(normName));
    const got = seedFromPostmortems(arg('--from-postmortems'), { isOurs: n => ours.has(normName(n)) });
    console.log(got.length ? `learned from the server's war broadcasts:\n  ${got.join('\n  ')}` : 'no guild-combat kills of ours found');
  }
  if (argv.includes('--alarms')) {
    for (const a of readAlarms({ since: Date.now() - 3600_000 }).slice(-20))
      console.log(`${new Date(a.at).toISOString()}  map ${a.room}  ${a.reporter} -> ${a.enemy} (${a.basis})`);
  }
  const b = current();
  console.log(`\n${WAR_FILE()}`);
  console.log(`our guild: ${b.our_guild ?? '(unknown — learned from the first guild-combat kill, or --our-guild)'}`);
  const gs = enemyGuilds();
  console.log(gs.length ? `at war with: ${gs.map(g => `${g.name} (${g.source}, since ${new Date(g.since).toISOString()})`).join('; ')}` : 'at war with nobody');
  const ms = Object.values(b.members).filter(m => m.guild_key && b.enemy_guilds[m.guild_key]);
  if (ms.length) {
    console.log(`\nknown enemy members (${ms.length}):`);
    for (const m of ms.sort((x, y) => (y.last_seen ?? 0) - (x.last_seen ?? 0)))
      console.log(`  ${m.name.padEnd(22)}${m.guild.padEnd(22)}${m.source.padEnd(14)}` +
        `${m.refused_at && Date.now() - m.refused_at < REFUSED_MS ? 'REFUSED by server safety' : ''}`);
  }
  const others = Object.values(b.members).filter(m => m.guild_key && !b.enemy_guilds[m.guild_key]).length;
  console.log(`\n${others} other player(s) with a known, non-enemy guild`);
}
