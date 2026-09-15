// Maintained FleetScript entry for a native, temporarily leased controller.
// No process, socket, global policy or lease is created here. The owning keeper
// passes its guarded native journey; ordinary FleetScripts keep their own runner.
import { leasedFleetWalk } from '../m59-fleetscript.mjs';
import * as transits from '../m59-transits.mjs';
let cache = { at: 0, edges: null };
function recordedEstimate(hops) {
  if (!cache.edges || Date.now() - cache.at >= 60_000) {
    const books = [];
    for (const name of transits.allCharacters()) {
      try { books.push(transits.loadBook(name)); } catch { /* one book is optional */ }
    }
    cache = { at: Date.now(), edges: transits.edgeTimes(books) };
  }
  return transits.estimateJourney(hops, cache.edges, { percentile: 'p90' });
}
export async function travelUnderLease({ session, keeper, destination, generation, token, check, setDeadline }) {
  return leasedFleetWalk({ agent: session.name, to: destination, control: {
    check,
    observe: () => {
      const c = session.need(), hp = c.vitals()?.health;
      const max = hp?.max ?? hp?.scale_max, room = Number(session.world?.room?.num);
      return { ok: true, room, health: Number.isFinite(hp?.value) && max > 0 ? hp.value / max : null,
        hpText: `${hp?.value ?? '?'}/${max ?? '?'}`, dead: hp?.value === 0 || room === 1 };
    },
    route: to => session.world.route(to),
    estimate: (_from, to) => recordedEstimate(session.world.route(to)?.hops ?? []),
    travel: (to, { budgetMs }) => {
      setDeadline(budgetMs); check();
      // Keeper.travel is the normal FleetScript travel engine, including its
      // shelter/health stops. Do not nest Session.travelJob in the owned job slot.
      return keeper.travel(to, { movementGeneration: generation, controlToken: token });
    },
  } });
}
