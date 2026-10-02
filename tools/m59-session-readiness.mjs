// Small, offline-testable session lifecycle helpers for m59-broker.

export async function joinSessionOnce(session, args, start) {
  // A JOIN IN PROGRESS IS ASKED FIRST. `live` turns true the moment joinOnce installs the new
  // client, which is BEFORE its login reads run and before combat is ready; answering "already
  // in game" from that half-built state let a second caller (a keeper retry) carry on with a
  // client that had no attribute block and a deaf CombatMode (prod, 2026-10-02). Wait for the
  // join instead; joinOnce bounds its own reads, so this cannot hang on them.
  if (session.joining) return session.joining;
  if (session.live) return session.snapshot('already in game');

  // Defer the call through Promise.resolve so a synchronous setup failure is
  // represented by the same shared promise as an asynchronous login failure.
  const joining = Promise.resolve().then(() => start(args));
  session.joining = joining;
  try {
    return await joining;
  } finally {
    if (session.joining === joining) session.joining = null;
  }
}

export function sessionReadiness(sessions) {
  const entries = [...sessions];
  return {
    // `sessions` is the public readiness contract used by callers before they
    // mutate a character. Allocated-but-joining Session objects are not ready.
    sessions: entries
      .filter(([, session]) => session.live)
      .map(([agent]) => agent),
    // Keep the complete identity set for diagnostics without presenting it as
    // proof that a character is already in the game.
    known_sessions: entries.map(([agent]) => agent),
  };
}
