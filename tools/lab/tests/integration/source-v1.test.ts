import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp,writeFile,readFile,mkdir,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { localServer } from '../../src/replay/local-server.js';
import { loadConfig } from '../../src/capture.js';
import { compareSource,SourcePolicySchema } from '../../src/evaluate/source.js';
import { sourceIdentity,verifySourceReport } from '../../../../scripts/source-state.mjs';
import { buildIndex } from '../../src/analysis/inventory.js';
import { packageSource } from '../../../../scripts/delivery.mjs';

const scriptRoot=resolve('../../scripts');
async function invoke(script:string,args:string[]) {
  return new Promise<{code:number|null;output:string}>((ok,fail)=>{
    const child=spawn(process.execPath,[join(scriptRoot,script),...args],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
    child.once('error',fail);child.once('exit',code=>ok({code,output}));
  });
}
const html=(broken=false)=>`<!doctype html><html><head><style>body{margin:20px;font-family:Arial}#menu{height:80px;background:#def}#menu[hidden]{display:none}section{height:200px}</style></head><body><section id="hero"><h1>Fixture reconstruction</h1><button id="toggle" aria-expanded="false">Menu</button><div id="menu" hidden>Contents</div></section><script>document.querySelector('#toggle').onclick=()=>{const b=document.querySelector('#toggle');b.setAttribute('aria-expanded',b.getAttribute('aria-expanded')==='true'?'false':'true');${broken?'':"document.querySelector('#menu').hidden=b.getAttribute('aria-expanded')!=='true';"}}</script></body></html>`;

test('Approved source workflow compares independent server, catches regression, binds policy/evidence, and verifies fresh package',{timeout:120000},async(t)=>{
  const root=await mkdtemp(join(tmpdir(),'clone-source-v1-')),run=join(root,'run'),source=join(root,'source');
  t.after(()=>rm(root,{recursive:true,force:true}));
  const config=await loadConfig('configs/fixture.json');config.viewports=[{id:'desktop',width:600,height:450}];config.settleMs=0;delete config.readySelector;
  config.scenarios=[{id:'load',action:'time',atMs:0},{id:'open',action:'click',selector:'#toggle',expect:{selector:'#menu',visuallyVisible:true}},{id:'close',action:'click',selector:'#toggle',precondition:{selector:'#menu',visible:true},expect:{selector:'#menu',visible:false},dependsOn:['open']}];
  const configFile=join(root,'config.json');await writeFile(configFile,JSON.stringify(config));
  const remote=await localServer(async(req,res)=>{res.setHeader('content-type','text/html');res.end(html());});
  try {
    const captured=await invoke('clone.mjs',[remote.origin+'/','--out',run,'--config',configFile]);assert.equal(captured.code,0,captured.output);
  }finally{await remote.close();}
  const denied=await invoke('verify-source.mjs',['--run',run,'--url','http://127.0.0.1:1/']);assert.notEqual(denied.code,0);assert.match(denied.output,/approval/i);
  const confirmation=join(root,'fixture-confirmation.txt');await writeFile(confirmation,'Synthetic fixture user decision for approval-gate testing only.');
  for(const [script,args] of [['review.mjs',['--run',run,'--confirmation-file',confirmation]],['workspace.mjs',['--run',run,'--out',source]]] as const){const r=await invoke(script,[...args]);assert.equal(r.code,0,r.output);}
  await writeFile(join(source,'index.html'),html());
  await writeFile(join(source,'package.json'),JSON.stringify({name:'synthetic-source-fixture',version:'1.0.0',type:'module',scripts:{build:'node build.mjs'}}));
  await writeFile(join(source,'package-lock.json'),JSON.stringify({name:'synthetic-source-fixture',version:'1.0.0',lockfileVersion:3,requires:true,packages:{'':{name:'synthetic-source-fixture',version:'1.0.0'}}}));
  await writeFile(join(source,'build.mjs'),"import{mkdir,copyFile}from'node:fs/promises';await mkdir('dist',{recursive:true});await copyFile('index.html','dist/index.html');");
  await writeFile(join(source,'server.mjs'),"import{createServer}from'node:http';import{readFile}from'node:fs/promises';createServer(async(q,s)=>{s.setHeader('content-type','text/html');s.end(await readFile('dist/index.html'))}).listen(Number(process.argv[2]),'127.0.0.1');");
  await mkdir(join(source,'dist'));await writeFile(join(source,'dist/index.html'),html());
  // Explicit fixture coverage review; no real-site quality claim.
  const inventory=JSON.parse(await readFile(join(run,'analysis/page-inventory.json'),'utf8'));
  const review={impacts:[{component:'FixtureCheckpoint',sectionIds:[],scenarioIds:['open']}],sections:inventory.sections.map((s:any)=>({selector:s.selector,label:s.label,kind:s.kind})),coverage:inventory.coverage.map((c:any)=>({...c,status:'passed',reason:'Synthetic fixture section verified by full configured checkpoints',evidence:[inventory.sections.find((s:any)=>s.id===c.sectionId).observations.find((o:any)=>o.viewportId===c.viewportId&&o.stateId===c.stateId).snapshot.file]}))};
  const reviewFile=join(root,'coverage-review.json');await writeFile(reviewFile,JSON.stringify(review));await buildIndex(join(run,'corpus'),join(run,'analysis'),{reviewFile});
  const policy=SourcePolicySchema.parse({schemaVersion:1,rationale:'Static synthetic fixture, exact screenshot/geometry policy before comparison',defaults:{maxChangedPixelRatio:0,maxBoxErrorPx:0,maxPageHeightDeltaPx:0,minElementCoverage:1,requiredSelectors:['#toggle']}});
  const policyFile=join(root,'policy.json');await writeFile(policyFile,JSON.stringify(policy));
  let broken=false,renamed=false;
  const server=await localServer(async(req,res)=>{res.setHeader('content-type','text/html');res.end(renamed?html().replaceAll('toggle','trigger').replaceAll('menu','panel'):html(broken));});
  let reportFile='';
  try {
    const partial=await compareSource(join(run,'corpus'),server.origin+'/',{out:join(root,'partial'),policy,mode:'targeted',impactKnown:true,scenarioIds:['close']});
    assert.equal(partial.status,'partial_passed');assert.deepEqual(partial.selection.setupIds,['load','open']);
    const unreviewed=await compareSource(join(run,'corpus'),server.origin+'/',{out:join(root,'unreviewed')});assert.equal(unreviewed.status,'unreviewed');
    const componentCheck=await invoke('verify-source.mjs',['--run',run,'--url',server.origin+'/','--policy',policyFile,'--component','FixtureCheckpoint']);assert.equal(componentCheck.code,0,componentCheck.output);
    const componentReport=JSON.parse(await readFile(JSON.parse(componentCheck.output.trim().split('\n').at(-1)!).reportFile,'utf8'));assert.equal(componentReport.selection.effectiveMode,'targeted');assert.deepEqual(componentReport.selection.measuredIds,['load','open']);assert.equal(componentReport.complete,false);
    const explicitFull=await invoke('verify-source.mjs',['--run',run,'--url',server.origin+'/','--policy',policyFile,'--component','FixtureCheckpoint','--mode','full']);assert.equal(explicitFull.code,0,explicitFull.output);
    const fullReport=JSON.parse(await readFile(JSON.parse(explicitFull.output.trim().split('\n').at(-1)!).reportFile,'utf8'));assert.equal(fullReport.selection.requestedMode,'full');assert.equal(fullReport.complete,true);
    const compared=await invoke('verify-source.mjs',['--run',run,'--url',server.origin+'/','--policy',policyFile]);assert.equal(compared.code,0,compared.output);
    const line=compared.output.trim().split('\n').at(-1)!;reportFile=JSON.parse(line).reportFile;
    const report=JSON.parse(await readFile(reportFile,'utf8'));assert.equal(report.status,'comparison_passed');assert.equal(report.complete,true);
    const state=JSON.parse(await readFile(join(run,'state.json'),'utf8'));await verifySourceReport(state,reportFile);
    renamed=true;
    const mapped=await compareSource(join(run,'corpus'),server.origin+'/',{out:join(root,'mapped'),policy:{...policy,selectorMap:{'#toggle':'#trigger','#menu':'#panel'}}});assert.equal(mapped.status,'comparison_passed');renamed=false;
    const bytes=await readFile(join(source,'index.html'));await writeFile(join(source,'index.html'),'changed');await assert.rejects(()=>verifySourceReport(state,reportFile),/changed/);await writeFile(join(source,'index.html'),bytes);
    broken=true;
    const failed=await compareSource(join(run,'corpus'),server.origin+'/',{out:join(root,'failed'),policy});assert.equal(failed.status,'failed');assert.ok(failed.states.some(s=>s.failures.includes('interaction')));
  }finally{await server.close();}
  const identity=await sourceIdentity(source),auditFile=join(root,'independence.json');
  await writeFile(auditFile,JSON.stringify({status:'passed',sourceSha256:identity.sourceSha256,rationale:'Synthetic hand-authored fixture uses inline readable event handler; no original opaque bundles',reviewedFiles:['index.html','server.mjs']}));
  const deliveryConfig=join(root,'delivery-config.json');await writeFile(deliveryConfig,JSON.stringify({install:{executable:'npm',args:['ci','--ignore-scripts']},build:{executable:'npm',args:['run','build']},start:{executable:process.execPath,args:['server.mjs','{port}']},buildDir:'dist',timeoutMs:30000}));
  const deliveryDir=join(root,'delivery');
  const delivered=await invoke('delivery.mjs',['--run',run,'--report',reportFile,'--config',deliveryConfig,'--out',deliveryDir,'--independence-file',auditFile]);assert.equal(delivered.code,0,delivered.output);
  const deliveryFile=join(deliveryDir,'delivery-check.json');
  const deliveryBytes=await readFile(deliveryFile),changedDelivery=JSON.parse(deliveryBytes.toString());changedDelivery.createdAt='changed';await writeFile(deliveryFile,JSON.stringify(changedDelivery));
  const refusedDelivery=await invoke('verify-source.mjs',['--run',run,'--finalize',reportFile,'--delivery-check',deliveryFile]);assert.notEqual(refusedDelivery.code,0);assert.match(refusedDelivery.output,/Delivery report changed/);await writeFile(deliveryFile,deliveryBytes);
  const finalized=await invoke('verify-source.mjs',['--run',run,'--finalize',reportFile,'--delivery-check',deliveryFile]);assert.equal(finalized.code,0,finalized.output);
  assert.equal(JSON.parse(await readFile(join(run,'state.json'),'utf8')).phase,'source_verified');
  const metrics=JSON.parse(await readFile(join(run,'metrics/run-metrics.json'),'utf8'));assert.equal(metrics.outcome,'passed');assert.equal(metrics.completeness.missingRunEnd,false);
  const archiveA=join(root,'a.tar.gz'),archiveB=join(root,'b.tar.gz');await packageSource(source,identity.files,archiveA);await packageSource(source,identity.files,archiveB);assert.deepEqual(await readFile(archiveA),await readFile(archiveB));
  const frozenPolicy=resolve(reportFile,'..','policy.json'),oldPolicy=await readFile(frozenPolicy);await writeFile(frozenPolicy,'{}');
  const stale=await invoke('verify-source.mjs',['--run',run,'--check',reportFile]);assert.notEqual(stale.code,0);await writeFile(frozenPolicy,oldPolicy);
});
