#!/usr/bin/env node
// Offline receipt, source, persistence, fleet isolation, filtering and rendering regressions.
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, readdirSync, appendFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommunicationsArchive, communicationsDirFor, communicationSource, communicationFilters, readCommunications, PLAYER_COMMUNICATION_CHANNELS } from './m59-communications.mjs';
import { communicationsReport, renderCommunications, fleetCommunications, renderFleetCommunications } from './m59-communications-page.mjs';
import { M59Client, BP, OF } from './m59-client.mjs';

const root = mkdtempSync(join(tmpdir(), 'm59-communications-'));
const env = { M59_EVIDENCE_DIR: root };
const stateFile = join(root, 'prod.json');
const at = Date.parse('2026-09-29T01:00:00Z');
let checks = 0;
const eq = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
const yes = value => { assert.ok(value); checks++; };
const saidBody = (speaker, name, channel, format) => {
  const b = Buffer.alloc(13); b.writeUInt32LE(speaker, 0); b.writeUInt32LE(name, 4);
  b[8] = channel; b.writeUInt32LE(format, 9); return b;
};
try {
  writeFileSync(stateFile, JSON.stringify({t1:{credentials:{character:'Fleet One'}},t2:{credentials:{character:'Fleet Two'}}}));
  const a = new CommunicationsArchive({ stateFile, agent: 't1', env });
  const c = new M59Client({ verbose: false, resources: new Map([[10, 'Visitor'], [11, 'Shopkeeper'], [12, 'Fleet One'], [100, 'hello <script>alert(1)</script>'], [101, 'Buy something!']]) });
  c.selfId = 1; c.me = { name: 'Fleet One' };
  c.room = { objects: new Map([[2, { nameRsc: 10, flags: OF.PLAYER }], [3, { nameRsc: 11, flags: 0 }]]) };
  c.onCommunication = ev => a.record({ ...ev, at }, c);
  c.onGameMessage(BP.SAID, saidBody(2, 10, 1, 100));
  c.onGameMessage(BP.SAID, saidBody(3, 11, 5, 101));
  c.onGameMessage(BP.SAID, saidBody(1, 12, 1, 100)); // own echo excluded
  const sys = Buffer.alloc(4); sys.writeUInt32LE(101);
  c.onGameMessage(BP.MESSAGE, sys);
  c.onGameMessage(BP.SYS_MESSAGE, sys);
  c.onGameMessage(BP.SAID, saidBody(7, 11, 7, 101)); // no observed sender
  // A responder failure must not erase the already-received line.
  c.onSaid = () => { throw new Error('reply failure'); };
  assert.throws(() => c.onGameMessage(BP.SAID, saidBody(2, 10, 1, 100)), /reply failure/);
  checks++; c.onSaid = null;
  const dir = communicationsDirFor(stateFile, env);
  let report = await readCommunications({ dir, day: '2026-09-29' });
  eq(report.total, 2);
  eq(report.counts, { player: 2, npc: 0, system: 0, unknown: 0 });
  eq(c.chat.length, 2); // archive has not expanded the responder's speech-only ring
  eq(a.record({ kind: 'said', speaker: 999, name: 'Fleet One', type: 'say', text: 'echo', at }, c), null);
  eq(report.rows[0].recipient, 'Fleet One');
  yes(report.rows[0].text.includes('<script>'));
  eq(communicationSource({ kind: 'said', speaker: 2, name: 'Recycled', type: 'resource' }, c).source, 'unknown');
  c.playersOnline.set(8, { name: 'Remote' });
  eq(communicationSource({ kind: 'said', speaker: 8, name: 'Remote', type: 'group' }, c).evidence, 'online-player');
  eq(communicationSource({ kind: 'said', speaker: 9, name: 'DM', type: 'dm' }, c).source, 'player');
  eq(communicationSource({ kind: 'said', speaker: 3, name: 'Shopkeeper', type: 'say' }, c).source, 'npc');
  const ev = { kind: 'said', speaker: 2, name: 'Visitor', type: 'broadcast', text: 'repeated', at };
  const b = new CommunicationsArchive({ stateFile, agent: 't2', env });
  b.record(ev, { ...c, me: { name: 'Fleet Two' } });
  a.record(ev, c); a.record(ev, c); // no time/text dedupe losing intentional repeats
  const restarted = new CommunicationsArchive({ stateFile, agent: 't1', env });
  restarted.record(ev, c);
  restarted.record({ ...ev, at: at + 86400000 }, c);
  report = await readCommunications({ dir, day: '2026-09-29' });
  eq(report.total, 6);
  eq(new Set(report.rows.map(r => r.id)).size, 6);
  eq((await readCommunications({ dir, day: '2026-09-30' })).total, 1);
  eq((await readCommunications({ dir, day: '2026-09-29', source: 'player' })).total, 6);
  eq((await readCommunications({ dir, day: '2026-09-29', source: 'npc' })).total, 0);
  eq((await readCommunications({ dir, day: '2026-09-29', recipient: 'Fleet Two' })).total, 1);
  eq((await readCommunications({ dir, day: '2026-09-29', sender: 'visitor', channel: 'broadcast', q: 'PEAT' })).total, 4);
  const page1 = await readCommunications({ dir, day: '2026-09-29', limit: 4 });
  const page2 = await readCommunications({ dir, day: '2026-09-29', limit: 4, offset: page1.next_offset });
  eq(new Set([...page1.rows, ...page2.rows].map(r => r.id)).size, 6);
  eq(page2.next_offset, null);
  const shadowDir = communicationsDirFor(join(root, 'shadow.json'), env);
  yes(shadowDir !== dir);
  eq((await readCommunications({ dir: shadowDir, day: '2026-09-29' })).total, 0);
  const file = join(dir, '2026-09-29', readdirSync(join(dir, '2026-09-29'))[0]);
  appendFileSync(file, '{"partial":');
  restarted.record(ev, c);
  report = await readCommunications({ dir, day: '2026-09-29' });
  eq(report.total, 7); eq(report.malformed, 1);
  const params = new URLSearchParams('date=2026-09-29&source=player&q=script');
  const view = await communicationsReport({ stateFile, env, params });
  eq(view.total, 2);
  const html = renderCommunications(view, params);
  yes(!html.includes('<script>')); yes(html.includes('&lt;script&gt;'));
  yes(html.includes('Player communications')); yes(html.includes('malformed or partial'));
  const fleetParams = new URLSearchParams('hours=48&comm_date=2026-09-29&comm_source=player&comm_q=script');
  const fleetView = await fleetCommunications({ stateFile, params: fleetParams, local: true, env });
  eq(fleetView.report.total, 2);
  const panel = renderFleetCommunications(fleetView, { basePath: '/fleet', hours: 48 });
  yes(panel.includes('action="/fleet#communications"'));
  yes(!panel.includes('name="comm_source"')); yes(panel.includes('name="hours" value="48"'));
  yes(panel.includes('&lt;script&gt;')); yes(!panel.includes('<script>'));
  const nextPanel = renderFleetCommunications({ ...fleetView, report: { ...fleetView.report, next_offset: 200 } }, { basePath: '/fleet', hours: 48 });
  yes(nextPanel.includes('comm_offset=200')); yes(nextPanel.includes('hours=48#communications'));
  eq(await fleetCommunications({ stateFile: null, params: fleetParams, local: false, env }), { local: false });
  const failedView = await fleetCommunications({ stateFile, params: new URLSearchParams('comm_date=invalid'), local: true, env });
  yes(renderFleetCommunications(failedView).includes('role="alert"'));
  process.env.M59_LEDGER_DIR = join(root, 'ledger');
  const { renderDashboard } = await import('./m59-dashboard.mjs');
  const dashboard = renderDashboard({ communications: fleetView, communicationPath: '/fleet', hours: 48 });
  yes(dashboard.includes('id="communications"')); yes(dashboard.includes('hello &lt;script&gt;'));
  yes(dashboard.includes('name="comm_q" value="script"')); yes(!dashboard.includes('http-equiv="refresh"'));
  for (const bad of ['date=2026-02-30', 'date=../../foo', 'source=wat', 'offset=-1']) {
    assert.throws(() => communicationFilters(new URLSearchParams(bad))); checks++;
  }
  eq(communicationFilters(new URLSearchParams(), at).day, '2026-09-29');
  const blockedRoot = join(root, 'blocked'); writeFileSync(blockedRoot, 'file');
  let errors = 0;
  const broken = new CommunicationsArchive({ stateFile, agent: 't1', env: { M59_EVIDENCE_DIR: blockedRoot }, onError: () => errors++ });
  eq(broken.record(ev, c), null); eq(errors, 1); eq(broken.errors, 1);

  // Exercise the real Session login observer on two fresh clients, without a socket.
  // Abort the fake login after receipt so normal post-login world setup never runs.
  process.env.M59_EVIDENCE_DIR = root;
  process.env.M59_RECORD_DIR = join(root, 'recordings');
  const { Session } = await import('./m59-session.mjs');
  const originalLogin = M59Client.prototype.login;
  M59Client.prototype.login = async function() {
    this.me = { name: 'Session Receiver' };
    this.onCommunication({ ...ev, at });
    throw new Error('offline login boundary');
  };
  try {
    const s = new Session('integration', { communicationStateFile: stateFile });
    s.recorder.enabled = false;
    for (let i = 0; i < 2; i++) {
      await assert.rejects(s.joinOnce({ account: 'fake', password: 'fake' }), /offline login boundary/); checks++;
    }
    eq((await readCommunications({ dir, day: '2026-09-29', recipient: 'Session Receiver' })).total, 2);
    s.pacer.stop?.();
  } finally { M59Client.prototype.login = originalLogin; }
  const raw = [];
  const early = new M59Client({verbose:false,resources:new Map()});
  early.onCommunication = ev => raw.push(ev);
  const welcome=Buffer.from('hello during login','latin1'), login=Buffer.alloc(3+welcome.length);
  login[0]=34;login.writeUInt16LE(welcome.length,1);welcome.copy(login,3);
  const logs=[];early.log=(...args)=>logs.push(args.join(' '));
  early.onMessage(login);eq(raw.length,0);yes(!logs.join(' ').includes('hello during login'));
  early.state='game';early.onMessage(Buffer.from([BP.SAID,1]));
  eq(raw.length,0);
  early.onMessage(Buffer.from([BP.MESSAGE,1]));eq(raw.length,0);
  early.onGameMessage(BP.SAID,saidBody(2,10,9,999));eq(raw[0].decoded,false);
  // Exclusions happen before creating any directory or scheduling a disk write.
  const quietState=join(root,'quiet.json');writeFileSync(quietState,'{}');
  const quiet=new CommunicationsArchive({stateFile:quietState,agent:'quiet',env});
  for(const type of ['resource','message','group','group-one','guild','unknown'])
    eq(quiet.record({...ev,type},c),null);
  eq(quiet.record({kind:'message',text:'combat spam',at},c),null);
  eq(quiet.record({...ev,speaker:3,name:'Shopkeeper',type:'say'},c),null);
  yes(!existsSync(quiet.dir));
  for(const type of PLAYER_COMMUNICATION_CHANNELS) yes(quiet.record({...ev,type},c));
  eq((await readCommunications({dir:quiet.dir,day:'2026-09-29'})).total,5);
  const quietFile=join(quiet.dir,'2026-09-29',readdirSync(join(quiet.dir,'2026-09-29'))[0]);
  yes(!readFileSync(quietFile,'utf8').includes('combat spam'));
  // Legacy noisy records cannot fill the first page or its filter options.
  const legacy=Array.from({length:250},(_,i)=>({version:1,id:'old'+i,at,source:'system',channel:'system',recipient:'Noise',text:'old combat'}));
  appendFileSync(quietFile,'\n'+legacy.map(x=>JSON.stringify(x)).join('\n')+'\n');
  const clean=await readCommunications({dir:quiet.dir,day:'2026-09-29',limit:2});
  eq(clean.total,5);eq(clean.rows.length,2);eq(clean.next_offset,2);yes(!clean.recipients.includes('Noise'));yes(!clean.channels.includes('system'));
  // The event stream remains available to bot logic even when general logs are quiet.
  const received=[];c.log=(...args)=>received.push(args.join(' '));
  const before=c.evSeq;c.onGameMessage(BP.MESSAGE,sys);c.onGameMessage(BP.SAID,saidBody(2,10,1,100));
  eq(c.eventsSince(before).map(x=>x.kind),['message','said']);eq(received,[]);
  // Exclude the full roster, including offline and human-piloted fleet members.
  const membersState=join(root,'members.json');
  writeFileSync(membersState,JSON.stringify({a:{credentials:{character:'Fleet One'}},offline:{credentials:{character:'Fleet Two'}},human:{credentials:{character:'Human Pilot'}}}));
  const members=new CommunicationsArchive({stateFile:membersState,agent:'a',env});
  for(const type of PLAYER_COMMUNICATION_CHANNELS)eq(members.record({...ev,name:' fLeEt TwO ',type},c),null);
  eq(members.record({...ev,name:'Human Pilot'},c),null);yes(!existsSync(members.dir));
  yes(members.record({...ev,name:'Fleet Two Visitor'},c));
  yes(members.record({...ev,name:'Outsider'},c));
  // Existing writers notice new roster membership without reconnecting.
  writeFileSync(membersState,JSON.stringify({a:{credentials:{character:'Fleet One'}},added:{credentials:{character:'Outsider'}}}));
  eq(members.record({...ev,name:'OUTSIDER'},c),null);
  const memberReport=await communicationsReport({stateFile:membersState,env,params:new URLSearchParams('date=2026-09-29')});
  eq(memberReport.total,1);eq(memberReport.rows[0].sender,'Fleet Two Visitor');eq(memberReport.counts.player,1);
  // Membership cannot be guessed if the roster is unreadable; do not write then.
  writeFileSync(membersState,'broken roster');let memberErrors=0;members.onError=()=>memberErrors++;
  eq(members.record({...ev,name:'Another Outsider'},c),null);eq(memberErrors,1);
  console.log(`${checks} communications assertions passed; no game connection opened.`);
} finally {
  // root is exclusively this test's mkdtemp directory, never a fleet path.
  rmSync(root, { recursive: true, force: true });
}
