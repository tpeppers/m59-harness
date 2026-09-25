// PREFARM EQUIPMENT — THE ARITHMETIC. Pure; no socket, no roster. Pinned by m59-prefarm-test.mjs.
//
// A raid's gear list can be FARMED instead of bought: faction soldiers carry weapons and armour and
// drop some of what they carry. This file answers the question that has to be asked first — is it
// worth it — before anybody walks anywhere: how many kills a list needs, how long the flagpoles take
// to make that many soldiers, what the list would cost at a smith instead, and what the byproducts
// sell for. Facts from kod, researched 2026-09-25 (citations are Meridian59/kod-relative):
//
//   SPAWN   Flagpole.GenerateTroops (object/active/flag.kod:755-838): one troop per tick, only in a
//           faction-held MonsterRoom (town poles never spawn), capped per room. TerritoryGame
//           (util/factgame/territry.kod:63-78): 300000 ms a tick, cap 4 — TWELVE AN HOUR PER ROOM.
//   DROPS   FactionTroop.CreateTreasure (monster/troop.kod:1034-1065): each carried item drops at
//           EQUIPMENT_DROP_PERCENT = 20 (troop.kod:33); the soldier's shield NEVER drops. Carried
//           odds from SetEquipment (troop.kod:531-627). No money, no reagents (TID_NONE).
//   DANGER  level 70-145, difficulty 3-7 (troop.kod SetEquipment on piBaseLevel 50). They are NOT
//           aggressive to a neutral player (AI_FIGHT_NEWBIESAFE) — a fight starts when WE start it.
//   PRICES  sell = value x (100 - 10 x markup)/100 (monster.kod:3126-3141); Barloque's smith 113 is
//           "expensive" (60%), Jasper's 374 "bargain" (90%), Marion's 201 "normal" (70%, weapons and
//           shields only). A fresh drop is worth ~84% of base (condition roll, item.kod:118).
//
// AND THE WARNING docs/m59-combat.md GIVES, IN CAPITALS: "DO NOT FARM SOLDIERS FOR ARMOUR — THE
// SPIDER AND THE ORC ARE BOTH BETTER AND BOTH FIGHTABLE." That was written when the strongest
// character was level 50; `planPrefarm` compares the soldiers' band against the fleet's actual
// levels and says so every time, rather than refusing — the operator decides.

/** Per-kill drop chance for each item a soldier can carry: P(carried) x 20%. */
export const SOLDIER_DROPS = Object.freeze({
  'long sword': 0.35 * 0.2, axe: 0.20 * 0.2, hammer: 0.10 * 0.2, mace: 0.10 * 0.2,
  'short sword': 0.15 * 0.2, scimitar: 0.10 * 0.2,
  'leather armor': 0.35 * 0.2, 'chain armor': 0.35 * 0.2, 'scale armor': 0.30 * 0.2,
  gauntlets: 0.19 * 0.2,
});

/** Base values (kod GetInitValue; matches substrate/m59-values.json). */
export const BASE_VALUE = Object.freeze({
  'long sword': 800, axe: 600, hammer: 450, mace: 50, 'short sword': 250, scimitar: 150,
  'leather armor': 400, 'chain armor': 1000, 'scale armor': 1500, gauntlets: 400,
});

/** What the fleet would PAY at the cheapest known counter instead (docs/armorer-run-facts.md §3). */
export const BUY_PRICE = Object.freeze({
  'chain armor': 1800, 'scale armor': 1800, hammer: 540, axe: 960, 'leather armor': 480,
  'short sword': 300, 'long sword': 1120,
});

/** Smiths: sell rate and whether they take armour at all. */
export const SMITHS = Object.freeze({
  113: { name: "Fehr'loi Qan", town: 'Barloque', rate: 0.6, armour: true },
  374: { name: 'Quintor', town: 'Jasper', rate: 0.9, armour: true },
  201: { name: 'Colhorr', town: 'Marion', rate: 0.7, armour: false },
});

export const SOLDIER = Object.freeze({ level: [70, 145], difficulty: [3, 7], perRoomPerHour: 12, cap: 4 });
export const CONDITION = 0.84;         // a fresh drop's value as a fraction of base

/** Troop names on the wire, and the three flag rooms each faction held at the territory game's start. */
export const FACTIONS = Object.freeze({
  duke: { troop: "soldier of the Duke's army", rooms: [586, 596, 585] },
  princess: { troop: "soldier of the Princess' army", rooms: [593, 583, 603] },
  rebel: { troop: 'rebel soldier', rooms: [568, 557, 547] },
});

/**
 * Every guild hall, and the nearest troop-spawning flag rooms from it (BFS over the baked map,
 * 2026-09-25 research — hops are graph hops, not measured journeys). `island` halls have no road to
 * a flagpole worth the name: the plan WARNS and the farmed gear is KEPT rather than deposited.
 */
export const HALLS = Object.freeze({
  714: { town: 'Barloque', smith: 113, nearest: [{ faction: 'princess', room: 593, hops: 3 }, { faction: 'duke', room: 585, hops: 6 }] },
  702: { town: 'Barloque', smith: 113, nearest: [{ faction: 'princess', room: 593, hops: 2 }, { faction: 'duke', room: 585, hops: 5 }] },
  708: { town: 'Barloque', smith: 113, nearest: [{ faction: 'princess', room: 593, hops: 4 }, { faction: 'rebel', room: 557, hops: 7 }] },
  709: { town: 'Barloque', smith: 113, nearest: [{ faction: 'princess', room: 593, hops: 4 }] },
  707: { town: 'Tos', smith: 113, nearest: [{ faction: 'duke', room: 596, hops: 2 }, { faction: 'princess', room: 583, hops: 6 }] },
  704: { town: 'Jasper', smith: 374, nearest: [{ faction: 'rebel', room: 568, hops: 2 }, { faction: 'duke', room: 586, hops: 6 }] },
  710: { town: 'Jasper', smith: 374, nearest: [{ faction: 'rebel', room: 568, hops: 2 }, { faction: 'duke', room: 586, hops: 6 }] },
  703: { town: 'Jasper', smith: 374, nearest: [{ faction: 'rebel', room: 568, hops: 1 }, { faction: 'duke', room: 586, hops: 5 }] },
  701: { town: 'Cor Noth', smith: 201, nearest: [{ faction: 'duke', room: 585, hops: 4 }, { faction: 'princess', room: 583, hops: 4 }] },
  711: { town: 'Cor Noth', smith: 201, nearest: [{ faction: 'duke', room: 585, hops: 4 }, { faction: 'princess', room: 583, hops: 4 }] },
  706: { town: 'Marion', smith: 201, nearest: [{ faction: 'rebel', room: 547, hops: 2 }] },
  712: { town: 'the forest', smith: 113, nearest: [{ faction: 'princess', room: 583, hops: 2 }] },
  705: { town: "Ko'catan (island)", smith: null, island: true, nearest: [{ faction: 'duke', room: 586, hops: 10 }] },
  713: { town: "Ko'catan (island)", smith: null, island: true, nearest: [{ faction: 'duke', room: 586, hops: 11 }] },
});

const key = s => String(s ?? '').toLowerCase().trim().replace(/s$/, '');
const dropKey = item => Object.keys(SOLDIER_DROPS).find(k => key(k) === key(item)) ?? null;

/**
 * THE PLAN. wants: {item: count}. Returns what it would take, what it would save, and the warnings.
 *
 *   kills     the EXPECTED kills for the slowest item (count / per-kill chance) — the list is done
 *             when its rarest line is; `kills90` is the same at ~90% confidence (Poisson, +1.3 sd).
 *   hours     kills / (rooms x 12 an hour): the flagpoles, not the fighters, are the ceiling.
 *   saves     what the list would cost to BUY; byproduct: expected sale value of everything else the
 *             kills drop, at the chosen smith.
 */
export function planPrefarm({ wants = {}, hall = 714, faction = null, rooms = null, fleetLevels = [], smith = null } = {}) {
  const h = HALLS[hall] ?? null;
  const warnings = [];
  if (!h) warnings.push(`hall ${hall} is not in the table — no nearest flagpole known; name the faction and rooms`);
  if (h?.island) warnings.push(`${h.town} is an island: no flagpole within reach of the hall. The farmed gear is KEPT in the fighters' packs rather than deposited, and the walk is ${h.nearest[0].hops}+ hops`);
  const pick = faction ? (h?.nearest ?? []).find(n => n.faction === faction) ?? { faction, room: FACTIONS[faction]?.rooms[0], hops: null }
                       : h?.nearest?.[0] ?? null;
  const fac = pick?.faction ?? faction ?? 'princess';
  const farmRooms = rooms ?? FACTIONS[fac]?.rooms ?? [];
  const smithRoom = smith ?? h?.smith ?? 113;
  const s = SMITHS[smithRoom] ?? SMITHS[113];

  const lines = [];
  let kills = 0;
  for (const [item, n] of Object.entries(wants)) {
    const k = dropKey(item);
    if (!k) { warnings.push(`${item}: soldiers never drop it (their shields do not drop at all) — buy it`); continue; }
    const need = Math.ceil(Number(n) / SOLDIER_DROPS[k]);
    kills = Math.max(kills, need);
    lines.push({ item: k, want: Number(n), per_kill: SOLDIER_DROPS[k], kills: need,
                 buy_each: BUY_PRICE[k] ?? null, saves: BUY_PRICE[k] ? BUY_PRICE[k] * Number(n) : null });
  }
  const kills90 = kills ? Math.ceil(kills + 1.3 * Math.sqrt(kills)) : 0;
  const perHour = farmRooms.length * SOLDIER.perRoomPerHour;
  const hours = perHour ? kills / perHour : null;
  // Byproducts: every drop the plan does not want, sold. Expected per kill, times kills, minus
  // what the wanted lines absorb.
  let byproduct = 0;
  for (const [k, pk] of Object.entries(SOLDIER_DROPS)) {
    const wanted = lines.find(l => l.item === k)?.want ?? 0;
    const surplus = Math.max(0, kills * pk - wanted);
    const armour = /armor|gauntlet/.test(k);
    if (armour && !s.armour) continue;
    byproduct += surplus * BASE_VALUE[k] * CONDITION * s.rate;
  }
  const saves = lines.reduce((m, l) => m + (l.saves ?? 0), 0);
  const top = Math.max(0, ...fleetLevels.map(Number).filter(Number.isFinite));
  if (top && top < SOLDIER.level[0])
    warnings.push(`every soldier is level ${SOLDIER.level[0]}-${SOLDIER.level[1]}; the fleet tops out at ${top}. ` +
                  'docs/m59-combat.md: "DO NOT FARM SOLDIERS FOR ARMOUR — THE SPIDER AND THE ORC ARE BOTH BETTER"');
  else if (top && top < SOLDIER.level[1])
    warnings.push(`soldiers run level ${SOLDIER.level[0]}-${SOLDIER.level[1]} against a fleet topping out at ${top}: ` +
                  'the upper half of every roll is above the fleet — fight them in numbers, never alone');
  if (hours != null && hours > 8) warnings.push(`${Math.round(hours)} hours of flagpole output — the rarest line (${lines.sort((a, b) => b.kills - a.kills)[0]?.item}) dominates; consider buying it`);
  return { hall, town: h?.town ?? null, faction: fac, troop: FACTIONS[fac]?.troop ?? null, rooms: farmRooms,
           walk_hops: pick?.hops ?? null, smith: smithRoom, lines, kills, kills90, per_hour: perHour,
           hours: hours == null ? null : Math.round(hours * 10) / 10,
           saves, byproduct: Math.round(byproduct), keep_not_deposit: !!h?.island, warnings };
}

/** One human paragraph for a plan. */
export function describePrefarm(pl) {
  const out = [`prefarm from hall ${pl.hall} (${pl.town ?? '?'}): ${pl.troop ?? '?'} in rooms ${pl.rooms.join(', ')}` +
               `${pl.walk_hops != null ? `, ${pl.walk_hops} hops from the hall` : ''}`];
  for (const l of pl.lines)
    out.push(`  ${l.item.padEnd(14)} want ${String(l.want).padStart(3)}  ${(l.per_kill * 100).toFixed(1)}%/kill  ~${l.kills} kills` +
             `${l.saves ? `  (buying: ${l.saves.toLocaleString()} sh)` : ''}`);
  out.push(`  => ~${pl.kills} kills (90%: ${pl.kills90}); flagpoles make ${pl.per_hour}/h, so ~${pl.hours} h;` +
           ` saves ${pl.saves.toLocaleString()} sh + ~${pl.byproduct.toLocaleString()} sh of byproducts at smith ${pl.smith}`);
  for (const w of pl.warnings) out.push(`  WARNING ${w}`);
  return out.join('\n');
}
