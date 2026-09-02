// Pure keeper liveness state. Rich `/state` snapshots and cheap `/live` replies both
// feed this object; transport failures do not. In particular, silence is UNKNOWN and
// cannot turn a process we can still prove alive into a reconnect decision.

export function normalizeKeeperCharacter(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  return normalized || null;
}

export function validateKeeperSample(sample, expected = {}) {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample))
    return { ok: false, reason: 'reply is not an object' };

  const wantAgent = expected.agent == null ? null : String(expected.agent);
  if (wantAgent !== null && String(sample.agent ?? '') !== wantAgent)
    return { ok: false, reason: `agent mismatch (expected ${wantAgent}, got ${sample.agent ?? 'missing'})` };

  const wantCharacter = normalizeKeeperCharacter(expected.character);
  const gotCharacter = normalizeKeeperCharacter(sample.character);
  if (wantCharacter && gotCharacter !== wantCharacter)
    return { ok: false, reason: `character mismatch (expected ${expected.character}, got ${sample.character ?? 'missing'})` };

  const wantPid = Number(expected.pid);
  const gotPid = Number(sample.pid);
  if (Number.isInteger(wantPid) && wantPid > 0 && gotPid !== wantPid)
    return { ok: false, reason: `pid mismatch (expected ${wantPid}, got ${sample.pid ?? 'missing'})` };
  if (!Number.isInteger(gotPid) || gotPid <= 0)
    return { ok: false, reason: 'reply has no valid pid' };

  if (typeof sample.in_game !== 'boolean')
    return { ok: false, reason: 'reply has no boolean in_game' };
  if (sample.connected !== undefined && typeof sample.connected !== 'boolean')
    return { ok: false, reason: 'reply has invalid connected value' };

  return { ok: true };
}

export class KeeperLiveness {
  constructor({ agent, character = null, phantomAfterMs = 20_000,
                probeEveryMs = 10_000, now = () => Date.now() } = {}) {
    if (agent == null || agent === '') throw new TypeError('agent is required');
    if (!Number.isFinite(phantomAfterMs) || phantomAfterMs < 0)
      throw new RangeError('phantomAfterMs must be non-negative');
    if (!Number.isFinite(probeEveryMs) || probeEveryMs <= 0)
      throw new RangeError('probeEveryMs must be positive');
    this.agent = String(agent);
    this.character = character;
    this.phantomAfterMs = phantomAfterMs;
    this.probeEveryMs = probeEveryMs;
    this.now = now;
    this.sample = null;
    this.sampleAt = 0;
    this.connectedFalseSince = 0;
    this.connectedFalseConfirmed = false;
    this.unknownSince = 0;
    this.lastError = null;
    this.nextProbeAt = 0;
    this.revision = null;
    this.disposed = false;
    this.generation = 0;
  }

  observe(sample, { pid = null, at = this.now() } = {}) {
    if (this.disposed) return { ok: false, reason: 'disposed' };
    const valid = validateKeeperSample(sample, {
      agent: this.agent,
      character: this.character,
      pid,
    });
    if (!valid.ok) return valid;

    const revision = sample.connection_revision ?? null;
    if (revision !== null && this.revision !== null && revision !== this.revision) {
      this.connectedFalseSince = 0;
      this.connectedFalseConfirmed = false;
    }
    this.revision = revision;

    if (sample.in_game && sample.connected === false) {
      if (!this.connectedFalseSince) this.connectedFalseSince = at;
      else if (at - this.connectedFalseSince >= this.phantomAfterMs)
        this.connectedFalseConfirmed = true;
    } else {
      this.connectedFalseSince = 0;
      this.connectedFalseConfirmed = false;
    }

    this.sample = {
      agent: sample.agent,
      character: sample.character ?? null,
      pid: Number(sample.pid),
      in_game: sample.in_game,
      connected: sample.connected,
      connection_revision: revision,
    };
    this.sampleAt = at;
    this.unknownSince = 0;
    this.lastError = null;
    this.nextProbeAt = at + this.probeEveryMs;
    this.generation++;
    return { ok: true };
  }

  unavailable(error, { at = this.now() } = {}) {
    if (this.disposed) return false;
    if (!this.unknownSince) this.unknownSince = at;
    this.lastError = error?.message ?? String(error ?? 'keeper did not answer');
    // Do not move nextProbeAt out: a later sweep may retry. Most importantly, do not
    // touch the accepted sample or connectedFalseSince — silence is not evidence of a
    // disconnected game socket.
    return true;
  }

  resetConnectionEvidence() {
    if (this.disposed) return false;
    this.connectedFalseSince = 0;
    this.connectedFalseConfirmed = false;
    this.revision = null;
    return true;
  }

  due(at = this.now()) {
    return !this.disposed && at >= this.nextProbeAt;
  }

  status({ processAlive = null, at = this.now() } = {}) {
    if (this.disposed) return { live: false, inGame: false, phantom: false, unknown: false, disposed: true };
    if (processAlive === false)
      return { live: false, inGame: false, reportedInGame: this.sample?.in_game ?? false,
               phantom: false, unknown: false, processDead: true };

    if (!this.sample) {
      // No HTTP evidence is safe only when the supervisor can positively prove the exact
      // recorded PID is alive. `null` means there is no such record, not that an unknown
      // process gets to suppress recovery forever.
      return { live: processAlive === true, inGame: false, phantom: false,
               unknown: true, lastSeenAt: null };
    }

    const reportedInGame = this.sample.in_game === true;
    const reportedPhantom = reportedInGame && this.sample.connected === false &&
      this.connectedFalseConfirmed;
    // An old HTTP sample is evidence about the exact PID named in that sample, not an
    // immortal substitute for the process record. If the supervisor can no longer prove
    // that recorded PID alive, neither `live` nor `inGame` may suppress recovery or let a
    // mutating tool through `need()`. Keep the reported value beside the effective one for
    // diagnostics; only positive process evidence turns it into current liveness.
    const processProven = processAlive === true;
    const unknown = !processProven || !!this.unknownSince;
    return {
      live: processProven && reportedInGame && !reportedPhantom,
      inGame: processProven && reportedInGame,
      reportedInGame,
      phantom: processProven && reportedPhantom,
      unknown,
      lastSeenAt: this.sampleAt,
      unknownSince: this.unknownSince || null,
      connected: this.sample.connected,
      pid: this.sample.pid,
      revision: this.revision,
      lastError: this.lastError,
    };
  }

  dispose() {
    this.disposed = true;
    this.generation++;
  }
}
