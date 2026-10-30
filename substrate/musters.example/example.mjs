// THE SHAPE OF A MUSTER SPEC (m59-preflight.mjs, fleetscripts/muster-run.mjs). Copy to substrate/musters/<name>.mjs.
// A spec is orders, so the real ones are machine-local; this one is read only when nothing of that name exists there.
export default {
  name: 'example',
  about: 'an example muster: island characters, fed and rested, two castings of create food each',
  exclude: ['hk1'],                                // agents never taken (a clone fleet translates prod names)
  rooms: r => r >= 2000 && r < 2700,               // candidates: where they stand
  startRooms: [2001, 2101],                        // where the operation can start (preparing needs a no-combat room)
  target: { health: 0.9, vigor: 80, meals: 4, fightAboveVigor: 60 },
  casts: { 'create food': 2 },                     // every knower carries the reagents for this many castings
  items: {},                                       // { '<item or class>': n } for everyone
  require: ['meal'],                               // a shortfall of these leaves the character home, named
  keep: { meal: 2 },                               // what a donor keeps beyond its own need
  maxHops: 3,                                      // sources further than this are reported, never planned
  operation: { script: 'come-home', params: { home: 2001 } },   // the FleetScript the ready ones are handed to
  accept: [],
};
