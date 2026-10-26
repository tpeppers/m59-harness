// AN EXAMPLE TRIPWIRE (tools/m59-tripwire.mjs). Copy it into substrate/tripwires/ (gitignored) and name it in
// substrate/tripwires-<fleet>.json `enabled` to arm it; a fresh clone arms nothing.
//
// A named player appearing in a FRESH `who`, or a keeper's war alarm about him, puts `example-stay-put` on; fifteen
// minutes of fresh absence takes it off. The names here are placeholders, not anybody on any server.
//
//   node tools/m59-tripwire.mjs check example-enemy-online
//   node tools/m59-tripwire.mjs try   example-enemy-online --who "Somebody Else,Example Enemy"
export default {
  name: 'example-enemy-online',
  about: 'a named enemy online (or alarmed by a keeper) puts example-stay-put on; 15 min of fresh absence takes it off',
  when: [
    { who_online: ['Example Enemy'] },
    { war_alarm: { enemies: ['Example Enemy'], within_ms: 60_000 } },
  ],
  then: { posture: 'example-stay-put' },
  quiet_ms: 15 * 60_000,
  rearm_ms: 5 * 60_000,
};
