// Reproduction preserves the complete source policy; scenario changes are explicit.
const copy=v=>structuredClone(v);
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export function clonePolicy(source,{overlay={},identities={}}={}){
 const original=source?.policy??source??{};
 if(!original||typeof original!=='object'||Array.isArray(original))throw Error('source policy must be an object');
 function remap(v){if(typeof v==='string')return identities[v]??v;if(Array.isArray(v))return v.map(remap);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[identities[k]??k,remap(x)]));return v;}
 const base=remap(copy(original)),policy={...base,...copy(overlay)};
 const changes=Object.fromEntries(Object.entries(overlay).filter(([k,v])=>JSON.stringify(canonical(base[k]))!==JSON.stringify(canonical(v))).map(([k,v])=>[k,{source:base[k]??null,scenario:v}]));
 return{policy,changes,sourceKeys:Object.keys(base)};
}
export function policyFidelity(expected,observed){
 const differences=[];for(const [key,want]of Object.entries(expected??{}))if(JSON.stringify(canonical(want))!==JSON.stringify(canonical(observed?.[key])))differences.push({key,expected:want,observed:observed?.[key]??null,missing:!Object.hasOwn(observed??{},key)});
 return{ok:differences.length===0,differences};
}
