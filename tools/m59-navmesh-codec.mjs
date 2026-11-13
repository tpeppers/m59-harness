// Compact mesh transport. Named parallel coordinate arrays preserve axis meaning;
// runtime edge points decode lazily rather than materializing millions of objects.
export const PACKED_NAVMESH_FORMAT='m59-navmesh-packed-room/1';
const encode=array=>Buffer.from(array.buffer,array.byteOffset,array.byteLength).toString('base64');
const decode=(value,Type)=>{if(typeof value!=='string')throw Error('invalid_navigation_array');const bytes=Buffer.from(value,'base64');if(bytes.length%Type.BYTES_PER_ELEMENT)throw Error('invalid_navigation_array_size');return new Type(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));};
export function packNavMesh(mesh){
  const x=[],y=[],floor=[],polygon=[],offsets=[0],to=[],cost=[],kind=[],actions={},pointOffsets=[0],px=[],py=[];
  for(const node of mesh.nodes){
    x.push(node.x);y.push(node.y);floor.push(node.floor??0);polygon.push(node.polygon??-1);
    for(const edge of node.edges){
      if(!['walk','jump'].includes(edge.kind??'walk')||edge.kind==='jump'&&edge.action?.declared!==true)throw Error('unsupported_packed_navigation_action');
      kind.push(edge.kind==='jump'?1:0);if(edge.action)actions[to.length]=edge.action;
      to.push(edge.to);cost.push(edge.cost??NaN);
      for(const p of edge.points??[]){if(!Number.isInteger(p.x)||!Number.isInteger(p.y))throw Error('navigation_points_must_be_wire_integers');px.push(p.x);py.push(p.y);}
      pointOffsets.push(px.length);
    }
    offsets.push(to.length);
  }
  return {format:PACKED_NAVMESH_FORMAT,version:1,room:mesh.room,identity:mesh.identity,provenance:mesh.provenance,polygons:mesh.polygons??[],
    nodes:{x:encode(Int32Array.from(x)),y:encode(Int32Array.from(y)),floor:encode(Float64Array.from(floor)),polygon:encode(Int32Array.from(polygon))},
    edges:{offsets:encode(Uint32Array.from(offsets)),to:encode(Uint32Array.from(to)),cost:encode(Float64Array.from(cost)),kind:encode(Uint8Array.from(kind)),actions,pointOffsets:encode(Uint32Array.from(pointOffsets))},
    points:{x:encode(Int32Array.from(px)),y:encode(Int32Array.from(py))}};
}
export function unpackNavMesh(packed){
  if(packed?.format!==PACKED_NAVMESH_FORMAT||packed.version!==1)throw Error('unsupported_packed_navigation_mesh');
  const x=decode(packed.nodes.x,Int32Array),y=decode(packed.nodes.y,Int32Array),floor=decode(packed.nodes.floor,Float64Array),polygon=decode(packed.nodes.polygon,Int32Array);
  const offsets=decode(packed.edges.offsets,Uint32Array),to=decode(packed.edges.to,Uint32Array),cost=decode(packed.edges.cost,Float64Array),pointOffsets=decode(packed.edges.pointOffsets,Uint32Array);
  const kind=packed.edges.kind?decode(packed.edges.kind,Uint8Array):new Uint8Array(to.length),actions=packed.edges.actions??{};
  const px=decode(packed.points.x,Int32Array),py=decode(packed.points.y,Int32Array);
  if(x.length>200000||to.length>2000000||px.length>16000000||kind.length!==to.length||y.length!==x.length||floor.length!==x.length||polygon.length!==x.length||offsets.length!==x.length+1||cost.length!==to.length||pointOffsets.length!==to.length+1||px.length!==py.length||offsets[0]!==0||offsets.at(-1)!==to.length||pointOffsets[0]!==0||pointOffsets.at(-1)!==px.length)throw Error('invalid_navigation_array_lengths');
  // Validate offsets without allocating an object/closure for every edge. Large
  // room graphs must fit the fine worker's 256 MiB heap before any query runs.
  for(let e=0;e<to.length;e++)if(to[e]>=x.length||kind[e]>1||kind[e]===1&&actions[e]?.declared!==true||pointOffsets[e]>pointOffsets[e+1]||pointOffsets[e+1]>px.length)throw Error('invalid_navigation_edge');
  const nodes=[];
  for(let i=0;i<x.length;i++){
    if(offsets[i]>offsets[i+1]||offsets[i+1]>to.length)throw Error('invalid_navigation_edge_offset');
    let edges;
    const node={x:x[i],y:y[i],floor:floor[i],...(polygon[i]>=0?{polygon:polygon[i]}:{})};
    Object.defineProperty(node,'edges',{enumerable:true,get(){
      if(edges)return edges;edges=[];
      for(let e=offsets[i];e<offsets[i+1];e++){
        const start=pointOffsets[e],end=pointOffsets[e+1];let points;
        const edge={to:to[e],kind:kind[e]===1?'jump':'walk',...(actions[e]?{action:actions[e]}:{}),...(Number.isFinite(cost[e])?{cost:cost[e]}:{})};
        Object.defineProperty(edge,'points',{enumerable:true,get(){return points??=Array.from({length:end-start},(_,k)=>({x:px[start+k],y:py[start+k]}));}});
        edges.push(edge);
      }
      return edges;
    }});
    nodes.push(node);
  }
  const mesh={format:'m59-navmesh-room/1',version:1,room:packed.room,identity:packed.identity,provenance:packed.provenance,polygons:packed.polygons??[],nodes};
  Object.defineProperty(mesh,'_packed',{value:true});return mesh;
}
