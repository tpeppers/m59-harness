# Native scene hold (lab only)

This patch is compiled only by `docker/Dockerfile.scene`. Build it with
`node tools/m59-scene-server-build.mjs --build --tag m59-scene:lab-replay`.
The wrapper uses an immutable source archive, and the container checks normalized
source SHA-256 preimages and the patch digest before applying it.

It adds `SceneHold` / `SceneRelease` to Monster and `SceneHoldRoom` /
`SceneStartRoom` to Room. The latter releases all room monsters within one KOD
top-level message. The loader detects `pbSceneHeld` as the native capability.
The property defaults to false; normal gameplay does not request a hold.

Holding suppresses core Monster reactions, movement and attacks. It pauses the
remaining duration of the behavior, random, spasm, offer, turning and enchantment
timers. New room entrants are held before room-entry effects can start their AI.
`SceneRelease(fresh=TRUE)` starts an idle wait when a reconstructed monster had no
saved behavior timer. Existing behavior timers retain their saved delay and state.

This is a room preparation barrier, not a whole-world deterministic snapshot.
Player regeneration, external inputs, unrelated rooms, RNG and custom subclass
handlers are separate fidelity concerns. The baseline replay gate remains required.
See [the replay workflow](../../docs/m59-death-replay.md) for native world saves,
variant CLI options, and interpretation rules.
