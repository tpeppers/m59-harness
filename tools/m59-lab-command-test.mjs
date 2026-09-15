import assert from 'node:assert/strict';
import {parseLabCommand,validateLabRoster} from './m59-lab-command.mjs';
const args=['--fleet','tour-shadow','--game-port','18959','--admin-port','18998'];
assert.equal(parseLabCommand([...args,'--check']).fleet,'tour-shadow');
assert.deepEqual(parseLabCommand([...args,'--','tools/m59-pilgrimage.mjs','--reverse']).command,['tools/m59-pilgrimage.mjs','--reverse']);
assert.equal(parseLabCommand([...args,'--scope','reverse-1','--check']).scope,'reverse-1');
assert.throws(()=>parseLabCommand([...args,'--scope','../prod','--check']));
for(const bad of [[],['--fleet','prod','--game-port','18959','--admin-port','18998'],
 ['--fleet','../prod','--game-port','18959','--admin-port','18998'],
 ['--fleet','tour','--game-port','5959','--admin-port','18998'],
 ['--fleet','tour','--game-port','18959','--admin-port','9998'],
 ['--fleet','tour','--game-port','18959','--admin-port','18959'],
 [...args,'--','tools/m59-service.mjs','--fleet','prod']])assert.throws(()=>parseLabCommand(bad));
const row=(host,port)=>({credentials:{host,port}});
assert.equal(validateLabRoster({a:row('127.0.0.1',18959),b:row('localhost',18959)},18959),2);
for(const roster of [{},[],{a:row('76.214.42.186',5959)},{a:row('127.0.0.1',18959),b:row('127.0.0.1',17959)}, {a:{}}])assert.throws(()=>validateLabRoster(roster,18959));
console.log('17 lab command checks passed');
