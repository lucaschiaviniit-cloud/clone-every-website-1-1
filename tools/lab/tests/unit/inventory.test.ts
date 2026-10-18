import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hash, corpusHash } from '../../src/core/artifacts.js';
import type { ElementSnapshot, Manifest, Snapshot } from '../../src/core/schema.js';
import { buildIndex, planImpact, sectionDossier, validateCoverage } from '../../src/analysis/inventory.js';

function element(selector:string,tag:string,extra:Partial<ElementSnapshot>={}):ElementSnapshot {
  return {elementId:selector,selector,tag,id:selector.startsWith('#')&&!selector.includes(' > ')?selector.slice(1):'',testId:'',text:'',attributes:{},box:{x:0,y:0,width:100,height:100,pageX:0,pageY:0},rects:[],visible:true,styles:{'font-family':'Fixture','font-size':'16px','opacity':'1'},before:null,after:null,textRects:[],...extra};
}
async function fixture(t:test.TestContext) {
  const base=await mkdtemp(join(tmpdir(),'inventory-unit-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const root=join(base,'capture'),output=join(base,'derived');await mkdir(root);
  const manifest:Manifest={schemaVersion:1,captureId:'fixture',status:'complete',targetUrl:'https://fixture.test/',createdAt:'2026-01-01T00:00:00.000Z',config:{viewports:[{id:'desktop',width:1200,height:800},{id:'mobile',width:400,height:800}],settleMs:0,timeoutMs:100,maxElements:100,maxBodyBytes:5_000_000,locale:'en',timezoneId:'UTC',reducedMotion:'reduce',colorScheme:'light',motionProtocol:'waapi-seek',allowedHosts:[],scenarios:[{id:'initial',action:'time',atMs:0},{id:'open',action:'click',selector:'#hero > button:nth-child(1)'},{id:'bottom',action:'scroll',progress:1},{id:'return',action:'scroll',progress:0}]},environment:{},evidence:[],resources:[],states:[],errors:[]};
  let count=0;
  const file=async(path:string,value:string|Buffer)=>{await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),value);return path;};
  const state=async(viewportId:string,stateId:string,options:{lazy?:boolean;truncated?:boolean}={})=>{
    const elements=[element('html','html'),element('html > body:nth-child(2)','body'),element('#hero','section',{attributes:{id:'hero',class:'hero'}}),element('#hero > button:nth-child(1)','button',{attributes:{class:'toggle','aria-expanded':stateId==='open'?'true':'false'}})];
    if(options.lazy)elements.push(element('#lazy','section',{attributes:{id:'lazy'}}),element('#lazy > img:nth-child(1)','img',{attributes:{src:'/images/lazy.png',loading:'lazy'}}));
    const snapshot:Snapshot={url:manifest.targetUrl,timestampIso:manifest.createdAt,browserTimeMs:0,scroll:{x:0,y:stateId==='bottom'?1000:0,width:1200,height:1800},viewport:{width:viewportId==='mobile'?400:1200,height:800,dpr:1},totalElements:options.truncated?200:elements.length,truncated:!!options.truncated,elements,html:'<!doctype html><html><head></head><body><section id="hero" class="hero"><button class="toggle" aria-expanded="false">Open</button><img id="independent" src="/images/inside.png"></section>'+(options.lazy?'<section id="lazy"><img src="/images/lazy.png" loading="lazy"></section>':'')+'</body></html>',shadows:[],frames:[],css:[{href:'/site.css',status:'captured',rules:[{text:'.hero { color: red; }'},{text:':root { --color: red; }'},{text:'.other { color: blue; }'}]}],fonts:[{family:'Fixture',status:'loaded'}],animations:[],canvases:[],session:{},runtime:{}};
    // A descendant with its own ID has no selector prefix; dossier must consult DOM.
    snapshot.elements.push(element('#independent','img',{attributes:{id:'independent',src:'/images/inside.png'}}));
    const snapshotFile=await file(`states/${viewportId}-${stateId}.json`,JSON.stringify(snapshot));
    const screenshotFile=await file(`states/${viewportId}-${stateId}.png`,Buffer.from('fixture screenshot'));
    const domFile=await file(`states/${viewportId}-${stateId}.html`,snapshot.html);
    const assertionFile=await file(`states/${viewportId}-${stateId}.assertion.json`,JSON.stringify({scenario:manifest.config.scenarios.find(s=>s.id===stateId),result:{executed:true,assertion:'not-applicable'}}));
    manifest.states.push({viewportId,stateId,snapshotFile,screenshotFile,domFile,assertionFile});
    for(const name of [snapshotFile,screenshotFile,domFile,assertionFile])manifest.evidence.push({schemaVersion:1,id:String(count++),kind:'D02',captureId:'fixture',pageId:'home',viewportId,stateId,source:{method:'test'},timestampIso:manifest.createdAt,status:'captured',file:name,sha256:hash(await readFile(join(root,name)))});
  };
  const resource=async(url:string,body:string,extra:Partial<Manifest['resources'][number]>={})=>{
    const path=await file(`resources/${count++}.bin`,body);
    manifest.resources.push({viewportId:'desktop',url,method:'GET',type:'other',mime:'application/octet-stream',status:200,headers:{},file:path,sha256:hash(body),bytes:Buffer.byteLength(body),replayable:true,...extra});
  };
  const save=async()=>{manifest.corpusSha256=corpusHash(manifest);await file('manifest.json',JSON.stringify(manifest));};
  return {base,root,output,manifest,file,state,resource,save};
}

test('inventory unifies observed states and viewports, marks candidates and unknown coverage honestly',async t=>{
  const f=await fixture(t);
  await f.state('desktop','initial');await f.state('desktop','bottom',{lazy:true,truncated:true});await f.state('mobile','initial');await f.save();
  const result=await buildIndex(f.root,f.output);
  const hero=result.inventory.sections.find(s=>s.selector==='#hero')!;
  assert.equal(hero.grouping,'candidate');assert.equal(hero.nature,'hypothesized');assert.equal(hero.observations.length,3);
  assert(result.inventory.sections.some(s=>s.selector==='#lazy'));
  assert(result.inventory.coverage.every(c=>c.status==='not-verified'));
  assert(result.inventory.coverage.some(c=>!c.observed));
  assert(result.inventory.gaps.some(g=>g.reason.includes('truncated')));
  assert(result.inventory.gaps.some(g=>g.viewportId==='mobile'&&g.reason.includes('Bottom')));
  assert.equal(result.assets.unresolvedUses.find(a=>a.url==='https://fixture.test/images/lazy.png')?.uses[0].stateId,'bottom');
  assert.deepEqual(result.inventory.scenarios.find(s=>s.id==='bottom')!.prerequisiteIds,['initial','open']);
  assert.deepEqual(await readdir(f.root),['manifest.json','states']);
  await assert.rejects(()=>buildIndex(f.root,join(f.root,'derived')),/outside the immutable corpus/);
});

test('short pages need no bottom/return scroll while missing configured states remain gaps',async t=>{
  const f=await fixture(t);f.manifest.config.scenarios=[{id:'initial',action:'time',atMs:0}];
  for(const viewport of f.manifest.config.viewports)await f.state(viewport.id,'initial');
  for(const state of f.manifest.states) {
    const bytes=await readFile(join(f.root,state.snapshotFile),'utf8'),snapshot=JSON.parse(bytes);
    snapshot.scroll.height=snapshot.viewport.height;
    await f.file(state.snapshotFile,JSON.stringify(snapshot));
    f.manifest.evidence.find(e=>e.file===state.snapshotFile)!.sha256=hash(JSON.stringify(snapshot));
  }
  await f.save();const result=await buildIndex(f.root,f.output);
  assert.deepEqual(result.inventory.gaps,[]);
  assert.equal(result.inventory.corpusSha256,f.manifest.corpusSha256);
  assert.equal(result.index.corpusSha256,f.manifest.corpusSha256);
  assert.equal(result.assets.corpusSha256,f.manifest.corpusSha256);
  f.manifest.config.scenarios.push({id:'missing',action:'time',atMs:50});await f.save();
  const missing=await buildIndex(f.root,f.output);
  assert(missing.inventory.gaps.some(g=>g.reason==='Configured capture state missing'));
  assert(!missing.inventory.gaps.some(g=>g.reason.includes('Bottom')||g.reason.includes('Return')));
});

test('derived cache validates source/config/artifact hashes and repairs malformed cache',async t=>{
  const f=await fixture(t);await f.state('desktop','initial');await f.save();
  const first=await buildIndex(f.root,f.output);assert.equal(first.cacheHit,false);
  const second=await buildIndex(f.root,f.output);assert.equal(second.cacheHit,true);
  await writeFile(join(f.output,'page-inventory.json'),'{}');assert.equal((await buildIndex(f.root,f.output)).cacheHit,false);
  await writeFile(join(f.output,'inventory-cache.json'),'broken json');assert.equal((await buildIndex(f.root,f.output)).cacheHit,false);
  const review=join(f.base,'review.json');await writeFile(review,JSON.stringify({sections:[{selector:'#hero',label:'Approved grouping'}]}));
  const changed=await buildIndex(f.root,f.output,{reviewFile:review});assert.equal(changed.cacheHit,false);assert.notEqual(first.inventory.sourceIdentity,changed.inventory.sourceIdentity);
  assert.equal(changed.inventory.sections.find(s=>s.selector==='#hero')!.grouping,'reviewed');
  assert.equal((await buildIndex(f.root,f.output,{reviewFile:review})).cacheHit,true);
  await f.state('mobile','initial');await f.save();
  const revised=await buildIndex(f.root,f.output,{reviewFile:review});assert.equal(revised.cacheHit,false);
  assert.notEqual(changed.inventory.sourceIdentity,revised.inventory.sourceIdentity);
  const state=f.manifest.states[0];await writeFile(join(f.root,state.snapshotFile),'{}');
  await assert.rejects(()=>buildIndex(f.root,f.output),/Captured artifact hash mismatch/);
});

test('coverage review is explicit and impact planning preserves preceding scenario actions',async t=>{
  const f=await fixture(t);await f.state('desktop','initial');await f.state('desktop','open');await f.save();
  const initial=await buildIndex(f.root,f.output),hero=initial.inventory.sections.find(s=>s.selector==='#hero')!;
  const review=join(f.base,'review.json');
  await writeFile(review,JSON.stringify({coverage:[{sectionId:hero.id,viewportId:'desktop',stateId:'open',status:'passed',reason:'User checked expanded menu',evidence:[f.manifest.states[1].screenshotFile]}],impacts:[{component:'Hero',sectionIds:[hero.id],scenarioIds:['open']}]}));
  const checked=await buildIndex(f.root,f.output,{reviewFile:review});
  assert.equal(checked.inventory.coverage.filter(c=>c.status==='passed').length,1);
  assert.deepEqual(planImpact(checked.inventory,['Hero']).scenarioIds,['initial','open']);
  assert.equal(planImpact(checked.inventory,['unknown']).mode,'full');
  assert.equal(planImpact(checked.inventory,['global-css']).mode,'full');
  await writeFile(review,JSON.stringify({coverage:[{sectionId:hero.id,viewportId:'mobile',stateId:'open',status:'passed',reason:'not observed',evidence:[f.manifest.states[1].screenshotFile]}]}));
  await assert.rejects(()=>buildIndex(f.root,f.output,{reviewFile:review}),/absent observation passed/);
});

test('coverage finalization rejects default, missing, skipped, unreviewed and wholly inapplicable sections',async t=>{
  const f=await fixture(t);
  for(const viewport of f.manifest.config.viewports)for(const scenario of f.manifest.config.scenarios)await f.state(viewport.id,scenario.id);
  await f.save();const result=await buildIndex(f.root,f.output),initial=result.inventory;
  assert.equal(validateCoverage(initial).complete,false);
  const review=join(f.base,'review.json');
  await writeFile(review,JSON.stringify({sections:initial.sections.map(s=>({selector:s.selector})),coverage:initial.coverage.map(c=>({...c,status:'passed',reason:'Reviewed the captured state',evidence:[initial.sections.find(s=>s.id===c.sectionId)!.observations.find(o=>o.viewportId===c.viewportId&&o.stateId===c.stateId)!.screenshot.file]}))}));
  const reviewed=(await buildIndex(f.root,f.output,{reviewFile:review})).inventory;
  assert.deepEqual(validateCoverage(reviewed),{complete:true,failures:[]});
  const missing=structuredClone(reviewed);missing.coverage.pop();assert(validateCoverage(missing).failures.some(f=>f.startsWith('Missing coverage row')));
  for(const status of ['skipped','not-verified','failed'] as const) {
    const changed=structuredClone(reviewed);changed.coverage[0].status=status;assert.equal(validateCoverage(changed).complete,false);
  }
  const candidate=structuredClone(reviewed);candidate.sections[0].grouping='candidate';assert.equal(validateCoverage(candidate).complete,false);
  const noEvidence=structuredClone(reviewed);noEvidence.coverage[0].evidence=[];assert.equal(validateCoverage(noEvidence).complete,false);
  const wrongState=structuredClone(reviewed);wrongState.coverage[0].evidence=['unrelated.png'];assert.equal(validateCoverage(wrongState).complete,false);
  const noReason=structuredClone(reviewed);noReason.coverage[0].reason=' ';assert.equal(validateCoverage(noReason).complete,false);
  const allNa=structuredClone(reviewed);allNa.coverage.forEach(c=>c.status='not-applicable');assert(validateCoverage(allNa).failures.some(f=>f.includes('no passed verification')));
  const noObservation=structuredClone(reviewed);noObservation.coverage[0].observed=false;assert.equal(validateCoverage(noObservation).complete,false);
  const truncated=structuredClone(reviewed);truncated.gaps.push({reason:'Truncated DOM',requiredAction:'Capture omitted elements'});assert.equal(validateCoverage(truncated).complete,false);
  const validNa=structuredClone(reviewed);validNa.coverage[0].status='not-applicable';assert.equal(validateCoverage(validNa).complete,true);
});

test('same HLS bytes keep distinct origin URLs and recursively audit dependencies and partial media',async t=>{
  const f=await fixture(t);await f.state('desktop','initial');
  const master='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nsub/index.m3u8\n';
  const child='#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n';
  await f.resource('https://fixture.test/a/master.m3u8',master,{mime:'application/vnd.apple.mpegurl'});
  await f.resource('https://fixture.test/b/master.m3u8',master,{mime:'application/vnd.apple.mpegurl'});
  await f.resource('https://fixture.test/a/sub/index.m3u8',child,{mime:'application/vnd.apple.mpegurl'});
  await f.resource('https://fixture.test/a/sub/key.bin','key');
  await f.resource('https://fixture.test/a/sub/segment.ts','segment',{status:206,headers:{'Content-Range':'bytes 0-6/100'}});
  await f.save();const result=await buildIndex(f.root,f.output),[a,b]=result.assets.assets;
  assert.equal(a.sha256,b.sha256);assert.notEqual(a.url,b.url);
  assert.equal(a.dependencies[0].url,'https://fixture.test/a/sub/index.m3u8');
  assert.equal(b.dependencies[0].url,'https://fixture.test/b/sub/index.m3u8');
  assert.equal(a.recursiveDependencyStatus,'incomplete');assert.equal(b.recursiveDependencyStatus,'incomplete');
  assert.equal(result.assets.assets[2].dependencies.find(d=>d.url.endsWith('key.bin'))!.completeBytes,true);
  assert.equal(result.assets.assets[2].dependencies.find(d=>d.url.endsWith('segment.ts'))!.completeBytes,false);
  assert.equal(result.assets.assets[4].partial,true);
});

test('HLS unsupported URI schemes and malformed playlist bodies never claim complete graph',async t=>{
  const f=await fixture(t);await f.state('desktop','initial');
  await f.resource('https://fixture.test/data.m3u8','#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain,hello"\n',{mime:'application/vnd.apple.mpegurl'});
  await f.resource('https://fixture.test/broken.m3u8','not a playlist',{mime:'application/vnd.apple.mpegurl'});
  await f.save();const result=await buildIndex(f.root,f.output);
  assert(result.assets.assets.every(a=>a.recursiveDependencyStatus==='incomplete'));
  assert.equal(result.assets.assets[0].dependencies[0].observed,false);
});

test('on-demand dossier links bounded DOM, CSS candidates, maps and JS without changing corpus',async t=>{
  const f=await fixture(t);await f.state('desktop','initial');
  await f.resource('https://fixture.test/app.js','class HeroController { open(){ document.querySelector(".hero"); } }',{mime:'text/javascript',type:'script'});
  await f.resource('https://fixture.test/app.js.map',JSON.stringify({version:3,sources:['src/hero.ts'],names:['HeroController'],sourcesContent:['class HeroController {}'],mappings:''}),{mime:'application/json'});
  await f.resource('https://fixture.test/huge.js','x'.repeat(2_000_001),{mime:'text/javascript',type:'script'});
  await f.resource('https://fixture.test/images/inside.png','pixels',{mime:'image/png'});
  await f.save();const before=await readFile(join(f.root,'manifest.json'));
  const index=await buildIndex(f.root,f.output),hero=index.inventory.sections.find(s=>s.selector==='#hero')!;
  await assert.rejects(()=>readdir(join(f.output,'dossiers')),/ENOENT/);
  const first=await sectionDossier(f.root,f.output,hero.id);assert.equal(first.cacheHit,false);
  assert(first.dossier.states[0].dom[0].html.includes('<section'));
  assert(first.dossier.states[0].elements.some((e:any)=>e.selector==='#independent'));
  assert(first.dossier.assets.some((a:any)=>a.url.endsWith('inside.png')));
  assert(first.dossier.states[0].cssCandidates.some((c:any)=>c.nature==='hypothesized'));
  assert(first.dossier.sourceMaps[0].sources.includes('src/hero.ts'));
  assert(first.dossier.jsResources[0].symbolCandidates.includes('HeroController'));
  assert.equal(first.dossier.limits.scriptResourcesOmitted,1);
  assert.equal((await sectionDossier(f.root,f.output,hero.id)).cacheHit,true);
  await writeFile(first.file,'broken dossier');assert.equal((await sectionDossier(f.root,f.output,hero.id)).cacheHit,false);
  assert.deepEqual(await readFile(join(f.root,'manifest.json')),before);
  await assert.rejects(()=>sectionDossier(f.root,f.output,'../../escape'),/Unknown section/);
});

test('symlinked capture inputs and output directories cannot escape their ownership boundary',async t=>{
  const f=await fixture(t);await f.state('desktop','initial');await f.save();
  const nestedLink=join(f.base,'output-link');await symlink(f.root,nestedLink,'dir');
  await assert.rejects(()=>buildIndex(f.root,join(nestedLink,'new')),/outside the immutable corpus/);
  const external=join(f.base,'outside.json');await writeFile(external,'external');
  const snapshot=f.manifest.states[0].snapshotFile;await rm(join(f.root,snapshot));await symlink(external,join(f.root,snapshot));
  await assert.rejects(()=>buildIndex(f.root,f.output),/symlink escapes corpus/);
});
