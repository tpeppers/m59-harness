// Actual HTTP server/client; no broker, game, character or movement packets.
import assert from'node:assert/strict';import{createServer}from'node:http';import{createRailObserver,postRailAction}from'./m59-rail-observer.mjs';
let calls=0,delay=80,pid=4;const timers=new Set();
const server=createServer((req,res)=>{calls++;let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
 const request=JSON.parse(body);assert.equal(request.agent,'a');assert.equal(request.keeper_pid,4);assert.equal(request.name,'walk_rail');
 const timer=setTimeout(()=>{timers.delete(timer);res.setHeader('x-m59-agent','a');res.setHeader('x-m59-character','A');res.setHeader('x-m59-keeper-pid',String(pid));res.end(JSON.stringify({arrived:true}));},delay);timers.add(timer);
});});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const k={agent:'a',character:'A',pid:4,port:server.address().port},state={...k,in_game:true,room:{num:579,object_id:9},you:{id:7},position_read:{id:7,room_object_id:9,x:96,y:160,row:2,col:1}};
const observer=createRailObserver({agent:'a',fleet:'offline',discover:async()=>new Map([['a',k]]),actionFetch:postRailAction,fetchImpl:async()=>({ok:true,headers:new Headers(),json:async()=>state})});
try{
 assert((await observer.action('walk_rail',{}, {timeoutMs:1000})).arrived);assert.equal(calls,1,'one accepted long action uses one native HTTP request');
 delay=1000;await assert.rejects(observer.action('walk_rail',{}, {timeoutMs:200}),/abort/i);assert.equal(calls,2,'an ambiguous timed-out action is never dispatched twice');
 delay=0;pid=99;await assert.rejects(observer.action('walk_rail',{}, {timeoutMs:1000}),/identity\/refusal/);assert.equal(calls,3,'a changed keeper identity remains terminal');
 console.log('native rail HTTP: delayed response, explicit absolute timeout, single POST, and keeper identity refusal passed');
}finally{for(const timer of timers)clearTimeout(timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
