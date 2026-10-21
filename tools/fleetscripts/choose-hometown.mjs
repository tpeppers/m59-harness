// CHOOSE A CHARACTER'S HOMETOWN — PERMANENTLY — AT THE HALL OF GENEALOGY IN COR NOTH.
//
//   choose-hometown agents=t5,t6 town=tos confirm=true
//
// PUBLIC. Operator's request, 2026-10-21 ("Have Beaker and Bunsen change their hometowns to Tos"),
// done first as a local pad and promoted here. Everything below is read from the server source
// (Meridian59/kod/object/active/holder/room/crnthrm/Coruniv.kod unless a file is named).
//
// THE MECHANISM. The Hall of Genealogy (RID_COR_UNIV, room 156) listens to the room. Saying a
// town's sentence EXACTLY (`StringEqual`, so no punctuation slack) anywhere in that room calls
// `SetHomeRoom #lock=TRUE` with the town's inn: Tos 52, Barloque 106, Cor Noth 153, Jasper 370,
// Marion 202. The home room decides where a character comes back after death and what its profile
// says it is ("He has been a citizen of Tos ..."). Only those five towns are offered.
//
// IT IS PERMANENT. `lock=TRUE` stores the room negated, and `CanChangeHomeroom`
// (player/user.kod) refuses every later choice with "You cannot change your hometown - it has
// already been chosen." So does a character whose home was ever locked by anything else. That is
// why this refuses to say a word without `confirm=true`. Nothing on the wire tells a locked home
// from an unlocked one, so the refusal is the only way to learn it, and this script reports it as
// such rather than as a failure to walk.
//
// THE VERDICT IS THE PROFILE, NOT THE SENTENCE. The hall's confirmation for Tos names the town;
// Marion's ("Be kind to all others...") and Barloque's ("Be true to thy noble blood.") do not. So
// success is read back from a confirmed self-look by object id (the same check `refreshHometowns`
// in m59-hometowns.mjs makes) and recorded in the fleet's hometown book. A character already
// living in the target town walks nowhere and says nothing.
import { walk, say, verify } from '../m59-fleetscript.mjs';
import { hometownFrom } from '../m59-describe.mjs';
import { recordHometown } from '../m59-hometowns.mjs';

export const HALL_OF_GENEALOGY = 156;   // RID_COR_UNIV (blakston.khd)

/** The five choosable towns: the exact sentence (Coruniv.kod coruniv_choose_*_trigger) and the
 *  hall's own reply (coruniv_chose_*), keyed by what an operator types. */
export const TOWNS = Object.freeze({
  tos:      { town: 'Tos',      room: 52,  say: 'I grew up on the ancient streets of Tos.',
              reply: 'Street savvy and ready for fame and fortune, you proudly display Tos as your hometown.' },
  barloque: { town: 'Barloque', room: 106, say: 'Good Barloque, thy regal streets shall be mine home.',
              reply: 'Be true to thy noble blood.' },
  cornoth:  { town: 'Cor Noth', room: 153, say: 'I commend my knowledge to the free city of Cor Noth.',
              reply: 'Be sure to annotate your degrees of study on your description.' },
  jasper:   { town: 'Jasper',   room: 370, say: 'With solidarity, we stand in Jasper.',
              reply: 'Seek out and have trust only in your fellow Jasperites.' },
  marion:   { town: 'Marion',   room: 202, say: 'Marion, home sweet home.',
              reply: 'Be kind to all others, even those who follow the urban ways.' },
});
export const LOCKED_REPLY = 'You cannot change your hometown - it has already been chosen.';

/** "Cor Noth", "cor_noth", "CORNOTH" -> 'cornoth'; anything else -> null. */
export function townKey(value) {
  const k = String(value ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return TOWNS[k] ? k : null;
}

/** What the hall said, as 'chosen' | 'locked' | null, from the lines heard after the sentence. */
export function hallVerdict(key, lines = []) {
  const text = lines.map(String);
  if (text.some(l => l.includes(LOCKED_REPLY))) return 'locked';
  if (text.some(l => l.includes(TOWNS[key].reply))) return 'chosen';
  return null;
}

/** A confirmed self-look: the reply must be about this character's own object. */
async function selfHometown(call, agent) {
  const st = await call('status', { agent }, 30_000).catch(() => null);
  const id = Number(st?.you?.id);
  const room = Number(st?.where?.num ?? st?.room?.num) || null;
  if (!(id > 0)) return { home: null, room, why: 'no live self object id in status' };
  const look = await call('look_at', { agent, target: id }, 30_000).catch(e => ({ error: e.message }));
  if (look?.id !== id || !look?.is_player) return { home: null, room, why: look?.error ?? 'no confirmed self-look reply' };
  return { home: hometownFrom(look.extra), room, extra: look.extra, character: st?.character ?? null };
}

async function cursorNow(call, agent) {
  const w = await call('wait_for_event', { agent, kinds: ['message'], timeout_ms: 1 }, 30_000).catch(() => null);
  return w?.cursor ?? 0;
}

async function heardSince(call, agent, since, ms) {
  const out = [], until = Date.now() + ms;
  let at = since;
  while (Date.now() < until) {
    const w = await call('wait_for_event', { agent, since: at, kinds: ['message', 'said'],
      timeout_ms: Math.min(3000, until - Date.now()) }, 30_000).catch(() => null);
    if (!w) break;
    if (w.cursor !== undefined) at = w.cursor;
    for (const e of w.events ?? []) if (e?.text) out.push(String(e.text));
    if (out.length && w.timed_out) break;
  }
  return out;
}

export const script = {
  name: 'choose-hometown',
  provenance: {
    pinned: 'e0d41b14', verified: '2026-10-21',
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-describe.mjs', 'tools/m59-hometowns.mjs'],
  },
  describe: 'Walk to the Hall of Genealogy (Cor Noth, 156) and choose a hometown — permanently.',
  recipe: {
    effect: 'The character\'s home room becomes the named town\'s inn, LOCKED for good: it is ' +
            'where the character returns after death, and what its profile calls it.',
    run: 'choose-hometown agents=<a,b> town=tos|barloque|cornoth|jasper|marion confirm=true',
    needs: ['confirm=true — the choice cannot be undone by anyone but a DM',
            'a home that was never locked; a locked one is refused by the hall, and reported'],
    cost: { time: 'the road to Cor Noth; the hall itself takes seconds',
            risk: 'the road',
            measured: '2026-10-21 — Beaker (Marion) and Bunsen (Cor Noth) to Tos from the Ukgoth ' +
                      'troll rooms, about four minutes each, both read back as "citizen of Tos"' },
    notes: ['A character already living in the target town walks nowhere.',
            'The verdict is a self-look by object id, recorded in the fleet\'s hometown book.'],
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'who chooses' },
    town: { required: true, describe: 'tos | barloque | cornoth | jasper | marion' },
    confirm: { type: 'boolean', default: false, describe: 'must be true: the choice is permanent' },
    minHealth: { type: 'number', default: 0.6, describe: 'fraction of health required to set out' },
  },

  async steps({ town, confirm }) {
    const key = townKey(town);
    if (!key) throw new Error(`choose-hometown: "${town}" is not one of ${Object.keys(TOWNS).join(', ')}`);
    const spec = TOWNS[key];
    const go = st => st.needed === true;
    return [
      verify(async ({ agent, call, state }) => {
        const me = await selfHometown(call, agent);
        state.before = me.home?.town ?? null;
        state.here = me.room;
        if (me.home?.town === spec.town) {
          state.needed = false;
          return { ok: true, skipped: `already a ${spec.town} resident — nothing to choose` };
        }
        if (!(confirm === true || confirm === 'true'))
          return { ok: false, before: state.before, why: `choosing ${spec.town} is PERMANENT (Coruniv.kod ` +
                   'SetHomeRoom lock=TRUE). Pass confirm=true to do it' };
        state.needed = true;
        return { ok: true, before: state.before ?? 'unread', to: spec.town };
      }, 'could not decide whether a choice is needed'),
      walk(st => (go(st) ? HALL_OF_GENEALOGY : st.here ?? HALL_OF_GENEALOGY), { candidates: [HALL_OF_GENEALOGY] }),
      verify(async ({ agent, call, state }) => {
        state.cursor = go(state) ? await cursorNow(call, agent) : 0;
        return true;
      }, 'could not mark the message stream'),
      say(st => (go(st) ? spec.say : ''), { listenMs: 4000, optional: true }),
      verify(async ({ agent, call, state }) => {
        if (!go(state)) return { ok: true, skipped: 'nothing was said' };
        const heard = await heardSince(call, agent, state.cursor, 8000);
        const hall = hallVerdict(key, heard);
        const me = await selfHometown(call, agent);
        if (me.character && me.extra) recordHometown(me.character, me.extra);
        if (me.home?.town === spec.town) return { ok: true, hometown: spec.town, from: state.before, hall };
        if (hall === 'locked') return { ok: false, outcome: 'locked', why: `the hall refused: "${LOCKED_REPLY}" ` +
                                        `— this character's home (${state.before ?? 'unread'}) was already chosen` };
        return { ok: false, hall, profile: me.home?.town ?? null, why: me.why ??
                 `the profile still says ${me.home?.town ?? 'nothing readable'}, not ${spec.town}` };
      }, 'the hometown did not change'),
    ];
  },
};
