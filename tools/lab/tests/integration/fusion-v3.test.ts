import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture, loadConfig } from '../../src/capture.js';
import { hash, jsonWrite, verifyCorpus } from '../../src/core/artifacts.js';
import { buildVariants } from '../../src/reconstruction/builders.js';
import { FusionSuiteSchema, verifyFusion } from '../../src/evaluate/fusion.js';
import { launchBrowser,newContext } from '../../src/browser/launch.js';
import { snapshot } from '../../src/extractors/snapshot.js';
import { localServer } from '../../src/replay/local-server.js';
import { buildIndex, validateCoverage } from '../../src/analysis/inventory.js';

const html=`<!doctype html><style>:root{--color-text:#111}body{margin:0}#hero{padding:20px}#panel[hidden]{display:none}@keyframes fade{to{opacity:.5}}#other{animation:fade 1s infinite}</style><main><section id="hero"><h1>Original fusion</h1><button id="toggle" aria-expanded="false">Menu</button><div id="panel" hidden>Panel content</div></section><section id="other"><img id="outside-image" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><canvas id="outside-canvas"></canvas>Unrelated section</section></main><script>document.querySelector('#toggle').onclick=()=>{const b=document.querySelector('#toggle'),p=document.querySelector('#panel');p.hidden=!p.hidden;b.setAttribute('aria-expanded',String(!p.hidden))}</script>`;
async function fixture(t:test.TestContext){
  const base=await mkdtemp(join(tmpdir(),'fusion-browser-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const target=join(base,'target');await mkdir(target);await writeFile(join(target,'index.html'),html);
  const server=await localServer(async(_req,res)=>{res.setHeader('content-type','text/html');res.end(await readFile(join(target,'index.html')));});t.after(()=>server.close());
  const config=await loadConfig('configs/fixture.json');delete config.readySelector;config.viewports=[{id:'desktop',width:1200,height:800},{id:'mobile',width:390,height:844}];config.scenarios=[{id:'initial',action:'time',atMs:0},{id:'open',action:'click',selector:'#toggle',expect:{selector:'#toggle',attribute:'aria-expanded',value:'true'}},{id:'close',action:'click',selector:'#toggle',dependsOn:['open'],precondition:{selector:'#panel',visible:true},expect:{selector:'#panel',visible:false}}];
  const files=[{file:'index.html',sha256:hash(html),nature:'observed'}];
  const identity={root:target,files,buildSha256:hash(JSON.stringify(files)),projectSha256:hash('project'),registrySha256:hash('registry')};
  const suite={schemaVersion:1 as const,config,components:[{id:'F-HERO',selector:'#hero',scenarioIds:['initial','open','close'],viewportIds:['desktop','mobile']}],checks:[{id:'heading',componentId:'F-HERO',scenarioId:'initial',selector:'h1',kind:'text',value:'Original fusion'},{id:'overflow',componentId:'F-HERO',scenarioId:'initial',selector:'#hero',kind:'no-overflow'},{id:'panel',componentId:'F-HERO',scenarioId:'open',selector:'#panel',kind:'visible'},{id:'token',componentId:'F-HERO',scenarioId:'close',selector:'#hero',kind:'token',property:'--color-text',value:'#111'}],visual:{maxChangedPixelRatio:.01,rationale:'Synthetic deterministic fixture'}};
  return {base,target,server,config,identity,suite};
}

test('selective capture measures only requested states, preserves setup and excludes unrelated subtree/media/motion',{timeout:45000},async t=>{
  const f=await fixture(t);f.config.selective={schemaVersion:1,purpose:'fusion',selectors:['#hero'],viewportIds:['mobile'],scenarioIds:['close']};
  const root=join(f.base,'capture');await capture(f.server.origin+'/',root,f.config);
  const manifest=await verifyCorpus(root);assert.equal(manifest.scope?.kind,'fusion-selective');assert.deepEqual(manifest.scope?.setupIds,['initial','open']);assert.equal(manifest.states.length,1);assert.equal(manifest.states[0].viewportId,'mobile');assert.equal(manifest.states[0].stateId,'close');
  const state=JSON.parse(await readFile(join(root,manifest.states[0].snapshotFile),'utf8'));assert(state.html.includes('Original fusion'));assert(!state.html.includes('Unrelated section'));assert(!state.elements.some((e:any)=>e.id==='outside-canvas'));assert.equal(state.canvases.length,0);assert.equal(state.media.length,0);assert(!state.animations.some((a:any)=>a.target==='#other'));assert(state.scope.ancestorSelectors.length>0);assert(state.css.length>0);
  await assert.rejects(()=>buildVariants(root,[]),/Selective Fusion/);
  const indexed=await buildIndex(root,join(f.base,'analysis'));assert.equal(indexed.inventory.scope?.kind,'fusion-selective');assert.deepEqual(indexed.inventory.viewportIds,['mobile']);assert.deepEqual(indexed.inventory.scenarios.map(s=>s.id),['close']);assert.deepEqual(indexed.inventory.scenarios[0].prerequisiteIds,['initial','open']);assert.equal(validateCoverage(indexed.inventory).complete,false);
  manifest.scope!.selectors=['#other'];await jsonWrite(join(root,'manifest.json'),manifest);await assert.rejects(()=>verifyCorpus(root),/modified/);
});

test('selective snapshots fail missing roots and include open shadow contents only inside selected branch',{timeout:30000},async t=>{
  const f=await fixture(t),browser=await launchBrowser(),context=await newContext(browser,f.config,f.config.viewports[0]);
  try{const page=await context.newPage();await page.goto(f.server.origin);await page.locator('#hero').evaluate(el=>{const host=document.createElement('div');host.id='host';host.attachShadow({mode:'open'}).innerHTML='<button id="shadow">Inside shadow</button>';el.append(host);});const s=await snapshot(page,200,{selectors:['#hero']});assert(s.shadows.length===1);assert(s.html.includes('Inside shadow'));await assert.rejects(()=>snapshot(page,200,{selectors:['#absent']}),/root missing/);}
  finally{await context.close();await browser.close();}
});

test('Fusion verifies new design contracts, targeted checks keep setup, and actual defects fail',{timeout:45000},async t=>{
  const f=await fixture(t);const result=await verifyFusion(f.server.origin+'/',f.suite,{out:join(f.base,'full'),identity:f.identity});assert.equal(result.status,'passed');assert.equal(result.fullCoverage,true);assert.equal(result.creative,'not-reviewed');assert.equal(result.rows.length,6);
  const partial=await verifyFusion(f.server.origin+'/',f.suite,{out:join(f.base,'partial'),identity:f.identity,selection:{mode:'targeted',scenarioIds:['close'],impactKnown:true}});assert.equal(partial.status,'passed');assert.equal(partial.fullCoverage,false);assert.deepEqual(partial.scope.setupIds,['initial','open']);
  const broken=structuredClone(f.suite);broken.checks[0].value='Wrong content';const failed=await verifyFusion(f.server.origin+'/',broken,{out:join(f.base,'failed'),identity:f.identity});assert.equal(failed.status,'failed');assert(failed.rows.some(r=>r.checks.some((c:any)=>!c.passed)));
  await assert.rejects(()=>verifyFusion(f.server.origin+'/',f.suite,{out:join(f.base,'full'),identity:f.identity}),/EEXIST/);
  await assert.rejects(()=>verifyFusion(f.server.origin+'/',f.suite,{out:join(f.target,'evidence'),identity:f.identity}),/outside target/);
});

test('approved Fusion baseline detects visual regression and rejects tampered screenshots',{timeout:45000},async t=>{
  const f=await fixture(t),reportRoot=join(f.base,'reference');await verifyFusion(f.server.origin+'/',f.suite,{out:reportRoot,identity:f.identity});
  const bytes=await readFile(join(reportRoot,'fusion-report.json')),approval={schemaVersion:1,kind:'fusion-baseline',reportFile:'reference/fusion-report.json',reportSha256:hash(bytes),scope:['F-HERO'],confirmationText:'Synthetic fixture approval',confirmationSha256:hash('Synthetic fixture approval')},baseline=join(f.base,'approved.json');await jsonWrite(baseline,approval);
  const same=await verifyFusion(f.server.origin+'/',f.suite,{out:join(f.base,'same'),identity:f.identity,baseline});assert.equal(same.status,'passed');
  const changed=html.replace('#hero{padding:20px}','#hero{padding:20px;background:red}');await writeFile(join(f.target,'index.html'),changed);const files=[{file:'index.html',sha256:hash(changed),nature:'observed'}],identity={...f.identity,files,buildSha256:hash(JSON.stringify(files))};
  const regression=await verifyFusion(f.server.origin+'/',f.suite,{out:join(f.base,'regression'),identity,baseline});assert.equal(regression.status,'failed');assert(regression.rows.some(r=>r.visual?.passed===false));
  const original=JSON.parse(bytes.toString());await writeFile(join(reportRoot,original.rows[0].screenshot),'tampered');await assert.rejects(()=>verifyFusion(f.server.origin+'/',f.suite,{out:join(f.base,'tampered'),identity,baseline}),/screenshot changed/);
});

test('Fusion suite refuses missing checks and stale build identity',{timeout:15000},async t=>{
  const f=await fixture(t),empty=structuredClone(f.suite);empty.checks=empty.checks.filter(x=>x.scenarioId!=='open');assert.equal(FusionSuiteSchema.safeParse(empty).success,false);
  await writeFile(join(f.target,'index.html'),'changed');await assert.rejects(()=>verifyFusion(f.server.origin+'/',f.suite,{out:join(f.base,'stale'),identity:f.identity}),/identity changed/);
});
