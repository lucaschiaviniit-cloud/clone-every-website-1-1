import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { hash,jsonRead,jsonWrite,verifyCorpus } from '../core/artifacts.js';
import type { Snapshot } from '../core/schema.js';
import { launchBrowser,newContext,softwareFingerprint } from '../browser/launch.js';
import { settle,runScenario } from '../browser/scenarios.js';
import { snapshot } from '../extractors/snapshot.js';
import { browserGuard,assertNoAI } from '../replay/security.js';
import { replayServer } from '../replay/replay-server.js';
import { imageMetrics,writeDiffs,structuralMetrics,motionMetrics,mean } from './metrics.js';
import { selectScenarios } from './selection.js';

export interface EvalOptions {runId?:string;browser?:Browser;viewportId?:string;persistSnapshots?:boolean;scenarioIds?:string[]}
export async function evaluate(root:string,variantId:string,options:EvalOptions={}) {
  const start=performance.now(),m=await verifyCorpus(root);
  if(m.scope?.kind==='fusion-selective')throw new Error('Selective Fusion evidence is not a complete Clone baseline');
  if(m.status!=='complete')throw new Error('Cannot evaluate blocked capture');
  if((m.environment.software as any)?.sha256!==(await softwareFingerprint()).sha256)throw new Error('Software/config/fixture drift: acquire a new reference corpus');
  const browser=options.browser??await launchBrowser(),ownBrowser=!options.browser;
  if(browser.version()!==m.environment.browser)throw new Error('Browser version drift: capture and eval are not comparable');
  const out=join(root,'evaluations',variantId,options.runId??'single');
  if(options.viewportId&&!m.config.viewports.some(v=>v.id===options.viewportId))throw new Error('Unknown viewport');
  const selection=selectScenarios(m.config.scenarios,{mode:options.scenarioIds?.length?'targeted':'full',impactKnown:true,scenarioIds:options.scenarioIds});
  const viewports:any[]=[],allStates:any[]=[];
  try {
    for(const vp of m.config.viewports.filter(v=>!options.viewportId||v.id===options.viewportId)) {
      const server=await replayServer(root,variantId,vp.id),context=await newContext(browser,m.config,vp);
      try {
        const target=new URL(m.targetUrl),localUrl=server.origin+target.pathname+target.search;
        const guard=await browserGuard(context,[server.origin],true,localUrl),page=await context.newPage();page.setDefaultTimeout(m.config.timeoutMs);
        const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text());});
        await page.goto(localUrl,{waitUntil:'domcontentloaded',timeout:m.config.timeoutMs});
        // Snapshot has no script to set readiness; source mirrors retain it where observable.
        await settle(page,m.config,server.variant.js);
        const stateRows=[];
        for(const scenario of selection.actions) {
          const reference=m.states.find(s=>s.viewportId===vp.id&&s.stateId===scenario.id);if(!reference)throw new Error(`Missing reference ${vp.id}/${scenario.id}`);
          const expectedAssertion=await jsonRead<any>(join(root,reference.assertionFile));
          if(expectedAssertion.result.assertion==='fail'||!expectedAssertion.result.executed)throw new Error(`Invalid reference scenario ${vp.id}/${scenario.id}`);
          const action=await runScenario(page,scenario,m.config.motionProtocol);assertNoAI(guard);
          if(!selection.measuredIds.includes(scenario.id))continue;
          const actual=await snapshot(page,m.config.maxElements),expected=await jsonRead<Snapshot>(join(root,reference.snapshotFile));
          const screenshot=await page.screenshot({fullPage:false,animations:'allow',caret:'hide'}),stem=`${vp.id}-${scenario.id}`;
          const screenshotPath=join(out,'screenshots',stem+'.png');await (await import('node:fs/promises')).mkdir(join(out,'screenshots'),{recursive:true});await (await import('node:fs/promises')).writeFile(screenshotPath,screenshot);
          const pix=imageMetrics(await readFile(join(root,reference.screenshotFile)),screenshot);
          await writeDiffs(pix,join(out,'diffs',stem+'.png'),join(out,'diffs',stem+'-heatmap.png'));
          if(options.persistSnapshots)await jsonWrite(join(out,'snapshots',stem+'.json'),actual);
          const row={viewportId:vp.id,stateId:scenario.id,referenceScreenshot:reference.screenshotFile,screenshot:`screenshots/${stem}.png`,screenshotSha256:hash(screenshot),visual:pix.metrics,structure:structuralMetrics(expected,actual),interaction:action,motion:motionMetrics(expected,actual),timestampIso:new Date().toISOString(),actualBrowserTimeMs:actual.browserTimeMs};
          stateRows.push(row);allStates.push(row);
        }
        const required=m.resources.filter(r=>r.viewportId===vp.id&&r.replayable),resolved=new Set(server.requests.filter(r=>r.matched).map(r=>r.url));
        const {resourcePath}=await import('../reconstruction/builders.js');
        const requiredPaths=[...new Set(required.map(r=>resourcePath(r.url,new URL(m.targetUrl).origin)))];
        const coverage=requiredPaths.filter(p=>resolved.has(p)).length;
        const vrow={viewportId:vp.id,states:stateRows.length,assetCoverage:{required:requiredPaths.length,resolved:coverage,resolvedRate:requiredPaths.length?coverage/requiredPaths.length:null,missing:requiredPaths.filter(p=>!resolved.has(p)),originalBodyHashMatches:server.requests.filter(r=>r.matched&&r.originalSha256).length,derivedBytesChanged:server.requests.filter(r=>r.matched&&r.originalSha256!==r.sha256).map(r=>r.url)},network:{...guard,requests:server.requests,unresolved:server.requests.filter(r=>!r.matched),errors},visual:{meanChangedPixelRatio:mean(stateRows.map(s=>s.visual.changedPixelRatio)),meanMaeNormalized:mean(stateRows.map(s=>s.visual.maeNormalized))},interaction:{assertions:stateRows.filter(s=>s.interaction.assertion!=='not-applicable').length,passed:stateRows.filter(s=>s.interaction.assertion==='pass').length}};
        viewports.push(vrow);
      }finally{await context.close();await server.close();}
    }
    const assertions=allStates.filter(s=>s.interaction.assertion!=='not-applicable'),passed=assertions.filter(s=>s.interaction.assertion==='pass');
    const scorecard={schemaVersion:1,captureId:m.captureId,corpusSha256:m.corpusSha256,variantId,runId:options.runId??'single',valid:true,offline:true,noAI:true,environment:{browser:browser.version(),node:process.version,os:process.platform},elapsedSeconds:(performance.now()-start)/1000,summary:{changedPixelRatio:mean(allStates.map(s=>s.visual.changedPixelRatio)),maeNormalized:mean(allStates.map(s=>s.visual.maeNormalized)),meanBoxErrorPx:mean(allStates.map(s=>s.structure.geometry.meanBoxErrorPx)),styleEqualRate:mean(allStates.map(s=>s.structure.style.equalPropertyRate??0)),typographyEqualRate:mean(allStates.map(s=>s.structure.typography.equalPropertyRate??0)),domEqualRate:mean(allStates.map(s=>s.structure.dom.equalNodeRate??0)),interactionPassRate:assertions.length?passed.length/assertions.length:null,assertions:assertions.length,passedAssertions:passed.length,assetCoverageRate:mean(viewports.map(v=>v.assetCoverage.resolvedRate??0)),remoteRequestsTransmitted:viewports.reduce((n,v)=>n+v.network.remoteRequestsTransmitted,0),remoteRequestsBlocked:viewports.reduce((n,v)=>n+v.network.blocked.length,0),consoleErrors:viewports.reduce((n,v)=>n+v.network.errors.length,0)},viewports,states:allStates,limitations:[m.config.motionProtocol==='waapi-seek'?'WAAPI/CSS checkpoints use seek after settling, not exact wall-clock load time':'Natural runtime checkpoints after settle; JS/video/GSAP not frozen, measured sampling overhead and run variability remain','JS/rAF/video have no synthetic clock; natural variability remains','No canvas/WebGL scene reconstruction','V3/V4 catalogs do not patch original interaction/motion logic']};
    await jsonWrite(join(out,'scorecard.json'),scorecard);
    await jsonWrite(join(out,'motion.json'),allStates.map(s=>({viewportId:s.viewportId,stateId:s.stateId,...s.motion})));
    await jsonWrite(join(out,'interactions.json'),allStates.map(s=>({viewportId:s.viewportId,stateId:s.stateId,...s.interaction})));
    await jsonWrite(join(root,'evaluations',variantId,'scorecard.json'),{latestRun:options.runId??'single',...scorecard});
    return scorecard;
  }finally{if(ownBrowser)await browser.close();}
}
