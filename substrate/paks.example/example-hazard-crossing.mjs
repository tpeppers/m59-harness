// THE SHAPE OF A PAK (tools/m59-joints.mjs). A committed EXAMPLE: it lives beside substrate/paks/, never in
// it, so nothing loads it unless this machine copies it in and names it in substrate/paks-<fleet>.json.
//
//   node tools/m59-joints.mjs check example-hazard-crossing
//   node tools/m59-joints.mjs dry   example-hazard-crossing      runs the scenarios below
//
// A pak names the joints it answers. An answer is a list of rules, tried in order, first match wins; a rule's
// `when` is a condition over the joint's facts (`node tools/m59-joints.mjs joints` lists them), and `then`
// is one of the joint's closed set of answers. Options are the pak's knobs; an assignment can override them.
export default {
  name: 'example-hazard-crossing',
  about: 'step through one square of a wall of fire when resistant and healthy; otherwise avoid it as always',
  options: { min_health_pct: 50, max_worst_hit_pct: 25 },
  joints: {
    'movement.hazard': [
      { name: 'only walls we can price',
        when: ['hazard', 'missing'], then: { do: 'default' } },
      { name: 'one worst-case tick is affordable',
        when: { all: [['self.health_pct', '>=', '$options.min_health_pct'],
                      (f, ctx) => f.hazard.worst_hit <= (f.self.max_health ?? 0) * ctx.options.max_worst_hit_pct / 100] },
        then: (f, ctx) => {
          ctx.branch('crossing', { worst: f.hazard.worst_hit, resist: f.hazard.resist_pct, health: f.self.health });
          return { do: 'cross', why: `worst ${f.hazard.worst_hit} of ${f.self.health} health` };
        } },
    ],
  },
  scenarios: {
    'healthy, resistant': { joint: 'movement.hazard', expect: { do: 'cross' },
      facts: { effect: { kind: 'firewall' }, self: { health: 120, max_health: 120, health_pct: 100 },
               hazard: { worst_hit: 8, resist_pct: 50 } } },
    'hurt': { joint: 'movement.hazard', expect: null,
      facts: { effect: { kind: 'firewall' }, self: { health: 30, max_health: 120, health_pct: 25 },
               hazard: { worst_hit: 16, resist_pct: 0 } } },
    'a cloud nobody can price': { joint: 'movement.hazard', expect: null,
      facts: { effect: { kind: 'poison_or_spore_cloud' }, self: { health: 120, max_health: 120, health_pct: 100 }, hazard: null } },
  },
};
