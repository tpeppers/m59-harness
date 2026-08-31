// The legacy Session surface still reaches these three globals. Keep the compatibility
// shim at the lab boundary so neither the generic fleet runtime nor shard control needs
// to know about roster persistence internals.

export function installLabGameGlobals(selection, target = globalThis) {
  if (!selection?.entries || typeof selection.entries[Symbol.iterator] !== 'function')
    throw new TypeError('installLabGameGlobals requires a fleet selection');
  target.fleetState = new Map([...selection.entries].map(entry => {
    const { id, ...record } = entry;
    if (typeof id !== 'string' || !id) throw new TypeError('lab actor id is required');
    return [id, record];
  }));
  // A lab never rewrites its credential roster from inside Session.join(). Mutable
  // observations have isolated paths installed by configureLabEnvironment instead.
  target.saveFleetState = () => {};
  target.drainExitGaps = () => {};
  return target.fleetState;
}
