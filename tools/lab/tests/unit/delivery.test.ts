import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,chmod,stat,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { command,packageSource } from '../../../../scripts/delivery.mjs';
import { sourceIdentity } from '../../../../scripts/source-state.mjs';

test('Packaging preserves executable modes and fixed byte identity after extraction',async()=>{
  const root=await mkdtemp(join(tmpdir(),'clone-package-')),source=join(root,'source'),extracted=join(root,'extracted');await mkdir(source);await mkdir(extracted);
  const file=join(source,'build.sh');await writeFile(file,'#!/bin/sh\nexit 0\n');await chmod(file,0o755);
  const identity=await sourceIdentity(source),a=join(root,'a.tar.gz'),b=join(root,'b.tar.gz');
  await packageSource(source,identity.files,a);await packageSource(source,identity.files,b);assert.deepEqual(await readFile(a),await readFile(b));
  await command('tar',['-xzpf',a,'-C',extracted],root,join(root,'extract.log'));
  assert.equal((await stat(join(extracted,'build.sh'))).mode&0o777,0o755);assert.equal((await sourceIdentity(extracted)).sourceSha256,identity.sourceSha256);
  await assert.rejects(()=>packageSource(source,[{path:'../escape',sha256:'',mode:0o644}],join(root,'bad.tar.gz')),/Invalid archive/);
});

test('Command timeout reaps SIGTERM-ignoring child before returning',{timeout:8000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'clone-process-')),pidFile=join(root,'pid');
  const code=`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},100)`;
  await assert.rejects(()=>command(process.execPath,['-e',code],root,join(root,'child.log'),500),/timed out/);
  const pid=Number(await readFile(pidFile,'utf8'));assert.throws(()=>process.kill(pid,0));
});

test('Command drains stdout and stderr before closing evidence log',async()=>{
  const root=await mkdtemp(join(tmpdir(),'clone-process-')),log=join(root,'output.log');
  await command(process.execPath,['-e',"process.stdout.write('x'.repeat(100000));process.stderr.write('FINAL-MARKER')"],root,log);
  const output=await readFile(log,'utf8');assert.equal(output.length,100012);assert.ok(output.includes('FINAL-MARKER'));
});
