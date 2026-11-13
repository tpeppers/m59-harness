// Offline comparison scenarios. Every from/goal/body x/y uses KOD/protocol
// units (64 per square); minimumFloor uses CLIENT geometry height units.
// No scene below is a live observation. Recorded fixtures remain frozen.
import { readFileSync } from 'node:fs';

const fixture = name => JSON.parse(readFileSync(new URL(`../../tools/fixtures/${name}`, import.meta.url), 'utf8'));
const bodiesOf = scene => (scene.bodies ?? []).map(({ id, x, y, flags }) => ({ id, x, y, flags }));
const point = ({ x, y }) => ({ x, y });

/**
 * Return independent case data for one explicitly selected baked map.
 * A successful route means reaching this exact goal (with the runner's common
 * tolerance), never merely reaching a refuge prefix or an occupied guide point.
 * Expected connectivity is deliberately not encoded: compare checked outcomes.
 */
export function benchmarkCases(map) {
  const merb = fixture('merb-recovery-2503.json');
  const occupied = fixture('konima-occupied-stage-2505.json');
  const returning = fixture('konima-return-approach-2505.json');
  const hollows = fixture('hollows-occupied-guide-2502.json');
  const flatFrom = { x: 736, y: 992 }, flatGoal = { x: 736, y: 2272 };
  const gateFrom = { x: 3808, y: 416 }, gateGoal = { x: 160, y: 4640 };
  const cases = [
    {
      id: 'flat-535-forward', room: 535, from: flatFrom, goal: flatGoal,
      bodies: [], selfId: 1, kind: 'flat-control',
      source: 'Committed room535 geometry-derived control at r15c11 to r35c11. All 160 consecutive eight-protocol-unit no-slide traces accepted; every sampled floor was client height832. No recorded player position.'
    },
    {
      id: 'flat-535-reverse', room: 535, from: flatGoal, goal: flatFrom,
      bodies: [], selfId: 1, kind: 'flat-control',
      source: 'Reverse of the geometry-derived flat-535-forward control. This direction is evaluated independently; no symmetric connectivity assumption.'
    },
    {
      id: 'ancient-579-ledge-walk', room: 579,
      from: { x: 2083, y: 2569 }, goal: { x: 2117, y: 2461 },
      bodies: [], selfId: 1, minimumFloor: 7040, kind: 'recorded-ledge-walk',
      source: 'substrate/m59-falljumps.json room579 jump1 to_fine client{x:32304,y:40080} to jump2 from_fine client{x:32848,y:38352}, converted exactly to protocol units. Operator-recorded walking approach between declared jumps; floors7040 to10880. This case includes no jump and forbids a valley shortcut below7040.'
    },
    {
      id: 'ancient-579-proved-narrow-band', room: 579,
      from: { x: 2077, y: 2416 }, goal: { x: 2255, y: 2416 },
      bodies: [], selfId: 1, minimumFloor: 7040, kind: 'proved-narrow-band-control',
      source: 'tools/m59-fineroute.mjs:256-270 describes the operator-recorded client segment{x:32200,y:37638} to{x:35055,y:37638}. This case uses its nearest integer-wire endpoints, protocol{x:2077,y:2416} to{x:2255,y:2416}; these are derived quantized endpoints, not claimed exact historical observations. Independently checked through compare.mjs assessPath on committed geometry: all23 no-slide quantized microsteps accepted,2.78125 squares, endpoint floors7040. Shifting the line one protocol unit south blocks at check3; one unit north crosses below the7040 floor fence at check10. No new path search supplies this positive witness.'
    },
    {
      id: 'merb-2503-west-crossing', room: 2503,
      from: { x: 4928, y: 3880 }, goal: { x: 96, y: 3680 },
      bodies: [], selfId: 1, kind: 'room-crossing',
      source: 'tools/m59-fine-safeleg-test.mjs:163-167 merbNorthWall and first merbFineExit opening. Existing test proves a refuge prefix within36 squares, rather than full arrival. This comparison separately asks for the complete exact-goal route.'
    },
    {
      id: 'merb-2503-recorded-recovery', room: 2503,
      from: point(merb.from), goal: { x: 3488, y: 2744 },
      bodies: bodiesOf(merb), selfId: merb.from.id, kind: 'recorded-local-recovery',
      source: 'tools/fixtures/merb-recovery-2503.json recorded native scene. Refuge square r42c54 is pinned by tools/m59-fine-refuge-reach-test.mjs:75-97. Exact goal{x:3488,y:2744} is the offline collision-checked endpoint derived with planBodyDetour to that square using the unchanged captured bodies; it is not a claimed recorded arrival.'
    },
    {
      id: 'konima-2505-open-gate', room: 2505,
      from: gateFrom, goal: gateGoal, bodies: [], selfId: 1,
      doorOpen: true, kind: 'door-state-control',
      source: 'tools/m59-fine-safeleg-test.mjs:45-60 arrival and exact fineCut goal. Open only door server tag1 at ceiling height1150 through the existing ceiling-door helper. Same endpoints as the closed case.'
    },
    {
      id: 'konima-2505-closed-gate', room: 2505,
      from: gateFrom, goal: gateGoal, bodies: [], selfId: 1,
      doorOpen: false, kind: 'door-state-control',
      source: 'tools/m59-fine-safeleg-test.mjs:45-60 arrival and exact fineCut goal, with unmodified baked closed-door geometry. Same endpoints as the open case; no open guide may authorize a closed edge.'
    },
    {
      id: 'konima-2505-occupied-exact-stage', room: 2505,
      from: point(occupied.from), goal: point(occupied.target),
      bodies: bodiesOf(occupied), selfId: occupied.from.id,
      avoidSquares: [...occupied.avoid_squares], kind: 'recorded-occupied-goal',
      source: 'tools/fixtures/konima-occupied-stage-2505.json: sanitized populated cohort24 scene dated2026-10-15. tools/m59-fine-traffic-refuge-test.mjs:37-50 checks that a follower waits while the exact goal is occupied. A partial route or another refuge is not exact-goal success.'
    },
    {
      id: 'konima-2505-freed-exact-stage', room: 2505,
      from: point(occupied.from), goal: point(occupied.target),
      bodies: [], selfId: occupied.from.id,
      avoidSquares: [...occupied.avoid_squares], kind: 'cleared-scene-control',
      source: 'Same endpoints and mandatory avoidance as konima-2505-occupied-exact-stage, with all bodies removed. This is a synthetic counterfactual control, not a second recorded scene; tools/m59-fine-traffic-refuge-test.mjs:49-50 checks the freed geometry route.'
    },
    {
      id: 'konima-2505-recorded-return-approach', room: 2505,
      from: point(returning.from), goal: point(returning.target),
      bodies: bodiesOf(returning), selfId: returning.from.id,
      minimumFloor: returning.minimumFloor, kind: 'recorded-local-approach',
      source: 'tools/fixtures/konima-return-approach-2505.json: last healthy confirmed cohort24 return approach dated2026-10-15, with unchanged frozen bodies and its declared client-height floor fence.'
    },
    {
      id: 'hollows-2502-occupied-exact-guide', room: 2502,
      from: point(hollows.from), goal: point(hollows.goal),
      bodies: bodiesOf(hollows), selfId: hollows.from.id, kind: 'recorded-occupied-goal',
      source: 'tools/fixtures/hollows-occupied-guide-2502.json and tools/m59-fine-traffic-refuge-test.mjs:87-91. The exact original guide is occupied by the retained shadowbeast. Reaching the next guide must not be reported as reaching this exact point.'
    },
    {
      id: 'hollows-2502-next-guide', room: 2502,
      from: point(hollows.from), goal: point(hollows.next),
      bodies: bodiesOf(hollows), selfId: hollows.from.id, kind: 'recorded-guide-continuation',
      source: 'Same frozen bodies and start as hollows-2502-occupied-exact-guide; goal is the separately authored next guide from tools/fixtures/hollows-occupied-guide-2502.json. This compares a complete route to that goal, without implicitly skipping an exact destination.'
    }
  ];
  for (const item of cases) {
    if (!map?.rooms?.[item.room]?.roo) throw new Error(`Benchmark room ${item.room} has no baked geometry`);
  }
  // Return fresh points and lists even where controls share literal inputs.
  return cases.map(item => ({ ...item, from: { ...item.from }, goal: { ...item.goal },
    bodies: item.bodies.map(body => ({ ...body })),
    ...(item.avoidSquares ? { avoidSquares: [...item.avoidSquares] } : {}) }));
}
