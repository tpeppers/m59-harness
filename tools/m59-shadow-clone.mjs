#!/usr/bin/env node
// CLONE PRODUCTION ONTO THE LAB IN SECONDS — the shadow fleet, re-dressed in place.
//
//   node tools/m59-shadow-clone.mjs              export prod's caches, re-dress every shadow, log them in
//   node tools/m59-shadow-clone.mjs export       just the snapshot (prod caches, read-only)
//   node tools/m59-shadow-clone.mjs dress        re-dress from the snapshot on disk, keepers cycled
//   node tools/m59-shadow-clone.mjs --dry        export and plan, write nothing to the lab
//   node tools/m59-shadow-clone.mjs --json       last line is a JSON report (timings, residue)
//
//   --prod-root <dir>    the production checkout whose caches are read (default: the deploy)
//   --roster <file>      the shadow roster (default: <prod-root>/substrate/fleets/shadow.json)
//   --server h:p --admin h:p --http n --dashboard n      the lab and the shadow broker
//   --keep-surplus       leave items prod does not carry (default: delete them — a clone is exact)
//   --keep-orders        leave the clones' own orders (default: each gets its original's mode,
//                        policy and loadout, with prod names translated to their clones)
//   --no-login           leave the fleet logged out after dressing
//
// WHY THIS EXISTS. `m59-shadow-run.mjs` builds a shadow fleet in about ten minutes, and almost
// none of that is work. Measured 2026-10-29 on the pieces it is made of:
//
//   prod snapshot     ~120 sequential broker calls (look/equipment/inventory/abilities/guild ×24)
//   create            a `reroll` per character, each a full login + BP_NEW_CHARINFO, in series
//   dress             a few hundred DM commands — 2000 of them take 130 ms on this socket
//   play              24 keeper processes at 6 at a time, 7-10 s each of node start + map load
//   settle            45+ s of watching a fleet that went shopping
//
// So the slow parts are the ones that are not cloning. This file does only the cloning:
//
//   EXPORT FROM CACHES, NOT FROM THE WIRE. Every prod keeper already holds its character's
//   attributes, karma, vitals, position, pack with amounts and grades, and what it wears, and
//   answers `GET /state` from cache in ~2 ms. Ability numbers are in the keeper's ability book
//   (substrate/abilities/<name>.json), faction in substrate/faction-status/<name>.json, the
//   hall's chests in substrate/storage/. Nothing is asked of the prod broker and nothing is
//   sent to the prod server: the export is 24 loopback GETs and some file reads.
//
//   NEVER RE-CREATE A BODY THAT EXISTS. The shadow accounts and characters are permanent;
//   a clone REWRITES them — stats, vitals, karma, abilities, pack, gear, guild, hall, chests,
//   faction, and the pose they log in at — over the maintenance socket, which is effectively
//   free. A body missing from the lab is reported, not made: making one needs a login and is
//   the old tool's job (`m59-shadow-run.mjs --until build`), once, ever.
//
//   NEVER RESTART A KEEPER THAT IS RUNNING. A keeper's cost is its process start, not its
//   login. If the shadow broker is up, each keeper is told `/leave` (the socket closes, the
//   process stays), the bodies are rewritten offline, and each is told `/join` — a relog,
//   which also re-sends every stat, list and item to the keeper so nothing it cached about
//   the old body survives. Only when no shadow broker is running is one started, with every
//   keeper spawned at once.
//
// THE RULE IT KEEPS: PROD IS READ, THE LAB IS WRITTEN. The prod side is file reads and
// cache-only GETs on prod's own keeper band (identity-checked by keeper-discovery). Every
// write goes to a loopback maintenance socket (m59-dm refuses anything else) and to keepers
// in the SHADOW fleet's band. `--fleet prod` and a non-loopback lab are refused up front.
import { spawn } from 'node:child_process';
import { setPriority, constants as OS } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as F from './m59-shadow-fidelity.mjs';
import { dm as dmRaw, resolve as dmResolve, statCmds, healthCmds, karmaCmd, setProp, returnedObject, rejections }
  from './m59-dm.mjs';
import { rarityName } from './m59-items.mjs';
import { setHallPassword, FLEETS_DIR as HALLSECRET_DIR } from './m59-hallsecret.mjs';
import { resolveKeeperBand, discoverKeeperStates, keeperIdentityHeaders, keeperBandPorts } from './runtime/keeper-discovery.mjs';
import { FactionStatusCache } from './m59-faction-status.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = n => argv.includes(n);

// The production checkout is where prod's keepers write their books and caches. A clone run
// from a worktree still reads the DEPLOY's, because that is the fleet being copied.
const DEPLOY = 'C:/code/m59-lab/prod-deploy';
const PROD_ROOT = resolvePath(arg('--prod-root', process.env.M59_PROD_ROOT ||
  (existsSync(join(DEPLOY, 'substrate', 'fleets', 'prod.json')) ? DEPLOY : REPO)));
const FLEET = arg('--fleet', 'shadow');
const ROSTER = resolvePath(arg('--roster', process.env.M59_SHADOW_ROSTER ||
  join(PROD_ROOT, 'substrate', 'fleets', `${FLEET}.json`)));
// Beside the roster, where m59-shadow.mjs has always kept it, so both tools share one snapshot
// and one slot assignment.
const SNAPSHOT = resolvePath(arg('--snapshot', join(dirname(dirname(ROSTER)), 'shadow-snapshot.json')));
const [GAME_HOST, GAME_PORT] = String(arg('--server', '127.0.0.1:15959')).split(':');
const [ADMIN_HOST, ADMIN_PORT] = String(arg('--admin', '127.0.0.1:19998')).split(':');
const HTTP_PORT = Number(arg('--http', 8971));
const DASH_PORT = Number(arg('--dashboard', HTTP_PORT + 1));
const BANDS = join(PROD_ROOT, 'substrate', 'keeper-bands.json');
const DRY = has('--dry');
const TRIM = !has('--keep-surplus');
const DM_ENV = { ...process.env, M59_ADMIN_HOST: ADMIN_HOST, M59_ADMIN_PORT: String(ADMIN_PORT) };
const dm = (cmds, timeoutMs = 120000) => dmRaw(cmds, { env: DM_ENV, timeoutMs });
const resolveNames = names => dmResolve(names, { env: DM_ENV, timeoutMs: 30000 });

const say = (...a) => { if (!has('--quiet')) console.log(...a); };
const timings = {};
async function timed(label, fn) {
  const t = Date.now();
  try { return await fn(); }
  finally { timings[label] = Date.now() - t; say(`  ${label}: ${((Date.now() - t) / 1000).toFixed(2)}s`); }
}
const readJson = (p, d = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const samePath = (a, b) => !!a && !!b && resolvePath(String(a)).toLowerCase() === resolvePath(String(b)).toLowerCase();

// ------------------------------------------------------------------ refusals
export function refusals({ fleet, gameHost, gamePort, adminHost, roster, httpPort, prodPort = 8901 }) {
  const out = [];
  if (/^prod/i.test(String(fleet ?? ''))) out.push(`REFUSING: --fleet "${fleet}" is production. A clone REWRITES characters.`);
  if (!/(^|[\\/])shadow[^\\/]*\.json$/i.test(String(roster ?? ''))) out.push(`REFUSING: roster ${roster} is not a shadow roster`);
  if (!LOOPBACK.has(String(gameHost)) || Number(gamePort) === 5959)
    out.push(`REFUSING: ${gameHost}:${gamePort} is not the loopback lab server`);
  if (!LOOPBACK.has(String(adminHost))) out.push(`REFUSING: maintenance socket ${adminHost} is not loopback`);
  if (Number(httpPort) === prodPort) out.push(`REFUSING: ${prodPort} is the production broker`);
  return out;
}

// ------------------------------------------------------------------ export (prod, read-only)
//
// One record per prod character in the shape `m59-shadow.mjs snapshot` wrote, so `verify`,
// the position and ability helpers and anything else reading shadow-snapshot.json keep working.
const FACTIONS = { neutral: 0, duke: 1, princess: 2, rebel: 3 };

/** A prod keeper's cached `/state` -> the snapshot record's body. Pure, for the test. */
export function recordFromState(st, { sheet = null, book = null, faction = null } = {}) {
  const rows = (st?.items ?? []).filter(x => x?.name).map(x => {
    const rarity = rarityName(x.rarity);
    return { name: x.name, amount: Number(x.amount ?? 0) || 0,
             ...(rarity && rarity !== 'normal' ? { rarity } : {}),
             ...(Number(x.translation) && Number(x.icon_rsc) === 30513 ? { translation: Number(x.translation) } : {}),
             // The icon resource id names the class of a bare scroll/potion/wand (fidelity iconHoldingClass).
             ...(/^(wand|scroll|potion)s?$/i.test(String(x.name).trim()) && Number(x.icon_rsc) ? { icon_rsc: Number(x.icon_rsc) } : {}) };
  });
  const sa = sheet?.attributes ?? null;
  const live = st?.attributes ?? {};
  // BASE ATTRIBUTES FROM THE SHEET WHEN THERE IS ONE. `/state` carries stat group 2, which is
  // the number AFTER gear and spells (Clifford reads might 53 against a cap of 50), and writing
  // that as the base would make the clone stronger by whatever he happened to be wearing.
  const six = ['might', 'intellect', 'stamina', 'agility', 'mysticism', 'aim'];
  const attributes = sa && six.every(k => Number.isFinite(Number(sa[k])))
    ? Object.fromEntries(six.map(k => [k, Number(sa[k])]))
    : six.every(k => Number.isFinite(Number(live[k]))) ? Object.fromEntries(six.map(k => [k, Number(live[k])])) : null;
  const abilityRows = kind => Object.entries(book?.[kind] ?? {})
    // NULL IS NOT ZERO: Number(null) is 0, and an ability nobody has read is not an ability of 0.
    .filter(([, v]) => v?.ability != null && v.ability !== '' && Number.isFinite(Number(v.ability)))
    .map(([name, v]) => ({ name, ability: Number(v.ability) }));
  const known = new Set([...abilityRows('skills'), ...abilityRows('spells')].map(r => r.name.toLowerCase()));
  const unnumbered = [...(st?.skills ?? []), ...(st?.spells ?? [])].map(s => s?.name).filter(n => n && !known.has(n.toLowerCase()));
  const you = st?.you ?? {};
  return {
    attributes, attributes_from: sa ? `sheet ${sheet.captured_at_iso ?? ''}`.trim() : attributes ? 'keeper (includes gear)' : null,
    karma: Number.isFinite(Number(live.karma)) ? Number(live.karma) : null,
    max_health: Number(st?.hp?.max) || null, health: Number(st?.hp?.value) || null,
    mana: Number.isFinite(Number(st?.mana?.value)) ? Number(st.mana.value) : null,
    max_mana: Number(st?.mana?.max) || null,
    vigor: Number.isFinite(Number(st?.vigor?.value)) ? Number(st.vigor.value) : null,
    room: Number(st?.room?.num) || null, room_name: st?.room?.name ?? null,
    col: Number.isInteger(you.col) ? you.col : null, row: Number.isInteger(you.row) ? you.row : null,
    // KOD fine units, 64 to a square — what piSave_fine_* store. Kept only when it agrees with
    // the square, because shadowLoginPositionCommands refuses a pose that does not.
    ...(Number.isInteger(you.x) && Number.isInteger(you.y) && Math.floor(you.x / 64) === you.col &&
        Math.floor(you.y / 64) === you.row ? { initialFine: { x: you.x, y: you.y } } : {}),
    equipment: (st?.equipment_items ?? []).map(e => e?.name).filter(Boolean),
    wielding: null,
    inventory: rows, purse: F.purseOf(rows),
    abilities: { skills: abilityRows('skills'), spells: abilityRows('spells') },
    abilities_at: book?.read_at ? Math.max(Number(book.read_at.skills) || 0, Number(book.read_at.spells) || 0) || null : null,
    abilities_unnumbered: unnumbered,
    faction: faction?.faction && faction.faction in FACTIONS
      ? { faction: faction.faction, soldier: !!faction.soldier, observed_at: faction.observed_at ?? null } : null,
    in_game: !!st?.in_game,
  };
}

async function exportProd() {
  const prodRoster = readJson(join(PROD_ROOT, 'substrate', 'fleets', 'prod.json'));
  if (!prodRoster) throw new Error(`no prod roster under ${PROD_ROOT}`);
  // Names only. The roster is the credential store; nothing else in it is read or kept.
  const agents = Object.entries(prodRoster).map(([agent, v]) => ({ agent, character: v?.credentials?.character ?? null }));
  const band = resolveKeeperBand('prod', { registryPath: BANDS, missing: 'null' });
  if (!band) throw new Error(`no keeper band for prod in ${BANDS}`);
  const { states, duplicateAgents } = await discoverKeeperStates({ band, expectedAgents: agents.map(a => a.agent) });
  const sub = d => join(PROD_ROOT, 'substrate', d);
  // Each cache spells a character's file differently ("Zheng He.json", "ZhengHe.json",
  // "Zheng-He.json"), so each is read the way its own writer names it.
  const bookOf = name => readJson(join(sub('abilities'), `${String(name).replace(/[^A-Za-z0-9_-]/g, '')}.json`));
  const factions = new FactionStatusCache({ dir: sub('faction-status') });
  const previous = readJson(SNAPSHOT, {});
  const prevChars = previous.characters ?? [];
  const slots = F.assignShadowSlots(agents.map(a => a.agent), prevChars);

  const out = [], missing = [];
  for (const { agent, character } of agents) {
    const st = states.get(agent);
    const prev = prevChars.find(p => p.prod_agent === agent) ?? null;
    const name = st?.character ?? character;
    if (!st) { missing.push(agent); if (prev) out.push({ ...prev, stale: true }); continue; }
    const rec = recordFromState(st, {
      sheet: readJson(join(sub('sheets'), `${name}.json`)) ?? readJson(join(REPO, 'substrate', 'sheets', `${name}.json`)),
      book: bookOf(name),
      faction: factions.read(name),
    });
    const slot = slots.get(agent);
    out.push({
      shadow_name: F.shadowName(slot), shadow_account: F.shadowAcct(slot),
      prod_character: name, prod_agent: agent,
      ...rec,
      // Attributes never move after creation, so the last snapshot's are still right when no
      // sheet was found this time.
      attributes: rec.attributes ?? prev?.attributes ?? null,
      // Guild rank moves rarely and is not in any cache; the last live read carries it.
      guild: prev?.guild ?? null,
      level: rec.max_health,
      state_age_ms: Number(st.as_of_ms) || null,
    });
  }

  // THE GUILD: the last live read of the roster (titles, ranks, master, hall password), with
  // the hall's chests and rent re-read from prod's storage cache, which is fresher.
  let guild = previous.guild ?? null;
  const storage = sub('storage');
  if (guild && existsSync(join(storage, 'chests'))) {
    const chests = readdirSync(join(storage, 'chests')).filter(f => f.endsWith('.json'))
      .map(f => readJson(join(storage, 'chests', f))).filter(Boolean);
    const rent = readJson(join(storage, 'rent.json'));
    guild = { ...guild, chests: chests.map(F.chestRecord).filter(Boolean),
              ...(rent && Number.isFinite(Number(rent.credit)) ? { rent_credit: Number(rent.credit), rent_observed_at: rent.observed_at ?? null } : {}) };
  }
  const snap = {
    _what: 'A read-only copy of the production roster, for building a shadow fleet on the local test ' +
           'server. Contains no account credentials. guild.hall_password is never printed.',
    taken_at: new Date().toISOString(), source: `prod keeper caches (${PROD_ROOT})`,
    exporter: 'm59-shadow-clone', storage_from: storage,
    characters: out, guild,
    ...(previous.guild && guild ? { guild_roster_from: previous.taken_at ?? null } : {}),
  };
  if (!DRY) { mkdirSync(dirname(SNAPSHOT), { recursive: true }); writeFileSync(SNAPSHOT, JSON.stringify(snap, null, 2), { mode: 0o600 }); }
  say(`  ${out.length - missing.length} of ${agents.length} prod characters read from keeper caches` +
      (missing.length ? `; NO KEEPER for ${missing.join(', ')} (last snapshot kept for them)` : '') +
      (duplicateAgents.size ? `; DUPLICATE keepers for ${[...duplicateAgents].join(', ')}` : ''));
  return snap;
}

// ------------------------------------------------------------------ the lab: reading
async function showBlocks(cmds) { return cmds.length ? F.splitReplies(await dm(cmds), cmds) : []; }

async function readHoldings(holderIds) {
  const heads = (await showBlocks(holderIds.map(id => `show object ${id}`))).map(F.parseShowObject);
  const listCmds = [...new Set(heads.flatMap(h => [h.passive, h.using].filter(Boolean)).map(l => `show list ${l}`))];
  const listBlocks = await showBlocks(listCmds);
  const listIds = new Map(listCmds.map((c, i) => [c, F.parseListObjects(listBlocks[i])]));
  const ids = l => (l ? listIds.get(`show list ${l}`) ?? [] : []);
  const itemIds = [...new Set(heads.flatMap(h => ids(h.passive)))];
  const items = await showBlocks(itemIds.map(id => `show object ${id}`));
  const byId = new Map(itemIds.map((id, i) => [id, F.parseShowObject(items[i])]));
  // A PHANTOM IS LISTED AND NOT OWNED. Item.Delete clears poOwner but leaves the holder's
  // list node behind (holder.kod:392), and a soldier shield deletes ITSELF when ReqUse finds
  // its owner in another faction (soldshld.kod:367) — which every shield an earlier,
  // faction-blind build tried to put on did. Counting one as carried means a real one is never
  // made: 21 of 24 clones were left without their army shield exactly that way.
  return holderIds.map((hid, i) => {
    const using = new Set(ids(heads[i]?.using));
    const all = ids(heads[i]?.passive).map(id => ({ id, class: byId.get(id)?.class ?? null,
      number: byId.get(id)?.number ?? null, using: using.has(id), owner: byId.get(id)?.owner ?? null })).filter(x => x.class);
    return { id: hid, head: heads[i], items: all.filter(x => x.owner === hid), phantoms: all.filter(x => x.owner !== hid) };
  });
}

// Detach before delete, so the list node and the cached load go with it.
const phantomCmds = holdings => holdings.flatMap(h => (h.phantoms ?? []).flatMap(p => F.deleteHeldCmds(h.id, p.id)));

const loggedOn = block => /pbLogged_on\s+= INT 1\b/.test(String(block ?? ''));

// ------------------------------------------------------------------ the lab: writing
//
// Every step is one or two maintenance batches across the WHOLE fleet, never a loop of
// per-character round trips: at ~65 µs a command the socket is not the cost, the round trip
// is, and twenty-four of them per concern is what made the old dress take minutes.

/** Stats, vitals and karma, as commands. Pure, for the test. */
export function bodyCmds(id, c) {
  const cmds = [];
  if (c.attributes) cmds.push(...statCmds(id, c.attributes));
  if (c.max_health) {
    // All three or the level does not move (m59-dm healthCmds); then down to prod's current.
    cmds.push(...healthCmds(id, c.max_health));
    if (c.health && c.health < c.max_health) cmds.push(setProp(id, 'piHealth', c.health));
  }
  if (Number.isFinite(c.karma)) cmds.push(karmaCmd(id, c.karma));
  if (Number.isFinite(c.vigor))
    cmds.push(setProp(id, 'piVigor', Math.max(0, Math.round(c.vigor))), setProp(id, 'piExertion', 0), `send object ${id} NewVigor`);
  // Max mana is recomputed at every login from mysticism and the spell list; the current
  // number is stored, and is what decides whether a character can cast on arrival.
  if (Number.isFinite(c.mana)) cmds.push(setProp(id, 'piMana', Math.max(0, Math.round(c.mana))));
  return cmds;
}

/**
 * Faction: ResetFaction is player.kod's own setter (it strips a soldier shield of the wrong
 * side), and the Parliament keeps a per-faction member list that votes and liege mail read.
 * JoinFaction is not used — it refuses unless the player is mid-intrigue with a liege.
 */
export function factionCmds(id, parliament, faction) {
  const f = FACTIONS[faction?.faction];
  if (f == null) return [];
  return [`send object ${id} ResetFaction faction INT ${f}`,
          ...(parliament ? [`send object ${parliament} MoveToFaction who OBJECT ${id} faction INT ${f}`] : [])];
}

async function dressBodies(chars, ids) {
  const parliament = returnedObject(await dm([`send object 0 GetParliament`]));
  const cmds = chars.flatMap(c => [...bodyCmds(ids[c.shadow_name], c), ...factionCmds(ids[c.shadow_name], parliament, c.faction)]);
  const out = await dm(cmds);
  const bad = rejections(out);
  say(`    ${cmds.length} stat/vital/karma/faction commands${bad.length ? `, ${bad.length} rejected: ${bad.slice(0, 2).join('; ')}` : ''}`);
  return { commands: cmds.length, rejected: bad };
}

async function dressAbilities(chars) {
  // The fidelity mirror is all-or-nothing on a name it cannot map, which is right for a
  // construction run and wrong for a clone of 24: one unmapped spell would leave all 24 with
  // the previous run's abilities. So the rows it cannot map are dropped and NAMED instead.
  const dropped = new Map();
  const records = chars.map(c => {
    const keep = kind => (c.abilities?.[kind] ?? []).filter(r => {
      const ok = F.shadowAbilityId(kind, r.name) != null && Number.isFinite(Number(r.ability));
      if (!ok) dropped.set(r.name, (dropped.get(r.name) ?? 0) + 1);
      return ok;
    });
    return { ...c, abilities: { skills: keep('skills'), spells: keep('spells') } };
  });
  try {
    const r = await F.mirrorShadowAbilities(records, { apply: true, resolve: resolveNames, dm: cmds => dm(cmds, 180000) });
    say(`    abilities: ${r.verified} characters read back exact (${r.commands} commands)` +
        (dropped.size ? `; NOT MAPPED: ${[...dropped].map(([n, k]) => `${n} x${k}`).join(', ')}` : ''));
    return { ok: true, ...r, unmapped: [...dropped.keys()] };
  } catch (e) {
    say(`    abilities: ${e.message}`);
    return { ok: false, error: e.message, unmapped: [...dropped.keys()] };
  }
}

const wearOf = c => (Array.isArray(c.equipment) ? c.equipment : []);

async function dressItems(chars, ids) {
  const index = F.defaultIndex();
  const who = chars.filter(c => Array.isArray(c.inventory));
  const holders = who.map(c => ids[c.shadow_name]);
  const before = await readHoldings(holders);
  const ghosts = phantomCmds(before);
  if (ghosts.length) await dm(ghosts);
  const unknown = new Map(), approx = new Map();
  const plans = who.map((c, i) => {
    const w = F.wantedHoldings(c.inventory, wearOf(c), index);
    for (const u of w.unknown) unknown.set(u.name, u.why);
    for (const a of w.approximated) approx.set(`${a.name} (${a.rarity})`, a.class);
    return { c, w, plan: F.planHoldings({ want: w.want, have: before[i].items }) };
  });
  // ONE create batch for the fleet; the ids come back in order, and are dealt back out per
  // character by count. A count mismatch hands nothing over and deletes what was made.
  const creates = plans.flatMap(p => F.createCmds(p.plan));
  const created = creates.length ? F.createdObjects(await dm(creates)) : [];
  if (created.length !== creates.length) {
    if (created.length) await dm(created.map(F.deleteCmd));
    return { ok: false, error: `created ${created.length} of ${creates.length} items — nothing handed over` };
  }
  let k = 0;
  const cmds = plans.flatMap((p, i) => {
    const mine = created.slice(k, k += p.plan.create.length);
    return F.holdingCmds(p.plan, { holder: holders[i], wearer: holders[i], created: mine, trim: TRIM });
  });
  const out = cmds.length ? await dm(cmds) : '';
  const bad = rejections(out);
  // READ IT BACK. No error has never meant success on this server. And WEAR UNTIL IT STICKS:
  // putting on a shield runs FreeHandSlotsFor (player.kod:3355), which can take a weapon put
  // on a moment earlier back off, so whatever is still wanted on is put on again — the game's
  // own slot rules decide, re-asked rather than re-implemented here.
  let after = await readHoldings(holders);
  for (let pass = 0; pass < 2; pass++) {
    const again = plans.flatMap((p, i) => F.planHoldings({ want: p.w.want, have: after[i].items }).wear
      .map(w => F.useCmd(holders[i], w.id)));
    if (!again.length) break;
    await dm(again);
    after = await readHoldings(holders);
  }
  const off = [];
  plans.forEach((p, i) => {
    const left = F.planHoldings({ want: p.w.want, have: after[i].items });
    const residue = { ...left, surplus: TRIM ? left.surplus : [] };
    if (residue.create.length || residue.setNumber.length || residue.wear.length || residue.unwear.length || residue.surplus.length)
      off.push(`${p.c.shadow_name} (${p.c.prod_character}): ${F.describePlan(residue)}` +
               (left.wear.length ? ` — not put on: ${left.wear.map(x => x.class).join(', ')}` : ''));
  });
  say(`    items: ${who.length - off.length} of ${who.length} packs match prod by class and amount ` +
      `(${creates.length} created, ${cmds.length} hold/wear/trim commands${ghosts.length ? `, ${ghosts.length / 2} phantom(s) removed` : ''}` +
      `${bad.length ? `, ${bad.length} rejected` : ''})`);
  for (const o of off) say(`      STILL DIFFERENT ${o}`);
  if (unknown.size) say(`      NOT CREATED — no single kod class: ${[...unknown].map(([n, w]) => `${n} (${w})`).join('; ')}`);
  if (approx.size) say(`      APPROXIMATED — class only, hidden attributes are not on the wire: ${[...approx.keys()].join(', ')}`);
  return { ok: !off.length, created: creates.length, commands: cmds.length, residue: off,
           unknown: [...unknown.keys()], approximated: [...approx.keys()], rejected: bad };
}

// The guild, its hall and its chests. The sequence and every command are the fidelity
// module's (see the note above TITLE_PROPS there); re-runnable, and it never takes a hall
// another guild owns.
async function mirrorGuild(snap, ids) {
  const g = snap.guild;
  if (!g) { say('    guild: none in the snapshot — skipped'); return { ok: true, skipped: true }; }
  const { members, missing, master } = F.guildMembers(g, snap.characters, ids);
  if (!master) { say(`    guild: prod's master ${g.master} has no shadow on the lab`); return { ok: false }; }
  const heads = (await showBlocks(members.map(m => `show object ${m.id}`))).map(F.parseShowObject);
  const inGuild = new Map(members.map((m, i) => [m.id, heads[i]?.guild ?? null]));
  let guildId = null;
  for (const gid of new Set([...inGuild.values()].filter(Boolean))) {
    if (F.returnedString(await dm([`send object ${gid} GetName`], 15000)) === g.name) { guildId = gid; break; }
  }
  const made = guildId == null;
  const rsc = {};
  for (const r of F.guildResourceCmds(g).filter(r => made || r.key === 'password'))
    rsc[r.key] = F.createdResource(await dm([r.cmd], 15000), r.cmd.slice('create resource '.length));
  if (made) {
    if (rsc.name == null) { say('    guild: `create resource` gave no id — nothing founded'); return { ok: false }; }
    guildId = F.createdObjects(await dm([F.guildCreateCmd({ masterId: master.id, nameRsc: rsc.name })], 30000))[0] ?? null;
    guildId ??= F.parseShowObject((await showBlocks([`show object ${master.id}`]))[0]).guild ?? null;
    if (guildId == null) { say('    guild: `create object Guild` returned nothing'); return { ok: false }; }
    inGuild.set(master.id, guildId);
  }
  const others = Object.fromEntries([...inGuild].filter(([, gid]) => gid != null && gid !== guildId));
  const readRoster = async () => {
    const h = F.parseShowObject((await showBlocks([`show object ${guildId}`]))[0]);
    return h.members ? F.memberEntries((await showBlocks([`show list ${h.members}`]))[0]) : [];
  };
  const titleRscs = Object.fromEntries(F.TITLE_PROPS.map(p => [p, rsc[p]]).filter(([, v]) => v != null));
  const setup = F.guildSetupCmds({ guildId, guild: g, members, current: await readRoster(), titleRscs, others, setTitles: made });
  if (setup.cmds.length) await dm(setup.cmds, 60000);
  const roster = new Map((await readRoster()).map(m => [m.id, m.rank]));
  const wrong = members.filter(m => roster.get(m.id) !== m.rank);
  let hallNote = 'no hall room';
  if (g.hall_room != null) {
    const hallId = returnedObject(await dm([`send object 0 FindRoomByNum num INT ${g.hall_room}`]));
    let hall = hallId == null ? null : F.parseShowObject((await showBlocks([`show object ${hallId}`]))[0]);
    if (!hall) hallNote = `no room ${g.hall_room} on the lab`;
    else if (hall.guildOwner === guildId) hallNote = `hall ${g.hall_room} ours`;
    else if (hall.guildOwner != null) hallNote = `hall ${g.hall_room} owned by another guild — NOT taken`;
    else if (rsc.password != null) {
      await dm([F.hallClaimCmd({ hallId, guildId, repId: master.id, passwordRsc: rsc.password })], 30000);
      hall = F.parseShowObject((await showBlocks([`show object ${hallId}`]))[0]);
      hallNote = hall.guildOwner === guildId ? `hall ${g.hall_room} CLAIMED` : `hall ${g.hall_room} claim refused`;
    }
    if (hall?.guildOwner === guildId) {
      for (const dir of new Set([HALLSECRET_DIR, dirname(ROSTER)]))
        try { setHallPassword(FLEET, g.hall_password ?? 'shadow', { dir, room: g.hall_room }); } catch { /* reported by verify */ }
      if (g.chests?.length && hall.active) {
        const placed = F.placedEntries((await showBlocks([`show list ${hall.active}`]))[0]);
        const classes = new Map((await showBlocks(placed.map(p => `show object ${p.id}`))).map((b, i) => [placed[i].id, F.parseShowObject(b).class]));
        const { chests } = F.matchChests(g.chests, placed, id => classes.get(id));
        const have = await readHoldings(chests.map(c => c.id));
        const chestGhosts = phantomCmds(have);
        if (chestGhosts.length) await dm(chestGhosts);
        const index = F.defaultIndex();
        const plans = chests.map((c, i) => ({ c, plan: F.planHoldings({ want: F.wantedHoldings(c.items, [], index).want, have: have[i].items, wearable: false }) }));
        const creates = plans.flatMap(p => F.createCmds(p.plan));
        const created = creates.length ? F.createdObjects(await dm(creates)) : [];
        if (created.length === creates.length) {
          let k = 0;
          const cmds = plans.flatMap(p => F.holdingCmds(p.plan, { holder: p.c.id, created: created.slice(k, k += p.plan.create.length), trim: TRIM }));
          if (cmds.length) await dm(cmds);
          hallNote += `, ${chests.length} chest(s) filled (${creates.length} created)`;
        } else hallNote += `, chests NOT filled (created ${created.length} of ${creates.length})`;
      }
    }
  }
  say(`    guild "${g.name}" ${made ? 'FOUNDED' : 'reused'}: ${members.length - wrong.length} of ${members.length} at prod's rank; ${hallNote}` +
      (missing.length ? `; not mirrored: ${missing.map(m => m.prod_character).join(', ')}` : ''));
  return { ok: !wrong.length, members: members.length, wrong: wrong.map(m => m.shadow), hall: hallNote };
}

async function dressPositions(chars) {
  const rooms = [...new Set(chars.map(c => c.room).filter(Boolean))];
  const found = await showBlocks(rooms.map(r => `send object 0 FindRoomByNum num INT ${r}`));
  const onLab = new Set(rooms.filter((r, i) => returnedObject(found[i]) != null));
  const placeable = chars.filter(c => onLab.has(c.room) && Number.isInteger(c.row) && Number.isInteger(c.col));
  const skipped = chars.filter(c => !placeable.includes(c)).map(c => `${c.shadow_name}${c.room ? ` (room ${c.room} not on the lab)` : ''}`);
  try {
    const r = await F.mirrorShadowLoginPositions(placeable, { apply: true, resolve: resolveNames, dm: cmds => dm(cmds) });
    say(`    login pose: ${r.verified} set and read back${skipped.length ? `; left where they were: ${skipped.join(', ')}` : ''}`);
    return { ok: true, ...r, skipped };
  } catch (e) { say(`    login pose: ${e.message}`); return { ok: false, error: e.message, skipped }; }
}

// ------------------------------------------------------------------ credentials vs the lab
//
// A ROSTER PASSWORD THE LAB DOES NOT HOLD LOOKS LIKE A SLOW LOGIN. The keeper retries "wrong
// username or password" for ever and the fleet waits for it. Found 2026-10-29: seven shadow
// slots carried passwords a later rebuild wrote over the roster without ever reaching the lab
// (an account that "already exists" keeps its old password), and a cold clone sat three
// minutes waiting for them. blakserv saves each account's MD5 in savegame/accounts.<time>
// (as of its last save), so the check is a file read on the LAB's own save — never prod's.
const LAB_ROOT = resolvePath(arg('--lab-root', process.env.M59_LAB_ROOT || 'C:/tmp/m59-control-server'));
export function credentialMismatches(roster, accountsText) {
  const stored = new Map([...String(accountsText ?? '').matchAll(/^ACCOUNT \d+:([^:]+):([0-9a-fA-F]{32}):/gm)]
    .map(m => [m[1], m[2].toLowerCase()]));
  const out = [];
  for (const [agent, v] of Object.entries(roster ?? {})) {
    const c = v?.credentials;
    if (!c?.account || !stored.has(c.account)) continue;      // not saved yet: cannot say
    if (createHash('md5').update(String(c.password ?? '')).digest('hex') !== stored.get(c.account)) out.push(agent);
  }
  return out;
}
function labCredentialCheck() {
  const dir = join(LAB_ROOT, 'run', 'server', 'savegame');
  try {
    const latest = readdirSync(dir).filter(f => /^accounts\.\d+$/.test(f)).sort((a, b) => Number(b.split('.')[1]) - Number(a.split('.')[1]))[0];
    if (!latest) return null;
    return credentialMismatches(readJson(ROSTER), readFileSync(join(dir, latest), 'utf8'));
  } catch { return null; }
}

// ------------------------------------------------------------------ one fixed password
//
// SHADOW ACCOUNTS ARE TEMPORARY TEST ACCOUNTS, AND ALL OF THEM USE ONE PASSWORD. Operator,
// 2026-10-29: "the shadow fleet should all just have a fixed password of 'shadow' — they're
// temporary testing accounts." Random per-account passwords bought nothing on a loopback lab and
// cost the seven slots whose roster copy drifted from the server's. `set account password <id>`
// works — it takes the numeric account id, never the name (adminfn.c:2882), which is likely why
// an earlier note said it did not.
//
// A running keeper holds its password in memory, so the switch is made with the shadow broker
// DOWN: once, on the first clone that finds a slot off the fixed password, which therefore takes
// the cold path. `save game` follows so the lab's account file (labCredentialCheck) agrees.
export const SHADOW_PASSWORD = 'shadow';
export function passwordSlotsToFix(roster, accountsText = '') {
  const want = createHash('md5').update(SHADOW_PASSWORD).digest('hex');
  const stored = new Map([...String(accountsText).matchAll(/^ACCOUNT \d+:([^:]+):([0-9a-fA-F]{32}):/gm)]
    .map(m => [m[1], m[2].toLowerCase()]));
  return Object.entries(roster ?? {}).filter(([, v]) => {
    const c = v?.credentials;
    if (!c?.account) return false;
    return c.password !== SHADOW_PASSWORD || (stored.has(c.account) && stored.get(c.account) !== want);
  }).map(([agent]) => agent);
}
const latestAccountsText = () => {
  const dir = join(LAB_ROOT, 'run', 'server', 'savegame');
  try {
    const latest = readdirSync(dir).filter(f => /^accounts\.\d+$/.test(f)).sort((a, b) => Number(b.split('.')[1]) - Number(a.split('.')[1]))[0];
    return latest ? readFileSync(join(dir, latest), 'utf8') : '';
  } catch { return ''; }
};

async function fixPasswords(agents) {
  const roster = readJson(ROSTER);
  const accounts = agents.map(a => roster[a]?.credentials?.account).filter(Boolean);
  const shows = await showBlocks(accounts.map(a => `show account ${a}`));
  const ids = accounts.map((a, i) => Number(new RegExp(`^\\s*(\\d+)\\s+${a}\\b`, 'm').exec(shows[i] ?? '')?.[1]) || null);
  const set = accounts.map((a, i) => ids[i] ? `set account password ${ids[i]} ${SHADOW_PASSWORD}` : null).filter(Boolean);
  const out = set.length ? await dm(set) : '';
  const done = (String(out).match(/Set password for account/g) ?? []).length;
  if (done !== set.length || set.length !== accounts.length)
    throw new Error(`set the fixed password on ${done} of ${accounts.length} shadow account(s) — roster NOT rewritten`);
  return done;
}

// ------------------------------------------------------------------ prod's orders
//
// A CLONE STARTS WITH ITS ORIGINAL'S ORDERS. Operator, 2026-10-29: copy prod's orders
// "initially" — the clone is where a change to them is tried, so it has to start from them.
// Orders are the roster's `autopilot` block (mode + policy) and the character's loadout file.
// Anything in them that names a prod agent or character (a buddy, a partner, a courier's
// customer) is rewritten to that character's clone, exactly — a whole string or nothing — so a
// clone never orders a prod character about.
export function translateOrders(value, names) {
  if (typeof value === 'string') return names.has(value) ? names.get(value) : value;
  if (Array.isArray(value)) return value.map(v => translateOrders(v, names));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [names.has(k) ? names.get(k) : k, translateOrders(v, names)]));
  return value;
}
const nameMap = chars => new Map(chars.flatMap(c => [[c.prod_agent, c.shadow_account], [c.prod_character, c.shadow_name]]));

function prodOrders(chars) {
  const prod = readJson(join(PROD_ROOT, 'substrate', 'fleets', 'prod.json'), {});
  const names = nameMap(chars);
  return new Map(chars.filter(c => prod[c.prod_agent]?.autopilot)
    .map(c => [c.shadow_account, translateOrders(structuredClone(prod[c.prod_agent].autopilot), names)]));
}

// Loadouts live in the shared machine-local substrate/loadouts/, one file per character slug
// (m59-loadout.mjs loadoutPath). The clone's file is its original's, translated; a clone whose
// original has none has its own removed, because silence is the original's order too.
function copyLoadouts(chars) {
  const dir = join(PROD_ROOT, 'substrate', 'loadouts');
  const slug = s => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  const names = nameMap(chars);
  let copied = 0, cleared = 0;
  for (const c of chars) {
    const src = join(dir, `${slug(c.prod_character)}.json`), dst = join(dir, `${slug(c.shadow_name)}.json`);
    const from = readJson(src);
    if (from) { writeFileSync(dst, JSON.stringify(translateOrders(from, names), null, 2)); copied++; }
    else if (existsSync(dst)) { rmSync(dst); cleared++; }
  }
  return { copied, cleared };
}

// ------------------------------------------------------------------ keepers (shadow band only)
// EVERY KEEPER, IN THE WORLD OR NOT. discoverKeeperStates answers only for keepers that are in
// game — right for reading state, wrong here: a keeper that is out is exactly the one that most
// needs its /join, and skipping it left 13 of 17 bodies logged out after a clone. Identity is
// still proved: the agent must be one we asked for AND wear the character the shadow roster
// names for it, and an agent answering on two ports is dropped rather than guessed between.
async function shadowKeepers(agents) {
  const band = resolveKeeperBand(FLEET, { registryPath: BANDS, missing: 'null' });
  if (!band) return new Map();
  const roster = readJson(ROSTER, {});
  const want = new Set(agents), seen = new Map(), dup = new Set();
  await Promise.all(keeperBandPorts(band).map(async port => {
    try {
      const s = await (await fetch(`http://127.0.0.1:${port}/live`, { signal: AbortSignal.timeout(1500) })).json();
      if (!want.has(s?.agent) || !(Number(s.pid) > 0) || s.character !== roster[s.agent]?.credentials?.character) return;
      if (seen.has(s.agent)) dup.add(s.agent);
      else seen.set(s.agent, { port, agent: s.agent, character: s.character, pid: Number(s.pid), policyReplace: s.policy_replace === 1 });
    } catch { /* nothing on that port */ }
  }));
  for (const a of dup) seen.delete(a);
  return seen;
}

async function keeperPost(identity, path, timeoutMs = 30000) {
  try {
    const r = await fetch(`http://127.0.0.1:${identity.port}${path}`, {
      method: 'POST', headers: { ...keeperIdentityHeaders(identity), 'content-type': 'application/json' },
      body: JSON.stringify({ agent: identity.agent }), signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function waitFor(pred, { timeoutMs, everyMs = 150 }) {
  const until = Date.now() + timeoutMs;
  for (;;) { const v = await pred(); if (v || Date.now() >= until) return v; await new Promise(r => setTimeout(r, everyMs)); }
}

const brokerHealth = async () => {
  try { return await (await fetch(`http://127.0.0.1:${HTTP_PORT}/health`, { signal: AbortSignal.timeout(20000) })).json(); }
  catch { return null; }
};

function stopBroker() {
  // BOTH PORTS, always: `stop` quiesces through the dashboard port, and its default is prod's.
  return new Promise(res => {
    const child = spawn(process.execPath, [join(PROD_ROOT, 'tools', 'm59-service.mjs'), 'stop', '--fleet', FLEET,
      '--http', String(HTTP_PORT), '--dashboard', String(DASH_PORT), '--force'], {
      cwd: PROD_ROOT, windowsHide: true, env: { ...process.env, M59_STATE_FILE: ROSTER, M59_FLEET: FLEET } });
    let out = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    child.on('close', code => res({ code, out }));
  });
}

function startBroker() {
  // From the PROD checkout, so the shadow keepers run the code prod's keepers run — a clone
  // that fails because the lab is on a newer mover is not a finding about prod.
  return new Promise(res => {
    const child = spawn(process.execPath, [join(PROD_ROOT, 'tools', 'm59-service.mjs'), 'start', '--fleet', FLEET,
      '--http', String(HTTP_PORT), '--dashboard', String(DASH_PORT)], {
      cwd: PROD_ROOT, windowsHide: true,
      env: { ...process.env, M59_STATE_FILE: ROSTER, M59_HOST: GAME_HOST, M59_PORT: String(GAME_PORT),
             M59_FLEET: FLEET, M59_KEEPER_CONCURRENCY: process.env.M59_KEEPER_CONCURRENCY || '24' },
    });
    let out = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    child.on('close', code => res({ code, out }));
  });
}

// ------------------------------------------------------------------ the whole clone
async function dress(snap, report) {
  const chars = snap.characters.filter(c => !c.stale || has('--include-stale'));
  const names = chars.map(c => c.shadow_name);
  const ids = await timed('resolve', () => resolveNames(names));
  const absent = chars.filter(c => ids[c.shadow_name] == null);
  if (absent.length) say(`  NOT ON THE LAB (make once with m59-shadow-run.mjs --until build): ` +
                         absent.map(c => `${c.shadow_name} <- ${c.prod_character}`).join(', '));
  const here = chars.filter(c => ids[c.shadow_name] != null);
  report.absent = absent.map(c => c.shadow_name);
  if (!here.length) throw new Error('no shadow body on the lab to dress');

  // Who is online right now decides the path.
  const agents = here.map(c => c.shadow_account);
  const health = await brokerHealth();
  // A broker is ours when its roster FILE is ours, never because its label matches (CLAUDE.md,
  // "Which fleet"): two checkouts can both hold a fleet called shadow.
  let brokerOurs = !!health && health.fleet === FLEET && samePath(health.state, ROSTER);
  if (health && !brokerOurs) throw new Error(`:${HTTP_PORT} is held by "${health.fleet}" — refusing to start a second broker or drive its keepers`);

  // THE FIXED PASSWORD, ONCE. See SHADOW_PASSWORD: running keepers hold the old one, so the
  // broker goes down first and this clone takes the cold path.
  const toFix = passwordSlotsToFix(readJson(ROSTER, {}), latestAccountsText());
  if (toFix.length && !DRY) {
    await timed('password', async () => {
      if (brokerOurs) {
        say(`    ${toFix.length} slot(s) not on the fixed password — stopping the shadow broker to switch them`);
        const r = await stopBroker();
        if (r.code !== 0) throw new Error(`could not stop the shadow broker: ${r.out.trim().split('\n').pop()}`);
        brokerOurs = false;
      }
      const n = await fixPasswords(toFix);
      const roster = readJson(ROSTER);
      const backup = `${ROSTER}.before-fixed-password`;
      if (!existsSync(backup)) copyFileSync(ROSTER, backup);
      for (const a of toFix) roster[a].credentials.password = SHADOW_PASSWORD;
      writeFileSync(ROSTER, JSON.stringify(roster, null, 2));
      await dm(['save game'], 30000);
      say(`    fixed password set on ${n} account(s) and in the roster (backup ${backup})`);
    });
  }
  const badPassword = labCredentialCheck() ?? [];
  report.bad_password = badPassword;
  const loginable = here.filter(c => !badPassword.includes(c.shadow_account));

  // PROD'S ORDERS, unless asked not to. Loadout files now; the autopilot block goes into the
  // roster before a cold start, or to each keeper (replace) while it is out on a hot one.
  const orders = has('--keep-orders') || DRY ? new Map() : prodOrders(here);
  if (orders.size) {
    const l = copyLoadouts(here);
    say(`  orders: prod's mode and policy for ${orders.size} clone(s); loadouts ${l.copied} copied, ${l.cleared} cleared`);
    report.orders = { copied: orders.size, loadouts: l };
  }
  const keepers = brokerOurs ? await shadowKeepers(agents) : new Map();
  report.path = keepers.size ? 'hot (keepers cycled)' : 'cold (broker started)';
  say(`  path: ${report.path}`);
  if (badPassword.length) say(`  ROSTER PASSWORD DOES NOT MATCH THE LAB for ${badPassword.join(', ')} — dressed, but cannot log in`);

  if (keepers.size) {
    await timed('logout', async () => {
      // NO LOGOFF GHOST. A body that logs off outside an inn leaves a ghost for minutes and logs
      // back in where the ghost is; piLogoffPenaltyCount < 0 skips the ghost for this one logoff
      // and UserLogoff resets it to 0 (user.kod:664-706), so nothing is left changed.
      await dm(here.map(c => setProp(ids[c.shadow_name], 'piLogoffPenaltyCount', -1)));
      const left = await Promise.all([...keepers.values()].map(id => keeperPost(id, '/leave')));
      const refused = left.filter(r => !r.ok);
      if (refused.length) say(`    ${refused.length} keeper(s) refused /leave: ${refused.map(r => r.error ?? r.status).slice(0, 3).join(', ')}`);
      // AND HANG THEM UP SERVER-SIDE. /leave stops the keeper wanting to be in, but a keeper
      // built before M59Client.close() existed never actually drops its socket (see that
      // method). The server's own hangup closes the session whichever code the keeper runs,
      // and with /leave already taken it does not come back.
      //
      // A HANGUP ALSO BLOCKS THE CALLER'S IP for SOCKET_BLOCK_TIME, five minutes by default
      // (adminfn.c:4200) — and every keeper and every client here is 127.0.0.1, so the whole lab
      // went dark for five minutes the first time ("Blocked connection from 127.0.0.1").
      // `hangup ip` is a TOGGLE (adminfn.c:4214): it lifts an existing block, and ADDS a
      // permanent one when there is none. So it is sent only when a hangup is known to have
      // landed, which is exactly when the block exists.
      const hung = await dm(here.map(c => `hangup user ${c.shadow_name}`));
      if (/has been disconnected/.test(hung)) await dm(['hangup ip 127.0.0.1']);
      const reads = here.map(c => `show object ${ids[c.shadow_name]}`);
      const off = await waitFor(async () => !(await showBlocks(reads)).some(loggedOn), { timeoutMs: 15000 });
      if (!off) say('    WARNING: some bodies still logged on after 15s — they are dressed online');
      // Orders go in while each keeper is out, so the join builds its autopilot from them.
      if (orders.size) {
        const pushed = await Promise.all([...keepers.values()].filter(id => orders.has(id.agent)).map(id => {
          const o = orders.get(id.agent);
          return fetch(`http://127.0.0.1:${id.port}/policy`, { method: 'POST',
            headers: { ...keeperIdentityHeaders(id), 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
            body: JSON.stringify({ agent: id.agent, ...(o.policy ?? {}), ...(o.mode ? { mode: o.mode } : {}),
                                   ...(id.policyReplace ? { replace: true } : {}), by: 'm59-shadow-clone (prod orders)' }) })
            .then(r => ({ id, ok: r.ok }), e => ({ id, ok: false, error: e.message }));
        }));
        const merged = pushed.filter(p => p.ok && !p.id.policyReplace).map(p => p.id.agent);
        const failed = pushed.filter(p => !p.ok).map(p => p.id.agent);
        if (merged.length) say(`    orders MERGED, not replaced, on ${merged.length} older keeper(s) — restart the shadow fleet for exact orders`);
        if (failed.length) say(`    orders NOT pushed to ${failed.join(', ')}`);
        report.orders.merged_only = merged; report.orders.failed = failed;
      }
    });
  } else if (orders.size) {
    // Cold: the broker reads its orders from the roster, so they are written there first.
    const roster = readJson(ROSTER);
    for (const [agent, o] of orders) if (roster[agent]) roster[agent].autopilot = o;
    writeFileSync(ROSTER, JSON.stringify(roster, null, 2));
  }

  report.body = await timed('stats+faction', () => dressBodies(here, ids));
  report.abilities = await timed('abilities', () => dressAbilities(here));
  report.items = await timed('items', () => dressItems(here, ids));
  // Before the pose: a guild hall sends non-members to its foyer on entry.
  report.guild = has('--no-guild') ? { skipped: true } : await timed('guild', () => mirrorGuild(snap, ids));
  report.position = await timed('pose', () => dressPositions(here));

  if (has('--no-login')) return;
  if (keepers.size) {
    await timed('login', async () => {
      // STAGGERED, BECAUSE blakserv LISTENS WITH A BACKLOG OF FIVE (async.c:143). Twenty-four
      // connects in the same millisecond overflow it and Windows answers the rest with
      // ECONNREFUSED from a server that is perfectly up — or they sit unaccepted until the
      // keeper's 15 s login wait gives up. Starting one every 60 ms keeps the queue short and
      // costs ~1.5 s across the fleet; a join that still fails, other than on its password,
      // is asked again.
      const wanted = [...keepers.values()].filter(id => !badPassword.includes(id.agent));
      const joinAll = async ids => Promise.all(ids.map((id, i) =>
        new Promise(r => setTimeout(r, i * 60)).then(() => keeperPost(id, '/join', 60000).then(r => ({ id, ...r })))));
      let results = await joinAll(wanted);
      for (let round = 0; round < 2; round++) {
        const retry = results.filter(r => !r.ok && !/password/i.test(r.body?.error ?? r.error ?? ''));
        if (!retry.length) break;
        await new Promise(r => setTimeout(r, 500));
        const again = await joinAll(retry.map(r => r.id));
        results = results.map(r => again.find(a => a.id.agent === r.id.agent) ?? r);
      }
      const bad = results.filter(r => !r.ok);
      if (bad.length) say(`    ${bad.length} keeper(s) did not rejoin: ` +
        bad.map(r => `${r.id.agent} (${r.body?.error ?? r.error ?? r.status})`).slice(0, 6).join('; '));
      report.in_game = results.length - bad.length;
    });
  } else {
    await timed('broker+login', async () => {
      const r = await startBroker();
      if (r.code !== 0) { say(r.out.trim().split('\n').slice(-5).join('\n')); throw new Error('shadow broker did not start'); }
      const ok = await waitFor(async () => {
        const h = await brokerHealth();
        report.in_game = Object.values(h?.session_characters ?? {}).filter(Boolean).length;
        return report.in_game >= loginable.length;
      }, { timeoutMs: 180000, everyMs: 500 });
      if (!ok) say(`    ${report.in_game} of ${loginable.length} in game when the wait ran out`);
    });
  }
}

async function main() {
  // BELOW NORMAL, AND EVERYTHING THIS STARTS INHERITS IT. A cold clone spawns 24 keeper
  // processes at once on the machine prod's broker lives on, and offline load on these cores
  // has frozen that broker for 188 s before. The lab can wait; prod cannot.
  try { setPriority(0, OS.priority.PRIORITY_BELOW_NORMAL); } catch { /* not fatal */ }
  const cmd = ['export', 'dress'].includes(argv[0]) ? argv[0] : 'all';
  const problems = refusals({ fleet: FLEET, gameHost: GAME_HOST, gamePort: GAME_PORT, adminHost: ADMIN_HOST, roster: ROSTER, httpPort: HTTP_PORT });
  if (problems.length) { for (const p of problems) console.error(p); process.exit(2); }
  const t0 = Date.now();
  const report = { fleet: FLEET, roster: ROSTER, snapshot: SNAPSHOT, prod_root: PROD_ROOT };
  say(`shadow clone: prod caches in ${PROD_ROOT} -> fleet "${FLEET}" on ${GAME_HOST}:${GAME_PORT}${DRY ? ' (DRY)' : ''}`);
  let ok = true;
  try {
    const snap = cmd === 'dress' ? readJson(SNAPSHOT) : await timed('export', exportProd);
    if (!snap?.characters?.length) throw new Error(`no snapshot at ${SNAPSHOT}`);
    report.characters = snap.characters.length;
    if (cmd !== 'export' && !DRY) await dress(snap, report);
    ok = !report.absent?.length && !report.bad_password?.length && report.items?.ok !== false && report.abilities?.ok !== false && report.position?.ok !== false;
  } catch (e) { ok = false; report.error = e.message; console.error(`FAILED: ${e.message}`); }
  report.ok = ok; report.timings_ms = timings; report.total_ms = Date.now() - t0;
  say(`\n${ok ? 'cloned' : 'cloned WITH PROBLEMS (above)'} in ${(report.total_ms / 1000).toFixed(1)}s` +
      (report.in_game != null ? ` — ${report.in_game} in game` : ''));
  if (has('--json')) console.log(JSON.stringify(report));
  process.exit(ok ? 0 : 1);
}

if (import.meta.filename === process.argv[1]) main();
