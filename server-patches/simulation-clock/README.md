# Lab-only Meridian simulation clock patch

This directory is an immutable patch input for the separate
`docker/Dockerfile.sim-clock` build. It is not consumed by the normal server image and it
never writes into `M59_ROOT`.

The build wrapper verifies all three identities before Docker sees the source:

1. the exact Meridian Git commit in `manifest.json`;
2. the SHA-256 of every source file touched by the patch;
3. that Git can apply the patch cleanly with no whitespace errors.

The Docker build repeats the per-file hash check before applying the patch. Its resulting
image is labelled with the source commit, patch digest, clock schema, and fixed configured
scale. The patched server still refuses to enable simulation unless its private savegame
directory contains a guard file with the exact text in the manifest. The lab server
controller creates that marker only under its own gitignored runtime directory.

Build and run one explicitly named lab instance:

```text
node tools/m59-sim-server-build.mjs --check --scale 10
node tools/m59-sim-server-build.mjs --build --scale 10 --tag m59-blakserv-sim:lab-10x
node tools/m59-sim-server.mjs start --id clock-lab --image m59-blakserv-sim:lab-10x --scale 10 --game-port 15959 --admin-port 19998
node tools/m59-sim-server.mjs attest --id clock-lab
node tools/m59-sim-server.mjs stop --id clock-lab
```

The controller publishes both sockets on loopback only, applies explicit CPU, memory, and
PID limits, and refuses ordinary production port numbers and production-like instance
names. `stop` asks blakserv to `terminate save` and never hard-stops the container.

When simulation is disabled, the patch preserves the original wall-clock timer behavior
and version-1 save format. The isolated image deliberately enables it and therefore writes
version-2 game saves containing a simulation-clock record. Those saves belong only to the
isolated lab runtime.

Version 1 accelerates the two event clocks that can be isolated safely: Blakod timers and
the Blakod-hour system event. The Blakod `GetTime()` builtin deliberately remains wall time
because the same primitive enforces packet, movement, and speed-hack rates; globally scaling
it would weaken those checks. TCP, sessions, inactivity, logs, save cadence/names, channel
maintenance, and profiling also remain on wall time. Save/reload freezes simulated time,
stores one absolute simulation timestamp, and preserves each ordinary timer's remaining
simulated duration. A required end record makes a cleanly truncated v2 file detectable.
The unsafe live `reload game` path is refused for a simulation server; a normal
lab-container restart loads the persisted clock safely, and a malformed or incompatible
v2 save terminates instead of silently creating a replacement world—even if simulation
was disabled in that patched binary.

Scale is fixed per image (1..100). A future schema may add an explicit second Blakod
wall-time primitive and migrate audited world-time call sites, plus adaptive scale control
and an in-process/no-TCP transport. Version 1 does not silently approximate those pieces.
