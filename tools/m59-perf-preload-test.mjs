import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,basename} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'m59-perf-optin-'));
try {
  for(const flag of [undefined,'0','false','1']) {
    const env={...process.env,M59_PERF_DIR:dir};
    if(flag===undefined)delete env.M59_PERF_LOG;else env.M59_PERF_LOG=flag;
    const run=spawnSync(process.execPath,['--import',new URL('./m59-perf-preload.mjs',import.meta.url).href,
      '--input-type=module','--eval','const p=globalThis[Symbol.for("m59.perf")]; console.log(p?"on":"off"); if(p){p.add("test.probe"); await p.close();}'],
      {env,encoding:'utf8',windowsHide:true,timeout:15000});
    assert.equal(run.status,0,run.stderr);assert.equal(run.stdout.trim(),flag==='1'?'on':'off');
    if(flag!=='1')assert.equal(readdirSync(dir).length,0,'disabled preload wrote logs');
  }
  assert.equal(readdirSync(dir).length,1,'enabled preload did not record the test');
} finally {
  assert.equal(resolve(dir).startsWith(resolve(tmpdir())+'\\')||resolve(dir).startsWith(resolve(tmpdir())+'/'),true);
  assert.equal(basename(dir).startsWith('m59-perf-optin-'),true);rmSync(dir,{recursive:true,force:true});
}
console.log('PASS preload: unset/zero/false are off, explicit one is on, no disabled log writes');
