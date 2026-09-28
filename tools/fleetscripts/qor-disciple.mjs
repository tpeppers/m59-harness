// MAKE A QOR DISCIPLE: KILL GOOD CREATURES UNTIL KARMA IS -10, THEN BUY THE LEVEL-1 QOR SPELLS.
//
//   qor-disciple agents=t9                        one step of the order, whichever phase it is in
//   node tools/m59-keep-training.mjs --agent t9 --until cloak --until-known --pause 600 \
//        --school Qor --cwd <prod> -- repl:qor-disciple agents=t9      the whole order, unattended
//
// PUBLIC. Operator, 2026-09-27: "take the 2 highest mysticism characters ... mark them for Qor
// disciples ... kill Centipedes until they have below -10 karma (it might take a while) and then
// buy level 1 Qor spells. Maybe do it as a FleetScript/DUM-bot package, so we can give the same
// order to other characters later and they'll just accomplish it via the automation?"
//
// SO THIS IS RE-RUNNABLE AND DECIDES ITS OWN PHASE, from the character's karma when it compiles:
//   karma above the target  ->  set the keeper to farm the good quarry, then let go. Farming is a
//                               keeper POLICY, not a step list: a script that held the character
//                               and swung for it would hold the very faculty (work) the keeper farms
//                               with. Run again later; nothing moves until the karma does.
//   karma at the target     ->  stop farming, fund the purchase, walk to Zuxana, buy what is not
//                               yet known, prove it off the spell list, go home.
// Under m59-keep-training.mjs with `--until <last spell> --until-known` that is the whole order:
// it re-runs this every --pause seconds and stops when the character KNOWS the spell.
//
// AND TAKE THE CHARACTER AWAY FROM DUM FIRST: add it to `not_ours` in the live DUM doctrine and
// POST /reload. Otherwise a DUM station re-deploys it within a pass and the farm posture is lost.
//
// THE KARMA MATH, read off the kod (player.kod:6491-6592, CalculateKarmaChangeFromKill):
//   * a kill moves karma toward -(victim karma); CENTIPEDE is viKarma +15 (centip.kod:50), a
//     "good" creature, so killing one LOWERS karma: ~-0.86 a kill at +50, ~-0.15 at 0, ~-0.05 at
//     -10, and nothing past about -15 (both negative, doer below act). ~104 kills from 0 to -10.
//   * EVERY centipede room also spawns an EVIL creature (baby spider -10, spider -30, larva -10,
//     giant rat -20), and killing one of those RAISES karma — a baby spider at -11 undoes about
//     four centipede kills. So the hunt list is the good quarry ONLY.
//   * THE ROOM IS 554, NOT THE ONE WITH THE BEST RATIO. 545 is half centipede (cap 12) on paper, and
//     measured 2026-09-27 it produced ZERO kills in 30 minutes for two characters: "the coarse grid
//     found no route beside the target, and the fine grid could not reach one either". 554 is 35%
//     centipede but the fleet has farmed it for weeks, so its approaches are known to work.
//   * karma is stored in hundredths and read truncated (player.kod:6429), so -10.99 reads -10.
//
// THE GATE (spell.kod:456-498): GetRequiredKarma is level * -10 for Qor, KarmaCheck fails while
// karma > the requirement — so level 1 needs karma <= -10, checked at learning AND at every cast.
// Priestess Zuxana, Temple of Qor (802), sells darkness, detect good and cloak at 500 each (no
// disciple quest below level 3, temples.kod:52-74). Unholy resolve, the fourth level-1 Qor spell,
// is only at the Bone Priestess in Kocatan (2141) — opt in with `unholyResolve=true`.
//
// THE TEMPLE OF QOR HAS A WANDERING ENTRANCE: 598 and 589 alternate every ten minutes
// (tempqor.kod ExitsTimer). A walk that finds the wrong one closed fails; this script is run again
// by the runner ten minutes later, which is the right cadence for exactly that door.
import { walk, learn, act, verify } from '../m59-fleetscript.mjs';

const CONTROL = process.env.M59_CONTROL_URL || 'http://127.0.0.1:8901';
const TEMPLE = 802, TEACHER = 'Priestess Zuxana';
const ZUXANA_SPELLS = ['darkness', 'detect good', 'cloak'];

async function read(tool, args) {
  const r = await fetch(`${CONTROL}/`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(45_000) });
  return JSON.parse((await r.json())?.result?.content?.[0]?.text ?? 'null');
}

export const script = {
  name: 'qor-disciple',
  describe: 'Kill good creatures until karma <= -10, then buy the level-1 Qor spells (re-runnable; picks its phase).',
  recipe: {
    effect: 'Drives a character to karma -10 by farming a good-karma creature, then buys and verifies ' +
            'the level-1 Qor spells from Priestess Zuxana.',
    run: 'qor-disciple agents=<a>   (under m59-keep-training --until cloak --until-known --pause 600)',
    needs: ['the character removed from DUM (not_ours + /reload)',
            'a hunt room whose GOOD quarry it can fight; 545 is the default',
            '1,500 shillings for the three spells — drawn from the guild hall when short'],
    cost: { time: 'hours: ~100+ kills from karma 0 to -10, more from high positive karma',
            money: '500 per spell', risk: 'ordinary farming risk in the hunt room' },
  },
  params: {
    agents: { type: 'agents', required: true },
    karmaTo: { type: 'number', default: -10, describe: 'the karma to reach (level-1 Qor needs <= -10)' },
    room: { type: 'number', default: 554, describe: 'where to farm (554: the proven centipede station)' },
    quarry: { type: 'string', default: 'centipede', describe: 'the GOOD creature to hunt (comma list); never an evil one' },
    home: { type: 'number', default: 554, describe: 'where to go after buying (back to farm by default)' },
    unholyResolve: { type: 'string', default: 'false', describe: 'true = also buy unholy resolve at the Bone Priestess (2141)' },
  },
  async steps(p, agentArg) {
    const agent = p.agent ?? agentArg;
    const st = await read('status', { agent }).catch(() => null);
    const karma = Number(st?.karma?.value);
    // UNREADABLE IS NOT A PHASE. Both phases move the character; a karma we could not read picks
    // neither and says so, and the runner simply asks again next time.
    if (!Number.isFinite(karma)) { console.log(`  ${agent}: karma unreadable — doing nothing this time`); return []; }
    const quarry = String(p.quarry).split(',').map(s => s.trim()).filter(Boolean);

    if (karma > Number(p.karmaTo)) {
      console.log(`  ${agent} karma ${karma} (target ${p.karmaTo}) — farming ${quarry.join(', ')} in ${p.room}`);
      // THE POSTURE IS THE WHOLE STEP. Re-asserted every run, because anything that re-decides the
      // character (a DUM that was not told, an operator order, a restart) replaces it silently.
      return [act('autopilot', { action: 'start', mode: 'farm', hunt: quarry, assigned_room: Number(p.room), roam: false,
        why: `qor-disciple: karma ${karma} -> ${p.karmaTo} by killing ${quarry.join('/')} only` },
        { why: 'set the farm posture; the keeper does the killing once this run lets go' })];
    }

    const ab = await read('abilities', { agent, kind: 'spells', refresh: true }).catch(() => null);
    const known = new Set((ab?.spells ?? []).map(s => String(s.name).toLowerCase()));
    const want = ZUXANA_SPELLS.filter(s => !known.has(s));
    const unholy = String(p.unholyResolve).toLowerCase() === 'true' && !known.has('unholy resolve');
    const inv = await read('inventory', { agent }).catch(() => null);
    const purse = (inv?.items ?? []).filter(i => /^shilling$/i.test(i.name ?? '')).reduce((n, i) => n + (Number(i.amount) || 0), 0);
    const cost = 500 * (want.length + (unholy ? 1 : 0));
    console.log(`  ${agent} karma ${karma} — ready. Buying ${[...want, ...(unholy ? ['unholy resolve'] : [])].join(', ') || 'nothing (all known)'}` +
                ` for ${cost}; purse ${purse}`);
    if (!want.length && !unholy) return [];
    const knowsAll = names => verify(async ({ call }) => {
      const until = Date.now() + 180_000;
      for (let i = 0; Date.now() < until; i++) {
        const a = await call('abilities', { agent, kind: 'spells', refresh: true }, 60_000).catch(() => null);
        const have = new Set((a?.spells ?? []).map(s => String(s.name).toLowerCase()));
        if (names.every(n => have.has(n))) return true;
        await new Promise(r => setTimeout(r, i ? 8000 : 2000));
      }
      return false;
    }, `${names.join(', ')} never all appeared in the spell list — do NOT re-buy in a loop`);
    return [
      // Stop farming first, or the keeper walks the character back to the hunt room between steps.
      act('autopilot', { action: 'start', mode: 'survive', why: 'qor-disciple: karma reached, going shopping' },
          { why: 'stop farming before the trip' }),
      // FROM THE GUILD HALL (operator, 2026-09-26: "use as much money ... from the guild hall"); a
      // character's own bank account can be empty, as Statler's was on 2026-09-27.
      ...(purse < cost ? [walk(714, { why: 'the guild chests, for the spell money' }), { ...verify(async ({ call }) => {
        const r = await call('hall_withdraw', { agent, wants: [{ item: 'shilling', amount: cost - purse }] }, 620_000)
          .catch(e => ({ ok: false, why: e.message }));
        console.log(`  ${agent} HALL took ${JSON.stringify(r?.took ?? {})}${r?.ok ? '' : `  REFUSED: ${r?.why ?? '?'}`}`);
        return r?.ok === true && Number(r?.took?.shilling ?? 0) > 0;
      }, 'the hall gave no shillings'), optional: true }] : []),
      ...(want.length ? [
        // WAIT OUT ONE FLIP OF THE DOOR RATHER THAN WALKING HOME. Only one of the two entrances is
        // open at a time and they swap every ten minutes (tempqor.kod ExitsTimer), so a walk that
        // arrives at the shut one fails at the threshold — measured 2026-09-28, Camilla at 598
        // twice — and the old answer was the walk home to the hunt room and back again ten minutes
        // later. Standing at the entrance for one flip guarantees the next attempt meets an open
        // door. The wait is skipped the moment the character is already inside.
        { ...walk(TEMPLE, { why: 'Priestess Zuxana, Temple of Qor (the entrance alternates between 598 and 589)' }), optional: true },
        { ...verify(async ({ call }) => {
          const here = async () => Number((await call('status', { agent }, 30_000).catch(() => null))?.room_num);
          if (await here() === TEMPLE) return true;
          console.log(`  ${agent}: the temple door was shut — waiting one ten-minute flip where I stand`);
          await new Promise(r => setTimeout(r, 630_000));
          return true;
        }, 'could not wait for the temple door'), optional: true, anywhere: true },
        walk(TEMPLE, { why: 'Priestess Zuxana, after one flip of the entrance' }),
        ...want.map(s => learn(TEACHER, s, { retry: true })),
        knowsAll(want),
      ] : []),
      ...(unholy ? [walk(2141, { why: 'the Bone Priestess, Kocatan — the only seller of unholy resolve' }),
                    learn('The Bone Priestess', 'unholy resolve', { retry: true }), knowsAll(['unholy resolve'])] : []),
      { ...walk(Number(p.home), { why: 'home' }), always: true },
    ];
  },
};
