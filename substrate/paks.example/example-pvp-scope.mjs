// THE SHAPE OF A PVP SCOPE PAK (tools/m59-combat-assist.mjs). A committed EXAMPLE: it lives beside substrate/paks/,
// never in it, so nothing loads it unless this machine copies it in and names it in substrate/paks-<fleet>.json.
//
//   node tools/m59-joints.mjs check example-pvp-scope
//   node tools/m59-joints.mjs dry   example-pvp-scope
//
// It knows no faction and no enemy. It does the least a pak can do with the three joints: a player the server will
// not let us hit is swung at once and then left alone (pvp.refused), and while only such players are left it heals the
// most hurt fleet-mate present with whatever heal it can pay for, one healer per ally per round (pvp.assist).
export default {
  name: 'example-pvp-scope',
  about: 'one probe at a player we cannot hit; then heal the most hurt ally, one healer per ally per round',
  options: { heal_below_pct: 60, heals: ['minor heal'], round_ms: 2000 },
  joints: {
    'pvp.refused': [
      { name: 'one probe is enough', then: f => ({ do: 'indirect', why: `refused: ${f.text}` }) },
    ],
    'pvp.assist': [
      { name: 'heal the most hurt ally we can pay for',
        when: (f, ctx) => !f.me.casting && f.me.ready_in_ms === 0,
        then: (f, ctx) => {
          const heal = ctx.options.heals.find(h => f.me.castable.includes(h));
          const hurt = f.allies.filter(a => Number.isFinite(a.health_pct) && a.health_pct < ctx.options.heal_below_pct)
            .sort((a, b) => a.health_pct - b.health_pct)[0];
          if (!heal || !hurt || (f.room_flags.no_combat && !hurt.self)) return null;
          const round = Math.floor(ctx.now / ctx.options.round_ms);
          return { do: 'cast', spell: heal, target: hurt.self ? 'self' : hurt.name,
            claim: { key: `${heal}|${hurt.name.toLowerCase()}|${round}`, ms: ctx.options.round_ms }, why: `${hurt.name} at ${hurt.health_pct}%` };
        } },
      { name: 'otherwise wait', then: { do: 'wait', ms: 1000 } },
    ],
  },
  scenarios: {
    'a refusal': { joint: 'pvp.refused', expect: { do: 'indirect' },
      facts: { text: 'Good thing your safety was on!', target: { name: 'A Stranger', probes: 1 } } },
    'an ally at 30%': { joint: 'pvp.assist', expect: { do: 'cast' },
      facts: { room_flags: { no_combat: false }, me: { casting: false, ready_in_ms: 0, castable: ['minor heal'] },
        allies: [{ name: 'Us', self: true, health_pct: 90 }, { name: 'Ally', self: false, health_pct: 30 }] } },
    'nobody hurt': { joint: 'pvp.assist', expect: { do: 'wait' },
      facts: { room_flags: { no_combat: false }, me: { casting: false, ready_in_ms: 0, castable: ['minor heal'] },
        allies: [{ name: 'Us', self: true, health_pct: 90 }] } },
  },
};
