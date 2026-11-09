// Share advisory quarry choices between keeper processes for in-place group hunts.
import { cooperativeStore } from './m59-cooperative-logoff.mjs';
import { OF } from './m59-parse.mjs';

const KIND = 'group-quarry', TTL_MS = 8000, REFRESH_MS = 2000;
const MAX_WALK = 24, WALK_SLACK = 6;
const published = new WeakMap();
const fold = value => String(value ?? '').trim().toLowerCase();
const nameOf = (c, o) => fold(c.rsc?.get?.(o?.nameRsc) ?? o?.name);

function context(pilot) {
  const s = pilot.s, c = s?.client, room = s?.world?.room?.num;
  if (pilot.mode !== 'farm' || !s?.live || !c?.combatReady || c.state !== 'game' ||
      !Number.isInteger(room) || pilot.policy?.assignedRoom !== room || !Number.isInteger(c.selfId) ||
      !Number.isInteger(c.room?.id) || !Object.values(pilot.policy?.gangUp ?? {}).some(r => r.fightInPlace)) return null;
  const epoch = c.idsAsOf?.();
  if (!epoch || epoch.saving) return null;
  return { s, c, room, roomId: c.room.id, since: epoch.last_save_began_at ?? -Infinity };
}

export function spreadGroupQuarries(pilot, candidates, preferId,
                                    { walks, now = Date.now(), store = cooperativeStore } = {}) {
  if (candidates.length < 2 || !walks?.size) return candidates;
  const local = context(pilot);
  if (!local) return candidates;
  const { s, c, room, roomId, since } = local;
  const players = pilot.gangUpPlayersHere();
  const groups = new Map();
  let nearest = Infinity;
  for (const candidate of candidates) {
    const walk = walks.get(candidate.id);
    if (!walk?.found || walk.goal_exempt || !Number.isFinite(walk.length) || walk.length > MAX_WALK) continue;
    const group = pilot.gangUpVerdict(candidate, players);
    if (!group?.fightInPlace || !group.met) continue;
    groups.set(candidate.id, { min: group.min, count: 0, walk: walk.length });
    nearest = Math.min(nearest, walk.length);
  }
  for (const [id, group] of groups) if (group.walk > nearest + WALK_SLACK) groups.delete(id);
  if (groups.size < 2) return candidates;
  let claims;
  try { claims = store(s)?.list(KIND) ?? []; } catch { return candidates; }
  const counted = new Set();
  for (const claim of claims) {
    const group = groups.get(claim.target);
    if (!group || claim.agent === s.name || claim.body === c.selfId || claim.room !== room || claim.roomId !== roomId ||
        !Number.isFinite(claim.at) || claim.at <= since || claim.at > now || now - claim.at > TTL_MS ||
        counted.has(claim.body)) continue;
    const actor = c.room.objects.get(claim.body), quarry = c.room.objects.get(claim.target);
    if (!(actor?.flags & OF.PLAYER) || !quarry || !claim.character || !claim.quarry ||
        nameOf(c, actor) !== claim.character || nameOf(c, quarry) !== claim.quarry) continue;
    counted.add(claim.body);
    group.count++;
  }
  const overflow = candidate => {
    const { min, count } = groups.get(candidate.id);
    return Math.max(0, count - min + 1);
  };
  const spread = candidates.filter(o => groups.has(o.id)).sort((a, b) =>
    Number(b.id === preferId) - Number(a.id === preferId) || overflow(a) - overflow(b));
  let i = 0;
  return candidates.map(o => groups.has(o.id) ? spread[i++] : o);
}

export function publishGroupQuarry(pilot, target, { now = Date.now(), store = cooperativeStore } = {}) {
  const local = context(pilot);
  const group = local && target ? pilot.gangUpVerdict(target) : null;
  if (!group?.fightInPlace || !group.met) return;
  const { s, c, room, roomId } = local;
  const character = fold(c.me?.name), quarry = nameOf(c, target);
  if (!character || !quarry || !Number.isInteger(target.id) || !c.room.objects.has(target.id)) return;
  const last = published.get(pilot);
  if (last?.client === c && last.roomId === roomId && last.id === target.id &&
      now >= last.at && now - last.at < REFRESH_MS) return;
  try {
    const claims = store(s);
    if (!claims) return;
    claims.write(KIND, s.name, { at: now, agent: s.name, body: c.selfId, room, roomId,
      target: target.id, character, quarry });
    published.set(pilot, { client: c, roomId, id: target.id, at: now });
  } catch { /* advisory evidence expires on its own */ }
}
