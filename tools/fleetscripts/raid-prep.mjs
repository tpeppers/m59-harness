// GET THE RAID READY, AND BE SAFE TO RUN AGAIN FIVE MINUTES OR FIVE HOURS LATER.
//
//   node tools/m59-fleet-repl.mjs   ->  raid-prep target=Ghost agents=t1,t2
//   node tools/m59-raid.mjs --report <fleet> Ghost      the aggregate, re-readable later
//
// Phase one of two; `raid-action` is the other. They are separate commands because
// preparation is idempotent and cheap to repeat while the fight is neither.
//
// WHAT IT DOES, each step announced on the raid channel (`say` on a test server, `guild` on
// prod, where the room is full of strangers and the fleet is in a guild):
//
//   1. read every raider — what it wields, its mana, its reagents, what is already on it
//   2. eat, because resting stops awarding vigor at 80 of 200 and food is the only way past
//   3. cast the long preparations, LONGEST-LASTING FIRST, skipping whoever already has one,
//      waiting for mana when a caster runs dry
//   4. STAGE the short ones and every room enchantment for the action phase
//   5. record what happened, per character, as it happens
//
// IDEMPOTENT BY OBSERVATION, NEVER BY MEMORY. It asks the world whether each buff is in
// effect rather than remembering what it cast. A memory would be wrong the moment something
// expired, and things expiring is the entire reason to run this again.
//
// NO FLEET-WIDE HOOK, BECAUSE fleetScript HAS NONE. An earlier draft declared an `after()`
// and it was simply never called: the script ran, reported `2/2 completed`, and printed
// nothing — the most misleading possible outcome for a tool whose job is to say what state
// the raid is in. Each agent now prints its own line as it finishes and appends its own
// record, and the aggregate is a separate read of those records.
import { verify, castVerified, foodIn, countReagents } from '../m59-fleetscript.mjs';
import { buffCatalogue } from '../m59-buffs.mjs';
import { planPreparations, inEffect, writeStaging, recordPrep } from '../m59-raid.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const script = {
  name: 'raid-prep',
  describe: 'Buff and feed the fleet for a boss, longest-lasting spells first. Re-runnable.',
  params: {
    target: { type: 'string', required: true, describe: 'the boss this is for — names the staging file' },
    // Comma-separated and NOT space-separated: the REPL splits arguments on whitespace, so
    // `buffs=enchant weapon` arrives as two tokens and the second is dropped. Ask for
    // `buffs=enchant weapon,bless` and it still breaks; use commas with no spaces around
    // them, or pass one buff at a time. Every name is in `node tools/m59-buffs.mjs`.
    buffs: { type: 'string', default: 'enchant weapon,super strength,bless,forces of light',
             describe: 'comma-separated buff names; see `node tools/m59-buffs.mjs`' },
    channel: { type: 'string', default: 'say', describe: '`guild` on prod, `say` on a test server' },
    wait_mana: { type: 'number', default: 120,
                 describe: 'seconds a caster may wait for mana before that cast is given up' },
    attempts: { type: 'number', default: 3,
                describe: 'tries per buff. A broken trance and a failed roll are both retryable ' +
                          'and both common; anything else is not retried' },
  },

  async steps({ target, buffs, channel, wait_mana, attempts }, agent, state) {
    const wanted = String(buffs).split(',').map(s => s.trim()).filter(Boolean);
    const plan = planPreparations(wanted, { catalogue: buffCatalogue() });
    const fleet = state?.fleet ?? process.env.M59_FLEET ?? 'default';

    return [
      verify(async ({ call, state: st }) => {
        // The plan is a pure function of the requested buffs, so every agent writes the
        // same staging file and there is nothing to coordinate.
        writeStaging(fleet, target, plan.deferred);

        const say = text => call('say', { agent, type: channel, text: String(text).slice(0, 220) }, 30_000)
          .catch(() => {});
        const status = () => call('status', { agent, brief: false }, 40_000).catch(() => null);
        const results = [], warnings = [];

        const before = await status();
        const wielded = (before?.equipment ?? [])
          .find(e => !/shield|helm|armor|armour/i.test(String(e))) ?? null;

        // ---- 2. VIGOR. A raider at 80 is not ready, and it does not feel like a problem
        // until the fight is slow for a reason nobody can name.
        const vigor0 = before?.vigor?.value ?? null;
        if (vigor0 != null && vigor0 < 180) {
          // `act verb=eat` applies an ITEM to yourself and needs to be told which — a bare
          // eat did nothing and reported `vigor 80 -> 80`, which reads as "there is no food"
          // rather than as "you did not say what to eat". What counts as food is a question
          // this repository has already answered the hard way (`foodIn` reads the game's own
          // Food class tree; a hand-written list has been wrong in four places at once).
          const inv0 = await call('inventory', { agent }, 40_000).catch(() => null);
          const meals = foodIn(inv0?.items ?? []);
          // ONE BITE IS ONE ITEM, AND THE GAIN LANDS A MOMENT LATER. The first version ate once per
          // STACK and read vigor straight back: on the 2026-09-25 rehearsal every raider reported
          // `80->80` with 60 loaves in the pack, while a loaf measured 80 -> 98 read three seconds
          // on. So: bite the same stack again until 180, reading after a settle, and move to the
          // next stack only when a bite stops paying.
          let ate = null, vigorNow = vigor0;
          if (meals.length) await say(`Vigor ${vigorNow}/200 — eating.`);
          for (const meal of meals) {
            for (let bite = 0; bite < Math.max(1, Number(meal.amount) || 1) && bite < 12 && vigorNow < 180; bite++) {
              ate = await call('act', { agent, verb: 'eat', target: meal.id }, 60_000)
                .catch(e => ({ error: e.message }));
              await sleep(2500);
              const v = (await status())?.vigor?.value ?? vigorNow;
              if (v <= vigorNow) { vigorNow = v; break; }
              vigorNow = v;
            }
            if (vigorNow >= 180) break;
          }
          if (!meals.length) ate = { error: 'nothing edible in the pack' };
          const vigor1 = vigorNow;
          results.push({ buff: 'vigor', outcome: vigor1 > vigor0 ? 'cast' : 'failed',
                         detail: `${vigor0}->${vigor1}` });
          if (vigor1 <= vigor0)
            warnings.push(`${before?.character ?? agent}: vigor stuck at ${vigor1} — nothing edible in the pack` +
              (ate?.error ? ` (${String(ate.error).slice(0, 60)})` : ''));
        } else if (vigor0 != null) {
          results.push({ buff: 'vigor', outcome: 'still', detail: `${vigor0}/200` });
        }

        // ---- 3. THE LONG PREPARATIONS, in the catalogue's order.
        for (const buff of plan.now) {
          const now = await status();
          // IDEMPOTENCY IS ANSWERED BY THE CAST ITSELF, AND IT IS FREE.
          //
          // `inEffect` can read a personal buff off the character, but it cannot see whether
          // a WEAPON is enchanted: the server does not rename it and no prod-safe read
          // exposes the flag, so it answers `null` — unknown — and prep had nothing to do
          // with that but re-cast and hope.
          //
          // The game answers it directly. Every already-in-effect refusal lives in
          // `CanPayCosts`, which runs BEFORE the mana and reagents are taken (persench.kod:76,
          // enchwp.kod:81), so asking costs nothing at all when the answer is yes:
          // "This weapon is already dedicated to Kraanan." Cheaper than a read, and it is the
          // server's own opinion rather than our inference from one.
          const have = inEffect(now, buff);
          if (have === true) { results.push({ buff: buff.name, outcome: 'still' }); continue; }

          if (buff.scope === 'weapon' && !wielded) {
            results.push({ buff: buff.name, outcome: 'skipped' });
            warnings.push(`${now?.character ?? agent}: nothing wielded, so there is no weapon to enchant`);
            continue;
          }

          // WAIT FOR MANA RATHER THAN GIVE UP: a caster short of mana is EARLY, not unable,
          // which is the same argument fleetScript's health floor makes about a journey.
          // Bounded, because a raid cannot wait for ever on somebody who is not regenerating.
          const need = buff.mana ?? 0;
          const until = Date.now() + Number(wait_mana) * 1000;
          let mana = now?.mana?.value ?? 0;
          if (mana < need) await say(`${buff.name}: waiting on mana, ${mana}/${need}.`);
          while (mana < need && Date.now() < until) {
            await new Promise(r => setTimeout(r, 10_000));
            mana = (await status())?.mana?.value ?? mana;
          }
          if (mana < need) {
            results.push({ buff: buff.name, outcome: 'failed' });
            warnings.push(`${now?.character ?? agent}: ${buff.name} needs ${need} mana, had ${mana} after ${wait_mana}s`);
            continue;
          }

          // THE CHARACTER'S OWN NAME IS THE TARGET FOR A PERSONAL BUFF. `status.you` is null
          // and no status field carries the self object id, so an id-based self-target
          // silently passed nothing and the cast came back "needs 1 target(s) — pass one".
          // The cast tool resolves a name against the room, and the caster is in the room.
          let targetId = now?.character ?? null;
          if (buff.scope === 'weapon') {
            const inv = await call('inventory', { agent }, 40_000).catch(() => null);
            const item = (inv?.items ?? []).find(i => new RegExp(String(wielded), 'i').test(i.name || ''));
            if (!item) {
              results.push({ buff: buff.name, outcome: 'skipped' });
              warnings.push(`${now?.character ?? agent}: cannot find "${wielded}" in the pack to enchant`);
              continue;
            }
            targetId = item.id;
          }

          // ---- REAGENTS, BEFORE THE ATTEMPT AND NOT AFTER IT.
          //
          // A cast short of reagents is refused in `CanPayCosts` with NO MESSAGE AND NO
          // COST, which is byte-for-byte what a cast that never left looks like: "no mana
          // and no reagents moved". Ffff and Iiii each burned four attempts and a hundred
          // and thirty seconds of a raid's prep that way, reported as an unexplained
          // failure, while carrying a dozen orc teeth and not one elderberry.
          //
          // The pack knows. So ask it, name the shortfall in the raid channel, and do not
          // spend an attempt that cannot succeed.
          const wantReagents = buff.reagents ?? [];
          if (wantReagents.length) {
            const key = x => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
            const inv = await call('inventory', { agent }, 40_000).catch(() => null);
            const bag = countReagents(inv?.items ?? []);
            const have = {};
            for (const [k, n] of Object.entries(bag)) have[key(k)] = (have[key(k)] ?? 0) + n;
            const short = wantReagents
              .map(r => ({ item: r.item, want: r.count, got: have[key(r.item)] ?? 0 }))
              .filter(r => r.got < r.want);
            if (short.length) {
              const what = short.map(r => `${r.want - r.got} more ${r.item}`).join(' and ');
              results.push({ buff: buff.name, outcome: 'failed', detail: `short of ${what}` });
              warnings.push(`${now?.character ?? agent}: ${buff.name} needs ${what} — nothing was cast`);
              await say(`I cannot cast ${buff.name}: I need ${what}.`);
              continue;
            }
          }

          await say(`Casting ${buff.name}${buff.scope === 'weapon' ? ` on my ${wielded}` : ''}.`);

          // RETRY WHAT IS RETRYABLE, AND ONLY THAT. A broken trance and a failed roll are
          // both ordinary and both fixed by casting again; "already in effect", "you do not
          // know it" and "out of range" are answers, and repeating them wastes the raid's
          // time. `enchant weapon` charges 30 seconds and is interrupted often enough that
          // one attempt is not a real attempt — the first live run of this fleet lost THREE
          // of three that way while reporting three successes.
          let r = null, tries = 0;
          const limit = Math.max(1, Number(attempts) || 1);
          while (tries < limit) {
            tries++;
            r = await castVerified(agent, buff.name, { target: targetId, cost: buff.mana });
            if (!r.retryable) break;
            if (tries < limit)
              await say(`${buff.name} ${r.outcome === 'interrupted' ? 'was interrupted' : 'failed its roll'} — trying again (${tries}/${limit}).`);
          }

          // ALREADY IN EFFECT IS A PREPARED BUFF, NOT A FAILED ONE. It is the single most
          // common outcome of a re-run, and filing it under failures would make an
          // idempotent prep look broken every time it did its job.
          const outcome = r.in_effect ? 'still' : r.landed ? 'cast' : 'failed';
          results.push({ buff: buff.name, outcome,
                         detail: outcome === 'cast' && tries > 1 ? `on attempt ${tries}` : r.why,
                         ...(tries > 1 ? { attempts: tries } : {}) });
          await say(outcome === 'still' ? `${buff.name} is already up.`
            : outcome === 'cast' ? `${buff.name} is up.`
            : `${buff.name} did not take: ${String(r.why).slice(0, 80)}`);
          if (outcome === 'failed')
            warnings.push(`${now?.character ?? agent}: ${buff.name} — ${r.why}` +
                          (tries > 1 ? ` (${tries} attempts)` : ''));
        }

        const row = { character: before?.character ?? agent, wielded,
                      mana: (await status())?.mana?.value ?? null };
        st.results = results; st.warnings = warnings; st.row = row;
        recordPrep(fleet, target, { agent, row, results, warnings });
        // The per-character line NOW, not only in an aggregate later: a prep run is watched
        // while it happens, and a silent one reads as a broken one.
        console.log(`  ${String(row.character).padEnd(8)} ` +
          results.map(r => `${r.buff}:${r.outcome}${r.detail ? `(${r.detail})` : ''}`).join('  ') +
          (warnings.length ? `   !! ${warnings.length} warning(s)` : ''));
        return true;
      }, 'preparation could not be read back'),
    ];
  },
};
