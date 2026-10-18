import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir,mkdtemp,readFile,writeFile,readdir,rm } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';
import { localServer,fixtureServer } from '../../src/replay/local-server.js';

const wrapper=resolve('..','..','scripts','clone.mjs');
async function invoke(args:string[]) {
  return new Promise<{code:number|null;output:string}>((ok,fail)=>{
    const child=spawn(process.execPath,[wrapper,...args],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:60000});
    let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
    child.once('error',fail);child.once('exit',code=>ok({code,output}));
  });
}
test('Wrapper preparation needs no browser and never starts source reconstruction',async()=>{
  await mkdir('.tmp',{recursive:true});
  const out=await mkdtemp(resolve('.tmp','wrapper-prepare-'));
  const result=await invoke(['https://example.test/work/?view=public','--prepare-only','--out',out,'--media','original']);
  assert.equal(result.code,0,result.output);
  const state=JSON.parse(await readFile(join(out,'state.json'),'utf8'));
  const config=JSON.parse(await readFile(join(out,'capture-config.json'),'utf8'));
  assert.equal(state.phase,'prepared');assert.equal(state.sourceReconstructionStarted,false);
  assert.equal(state.approval,null);assert.equal(state.corpusSha256,null);
  assert.deepEqual(config.allowedHosts,['example.test']);
  assert.equal(state.interactionCoverage,'partial-load-and-scroll-only');
  const repeated=await invoke(['https://example.test/','--prepare-only','--out',out,'--media','original']);
  assert.notEqual(repeated.code,0);assert.match(repeated.output,/must be empty/);
  assert.equal(JSON.parse(await readFile(join(out,'state.json'),'utf8')).targetUrl,'https://example.test/work/?view=public');
});

test('Wrapper performs real synthetic capture/build and stops at the review gate',{timeout:90000},async()=>{
  await mkdir('.tmp',{recursive:true});
  const out=await mkdtemp(resolve('.tmp','wrapper-capture-'));
  const configPath=resolve('.tmp','wrapper-config.json');
  const config=JSON.parse(await readFile('configs/fixture.json','utf8'));
  config.viewports=[config.viewports[0]];
  config.scenarios=config.scenarios.filter((s:any)=>['load-0','menu-open','menu-closed'].includes(s.id));
  await writeFile(configPath,JSON.stringify(config));
  const server=await fixtureServer();
  let result;
  try{result=await invoke([server.origin+'/','--out',out,'--config',configPath,'--media','original']);}finally{await server.close();}
  assert.equal(result.code,0,result.output);
  const state=JSON.parse(await readFile(join(out,'state.json'),'utf8'));
  const manifest=JSON.parse(await readFile(join(out,'corpus','manifest.json'),'utf8'));
  const inventory=JSON.parse(await readFile(join(out,'baseline-inventory.json'),'utf8'));
  assert.equal(state.phase,'awaiting_user_review');assert.equal(state.sourceReconstructionStarted,false);
  assert.equal(state.approval,null);assert.equal(state.corpusSha256,manifest.corpusSha256);
  assert.ok(Number.isInteger(state.preview.port)&&state.preview.port>0&&state.preview.port<=65535);
  assert.equal(state.preview.url,`http://127.0.0.1:${state.preview.port}/`);
  assert.equal(state.baselineSha256,createHash('sha256').update(JSON.stringify(inventory)).digest('hex'));
  assert.ok(inventory.some((e:any)=>e.path==='build.json'));
  assert.equal(manifest.states.length,3);
  assert.equal(JSON.parse(await readFile(join(out,'preflight.json'),'utf8')).status,'passed');
  const startup=JSON.parse(await readFile(join(out,'replay-checks/report.json'),'utf8'));
  assert.equal(startup.status,'passed');assert.equal(startup.fullComparison,false);assert.equal(startup.accuracyApproved,false);
  assert.equal(startup.corpusSha256,manifest.corpusSha256);assert.equal(startup.buildSha256,createHash('sha256').update(await readFile(join(out,'corpus/replays/v2/build.json'))).digest('hex'));
  assert.deepEqual(startup.scenarioIds,['load-0','menu-open','menu-closed']);
  assert.equal(startup.viewports[0].network.remoteRequestsTransmitted,0);
  assert.deepEqual(await readdir(join(out,'corpus','replays')),['v2']);
  assert.match(await readFile(join(out,'AGENT_HANDOFF.md'),'utf8'),/Only an explicit user confirmation/);
});


test('Wrapper refuses an unspecified media choice before creating a run or contacting the target',async t=>{
  const base=await mkdtemp(resolve('.tmp','wrapper-choice-'));t.after(()=>rm(base,{recursive:true,force:true}));
  let requests=0;const server=await localServer(async(_req,res)=>{requests++;res.end('must not be requested');});
  try {
    const out=join(base,'run'),result=await invoke([server.origin+'/','--out',out]);
    assert.notEqual(result.code,0);assert.match(result.output,/MEDIA_CHOICE_REQUIRED/);assert.equal(requests,0);
    await assert.rejects(()=>readdir(out),{code:'ENOENT'});
  }finally{await server.close();}
});

test('Wrapper blocks a broken replay before indexing or requesting accuracy review',{timeout:90000},async t=>{
  const base=await mkdtemp(resolve('.tmp','wrapper-startup-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const out=join(base,'run'),configPath=join(base,'config.json'),config=JSON.parse(await readFile('configs/fixture.json','utf8'));
  config.viewports=[config.viewports[0]];delete config.readySelector;config.scenarios=[{id:'load',action:'time',atMs:0}];await writeFile(configPath,JSON.stringify(config));
  let port='';const server=await localServer(async(_req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><body><h1>Runtime receipt</h1><script>if(location.port!=='+JSON.stringify(port)+')throw new Error("Replay runtime regression");</script>');});
  port=new URL(server.origin).port;
  try {
    const result=await invoke([server.origin+'/','--out',out,'--config',configPath,'--media','original']);
    assert.notEqual(result.code,0,result.output);
    const state=JSON.parse(await readFile(join(out,'state.json'),'utf8')),report=JSON.parse(await readFile(join(out,'replay-checks/report.json'),'utf8'));
    assert.equal(state.phase,'blocked');assert.equal(state.sourceReconstructionStarted,false);assert.equal(state.approval,null);
    assert.equal(report.status,'failed');assert(report.viewports[0].failures.includes('new-page-error'));
    await assert.rejects(()=>readdir(join(out,'analysis')),{code:'ENOENT'});
  }finally{await server.close();}
});
