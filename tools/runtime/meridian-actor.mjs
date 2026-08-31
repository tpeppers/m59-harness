// Meridian-specific construction at the edge of the generic FleetRuntime.
// Importing this module loads the shared game/map engine once for the whole process.

import { Session } from '../m59-session.mjs';
import * as party from '../m59-party.mjs';
import { configureSpotClaimStore } from '../m59-spotclaims.mjs';
import { ManagedAutopilot, disableSessionRecorder } from './managed-autopilot.mjs';
import { installConfiguredParties } from './party-roster.mjs';
import { meridianPrimarySource } from './primary-source.mjs';
import { SessionActor } from './session-actor.mjs';

export function installFleetRosterSource({ roster, stateFile, entries, multiProcess = false }) {
  party.setRosterSource(party.rosterFileSource(stateFile, { seed: roster }));
  const parties = installConfiguredParties(entries, party);
  // A one-process runtime shares the in-memory reservation map. Shards need the existing
  // atomic file store to prevent actors in different processes choosing the same wall.
  const spotClaims = multiProcess ? configureSpotClaimStore({
    enabled: true,
    directory: process.env.M59_SPOT_CLAIMS_DIR,
    namespace: process.env.M59_SPOT_CLAIMS_NAMESPACE,
  }) : configureSpotClaimStore({ enabled: false });
  return Object.freeze({ parties, spotClaims });
}

export function createMeridianActor(entry, context) {
  const id = context?.id ?? entry?.id;
  const credentials = entry?.credentials;
  if (!id) throw new TypeError('Meridian actor needs an id');
  if (!credentials?.account || !credentials?.password)
    throw new TypeError(`Meridian actor ${id} needs account and password credentials`);

  const mode = entry?.autopilot?.mode || 'survive';
  if (mode === 'tick') {
    throw new Error(
      `actor ${id} requests tick mode; lab-runtime v1 supports managed Autopilot modes only`,
    );
  }

  let session = null;
  let controller = null;
  try {
    session = disableSessionRecorder(new Session(id));
    controller = new ManagedAutopilot(session, {
      mode,
      policy: entry?.autopilot?.policy || {},
    });
    const actor = new SessionActor({
      id,
      session,
      controller,
      scheduler: context.scheduler,
      safetyScheduler: context.safetyScheduler,
      clock: context.clock,
      reconnect: entry?.rejoin !== false && entry?.autopilot?.rejoin !== false,
      project: () => meridianPrimarySource({ agent: id, session, controller }),
      publish: (_actorId, value, options) => context.publishState(value, options),
      publishTransition: (_actorId, type, payload) =>
        context.publishTransition(type, payload),
    });

    return Object.freeze({
      id,
      session,
      controller,
      actor,
      start: () => actor.start({ credentials }),
      stop: reason => actor.stop(reason),
      snapshot: () => actor.snapshot(),
    });
  } catch (error) {
    try { controller?.stop('actor construction failed', { hard: true }); } catch {}
    try { session?.recorder?.stop?.(); } catch {}
    throw error;
  }
}
