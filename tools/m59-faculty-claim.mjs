// A standing faculty claim remains takeable. An active operation's busy window is
// different: DUM's missing-claim heartbeat must not restore its old claim over the
// FleetScript that borrowed the character. Explicitly releasing the busy operation,
// or letting its lease expire, makes the character available again.
const DIRECTIONAL = new Set(['work', 'movement', 'economy', 'social']);

export function busyClaimRefusal({ busy, faculty, by, now = Date.now() } = {}) {
  if (!DIRECTIONAL.has(faculty) || !busy || !(busy.until > now) || busy.by === (by || 'unnamed')) return null;
  const doing = busy.label || busy.kind || 'an operation';
  return { faculty, code: 'busy', by: busy.by, kind: busy.kind ?? null,
    expires_in_ms: busy.until - now,
    why: `${busy.by ?? 'another holder'} is busy with ${doing}; wait for it to finish or explicitly release the operation` };
}
