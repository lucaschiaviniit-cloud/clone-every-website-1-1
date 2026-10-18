import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { capture,loadConfig } from '../../src/capture.js';
import { verifyCorpus } from '../../src/core/artifacts.js';
import { localServer } from '../../src/replay/local-server.js';
import { buildVariants,variants } from '../../src/reconstruction/builders.js';
import { checkReplay } from '../../src/evaluate/replay-check.js';
import { launchBrowser,newContext } from '../../src/browser/launch.js';
import { browserGuard } from '../../src/replay/security.js';
import { Artifacts,hash } from '../../src/core/artifacts.js';
import { observeNetwork } from '../../src/extractors/network.js';
import type { Manifest } from '../../src/core/schema.js';

test('Cache preserves captured image bytes, URL variants, geometry and offline behavior',{timeout:90000},async t=>{
  const base=await mkdtemp(join(tmpdir(),'clone-media-cache-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const counts=new Map<string,number>();
  const server=await localServer(async(req,res)=>{
    const url=req.url??'/';counts.set(url,(counts.get(url)??0)+1);
    if(url==='/') {
      res.setHeader('content-type','text/html');res.end(`<!doctype html><html><body><img id="photo" src="/photo.svg?v=1" width="160" height="90"><button id="reload">Reload</button><button id="variant">Variant</button><script>let variant=1;const load=()=>{const old=document.querySelector('#photo'),image=old.cloneNode();image.src='/photo.svg?v='+variant;old.replaceWith(image);};document.querySelector('#reload').onclick=load;document.querySelector('#variant').onclick=()=>{variant=2;load();};</script></body></html>`);
    }else if(url.startsWith('/photo.svg')) {
      res.setHeader('content-type','image/svg+xml');res.setHeader('cache-control','public, max-age=3600');
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="${url.endsWith('2')?'blue':'red'}"/></svg>`);
    }else{res.statusCode=404;res.end();}
  });t.after(()=>server.close());
  const config=await loadConfig('configs/fixture.json');config.mediaMode='original';config.viewports=[config.viewports[0]];config.settleMs=100;delete config.readySelector;
  config.scenarios=[{id:'load',action:'time',atMs:0,expect:{selector:'#photo',mediaReady:true}},{id:'reload-1',action:'click',selector:'#reload',waitMs:100,expect:{selector:'#photo',mediaReady:true}},{id:'reload-2',action:'click',selector:'#reload',waitMs:100,expect:{selector:'#photo',mediaReady:true}},{id:'variant',action:'click',selector:'#variant',waitMs:100,expect:{selector:'#photo',mediaReady:true}}];
  const observations:any[]=[];
  for(const enabled of [false,true]) {
    counts.clear();const root=join(base,String(enabled));config.captureMediaCache=enabled;
    await capture(server.origin+'/',root,config);const manifest=await verifyCorpus(root);
    const media=manifest.resources.filter(r=>r.type==='image');
    observations.push({requests:counts.get('/photo.svg?v=1'),variants:counts.get('/photo.svg?v=2'),bodies:media.map(r=>({url:r.url,sha256:r.sha256})),states:await Promise.all(manifest.states.map(async s=>{const snap=JSON.parse(await readFile(join(root,s.snapshotFile),'utf8')),assertion=JSON.parse(await readFile(join(root,s.assertionFile),'utf8'));assert.equal(assertion.result.assertion,'pass');const e=snap.elements.find((e:any)=>e.id==='photo');return {box:e.box,src:e.attributes.src};}))});
    if(enabled) {
      const networkRecord=manifest.evidence.find(e=>e.kind==='D09'&&e.file)!;
      const network=JSON.parse(await readFile(join(root,networkRecord.file!),'utf8'));
      assert.equal(network.guard.mediaCache.enabled,true);
      await buildVariants(root,[(await variants()).find(v=>v.id==='v2')!]);
      await assert.rejects(()=>checkReplay(root,join(root,'derived','nested')),/outside the corpus/);
      await assert.rejects(()=>readdir(join(root,'derived')),{code:'ENOENT'});
      const replay=await checkReplay(root,join(base,'startup'));
      assert.equal(replay.status,'passed',JSON.stringify(replay));assert.equal(replay.viewports[0].network.remoteRequestsTransmitted,0);
    }
  }
  const [uncached,cached]=observations;
  assert.equal(cached.requests,uncached.requests);assert.equal(cached.variants,1);
  assert.deepEqual(cached.bodies,uncached.bodies);assert.deepEqual(cached.states,uncached.states);
});


test('Repeated actual media requests reuse recorded bytes; cookie-bearing requests always reach upstream',{timeout:45000},async t=>{
  const base=await mkdtemp(join(tmpdir(),'clone-cache-requests-'));t.after(()=>rm(base,{recursive:true,force:true}));
  let mediaGets=0;
  const server=await localServer(async(req,res)=>{
    if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><img src="/photo.svg" width="160" height="90">');}
    else {mediaGets++;res.setHeader('content-type','image/svg+xml');res.setHeader('cache-control','public, max-age=3600');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="red"/></svg>');}
  });t.after(()=>server.close());
  const config=await loadConfig('configs/fixture.json'),browser=await launchBrowser();t.after(()=>browser.close());
  const observations:any[]=[];
  for(const mode of ['off','on','cookie']) {
    mediaGets=0;config.captureMediaCache=mode!=='off';
    const context=await newContext(browser,config,config.viewports[0]);
    try {
      if(mode==='cookie')await context.addCookies([{name:'fixture',value:'private',url:server.origin}]);
      const page=await context.newPage();
      const manifest:Manifest={schemaVersion:1,captureId:mode,targetUrl:server.origin+'/',status:'complete',createdAt:new Date().toISOString(),config,environment:{},evidence:[],resources:[],states:[],errors:[]};
      const artifacts=new Artifacts(join(base,mode),manifest),network=await observeNetwork(context,page,artifacts,'desktop',true);
      const audit=await browserGuard(context,[server.origin],false,server.origin+'/',network.recordResponse,{mediaConfig:config});
      const screenshots:string[]=[];
      for(let i=0;i<3;i++) {
        const current=i===0?page:await context.newPage();await current.goto(server.origin+'/');await current.locator('img').evaluate(img=>(img as HTMLImageElement).decode());
        screenshots.push(hash(await current.screenshot()));await current.close();
      }
      const net=await network.finish(),media=manifest.resources.filter(r=>r.type==='image');
      observations.push({mode,requests:mediaGets,hashes:media.map(r=>r.sha256),screenshots});
      assert.equal(media.length,3);
      if(mode==='on') {
        assert.equal(audit.mediaCache?.hits,2);assert.equal(mediaGets,1);
        assert.equal(media.filter(r=>r.captureSource==='same-context-media-cache').length,2);
        assert.equal(net.har.log.entries.filter((e:any)=>e._captureSource==='same-context-media-cache').length,2);
      }else{assert.equal(mediaGets,3);assert.equal(audit.mediaCache?.hits,0);}
    }finally{await context.close();}
  }
  assert.deepEqual(observations[0].hashes,observations[1].hashes);
  assert.deepEqual(observations[0].screenshots,observations[1].screenshots);
});
