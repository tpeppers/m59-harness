// Keep transport causes that Error JSON normally drops; never serialize an
// arbitrary request, response, credentials object or enumerable error payload.
export function errorEvidence(error,{depth=0,seen=new Set()}={}){
 if(!error||typeof error!=='object')return{message:String(error??'unknown error').slice(0,1000)};
 if(seen.has(error))return{message:'error cause cycle'};if(depth>=4)return{message:'further causes omitted'};seen.add(error);
 const out={};for(const field of['name','message','code','errno','syscall','address','port'])if(['string','number'].includes(typeof error[field]))out[field]=typeof error[field]==='string'?error[field].slice(0,1000):error[field];
 if(typeof error.stack==='string')out.stack=error.stack.slice(0,4000);
 if(error.cause)out.cause=errorEvidence(error.cause,{depth:depth+1,seen});return out;
}
