import {processStartTimes,START_TIME_TOLERANCE_MS} from './runtime/process-identity.mjs';
import {crossingAdmissionConflict} from './m59-crossing-queue.mjs';
// m59-spotclaims.mjs — Atomic wall reservations shared by keeper processes.
//
// Production runs one keeper per OS process. An in-memory Map therefore cannot stop two
// characters from choosing the same deterministic safe square before either walk lands.
// This store keeps one tiny claim file per character behind an atomic `wx` lock. The lock
// makes "count occupants, then reserve" one operation; the claim file makes the result
// visible to every keeper without involving the broker or the game connection.

import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const PROCESS_STARTED_AT = Date.now();
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const LOCK_TIMEOUT_MS = 3_000;
const BROKEN_LOCK_MS = 5_000;
let sequence = 0;
let explicitConfiguration = null;
const ownPartners = new Map();

const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 20);

// A fleet file alone is not a namespace: the same roster can point at two servers, and
// two fleets can use the same character handles on different servers. Conversely every
// keeper for one fleet/server pair must derive exactly the same directory.
export function spotClaimNamespace({ fleetPath = '', host = '', port = '' } = {}) {
  return hash(JSON.stringify({
    fleet: fleetPath ? resolve(String(fleetPath)).toLowerCase() : '',
    host: String(host).trim().toLowerCase(),
    port: Number(port) || 0,
  }));
}

export function configureSpotClaimStore({ directory, namespace, enabled = true } = {}) {
  explicitConfiguration = enabled ? {
    directory: resolve(String(directory || join('substrate', '.spot-claims'))),
    namespace: String(namespace || 'default'),
  } : { disabled: true };
  const cfg = configuration();
  if (cfg) mkdirSync(cfg.path, { recursive: true });
  return cfg ? { directory: cfg.directory, namespace: cfg.namespace, path: cfg.path } : null;
}

function configuration() {
  if (explicitConfiguration?.disabled) return null;
  const configured = explicitConfiguration ?? (() => {
    const directory = String(process.env.M59_SPOT_CLAIMS_DIR || '').trim();
    if (!directory) return null;       // ordinary imports/tests retain the in-memory APIs
    return {
      directory: resolve(directory),
      namespace: String(process.env.M59_SPOT_CLAIMS_NAMESPACE || 'default'),
    };
  })();
  if (!configured) return null;
  // Hash the namespace again at the filesystem boundary. It may have come from an
  // environment variable, so it must never be able to name a parent directory.
  return { ...configured, path: join(configured.directory, `v1-${hash(configured.namespace)}`) };
}

export const fileSpotClaimsEnabled = () => !!configuration();

function pidAlive(pid) {
  pid = Number(pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === 'EPERM'; }
}

function remove(path) {
  try { unlinkSync(path); return true; }
  catch (e) { if (e?.code !== 'ENOENT') throw e; return false; }
}

function lockOwner(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function clearAbandonedLock(path) {
  const owner = lockOwner(path);
  if (owner?.pid && !pidAlive(owner.pid)) return remove(path);
  if (owner) return false;
  // There is a few-byte interval between `open(wx)` and writing the owner. Only a lock
  // that has stayed unreadable for seconds is abandoned; a current writer is left alone.
  try {
    if (Date.now() - statSync(path).mtimeMs > BROKEN_LOCK_MS) return remove(path);
  } catch (e) {
    if (e?.code === 'ENOENT') return true;
    throw e;
  }
  return false;
}

function withLock(fn) {
  const cfg = configuration();
  if (!cfg) throw new Error('file spot claims are not configured');
  mkdirSync(cfg.path, { recursive: true });
  const path = join(cfg.path, '.claims.lock');
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd = null;
  while (fd == null) {
    try {
      fd = openSync(path, 'wx');
    } catch (e) {
      // Windows can report a sharing/delete-pending race as EPERM rather than
      // EEXIST. Retry acquisition only, bounded by the same deadline. This does
      // not remove a lock on permission/sharing errors or enter without one.
      const sharing=process.platform==='win32'&&['EPERM','EACCES','EBUSY'].includes(e?.code);
      if (e?.code !== 'EEXIST'&&!sharing) throw e;
      if(e?.code==='EEXIST')clearAbandonedLock(path);
      if (Date.now() >= deadline)
        throw new Error(`wall claim store stayed locked for ${LOCK_TIMEOUT_MS}ms`,{cause:e});
      Atomics.wait(LOCK_WAIT, 0, 0, 5);
    }
  }
  try{
    writeFileSync(fd, JSON.stringify({ pid: process.pid, process_started_at: PROCESS_STARTED_AT }));
    fsyncSync(fd);
  }catch(e){try{closeSync(fd);}catch{}remove(path);throw e;}
  try { return fn(cfg.path); }
  finally {
    try { closeSync(fd); } catch {}
    remove(path);
  }
}

function writeExclusive(dir, kind, agent, record) {
  const name = `${kind}-${process.pid}-${hash(agent)}-${Date.now()}-${++sequence}.json`;
  const path = join(dir, name);
  let fd = null, complete = false;
  try {
    fd = openSync(path, 'wx');
    writeFileSync(fd, JSON.stringify(record));
    fsyncSync(fd);
    complete = true;
  } finally {
    if (fd != null) try { closeSync(fd); } catch {}
    if (!complete) remove(path);
  }
  return { path, name };
}

function records(dir, prefix, { retainDead = false } = {}) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix + '-') || !entry.name.endsWith('.json'))
      continue;
    const path = join(dir, entry.name);
    let value;
    try { value = JSON.parse(readFileSync(path, 'utf8')); }
    catch {
      const pid = Number(entry.name.split('-')[1]);
      if (!retainDead && !pidAlive(pid)) { remove(path); continue; }
      // An unreadable record owned by a live process means the store is not safe to use.
      // Failing closed is preferable to sending two characters to the same wall.
      throw new Error(`live wall claim record is unreadable: ${entry.name}`);
    }
    if (!value?.agent) {
      if(retainDead)throw Error('traversal claim identity is unreadable');
      remove(path);continue;
    }
    if (!retainDead && !pidAlive(value.pid)) { remove(path); continue; }
    out.push({ ...value, _path: path, _name: entry.name });
  }

  // A process can die between creating its new claim and deleting its old one. Keep the
  // newest complete record, which makes the create-before-delete move crash-safe.
  const newest = new Map();
  for (const value of out) {
    const old = newest.get(value.agent);
    const at = Number(value.updated_at ?? value.claimed_at ?? 0);
    const oldAt = Number(old?.updated_at ?? old?.claimed_at ?? 0);
    if (!old || at > oldAt || (at === oldAt && value._name > old._name)) {
      if (old) remove(old._path);
      newest.set(value.agent, value);
    } else remove(value._path);
  }
  return [...newest.values()];
}

const stripPrivate = value => Object.fromEntries(
  Object.entries(value).filter(([key]) => !key.startsWith('_')));

function writeParticipantUnlocked(dir, agent, partner) {
  const all = records(dir, 'participant');
  const current = all.find(r => r.agent === agent);
  const normalized = partner ? String(partner) : null;
  if (current?.pid === process.pid && (current.partner ?? null) === normalized) return current;
  const now = Date.now();
  const made = {
    version: 1, agent: String(agent), partner: normalized,
    pid: process.pid, process_started_at: PROCESS_STARTED_AT, updated_at: now,
  };
  const file = writeExclusive(dir, 'participant', agent, made);
  for (const old of all) if (old.agent === agent) remove(old._path);
  return { ...made, _path: file.path, _name: file.name };
}

// Publish the relationship separately from a wall. A keeper already holding a square can
// be paired later; the next selector must see that change without making it abandon/re-take
// the wall merely to refresh metadata.
export function rememberFileSpotPartner(agent, partner = null) {
  if (!agent) return false;
  ownPartners.set(String(agent), partner ? String(partner) : null);
  if (!fileSpotClaimsEnabled()) return false;
  withLock(dir => writeParticipantUnlocked(dir, String(agent), partner));
  return true;
}

function snapshotUnlocked(dir) {
  const claims = records(dir, 'claim');
  const participants = records(dir, 'participant');
  return { claims, participants };
}

export function fileSpotClaimSnapshot() {
  return withLock(snapshotUnlocked);
}

function participantOf(snapshot, agent) {
  const row = snapshot.participants.find(r => r.agent === agent);
  if (row) return row;
  const claim = snapshot.claims.find(r => r.agent === agent);
  return claim ? { agent, partner: claim.partner ?? null } : null;
}

function recordedPartners(snapshot, a, b) {
  const ar = participantOf(snapshot, a), br = participantOf(snapshot, b);
  return ar?.partner === b && br?.partner === a;
}

function mayShare(snapshot, a, b, callback) {
  try { if (callback?.(a, b)) return true; } catch {}
  return recordedPartners(snapshot, a, b);
}

function occupants(snapshot, room, col, row) {
  room = Number(room); col = Number(col); row = Number(row);
  return snapshot.claims.filter(r =>
    Number(r.room) === room && Number(r.col) === col && Number(r.row) === row);
}

export function fileSpotOccupancy(agent, room, col, row,
                                  { snapshot = null, mayShare: share = null } = {}) {
  snapshot ??= fileSpotClaimSnapshot();
  return occupants(snapshot, room, col, row)
    .filter(r => r.agent !== agent && !mayShare(snapshot, String(agent), r.agent, share)).length;
}

export function fileSpotTakenByAnother(agent, room, col, row, cap = 1,
                                       { snapshot = null, mayShare: share = null } = {}) {
  snapshot ??= fileSpotClaimSnapshot();
  const blocked = occupants(snapshot, room, col, row)
    .filter(r => r.agent !== agent && !mayShare(snapshot, String(agent), r.agent, share));
  const limit = Number.isFinite(Number(cap)) ? Math.max(1, Math.floor(Number(cap))) : Infinity;
  if (blocked.length < limit) return null;
  return blocked[0]?.agent ?? 'another keeper';
}

export function claimFileSpot(agent, room, col, row,
                              { cap = Infinity, partner = undefined, mayShare: share = null } = {}) {
  if (!fileSpotClaimsEnabled()) return null;
  agent = String(agent);
  if (partner !== undefined) ownPartners.set(agent, partner ? String(partner) : null);
  return withLock(dir => {
    if (partner !== undefined || ownPartners.has(agent))
      writeParticipantUnlocked(dir, agent, ownPartners.get(agent) ?? null);
    const snapshot = snapshotUnlocked(dir);
    const mine = snapshot.claims.find(r => r.agent === agent);
    if (mine && Number(mine.room) === Number(room) && Number(mine.col) === Number(col) &&
        Number(mine.row) === Number(row)) return true;

    const limit = Number.isFinite(Number(cap)) ? Math.max(1, Math.floor(Number(cap))) : Infinity;
    const occupied = occupants(snapshot, room, col, row)
      .filter(r => r.agent !== agent && !mayShare(snapshot, agent, r.agent, share));
    if (occupied.length >= limit) return false;

    const now = Date.now();
    const made = {
      version: 1, agent, partner: ownPartners.get(agent) ?? null,
      room: Number(room), col: Number(col), row: Number(row),
      pid: process.pid, process_started_at: PROCESS_STARTED_AT,
      claimed_at: now, updated_at: now,
    };
    const file = writeExclusive(dir, 'claim', agent, made);
    // Create first, release the old square second. A crash can temporarily leave two
    // complete records, but the next reader deterministically keeps this newer one.
    for (const old of snapshot.claims) if (old.agent === agent) remove(old._path);
    return !!file;
  });
}

export function releaseFileSpot(agent) {
  if (!fileSpotClaimsEnabled()) return null;
  return withLock(dir => {
    let released = 0;
    for (const old of records(dir, 'claim')) {
      if (old.agent !== String(agent)) continue;
      if (remove(old._path)) released++;
    }
    return released;
  });
}

export function fileClaimedSpotList({ snapshot = null } = {}) {
  snapshot ??= fileSpotClaimSnapshot();
  return snapshot.claims.map(r => ({ at: `${r.room}:${r.col},${r.row}`, agent: r.agent }));
}

export function fileSpotHeldBy(agent, { snapshot = null } = {}) {
  snapshot ??= fileSpotClaimSnapshot();
  const r = snapshot.claims.find(x => x.agent === String(agent));
  return r ? { room: Number(r.room), col: Number(r.col), row: Number(r.row) } : null;
}

// Passage claims use the same fleet/server namespace and atomic store as walls.
// No timeout can evict a live body from a passage. Only its owner releases it
// after a confirmed exit; dead-process claims are removed by records().
export function reserveFilePassage(agent, room, zone, {flow=null,entryPending=false,entry=null,character=null}={}) {
  if (!fileSpotClaimsEnabled()) return null;
  return withLock(dir => {
    const all = records(dir, 'passage');
    const conflict = all.find(r => r.room === room && r.zone === zone && crossingAdmissionConflict(r,{agent:String(agent),flow,entry}));
    if (conflict) return { ok: false, agent: conflict.agent };
    const own = all.find(r => r.agent === String(agent));
    if(own&&own.pid!==process.pid)return {ok:false,reason:'passage_owner_process_changed'};
    if (own?.room === room && own.zone === zone) return (own.flow??null)===flow?{ok:true}:{ok:false,reason:'passage_flow_changed'};
    if (own) return { ok: false, reason: 'passage_exit_unconfirmed' };
    writeExclusive(dir, 'passage', String(agent), { agent: String(agent), room, zone, flow, entryPending, entry, character,
      pid: process.pid, process_started_at:PROCESS_STARTED_AT, updated_at: Date.now() });
    return { ok: true };
  });
}
export function filePassageSnapshot(){
 if(!fileSpotClaimsEnabled())return null;
 return withLock(dir=>records(dir,'passage').map(({_path,_name,...record})=>record));
}
// Retag only this process's existing reservation. It remains held throughout;
// this admits no new body and never releases another live keeper's claim.
export function retagOwnFilePassage(agent,room,zone,flow){
 if(!fileSpotClaimsEnabled())return null;if(typeof flow!=='string'||!flow||flow.length>2048)throw Error('invalid passage convoy flow');
 return withLock(dir=>{const all=records(dir,'passage'),own=all.find(r=>r.agent===String(agent));if(!own)return{ok:false,reason:'passage_not_held'};if(own.pid!==process.pid||own.room!==room||own.zone!==zone)return{ok:false,reason:'passage_owner_or_location_changed'};if(own.flow===flow)return{ok:true,changed:false};const{_path,_name,...record}=own;writeExclusive(dir,'passage',String(agent),{...record,flow,updated_at:Date.now()});remove(_path);return{ok:true,changed:true};});
}
// Called only after the owning native session observes its body inside the zone.
export function confirmFilePassageEntry(agent,room,zone){
 if(!fileSpotClaimsEnabled())return null;
 return withLock(dir=>{const own=records(dir,'passage').find(r=>r.agent===String(agent));
  if(!own||own.pid!==process.pid||own.room!==room||own.zone!==zone)return false;
  if(!own.entryPending)return true;
  const {_path,_name,...record}=own;writeExclusive(dir,'passage',String(agent),{...record,entryPending:false,updated_at:Date.now()});remove(_path);return true;
 });
}
export function releaseFilePassage(agent) {
  if (!fileSpotClaimsEnabled()) return null;
  return withLock(dir => {
    for (const r of records(dir, 'passage'))
      if (r.agent === String(agent) && r.pid === process.pid) remove(r._path);
    return true;
  });
}

// Map entry can precede a narrow crossing by several walking legs. Reserve
// that complete transit before entry, independently of packet-level passages.
// A dead driver does not prove that its character left the constrained room.
const traversalRecords=dir=>{
  const all=records(dir,'traversal',{retainDead:true});
  if(all.some(r=>!Number.isSafeInteger(r.room)||typeof r.token!=='string'||!r.token||
    !['admitted','entered','stopped'].includes(r.phase)||!Number.isSafeInteger(r.pid)||r.pid<=0))
    throw Error('traversal claim is unusable');
  return all.sort((a,b)=>(b.updated_at??0)-(a.updated_at??0));
};
const traversalView=r=>r&&({agent:r.agent,room:r.room,token:r.token,phase:r.phase,
  pid:r.pid,driver_alive:pidAlive(r.pid),updated_at:r.updated_at});
export function reserveFileTraversal(agent,room,token){
  if(!fileSpotClaimsEnabled())return null;
  if(!agent||!Number.isSafeInteger(room)||!token)throw Error('invalid traversal admission');
  return withLock(dir=>{
    const all=traversalRecords(dir),own=all.find(r=>r.agent===String(agent));
    if(own?.room===room&&own.token===token)return {ok:true,lease:traversalView(own)};
    const other=own??all.find(r=>r.room===room);
    if(other)return {ok:false,lease:traversalView(other)};
    const made={agent:String(agent),room,token,phase:'admitted',pid:process.pid,updated_at:Date.now()};
    writeExclusive(dir,'traversal',String(agent),made);
    return {ok:true,lease:traversalView(made)};
  });
}
export function markFileTraversal(lease,phase){
  if(!fileSpotClaimsEnabled())return null;
  if(!['entered','stopped'].includes(phase))throw Error('invalid traversal phase');
  return withLock(dir=>{
    const all=traversalRecords(dir),own=all.find(r=>r.token===lease.token&&r.agent===lease.agent&&r.room===lease.room);
    if(!own||own.pid!==process.pid)return false;
    const {_path,_name,...made}=own;
    writeExclusive(dir,'traversal',own.agent,{...made,phase,updated_at:Date.now()});
    for(const r of all)if(r.token===own.token&&r.agent===own.agent)remove(r._path);
    return true;
  });
}
export function releaseFileTraversal(lease,proof){
  if(!fileSpotClaimsEnabled())return null;
  if(proof?.confirmed!==true||proof.agent!==lease.agent||!Number.isInteger(proof.room)||
      proof.room===lease.room||!Number.isFinite(proof.at)||Math.abs(Date.now()-proof.at)>5000)return false;
  return withLock(dir=>{
    const all=traversalRecords(dir),own=all.find(r=>r.token===lease.token&&r.agent===lease.agent&&r.room===lease.room);
    if(!own)return true;
    // An admitted driver outside the room has not entered yet. A waiter must
    // not steal its ticket during the await before the first crossing packet.
    if(own.phase==='admitted'&&pidAlive(own.pid))return false;
    for(const r of all)if(r.token===own.token&&r.agent===own.agent)remove(r._path);
    return true;
  });
}

// Run during service startup, not per movement packet. A recycled live PID
// cannot own a record written before that process was created. Unknown process
// identity retains the record. Query outside the mutex, then compare the exact
// immutable record again under lock before removing positively dead ownership.
export function reconcileDeadSpotClaims({starts=processStartTimes,live=pidAlive,now=Date.now(),toleranceMs=START_TIME_TOLERANCE_MS}={}){
 if(!fileSpotClaimsEnabled())return{checked:0,removed:[],unknown:[]};
 const snapshot=withLock(dir=>readdirSync(dir).filter(n=>/^(claim|passage|participant)-.*\.json$/.test(n)).flatMap(name=>{
  try{const path=join(dir,name),raw=readFileSync(path,'utf8'),record=JSON.parse(raw);return Number.isSafeInteger(record.pid)&&record.pid>0?[{path,name,raw,record}]:[];}catch{return[];}
 }));
 const pids=[...new Set(snapshot.map(s=>s.record.pid).filter(pid=>live(pid)))],born=starts(pids),removed=[],unknown=[];
 const candidates=snapshot.filter(s=>{
  const r=s.record;if(!live(r.pid)){s.reason='owner process is absent';return true;}
  const start=born.get(r.pid),written=Number(r.updated_at??r.claimed_at??r.process_started_at);
  if(Number.isFinite(start)&&start>0&&start<=now+toleranceMs&&Number.isFinite(written)&&written>0&&written<=now+toleranceMs&&start>written+toleranceMs){s.reason='record predates current process';s.process_created_at=start;return true;}
  if(!Number.isFinite(start)||!Number.isFinite(written))unknown.push({name:s.name,pid:r.pid});return false;
 });
 withLock(()=>{for(const s of candidates){let current;try{current=readFileSync(s.path,'utf8');}catch{continue;}if(current!==s.raw)continue;if(remove(s.path))removed.push({name:s.name,agent:s.record.agent,pid:s.record.pid,record_at:s.record.updated_at??s.record.claimed_at??s.record.process_started_at,process_created_at:s.process_created_at??null,reason:s.reason});}});
 return{checked:snapshot.length,removed,unknown};
}
