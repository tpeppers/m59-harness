# Underworld — room 1, central rip r16c16

## 2026-10-06: puzzle and timed return investigation

Read [the full report](../../../../docs/m59-underworld-node.md). CorpseNode is a
Portal and must be activated to bond before stepping onto it. It appears for
60 seconds after all five braziers light. Its success message and grant differ
from an ordinary ManaNode's appearance; recognize the distinct tail and confirm
maximum mana (plus bit 128 in owned native trials).

The first puzzle completion bonded (+5), but its lower-floor return took longer
than the portal's window. Merely ending at the southern switch also selected a
low valley with 126 return waypoints. The measured higher-shelf final approach
has a separately audited 28-waypoint return. Exact endpoint planning, a precise
walker correction, a fresh unlit-only solver, activation mask telemetry, timed
return preparation and failure receipts are implemented in
`tools/m59-underworld-node.mjs`. Two connected normal-entry native runs prove puzzle, bond (+5 maximum mana,
bit 128) and return to room 1011: 200,852 and 219,245 ms, 59/59 HP, baselines
restored. Initial masks 27 and 26 needed five and six activations, no jump.
Final-switch-to-return times were 17.8 and 17.4 seconds, inside the 60-second
window. All 32 solver states pass offline; 22 integrated movement suites have
zero new regressions (19 existing known-red assertions unchanged).

This is an activity for a character already in room 1. Keep it conditional in
the generic stone book; do not route living characters to their death. Checked
activation-range approaches may avoid the jumps remembered by a human player;
claim full route success only from connected ordinary-action native receipts.
