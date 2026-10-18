import { join,resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { capture,captureId,loadConfig } from './capture.js';
import { verifyCorpus } from './core/artifacts.js';
import { fixtureServer } from './replay/local-server.js';
import { installNodeGuard } from './replay/security.js';
import { buildVariants,variants } from './reconstruction/builders.js';
import { evaluate } from './evaluate/evaluate.js';
import { benchmark } from './experiments/runner.js';
import { report } from './evaluate/report.js';
import { replayServer } from './replay/replay-server.js';
import { readFile } from 'node:fs/promises';
import { buildIndex,sectionDossier,validateCoverage,planImpact } from './analysis/inventory.js';
import { compareSource,SourcePolicySchema } from './evaluate/source.js';
import { loadState,verifyApproval } from '../../../scripts/state.mjs';
import { verifyFusion } from './evaluate/fusion.js';
import { preflight } from './browser/preflight.js';
import { checkReplay } from './evaluate/replay-check.js';

const command=process.argv[2];
const {values}=parseArgs({args:process.argv.slice(3),options:{url:{type:'string'},config:{type:'string'},capture:{type:'string'},out:{type:'string'},variant:{type:'string'},viewport:{type:'string'},port:{type:'string'},repeat:{type:'string'},all:{type:'boolean'},offline:{type:'boolean'},'no-ablation':{type:'boolean'},run:{type:'string'},policy:{type:'string'},selection:{type:'string'},scenario:{type:'string',multiple:true},section:{type:'string'},'review-file':{type:'string'},'no-cache':{type:'boolean'},identity:{type:'string'},baseline:{type:'string'}}});
// Resolve caller paths before entering the portable engine's own root.
const root=values.capture?resolve(values.capture):undefined;
const configPath=values.config?resolve(values.config):undefined;
const outPath=values.out?resolve(values.out):undefined;
const runPath=values.run?resolve(values.run):undefined;
const policyPath=values.policy?resolve(values.policy):undefined;
const selectionPath=values.selection?resolve(values.selection):undefined;
const reviewPath=values['review-file']?resolve(values['review-file']):undefined;
const identityPath=values.identity?resolve(values.identity):undefined;
const fusionBaselinePath=values.baseline?resolve(values.baseline):undefined;
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
const captureConfig=command==='capture'?await loadConfig(configPath??'configs/capture.json'):undefined;
installNodeGuard(captureConfig?.ownershipAuthorization?captureConfig.allowedHosts:[]);
const requiredRoot=()=>{if(!root)throw new Error('--capture is required');return root;};
try {
  if(command==='preflight') {
    if(!outPath)throw new Error('--out run directory is required');
    const result=await preflight(outPath);console.log(JSON.stringify(result));if(result.status!=='passed')process.exitCode=1;
  }else if(command==='replay-check') {
    if(!outPath)throw new Error('--out fresh evidence directory is required');
    const result=await checkReplay(requiredRoot(),outPath);console.log(JSON.stringify({status:result.status,requiresReview:result.requiresReview}));if(result.status!=='passed')process.exitCode=1;
  }else if(command==='fusion-capabilities') {
    console.log(JSON.stringify({apiVersion:1,inventorySchema:1,features:['fusion-eval','fusion-selective-capture']}));
  }else if(command==='fusion-eval') {
    if(!values.url||!configPath||!identityPath||!outPath)throw new Error('--url, --config, --identity, --out required');
    const result=await verifyFusion(values.url,JSON.parse(await readFile(configPath,'utf8')),{out:outPath,identity:JSON.parse(await readFile(identityPath,'utf8')),baseline:fusionBaselinePath,selection:selectionPath?JSON.parse(await readFile(selectionPath,'utf8')):undefined});
    console.log(JSON.stringify({status:result.status,fullCoverage:result.fullCoverage}));
    if(result.status==='failed')process.exitCode=1;
  }else if(command==='fixture') {
    const server=await fixtureServer();try{console.log('CAPTURE_PATH='+await capture(server.origin+'/',outPath??join('outputs','fixture',captureId()),await loadConfig(configPath??'configs/fixture.json')));}finally{await server.close();}
  }else if(command==='capture') {
    if(!values.url)throw new Error('--url is required; no previous target is used');
    console.log('CAPTURE_PATH='+await capture(new URL(values.url).href,outPath??join('outputs',captureId()),captureConfig!));
  }else if(command==='verify') {
    const m=await verifyCorpus(requiredRoot());console.log(JSON.stringify({corpusSha256:m.corpusSha256,status:m.status}));
  }else if(command==='build') {
    const available=await variants(),selected=values.variant?available.filter(v=>v.id===values.variant):undefined;
    if(selected&&!selected.length)throw new Error('Unknown variant');
    await buildVariants(requiredRoot(),selected);
  }else if(command==='inventory'||command==='dossier') {
    if(!outPath)throw new Error('--out outside the capture is required');
    if(command==='dossier') {
      if(!values.section)throw new Error('--section is required');
      const r=await sectionDossier(requiredRoot(),outPath,values.section);console.log(JSON.stringify({file:r.file,cacheHit:r.cacheHit}));
    }else {
      const r=await buildIndex(requiredRoot(),outPath,{reviewFile:reviewPath,cache:!values['no-cache']});
      console.log(JSON.stringify({status:'indexed',cacheHit:r.cacheHit,files:r.files}));
    }
  }else if(command==='source-eval') {
    const {state}=await loadState(runPath);const approvedIdentity=await verifyApproval(state);
    if(!values.url||!outPath)throw new Error('--url and --out are required');
    const policy=policyPath?SourcePolicySchema.parse(JSON.parse(await readFile(policyPath,'utf8'))):undefined;
    const selection=selectionPath?JSON.parse(await readFile(selectionPath,'utf8')):{};
    if(selection.mode==='targeted'&&selection.changedComponents?.length&&state.analysisDir) {
      const inventory=JSON.parse(await readFile(join(state.analysisDir,'page-inventory.json'),'utf8'));
      const impact=planImpact(inventory,selection.changedComponents);selection.mode=impact.mode;selection.scenarioIds=impact.scenarioIds;selection.impactKnown=true;
    }
    const r=await compareSource(state.captureDir,values.url,{...selection,out:outPath,policy,variantId:state.baselineVariant??"v2",approvedEngineIdentity:approvedIdentity.engineSha256,protectedDirs:[state.sourceDir].filter(Boolean)});
    if(state.analysisDir) {
      const inventory=JSON.parse(await readFile(join(state.analysisDir,'page-inventory.json'),'utf8'));
      if(inventory.corpusSha256!==r.corpusSha256||inventory.captureId!==r.captureId||JSON.stringify(inventory.viewportIds)!==JSON.stringify(r.scope.viewportIds)||JSON.stringify(inventory.scenarios.map((s:any)=>s.id))!==JSON.stringify(r.scope.scenarioIds))throw new Error('Inventory belongs to a different corpus or scope');
      if(inventory.sourceIdentity) {
        await (await import('./core/artifacts.js')).jsonWrite(join(outPath,'coverage.json'),inventory);
        const coverage=validateCoverage(inventory);
        (r as any).inventoryCoverage=coverage;
        await (await import('./core/artifacts.js')).jsonWrite(join(outPath,'source-report.json'),r);
      }
    }
    console.log(JSON.stringify({status:r.status,summary:r.summary}));
  }else if(command==='eval'){const r=await evaluate(requiredRoot(),values.variant??'v2',{persistSnapshots:true,viewportId:values.viewport,scenarioIds:values.scenario});console.log(JSON.stringify(r.summary,null,2));}
  else if(command==='bench') {
    if(!values.offline)throw new Error('Benchmark requires explicit --offline');
    const result=await benchmark(requiredRoot(),Number(values.repeat??3),!values['no-ablation'],values.all?undefined:values.variant);
    await report(requiredRoot());console.log(JSON.stringify({status:result.status,elapsedSeconds:result.elapsedSeconds,ranking:result.ranking},null,2));
  }else if(command==='report'){await report(requiredRoot());console.log('Report written to corpus/RESULTS.md');}
  else if(command==='serve') {
    const server=await replayServer(requiredRoot(),values.variant??'v2',values.viewport??'desktop',Number(values.port??4173),true);
    const target=new URL(server.manifest.targetUrl);console.log(`Local replay: ${server.origin}${target.pathname}${target.search} (loopback only). Ctrl+C to stop.`);
    const stop=async()=>{await server.close();process.exit(0);};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  }else throw new Error('Commands: preflight, replay-check, fixture, capture, verify, build, inventory, dossier, source-eval, fusion-capabilities, fusion-eval, eval, bench, report, serve');
}catch(error){console.error(String(error));process.exitCode=1;}
