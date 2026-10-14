#!/usr/bin/env node
// SELF-HEAL OF A STALE selfId — the regression test for the frozen-character bug.
//
//   node tools/m59-selfheal-test.mjs
//
// selfId is set only by BP.PLAYER (one per room entry). If it goes stale, `self`
// resolves to undefined and the character is BLIND: no position, no room, every
// tick "no room or position yet" — while the session stays alive, so the liveness
// guard never fires and nothing recovers it. Re-requesting room contents cannot
// help, because BP.PLAYER is not resent. The heal: on ROOM_CONTENTS, if selfId
// does not resolve and a player object in the fresh contents carries OUR unique
// character name, re-bind selfId to it. These tests pin that behaviour on real
// packed packets, exactly like m59-appearance-test.mjs.
import assert from 'node:assert/strict';
import { M59Client } from './m59-client.mjs';

const BP = { ROOM_CONTENTS: 134 };
const u8 = value => Buffer.from([value & 0xff]);
const u16 = value => { const out = Buffer.alloc(2); out.writeUInt16LE(value & 0xffff); return out; };
const u32 = value => { const out = Buffer.alloc(4); out.writeUInt32LE(value >>> 0); return out; };
const i32 = value => { const out = Buffer.alloc(4); out.writeInt32LE(value); return out; };

const object = ({ id, icon = 950, name = 900, flags = 0 }) => Buffer.concat([
  u32(id), u32(icon), u32(name), u32(flags), i32(0),
  u16(0),                    // LIGHT_FLAG_NONE
  u8(1), u16(1),            // base ANIMATE_NONE, group 1
  u8(0),                     // base overlay count
]);
const motion = () => Buffer.concat([u8(1), u16(2), u8(0)]);
const roomObject = (value) => Buffer.concat([
  object(value), u16(value.y), u16(value.x), u16(value.angle), motion(),
]);
const roomContents = (roomId, objects) =>
  Buffer.concat([u32(roomId), u16(objects.length), ...objects.map(roomObject)]);

// OF.PLAYER is 0x0004 (m59-parse.mjs).
const PLAYER = 0x0004;
const resources = new Map([
  [900, 'JayB'], [901, 'rat'], [902, 'Kermit'],
  [950, 'bta.bgf'], [951, 'rat.bgf'],
]);

// 1. THE HEAL: a stale selfId is re-bound to the player object carrying our name.
{
  const client = new M59Client({ resources, verbose: false });
  client.inGame = true;
  client.me = { name: 'JayB' };
  client.selfId = 4242;   // stale: no such object will exist
  assert.equal(client.self, undefined, 'precondition: stale selfId means no self');

  client.onGameMessage(BP.ROOM_CONTENTS, roomContents(800, [
    { id: 501, name: 901, flags: 0, x: 672, y: 736, angle: 0 },          // a rat
    { id: 777, name: 900, flags: PLAYER, x: 864, y: 800, angle: 1024 },  // US
  ]));
  assert.equal(client.selfId, 777, 'selfId re-bound to the object carrying our name');
  assert.equal(client.self?.col, 13, 'self resolves again (x=864 -> col 13)');
  assert.equal(client.self?.row, 12, 'self resolves again (y=800 -> row 12)');
}

// 2. NO FALSE HEAL: another player's object must not capture our identity.
{
  const client = new M59Client({ resources, verbose: false });
  client.inGame = true;
  client.me = { name: 'JayB' };
  client.selfId = null;

  client.onGameMessage(BP.ROOM_CONTENTS, roomContents(800, [
    { id: 501, name: 902, flags: PLAYER, x: 672, y: 736, angle: 0 },  // Kermit, not us
  ]));
  assert.notEqual(client.selfId, 501, 'a different-named player does not capture selfId');
  assert.equal(client.selfId, null, 'selfId stays unset when we are not in the room');
}

// 3. An id resolving to our correctly named player is retained.
{
  const client = new M59Client({ resources, verbose: false });
  client.inGame = true;
  client.me = { name: 'JayB' };
  client.selfId = 777;

  client.onGameMessage(BP.ROOM_CONTENTS, roomContents(800, [
    { id: 777, name: 900, flags: PLAYER, x: 864, y: 800, angle: 1024 },
    { id: 501, name: 901, flags: 0, x: 672, y: 736, angle: 0 },
  ]));
  assert.equal(client.selfId, 777, 'a resolving selfId is left alone');
  assert.equal(client.self?.id, 777);
}

// A save reuses the old id for another player. Resolving it must not follow
// that player's position; our own fresh named object identifies this body.
{
  const c=new M59Client({resources,verbose:false});c.inGame=true;c.me={name:'JayB'};c.selfId=501;
  c.onGameMessage(BP.ROOM_CONTENTS,roomContents(800,[
    {id:501,name:902,flags:PLAYER,x:672,y:736,angle:0},
    {id:777,name:900,flags:PLAYER,x:864,y:800,angle:0},
  ]));
  assert.equal(c.selfId,777);assert.equal(c.self.col,13);assert.equal(c.self.row,12);
}
// If the body cannot be positively identified, no foreign pose is exposed.
{
  const c=new M59Client({resources,verbose:false});c.inGame=true;c.me={name:'JayB'};c.selfId=501;let requests=0;
  c.requestPlayer=()=>requests++;
  c.onGameMessage(BP.ROOM_CONTENTS,roomContents(800,[{id:501,name:902,flags:PLAYER,x:672,y:736,angle:0}]));
  assert.equal(c.selfId,null);assert.equal(c.self,undefined);assert.equal(requests,1);
}

// 4. NO HEAL FROM A NON-PLAYER OBJECT with our name (a sign, a mailbox).
{
  const client = new M59Client({ resources, verbose: false });
  client.inGame = true;
  client.me = { name: 'JayB' };
  client.selfId = null;

  client.onGameMessage(BP.ROOM_CONTENTS, roomContents(800, [
    { id: 501, name: 900, flags: 0, x: 672, y: 736, angle: 0 },  // our name, no PLAYER flag
  ]));
  assert.equal(client.selfId, null, 'a non-player object with our name is not us');
}

console.log('m59 selfheal: 6 scenarios passed on packed offline packets');
