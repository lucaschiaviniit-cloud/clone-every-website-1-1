import { join } from 'node:path';
import { jsonWrite,verifyCorpus } from '../core/artifacts.js';
import { launchBrowser } from '../browser/launch.js';
import { variants,buildVariants,type Variant } from '../reconstruction/builders.js';
import { evaluate } from '../evaluate/evaluate.js';
import { stats } from '../evaluate/metrics.js';

const dimensions=['changedPixelRatio','maeNormalized','meanBoxErrorPx','styleEqualRate','typographyEqualRate','domEqualRate','interactionPassRate','assetCoverageRate','remoteRequestsTransmitted','consoleErrors'] as const;
export async function benchmark(root:string,repeat:number,includeAblations=true,onlyVariant?:string) {
  if(!Number.isInteger(repeat)||repeat<3)throw new Error('Benchmark needs at least 3 repetitions');
  const m=await verifyCorpus(root);if(m.status!=='complete')throw new Error('Cannot benchmark blocked capture');
  const main=(await variants()).filter(v=>!onlyVariant||v.id===onlyVariant);if(!main.length)throw new Error('Unknown variant');
  const baseline=(await variants()).find(v=>v.id==='v4')!;
  const ablations:Variant[]=includeAblations?(['css','js','har','assets','state','motion'] as const).map(module=>({...baseline,id:`ablate-${module}`,[module]:false})):[];
  const variantsToRun=[...main,...ablations];await buildVariants(root,variantsToRun);
  const browser=await launchBrowser(),start=performance.now(),runs:any[]=[];
  try {
    for(const variant of variantsToRun)for(let repetition=1;repetition<=repeat;repetition++) {
      console.log(`bench ${variant.id} repeat ${repetition}/${repeat}`);
      const scorecard=await evaluate(root,variant.id,{browser,runId:`repeat-${repetition}`});
      runs.push(scorecard);
      await jsonWrite(join(root,'benchmark-progress.json'),{status:'running',completed:runs.length,total:variantsToRun.length*repeat,last:variant.id,elapsedSeconds:(performance.now()-start)/1000});
    }
  }catch(error){await jsonWrite(join(root,'benchmark-error.json'),{status:'invalid',error:String(error),completed:runs.length});throw error;}
  finally{await browser.close();}
  const summaries=variantsToRun.map(v=>{
    const vr=runs.filter(r=>r.variantId===v.id);
    return {variantId:v.id,metrics:Object.fromEntries(dimensions.map(d=>[d,stats(vr.map(r=>r.summary[d]).filter((n:unknown)=>typeof n==='number'))])),elapsedSeconds:stats(vr.map(r=>r.elapsedSeconds)),viewports:m.config.viewports.map(vp=>({viewportId:vp.id,changedPixelRatio:stats(vr.map(r=>r.viewports.find((x:any)=>x.viewportId===vp.id).visual.meanChangedPixelRatio)),maeNormalized:stats(vr.map(r=>r.viewports.find((x:any)=>x.viewportId===vp.id).visual.meanMaeNormalized)),interactionPassRate:stats(vr.map(r=>{const x=r.viewports.find((x:any)=>x.viewportId===vp.id).interaction;return x.assertions?x.passed/x.assertions:0;}))})),stability:m.config.viewports.map(vp=>({viewportId:vp.id,states:m.config.scenarios.map(s=>{const rows=vr.flatMap(r=>r.states.filter((x:any)=>x.viewportId===vp.id&&x.stateId===s.id));const unique=new Set(rows.map((r:any)=>r.screenshotSha256));return {stateId:s.id,uniqueScreenshotHashes:unique.size,pixelStable:unique.size===1,changedPixelRatio:stats(rows.map((r:any)=>r.visual.changedPixelRatio))};})}))};
  });
  const base=summaries.find(s=>s.variantId==='v4');
  const deltas=ablations.map(a=>{const s=summaries.find(s=>s.variantId===a.id)!;return {ablation:a.id,baseline:'v4',deltas:base?Object.fromEntries(dimensions.map(d=>[d,(s.metrics[d].median??0)-(base.metrics[d].median??0)])):null};});
  const mainSummaries=summaries.filter(s=>!s.variantId.startsWith('ablate-'));
  const bestVisual=[...mainSummaries].sort((a,b)=>(a.metrics.maeNormalized.median??Infinity)-(b.metrics.maeNormalized.median??Infinity))[0];
  const bestInteraction=[...mainSummaries].sort((a,b)=>(b.metrics.interactionPassRate.median??-1)-(a.metrics.interactionPassRate.median??-1))[0];
  const result={schemaVersion:1,captureId:m.captureId,corpusSha256:m.corpusSha256,status:'complete',offline:true,repeat,viewports:m.config.viewports,scenarios:m.config.scenarios.length,elapsedSeconds:(performance.now()-start)/1000,runs:runs.map(r=>({variantId:r.variantId,runId:r.runId,valid:r.valid,summary:r.summary})),summaries,ablations:deltas,ranking:{method:'Separate dimensions; no composite score or manually adjusted ranking',bestVisualByMedianMae:bestVisual?.variantId,bestVisualTies:mainSummaries.filter(s=>s.metrics.maeNormalized.median===bestVisual?.metrics.maeNormalized.median).map(s=>s.variantId),bestInteractionByMedianAssertionRate:bestInteraction?.variantId,bestInteractionTies:mainSummaries.filter(s=>s.metrics.interactionPassRate.median===bestInteraction?.metrics.interactionPassRate.median).map(s=>s.variantId)},referenceDrift:'Frozen corpus and software/config fingerprint, every artifact hash checked; no live reference comparability claim'};
  await jsonWrite(join(root,'benchmark.json'),result);
  await jsonWrite(join(root,'benchmark-progress.json'),{status:'complete',completed:runs.length,total:runs.length,elapsedSeconds:result.elapsedSeconds});
  return result;
}
