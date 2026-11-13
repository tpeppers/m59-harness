// Offline acceptance objectives. CLIENT points use 1024 units/square; square
// identities are 1-based row/col. Route evidence never grants node ownership.
import { STONES } from './m59-stones.mjs';
import { RoomGeometry } from './m59-roo.mjs';
import { applyCeilingDoors, previewOpenedDoor } from './m59-ceiling-doors.mjs';

const point = (x, y) => ({ kind: 'point', x, y, units: 'client' });
const square = (row, col) => ({ kind: 'square', row, col });
const range = (row, col, within) => ({ kind: 'range', row, col, within });
const promoted = new Set(['victoria', 'sentinel', 'ancient', 'badlands', 'cave']);
const details = {
  victoria: { routeStatus: 'quiet-native-connected', approachGoal: point(46320, 12848),
    entry: point(28160, 7680), returnGoal: point(26912, 8176),
    requirements: [], source: '.claude/skills/node-runner/nodes/victoria.md:3-18' },
  sentinel: { routeStatus: 'quiet-native-connected', approachGoal: point(31760, 45088),
    entry: point(43520, 20992), returnGoal: point(112, 43040),
    requirements: ['running declared fall r35c16 -> r38c19', 'enter from room599; return through west exit to579'],
    source: '.claude/skills/node-runner/nodes/sentinel.md:3-23' },
  ancient: { routeStatus: 'quiet-native-connected', approachGoal: point(29952, 52256),
    entry: point(72192, 39424), returnGoal: point(16432, 0),
    requirements: ['three declared running falls', 'third fall uses timed gravity and sliding', 'wire endpoint must retain its shelf'],
    source: '.claude/skills/node-runner/nodes/ancient.md:13-42' },
  badlands: { routeStatus: 'native-connected', approachGoal: point(46080, 64448),
    entry: point(53760, 512), returnGoal: point(54208, 960),
    requirements: ['known strict fine route; ordinary coarse route can stay under the mesa', 'return historically required 64-unit flood cap1500000'],
    source: '.claude/skills/node-runner/nodes/badlands.md:70-79; docs/m59-node-tour.md' },
  cave: { routeStatus: 'quiet-native-connected-experimental-fall', approachGoal: point(53760, 23040),
    entry: point(46592, 57856), returnGoal: square(57, 45),
    requirements: ['inferred running fall r36c46 -> r34c46 remains experimental', 'exit staging must be followed by a separate normal crossing to587'],
    source: '.claude/skills/node-runner/nodes/cave.md:3-26; docs/m59-node-tour.md' },
  peak: { routeStatus: 'quiet-native-entrance-round-trip', approachGoal: square(20, 17),
    entry: point(31232, 50688), upperEntry: point(5824, 24000), returnGoal: square(50, 31),
    requirements: ['two non-uphill running falls verified in two complete quiet native room-local round trips', 'requires the existing declared boarding and upper-stair falls; quiet traversal does not establish town travel, activation or monster tolerance'],
    source: 'docs/m59-vale-peak-node-pathing.md; .claude/skills/node-runner/nodes/peak.md' },
  ice: { routeStatus: 'quiet-native-chamber-round-trip', approachGoal: square(25, 20),
    entry: point(25088, 46592), returnGoal: point(25088, 46592),
    requirements: ['first door sector1: go at r24c10 or inside r24c11; 4.35s animation within10s cycle',
      'prepare conditional route before press; observe actual opening before execution',
      'independent mana gate sector2 requires observed yeti kill, excluding node-caused kill, and opens for2s'],
    source: 'docs/m59-ice-node-pathing.md; tools/m59-node-path-test.mjs' },
  fey: { routeStatus: 'quiet-native-spawn-round-trip', approachGoal: point(29696, 22528),
    entry: point(29184, 512), returnGoal: square(1, 29),
    requirements: ['spawn access does not create the stone', 'eight-room extreme karma alignment; observed karma also changes floors'],
    source: 'docs/m59-vale-peak-node-pathing.md; exact source spawn protocol{x:1920,y:1472}' },
  corpse: { routeStatus: 'quiet-native-conditional-puzzle', approachGoal: range(16, 16, 2),
    entry: point(18944, 23040), returnGoal: square(16, 16),
    requirements: ['already in the Underworld; this objective never requests a death', 'five-brazier unlit-only puzzle',
      '60s central rip; activate within2 squares to bond, then step onto portal separately', 'avoid city/Hell portals during approaches'],
    source: 'docs/m59-underworld-node.md; tools/m59-underworld-node-test.mjs' },
  ukgoth: { routeStatus: 'conditional-unverified-node-route', approachGoal: range(27, 61, 2), entry: null, returnGoal: null,
    requirements: ['Relic of Qor in speaker pack is consumed by saying Qor the Vile', '10s floor door; game hour0 for node existence', 'a road crossing through Ukgoth is not node acquisition'],
    source: 'tools/m59-stones.mjs; .claude/skills/node-runner/nodes/ukgoth.md' },
  martyr: { routeStatus: 'normal-approach-unresolved', approachGoal: range(57, 45, 2), entry: null, returnGoal: null,
    requirements: ['ActivatePortal must place the node', 'normal town approach into room32/47 remains unresolved'],
    source: 'tools/m59-stones.mjs; docs/m59-vale-peak-node-pathing.md' },
  avar: { routeStatus: 'conditional-unverified-node-route', approachGoal: range(34, 52, 2), entry: null, returnGoal: null,
    requirements: ['village node value must swing past2000', 'node can disappear on60s timer; confirm the actual object'],
    source: 'tools/m59-stones.mjs; docs/m59-vale-peak-node-pathing.md' },
  mausoleum: { routeStatus: 'guest-only-by-design', approachGoal: range(35, 5, 2), entry: null, returnGoal: null,
    requirements: ['guest demonstration only; broad all-nodes intent cannot make normal-player access available'],
    source: 'tools/m59-stones.mjs: NODE_GUEST; rooms1006/1016' }
};

export function navMeshNodeObjectives() {
  return Object.entries(STONES).map(([key, stone]) => {
    if (!details[key]) throw new Error('uncatalogued_mana_node_' + key);
    const d = details[key];
    return { key, node: stone.node, room: stone.room, rooms: [...(stone.rooms ?? [stone.room])],
      nodeSquare: square(stone.row, stone.col), acquisitionGoal: range(stone.row, stone.col, 2),
      promoted: promoted.has(key), ...structuredClone(d) };
  });
}

// These are observed game prerequisites, not permission or reachability claims.
// Passing a gate never proves movement, activation, ownership or a live deadline.
export function navMeshObjectiveGate(key, state = {}, { purpose = 'meld', now = Date.now() } = {}) {
  if (!STONES[key]) return { available: false, reason: 'unknown_node' };
  const refusal = reason => ({ available: false, reason });
  if (key === 'mausoleum' && state.guest !== true) return refusal('guest_only_by_design');
  if (key === 'corpse' && state.alreadyInUnderworld !== true) return refusal('requires_existing_underworld');
  if (purpose === 'approach') return { available: true, reason: 'location_only_not_acquisition' };
  if (key === 'ice') {
    const h = state.sectorHeights?.get?.(2) ?? state.sectorHeights?.[2];
    const elapsed = now - state.yetiKilledAt;
    if (state.yetiKillObserved !== true || state.yetiKilledByNode !== false) return refusal('observed_non_node_yeti_kill_required');
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 2000) return refusal('yeti_mana_gate_window_expired_or_unknown');
    if (h?.type !== 5 || h.height !== 510) return refusal('mana_gate_open_observation_required');
  }
  if (key === 'fey' && (state.extremeKarmaAligned !== true || state.nodeObserved !== true)) return refusal('faction_node_not_observed');
  if (key === 'ukgoth') {
    const elapsed = now - state.relicDoorOpenedAt;
    if (state.gameHour !== 0 || state.nodeObserved !== true || state.relicDoorOpeningObserved !== true)
      return refusal('relic_door_and_hour_zero_required');
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 10000) return refusal('relic_door_window_expired_or_unknown');
  }
  if (key === 'martyr' && (state.portalActivationObserved !== true || state.nodeObserved !== true)) return refusal('activated_portal_node_required');
  if (key === 'avar' && (!(state.nodeValue > 2000) || state.nodeObserved !== true)) return refusal('faction_swing_node_required');
  if (key === 'corpse' && (state.brazierMask !== 31 || state.ripObserved !== true || !Number.isFinite(state.ripAppearedAt)
      || now < state.ripAppearedAt || now - state.ripAppearedAt >= 60000)) return refusal('live_solved_brazier_rip_required');
  return { available: true, reason: 'prerequisites_only_not_acquisition' };
}

export function iceAcceptanceGeometry(map, { yetiOpen = false, manaOpen = false, previewYeti = false } = {}) {
  const geometry = RoomGeometry.fromJSON(map.rooms[750].roo); geometry.roomNum = 750;
  const observed = new Map([[1, { type: 5, height: yetiOpen ? 448 : 380 }], [2, { type: 5, height: manaOpen ? 510 : 380 }]]);
  const applied = applyCeilingDoors(map, 750, observed, null, { geometryOf: () => geometry });
  if (!applied) throw new Error('ice_observed_door_state_unavailable');
  if (!previewYeti) return { geometry, observed, state: applied.state, conditional: false };
  const preview = previewOpenedDoor(map, 750, 1, { observed });
  if (!preview) throw new Error('ice_first_door_preview_unavailable');
  preview.geometry.roomNum = 750;
  return { geometry: preview.geometry, observed, state: preview.state, conditional: true, closedGeometry: geometry };
}

export function navMeshObjectiveCases() {
  const objectives = navMeshNodeObjectives(), out = [];
  for (const o of objectives) {
    if (!o.entry || ['ice', 'corpse'].includes(o.key)) continue;
    out.push({ id: 'node-' + o.key + '-entry', node: o.key, room: o.room, from: o.entry, goal: o.approachGoal,
      expectation: 'route', source: o.source, requirements: o.requirements,
      allowedKinds: ['sentinel','ancient','cave','peak'].includes(o.key) ? ['walk','jump'] : ['walk'],
      maxJumps: o.key === 'ancient' ? 4 : o.key === 'peak' ? 2 : ['sentinel','cave'].includes(o.key) ? 1 : 0 });
    if (o.returnGoal && o.approachGoal.kind === 'point') out.push({ id: 'node-' + o.key + '-return', node: o.key, room: o.room,
      from: o.approachGoal, goal: o.returnGoal, expectation: 'route', source: o.source, requirements: o.requirements });
  }
  const peak = objectives.find(o => o.key === 'peak');
  out.push({ id: 'node-peak-upper-section', node: 'peak', room: 515, from: peak.upperEntry, goal: peak.approachGoal,
    expectation: 'route', source: peak.source, requirements: peak.requirements, allowedKinds: ['walk','jump'], maxJumps: 1 });
  const ice = { node: 'ice', room: 750, source: 'docs/m59-ice-node-pathing.md; tools/m59-node-path-test.mjs' };
  out.push(
    { ...ice, id: 'ice-entry-to-closed-door-trigger', from: point(25088, 46592), goal: square(24, 10), state: 'closed', expectation: 'route' },
    { ...ice, id: 'ice-first-door-preview-to-main-chamber', from: point(9216, 23568), goal: square(25, 20), state: 'preview-first-only', expectation: 'route', conditional: true },
    { ...ice, id: 'ice-chamber-to-inside-trigger', from: square(25, 20), goal: square(24, 11), state: 'closed', expectation: 'route', startProvenance: 'geometry representative of documented native chamber square' },
    { ...ice, id: 'ice-chamber-to-outside-closed-trigger', from: square(25, 20), goal: square(24, 10), state: 'closed', expectation: 'blocked', startProvenance: 'geometry representative of documented native chamber square' },
    { ...ice, id: 'ice-open-first-door-return', from: square(24, 11), goal: point(25088, 46592), state: 'preview-first-only', expectation: 'route', conditional: true },
    { ...ice, id: 'ice-closed-mana-gate', from: square(25, 20), goal: square(25, 22), state: 'closed', expectation: 'blocked' },
    { ...ice, id: 'ice-observed-open-mana-gate', from: square(25, 20), goal: square(25, 22), state: 'mana-open', expectation: 'route',
      conditional: true, requirements: ['requires observed non-node yeti kill and unexpired2s window before execution; this is geometry only'] }
  );
  const portals = [{ row: 3, col: 7 }, { row: 2, col: 25 }, { row: 21, col: 30 }, { row: 32, col: 16 }, { row: 21, col: 2 }, { row: 10, col: 6 }];
  for (const [index, row, col] of [[1,4,7],[2,2,23],[3,20,29],[4,31,15],[5,20,2]]) out.push({
    id: 'underworld-brazier-' + index, node: 'corpse', room: 1, from: point(18944, 23040), goal: range(row, col, 3),
    avoidSquares: [...portals, { row: 16, col: 16 }], expectation: 'route', source: 'tools/m59-underworld-node-test.mjs; docs/m59-underworld-node.md' });
  out.push({ id: 'underworld-final-high-shelf-to-rip', node: 'corpse', room: 1, from: point(17408, 28736), goal: square(16, 16),
    avoidSquares: portals, expectation: 'route', conditional: true, source: 'docs/m59-underworld-node.md; 28-waypoint high-shelf return witness' });
  return out;
}

export function objectiveGoalOptions(geometry, goal, from = null) {
  if (goal.kind === 'point') return { target: { x: goal.x, y: goal.y }, options: {} };
  const radius = goal.kind === 'range' ? goal.within : 0;
  const squares = [];
  for (let row = goal.row - radius; row <= goal.row + radius; row++) for (let col = goal.col - radius; col <= goal.col + radius; col++) {
    if (row < 1 || col < 1 || row > geometry.rows || col > geometry.cols) continue;
    const p = geometry.standPoint(row, col);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) squares.push({ row, col, point: p });
  }
  squares.sort((a,b) => from ? Math.hypot(a.point.x-from.x,a.point.y-from.y)-Math.hypot(b.point.x-from.x,b.point.y-from.y) : 0);
  if (!squares.length) return null;
  return { target: { ...squares[0].point }, options: goal.kind === 'square' ? { goalSquare: { row: goal.row, col: goal.col } }
    : { goalSquares: squares.map(({ row, col }) => ({ row, col })) } };
}

export function objectiveEndpointMatches(goal, endpoint) {
  if (![endpoint?.x, endpoint?.y].every(Number.isFinite)) return false;
  if (goal.kind === 'point') return Math.hypot(goal.x-endpoint.x,goal.y-endpoint.y) <= 0.05;
  const row = Math.floor(endpoint.y / 1024) + 1, col = Math.floor(endpoint.x / 1024) + 1;
  const radius = goal.kind === 'range' ? goal.within : 0;
  return Math.abs(row-goal.row) <= radius && Math.abs(col-goal.col) <= radius;
}
