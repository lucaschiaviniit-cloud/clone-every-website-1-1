import { readFile,mkdir,readdir,realpath,lstat } from 'node:fs/promises';
import { join,resolve,relative,isAbsolute } from 'node:path';
import { z } from 'zod';
import type { Browser } from 'playwright';
import type { Snapshot,Scenario } from '../core/schema.js';
import { hash,jsonWrite,verifyCorpus } from '../core/artifacts.js';
import { launchBrowser,newContext,softwareFingerprint } from '../browser/launch.js';
import { settle,runScenario } from '../browser/scenarios.js';
import { snapshot } from '../extractors/snapshot.js';
import { browserGuard,isLoopback,assertNoAI } from '../replay/security.js';
import { replayServer } from '../replay/replay-server.js';
import { imageMetrics,structuralMetrics,motionMetrics,writeDiffs } from './metrics.js';
import { selectScenarios,type SelectionOptions } from './selection.js';

const Limits=z.object({
  maxChangedPixelRatio:z.number().min(0).max(1),
  maxBoxErrorPx:z.number().nonnegative(),
  maxPageHeightDeltaPx:z.number().nonnegative(),
  minElementCoverage:z.number().min(0).max(1),
  requiredSelectors:z.array(z.string()).default([]),
});
export const SourcePolicySchema=z.object({
  schemaVersion:z.literal(1),
  rationale:z.string().min(1),
  defaults:Limits.optional(),
  states:z.record(z.string(),Limits).default({}),
  selectorMap:z.record(z.string(),z.string()).default({}),
  recoveredLibraryHashes:z.record(z.string(),z.string().min(1)).default({}),
});
export type SourcePolicy=z.infer<typeof SourcePolicySchema>;
export interface SourceOptions extends SelectionOptions {
  out:string;variantId?:string;viewportIds?:string[];policy?:SourcePolicy;browser?:Browser;
  identity?:Record<string,unknown>;protectedDirs?:string[];
  // Internal attestation from verifyApproval, never from CLI/user options.
  approvedEngineIdentity?:string;
}

export function mappedScenario(s:Scenario,map:Record<string,string>):Scenario {
  return {...s,selector:s.selector?(map[s.selector]??s.selector):undefined,
    expect:s.expect?{...s.expect,selector:s.expect.selector?(map[s.expect.selector]??s.expect.selector):undefined}:undefined,
    precondition:s.precondition?{...s.precondition,selector:s.precondition.selector?(map[s.precondition.selector]??s.precondition.selector):undefined}:undefined};
}

function mappedSnapshot(actual:Snapshot,reference:Snapshot,map:Record<string,string>) {
  const result=structuredClone(actual);
  for(const [before,after] of Object.entries(map)) {
    const a=reference.elements.find(e=>e.selector===before),b=result.elements.find(e=>e.selector===after);
    if(a&&b){b.selector=a.selector;b.id=a.id;b.testId=a.testId;}
    for(const animation of result.animations)if(animation.target===after)animation.target=before;
    for(const canvas of result.canvases)if(canvas.selector===after)canvas.selector=before;
  }
  return result;
}

/** Internal comparator. Public verify-source.mjs enforces current user approval. */
export async function compareSource(root:string,sourceUrl:string,options:SourceOptions) {
  const target=new URL(sourceUrl);
  if(!['http:','https:'].includes(target.protocol)||!isLoopback(target.hostname)||target.username||target.password||target.hash)throw new Error('Source URL must be credential-free loopback HTTP(S)');
  const m=await verifyCorpus(root);
  if(m.scope?.kind==='fusion-selective')throw new Error('Selective Fusion evidence is not a Clone baseline');
  if(m.status!=='complete')throw new Error('Cannot compare an incomplete capture');
  const captureSoftwareSha256=(m.environment.software as any)?.sha256,currentSoftwareSha256=(await softwareFingerprint()).sha256;
  if(captureSoftwareSha256!==currentSoftwareSha256&&!options.approvedEngineIdentity)throw new Error('Software drift: acquire a new reference or review the repaired replay with the current engine');
  const selection=selectScenarios(m.config.scenarios,options),policy=options.policy?SourcePolicySchema.parse(options.policy):undefined;
  const viewports=m.config.viewports.filter(v=>!options.viewportIds||options.viewportIds.includes(v.id));
  if(!viewports.length||options.viewportIds?.some(id=>!m.config.viewports.some(v=>v.id===id)))throw new Error('Unknown or empty viewport selection');
  const output=resolve(options.out);
  let ancestor=resolve(output,'..');
  for(;;) {try{await lstat(ancestor);break;}catch(error:any){if(error.code!=='ENOENT')throw error;const next=resolve(ancestor,'..');if(next===ancestor)throw error;ancestor=next;}}
  const actualOutput=resolve(await realpath(ancestor),relative(ancestor,output));
  const contained=(base:string,path:string)=>{const r=relative(base,path);return r===''||(!r.startsWith('..')&&!isAbsolute(r));};
  for(const dir of [root,...options.protectedDirs??[]])if(contained(await realpath(dir),actualOutput))throw new Error('Comparison output must stay outside capture and source');
  await mkdir(resolve(output,'..'),{recursive:true});
  try {await mkdir(output);}catch(error:any){if(error.code!=='EEXIST')throw error;}
  if(await realpath(output)!==actualOutput)throw new Error('Comparison output symlink refused');
  const existing=await readdir(output);
  if(existing.some(name=>!['policy.json','selection.json','coverage.json'].includes(name)))throw new Error('Comparison evidence output must be fresh');
  for(const name of existing)if(!(await lstat(join(output,name))).isFile())throw new Error('Comparison metadata must be regular files without symlinks');
  const browser=options.browser??await launchBrowser(),ownBrowser=!options.browser;
  const start=performance.now(),rows:any[]=[],viewportRows:any[]=[];
  const originalScripts=new Set(m.resources.filter(r=>r.type==='script'||/javascript/.test(r.mime)).map(r=>r.sha256).filter(Boolean));
  try {
    if(browser.version()!==m.environment.browser)throw new Error('Browser version drift');
    for(const vp of viewports) {
      const server=await replayServer(root,options.variantId??'v2',vp.id);
      let referenceContext:Awaited<ReturnType<typeof newContext>>|undefined;
      let sourceContext:Awaited<ReturnType<typeof newContext>>|undefined;
      try {
        referenceContext=await newContext(browser,m.config,vp);
        const original=new URL(m.targetUrl),referenceUrl=server.origin+original.pathname+original.search;
        const referenceGuard=await browserGuard(referenceContext,[server.origin],true,referenceUrl),refPage=await referenceContext.newPage();
        refPage.setDefaultTimeout(m.config.timeoutMs);
        const refResponse=await refPage.goto(referenceUrl,{waitUntil:'domcontentloaded',timeout:m.config.timeoutMs});
        if(!refResponse||refResponse.status()>=400)throw new Error('Approved replay failed to load');
        const referenceReadiness=await settle(refPage,m.config);
        const references=new Map<string,{action:any;snapshot:Snapshot;screenshot:Buffer}>();
        // One heavy page runs at a time; source begins after reference checkpoints.
        for(const scenario of selection.actions) {
          const action=await runScenario(refPage,scenario,m.config.motionProtocol);assertNoAI(referenceGuard);
          if(!action.executed||action.assertion==='fail')throw new Error(`Approved replay scenario failed: ${vp.id}/${scenario.id}`);
          if(selection.measuredIds.includes(scenario.id))references.set(scenario.id,{action,snapshot:await snapshot(refPage,m.config.maxElements),screenshot:await refPage.screenshot({fullPage:false,animations:'allow',caret:'hide'})});
        }
        await referenceContext.close();
        sourceContext=await newContext(browser,m.config,vp);
        const sourceGuard=await browserGuard(sourceContext,[target.origin],true,target.href),page=await sourceContext.newPage();
        page.setDefaultTimeout(m.config.timeoutMs);
        const errors:string[]=[],httpErrors:any[]=[],pending:Promise<void>[]=[],opaqueScripts:any[]=[];
        page.on('pageerror',e=>errors.push(e.message));
        page.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text());});
        sourceContext.on('response',response=>{
          if(response.status()>=400)httpErrors.push({url:response.url(),status:response.status()});
          if(response.request().resourceType()==='script')pending.push((async()=>{
            try{const sha256=hash(await response.body());if(originalScripts.has(sha256))opaqueScripts.push({url:response.url(),sha256,declaredLibrary:policy?.recoveredLibraryHashes[sha256]??null});}
            catch{errors.push(`Script bytes unavailable: ${response.url()}`);}
          })());
        });
        const response=await page.goto(target.href,{waitUntil:'domcontentloaded',timeout:m.config.timeoutMs});
        if(!response||response.status()>=400)throw new Error('Source failed to load');
        const sourceReadiness=await settle(page,m.config);
        for(const scenario of selection.actions) {
          const actualScenario=mappedScenario(scenario,policy?.selectorMap??{}),action=await runScenario(page,actualScenario,m.config.motionProtocol);assertNoAI(sourceGuard);
          if(!selection.measuredIds.includes(scenario.id)) {
            if(!action.executed||action.assertion==='fail')throw new Error(`Source prerequisite failed: ${scenario.id}`);
            continue;
          }
          const reference=references.get(scenario.id)!,raw=await snapshot(page,m.config.maxElements),actual=mappedSnapshot(raw,reference.snapshot,policy?.selectorMap??{});
          const screenshot=await page.screenshot({fullPage:false,animations:'allow',caret:'hide'}),stem=`${encodeURIComponent(vp.id)}-${encodeURIComponent(scenario.id)}`;
          const paths={reference:`screenshots/${stem}-reference.png`,actual:`screenshots/${stem}-source.png`,snapshot:`snapshots/${stem}-source.json`,referenceSnapshot:`snapshots/${stem}-reference.json`,diff:`diffs/${stem}.png`};
          const {writeFile}=await import('node:fs/promises');
          await mkdir(join(options.out,'screenshots'),{recursive:true});
          await writeFile(join(options.out,paths.reference),reference.screenshot);await writeFile(join(options.out,paths.actual),screenshot);
          await jsonWrite(join(options.out,paths.snapshot),raw);await jsonWrite(join(options.out,paths.referenceSnapshot),reference.snapshot);
          const image=imageMetrics(reference.screenshot,screenshot),structure=structuralMetrics(reference.snapshot,actual),motion=motionMetrics(reference.snapshot,actual);
          await writeDiffs(image,join(options.out,paths.diff),join(options.out,'diffs',stem+'-heat.png'));
          const limits=policy?.states[`${vp.id}/${scenario.id}`]??policy?.defaults,failures:string[]=[];
          if(!action.executed||action.assertion==='fail')failures.push('interaction');
          if(raw.truncated||reference.snapshot.truncated)failures.push('truncated-snapshot');
          if(limits) {
            if(image.metrics.changedPixelRatio>limits.maxChangedPixelRatio)failures.push('visual');
            if(structure.geometry.maxBoxErrorPx===null||structure.geometry.maxBoxErrorPx>limits.maxBoxErrorPx)failures.push('geometry');
            if(Math.abs(structure.geometry.pageHeightDeltaPx)>limits.maxPageHeightDeltaPx)failures.push('page-height');
            if((structure.matching.referenceCoverage??0)<limits.minElementCoverage)failures.push('element-coverage');
            for(const selector of limits.requiredSelectors) {
              if(!reference.snapshot.elements.some(e=>e.selector===selector&&e.visible))failures.push(`invalid-required-reference:${selector}`);
              if(!actual.elements.some(e=>e.selector===selector&&e.visible))failures.push(`required-selector:${selector}`);
            }
          }
          const brokenImages=(raw.media??[]).filter((x:any)=>x.tag==='img'&&x.visible&&(!x.complete||!x.naturalWidth));
          if(brokenImages.length)failures.push('visible-image-not-ready');
          if(raw.fonts.some((f:any)=>f.status==='error'))failures.push('font-error');
          rows.push({viewportId:vp.id,stateId:scenario.id,paths,hashes:{reference:hash(reference.screenshot),actual:hash(screenshot)},visual:image.metrics,structure,motion,interaction:action,media:raw.media??[],limits:limits??null,status:failures.length?'failed':limits?'passed':'unreviewed',failures});
        }
        await Promise.all(pending);
        viewportRows.push({viewportId:vp.id,referenceReadiness,sourceReadiness,errors,httpErrors,blocked:sourceGuard.blocked,opaqueScripts,referenceBlocked:referenceGuard.blocked});
      }finally{await Promise.allSettled([referenceContext?.close(),sourceContext?.close(),server.close()]);}
    }
    const complete=selection.fullCoverage&&viewports.length===m.config.viewports.length;
    const runtimeFailures=viewportRows.some(v=>v.errors.length||v.httpErrors.length||v.blocked.length||v.opaqueScripts.some((s:any)=>!s.declaredLibrary));
    const status=rows.some(r=>r.status==='failed')||runtimeFailures?'failed':rows.some(r=>r.status==='unreviewed')?'unreviewed':complete?'comparison_passed':'partial_passed';
    const report={schemaVersion:1,kind:'source-vs-approved-replay',createdAt:new Date().toISOString(),captureId:m.captureId,corpusSha256:m.corpusSha256,referenceProvenance:{variantId:options.variantId??'v2',captureSoftwareSha256,currentSoftwareSha256,approvedEngineIdentity:options.approvedEngineIdentity??null},scope:{viewportIds:m.config.viewports.map(v=>v.id),scenarioIds:m.config.scenarios.map(s=>s.id)},identity:options.identity??null,policySha256:policy?hash(JSON.stringify(policy)):null,sourceUrl:target.href,selection,complete,status,elapsedSeconds:(performance.now()-start)/1000,states:rows,viewports:viewportRows,
      summary:{measured:rows.length,passed:rows.filter(r=>r.status==='passed').length,failed:rows.filter(r=>r.status==='failed').length,unreviewed:rows.filter(r=>r.status==='unreviewed').length,runtimeFailures},
      limitations:['Comparison passes only its frozen policy and observed scenarios; it does not certify universal fidelity.','Natural JS/video/GPU clocks vary; no implicit masks or universal visual threshold.','Copied script hash detection is diagnostic; source independence and fresh-package checks are separate required delivery evidence.','Missing behavior assertions cannot prove interactions beyond the configured expectations.']};
    await jsonWrite(join(options.out,'source-report.json'),report);
    const lines=['# Source versus approved replay',`Status: ${status}`,`Coverage: ${rows.length}/${m.config.viewports.length*m.config.scenarios.length} checkpoints`,...rows.filter(r=>r.status!=='passed').map(r=>`- ${r.viewportId}/${r.stateId}: ${r.status} ${r.failures.join(', ')}`),'',...report.limitations];
    await (await import('node:fs/promises')).writeFile(join(options.out,'REPORT.md'),lines.join('\n')+'\n');
    return report;
  }finally{if(ownBrowser)await browser.close();}
}
