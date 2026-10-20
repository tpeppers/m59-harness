import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {renderArrivals} from './m59-arrivals-page.mjs';
const dir=mkdtempSync(join(tmpdir(),'arrival-page-')),stateFile=join(dir,'roster.json');
writeFileSync(stateFile,JSON.stringify({a:{credentials:{character:'<script>test</script>'}}}));
let html=await renderArrivals({stateFile,live:[{agent:'a',room_num:39}],query:new URLSearchParams('mode=chalice&to=52'),epoch:{id:'test',at:null,dirty:true}});
assert(html.includes('Arrival explorer'));assert(html.includes('&lt;script&gt;test&lt;/script&gt;'));assert(!html.includes('<script>test</script>'));assert(html.includes('Current inspected resources'));assert(html.includes('not added edge percentiles'));assert(html.includes('/arrivals'));
html=await renderArrivals({stateFile,live:[{agent:'a',room_num:39}],readiness:{a:{unavailable:true,reason:'offline'}}});assert(html.includes('No modeled route'));assert(html.includes('offline'));
console.log('Arrival page: navigation, scenarios, unknown readiness, uncertainty labels and escaped character text passed.');
