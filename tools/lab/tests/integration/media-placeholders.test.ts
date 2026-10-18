import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { capture,loadConfig } from '../../src/capture.js';
import { verifyCorpus } from '../../src/core/artifacts.js';
import { localServer } from '../../src/replay/local-server.js';
import { buildVariants,variants } from '../../src/reconstruction/builders.js';
import { replayServer } from '../../src/replay/replay-server.js';
import { launchBrowser,newContext } from '../../src/browser/launch.js';
import { browserGuard } from '../../src/replay/security.js';
import { settle,runScenario } from '../../src/browser/scenarios.js';
import { buildIndex } from '../../src/analysis/inventory.js';

test('Placeholder capture never requests original media; offline replay retains layout, decode, playback, pause and resize',{timeout:60000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'media-placeholder-'));
  let photoRequests=0,videoRequests=0,logoRequests=0;
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="blue"/></svg>';
  const html=`<!doctype html><html><head><style>body{margin:0}#card{width:320px}img,video{display:block;width:100%;height:180px;object-fit:cover}@media(max-width:400px){#card{width:240px}img,video{height:135px}}#panel[hidden]{display:none}</style></head><body><div id="card"><picture><source media="(max-width:400px)" srcset="/mobile.jpg"><img id="photo" src="/photo.jpg" width="320" height="180"></picture><video id="video" width="320" height="180" muted loop autoplay playsinline><source src="/clip.webm" type="video/webm"></video></div><img src="/logo.svg" width="320" height="180"><button id="pause">Pause</button><button id="menu" aria-expanded="false">Menu</button><div id="panel" hidden>Contents</div><script>document.querySelector('#pause').onclick=()=>document.querySelector('#video').pause();document.querySelector('#menu').onclick=()=>{const b=document.querySelector('#menu');b.setAttribute('aria-expanded',b.getAttribute('aria-expanded')==='false'?'true':'false');document.querySelector('#panel').hidden=b.getAttribute('aria-expanded')!=='true';};</script></body></html>`;
  const remote=await localServer(async(req,res)=>{
    if(req.url==='/'){res.setHeader('content-type','text/html');res.end(html);}
    else if(req.url==='/logo.svg'){logoRequests++;res.setHeader('content-type','image/svg+xml');res.end(svg);}
    else if(req.url?.endsWith('.jpg')){photoRequests++;res.setHeader('content-type','image/svg+xml');res.end(svg);}
    else if(req.url==='/clip.webm'){videoRequests++;res.statusCode=503;res.end('Original video must not be requested');}
    else{res.statusCode=404;res.end();}
  });
  const config=await loadConfig('configs/fixture.json');config.mediaMode='placeholders';config.viewports=[{id:'desktop',width:600,height:500}];config.settleMs=200;config.readySelector='#photo';config.motionProtocol='natural-sampled';
  config.scenarios=[{id:'loaded',action:'time',atMs:0,waitMs:200,expect:{selector:'#photo',mediaReady:true}},{id:'video-playing',action:'time',atMs:300,waitMs:350,expect:{selector:'#video',videoPlaying:true}},{id:'paused',action:'click',selector:'#pause',waitMs:50,expect:{selector:'#video',videoPlaying:false}},{id:'menu-open',action:'click',selector:'#menu',expect:{selector:'#panel',visible:true}},{id:'menu-close',action:'click',selector:'#menu',expect:{selector:'#panel',visible:false}},{id:'resize',action:'resize',width:360,height:500,waitMs:100,expect:{selector:'#photo',mediaReady:true}}];
  try {
    await capture(remote.origin+'/',root,config);
    const manifest=await verifyCorpus(root);assert.equal(manifest.status,'complete');
    assert.equal(photoRequests,0);assert.equal(videoRequests,0);assert.ok(logoRequests>0);
    for(const state of manifest.states){const a=JSON.parse(await readFile(join(root,state.assertionFile),'utf8'));assert.equal(a.result.executed,true,JSON.stringify(a));assert.notEqual(a.result.assertion,'fail',JSON.stringify(a));}
    const replacements=manifest.resources.filter(r=>r.substitution);assert.ok(replacements.some(r=>r.url.endsWith('/mobile.jpg')));
    assert.ok(replacements.every((r:any)=>r.substitution?.originalBodyDownloaded===false&&r.replayable));
    const provenance=JSON.parse(await readFile('assets/media/provenance.json','utf8'));
    const video=replacements.find(r=>r.substitution?.kind==='video');assert.equal(video?.bytes,provenance.bytes);assert.equal(video?.sha256,provenance.sha256);
    const image=replacements.find(r=>r.url.endsWith('/photo.jpg'));assert.equal(image?.substitution?.width,320);assert.equal(image?.substitution?.height,180);
    await buildIndex(root,root+'-analysis');
    const assets=JSON.parse(await readFile(join(root+'-analysis','assets-map.json'),'utf8'));
    assert.ok(assets.assets.filter((r:any)=>r.url.endsWith('/clip.webm')).every((r:any)=>r.substitution?.originalBodyDownloaded===false));
    const last=JSON.parse(await readFile(join(root,manifest.states.at(-1)!.snapshotFile),'utf8'));
    const capturedBox=last.elements.find((e:any)=>e.id==='photo').box;assert.equal(capturedBox.width,240);assert.equal(capturedBox.height,135);
    await remote.close();
    await buildVariants(root,[(await variants()).find(v=>v.id==='v2')!]);
    const replay=await replayServer(root,'v2','desktop'),browser=await launchBrowser(),context=await newContext(browser,config,config.viewports[0]);
    try {
      const guard=await browserGuard(context,[replay.origin],true,replay.origin+'/'),page=await context.newPage();
      const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(replay.origin+'/');await settle(page,config);
      for(const scenario of config.scenarios){const result=await runScenario(page,scenario,config.motionProtocol);assert.equal(result.executed,true,JSON.stringify(result));assert.notEqual(result.assertion,'fail',JSON.stringify(result));}
      const box=await page.locator('#photo').boundingBox();assert.equal(box?.width,capturedBox.width);assert.equal(box?.height,capturedBox.height);
      const videoRequest=await fetch(replay.origin+'/clip.webm',{headers:{range:'bytes=0-31'}});assert.equal(videoRequest.status,206);assert.equal((await videoRequest.arrayBuffer()).byteLength,32);
      assert.equal(guard.remoteRequestsTransmitted,0);assert.deepEqual(guard.blocked,[]);assert.deepEqual(errors,[]);
    }finally{await context.close();await browser.close();await replay.close();}
  }finally{await remote.close().catch(()=>undefined);await rm(root,{recursive:true,force:true});await rm(root+'-analysis',{recursive:true,force:true});}
});

test('Unsupported streams produce a blocked capture without downloading the original stream',{timeout:30000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'media-placeholder-stream-'));let streamRequests=0;
  const remote=await localServer(async(req,res)=>{
    if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<html><body><script>fetch("/live.m3u8").catch(()=>{});</script></body></html>');}
    else {streamRequests++;res.end('#EXTM3U');}
  });
  const config=await loadConfig('configs/fixture.json');config.mediaMode='placeholders';config.viewports=[config.viewports[0]];config.settleMs=100;delete config.readySelector;config.scenarios=[{id:'load',action:'time',atMs:0}];
  try {
    await assert.rejects(()=>capture(remote.origin+'/',root,config),/PLACEHOLDER_STREAM_UNSUPPORTED/);
    assert.equal(streamRequests,0);
    const manifest=await verifyCorpus(root);assert.equal(manifest.status,'blocked');assert.ok(manifest.errors.some(e=>e.includes('PLACEHOLDER_STREAM_UNSUPPORTED')));
  }finally{await remote.close();await rm(root,{recursive:true,force:true});}
});
