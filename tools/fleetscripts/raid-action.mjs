// THE FIGHT: muster, finish the preparations somewhere safe, walk in, and engage in ROLES.
//
//   node tools/m59-fleet-repl.mjs  ->  run raid-action --target Ghost --room 40 --via 38,40
//   ... --stage-room 2 --healers shadow02,shadow03
//
// Phase two. `raid-prep` is phase one and leaves a staging file naming everything it
// deliberately did NOT cast; this reads that file and casts those things at the last moment
// they are worth casting — which is NOT inside the boss's room. See below.
//
// ============================================================================
// THE STAGING ROOM, AND WHY THE DEFERRED BUFFS ARE NOT CAST AT THE BOSS'S FEET
// ============================================================================
//
// The first draft cast them on arrival, standing next to the boss, reasoning that a
// forty-second buff is worth nothing if it is cast any earlier. The reasoning is right and
// the conclusion was wrong, because a cast in a boss's room does not happen at all:
// EVENT_DAMAGE breaks a casting trance (trance.kod), and a boss hits about once a second.
// Measured on the shadow fleet — a caster took two hits from a wandering troll and lost the
// spell both times, with the mana spent and the reagents gone. In the Ghost's room, with
// twenty-one raiders pulling aggression, nobody would finish anything.
//
// So the buffs are finished in a STAGING ROOM: somewhere safe, and as few rooms from the
// boss as possible so a short buff still has most of its life at contact. Room 2 is the
// staging room for the Castle Victoria throne room — outside the front door, two rooms out.
// `--stage-room` takes any room; omit it and the buffs are cast wherever the fleet happens
// to be standing, which is the old behaviour.
//
// AND MUSTER THERE FIRST. Keepers roam: by the time a raid is called, the fleet is not where
// prep left it. One run began with raiders in rooms 2, 101 and 585, and the routes from 101
// and 585 to the castle cross Ukgoth — a known trap room — while the raid believed it was
// setting out from the front door. Everyone walks to the staging room before anything else.
//
// ============================================================================
// ROLES: MOST OF THE FLEET SWINGS, THE HEALERS DO NOT
// ============================================================================
//
// A character with `minor heal` standing in melee is worth one mundane weapon, and against a
// boss that resists mundane weapons 90% that is worth almost nothing. Standing back and
// healing whoever is worst hurt is worth far more, and it is the only thing in the raid that
// converts mana into survival. Healers therefore walk in with everyone else and then never
// call `fight`: they watch the fleet and cast on the raider who needs it most.
//
// A STALE STAGING IS REPORTED, NOT OBEYED QUIETLY. If prep ran four hours ago the long buffs
// it cast may have lapsed, and this says so rather than walking a fleet in on the strength of
// a file. It does not re-run prep for you: that is a separate command, and re-running it is
// the whole point of it being idempotent.
import { verify, act, castVerified, call } from '../m59-fleetscript.mjs';
import { buffCatalogue } from '../m59-buffs.mjs';
import { readStaging } from '../m59-raid.mjs';
import { blowLandedAsMagic, GHOST_OF_FARNOHL, ATCK } from '../m59-resistance.mjs';

// THE FLEET-WIDE SURVEY IS COMPUTED ONCE, NOT ONCE PER RAIDER.
//
// The arming gate asks a question about the WHOLE fleet — how many raiders still need a
// weapon, and how many casts the fleet can pay for — and every agent was computing it
// independently. With 21 raiders that is 21 surveys of 21 characters, each survey two broker
// calls per character: about 900 calls fired at once, on top of the fighting.
//
// It showed up as `fetch failed` on ten of twenty-one agents and five deaths, which reads as
// a flaky broker and was self-inflicted load. fleetScript runs agents in the same process, so
// a module-level memo IS the fix; the TTL is short because the answer genuinely changes as
// raiders are armed, and `inFlight` collapses the thundering herd at the start of a run when
// all 21 ask at the same instant.
let FLEET_SURVEY = { at: 0, value: null, inFlight: null };
const SURVEY_TTL_MS = 20_000;

async function surveyFleetArming(call) {
  if (FLEET_SURVEY.value && Date.now() - FLEET_SURVEY.at < SURVEY_TTL_MS) return FLEET_SURVEY.value;
  if (FLEET_SURVEY.inFlight) return FLEET_SURVEY.inFlight;
  FLEET_SURVEY.inFlight = (async () => {
    const roster = await call('fleet', {}, 40_000).catch(() => null);
    const rows = roster?.fleet ?? [];
    let casts = 0, unarmed = 0;
    let dm = null;
    try {
      const mod = await import('../m59-dm.mjs');
      if (mod.isLoopbackHost?.(process.env.M59_HOST ?? '127.0.0.1')) dm = mod;
    } catch { /* no socket: every raider counts as unconfirmed, which is conservative */ }

    for (const r of rows) {
      const inv = await call('inventory', { agent: r.agent }, 30_000).catch(() => null);
      const same = r.wielding ? (inv?.items ?? []).filter(i =>
        String(i.name).toLowerCase() === String(r.wielding).toLowerCase()) : [];
      let armed = false;
      if (dm && same.length === 1) {
        const out = String(await dm.dm([`show object ${same[0].id}`]));
        const at = Number((out.match(/piAttack_type\s+= INT (\d+)/) ?? [])[1] ?? 0);
        armed = (at & ATCK.WEAP_MAGIC) !== 0;
      }
      if (!armed) unarmed++;

      const sp = await call('spells', { agent: r.agent }, 30_000).catch(() => null);
      if (!(sp?.spells ?? []).some(x => /enchant weapon/i.test(x.name ?? ''))) continue;
      const amount = re => (inv?.items ?? []).filter(i => re.test(i.name || ''))
        .reduce((n, i) => n + (i.amount || 1), 0);
      const byReagent = Math.min(Math.floor(amount(/elderberr/i) / 3), amount(/orc tooth/i));
      const mana = r.mana_now ?? Number(String(r.mana ?? '0/0').split('/')[0]) ?? 0;
      casts += Math.max(0, Math.min(byReagent, Math.floor(mana / 17)));
    }
    const value = { casts, unarmed, of: rows.length };
    FLEET_SURVEY = { at: Date.now(), value, inFlight: null };
    return value;
  })();
  return FLEET_SURVEY.inFlight;
}

/** The healer's watch: cast on whoever is worst hurt, for as long as the fight lasts. */
async function tendTheWounded({ call, agent, say, spell, forMs, below, mana }) {
  const until = Date.now() + forMs;
  const casts = [];
  await say('Holding back to heal.');
  while (Date.now() < until) {
    const me = await call('status', { agent, brief: true }, 30_000).catch(() => null);
    if (me?.mana?.value != null && me.mana.value < (mana ?? 4)) {
      // Out of mana is not out of the fight — it is a pause. Keep watching, because mana
      // comes back and a healer that gives up is a healer nobody can plan around.
      await new Promise(r => setTimeout(r, 8000));
      continue;
    }
    const f = await call('fleet', {}, 40_000).catch(() => null);
    const rows = (f?.fleet ?? []).map(r => {
      const [h, max] = String(r.health ?? '0/1').split('/').map(Number);
      return { who: r.character, agent: r.agent, room: r.room_num, frac: max ? h / max : 1, h, max };
    });
    // ONLY SOMEBODY IN THE SAME ROOM. A heal resolves against a target in the room, and the
    // worst-hurt character in the fleet may be three maps away doing something unrelated.
    const here = rows.find(r => r.agent === agent)?.room ?? null;
    const hurt = rows
      .filter(r => r.agent !== agent && r.room === here && r.frac < below)
      .sort((a, b) => a.frac - b.frac)[0];
    if (!hurt) { await new Promise(r => setTimeout(r, 3000)); continue; }

    await say(`Healing ${hurt.who} (${hurt.h}/${hurt.max}).`);
    // A RESTING HEALER CANNOT CAST, AND A HEALER IS EXACTLY WHO THE KEEPER SITS DOWN — it is
    // standing at the back of a fight taking occasional hits, which is the keeper's cue to
    // rest it. PFLAG_NO_MAGIC (player.kod:1166) then refuses every heal for the rest of the
    // fight. One to seven casts landed per healer per run before this line.
    await call('rest', { agent, stand: true }, 30_000).catch(() => {});
    const r = await castVerified(agent, spell, { target: hurt.who, cost: mana });
    // The OUTCOME, not just the yes/no. A healer landing one cast in seven is either out of
    // range, being interrupted, or casting a spell it does not have — three different repairs,
    // and "0/7 landed" chooses none of them.
    casts.push({ on: hurt.who, at: hurt.h, landed: r.landed, outcome: r.outcome, why: r.why });
    // The server runs one action per second and silently throttles anything faster
    // (INCOMING_PACKET_THROTTLE), so pacing here is accuracy rather than politeness.
    await new Promise(x => setTimeout(x, 1500));
  }
  return casts;
}

export const script = {
  name: 'raid-action',
  describe: 'Muster, finish the deferred buffs somewhere safe, walk in, and fight in roles.',
  params: {
    target: { type: 'string', required: true, describe: 'creature name, partial is fine' },
    room: { type: 'number', required: true, describe: 'the room it is in' },
    via: { type: 'string', default: '', describe: 'comma-separated rooms to walk through, in order' },
    stage_room: { type: 'number', default: 0,
                  describe: 'muster and cast the deferred buffs here, then go. 0 = wherever we stand. ' +
                            'A boss room is never safe to cast in: being hit breaks a casting trance' },
    room_caster: { type: 'string', default: '',
                   describe: 'agent who keeps a ROOM enchantment up during the fight. Room ' +
                             'enchantments only affect the room they are cast in, so this can ' +
                             'only happen at the boss, never in prep' },
    room_enchant: { type: 'string', default: 'forces of light',
                    describe: 'forces of light adds +50..+150 to the HIT ROLL of every good player ' +
                              'in the room (forceslt.kod ModifyHitRoll) and does not touch ' +
                              'damage — the answer to a boss that dodges, not one that resists' },
    healers: { type: 'string', default: '',
               describe: 'comma-separated agents who hold back and heal instead of swinging. ' +
                         'Empty means everybody fights' },
    escort: { type: 'string', default: '',
              describe: 'comma-separated agents who fight the ESCORT and never the boss. The ' +
                        'throne room breeds one tusked skeleton every ~12s while anybody is ' +
                        'standing in it, to a cap of nine (ten minus the ghost, which counts)' },
    heal_spell: { type: 'string', default: 'minor heal' },
    heal_below: { type: 'number', default: 0.85, describe: 'heal a fleetmate under this fraction' },
    require_enchanted: { type: 'boolean', default: true,
                        describe: 'REFUSE to set out with a mundane weapon. Satisfied two ways: ' +
                                  'already wielding a magic one, or the fleet can arm it before ' +
                                  'the raid (a caster who knows enchant weapon, with reagents and ' +
                                  'mana). Set false to go anyway — it reports and continues' },
    despite_hazard: { type: 'string', default: '',
                      describe: 'why this raid may enter a NEVER_ENTER room. Room 40 is on that ' +
                                'list (tusked skeletons at level 100; Floyd died there), so a raid ' +
                                'on the throne room must say what makes it worth it. The keeper ' +
                                'refuses the override without a reason and logs the one it gets' },
    channel: { type: 'string', default: 'say', describe: '`guild` on prod, `say` on a test server' },
    rounds: { type: 'number', default: 15, describe: 'swing rounds before breaking off' },
    disengage_at: { type: 'number', default: 0.4,
                    describe: 'health fraction to break off at. The keeper still owns survival; this is on top of it' },
  },

  async steps({ target, room, via, stage_room, room_caster, room_enchant, healers,
                escort, heal_spell, heal_below, require_enchanted, despite_hazard, channel,
                rounds, disengage_at }, agent, state) {
    // FILTER THE EMPTY STRING BEFORE CONVERTING, because Number('') is 0 and 0 is finite — so
    // an empty `via` compiled to a walk to ROOM 0, which the router correctly refuses with
    // "room 0 is not in the baked map". Found by a gate test that passed no hops on purpose.
    const hops = String(via).split(',').map(x => x.trim()).filter(Boolean)
      .map(Number).filter(n => Number.isFinite(n) && n > 0);
    const healing = String(healers).split(',').map(s => s.trim()).filter(Boolean).includes(agent);
    const escorts = String(escort ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const stage = Number(stage_room) || 0;

    // A MUSTER WALK TO THE ROOM YOU ARE STANDING IN IS NOT FREE — IT IS POISON.
    //
    // `walk` reports ok once it observes arrival, but the keeper keeps the travel JOB
    // registered, and every later walk is then refused with "<agent> is busy: walk to
    // Outside Castle Victoria" before a packet is sent. Measured across a 21-raider run:
    // agents already standing in the staging room issued a no-op muster, and the walk to 38
    // that followed was refused three times each and gave up. The ones who genuinely had to
    // travel were fine — the journey ended and cleared.
    //
    // So ask where the body is BEFORE building the plan, and leave the muster out for anyone
    // already there. `steps()` is async and may read the world; that is the whole reason it
    // is async.
    let hereNow = null;
    if (stage) {
      const at = await call('status', { agent, brief: true }, 30_000).catch(() => null);
      hereNow = Number(at?.where?.num ?? at?.room_num ?? NaN);
    }
    const needsMuster = stage && hereNow !== stage;

    return [
      // ---- 1. MUSTER. Keepers roam, so the raid begins by putting everyone in one place
      // rather than assuming prep left them there.
      ...(needsMuster ? [{ do: 'walk', to: stage }] : []),

      // ---- 2. FINISH THE DEFERRED PREPARATION — here, where nothing is hitting anybody.
      verify(async ({ call, state: st }) => {
        const say = text => call('say', { agent, type: channel, text: String(text).slice(0, 220) }, 30_000)
          .catch(() => {});
        const staging = readStaging(state.fleet ?? 'shadow-ab', target);
        if (!staging) {
          await say('No staged preparation found — going in with what we have.');
          st.deferred = { none: true };
          return true;
        }
        const ageMin = Math.round((staging.age_ms ?? 0) / 60_000);
        if (ageMin > 60)
          await say(`Warning: prep ran ${ageMin} minutes ago, the long buffs may have lapsed.`);

        const cat = new Map(buffCatalogue().map(b => [b.name, b]));
        const me = await call('status', { agent, brief: false }, 40_000).catch(() => null);
        const self = me?.character ?? agent;   // `status.you` is null; the NAME is the target
        const done = [];
        for (const d of staging.deferred ?? []) {
          const buff = cat.get(d.name);
          await say(`${d.name} now.`);
          const r = await castVerified(agent, d.name,
            { target: buff?.scope === 'room' ? null : self, cost: buff?.mana ?? d.mana ?? null });
          done.push({ name: d.name, landed: r.landed, in_effect: r.in_effect, outcome: r.outcome, why: r.why });
          if (!r.landed && !r.in_effect)
            await say(`${d.name} did not take: ${String(r.why).slice(0, 70)}`);
        }
        st.deferred = { age_minutes: ageMin, cast: done };
        const up = done.filter(d => d.landed || d.in_effect).length;
        await say(`${up} of ${done.length} final buff(s) up. ` +
                  (healing ? 'I will hold back and heal.' : `Engaging ${target}.`));
        console.log(`  ${agent} staged buffs: ${up}/${done.length} up`);
        return true;
      }, 'the deferred preparation could not be finished'),

      // ---- 2b. THE ARMING GATE. Do not set out with a mundane weapon.
      //
      // OPERATOR DECISION, 2026-09-11: this is a REQUIREMENT rather than a capability. The
      // reason is the whole night — a raid that goes in mundane does not fail and does not
      // spin, it STALEMATES, which is the one failure mode that looks like success from the
      // outside. `fight` returns ok, returns a transcript, and the boss ends on full health.
      //
      // IT IS A GATE ON SETTING OUT, NOT A RETREAT RULE. A mundane raider already in the
      // fight should STAY in it: damage is floored at one point a swing (monster.kod:1562)
      // and the body is holding aggression off the healers. Gate at prep, report at contact,
      // never withdraw on this. See the first-contact step below, which reports and fights on.
      //
      // TWO SATISFIERS, because the operator named two and both are real:
      //   1. already wielding a weapon carrying ATCK_WEAP_MAGIC; or
      //   2. the fleet can arm it before the raid — somebody knows `enchant weapon` and has
      //      the reagents AND THE MANA for it.
      //
      // The mana half is not pedantry and is why it is checked: `enchant weapon` is 17 mana
      // against a 25 maximum (enchwp.kod:50), so a caster arms ONE weapon per mana cycle. A
      // fleet with four casters and twenty-one mundane weapons satisfies "has a caster" and
      // is still five cycles away from being armed. That exact gap is what walked seventeen
      // raiders at the ghost carrying mundane steel.
      verify(async ({ call, state: st }) => {
        if (!require_enchanted) { st.arming = { gated: false }; return true; }
        const say = text => call('say', { agent, type: channel, text: String(text).slice(0, 220) }, 30_000)
          .catch(() => {});

        // SATISFIER 1 — and it is UNKNOWN on prod, not false. The server never renames an
        // enchanted weapon, so only a loopback maintenance socket can read the flag.
        let mine = null;
        try {
          const dm = await import('../m59-dm.mjs');
          if (dm.isLoopbackHost?.(process.env.M59_HOST ?? '127.0.0.1')) {
            // `status` HAS NO `wielding` FIELD — it carries `equipment: ["long sword"]`, and
            // `wielding` lives on the FLEET row instead. Reading the wrong one made this whole
            // satisfier silently dead: String(undefined) is "undefined", nothing matched, every
            // raider looked mundane, and the gate passed everyone on satisfier 2 for the wrong
            // reason. That is the "status has two shapes" trap, which this repository has been
            // bitten by three times and which never errors — it just answers about nothing.
            const me = await call('status', { agent, brief: false }, 40_000).catch(() => null);
            const worn = (me?.equipment ?? [])
              .find(e => !/shield|helm|armor|armour|ring|amulet|cloak/i.test(String(e))) ?? null;
            const inv = await call('inventory', { agent }, 40_000).catch(() => null);
            const same = worn ? (inv?.items ?? []).filter(i =>
              String(i.name).toLowerCase() === String(worn).toLowerCase()) : [];
            // Two weapons of one name make the NAME useless, so that is unknown rather than
            // false — `equipment()` carries no object id to tell them apart.
            if (same.length === 1) {
              const out = String(await dm.dm([`show object ${same[0].id}`]));
              const at = Number((out.match(/piAttack_type\s+= INT (\d+)/) ?? [])[1] ?? 0);
              mine = (at & ATCK.WEAP_MAGIC) !== 0;
            } else if (same.length === 0) mine = false;
          }
        } catch { /* no socket, no read — stays unknown */ }
        if (mine === true) { st.arming = { ok: true, why: 'already wielding a magic weapon' }; return true; }

        // SATISFIER 2 — can the fleet arm the raiders who need it, counting MANA not casters,
        // and counting the WHOLE fleet rather than just this one weapon. Asking "can the fleet
        // arm ME" passes every raider independently while the fleet can only arm four of them.
        // Computed once for the run and shared; see surveyFleetArming.
        const survey = await surveyFleetArming(call);
        const casts = survey?.casts ?? 0, unarmed = survey?.unarmed ?? 0;
        if (unarmed === 0) { st.arming = { ok: true, why: 'every raider is confirmed armed' }; return true; }
        if (casts >= unarmed) {
          st.arming = { ok: true, unarmed, casts,
                        why: `${unarmed} raider(s) still need arming and the fleet has ${casts} cast(s) for it` };
          return true;
        }

        const why = `set out with a weapon the ${target} resists: ` +
          (mine === false ? 'this weapon is mundane' : 'cannot confirm this weapon is enchanted') +
          `, and the fleet has mana and reagents for ${casts} more enchant(s) against ` +
          `${unarmed} raider(s) still needing one. ` +
          'Run raid-arm or raid-prep buffs="enchant weapon" first, or pass ' +
          'require_enchanted=false to go anyway.';
        await say('I will not set out with a mundane weapon. Enchant first.');
        st.arming = { ok: false, why, casts_available: casts };
        return { ok: false, why };
      }, 'the arming gate could not be read'),

      // ---- 3. WALK IN. One hop at a time, so an arrival is reported per room rather than
      // as one opaque journey. `walk` carries fleetScript's health floor.
      // The hazard reason rides on EVERY hop, not just the last: the boss room may not be the
      // only listed room on the way in, and a journey refused three rooms out is refused
      // just as completely as one refused at the door.
      ...hops.map(h => ({ do: 'walk', to: h,
                          ...(despite_hazard ? { despiteHazard: despite_hazard } : {}) })),

      // ---- 3a. CLOSE ON THE BOSS. THE STEP THAT WAS MISSING THE WHOLE TIME.
      //
      // Arriving in the room is not arriving at the fight. The throne room is 23 rows deep:
      // raiders enter at the top, and the ghost was measured at r22c5 with every raider at
      // row 1 or 2 — DISTANCE 20 TO 21 SQUARES against a melee reach of 2 to 3. Every swing
      // all night came back "The ghost of Far'Nohl is too far away to hit with a hammer",
      // which is the server saying plainly that nobody was ever in the fight.
      //
      // Why it went unnoticed for five attempts: `attack` swings from where you stand and
      // reports messages, so it looks like combat; and `fight`, which DOES walk to a square
      // beside the target, bails out on `stale_identity` before its approach ever runs. Two
      // tools, one that cannot approach and one that never got far enough to try.
      //
      // Positions are read fresh here rather than computed once, because the ghost is
      // AI_MOVE_WALKTHROUGH_WALLS and does not wait where it spawned.
      //
      // AN ESCORT RAIDER SKIPS THIS AND THE PROBE BELOW. Both are about the BOSS — closing on
      // it, and reading its resistance band off one swing — and neither means anything against
      // a tusked skeleton. Its melee loop does its own closing, on whatever is nearest.
      ...(escorts.includes(agent) ? [] : [
      verify(async ({ call, state: st }) => {
        const say = text => call('say', { agent, type: channel, text: String(text).slice(0, 220) }, 30_000)
          .catch(() => {});
        // A LEGAL TARGET SAYS SO. Matching the NAME alone finds "logoff ghost" — a
        // logged-off player's body, which matches "Ghost" and is often nearer than the boss.
        // A raider that picks one spends the whole fight hearing "You can't attack the logoff
        // ghost." with a distance and a swing count to show for it. `can` is the server's own
        // answer to "may I swing at this", so it rules out the furniture and the drops too.
        const ghostOf = async () => {
          const look = await call('look', { agent }, 40_000).catch(() => null);
          const g = (look?.objects ?? []).find(o =>
            new RegExp(target, 'i').test(o.name ?? '') && (o.can ?? []).includes('attack'));
          return g ? { col: g.col, row: g.row, distance: g.distance } : null;
        };
        let g = await ghostOf();
        if (!g) { st.approach = { ok: false, why: `cannot see ${target} in this room` }; return true; }

        // SPREAD, rather than twenty-one bodies aiming at one square. A ring of eight around
        // the boss, picked by a stable index so two raiders do not choose the same spot — the
        // operator's own correction: 2-4 fit in a coarse square, so 8 squares holds 21.
        const RING = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
        const slot = RING[(Number(String(agent).replace(/\D/g, '')) || 0) % RING.length];

        // AND STAND UP BEFORE WALKING. A resting character's MOVE is bounced SILENTLY
        // (user.kod:2988 puts it back on the square it is already on and returns) — unlike an
        // attack, which is refused out loud. So a seated raider walks nowhere, the distance
        // does not improve, and the loop below concluded "stuck at 20 squares — geometry".
        // It was posture. Four of twenty-one raiders reached melee in the run that found this.
        await call('rest', { agent, stand: true }, 30_000).catch(() => {});

        const deadline = Date.now() + 120_000;
        let last = g.distance, stalls = 0;
        while (Date.now() < deadline) {
          g = await ghostOf();
          if (!g) break;
          if (g.distance <= 2) break;                       // in reach
          await call('walk_to', { agent, col: g.col + slot[0], row: g.row + slot[1] }, 90_000)
            .catch(() => {});
          const now = await ghostOf();
          if (!now) break;
          // NO PROGRESS IS AN ANSWER — but not on the first try. A body in the way is the
          // normal case in a room with twenty other raiders in it, and one non-improving step
          // used to end the approach for good. Three strikes, and each one stands up again,
          // because the commonest reason a step gains nothing is that the keeper sat the
          // character down between rounds.
          if (now.distance >= last) {
            if (++stalls >= 3) { st.approach = { ok: false, stuck_at: now.distance }; break; }
            await call('rest', { agent, stand: true }, 30_000).catch(() => {});
          } else { stalls = 0; }
          last = Math.min(last, now.distance);
        }
        const end = await ghostOf();
        st.approach = { ok: (end?.distance ?? 99) <= 3, distance: end?.distance ?? null, ...st.approach };
        if (st.approach.ok) await say(`In reach of ${target}.`);
        else console.log(`  !! ${agent} could not close on ${target} (distance ${end?.distance ?? '?'})`);
        return true;
      }, 'the approach could not be read back'),

      // ---- 3b. FIRST CONTACT IS A MEASUREMENT. One swing, then read the sentence.
      //
      // THE INCIDENT THIS EXISTS FOR. Seventeen raiders reported the action phase complete
      // against a boss that finished on 233 of 233 health. Nothing lied: `fight` returned ok
      // and returned a combat transcript. What nobody read was the transcript, which had been
      // saying the answer all along — "The ghost of Far'Nohl laughs off your pitiful blow."
      //
      // That sentence is `player_hit_immunity` (player.kod:208), selected at :9703 when the
      // target's resistance to what you just dealt is above 60. The ghost resists
      // ATCK_WEAP_NONMAGIC at 90 and ATCK_WEAP_MAGIC at -50 (ghost.kod:87-88), so the two
      // states are DIFFERENT SENTENCES: "laughs off your pitiful blow" means the weapon in
      // this hand is mundane, and "staggers backwards from the blow" means the enchantment is
      // live. One swing distinguishes them.
      //
      // It is the only prod-safe way to ask. The server never renames an enchanted weapon and
      // `equipment()` reports names without ids, so the flag itself is unreadable — which is
      // exactly why `inEffect()` answers null for weapon scope. The unreadable flag and the
      // readable sentence are the same mechanic from two sides. (Thanks to the FleetScratch
      // session for the observation.)
      //
      // IT DOES NOT REFUSE. A raider swinging a mundane weapon is still worth having in the
      // room — it holds aggression and it is one more body between the boss and the healers.
      // It reports, loudly, so the raid knows whether it is fighting or performing.
      verify(async ({ call, state: st }) => {
        const say = text => call('say', { agent, type: channel, text: String(text).slice(0, 220) }, 30_000)
          .catch(() => {});
        // AIM AT THE OBJECT `look` JUST RETURNED, NOT AT THE WORD.
        //
        // `attack` resolves a NAME in the broker, against the broker's snapshot of the room —
        // and a snapshot that has not caught up throws `nothing here matches "Ghost"`, which
        // this used to swallow into an empty transcript indistinguishable from a quiet swing.
        // An id read from a live `look` one line earlier is not a stored id (the thing this
        // fleet was burned by): it is re-resolved at the moment of use, every time.
        const seen = await call('look', { agent }, 40_000).catch(() => null);
        const here = (seen?.objects ?? []).find(o =>
          new RegExp(target, 'i').test(o.name ?? '') && (o.can ?? []).includes('attack'));
        // Standing, for the same reason the melee loop stands: a seated character's swing is
        // refused with a sentence that reads like combat, and first contact is the one swing
        // whose transcript the whole arming decision rests on.
        if (here) await call('rest', { agent, stand: true }, 30_000).catch(() => {});
        let probe = here
          ? await call('attack', { agent, target: here.id, swings: 2 }, 60_000)
              .catch(e => ({ error: e.message }))
          : { error: `${target} is not in this room to swing at` };
        if (probe?.could_not_swing) {
          await call('rest', { agent, stand: true }, 30_000).catch(() => {});
          probe = await call('attack', { agent, target: here.id, swings: 2 }, 60_000)
            .catch(e => ({ error: e.message }));
        }
        if (probe?.error) console.log(`  ?  ${agent} first contact refused: ${probe.error}`);
        const lines = probe?.combat ?? probe?.messages ?? probe?.lines ?? [];
        const magic = blowLandedAsMagic(lines, GHOST_OF_FARNOHL);
        st.first_contact = { magic, lines: lines.slice(0, 6) };
        if (magic === false) {
          await say('My weapon is MUNDANE — it is laughing off my blows. I need an enchant.');
          console.log(`  !! ${agent} is swinging a mundane weapon: ${lines.find(l => /laughs off/i.test(l)) ?? ''}`);
        } else if (magic === true) {
          await say('Enchantment is live — it staggers.');
        } else {
          console.log(`  ?  ${agent} first contact said nothing conclusive about the weapon`);
        }
        return true;
      }, 'first contact could not be read'),
      ]),

      // ---- 4. FIGHT, OR HEAL.
      //
      // `equip: false` deliberately. `fight` otherwise wields "the best weapon you are
      // carrying", scored on the weapon's own numbers — and an enchantment is an ITEM
      // ATTRIBUTE rather than a damage bonus, so the scorer cannot see it. Against this boss
      // that swap is a fifteenfold downgrade (ghost.kod:83) and it would undo the entire prep
      // phase on the way into the fight.
      healing
        ? verify(async ({ call, state: st }) => {
            const say = text => call('say', { agent, type: channel, text: String(text).slice(0, 220) }, 30_000)
              .catch(() => {});
            const spell = buffCatalogue().find(b => b.name === String(heal_spell).toLowerCase());
            st.healed = await tendTheWounded({
              call, agent, say, spell: heal_spell,
              forMs: Math.max(60_000, Number(rounds) * 8000),
              below: Number(heal_below), mana: spell?.mana ?? 4,
            });
            const landed = st.healed.filter(h => h.landed).length;
            await say(`${landed} heal(s) landed on ${new Set(st.healed.map(h => h.on)).size} raider(s).`);
            const why = {};
            for (const h of st.healed) if (!h.landed) why[h.outcome ?? 'unclassified'] = (why[h.outcome ?? 'unclassified'] ?? 0) + 1;
            console.log(`  ${agent} healed: ${landed}/${st.healed.length} cast(s) landed` +
                        (Object.keys(why).length ? `  failures: ${JSON.stringify(why)}` : '') +
                        (st.healed.find(h => !h.landed)?.why ? `  e.g. "${String(st.healed.find(h => !h.landed).why).slice(0, 90)}"` : ''));
            return true;
          }, 'the healer could not be read back')
        : verify(async ({ call, state: st }) => {
            // A MELEE LOOP, BECAUSE THE BOSS DOES NOT STAND STILL AND NEITHER TOOL HANDLES IT.
            //
            // `fight` would do this — it walks to a square beside the target, faces it and
            // swings — but it returns `stale_identity` after one round against a keeper-backed
            // character, because it runs in the BROKER against a snapshot. `attack` swings
            // honestly but only from where you are standing. So: close, swing, and close
            // again, re-reading the boss's position every round.
            //
            // Measured: one walk took a raider from 21 squares to 1, and the very next swings
            // were "too far away" again because the ghost had hit it and stepped off. A single
            // approach is not a fight.
            const say = text => call('say', { agent, type: channel, text: String(text).slice(0, 220) }, 30_000)
              .catch(() => {});
            // Attackable only — see the approach step. "logoff ghost" matches "Ghost".
            //
            // AND THE ESCORT IS A ROLE, NOT A DISTRACTION. The throne room generates a tusked
            // skeleton about every twelve seconds while a player is standing in it, to a cap of
            // nine (ten minus the ghost, which counts). Raiders named in `escort` fight THOSE
            // and never the boss: same loop, same standing, same ring — only the target picker
            // differs, so the two roles are measured on identical machinery.
            const onEscort = escorts.includes(agent);
            const ghostOf = async () => {
              const look = await call('look', { agent }, 40_000).catch(() => null);
              const attackable = (look?.objects ?? []).filter(o => (o.can ?? []).includes('attack')
                                                                  && !o.is_player);
              const isBoss = o => new RegExp(target, 'i').test(o.name ?? '');
              const g = onEscort
                // nearest thing that is NOT the boss; the boss is somebody else's job
                ? attackable.filter(o => !isBoss(o))
                    .sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0]
                : attackable.find(isBoss);
              return g ? { id: g.id, col: g.col, row: g.row, distance: g.distance,
                           name: g.name } : null;
            };
            const heard = [];
            let lastTooFar = false, swings = 0, closes = 0, landed = 0, tooFar = 0, roomCasts = 0, stuckAt = null;
            // A REFUSED CALL IS NOT A SWING, AND COUNTING IT AS ONE HID THE WHOLE PROBLEM.
            //
            // `swings += 2` used to run whether or not `attack` came back, and the call was
            // `.catch(() => null)` — so a run that never landed a blow reported swings=590,
            // landed=0, and read as "we are hitting it and the damage is not registering".
            // It was the opposite: the swings were never taken. Refusals are counted and the
            // first few reasons are kept, because a refusal that cannot say why gets blamed
            // on the fight.
            let refused = 0, stoodUp = 0;
            const refusals = [];
            const roomFailed = [];

            for (let round = 0; round < Math.max(1, Number(rounds)); round++) {
              const me = await call('status', { agent, brief: true }, 30_000).catch(() => null);
              const hp = me?.hp ?? me?.vitals?.health;
              const frac = hp && hp.max ? hp.value / hp.max : 1;
              // The keeper still owns survival; this is the raid's own line on top of it.
              if (frac < Number(disengage_at)) { await say('Breaking off, too hurt.'); break; }

              // KEEP THE ROOM ENCHANTMENT UP. Only one raider does this, and only here: a room
              // enchantment affects the room it was cast in and nothing else, which is why it
              // could never be part of prep. `forces of light` lasts 6s to ~3.4min depending on
              // spell power (forceslt.kod GetDuration), so it needs re-casting mid-fight.
              //
              // Attempting it every round is CHEAP BY DESIGN: if it is already up the game
              // refuses in CanPayCosts before taking payment — "This place is already infused
              // with the spirit of Shal'ille." — so the only casts that cost anything are the
              // ones that were needed.
              if (String(room_caster) === agent) {
                // STAND FIRST. `IsResting` sets PFLAG_NO_MAGIC as well as PFLAG_NO_FIGHT
                // (player.kod:1161-1166), and a refused cast costs nothing — so this is one
                // cheap packet against a room enchantment that otherwise never goes up at all.
                // Measured: `forces of lightx0` across a whole run, with mana and reagents
                // untouched, from a caster the keeper had sat down.
                await call('rest', { agent, stand: true }, 30_000).catch(() => {});
                const r = await castVerified(agent, room_enchant, { target: null });
                if (r.landed) { await say(`${room_enchant} is up.`); roomCasts++; }
                else if (!r.in_effect) roomFailed.push(r.why);
              }

              const g = await ghostOf();
              if (!g) break;                                  // dead, or gone from the room
              // A "TOO FAR AWAY" IS AN ORDER TO CLOSE, WHATEVER `look` SAID. The ghost staggers
              // backwards from a blow, and reach at the fine grid is not two whole squares: on the
              // 2026-09-25 rehearsal two raiders reported closes=0 too_far=10 — twenty swings from a
              // square `look` called distance 2, none of them landing. After a refusal on reach,
              // walk in until the ghost is adjacent before swinging again.
              if (g.distance > (lastTooFar ? 1 : 2)) {
                lastTooFar = false;
                // ROTATE THE APPROACH SQUARE. Aiming at the same offset every round is how a
                // raider sits at distance 4 for ever: measured, six consecutive walks to
                // (col, row-1) against a ghost on its spawn point at r2c5, all six ending at
                // distance 4 because that one square is not reachable. The boss is not always
                // in open floor — on the dais, in a corner, behind the throne — so try the
                // ring rather than one guess, and let the offset change on every attempt.
                const RING = [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]];
                const o = RING[closes % RING.length];
                await call('walk_to', { agent, col: g.col + o[0], row: g.row + o[1] }, 60_000)
                  .catch(() => {});
                closes++;
                // GIVE UP OUT LOUD rather than silently. A raider that cannot reach the boss
                // after a full turn of the ring is stuck on geometry, not unlucky, and should
                // say so instead of burning the rest of the fight on walk attempts.
                if (closes >= RING.length * 2) {
                  const now = await ghostOf();
                  if ((now?.distance ?? 99) > 2) {
                    stuckAt = now?.distance ?? null;
                    await say(`I cannot reach ${target} — stuck at ${stuckAt} squares.`);
                    break;
                  }
                }
                continue;                                     // re-read before swinging
              }
              // `g.id` comes from the `look` three lines up — live, this round, never stored.
              const r = await call('attack', { agent, target: g.id, swings: 2 }, 60_000)
                .catch(e => ({ error: e.message }));
              if (r?.error) {
                refused++;
                if (refusals.length < 3) refusals.push(r.error);
                continue;
              }
              const msgs = r?.messages ?? [];
              heard.push(...msgs);
              // SITTING DOWN IS WHY landed READ ZERO THROUGH THREE WHOLE SIMULATIONS.
              //
              // "You find yourself unable to lift your weapon." is PFLAG_NO_FIGHT, and
              // `ResetPlayerFlagList` sets that flag for anybody who `IsResting`
              // (player.kod:1161-1165). It is not exhaustion and not a miss: the character is
              // sitting down, and every swing for the rest of the fight is refused in a
              // sentence that reads like combat.
              //
              // The commander claim does not stop it. A claim takes work, movement and
              // economy; RECOVERY stays with the keeper on purpose, and a keeper's answer to a
              // hurt character in a room it thinks is safe is to sit it down. Same mechanic
              // that ate the 30-second enchant-weapon trances earlier in this raid, arriving
              // from the other end.
              //
              // So stand up and take the round again. `attack` already flags it — the tool
              // even says what to do — and nothing was reading the flag.
              if (r?.could_not_swing || msgs.some(m => /unable to lift your weapon/i.test(m))) {
                stoodUp++;
                await call('rest', { agent, stand: true }, 30_000).catch(() => {});
                continue;                                   // the round was refused, not swung
              }
              swings += 2;
              if (msgs.some(m => /too far away/i.test(m))) { tooFar++; lastTooFar = true; }
              // THE SUBJECT IS THE WEAPON, NOT YOU. The server says "Your hammer crushes the
              // ghost of Far'Nohl." — so a pattern looking for "you crush" matches nothing and
              // reported landed=0 through a run that took the boss from 233 to 161. A counter
              // that reads zero while 72 damage lands is the instrument, not the fight.
              //
              // Captured verbatim rather than guessed: hits are "Your <weapon> <verb>s the
              // <target>", misses are "<target> avoids/dodges your attack", and incoming is
              // "<target> wounds you with its attack".
              if (msgs.some(m => /^your\s+\S+.*\b\w+s\s+(the\s+)?/i.test(m)
                                 && !/concentration/i.test(m))) landed++;
            }

            // COUNT THE HITS FROM THE WHOLE TRANSCRIPT, not only from the rounds that reached
            // the counter. `landed` is incremented per round and every `continue` above it —
            // a refused call, a seated swing, a close — skips it, so the per-round number is a
            // floor and not a total. This is the total, and printing both makes the gap
            // visible instead of leaving a zero to be interpreted.
            const hitLines = heard.filter(m => /^your\s/i.test(m) && !/concentration|unable to lift/i.test(m));
            // What the log says about the weapon, which is the only prod-safe read there is.
            const magic = blowLandedAsMagic(heard, GHOST_OF_FARNOHL);
            st.melee = { swings, closes, landed, too_far: tooFar, weapon_magic: magic,
                         ...(refused ? { refused, refusals } : {}),
                         ...(stoodUp ? { stood_up: stoodUp } : {}),
                         ...(stuckAt != null ? { stuck_at: stuckAt } : {}),
                         room_casts: roomCasts,
                         ...(roomFailed.length ? { room_enchant_failed: roomFailed.slice(0, 3) } : {}),
                         hits: hitLines.length, heard: heard.length,
                         said: heard.slice(-8) };
            console.log(`  ${String(agent).padEnd(9)} ${onEscort ? 'ESCORT' : 'boss  '} ` +
                        `swings=${swings} closes=${closes} ` +
                        `landed=${landed} hits=${hitLines.length}/${heard.length} ` +
                        `too_far=${tooFar} magic=${magic}` +
                        (stoodUp ? ` stood_up=${stoodUp}` : '') +
                        (refused ? ` refused=${refused} (${refusals[0] ?? '?'})` : '') +
                        (stuckAt != null ? ` STUCK@${stuckAt}` : '') +
                        (String(room_caster) === agent ? ` ${room_enchant}x${roomCasts}` : '') +
                        (heard.length ? ' | ' + JSON.stringify(heard.slice(0, 3)) : ''));
            return true;
          }, 'the melee could not be read back'),
    ];
  },
};
