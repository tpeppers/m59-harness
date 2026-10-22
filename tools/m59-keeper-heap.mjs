// THE KEEPER HEAP CEILING, read at every spawn rather than once per broker.
//
// The ceiling used to come only from M59_KEEPER_HEAP_MB in the broker's own environment. A live
// handover cannot change that: the predecessor spawns its successor with ITS environment
// (runtime/broker-handover.mjs successorSpawnSpec), so `M59_KEEPER_HEAP_MB=1024 m59-service
// restart` produced a broker that still spawned 640 MB keepers. Measured 2026-10-22: seven prod
// keepers died "Reached heap limit" at 640 (Mark-Compact 636.7 -> 636.5 MB) in two hours, and
// the handover meant to raise it changed nothing. So the number may also live in a one-line,
// gitignored file, `substrate/keeper-heap-mb`, which every spawn reads.
//
// Precedence: the environment when it says something, then the file, then 640. 0 (either place)
// leaves Node's own default. A file that does not parse is not 0 — it is ignored, loudly.

import { readFileSync } from 'node:fs';

export const DEFAULT_KEEPER_HEAP_MB = 640;

/** The ceiling in MB (0 = Node default) and where it came from. */
export function keeperHeapMb({ env = process.env, file = null, read = readFileSync } = {}) {
  const fromEnv = env?.M59_KEEPER_HEAP_MB;
  if (fromEnv != null && String(fromEnv).trim() !== '') {
    const mb = Number(fromEnv);
    if (Number.isFinite(mb) && mb >= 0) return { mb, source: 'env' };
  }
  if (file) {
    let text = null;
    try { text = read(file, 'utf8'); } catch { text = null; }
    if (text != null) {
      const mb = Number(String(text).trim());
      if (Number.isFinite(mb) && mb >= 0 && String(text).trim() !== '') return { mb, source: 'file' };
      return { mb: DEFAULT_KEEPER_HEAP_MB, source: 'default', warning: `${file} does not hold a number; using ${DEFAULT_KEEPER_HEAP_MB}` };
    }
  }
  return { mb: DEFAULT_KEEPER_HEAP_MB, source: 'default' };
}

/** The node flags for a keeper spawn. */
export function keeperHeapArgs(opts = {}) {
  const { mb } = keeperHeapMb(opts);
  return mb > 0 ? [`--max-old-space-size=${Math.round(mb)}`] : [];
}
