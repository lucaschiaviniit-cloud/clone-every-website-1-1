import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile,mkdtemp,writeFile,mkdir,rm } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { capture,loadConfig,blockedCapture } from '../../src/capture.js';
import { fixtureServer,localServer } from '../../src/replay/local-server.js';
import { buildVariants } from '../../src/reconstruction/builders.js';
import { evaluate } from '../../src/evaluate/evaluate.js';
import { verifyCorpus,jsonRead,Artifacts } from '../../src/core/artifacts.js';
import { observeNetwork } from '../../src/extractors/network.js';
import { launchBrowser,newContext } from '../../src/browser/launch.js';
import { browserGuard,assertNoAI } from '../../src/replay/security.js';
import type { Snapshot } from '../../src/core/schema.js';

test('Routed acquisition captures real dedicated-worker script and consumed binary bytes', {timeout:30000},async()=>{
  const root=await mkdtemp(join(process.cwd(),'.tmp','worker-')),config=await loadConfig('configs/fixture.json');
  const payload=Buffer.from([0,1,2,3,255]),worker='fetch("/frame.bin").then(r=>r.arrayBuffer()).then(b=>postMessage(b.byteLength))';
  const server=await localServer(async(req,res)=>{
    const content=req.url==='/worker.js'?worker:req.url==='/frame.bin'?payload:'<script>new Worker("/worker.js").onmessage=e=>document.documentElement.dataset.bytes=e.data</script>';
    res.setHeader('content-type',req.url==='/worker.js'?'text/javascript':req.url==='/frame.bin'?'application/octet-stream':'text/html');res.end(content);
  });
  const browser=await launchBrowser(),context=await newContext(browser,config,config.viewports[0]);
  try {
    const artifacts=new Artifacts(root,{schemaVersion:1,captureId:'worker-test',status:'complete',targetUrl:server.origin+'/',createdAt:new Date().toISOString(),config,environment:{},resources:[],evidence:[],states:[],errors:[]});
    const page=await context.newPage(),network=await observeNetwork(context,page,artifacts,'desktop',true);
    await browserGuard(context,[server.origin],true,server.origin+'/',network.recordResponse);
    await page.goto(server.origin+'/');await page.waitForFunction(()=>document.documentElement.dataset.bytes==='5');await network.finish();
    const script=artifacts.manifest.resources.find(r=>r.url.endsWith('/worker.js')),frame=artifacts.manifest.resources.find(r=>r.url.endsWith('/frame.bin'));
    assert.ok(script?.file);assert.equal((await readFile(join(root,script.file))).toString(),worker);
    assert.ok(frame?.file);assert.deepEqual(await readFile(join(root,frame.file)),payload);
  }finally{await context.close();await browser.close();await server.close();}
});

await mkdir(join(process.cwd(),'.tmp'),{recursive:true});

test('D01-D16 browser capture, deterministic replay V0-V4 and integrity gates', {timeout:240000},async(t)=>{
  const root=await mkdtemp(join(process.cwd(),'.tmp','integration-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const config=await loadConfig('configs/fixture.json');
  // All three responsive viewports, four animation checkpoints and actual interactions.
  config.scenarios=config.scenarios.filter(s=>s.action!=='scroll'||s.progress===1);
  const server=await fixtureServer();
  try{await capture(server.origin+'/',root,config);}finally{await server.close();}
  const m=await verifyCorpus(root);
  const data=async(kind:string,vp='desktop',state='load-0')=>{
    const e=m.evidence.find(e=>e.kind===kind&&e.viewportId===vp&&e.stateId===state);assert.ok(e?.file,`${kind} evidence`);return jsonRead<any>(join(root,e.file));
  };
  assert.equal(m.status,'complete');assert.equal(new Set(m.evidence.filter(e=>e.status==='captured').map(e=>e.kind)).size,16);
  const s=await data('D02') as Snapshot;
  assert.ok(s.shadows.length>0);assert.ok((s.frames as any[]).some(f=>f.status==='captured'&&f.html.includes('Same origin frame')));
  assert.ok(s.elements.find(e=>e.id==='hero')!.box.width>0);assert.equal(s.viewport.width,1440);
  assert.equal((await data('D02','mobile')).elements.find((e:any)=>e.tag==='h1').styles['font-size'],'40px');
  assert.equal((await data('D02','desktop')).elements.find((e:any)=>e.tag==='h1').styles['font-size'],'70px');
  assert.ok(JSON.stringify(await data('D03')).includes('@keyframes'));assert.ok(JSON.stringify(await data('D04','desktop','tokens')).includes('--accent'));
  assert.ok(s.fonts.some((f:any)=>f.family==='LabFont'&&f.status==='loaded'));
  assert.ok(m.resources.some(r=>r.mime.includes('font/woff2')&&r.file&&r.sha256));
  assert.ok((await data('D08','desktop','scripts')).bundles.some((b:any)=>b.file&&b.sha256));
  assert.ok(JSON.stringify(await data('D09','desktop','network')).includes('Network.requestWillBeSent'));
  assert.ok(s.animations.some(a=>a.type==='CSSAnimation'));assert.ok(s.animations.some(a=>a.type==='Animation'));
  assert.ok(s.animations.every(a=>a.timing.iterations==='Infinity'&&a.computedTiming.endTime==='Infinity'));
  assert.equal((await data('D02','desktop','load-500')).animations[0].currentTime,500);
  assert.equal((await data('D02','desktop','load-1500')).animations[0].currentTime,1500);
  assert.equal(s.canvases.length,2);assert.ok(s.canvases.every(c=>c.snapshot.startsWith('data:image/png;base64,')));
  const canvasColors=s.canvases.map(c=>{const png=PNG.sync.read(Buffer.from(c.snapshot.split(',')[1],'base64'));return [...png.data.slice((50*png.width+120)*4,(50*png.width+120)*4+4)];});
  assert.deepEqual(canvasColors[0],[167,236,85,255]);assert.ok(Math.abs(canvasColors[1][0]-38)<=1&&Math.abs(canvasColors[1][1]-89)<=1&&Math.abs(canvasColors[1][2]-64)<=1&&canvasColors[1][3]===255);
  assert.ok(JSON.stringify(s.session).includes('[REDACTED]'));assert.ok(!JSON.stringify(s.session).includes('nonsecret'));
  const png=PNG.sync.read(await readFile(join(root,m.states[0].screenshotFile)));assert.equal(png.width,1440);assert.equal(png.height,900);
  await buildVariants(root);
  const scores:any[]=[];
  for(const variant of ['v0','v1','v2','v3','v4']) {
    scores.push(await evaluate(root,variant));
    // Scores are retained for assertions; per-variant images are disposable test output.
    await rm(join(root,'evaluations',variant),{recursive:true,force:true});
  }
  for(const score of scores){assert.equal(score.valid,true);assert.equal(score.summary.remoteRequestsTransmitted,0);}
  const get=(id:string)=>scores.find(s=>s.variantId===id);
  assert.equal(get('v2').summary.interactionPassRate,1);assert.ok(get('v0').summary.interactionPassRate<1);assert.ok(get('v1').summary.interactionPassRate<1);
  assert.equal(get('v0').summary.interactionPassRate,.6);assert.equal(get('v1').summary.interactionPassRate,.8);
  assert.ok(get('v0').states.filter((s:any)=>s.stateId==='menu-closed').every((s:any)=>s.interaction.assertion==='fail'&&s.interaction.precondition.pass===false));
  assert.ok(get('v2').summary.assetCoverageRate>get('v1').summary.assetCoverageRate);
  for(const id of ['v3','v4'])assert.equal(get(id).summary.interactionPassRate,get('v2').summary.interactionPassRate);
  // Hash corruption must fail instead of silently changing the reference corpus.
  const file=join(root,m.states[0].screenshotFile),bytes=await readFile(file);await writeFile(file,Buffer.from('corrupted'));
  await assert.rejects(()=>verifyCorpus(root),/Evidence hash mismatch/);await writeFile(file,bytes);await verifyCorpus(root);
});

test('Browser blocks remote GET/POST, AI endpoints and homepage navigation', {timeout:30000},async()=>{
  const config=await loadConfig('configs/fixture.json'),browser=await launchBrowser(),server=await fixtureServer();
  const context=await newContext(browser,config,config.viewports[0]);
  try {
    const audit=await browserGuard(context,[server.origin],true,server.origin+'/'),page=await context.newPage();await page.goto(server.origin+'/');
    await page.evaluate(async()=>{for(const [url,method] of [['https://example.test/','GET'],['/api/status','POST'],['https://api.openai.com/v1/responses','GET']]){try{await fetch(url,{method});}catch{}}});
    assert.equal(audit.remoteRequestsTransmitted,0);assert.ok(audit.blocked.some(x=>x.reason==='offline-remote'));assert.ok(audit.blocked.some(x=>x.reason==='non-GET'));assert.throws(()=>assertNoAI(audit),/AI_RUNTIME_FORBIDDEN/);
    await page.goto(server.origin+'/frame.html').catch(()=>undefined);assert.ok(audit.blocked.some(x=>x.reason==='homepage-only'));
  }finally{await context.close();await browser.close();await server.close();}
});

test('Remote target without recorded capture request produces a blocked manifest',async()=>{
  const root=await mkdtemp(join(process.cwd(),'.tmp','blocked-')),config=await loadConfig('configs/capture.json');
  delete config.ownershipAuthorization;
  await capture('https://example.test/',root,config);
  const m=await verifyCorpus(root);assert.equal(m.status,'blocked');assert.equal(m.resources.length,0);assert.equal(m.states.length,0);assert.ok(m.evidence.every(e=>e.status==='unavailable'));
});
