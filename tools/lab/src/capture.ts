import { join,resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { CaptureConfig,Manifest,Snapshot } from './core/schema.js';
import { MODULES,ConfigSchema } from './core/schema.js';
import { Artifacts,hash,jsonWrite,verifyCorpus } from './core/artifacts.js';
import { launchBrowser,newContext,environment } from './browser/launch.js';
import { settle,runScenario } from './browser/scenarios.js';
import { snapshot } from './extractors/snapshot.js';
import { observeNetwork,scriptMetadata } from './extractors/network.js';
import { browserGuard,assertNoAI,isLoopback } from './replay/security.js';
import { tokens,splitRules } from './adapters/ai-site-cloner.js';
import { selectScenarios } from './evaluate/selection.js';
import { changedSelectors } from './capture-delta.js';

export async function loadConfig(path:string) {return ConfigSchema.parse(JSON.parse(await readFile(path,'utf8'))) as CaptureConfig;}
export function captureId() {return new Date().toISOString().replace(/[:.]/g,'-');}
export async function blockedCapture(url:string,root:string,config:CaptureConfig) {
  const manifest:Manifest={schemaVersion:1,captureId:root.split(/[\\/]/).at(-1)!,status:'blocked',targetUrl:url,createdAt:new Date().toISOString(),config,environment:{node:process.version,os:process.platform},evidence:[],resources:[],states:[],errors:['capture_request_not_recorded'],policy:{status:'capture_request_not_recorded',checkedAt:new Date().toISOString(),reason:'Remote acquisition needs a factual record of the user request. The clone wrapper records the supplied URL and read-only request; it does not assert ownership.'}};
  const a=new Artifacts(root,manifest);
  for(const kind of MODULES)await a.evidence(kind,'all','blocked',{reason:manifest.policy},'policy preflight',{status:'unavailable',error:'capture_request_not_recorded'});
  await a.save();await jsonWrite(join(root,'BLOCKED.json'),manifest.policy);return root;
}
export async function capture(url:string,root:string,config:CaptureConfig) {
  config=ConfigSchema.parse(config) as CaptureConfig;
  const selective=config.selective;
  const selection=selectScenarios(config.scenarios,selective?{mode:'targeted',scenarioIds:selective.scenarioIds,impactKnown:true}:{});
  if(selective&&(new Set(selective.viewportIds).size!==selective.viewportIds.length||selective.viewportIds.some(id=>!config.viewports.some(v=>v.id===id))))throw new Error('Invalid selective viewport IDs');
  const target=new URL(url);
  if(!['http:','https:'].includes(target.protocol)||target.username||target.password||target.hash)throw new Error('Capture requires one HTTP(S) page URL without credentials or fragment');
  if((await import('./adapters/webembedding.js')).publicUrl(target.href)!==target.href)throw new Error('Sensitive query parameters cannot be captured');
  const live=!isLoopback(target.hostname);
  if(live&&!config.ownershipAuthorization)return blockedCapture(url,root,config);
  const browser=await launchBrowser();
  try {
  const manifest:Manifest={schemaVersion:1,captureId:root.split(/[\\/]/).at(-1)!,status:'complete',targetUrl:url,createdAt:new Date().toISOString(),config,environment:await environment(browser),evidence:[],resources:[],states:[],errors:[],policy:{mode:live?'requested-single-page':'owned-local-fixture',captureRequest:config.ownershipAuthorization,noAI:true,assetDiscovery:!!config.assetDiscovery,interactionCoverage:config.scenarios.some(s=>['hover','focus','click','key'].includes(s.action))?'configured-scenarios-only':'partial-load-and-scroll-only'}};
  const a=new Artifacts(root,manifest);
  if(selective)manifest.scope={kind:'fusion-selective',selectors:selective.selectors,viewportIds:selective.viewportIds,measuredIds:selection.measuredIds,setupIds:selection.setupIds,network:'runtime-required-resources'};
  try {
    for(const vp of config.viewports) {
      if(selective&&!selective.viewportIds.includes(vp.id))continue;
      console.log(`capture ${vp.id} ${vp.width}x${vp.height}`);
      const context=await newContext(browser,config,vp);
      const page=await context.newPage();page.setDefaultTimeout(config.timeoutMs);
      const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text());});
      const network=await observeNetwork(context,page,a,vp.id,true);
      const origins=live?[target.origin,...config.allowedHosts.map(host=>`https://${host}`)]:[target.origin];
      const guard=await browserGuard(context,origins,!live,url,network.recordResponse,{discoverAssets:!!config.assetDiscovery,mediaConfig:config,recordPlaceholder:network.recordPlaceholder});
      const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:config.timeoutMs});
      if(!response||response.status()>=400)throw new Error(`Main document failed ${response?.status()}`);
      const initial=await response.body();const htmlFile=await a.binary('D01',vp.id,'initial',initial,'html','Playwright main response.body(); original bytes');
      await a.evidence('D01',vp.id,'initial-meta',{url:response.url(),status:response.status(),headers:(await import('./adapters/webembedding.js')).safeHeaders(await response.allHeaders()),sha256:hash(initial),file:htmlFile},'Playwright response status/headers');
      const readiness=await settle(page,config);
      await a.evidence('D10',vp.id,'readiness',readiness,'Explicit readiness protocol; natural timeline checkpoints remain relative to settled page');
      if(!selective)await a.evidence('D12',vp.id,'natural-before-seek',(await snapshot(page,config.maxElements)).animations,'getAnimations before controlled WAAPI seek');
      const designTokens=await tokens(page);
      await a.evidence('D04',vp.id,'tokens',designTokens,'collectTokens(page)',{source:{method:'collectTokens(page)',repositoryAdapter:'ai-site-cloner'}});
      await network.cdp.send('DOM.enable');await network.cdp.send('CSS.enable');
      const renderedFonts=[];
      try{
        const {root:doc}=await network.cdp.send('DOM.getDocument');
        for(const selector of ['body','h1','p','button']){
          const {nodeId}=await network.cdp.send('DOM.querySelector',{nodeId:doc.nodeId,selector});
          if(nodeId)renderedFonts.push({selector,...await network.cdp.send('CSS.getPlatformFontsForNode',{nodeId})});
        }
      }catch(e){renderedFonts.push({status:'unsupported',error:String(e)});}
      await a.evidence('D06',vp.id,'platform-fonts',renderedFonts,'CDP CSS.getPlatformFontsForNode; selected nodes');
      let previous:Snapshot|undefined;
      const profile:{stateId:string;actionMs:number;snapshotMs:number;evidenceMs:number}[]=[];
      for(const scenario of selection.actions) {
        const actionStart=performance.now();
        const assertion=await runScenario(page,scenario,config.motionProtocol);assertNoAI(guard);
        if(selective&&(!assertion.executed||assertion.assertion==='fail'))throw new Error(`Selective setup/checkpoint failed: ${scenario.id}: ${assertion.error??'assertion'}`);
        if(!selection.measuredIds.includes(scenario.id))continue;
        const snapshotStart=performance.now();
        const s=await snapshot(page,config.maxElements,selective?{selectors:selective.selectors}:undefined);
        const evidenceStart=performance.now();
        const snapshotFile=await a.evidence('D02',vp.id,scenario.id,s,'DOM serialization + open shadow/accessible iframe + browser observation');
        const domFile=await a.binary('D02',vp.id,scenario.id,Buffer.from(s.html),'html','Derived DOM serialization with declarative open shadow roots; form values redacted');
        await a.evidence('D03',vp.id,scenario.id,{sheets:s.css,parsed:(s.css as any[]).flatMap(sheet=>sheet.rules?.flatMap((r:any)=>splitRules(r.text))??[])},'CSSOM; inaccessible sheets recorded unavailable; splitRules adapter');
        await a.evidence('D04',vp.id,scenario.id,s.elements.map(e=>({elementId:e.elementId,selector:e.selector,styles:e.styles,before:e.before,after:e.after})),'getComputedStyle; named properties and custom properties');
        await a.evidence('D05',vp.id,scenario.id,{coordinateSystem:'box x/y viewport CSS pixels; pageX/pageY = x/y + scroll; DPR1',scroll:s.scroll,elements:s.elements.map(e=>({elementId:e.elementId,selector:e.selector,box:e.box,rects:e.rects,visible:e.visible,textRects:e.textRects}))},'getBoundingClientRect/getClientRects/Range.getClientRects');
        await a.evidence('D06',vp.id,scenario.id,{fontFaceSet:s.fonts,elements:s.elements.filter(e=>e.text).map(e=>({elementId:e.elementId,selector:e.selector,declared:Object.fromEntries(Object.entries(e.styles).filter(([k])=>/font|line-height|letter-spacing/.test(k))),textRects:e.textRects})),renderedFontLimit:'CDP font evidence only selected body/h1/p/button, see platform-fonts'},'document.fonts and computed typography/text rectangles');
        await a.evidence('D10',vp.id,scenario.id,{viewport:s.viewport,media:s.css,geometryFile:snapshotFile,totalElements:s.totalElements,selectedElements:s.elements.length,truncated:s.truncated},'Repeated actual viewport; no unmeasured breakpoint inference');
        const assertionFile=await a.evidence('D11',vp.id,scenario.id,{scenario,result:assertion,delta:previous?{nodesBefore:previous.elements.length,nodesAfter:s.elements.length,changed:changedSelectors(previous.elements,s.elements),matching:'exact selector + tag, confidence 1 within unchanged fixture tree; snapshot indices not persistent'}:null},'Predefined safe scenario; assertion + observed delta');
        await a.evidence('D12',vp.id,scenario.id,{protocol:config.motionProtocol,nominalTimeMs:scenario.atMs,actualBrowserTimeMs:s.browserTimeMs,animations:s.animations,otherRuntime:s.runtime},'getAnimations + getKeyframes/getTiming; controlled timeline checkpoints');
        const screenshotFile=await a.binary('D13',vp.id,scenario.id,await page.screenshot({fullPage:false,animations:'allow',caret:'hide'}),'png','Viewport screenshot after scenario and timeline seek');
        await a.evidence('D14',vp.id,scenario.id,s.canvases,'Canvas.toDataURL + dimensions; context/scene unsupported');
        await a.evidence('D07',vp.id,scenario.id,{media:s.media??[],limitations:s.limitations??[]},'Observed media readiness/visibility; playback progression asserted separately');
        await a.evidence('D15',vp.id,scenario.id,s.session,'Fresh unauthenticated context; cookie/storage names only, all values redacted');
        manifest.states.push({viewportId:vp.id,stateId:scenario.id,snapshotFile,screenshotFile,domFile,assertionFile});previous=s;
        profile.push({stateId:scenario.id,actionMs:snapshotStart-actionStart,snapshotMs:evidenceStart-snapshotStart,evidenceMs:performance.now()-evidenceStart});
      }
      await a.evidence('D16',vp.id,'profile',{profile,clock:'monotonic milliseconds; diagnostic, not controlled performance benchmark'},'Phase profiling without extra browser captures');
      const net=await network.finish();
      if(guard.placeholderErrors?.length)throw new Error(`Media placeholder adaptation failed: ${guard.placeholderErrors.map(e=>e.reason).join('; ')}`);
      await a.evidence('D07',vp.id,'resources',manifest.resources.filter(r=>r.viewportId===vp.id),'Validated route.fetch response.body before fulfill; original GET bytes including workers; SHA256 store');
      await a.evidence('D08',vp.id,'scripts',{scriptOrder:await page.locator('script').evaluateAll(s=>s.map((e:any,i)=>({order:i,src:e.src,type:e.type,async:e.async,defer:e.defer}))),cdpScripts:net.scripts,bundles:await scriptMetadata(manifest,vp.id,root),wasm:manifest.resources.filter(r=>/wasm/.test(r.mime)),sourceMaps:manifest.resources.filter(r=>/\.map(?:\?|$)/.test(r.url))},'Debugger.scriptParsed + actually observed bundle bytes; detectBundler adapter');
      await a.evidence('D09',vp.id,'network',{events:net.events,har:net.har,guard,errors},'CDP Network events + validated route.fetch incl workers + sanitized HAR 1.2 with body references');
      await context.close();
    }
    await a.evidence('D02','all','closed-shadow',{limitation:'Closed roots are not accessible or distinguishable from absence without invasive instrumentation'},'Browser access boundary',{status:'unsupported'});
    await a.evidence('D12','all','js-motion-internals',{limitation:'No GSAP/Lenis/rAF internal reconstruction or synthetic JS clock'},'Browser access boundary',{status:'unsupported'});
    await a.evidence('D14','all','webgl-scene',{limitation:'Canvas pixels and dimensions only; no context trace or scene reconstruction'},'Browser access boundary',{status:'unsupported'});
    if(!manifest.resources.some(r=>/\.map(?:\?|$)/.test(r.url)))await a.evidence('D08','all','source-maps',{limitation:'No source map observed in captured traffic; no speculative fetch'},'Observed network inventory',{status:'unavailable'});
    await a.evidence('D16','all','integrity',{files:manifest.evidence.length,resources:manifest.resources.length,states:manifest.states.length,evaluationStatus:'not run yet; capture integrity only'},'Schema validation and SHA256 verification on persisted artifacts');
    await a.save();await verifyCorpus(root);return resolve(root);
  }catch(e){manifest.errors.push(String(e));manifest.status='blocked';await a.save();throw e;}
  }
  finally{await browser.close();}
}
