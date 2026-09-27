#!/usr/bin/env node
// LIFT ANY SUSPECTED CURSE AT THE DESK, WITHOUT ASKING.
//
//   node tools/m59-uncurse-desk.mjs --caster hk1 --room 2 [--every 120] [--cooldown 1800] [--once]
//
// Operator, 2026-09-27: "it's cheap and any suspected curse should just get a remove curse", and
// "uncursing isn't really a risk, use it as often as desired (but keepers should note what gets
// released)". A cursed weapon can never be unwielded, and nothing on the wire says an item is
// cursed until you try: Piggy held an unidentified short sword that blocked sixteen "wield the
// enchanted twin" orders in a row, and one remove curse from the desk freed it.
//
// EACH ROUND: the caster must be in game, in `--room`, with mana. Everyone else standing there
// who is WIELDING or WEARING an item that reads unidentified (rarity 100) or cursed (200) is a
// suspect. The caster casts remove curse on each, at most once per `--cooldown` per character.
//
// A SUSPICION IS FREE TO ACT ON. remcurse.kod refuses a target with nothing cursed BEFORE the
// spell is cast ("detects no accursed items to strip away"), so no mana or emerald is spent on a
// wrong guess. The verdict is read from the caster's MANA, not the reply: a cast reply's own mana
// figure can be a stale snapshot. What was released is recorded by the TARGET's keeper
// (`uncursed` ledger rows, Autopilot.noteUncursed), because only the target hears it.
//
// It holds nothing: one broker `cast` per suspect. Stop it with Ctrl-C.
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SUSPECT_GRADES = new Set([100, 200]);

/**
 * The characters in `room` wielding or wearing a suspect item. Pure: `rows` is the broker's fleet,
 * `packs` maps agent -> inventory items ({name, rarity}). A name match is enough — the cast costs
 * nothing when the guess is wrong, so an ambiguous twin is a reason to cast, not to skip.
 */
export function suspects(rows, packs, { caster, room, now = Date.now(), last = new Map(), cooldownMs = 1_800_000 } = {}) {
  const norm = s => String(s ?? '').trim().toLowerCase();
  return (rows ?? []).filter(r => r?.agent && r.agent !== caster && r.room_num === room && r.in_game !== false &&
      r.piloted !== true && now - (last.get(r.agent) ?? 0) >= cooldownMs)
    .map(r => {
      const held = new Set([r.wielding, r.weapon_magic?.wielded?.name, ...(r.worn ?? [])].filter(Boolean).map(norm));
      const bad = (packs.get(r.agent) ?? []).filter(i => SUSPECT_GRADES.has(Number(i.rarity)) && held.has(norm(i.name)));
      return bad.length ? { agent: r.agent, character: r.character, items: bad.map(i => `${i.name}(${i.rarity})`) } : null;
    })
    .filter(Boolean);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const CASTER = arg('caster', 'hk1');
  const ROOM = Number(arg('room', 2));
  const EVERY = Math.max(30, Number(arg('every', 120))) * 1000;
  const COOL = Math.max(0, Number(arg('cooldown', 1800))) * 1000;
  const ONCE = argv.includes('--once');
  const BROKER = `http://127.0.0.1:${Number(arg('broker', 8901))}/`;
  const say = (...a) => console.log(new Date().toISOString().slice(11, 19), '[uncurse-desk]', ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const call = async (tool, args, timeoutMs = 60_000) => {
    const r = await fetch(BROKER, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs) });
    const t = (await r.json())?.result?.content?.[0]?.text;
    if (typeof t !== 'string' || t.startsWith('error:')) throw new Error(t ?? 'no answer');
    return JSON.parse(t);
  };
  const manaOf = async agent => {
    const f = (await call('fleet', {})).fleet.find(r => r.agent === agent);
    return Number(String(f?.mana ?? '').split('/')[0]) || 0;
  };
  const last = new Map();
  say(`${CASTER} lifts suspected curses in room ${ROOM}, every ${EVERY / 1000}s, once per ${COOL / 1000}s per character`);
  for (;;) {
    try {
      const rows = (await call('fleet', {})).fleet ?? [];
      const caster = rows.find(r => r.agent === CASTER);
      if (!caster || caster.room_num !== ROOM) say(`${CASTER} is not in room ${ROOM}; waiting`);
      else {
        const here = rows.filter(r => r.room_num === ROOM && r.agent !== CASTER);
        const packs = new Map();
        for (const r of here) {
          const inv = await call('inventory', { agent: r.agent }).catch(() => null);
          if (inv?.items) packs.set(r.agent, inv.items);
        }
        for (const sus of suspects(rows, packs, { caster: CASTER, room: ROOM, last, cooldownMs: COOL })) {
          const st = await call('status', { agent: sus.agent, brief: false }).catch(() => null);
          const id = st?.self_id ?? st?.you?.id;
          if (!id || id < 0) { say(`${sus.character}: no object id to aim at; skipped`); continue; }
          last.set(sus.agent, Date.now());
          const before = await manaOf(CASTER);
          const r = await call('cast', { agent: CASTER, spell: 'remove curse', target: id }, 90_000)
            .catch(e => ({ error: e.message }));
          const after = await manaOf(CASTER);
          const took = after < before;
          say(`${sus.character} wearing ${sus.items.join(', ')}: ` +
              (r.error ? `cast failed (${r.error})`
                : took ? `curse LIFTED (mana ${before} -> ${after}); the keeper records what was released`
                : 'nothing cursed (the cast was refused free)'));
        }
      }
    } catch (e) { say(`round failed: ${e.message}`); }
    if (ONCE) break;
    await sleep(EVERY);
  }
}
