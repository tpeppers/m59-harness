# Survival retreat follow-up — 2026-09-22

The preceding seed-22 shadow run recorded 8 measured PvE deaths (6 in the Flatlands), 160 legs and 14 full circuits. Its retreat receipts were unreliable: a one-square shuffle counted as escape; three receipts ended in the Underworld and three more spanned death and respawn. There were 518 larger-target refusals under a combined health/identity reason, with no observed live lure.

## Changes

Survival-owned retreats now measure escape against the original recovery episode's two-square pocket, not just the position at the start of the latest fallback. Movement inside that pocket is recorded as displacement but does not suppress later rungs or reset failure history. Failed attempts remain associated with the episode even when the character oscillates between opposite pocket edges. A live room departure or verified safe cover still ends the fallback sequence. Ordinary healthy movement keeps its existing displacement rule.

A scoped cancellation lease is passed through rail retreat, breadcrumbs, the entry-door walk and the previous-room journey. The existing paced-movement cancellation checks consult this lease. It latches death, client replacement or survival-owner change, stopping subsequent steps and fallbacks without cancelling a newer command or the new life’s recovery. Fatal health pushes and authoritative Underworld entry increment a session life-boundary counter, so respawning before an awaited call returns cannot erase the interruption. The lease is released in finally. Jam ownership includes the same life boundary. Receipts separate displaced, freed, cancelled and the interruption reason.

Larger-target health and name-identity refusals now include separate booleans, health/threshold and visible namesake positions. The unique-name rule remains necessary because combat prose does not identify the attacking object. Identity is rechecked before every provoking swing; a newly arriving namesake ends provocation and requests the existing reachable refuge. This does not permit additional aggression or loosen collision, health, cover, player or weapon gates.

## Validation

The ten-file survival/recovery regression command passes 99 Node test entries, including 44 jam integration cases. Added cases cover all three fallback death points with and without immediate respawn, client replacement, pocket oscillation, safe cover during a rail attempt, and a real breadcrumb executor refusing a second paced step after fatal health followed by respawn. The real watchdog, pending dispatcher and suspended-journey coverage remain in place.

A larger-target case now uses real Flatlands geometry, the real refuge selector, body-aware reachability and the actual backward/outside-needle filter. It exercises exact retaliation, refuge arrival, chase and local clearance. Wire attacks, arrival and monster chase remain simulated: this proves offline control flow, not a live lure or reduced mortality. Refusal reasons and mid-fight identity ambiguity also have regressions.

The movement gate ran all 13 suites with zero new regressions. Its existing named baseline remains twelve needle assertions and four travelling assertions. The three early blocker suites were also rerun after the final same-pocket/cover changes and passed. Demonstration provenance and logs are retained in substrate/survival-retreat-tour-20260922.

## Authorized demonstration

One further one-hour continuous reverse seven-stop tour, seed 22, using the same 21 shadow characters on game/admin 18959/18998 and broker/dashboard 8981/8982. A new runtime inherits the preceding shadow map books. No production deployment, server reset, character reroll or equipment/health normalization is part of this change. Initial scenes capture accumulated health/equipment differences. The inherited pinned-watchdog timeout is unchanged (previously 2,147,483,647 ms); repeated recovery failures qualify jams independently.

Compare exact-window postmortems and ledger deaths to both prior runs (12/10 deaths/Flatlands, 53 legs, 2 circuits; then 8/6, 160 legs, 14 circuits). Compare Flatlands exposure, sampling gaps and throughput as well as raw deaths. Death/respawn must never appear as retreat success; shuffling must retain escalation. Separate live lure outcomes from safety refusals and missing exercised cases. Same seed fixes starting assignments, not monster RNG, inherited learning or character state. No causal mortality percentage claim is justified. Production release remains on hold.
