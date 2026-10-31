#!/usr/bin/env node
// WHO CAN LEARN THIS SPELL OR SKILL NOW, HOW FAR IS EVERYONE ELSE, AND WHEN WILL THEY GET THERE.
//
//   node tools/m59-learners.mjs archery                               # spell or skill, from the catalogue
//   node tools/m59-learners.mjs --skill archery --agents t18,t20      # just these
//   node tools/m59-learners.mjs --spell "enchant weapon" --room-policy 2,599 --exclude hk1,hk2,hk3
//   node tools/m59-learners.mjs archery --window 48 --margin 5        # rate over 48h, ETA to +5
//   ... --buy --teacher "Priestess Qerti'nya" --teacher-room 801 --price 1000 --home 2
//
// Was m59-spell-learners.mjs, which hardcoded `kind: 'spells'` and so answered "no catalogue row
// for archery" to the operator's question, 2026-10-31: "Is anyone in this production fleet
// eligible to get the skill archery yet?". That name is now a shim over this file.
//
// The answer is PlayerCanLearn (player.kod:10509), and it already has one home:
// compendium/tools/learn.mjs, re-exported by m59-loadout.mjs. This reads each character's live
// abilities and intellect from the broker and asks that function; it computes nothing itself.
// Skills and spells go through the same arithmetic — weaponcraft is school 10 to it.
//
// `short` is the combined ability percentage still missing among the best three abilities one
// level below in the same school — for archery (weaponcraft 5), the best three of fire, parry,
// second wind and scimitar wielding. It is a threshold, not points spent. Intellect lowers the
// bar (2*POINTS_SLOPE/5 per point), so the lowest-int characters are the furthest away.
//
// THE ESTIMATE. `have` is replayed backwards through the character's ability book
// (substrate/abilities/<character>.json, every pushed advancement) to what it was `--window`
// hours ago, and the difference is the rate. Replaying `have` rather than summing gains matters:
// a point in the FOURTH-best ability moves nothing until it overtakes the third. The book keeps
// only its last MAX_HISTORY changes, so a busy character's window is cut to its oldest row and
// the column says so. `eta` is short/rate; `eta+M` is (short+margin)/rate.
//
// RAW INTELLECT, NOT THE STATUS NUMBER. PlayerCanLearn reads GetRawIntellect (player.kod:10839),
// piIntellect alone; the status bar shows GetIntellect, which adds piIntellectMod. The Princess'
// army shield writes into that mod — +3 intellect at ranks 3-6, +5 at 7-10 (prinshld.kod
// UpdateRankPowers) — so for her soldiers the status number lowers the bar the game does not
// lower. That was the "optimism" once covered by a 16-point margin: Waldorf (a supreme hero, +5,
// 14 points of need) refused at 190 and sold at 200 against a predicted 184; Scooter (an average
// soldier, +3) refused at +4. The Duke's and rebel shields add agility/stamina and might/aim and
// leave this alone. So the bonus is taken back out, by rank from the shield-ranker's book
// (substrate/shield-ranker-<fleet>.json) or +5 when the rank is unknown, and the margin is 0.
//
// --buy runs the public `learn-skill` fleetscript for each character that can learn it and does
// not know it yet, one at a time (one driver per fleet). It does not fund anybody: a purse under
// --price is reported and skipped, because moving money is a decision and this is a report.
import process from 'node:process';
import { RemainingRequiredToLearnNewSkills, learningConstants } from './m59-loadout.mjs';
import { loadBook, MAX_HISTORY } from './m59-abilities.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Planner catalogue rows (spells and skills with school and level), from compendium/data/planner.json. */
export function plannerCatalogue(repo = REPO) {
  const j = JSON.parse(fs.readFileSync(path.join(repo, 'compendium', 'data', 'planner.json'), 'utf8'));
  return [...(j.spells ?? []).map(s => ({ ...s, kind: 'spell' })), ...(j.skills ?? []).map(s => ({ ...s, kind: 'skill' }))];
}

/** 'spells' | 'skills' for a name, from the catalogue; null when it is neither, or ambiguous. */
export function kindOf(catalogue, name) {
  const kinds = new Set(catalogue.filter(r => norm(r.name) === norm(name)).map(r => r.kind));
  return kinds.size === 1 ? (kinds.has('skill') ? 'skills' : 'spells') : null;
}

const knownOf = abilities => [...(abilities?.spells ?? []).map(s => ({ ...s, kind: 'spell' })),
                              ...(abilities?.skills ?? []).map(s => ({ ...s, kind: 'skill' }))];

/** One character's standing against one spell or skill. Pure: `abilities` is the broker's abilities reply.
 *  `spell` is the old name of `name`; `kind` is resolved from the catalogue when omitted. */
export function standing({ abilities, intellect, name, spell, kind, catalogue, constants }) {
  const want = name ?? spell;
  const k = kind ?? kindOf(catalogue, want);
  const r = RemainingRequiredToLearnNewSkills({ known: knownOf(abilities), catalogue, intellect, constants,
                                                kind: k ?? 'both', name: want });
  const c = r.candidates?.[0] ?? null;
  return {
    kind: k,
    known: !!c?.already_known,
    can: c ? c.can_learn : null,
    short: c?.remaining_required ?? null,
    need: c?.need ?? null, have: c?.have ?? null,
    below: (c?.previous_level_best_three ?? []).map(x => `${x.name} ${x.ability}`).join(', '),
    why: c ? null : `no catalogue row for "${want}"`,
  };
}

/** What the abilities were at `since`, replaying the book's history backwards from `abilities`. */
export function abilitiesAt(abilities, history, since) {
  const back = new Map();
  for (const h of history ?? []) {
    if (!(h?.at > since) || !h.name || !Number.isFinite(h.by)) continue;
    const key = `${h.kind === 'skill' ? 'skills' : 'spells'}:${norm(h.name)}`;
    back.set(key, (back.get(key) ?? 0) + h.by);
  }
  const rewind = kind => (abilities?.[kind] ?? []).map(s => {
    const by = back.get(`${kind}:${norm(s.name)}`) ?? 0;
    return by ? { ...s, ability: Math.max(0, (Number(s.ability) || 0) - by) } : s;
  });
  return { ...abilities, spells: rewind('spells'), skills: rewind('skills') };
}

/** The intellect PlayerCanLearn reads: status intellect less the Princess shield's rank bonus.
 *  `princessRank` null with the shield on assumes the highest bonus. */
export function rawIntellect({ intellect, equipment = [], princessRank = null }) {
  const n = Number(intellect) || 0;
  if (!(equipment ?? []).some(e => /shield of the princess/i.test(typeof e === 'string' ? e : e?.name ?? ''))) return n;
  const r = Number(princessRank);
  const bonus = !Number.isFinite(r) || princessRank == null ? 5 : r <= 2 ? 0 : r <= 6 ? 3 : 5;
  return Math.max(1, n - bonus);
}

/** How fast `have` is moving, and when `short` (and short + margin) closes. Pure. */
export function trend({ abilities, intellect, name, kind, catalogue, constants, history = [],
                        now = Date.now(), windowMs = 24 * 3600_000, margin = 0, maxHistory = MAX_HISTORY }) {
  const nowS = standing({ abilities, intellect, name, kind, catalogue, constants });
  if (nowS.known || nowS.have == null) return { ...nowS, rate: null, hours: null, eta: null, eta_margin: null };
  let since = now - windowMs, truncated = false;
  const rows = (history ?? []).filter(h => h?.at);
  // A full book has forgotten what came before its oldest row; that row is as far back as we can see.
  if (rows.length >= maxHistory) {
    const oldest = Math.min(...rows.map(h => h.at));
    if (oldest > since) { since = oldest - 1; truncated = true; }   // -1: the oldest change itself is inside
  }
  const then = standing({ abilities: abilitiesAt(abilities, rows, since), intellect, name, kind, catalogue, constants });
  const hours = (now - since) / 3600_000;
  const rate = hours > 0 ? (nowS.have - then.have) / hours : null;
  const eta = gap => gap <= 0 ? 0 : rate > 0 ? gap / rate : null;
  return { ...nowS, have_then: then.have, hours, truncated, rate,
           eta: eta(nowS.short ?? 0), eta_margin: eta((nowS.need ?? 0) + margin - nowS.have) };
}

const fmtH = h => h == null ? '—' : h === 0 ? 'now' : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;

export async function main(argv = process.argv.slice(2)) {
  const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const list = s => String(s ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const valued = new Set(['spell', 'skill', 'learn', 'agents', 'exclude', 'room-policy', 'broker', 'window', 'margin', 'ranks', 'fleet',
                          'teacher', 'teacher-room', 'price', 'home']);
  const bare = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && valued.has(argv[i - 1].slice(2))));
  const NAME = arg('skill') || arg('spell') || arg('learn') || bare[0] ||
    (console.error('name a spell or skill: m59-learners.mjs "<name>"  (or --spell / --skill)'), process.exit(2));
  const catalogue = plannerCatalogue();
  const KIND = arg('skill') ? 'skills' : arg('spell') ? 'spells' : kindOf(catalogue, NAME);
  if (!KIND) { console.error(`"${NAME}" is not one spell or one skill in compendium/data/planner.json`); process.exit(2); }
  const windowMs = Number(arg('window', 24)) * 3600_000, margin = Number(arg('margin', 0));
  const fleetName = arg('fleet') || process.env.M59_FLEET || null;
  const ranksFile = arg('ranks') || (fleetName ? path.join(REPO, 'substrate', `shield-ranker-${fleetName}.json`) : null);
  let ranks = {};
  try { ranks = ranksFile ? JSON.parse(fs.readFileSync(ranksFile, 'utf8')).units ?? {} : {}; } catch { ranks = {}; }
  const BROKER = `http://127.0.0.1:${Number(arg('broker') || 8901)}/`;
  const call = async (tool, args, ms = 120_000) => {
    const r = await fetch(BROKER, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
      signal: AbortSignal.timeout(ms) });
    const t = (await r.json())?.result?.content?.[0]?.text;
    if (typeof t !== 'string' || t.startsWith('error:')) throw new Error(t ?? 'no answer');
    return JSON.parse(t);
  };
  // A busy keeper drops the odd read; one dropped read used to abort the whole report.
  const retry = async (tool, args) => {
    for (let i = 0; ; i++) {
      try { return await call(tool, args); }
      catch (e) { if (i >= 3) throw e; await new Promise(r => setTimeout(r, 3000)); }
    }
  };
  const constants = learningConstants();
  const fleet = (await call('fleet', {})).fleet ?? [];
  const only = list(arg('agents')), exclude = list(arg('exclude')), rooms = list(arg('room-policy')).map(Number);
  const rows = fleet.filter(r => r.in_game !== false && (!only.length || only.includes(r.agent)) &&
    !exclude.includes(r.agent) && (!rooms.length || rooms.includes(r.policy?.assignedRoom)));
  const out = [];
  for (const r of rows) {
    try {
      const [ab, st] = await Promise.all([retry('abilities', { agent: r.agent }), retry('status', { agent: r.agent })]);
      const shown = Number(st?.attributes?.intellect?.value) || 0;
      const intellect = rawIntellect({ intellect: shown, equipment: st?.equipment, princessRank: ranks[r.agent]?.rank?.max ?? null });
      out.push({ agent: r.agent, name: r.character, intellect, shown, purse: Number(r.purse) || 0, room: r.room_num,
        ...trend({ abilities: ab, intellect, name: NAME, kind: KIND, catalogue, constants,
                   history: loadBook(r.character).history, windowMs, margin }) });
    } catch (e) {
      out.push({ agent: r.agent, name: r.character, why: `unread: ${e.message}`.slice(0, 120) });
    }
  }
  out.sort((a, b) => Number(!!b.known) - Number(!!a.known) || Number(!!b.can) - Number(!!a.can) ||
    (a.short ?? 1e9) - (b.short ?? 1e9));
  console.log(`${NAME} (${KIND.slice(0, -1)}): who can learn it (PlayerCanLearn via compendium/tools/learn.mjs)`);
  console.log(`  rate = change in "have" over the last ${windowMs / 3600_000}h of each ability book; int is RAW (Princess shield bonus taken out)${margin ? `; eta+${margin} adds a margin` : ''}`);
  for (const x of out) {
    if (x.have == null && !x.known) { console.log(`  ${x.agent.padEnd(4)} ${String(x.name).slice(0, 12).padEnd(12)} ${x.why ?? 'no answer'}`); continue; }
    const state = x.known ? 'KNOWS IT' : x.can ? `CAN LEARN (have ${x.have} / need ${x.need})` : `short ${x.short} (have ${x.have} / need ${x.need})`;
    const pace = x.known ? '' : `  ${x.rate == null ? '' : `${x.rate >= 0 ? '+' : ''}${x.rate.toFixed(2)}/h over ${fmtH(x.hours)}${x.truncated ? '*' : ''}`}` +
      `  eta ${fmtH(x.eta)}${margin ? `  eta+${margin} ${fmtH(x.eta_margin)}` : ''}`;
    console.log(`  ${x.agent.padEnd(4)} ${String(x.name).slice(0, 12).padEnd(12)} int ${String(x.intellect).padStart(2)}${x.shown !== x.intellect ? ` (shown ${x.shown})` : ''} ${state}${pace}` +
      `  [${x.below}]  purse ${x.purse}${x.why ? ' — ' + x.why : ''}`);
  }
  if (out.some(x => x.truncated)) console.log(`  * the book holds only its last ${MAX_HISTORY} changes; the window was cut to the oldest`);

  if (argv.includes('--buy')) {
    const teacher = arg('teacher'), teacherRoom = Number(arg('teacher-room')), price = Number(arg('price')), home = Number(arg('home'));
    if (!teacher || !teacherRoom || !price || !home) { console.error('--buy needs --teacher --teacher-room --price --home'); process.exit(2); }
    const { loadFleetScripts, runNamed } = await import('./m59-fleetlib.mjs');
    const { fleetScript } = await import('./m59-fleetscript.mjs');
    const { scripts } = await loadFleetScripts();
    for (const x of out.filter(x => !x.known && x.can)) {
      if (x.purse < price) { console.log(`  ${x.agent}: purse ${x.purse} under ${price}, skipped (fund it first)`); continue; }
      console.log(`  ${x.agent}: buying ${NAME} from ${teacher} in ${teacherRoom}`);
      const r = await runNamed('learn-skill', { agents: x.agent, skill: NAME, teacher, teacherRoom, price, home },
        { scripts, fleetScript, onLog: (...a) => console.log('   ', ...a) }).catch(e => ({ ok: false, why: e.message }));
      console.log(`  ${x.agent}: ${JSON.stringify(r).slice(0, 300)}`);
    }
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) await main();
