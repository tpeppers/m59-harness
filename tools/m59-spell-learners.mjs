#!/usr/bin/env node
// WHO CAN LEARN THIS SPELL NOW, AND HOW FAR IS EVERYONE ELSE — then, optionally, send them to buy it.
//
//   node tools/m59-spell-learners.mjs --spell "enchant weapon"                 # every in-game character
//   node tools/m59-spell-learners.mjs --spell "enchant weapon" --agents t1,t10 # just these
//   node tools/m59-spell-learners.mjs --spell "enchant weapon" --room-policy 2,599 --exclude hk1,hk2,hk3
//   ... --buy --teacher "Priestess Qerti'nya" --teacher-room 801 --price 1000 --home 2
//
// Operator, 2026-09-28: "Can some of the lowest int troll hunters buy the enchant weapon spell for
// level 2 Kraanan" — and then "they can buy the other level 1 Kraanan skill relay and practice
// that too". The answer is PlayerCanLearn (player.kod:10509), and it already has one home:
// compendium/tools/learn.mjs, re-exported by m59-loadout.mjs. This reads each character's live
// abilities and intellect from the broker and asks that function; it computes nothing itself.
//
// `short` is the combined ability percentage still missing among the best three spells one level
// below in the same school — for enchant weapon, the Kraanan level-1 four (create weapon, create
// food, glow, relay). It is a threshold, not points spent: practising relay from 5 to 30 moves it
// by 25. Intellect lowers the bar (2*POINTS_SLOPE/5 per point), so the lowest-int hunters are the
// furthest away, not the nearest.
//
// --buy runs the public `learn-skill` fleetscript for each character that can learn it and does
// not know it yet, one at a time (one driver per fleet). It does not fund anybody: a purse under
// --price is reported and skipped, because moving money is a decision and this is a report.
import process from 'node:process';
import { RemainingRequiredToLearnNewSkills, learningConstants } from './m59-loadout.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Planner catalogue rows (spells and skills with school and level), from compendium/data/planner.json. */
export function plannerCatalogue(repo = REPO) {
  const j = JSON.parse(fs.readFileSync(path.join(repo, 'compendium', 'data', 'planner.json'), 'utf8'));
  return [...(j.spells ?? []).map(s => ({ ...s, kind: 'spell' })), ...(j.skills ?? []).map(s => ({ ...s, kind: 'skill' }))];
}

/** One character's standing against one spell. Pure: `abilities` is the broker's abilities reply. */
export function standing({ abilities, intellect, spell, catalogue, constants }) {
  const known = [...(abilities?.spells ?? []).map(s => ({ ...s, kind: 'spell' })),
                 ...(abilities?.skills ?? []).map(s => ({ ...s, kind: 'skill' }))];
  const r = RemainingRequiredToLearnNewSkills({ known, catalogue, intellect, constants, kind: 'spells', name: spell });
  const c = r.candidates?.[0] ?? null;
  return {
    known: !!c?.already_known,
    can: c ? c.can_learn : null,
    short: c?.remaining_required ?? null,
    need: c?.need ?? null, have: c?.have ?? null,
    below: (c?.previous_level_best_three ?? []).map(x => `${x.name} ${x.ability}`).join(', '),
    why: c ? null : `no catalogue row for "${spell}"`,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const list = s => String(s ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const SPELL = arg('spell') || (console.error('--spell "<name>" is required'), process.exit(2));
  const BROKER = `http://127.0.0.1:${Number(arg('broker') || 8901)}/`;
  const call = async (tool, args, ms = 120_000) => {
    const r = await fetch(BROKER, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
      signal: AbortSignal.timeout(ms) });
    const t = (await r.json())?.result?.content?.[0]?.text;
    if (typeof t !== 'string' || t.startsWith('error:')) throw new Error(t ?? 'no answer');
    return JSON.parse(t);
  };
  const catalogue = plannerCatalogue();
  const constants = learningConstants();
  const fleet = (await call('fleet', {})).fleet ?? [];
  const only = list(arg('agents')), exclude = list(arg('exclude')), rooms = list(arg('room-policy')).map(Number);
  const rows = fleet.filter(r => r.in_game !== false && (!only.length || only.includes(r.agent)) &&
    !exclude.includes(r.agent) && (!rooms.length || rooms.includes(r.policy?.assignedRoom)));
  const out = [];
  for (const r of rows) {
    const [ab, st] = await Promise.all([call('abilities', { agent: r.agent }), call('status', { agent: r.agent })]);
    const intellect = Number(st?.attributes?.intellect?.value) || 0;
    out.push({ agent: r.agent, name: r.character, intellect, purse: Number(r.purse) || 0, room: r.room_num,
      ...standing({ abilities: ab, intellect, spell: SPELL, catalogue, constants }) });
  }
  out.sort((a, b) => Number(b.known) - Number(a.known) || Number(b.can) - Number(a.can) || (a.short ?? 1e9) - (b.short ?? 1e9));
  console.log(`${SPELL}: who can learn it (PlayerCanLearn via compendium/tools/learn.mjs)`);
  for (const x of out) console.log(`  ${x.agent.padEnd(4)} ${String(x.name).slice(0, 12).padEnd(12)} int ${String(x.intellect).padStart(2)} ` +
    (x.known ? 'KNOWS IT' : x.can ? `CAN LEARN (have ${x.have} / need ${x.need})` : `short ${x.short} (have ${x.have} / need ${x.need})`) +
    `  [${x.below}]  purse ${x.purse}${x.why ? ' — ' + x.why : ''}`);

  if (argv.includes('--buy')) {
    const teacher = arg('teacher'), teacherRoom = Number(arg('teacher-room')), price = Number(arg('price')), home = Number(arg('home'));
    if (!teacher || !teacherRoom || !price || !home) { console.error('--buy needs --teacher --teacher-room --price --home'); process.exit(2); }
    const { loadFleetScripts, runNamed } = await import('./m59-fleetlib.mjs');
    const { fleetScript } = await import('./m59-fleetscript.mjs');
    const { scripts } = await loadFleetScripts();
    for (const x of out.filter(x => !x.known && x.can)) {
      if (x.purse < price) { console.log(`  ${x.agent}: purse ${x.purse} under ${price}, skipped (fund it first)`); continue; }
      console.log(`  ${x.agent}: buying ${SPELL} from ${teacher} in ${teacherRoom}`);
      const r = await runNamed('learn-skill', { agents: x.agent, skill: SPELL, teacher, teacherRoom, price, home },
        { scripts, fleetScript, onLog: (...a) => console.log('   ', ...a) }).catch(e => ({ ok: false, why: e.message }));
      console.log(`  ${x.agent}: ${JSON.stringify(r).slice(0, 300)}`);
    }
  }
}
