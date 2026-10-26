// THE SHAPE OF A POSTURE (tools/m59-posture.mjs). A committed EXAMPLE, beside substrate/postures/.
//
//   node tools/m59-posture.mjs show    example-stay-put --fleet <name>     what it would change (reads only)
//   node tools/m59-posture.mjs apply   example-stay-put --fleet <name>     save, push, read back
//   node tools/m59-posture.mjs release example-stay-put --fleet <name>     restore the save, read back
//
// "Nobody goes anywhere": no town trips, no journeys out of the room each character is in. The save holds
// exactly these keys as each keeper had them, so release puts back what was there -- not what this file
// guesses was there.
export default {
  name: 'example-stay-put',
  about: 'every fleet character stays in the room it is in; no town trips; leased runs paused',
  who: { min_max_health: 1 },
  orders: unit => ({ town_trips: false, ...(unit.room ? { confine_rooms: [unit.room] } : {}) }),
  pause_jobs: true,
};
