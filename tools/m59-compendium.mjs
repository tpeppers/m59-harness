#!/usr/bin/env node
// THE COMPENDIUM, SERVED LOCALLY, WITH A REAL CHARACTER IN IT.
//
//   node tools/m59-compendium.mjs                     serve, print the URL
//   node tools/m59-compendium.mjs --open              ...and open a browser
//   node tools/m59-compendium.mjs --open --agent t1   ...as that character
//   node tools/m59-compendium.mjs --status            is it already up?
//
// The compendium is static HTML and its bestiary already recalculates every row
// against a reference character — but the reference character is a preset you type in
// by hand, and the fleet is right there. So this serves the tree and adds one endpoint
// that hands the page a live character.
//
//   node tools/m59-compendium.mjs --access lan-read   ...and let the LAN read it
//
// THREE ACCESS MODES, AND THE DEFAULT IS THIS COMPUTER ONLY. `--access <mode>` or
// M59_COMPENDIUM_ACCESS=<mode>:
//
//   local       listens on 127.0.0.1. Nothing else on the network can connect. (default)
//   lan-read    listens on every interface. Another device may read every page AND every
//               live character — this process reads the broker on behalf of whoever asks,
//               so that is the fleet's characters, equipment and levels — but a request
//               that WRITES (any method other than GET/HEAD: the planner's loadout and
//               guild-plan saves, the hand-overs to the fleet) is refused unless it comes
//               from this computer.
//   lan-write   listens on every interface and lets the LAN write too. A loadout or guild
//               plan saved from a phone is an INSTRUCTION the keeper obeys, and the
//               hand-over endpoints move items between characters, so this is a deliberate
//               choice and never a default.
//
// The mode is a closed list: an unrecognised one is refused rather than read as the
// nearest thing, because "lan-wirte" quietly meaning `local` and "loacl" quietly meaning
// anything wider are both the kind of setting that does nothing while looking set.
//
// WHY A COOKIE. The alternative is a query string, and a query string is in every
// link the reader clicks afterwards, in their history, and in the address bar of a
// screenshot. A cookie is set once by /_import and then applies to every page of the
// compendium as they browse it — which is the actual requirement, because "your
// character" should still be selected three creatures later. It is scoped to this
// origin, is not HttpOnly on purpose (the page's own JavaScript is what reads it), and
// carries only what the bestiary needs to do the arithmetic.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// The server's own names for the weapon proficiencies. Imported rather than duplicated:
// seven of the eight were invented until recently, and a second copy is how that comes
// back.
import { proficiencyFor as profFor } from './m59-skills.mjs';
import { guildPlan, saveGuildPlan, guildStoreAvailable, guildShortfall } from './m59-guildwants.mjs';
import { StorageCache, GUILD_CHEST_SLOTS, CHEST_BULK_MAX, chestFullness } from './m59-storage.mjs';
// The loadout format, and the only thing that decides what a character name may become on
// the filesystem. This server accepts one over a socket; it does not get to invent its own
// rule for that.
import { readLoadout, writeLoadout, listLoadouts, loadoutPath, slugOf, normalise, LOADOUT_DIR,
         applyInventoryToAll } from './m59-loadout.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const ROOT = path.join(REPO, 'compendium');

export const COMPENDIUM_PORT = Number(process.env.M59_COMPENDIUM_PORT || 8099);
export const ACCESS_MODES = ['local', 'lan-read', 'lan-write'];
export function parseAccess(value) {
  const mode = String(value ?? 'local').trim().toLowerCase() || 'local';
  if (!ACCESS_MODES.includes(mode))
    throw new Error(`unknown compendium access "${value}" — use one of ${ACCESS_MODES.join(', ')}`);
  return mode;
}
export const accessHost = mode => (mode === 'local' ? '127.0.0.1' : '0.0.0.0');
const isLoopback = addr => /^(127\.|::1$|::ffff:127\.)/.test(String(addr ?? ''));
const isRead = method => method === 'GET' || method === 'HEAD';
// THE WHOLE POLICY, pure so it can be tested without a socket. `local` still checks the
// address even though its listener cannot be reached from outside: a guard that relies on
// the bind alone is one config change from being no guard.
export function allowRequest(mode, method, remoteAddress) {
  if (isLoopback(remoteAddress)) return { ok: true };
  if (mode === 'lan-write') return { ok: true };
  if (mode === 'lan-read' && isRead(method)) return { ok: true };
  return { ok: false, why: mode === 'lan-read'
    ? 'this compendium is LAN-readable only; writing is allowed from this computer (start it with --access lan-write to change that)'
    : 'this compendium is local-only (start it with --access lan-read or lan-write to allow the network)' };
}
const BROKER_PORT = process.env.M59_BROKER_PORT || '8901';
const BROKER = `http://127.0.0.1:${BROKER_PORT}/`;
export const COOKIE = 'm59char';

// Identifies THIS server rather than whatever else is on the port. The broker learned
// the same lesson: a port answering is not the same as the thing you wanted answering,
// and starting a second copy of something is how a fleet gets held by a process nobody
// is talking to.
const IDENT = 'm59-compendium';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

// ------------------------------------------------------------------- the broker

async function broker(name, args = {}, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(BROKER, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                             params: { name, arguments: args } }),
    });
    const j = await r.json();
    if (j.result?.isError) throw new Error(j.result.content[0].text);
    return JSON.parse(j.result.content[0].text);
  } finally { clearTimeout(t); }
}

// ------------------------------------------------- a character, as the page wants it
//
// The bestiary's "build" is a fixed shape — six attributes, five combat skills, a
// weapon class and one armour class per slot — and every field of it exists on a live
// character. This is the translation, and the interesting part is that most of it can
// go wrong quietly, so each field records where it came from.

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The compendium names gear by its kod CLASS and shows a display name; the wire gives
// us only the display name. Match on that, normalised, because "chain armor" on the
// wire and "chain armor" in the table differ by whatever punctuation either side felt
// like. An unmatched item is reported rather than dropped — the reader can see that
// their plate mail was not modelled, which a silently empty slot would hide.
// DISPLAY NAME FIRST, class second, and in two full passes rather than one combined
// test. The two vocabularies overlap: `Helm` is the CLASS of "magic spirit helmet",
// while the item actually called "helm" has the class `SimpleHelm`. A single pass that
// accepted either would match a plain helm to the magic one — the first entry whose
// class happened to spell the same word — and quietly compute the whole table against
// the wrong defence bonus.
//
// The wire only ever gives us display names, so that is the authoritative side; the
// class match is a convenience for anything that passes one deliberately.
function matchGear(data, name) {
  const want = norm(name);
  if (!want) return null;
  const passes = [(x) => norm(x.name) === want, (x) => norm(x.cls) === want];
  for (const hit of passes) {
    for (const w of data.weapons || [])
      if (hit(w)) return { kind: 'weapon', cls: w.cls, name: w.name };
    for (const slot of Object.keys(data.armour || {}))
      for (const a of data.armour[slot] || [])
        if (hit(a)) return { kind: 'armour', slot, cls: a.cls, name: a.name };
  }
  return null;
}

// WHICH STROKE THE CHARACTER WOULD ACTUALLY SWING. The build carries one number and
// the character has up to four, so this picks the one that applies to what is in its
// hand: `fire` for a bow, the better of slash and thrust for anything else, and
// Unarmed Combat for an empty hand. Reported, because "we used your thrust" is a
// claim about the numbers on the page.
function pickStroke(abilityByName, weaponName) {
  const get = (n) => abilityByName[norm(n)] ?? null;
  const ranged = /bow|crossbow|sling/i.test(weaponName || '');
  if (!weaponName) {
    const u = get('Unarmed Combat');
    return { key: 'Unarmed Combat', value: u ?? 0, known: u !== null };
  }
  if (ranged) { const f = get('fire'); return { key: 'fire', value: f ?? 0, known: f !== null }; }
  const slash = get('slash'), thrust = get('thrust');
  if (slash === null && thrust === null) return { key: 'slash', value: 0, known: false };
  return (thrust ?? -1) > (slash ?? -1)
    ? { key: 'thrust', value: thrust, known: true }
    : { key: 'slash', value: slash ?? 0, known: slash !== null };
}

export function buildFromCharacter({ status, equipment, abilities, data }) {
  // Abilities by normalised name, from the broker's cached record — the numbers it
  // keeps current from the server's own pushes rather than re-reading here.
  const abilityByName = {};
  for (const row of [...(abilities?.skills || []), ...(abilities?.spells || [])])
    if (row?.name) abilityByName[norm(row.name)] = row.ability;
  const get = (n) => abilityByName[norm(n)] ?? null;

  // Attributes. `status` reports them under their own names; they are fixed at
  // creation and never move, so there is nothing to keep current.
  const attr = status?.attributes ?? status?.stats ?? {};
  const statOf = (k) => {
    const v = attr[k] ?? attr[k?.toLowerCase()];
    return Number.isFinite(v) ? v : (Number.isFinite(v?.value) ? v.value : 0);
  };

  const equipped = (equipment?.equipped || []).map(e => e.name).filter(Boolean);
  const matched = equipped.map(n => ({ name: n, hit: matchGear(data, n) }));
  const weapon = matched.find(m => m.hit?.kind === 'weapon')?.hit ?? null;
  const gear = {};
  const worn = [];
  for (const m of matched) {
    if (m.hit?.kind !== 'armour') continue;
    // One item per slot, first wins. Two things in one slot is possible in kod
    // (CanBeWornInSameSlotWith) and the bestiary has no way to express it, so say so
    // rather than pick silently.
    if (gear[m.hit.slot]) { worn.push({ ...m.hit, ignored: 'the bestiary models one item per slot' }); continue; }
    gear[m.hit.slot] = m.hit.cls;
    worn.push(m.hit);
  }
  const unmatched = matched.filter(m => !m.hit).map(m => m.name);

  const stroke = pickStroke(abilityByName, weapon?.name ?? null);
  // The proficiency for what is actually held. profFor is the server's own names now;
  // it used to invent them, and every lookup missed.
  const profName = weapon ? profFor(weapon.name) : null;
  const prof = profName ? get(profName) : get('brawling');

  const health = status?.health ?? status?.vitals?.health ?? null;
  const maxHealth = health?.max ?? health?.currentMax ?? status?.max_health ?? 1;

  const missing = [];
  if (!stroke.known) missing.push(`stroke (${stroke.key})`);
  if (prof === null) missing.push(profName ? `proficiency (${profName})` : 'brawling');
  for (const k of ['parry', 'block', 'dodge']) if (get(k) === null) missing.push(k);

  return {
    id: 'live',
    name: `${status?.character ?? 'character'} (live)`,
    live: true,
    mode: 'detailed',
    maxHealth,
    stats: {
      might: statOf('might'), agility: statOf('agility'), stamina: statOf('stamina'),
      intellect: statOf('intellect'), mysticism: statOf('mysticism'), aim: statOf('aim'),
    },
    skills: {
      stroke: stroke.value ?? 0,
      proficiency: prof ?? 0,
      parry: get('parry') ?? 0,
      block: get('block') ?? 0,
      dodge: get('dodge') ?? 0,
      // calc.mjs falls back to these when the hand is empty, and having them means an
      // unarmed character is modelled as unarmed rather than as a swordsman with no sword.
      brawling: get('brawling') ?? 0,
      punch: get('Unarmed Combat') ?? 0,
    },
    weapon: weapon?.cls ?? '',
    gear,
    // WHAT WE USED AND WHAT WE COULD NOT. The page shows this, because a table of
    // numbers computed from a guess must not look like one computed from a reading.
    from: {
      character: status?.character ?? null,
      agent: status?.agent ?? null,
      at: Date.now(),
      equipped,
      weapon: weapon?.name ?? null,
      worn: worn.map(w => w.name),
      stroke: stroke.key,
      proficiency: profName,
      unmatched_gear: unmatched,
      missing_skills: missing,
      abilities_age_ms: abilities?.freshness?.age_ms ?? null,
    },
  };
}

// ------------------------------------------------------------------- the server

function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  // Path traversal: normalise FIRST, then check, or "/../../substrate/fleets/prod.json"
  // walks straight out of the tree and hands over the account passwords.
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('outside the compendium'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + p); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

async function characterBuild(agent) {
  const [status, equipment, ability] = await Promise.all([
    broker('status', { agent, brief: true }),
    broker('equipment', { agent }),
    broker('abilities', { agent, known_only: false }),
  ]);
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'creatures.json'), 'utf8'));
  return buildFromCharacter({
    status: { ...status, agent, character: status?.character ?? status?.name ?? agent },
    equipment,
    abilities: { skills: ability?.skills, spells: ability?.spells, freshness: ability?.freshness },
    data,
  });
}

const JSONH = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (res, body, code = 200) => {
  res.writeHead(code, JSONH);
  res.end(JSON.stringify(body, null, 1));
};

// A shopping list is a few kilobytes. Bounded so a stuck or hostile client cannot make this
// process hold an unbounded string. One copy, because both writing endpoints need the same bound
// and a second copy of a limit is how the two come to differ.
function readBody(req, res, then) {
  let body = '', tooBig = false;
  req.on('data', (c) => {
    body += c;
    if (body.length > 256 * 1024 && !tooBig) { tooBig = true; req.destroy(); }
  });
  req.on('end', () => {
    if (tooBig) return;
    let raw;
    try { raw = JSON.parse(body); }
    catch (e) { res.writeHead(400, JSONH); return res.end(JSON.stringify({ error: 'not JSON: ' + e.message })); }
    return then(raw);
  });
}

export function createServer({ access = 'local' } = {}) {
  const mode = parseAccess(access);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    const allowed = allowRequest(mode, req.method, req.socket.remoteAddress);
    if (!allowed.ok) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(allowed.why);
    }

    if (url.pathname === '/_health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ident: IDENT, pid: process.pid, root: ROOT,
        host: server.address()?.address, access: mode }));
    }

    // THE HANDOVER. Fetch the character, set the cookie, and send the reader on to the
    // page they actually wanted. A redirect rather than a rendered page so that the
    // address bar ends up on /creatures/ — the reader can then reload, bookmark and
    // navigate normally, and the cookie follows them.
    if (url.pathname === '/_import') {
      const agent = url.searchParams.get('agent');
      const to = url.searchParams.get('to') || '/creatures/';
      // Only ever a path within this origin. An open redirect on a loopback server is
      // still an open redirect, and this one would carry the cookie.
      const dest = to.startsWith('/') && !to.startsWith('//') ? to : '/creatures/';
      if (!agent) { res.writeHead(400).end('need ?agent='); return; }
      try {
        const build = await characterBuild(agent);
        const value = encodeURIComponent(JSON.stringify(build));
        res.writeHead(302, {
          location: dest,
          // Session cookie, this origin, path-wide. SameSite=Lax is enough: nothing
          // here is a state change, and Strict would drop it on the redirect itself in
          // some browsers.
          'set-cookie': `${COOKIE}=${value}; Path=/; SameSite=Lax; Max-Age=86400`,
          'cache-control': 'no-store',
        });
        return res.end();
      } catch (e) {
        res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<h1>could not read ${agent}</h1><p>${e.message}</p>` +
                       `<p>The compendium itself is fine — <a href="${dest}">carry on without a character</a>. ` +
                       `This needs the broker on ${BROKER_PORT} with that agent in game.</p>`);
      }
    }

    // Same data, without the cookie, for anything that would rather fetch it.
    if (url.pathname === '/_character') {
      const agent = url.searchParams.get('agent');
      if (!agent) { res.writeHead(400).end('need ?agent='); return; }
      try {
        const build = await characterBuild(agent);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(build, null, 1));
      } catch (e) {
        res.writeHead(502, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    if (url.pathname === '/_forget') {
      res.writeHead(302, { location: url.searchParams.get('to') || '/creatures/',
                           'set-cookie': `${COOKIE}=; Path=/; Max-Age=0` });
      return res.end();
    }

    // ------------------------------------------------------------------ the planner
    //
    // THREE ENDPOINTS, AND ONE OF THEM WRITES. That is a first for this tree — everything
    // else here is a static site that happens to be served — so it is worth being explicit
    // about what bounds it: only this computer may write unless the server was started
    // `--access lan-write` (see the header of this file and `allowRequest`),
    // the path is `substrate/loadouts/<slug>.json` with the slug computed by
    // m59-loadout.mjs and nothing else, and the body is run through the same `normalise`
    // the tool uses before a byte is written. A loadout holds no credential — it is a
    // shopping list — which is why this is a reasonable thing to expose at all and why the
    // roster, which does, stays behind the path-traversal guard in serveStatic.

    // WHAT THE PLANNER OPENS WITH: a character as observed, plus whatever plan it has. Both
    // halves, separately labelled, because the page's one job is to never draw them alike.
    if (url.pathname === '/_planner') {
      const agent = url.searchParams.get('agent');
      if (!agent) { res.writeHead(400, JSONH).end(JSON.stringify({ error: 'need ?agent=' })); return; }
      try {
        const [status, equipment, ability, inv] = await Promise.all([
          broker('status', { agent, brief: true }),
          broker('equipment', { agent }),
          broker('abilities', { agent, known_only: false }),
          broker('inventory', { agent }),
        ]);
        const character = status?.character ?? status?.name ?? agent;
        // A CHARACTER CAN HAVE A LOADOUT AND NOT BE IN THE FLEET, and vice versa. Read it by
        // NAME, because the roster's agent handles are per-machine and a loadout is about
        // the character.
        let saved = null;
        try { saved = readLoadout(character); } catch { /* a broken file is not a reason to refuse the character */ }
        // ATTRIBUTES ARRIVE AS {value, display_scale, hard_cap} AND THE PAGE WANTS NUMBERS.
        // Flattened here rather than in the browser, because `hard_cap` is the real ceiling
        // a re-roll may spend up to (70) and the page had it hardcoded — a number the
        // server already knows should not be typed into a stylesheet's neighbour.
        const attrRaw = status?.attributes ?? status?.stats ?? {};
        const attributes = {}, caps = {};
        for (const [k, v] of Object.entries(attrRaw)) {
          attributes[k] = Number.isFinite(v) ? v : (Number.isFinite(v?.value) ? v.value : 0);
          if (Number.isFinite(v?.hard_cap)) caps[k] = v.hard_cap;
        }
        return json(res, {
          observed: {
            character, agent,
            attributes, attribute_caps: caps,
            // A CHARACTER'S LEVEL IS ITS MAXIMUM HEALTH. There is no separate field, here or
            // in the game — see substrate/sheets/*.json, which says the same thing.
            level: status?.vitals?.health?.max ?? null,
            skills: ability?.skills ?? [],
            spells: ability?.spells ?? [],
            inventory: inv?.items ?? [],
            equipment: equipment?.equipped ?? [],
            at: new Date().toISOString(),
            source: 'the broker, live',
            // The page shows this: an ability list read four minutes ago and one read now
            // must not render identically.
            abilities_age_ms: ability?.freshness?.age_ms ?? null,
          },
          loadout: saved?.loadout ?? null,
          problems: saved?.problems ?? [],
          character,
        });
      } catch (e) {
        res.writeHead(502, JSONH);
        return res.end(JSON.stringify({ error: `could not read ${agent}: ${e.message}. ` +
          `This needs the broker on ${BROKER_PORT} with that agent in game.` }));
      }
    }

    // WHO THERE IS TO PLAN FOR. Also the page's test for whether it is being served by the
    // harness at all — nothing else answers this path, so a 404 is the honest signal that
    // Save cannot work, and the page says so rather than offering a button that does
    // nothing.
    if (url.pathname === '/_loadouts') {
      const saved = listLoadouts();
      let fleet = [];
      try {
        const f = await broker('fleet', {});
        const has = new Set(saved.filter(s => s.loadout).map(s => slugOf(s.loadout.character)));
        fleet = (f.fleet || []).filter(r => r.character)
          .map(r => ({ agent: r.agent, character: r.character, loadout: has.has(slugOf(r.character)) }));
      } catch { /* no broker: the saved loadouts are still worth listing */ }
      return json(res, {
        dir: LOADOUT_DIR,
        fleet,
        loadouts: saved.map(s => ({ character: s.loadout?.character ?? s.file,
                                    file: s.file, ok: !!s.loadout, problems: s.problems })),
      });
    }

    // THE GUILD HALL IS A SHEET IN THE PLANNER, AND IT IS NOT A CHARACTER.
    //
    // Everything else the planner edits belongs to one character and follows it across
    // re-rolls. A chest plan belongs to the FLEET: one file, one end state, answered by
    // whoever walks past. So it is its own route rather than a loadout with a reserved
    // name — a character called "GUILD HALL" would be indistinguishable from a real one to
    // every tool that iterates loadouts, and the first of those to run would try to give
    // it a weapon.
    //
    // The sheet is offered only when the cache shows a guild AND an opened chest, which is
    // the same gate the keeper uses. A planner that let somebody fill in three chests for a
    // hall the fleet does not own would be collecting items against nowhere to put them.
    if (url.pathname === '/_guildplan' && req.method === 'GET') {
      const store = new StorageCache();
      const chests = store.allChests(), rent = store.readRent();
      const gate = guildStoreAvailable({ rent, chests });
      const plan = guildPlan();
      return json(res, {
        available: gate.ok, why: gate.why ?? null,
        slots: GUILD_CHEST_SLOTS, chest_bulk_max: CHEST_BULK_MAX,
        chests: chests.map(c => ({ slot: c.slot, never_opened: !!c.never_opened,
          observed_at: c.observed_at ?? null, opened_by: c.opened_by ?? null,
          items: c.items ?? null, bulk: c.items ? chestFullness(c.items).bulk : null,
          percent: c.fullness?.percent ?? null })),
        plan: plan ? Object.fromEntries([...plan.chests].map(([slot, items]) => [slot, items])) : null,
        problems: plan?.problems ?? [],
        shortfall: plan ? guildShortfall({ plan, chests, rent }) : [],
      });
    }

    if (url.pathname === '/_guildplan' && req.method === 'POST') {
      return readBody(req, res, (raw) => {
        const store = new StorageCache();
        const gate = guildStoreAvailable({ rent: store.readRent(), chests: store.allChests() });
        // REFUSED RATHER THAN SAVED-AND-IGNORED. A plan written against a hall the fleet
        // does not own would sit on disk protecting items from every vendor the fleet
        // visits, for a chest that does not exist.
        if (!gate.ok) {
          res.writeHead(409, JSONH);
          res.end(JSON.stringify({ error: 'no guild hall', why: gate.why }));
          return;
        }
        const { saved, problems } = saveGuildPlan(raw);
        return json(res, { saved, problems });
      });
    }

    if (url.pathname === '/_loadout' && req.method === 'GET') {
      const character = url.searchParams.get('character');
      if (!character) { res.writeHead(400, JSONH).end(JSON.stringify({ error: 'need ?character=' })); return; }
      const rec = readLoadout(character);
      if (!rec) { res.writeHead(404, JSONH).end(JSON.stringify({ error: `no loadout for ${character}` })); return; }
      return json(res, { loadout: rec.loadout, problems: rec.problems, path: rec.path });
    }

    if (url.pathname === '/_loadout' && req.method === 'POST') {
      return readBody(req, res, (raw) => {
        const character = String(raw?.character ?? '').trim();
        // TWO CHECKS, AND THE SECOND IS NOT REDUNDANT.
        //
        // `slugOf` already makes escape impossible — it drops everything that is not a
        // letter or digit, so "../../substrate/fleets/prod" lands on
        // `loadouts/substrate-fleets-prod.json` rather than anywhere near the roster. That
        // is the property that matters and it is tested.
        //
        // But it lands SOMEWHERE, under a name nobody asked for, and a write that silently
        // renames its target is the shape of a bug even when it is not the shape of an
        // exploit. No Meridian character name contains a slash or a dot-dot, so a request
        // carrying one is not a character name and is refused rather than flattened.
        if (/[\\/]|\.\./.test(character)) {
          res.writeHead(400, JSONH);
          return res.end(JSON.stringify({ error: `"${character}" is not a character name — ` +
            'it looks like a path. Nothing here can be written outside substrate/loadouts/, ' +
            'but a name that would be silently rewritten is refused rather than accepted.' }));
        }
        if (!slugOf(character)) {
          res.writeHead(400, JSONH);
          return res.end(JSON.stringify({ error: `"${character}" cannot be a character name — ` +
            'letters and digits, please' }));
        }
        try {
          // `force` because the planner is editing a named character deliberately, and the
          // collision guard exists for a caller that does not know it is overwriting. Say
          // which file it went to either way: a save that lands somewhere unexpected must
          // not look identical to one that lands where you meant.
          const out = writeLoadout(character, raw, { force: true });
          return json(res, { ok: true, path: out.path, loadout: out.loadout, problems: out.problems });
        } catch (e) {
          res.writeHead(400, JSONH);
          return res.end(JSON.stringify({ error: e.message }));
        }
      });
    }

    // ONE SHARED INVENTORY PLAN, GIVEN TO SELECTED CHARACTERS OR THE WHOLE FLEET.
    //
    // Gear and the desired carry list are the parts that can be shared. This copies those
    // and NOTHING ELSE — schools, skills, sell/keep rules, purse settings and notes are left
    // as found, which is what makes it safe against characters already planned by hand.
    //
    // WHO THE WHOLE FLEET IS COMES FROM THE BROKER, NOT FROM THE PAGE. An explicit checked
    // subset is different: it is a list of named loadouts, just like /_loadout above, and can
    // include one saved locally whose character is not logged in.
    //
    // It plans by default; `apply: true` is a second call, after somebody has read the
    // first. Both are the same function in m59-loadout.mjs, so the preview cannot describe
    // a write that would not happen.
    if ((url.pathname === '/_inventory-to-fleet' || url.pathname === '/_gear-to-fleet') &&
        req.method === 'POST') {
      return readBody(req, res, async (raw) => {
        let fleet = { fleet: [] };
        if (!Array.isArray(raw?.targets)) {
          try { fleet = await broker('fleet', {}); }
          catch (e) {
            res.writeHead(502, JSONH);
            return res.end(JSON.stringify({ error:
              `the broker on ${BROKER_PORT} is not answering (${e.message}) — and "the whole fleet" ` +
              'is a live question. The loadouts saved here are a different set of characters, so they ' +
              'are not substituted for it.' }));
          }
        }
        let characters = (fleet.fleet || []).filter(r => r.character)
          .map(r => ({ character: r.character, agent: r.agent }));
        if (Array.isArray(raw?.targets)) {
          const seen = new Set();
          characters = [];
          for (const target of raw.targets) {
            const character = String(target?.character ?? '').trim();
            if (/[\\/]|\.\./.test(character) || !slugOf(character)) {
              res.writeHead(400, JSONH);
              return res.end(JSON.stringify({ error: `"${character}" is not a usable character name` }));
            }
            const key = character.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            characters.push({ character, agent: target?.agent ?? null });
          }
        }
        if (!characters.length) {
          res.writeHead(409, JSONH);
          return res.end(JSON.stringify({ error:
            Array.isArray(raw?.targets) ? 'select at least one character'
              : 'the broker answered, but no character in the fleet has a name yet — a resume writes the ' +
                'name back on the first successful login, so this is what an empty or booting fleet looks like' }));
        }
        try {
          const shared = {};
          if (Object.prototype.hasOwnProperty.call(raw ?? {}, 'gear')) shared.gear = raw.gear;
          if (Object.prototype.hasOwnProperty.call(raw ?? {}, 'carry')) shared.carry = raw.carry;
          const out = applyInventoryToAll(shared, characters, {
            from: raw?.from ?? null,
            apply: raw?.apply === true,
            allowEmpty: raw?.allow_empty === true,
          });
          return json(res, {
            ok: true,
            scope: Array.isArray(raw?.targets) ? 'selected' : 'fleet',
            ...out,
          });
        } catch (e) {
          res.writeHead(400, JSONH);
          return res.end(JSON.stringify({ error: e.message }));
        }
      });
    }

    serveStatic(req, res, url.pathname);
  });
  return server;
}

// Is one already up, and is it OURS? A port that answers is not the same as the thing
// you wanted answering.
export async function probe(port = COMPENDIUM_PORT, ms = 1200) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/_health`, { signal: ctl.signal });
    const j = await r.json();
    return j?.ident === IDENT ? j : { foreign: true };
  } catch { return null; }
  finally { clearTimeout(t); }
}

// Start one if there is not one already. Returns how it went, so a caller can say
// "started it" or "it was already up" rather than guessing.
// An already-running server keeps the access mode it was started with; `access` here only
// applies to one this call starts, and `already` reports what the running one says.
export async function ensureServing(port = COMPENDIUM_PORT, { access = process.env.M59_COMPENDIUM_ACCESS } = {}) {
  const up = await probe(port);
  if (up && !up.foreign) return { already: true, pid: up.pid, port, access: up.access };
  if (up?.foreign)
    throw new Error(`something else is already listening on ${port} — set M59_COMPENDIUM_PORT`);
  const mode = parseAccess(access);
  const child = spawn(process.execPath,
                      [fileURLToPath(import.meta.url), '--port', String(port), '--access', mode],
                      { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  // Wait for it rather than assuming: a browser opened against a socket that is not
  // listening yet shows an error page, and the reader reads that as the key not working.
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 150));
    const ok = await probe(port, 400);
    if (ok && !ok.foreign) return { started: true, pid: ok.pid, port, access: ok.access };
  }
  throw new Error(`started a compendium server on ${port} but it never answered /_health`);
}

// The default browser, on whichever platform this is.
export function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32'
    // `start` is a cmd builtin, and the empty string is the window TITLE — without it
    // cmd treats a quoted URL as the title and opens nothing at all.
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return `${cmd} ${args.join(' ')}`;
}

export const importUrl = (agent, to = '/creatures/', port = COMPENDIUM_PORT) =>
  `http://127.0.0.1:${port}/_import?agent=${encodeURIComponent(agent)}&to=${encodeURIComponent(to)}`;

// ---------------------------------------------------------------------- cli
function printLanUrls(port, access) {
  if (!access || access === 'local') return;
  for (const addresses of Object.values(networkInterfaces()))
    for (const address of addresses || [])
      if (address.family === 'IPv4' && !address.internal)
        console.log(`  LAN (${access}): http://${address.address}:${port}/`);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'm59-compendium.mjs') {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const port = Number(arg('--port', COMPENDIUM_PORT));
  const agent = arg('--agent', null);
  const to = arg('--to', '/creatures/');
  let access;
  try { access = parseAccess(arg('--access', process.env.M59_COMPENDIUM_ACCESS)); }
  catch (e) { console.error(e.message); process.exit(2); }

  if (argv.includes('--status')) {
    const up = await probe(port);
    console.log(up ? (up.foreign ? `port ${port}: something else is listening`
                                 : `up — pid ${up.pid} on http://127.0.0.1:${port}/  (access: ${up.access ?? 'unknown'})`)
                   : `not running on ${port}`);
    printLanUrls(port, up?.access);
    process.exit(up && !up.foreign ? 0 : 1);
  }

  if (argv.includes('--open') && !argv.includes('--serve')) {
    const how = await ensureServing(port, { access });
    const url = agent ? importUrl(agent, to, port) : `http://127.0.0.1:${port}${to}`;
    openBrowser(url);
    console.log(`${how.already ? 'already serving' : 'started'} on ${port} (pid ${how.pid}, access: ${how.access ?? 'unknown'}); opened ${url}`);
    if (how.already && how.access && how.access !== access)
      console.log(`  note: it was already running as ${how.access}; restart it to change that`);
    printLanUrls(port, how.access);
    process.exit(0);
  }

  createServer({ access }).listen(port, accessHost(access), () => {
    console.log(`compendium on http://127.0.0.1:${port}/  (access: ${access})`);
    printLanUrls(port, access);
    if (agent) {
      const url = importUrl(agent, to, port);
      if (argv.includes('--open')) openBrowser(url);
      console.log(`character import: ${url}`);
    }
  });
}
