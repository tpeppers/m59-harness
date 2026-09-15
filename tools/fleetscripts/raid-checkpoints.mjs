#!/usr/bin/env node
// THE BOSS RAID AS A CHECKPOINT CHAIN — the worked example for FleetScratch's skipTo.
//
//   node tools/fleetscripts/raid-checkpoints.mjs --survey
//   node tools/fleetscripts/raid-checkpoints.mjs --skip-to armed --dry
//   node tools/fleetscripts/raid-checkpoints.mjs --until engaged
//
// Five raid attempts on 2026-09-11 took 16-30 minutes each and every one re-walked the fleet
// from the beginning. Not one failure was in the part being iterated on. This is that raid
// with its postconditions written down, so an attempt can start from the last one that still
// holds instead of from the door.
//
// READ THE `armed` CHECKPOINT FIRST if you are reviewing this. It is the one that makes the
// case for the design, because its postcondition is genuinely UNKNOWABLE from a prod-safe
// read, knowable from the maintenance socket on a loopback test server, and cheap to
// establish either way. All three of those facts have to be expressible or the abstraction
// is lying.
import { checkpoint, chain, reach, runUntil, survey, report } from '../m59-checkpoint.mjs';

const rpc = async (name, args = {}, ms = 60_000) => {
  const port = process.env.M59_BROKER_PORT ?? 8971;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
                             params: { name, arguments: args } }),
    });
    const j = await res.json();
    const txt = j?.result?.content?.[0]?.text;
    try { return JSON.parse(txt); } catch { return txt ?? j?.result ?? j; }
  } finally { clearTimeout(t); }
};

const roster = async () => (await rpc('fleet', {}))?.fleet ?? [];

// ---------------------------------------------------------------------------------------
// Reading a weapon's MAGIC flag needs the maintenance socket, which is loopback-only. On a
// server we cannot ask, this returns null and the chain reports UNKNOWN rather than guessing.
// ---------------------------------------------------------------------------------------
let dmMod = null;
const dm = async () => {
  if (dmMod === null) {
    try { dmMod = await import('../m59-dm.mjs'); }
    catch { dmMod = false; }
  }
  return dmMod || null;
};

/** true if this character's WIELDED weapon carries ATCK_WEAP_MAGIC; null if we cannot tell. */
async function wieldsMagic(row) {
  const d = await dm();
  if (!d || !d.isLoopbackHost?.(new URL(`http://${process.env.M59_HOST ?? '127.0.0.1'}`).hostname))
    return null;
  const inv = await rpc('inventory', { agent: row.agent }).catch(() => null);
  const same = (inv?.items ?? []).filter(i =>
    String(i.name).toLowerCase() === String(row.wielding ?? '').toLowerCase());
  // AMBIGUITY IS UNKNOWN, NOT FALSE. `equipment()` answers by NAME only, so two weapons of
  // one name — one magic, one not — make the name useless. That is not a hypothetical: a
  // raider went in swinging the mundane twin of the sword we had just enchanted, and the
  // ghost "laughed off your pitiful blow".
  if (same.length !== 1) return same.length === 0 ? false : null;
  const out = String(await d.dm([`show object ${same[0].id}`]));
  const at = Number((out.match(/piAttack_type\s+= INT (\d+)/) ?? [])[1] ?? 0);
  return (at & 0x04) !== 0;                       // ATCK_WEAP_MAGIC
}

export function raidChain({ stage = 38, boss = 40, target = 'Ghost' } = {}) {
  return chain(
    // -------------------------------------------------------------------------------------
    checkpoint('mustered', {
      describe: `every raider standing in room ${stage}`,
      perishable: true,          // keepers roam: this decays with nobody doing anything
      holds: async () => {
        const rows = await roster();
        if (!rows.length) return null;                       // no broker answer is not "no"
        return rows.every(r => Number(r.room_num) === Number(stage));
      },
      // THE OPERATOR'S OWN DESIGN NOTE: establish a postcondition BY DM COMMAND rather than
      // replaying the walk. A muster that walks takes eight minutes and crosses Ukgoth; a
      // relocate is instant and is exactly as true afterwards.
      establish: async () => {
        const d = await dm();
        if (!d) throw new Error('mustering by relocate needs the maintenance socket');
        const rows = await roster();
        const names = rows.map(r => r.character).filter(Boolean);
        const ids = await d.resolve(names);
        const cmds = [];
        for (const n of names) if (ids[n]) cmds.push(`send object ${ids[n]} UtilGoNearSquare room ${stage}`);
        if (cmds.length) await d.dm(cmds, { timeoutMs: 120_000 });
      },
    }),

    // -------------------------------------------------------------------------------------
    // THE INTERESTING ONE. Against a boss resisting ATCK_WEAP_NONMAGIC by 90% and taking -50
    // against ATCK_WEAP_MAGIC, this postcondition is worth about fifteen times everything
    // else the raid decides. And:
    //
    //   * it is UNKNOWABLE from a prod-safe read (the server does not rename the weapon);
    //   * it is knowable here, because a loopback maintenance socket can read the flag;
    //   * it is cheap to establish EITHER WAY, because casting at an already-enchanted weapon
    //     is refused in CanPayCosts before any cost is taken — "This weapon is already
    //     dedicated to Kraanan" — so asking costs nothing when the answer is yes.
    //
    // That last point is the general lesson: when `holds` cannot answer, `establish` sometimes
    // can, for free. Look for that before accepting an unknown.
    checkpoint('armed', {
      describe: 'every raider wielding a weapon the boss does not resist',
      perishable: true,          // conjured weapons evaporate, taking the enchantment with them
      holds: async () => {
        const rows = await roster();
        if (!rows.length) return null;
        let unknown = false;
        for (const r of rows) {
          const m = await wieldsMagic(r);
          if (m === null) unknown = true;
          else if (m === false) return false;      // one mundane weapon is a definite no
        }
        return unknown ? null : true;
      },
      establish: async () => {
        throw new Error('run raid-arm (or raid-prep buffs="enchant weapon") — this one is ' +
                        'deliberately not automated here: it spends reagents');
      },
    }),

    // -------------------------------------------------------------------------------------
    checkpoint('in_the_boss_room', {
      describe: `every raider standing in room ${boss}`,
      perishable: true,
      holds: async () => {
        const rows = await roster();
        if (!rows.length) return null;
        return rows.every(r => Number(r.room_num) === Number(boss));
      },
      establish: async () => {
        const d = await dm();
        if (!d) throw new Error('needs the maintenance socket');
        const rows = await roster();
        const ids = await d.resolve(rows.map(r => r.character).filter(Boolean));
        const cmds = [];
        for (const [, o] of Object.entries(ids)) if (o) cmds.push(`send object ${o} UtilGoNearSquare room ${boss}`);
        if (cmds.length) await d.dm(cmds, { timeoutMs: 120_000 });
      },
    }),

    // -------------------------------------------------------------------------------------
    // Deliberately has NO establish(). The fight is the thing we came to do; there is no
    // honest way to "skip to having fought it", and a checkpoint that cannot be established
    // says so rather than pretending.
    checkpoint('engaged', {
      describe: `${target} has taken damage`,
      holds: async () => {
        const d = await dm();
        if (!d) return null;
        const obj = await d.roomObject(boss);
        if (!obj) return null;
        const out = String(await d.dm([`show object ${obj}`]));
        const m = /LIST (\d+)/.exec((out.match(/plActive\s+= (.+)/) ?? [])[1] ?? '');
        if (!m) return false;
        const l = String(await d.dm([`show list ${m[1]}`]));
        for (const id of [...l.matchAll(/OBJECT (\d+)/g)].map(x => Number(x[1]))) {
          const o = String(await d.dm([`show object ${id}`]));
          if (!/is CLASS Ghost/i.test(o)) continue;
          const hp = Number((o.match(/piHit_points\s+= INT (-?\d+)/) ?? [])[1] ?? NaN);
          const mx = Number((o.match(/piMax_hit_points\s+= INT (-?\d+)/) ?? [])[1] ?? NaN);
          if (Number.isFinite(hp) && Number.isFinite(mx)) return hp < mx;
        }
        return false;
      },
    }),
  );
}

if (process.argv[1] && process.argv[1].endsWith('raid-checkpoints.mjs')) {
  const arg = f => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : null; };
  const cps = raidChain({ stage: Number(arg('--stage') ?? 38), boss: Number(arg('--boss') ?? 40) });
  const dry = process.argv.includes('--dry');
  const allowUnknown = process.argv.includes('--allow-unknown');

  if (process.argv.includes('--survey')) {
    console.log('WHERE THE RAID IS RIGHT NOW\n');
    for (const r of await survey(cps))
      console.log(`  ${String(r.state).padEnd(9)} ${String(r.name).padEnd(18)} ` +
                  `${r.perishable ? '(perishable) ' : ''}${r.describe ?? ''}` +
                  `${r.can_establish ? '' : '   [no establish: this one must be earned]'}`);
    process.exit(0);
  }
  const to = arg('--skip-to'), until = arg('--until');
  if (!to && !until) {
    console.error('usage: --survey | --skip-to <checkpoint> [--dry] [--allow-unknown] | --until <checkpoint>');
    process.exit(2);
  }
  const r = until ? await runUntil(cps, until, {}, { dryRun: dry, allowUnknown })
                  : await reach(cps, to, {}, { dryRun: dry, allowUnknown });
  console.log(report(r));
  process.exit(r.reached ? 0 : 1);
}
