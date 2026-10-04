// practice-while-farming — DRILL A SCHOOL'S SPELLS ON SPARE MANA WITHOUT STOPPING THE FARMING.
//
//   practice-while-farming agents=t5,t6,t8 school=qor
//   practice-while-farming agents=t5 school=qor only="cloak,darkness"
//   practice-while-farming agents=t9 school=qor floor=30 gap_s=90
//   practice-while-farming agents=t5,t6,t8 school=qor off=true      # stop drilling Qor
//
// Operator, 2026-10-04: the Faronath tree farmers knew three Qor spells and practised none of
// them -- "have the practice use spare mana", then "is it done in a repeatable way?". This is the
// repeatable way. Re-run it after a level-up and the new spell joins the list at its own place.
//
// IT IS A POSTURE, NOT AN ERRAND. It writes one setting, `practice_spells`, and walks nobody:
// the keeper casts between kills in the rooms the character already farms. Hunt, confinement,
// farm strategy and buffs are left exactly as they were, so it layers on ANY farming assignment
// -- which is why this is a fleetscript and not a farm strategy file (one strategy per character).
//
// What it decides, per character, is tools/m59-farmpractice.mjs: which of the school's spells are
// safe to cast on itself, weakest first (practice drills the head of the list), and a mana floor
// that keeps the character's own buffs and touch spell affordable. Reagents are spent freely; the
// report says which spell is short of one, because that spell is then skipped every time.
import { verify } from '../m59-fleetscript.mjs';
import { planFarmPractice, practiceMatches } from '../m59-farmpractice.mjs';

const list = s => String(s ?? '').split(',').map(x => x.trim()).filter(Boolean);
const count = (items, item) => (items ?? [])
  .filter(i => String(i.name ?? '').toLowerCase().includes(String(item).toLowerCase()))
  .reduce((n, i) => n + (Number(i.amount) || 1), 0);

export const script = {
  name: 'practice-while-farming',
  describe: "Practise a school's self-safe spells on spare mana, weakest first, in the rooms each character already farms.",

  // A POLICY WRITE TAKES NO BODY. The keeper lease cancels the character's in-flight journey when
  // it is claimed (holdKeeper), which is right for an errand that walks and wrong here: this script
  // moves nothing, and taking the lease would interrupt a farmer on its way back from town for no
  // reason. Nothing else is waived.
  unsafe: {
    reason: 'Writes one autopilot setting (practice_spells) and moves nobody; holding the keeper would cancel the farmer\'s journey for nothing.',
    waives: ['keeperLease'],
  },

  consults: ['the abilities tool', 'the autopilot policy', 'substrate/m59-spells.json (the kod spell catalogue)'],

  notes: [
    'PRACTICE CASTS THE FIRST LISTED SPELL IT CAN AFFORD. The order is weakest first, so the',
    'weakest is what gets drilled; a spell short of its reagent is skipped and the next drilled.',
    '',
    'SPARE MANA MEANS: after a practice cast the character can still cast every buff it is',
    'posted to cast and its touch spell. `floor` raises that, never lowers it.',
  ],

  params: {
    agents: { type: 'agents', required: true, describe: 'who practises' },
    school: { type: 'string', required: true, describe: "qor, kraanan, shal'ille, faren, riija or jala" },
    only:   { type: 'string', default: null, describe: 'limit to these spells, comma separated' },
    floor:  { type: 'number', default: null, describe: 'a mana floor above the derived one' },
    gap_s:  { type: 'number', default: 60, describe: 'at most one practice cast per this many seconds' },
    rooms:  { type: 'string', default: null, describe: 'practice rooms, comma separated; default: the farming rooms' },
    off:    { type: 'boolean', default: false, describe: "remove this school's spells from practice instead" },
  },

  steps: (p) => [
    verify(async ({ agent, call, state }) => {
      const [ab, ap, st, inv] = await Promise.all([
        call('abilities', { agent }), call('autopilot', { agent, action: 'status' }),
        call('status', { agent }), call('inventory', { agent }).catch(() => null)]);
      const policy = ap?.policy ?? {};
      const prior = policy.practiceSpells ?? null;

      if (p.off) {
        const plan = planFarmPractice({ school: p.school, known: ab?.spells ?? [], policy, keepOthers: true });
        const schoolNames = new Set((ab?.spells ?? []).filter(s =>
          String(s.school ?? '').toLowerCase().replace(/[’'`]/g, '') === String(p.school).toLowerCase().replace(/[’'`]/g, ''))
          .map(s => String(s.name).toLowerCase()));
        const rest = (prior?.spells ?? []).filter(e => !schoolNames.has(String(e?.name ?? e).toLowerCase()));
        const practice = rest.length ? { ...prior, spells: rest } : null;
        state.planned = practice;
        state.report = [`${p.school}: removed from practice` + (rest.length ? `; ${rest.length} other entr(ies) kept` : '; practice off'),
                        ...(plan.report ?? [])];
      } else {
        const plan = planFarmPractice({
          school: p.school, known: ab?.spells ?? [], policy,
          maxMana: st?.mana?.max ?? st?.vitals?.max ?? null,
          pack: item => count(inv?.items, item),
          only: p.only ? list(p.only) : null, floor: p.floor,
          rooms: p.rooms ? list(p.rooms).map(Number) : null, gapMs: Math.max(20, Number(p.gap_s) || 60) * 1000,
        });
        if (!plan.ok) return { ok: false, why: `${agent}: ${plan.why}` + (plan.report?.length ? ` | ${plan.report.join(' | ')}` : '') };
        state.planned = plan.practice;
        state.report = plan.report;
      }
      // The mode is passed back unchanged: `start` needs one, and this script changes nothing else.
      const r = await call('autopilot', { agent, action: 'start', mode: ap?.mode ?? 'farm',
        practice_spells: state.planned,
        why: `practice-while-farming school=${p.school}${p.off ? ' off' : ''}` });
      if (r?.error) return { ok: false, why: `${agent}: ${r.error}` };
      if (r?.keeper_backed && !(r.keeper_push?.confirmed && r.keeper_push?.ok))
        return { ok: false, why: `${agent}: the keeper did not confirm the push (${JSON.stringify(r.keeper_push ?? null).slice(0, 200)})` };
      return { ok: true, why: `${agent}: ${state.report.join(' | ')}` };
    }, 'plan the practice list from what the character knows, and push it'),

    // READ IT BACK FROM THE KEEPER, not from the reply: the value in force is what counts.
    verify(async ({ agent, call, state }) => {
      const ap = await call('autopilot', { agent, action: 'status' });
      const live = ap?.policy?.practiceSpells ?? null;
      if (state.planned === null) return live == null || !(live.spells ?? []).length
        ? { ok: true } : { ok: false, why: `${agent}: practice still lists ${JSON.stringify(live.spells)}` };
      return practiceMatches(live, state.planned)
        ? { ok: true, why: `${agent}: drilling ${(live.spells ?? []).map(e => e.name ?? e).join(' > ')}, floor ${live.mana_floor}` }
        : { ok: false, why: `${agent}: the keeper holds ${JSON.stringify(live).slice(0, 300)}` };
    }, "the keeper's practice setting is the one planned"),
  ],
};
