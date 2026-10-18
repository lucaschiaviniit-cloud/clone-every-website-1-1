import { readFile, mkdir, realpath, lstat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { ConfigSchema } from '../core/schema.js';
import type { CaptureConfig } from '../core/schema.js';
import { hash, jsonWrite } from '../core/artifacts.js';
import { launchBrowser, newContext } from '../browser/launch.js';
import { settle, runScenario } from '../browser/scenarios.js';
import { browserGuard, assertNoAI, isLoopback } from '../replay/security.js';
import { selectScenarios } from './selection.js';
import { imageMetrics, writeDiffs } from './metrics.js';

const ID=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const SHA=z.string().regex(/^[a-f0-9]{64}$/);
const SelectionSchema=z.object({mode:z.enum(['full','targeted','smoke']).optional(),scenarioIds:z.array(ID).optional(),sharedSystems:z.array(z.string()).optional(),impactKnown:z.boolean().optional()}).strict();
const Check=z.object({id:ID,componentId:ID,scenarioId:ID,selector:z.string().min(1),kind:z.enum(['visible','no-overflow','focus','token','text','box','media-ready']),property:z.string().optional(),value:z.string().optional(),maxWidth:z.number().nonnegative().optional(),minWidth:z.number().nonnegative().optional()}).strict().superRefine((c,ctx)=>{
  if(['token','text'].includes(c.kind)&&c.value===undefined)ctx.addIssue({code:'custom',message:'Token/text check requires value'});
  if(c.kind==='token'&&!c.property?.startsWith('--'))ctx.addIssue({code:'custom',message:'Token check requires CSS custom property'});
  if(c.kind==='box'&&c.minWidth===undefined&&c.maxWidth===undefined)ctx.addIssue({code:'custom',message:'Box check requires a bound'});
});
export const FusionSuiteSchema=z.object({schemaVersion:z.literal(1),config:ConfigSchema,components:z.array(z.object({id:ID,selector:z.string().min(1),scenarioIds:z.array(ID).min(1),viewportIds:z.array(ID).min(1)}).strict()).min(1),checks:z.array(Check).min(1),visual:z.object({maxChangedPixelRatio:z.number().min(0).max(1),rationale:z.string().min(1)}).strict().optional()}).strict().superRefine((s,c)=>{
  const ids=s.config.scenarios.map(x=>x.id),viewports=s.config.viewports.map(x=>x.id),components=s.components.map(x=>x.id);
  for(const [label,values] of [['scenario',ids],['viewport',viewports],['component',components],['check',s.checks.map(x=>x.id)]] as const)if(new Set(values).size!==values.length)c.addIssue({code:'custom',message:`Duplicate ${label} IDs`});
  if(s.config.selective)c.addIssue({code:'custom',message:'Fusion suite config cannot be a selective acquisition plan'});
  for(const component of s.components){
    if(component.viewportIds.some(x=>!viewports.includes(x))||component.scenarioIds.some(x=>!ids.includes(x)))c.addIssue({code:'custom',message:`Unknown scope in ${component.id}`});
    for(const scenario of component.scenarioIds)if(!s.checks.some(x=>x.componentId===component.id&&x.scenarioId===scenario))c.addIssue({code:'custom',message:`Missing check for ${component.id}/${scenario}`});
  }
  for(const check of s.checks)if(!s.components.some(x=>x.id===check.componentId&&x.scenarioIds.includes(check.scenarioId)))c.addIssue({code:'custom',message:`Check ${check.id} is outside component contract`});
});
type Suite=z.infer<typeof FusionSuiteSchema>;
interface Identity { buildSha256:string; projectSha256:string; registrySha256:string; files:{file:string;sha256:string}[]; root:string }
export interface FusionOptions { out:string; identity:Identity; baseline?:string; selection?:{mode?:'full'|'targeted'|'smoke';scenarioIds?:string[];sharedSystems?:string[];impactKnown?:boolean} }
const within=(root:string,path:string)=>{const rel=relative(root,path);return rel===''||(!rel.startsWith('..'+ '/')&&rel!=='..'&&!isAbsolute(rel));};
async function verifyIdentity(identity:Identity) {
  const root=await realpath(identity.root),files=[];
  for(const entry of identity.files){const path=await realpath(resolve(root,entry.file));if(!within(root,path))throw new Error('Build identity file escapes target');const digest=hash(await readFile(path));if(digest!==entry.sha256)throw new Error('Build identity changed during verification');files.push({file:entry.file,sha256:digest,nature:'observed'});}
  if(hash(JSON.stringify(files))!==identity.buildSha256)throw new Error('Build identity hash mismatch');
}
async function freshOutput(path:string,protectedRoots:string[]) {
  let parent=resolve(path);
  for(;;){try{await lstat(parent);break;}catch(e:any){if(e.code!=='ENOENT')throw e;parent=dirname(parent);}}
  const actual=resolve(await realpath(parent),relative(parent,resolve(path)));
  for(const root of protectedRoots)if(within(await realpath(root),actual))throw new Error('Verification output must stay outside target and baseline');
  await mkdir(dirname(path),{recursive:true});await mkdir(path); // Fresh evidence, never overwrite.
}
export async function verifyFusion(url:string,rawSuite:unknown,options:FusionOptions) {
  const suite=FusionSuiteSchema.parse(rawSuite),target=new URL(url);
  if(!['http:','https:'].includes(target.protocol)||!isLoopback(target.hostname)||target.username||target.password||target.hash)throw new Error('Fusion verification requires credential-free loopback HTTP(S)');
  SHA.parse(options.identity.buildSha256);SHA.parse(options.identity.projectSha256);SHA.parse(options.identity.registrySha256);
  await verifyIdentity(options.identity);
  const suiteSha256=hash(JSON.stringify(suite)),selection=selectScenarios(suite.config.scenarios,options.selection?SelectionSchema.parse(options.selection):undefined);
  let baseline:any,baselineRoot:string|undefined;
  if(options.baseline){
    const approval=JSON.parse(await readFile(options.baseline,'utf8'));
    if(approval.schemaVersion!==1||approval.kind!=='fusion-baseline'||!approval.confirmationText?.trim()||hash(approval.confirmationText)!==approval.confirmationSha256)throw new Error('Invalid Fusion baseline approval');
    const reportFile=resolve(dirname(options.baseline),approval.reportFile),bytes=await readFile(reportFile);
    if(hash(bytes)!==approval.reportSha256)throw new Error('Baseline report changed');
    baseline=JSON.parse(bytes.toString());baselineRoot=dirname(reportFile);
    if(baseline.status!=='passed'||!baseline.fullCoverage||baseline.suiteSha256!==suiteSha256||!approval.scope?.length||suite.components.some(c=>!approval.scope.includes(c.id)))throw new Error('Baseline scope/suite is not compatible; review the new project baseline');
    if(!suite.visual)throw new Error('Freeze a justified visual threshold before creating a baseline');
    for(const row of baseline.rows){const file=await realpath(resolve(baselineRoot!,row.screenshot));if(!within(await realpath(baselineRoot!),file)||hash(await readFile(file))!==row.screenshotSha256)throw new Error('Baseline screenshot changed or escapes report');}
  }
  await freshOutput(options.out,[options.identity.root,...(baselineRoot?[baselineRoot]:[])]);
  const browser=await launchBrowser(),rows:any[]=[],errors:string[]=[];
  const started=performance.now();
  try {
    if(baseline&&baseline.browser!==browser.version())throw new Error('Baseline browser drift; acquire/review a new baseline');
    for(const viewport of suite.config.viewports){
      const config=suite.config as CaptureConfig,context=await newContext(browser,config,viewport);
      try {
        const guard=await browserGuard(context,[target.origin],true,target.href),page=await context.newPage();page.setDefaultTimeout(config.timeoutMs);
        const pageErrors:string[]=[];page.on('pageerror',e=>pageErrors.push(e.message));page.on('console',m=>{if(m.type()==='error')pageErrors.push(m.text());});
        const httpErrors:string[]=[];page.on('response',r=>{if(r.status()>=400)httpErrors.push(`${r.status()} ${r.url()}`);});
        const response=await page.goto(target.href,{waitUntil:'domcontentloaded'});if(!response||response.status()>=400)throw new Error('Fusion target failed to load');
        const readiness=await settle(page,config);
        for(const scenario of selection.actions){
          const action=await runScenario(page,scenario,config.motionProtocol);assertNoAI(guard);
          if(!action.executed||action.assertion==='fail')errors.push(`${viewport.id}/${scenario.id}: ${action.error??'scenario assertion failed'}`);
          if(!selection.measuredIds.includes(scenario.id))continue;
          const checks=[];
          for(const check of suite.checks.filter(x=>x.scenarioId===scenario.id&&suite.components.some(c=>c.id===x.componentId&&c.viewportIds.includes(viewport.id)))){
            let observed:any,passed=false,error:string|undefined;
            try {
              const locator=page.locator(check.selector);if(await locator.count()!==1)throw new Error('Check selector must identify exactly one element');
              observed=await locator.evaluate(async(el,check)=>{
                const r=el.getBoundingClientRect(),style=getComputedStyle(el);
                if(check.kind==='no-overflow')return {pass:el.scrollWidth<=el.clientWidth+1&&r.left>=-1&&r.right<=innerWidth+1,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,left:r.left,right:r.right};
                if(check.kind==='focus')return {pass:document.activeElement===el};
                if(check.kind==='token'){const value=style.getPropertyValue(check.property!).trim();return {pass:value===check.value,value};}
                if(check.kind==='text')return {pass:el.textContent===check.value,value:el.textContent};
                if(check.kind==='box')return {pass:r.width>=(check.minWidth??0)&&r.width<=(check.maxWidth??Infinity),width:r.width};
                if(check.kind==='media-ready'){if(el instanceof HTMLImageElement){let timer:ReturnType<typeof setTimeout>|undefined;try{const decoded=await Promise.race([el.decode().then(()=>true,()=>false),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),2000);})]);return {pass:decoded&&el.complete&&el.naturalWidth>0};}finally{clearTimeout(timer);}}return {pass:el instanceof HTMLMediaElement&&el.readyState>=2};}
                let visible=r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth&&style.visibility==='visible';
                for(let parent:Element|null=el;parent;){const cs=getComputedStyle(parent);visible=visible&&cs.display!=='none'&&Number(cs.opacity)>0&&cs.contentVisibility!=='hidden';const root=parent.getRootNode();parent=parent.parentElement??(root instanceof ShadowRoot?root.host:null);}
                return {pass:visible,scope:'DOM geometry/opacity; occlusion and artistic quality require visual review'};
              },check);passed=observed.pass;
            }catch(e){error=String(e);}
            checks.push({id:check.id,componentId:check.componentId,passed,observed,error});
          }
          const screenshot=`${viewport.id}-${scenario.id}.png`,bytes=await page.screenshot({animations:'allow',caret:'hide'});
          await (await import('node:fs/promises')).writeFile(join(options.out,screenshot),bytes);
          let visual:any;
          if(baseline){const before=baseline.rows.find((x:any)=>x.viewportId===viewport.id&&x.scenarioId===scenario.id);if(!before)throw new Error('Baseline checkpoint missing');const comparison=imageMetrics(await readFile(resolve(baselineRoot!,before.screenshot)),bytes);await writeDiffs(comparison,join(options.out,`${viewport.id}-${scenario.id}-diff.png`),join(options.out,`${viewport.id}-${scenario.id}-heat.png`));visual={...comparison.metrics,passed:comparison.metrics.changedPixelRatio<=suite.visual!.maxChangedPixelRatio};}
          rows.push({viewportId:viewport.id,scenarioId:scenario.id,action,checks,readiness,screenshot,screenshotSha256:hash(bytes),visual});
        }
        errors.push(...pageErrors.map(e=>`${viewport.id}: ${e}`),...httpErrors.map(e=>`${viewport.id}: ${e}`));
        if(guard.blocked.some(x=>!['websocket-disabled','tracking-disabled'].includes(x.reason)))errors.push(`${viewport.id}: blocked runtime requests (see traffic audit)`);
        await jsonWrite(join(options.out,`traffic-${viewport.id}.json`),guard);
      }finally{await context.close();}
    }
    await verifyIdentity(options.identity);
    const failed=errors.length>0||rows.some(r=>r.checks.some((c:any)=>!c.passed)||r.visual?.passed===false);
    const result={schemaVersion:1,kind:'fusion-verification',status:failed?'failed':'passed',fullCoverage:selection.fullCoverage,scope:selection,identity:options.identity,suiteSha256,visualPolicy:suite.visual,browser:browser.version(),url:target.href,elapsedMs:performance.now()-started,rows,errors,technical:failed?'failed':'passed',fidelity:'not-verified',creative:'not-reviewed',visual:baseline?'compared-to-approved-fusion':'no-project-baseline',limitations:['Checks cover the declared contract and selected states only.','Build hash covers explicitly listed identity files; it does not attest which process serves the URL.','No automatic artistic, originality, performance or WCAG certification.']};
    await jsonWrite(join(options.out,'fusion-report.json'),result);return result;
  }catch(error){await jsonWrite(join(options.out,'fusion-error.json'),{schemaVersion:1,status:'failed',error:String(error),rows,errors,fullCoverage:false});throw error;}
  finally{await browser.close();}
}
