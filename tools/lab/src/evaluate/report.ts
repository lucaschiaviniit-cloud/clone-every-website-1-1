import { join,resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { jsonRead } from '../core/artifacts.js';
import type {Manifest} from '../core/schema.js';
export async function report(root:string,_writeDocs=false) {
  const bench=await jsonRead<any>(join(root,'benchmark.json'));
  const manifest=await jsonRead<Manifest>(join(root,'manifest.json'));
  const pct=(x:any)=>typeof x==='number'?(x*100).toFixed(3)+'%':'not measured';
  const number=(x:any)=>typeof x==='number'?x.toFixed(6):'not measured';
  const table=bench.summaries.map((s:any)=>`| ${s.variantId} | ${pct(s.metrics.changedPixelRatio.median)} | ${number(s.metrics.maeNormalized.median)} | ${number(s.metrics.meanBoxErrorPx.median)} | ${pct(s.metrics.interactionPassRate.median)} | ${pct(s.metrics.assetCoverageRate.median)} | ${number(s.metrics.remoteRequestsTransmitted.median)} | ${pct(s.metrics.changedPixelRatio.iqr)} |`).join('\n');
  const stable=bench.summaries.map((s:any)=>`- ${s.variantId}: ${s.stability.flatMap((v:any)=>v.states).filter((x:any)=>x.pixelStable).length}/${s.stability.flatMap((v:any)=>v.states).length} identical screenshot hashes across repetitions.`).join('\n');
  const text=`# Deterministic replay benchmark

Target: ${manifest.targetUrl}
Corpus SHA256: ${bench.corpusSha256}
Artifacts: ${resolve(root)}

${bench.repeat} repetitions, ${bench.viewports.length} viewports, ${bench.scenarios} scenarios per viewport. Medians of run means. IQR is observed dispersion, not a confidence interval. No visual masks. Only configured states were measured.

| Variant | Changed pixels | MAE | Box error px | Assertion pass | Assets resolved | Remote transmitted | Pixel IQR |
|---|---:|---:|---:|---:|---:|---:|---:|
${table}

${stable}

V0 serializes static DOM; V1 replays distributed frontend; V2 additionally serves observed GET data, including worker resources. V3/V4 add evidence catalogs while retaining the V2 frontend. They do not demonstrate better reconstruction merely by having different natural-runtime scores. No server logic is reconstructed. POST, forms, WebSockets and AI runtime are disabled.

Motion protocol: ${manifest.config.motionProtocol}. WAAPI seeking controls only exposed CSS/WAAPI timelines. Natural JS, video, GSAP, RAF and canvas clocks remain variable; differences can include temporal drift. Actual timestamps, console errors, missing resources and blocked requests remain in scorecards.

Interaction coverage: ${manifest.policy?.interactionCoverage??'configured-scenarios-only'}. Default load/scroll scenarios do not prove menu, hover, focus or other interaction fidelity.

See benchmark.json for per-viewport summaries, ablation deltas, repetition stability and separate-dimension ranking. Vary one module at a time, at least three repetitions, and keep corpus/browser/software identity fixed. A replay is not editable original source and is not the reconstructed source phase. A new target needs its own measurements.
`;
  await writeFile(join(root,'RESULTS.md'),text,'utf8');return text;
}
