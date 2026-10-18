import { mkdir,readFile,realpath,writeFile } from 'node:fs/promises';
import { join,relative,isAbsolute,resolve } from 'node:path';
import { hash,jsonWrite,verifyCorpus } from '../core/artifacts.js';
import { launchBrowser,newContext } from '../browser/launch.js';
import { runScenario,settle } from '../browser/scenarios.js';
import { browserGuard } from '../replay/security.js';
import { replayServer } from '../replay/replay-server.js';
import { failureCategory } from '../browser/preflight.js';

/** A short startup receipt, not a full comparison or an accuracy approval. */
export async function checkReplay(root:string,out:string) {
  const corpus=await realpath(root),output=resolve(out);
  // Resolve existing ancestors before creating anything: even rejected checks must leave the corpus intact.
  let ancestor=output;
  for(;;) {
    try{await realpath(ancestor);break;}
    catch(error:any){if(error.code!=='ENOENT')throw error;const parent=resolve(ancestor,'..');if(parent===ancestor)throw error;ancestor=parent;}
  }
  const actual=resolve(await realpath(ancestor),relative(ancestor,output));
  const rel=relative(corpus,actual);
  if(rel===''||(!rel.startsWith('..')&&!isAbsolute(rel)))throw new Error('Replay check output must be outside the corpus');
  await mkdir(resolve(output,'..'),{recursive:true});
  await mkdir(output); // fresh evidence; never follow/overwrite an existing output directory
  const report:any={schemaVersion:1,kind:'replay-startup-check',status:'failed',createdAt:new Date().toISOString(),viewports:[],fullComparison:false,accuracyApproved:false};
  const started=performance.now();let browser:Awaited<ReturnType<typeof launchBrowser>>|undefined;
  try {
    const m=await verifyCorpus(root);report.corpusSha256=m.corpusSha256;
    report.buildSha256=hash(await readFile(join(root,'replays/v2/build.json')));
    // Preserve all prerequisites up to the first significant interaction, plus its immediate close/reset.
    const first=m.config.scenarios.findIndex(s=>['click','hover','focus','key','wheel','swipe','resize'].includes(s.action));
    let last=first<0?0:first;
    const next=m.config.scenarios[last+1];
    if(first>=0&&next?.action==='click'&&next.selector===m.config.scenarios[last].selector)last++;
    const actions=m.config.scenarios.slice(0,last+1);
    report.scenarioIds=actions.map(s=>s.id);
    browser=await launchBrowser();
    for(const vp of m.config.viewports) {
      const row:any={viewportId:vp.id,status:'failed',actions:[],pageErrors:[],consoleErrors:[],failures:[]};report.viewports.push(row);
      const originalErrors=new Set<string>();
      for(const evidence of m.evidence.filter(e=>e.kind==='D09'&&e.viewportId===vp.id&&e.file)) {
        const network=JSON.parse(await readFile(join(root,evidence.file!),'utf8'));
        for(const error of network.errors??[])originalErrors.add(error);
      }
      const server=await replayServer(root,'v2',vp.id,0,true);
      let context:Awaited<ReturnType<typeof newContext>>|undefined;
      try {
        context=await newContext(browser,m.config,vp);const page=await context.newPage();
        page.setDefaultTimeout(m.config.timeoutMs);
        page.on('pageerror',e=>row.pageErrors.push({message:e.message,observedOnOriginal:originalErrors.has(e.message)}));
        page.on('console',msg=>{if(msg.type()==='error')row.consoleErrors.push({message:msg.text(),observedOnOriginal:originalErrors.has(msg.text())});});
        const target=new URL(m.targetUrl),url=server.origin+target.pathname+target.search;
        const guard=await browserGuard(context,[server.origin],true,url);
        const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:m.config.timeoutMs});
        if(!response||response.status()>=400)throw new Error(`Replay document failed: ${response?.status()}`);
        row.readiness=await settle(page,m.config);
        for(const action of actions) {
          const result=await runScenario(page,action,m.config.motionProtocol);row.actions.push(result);
          if(!result.executed||result.assertion==='fail')row.failures.push(`scenario:${action.id}`);
        }
        row.assets=await page.evaluate(()=>{
          const visible=(element:Element)=>{
            const rect=element.getBoundingClientRect();
            if(rect.width<=0||rect.height<=0||rect.bottom<=0||rect.top>=innerHeight||rect.right<=0||rect.left>=innerWidth)return false;
            for(let current:Element|null=element;current;current=current.parentElement){const s=getComputedStyle(current);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false;}
            return true;
          };
          return {bodyPresent:!!document.body?.children.length,fontStatus:document.fonts.status,fontErrors:Array.from(document.fonts).filter(f=>f.status==='error').map(f=>f.family),brokenVisibleImages:Array.from(document.images).filter(i=>visible(i)&&(!i.complete||i.naturalWidth===0)).map(i=>i.currentSrc),scrollHeight:document.documentElement.scrollHeight,viewportHeight:innerHeight};
        });
        if(!row.assets.bodyPresent)row.failures.push('empty-body');
        if(row.assets.fontErrors.length)row.failures.push('font-error');
        if(row.assets.brokenVisibleImages.length)row.failures.push('visible-image-not-ready');
        // Probe real input without assuming an open overlay or a smooth scroller must move immediately.
        const before=await page.evaluate(()=>scrollY);await page.mouse.move(vp.width/2,vp.height/2);await page.mouse.wheel(0,400);await page.waitForTimeout(250);
        row.wheelProbe={before,after:await page.evaluate(()=>scrollY),assertion:'diagnostic-only; configured scroll assertions remain required'};
        const screenshot=await page.screenshot({animations:'allow',caret:'hide'}),file=`${vp.id}.png`;
        await writeFile(join(output,file),screenshot);row.screenshot={file,sha256:hash(screenshot)};
        row.network={remoteRequestsTransmitted:guard.remoteRequestsTransmitted,blocked:guard.blocked,unresolved:server.requests.filter(r=>!r.matched||r.status>=400)};
        if(row.network.unresolved.length)row.failures.push('local-resource-unresolved');
        if(row.pageErrors.some((e:any)=>!e.observedOnOriginal))row.failures.push('new-page-error');
        row.requiresReview=row.consoleErrors.length>0||row.pageErrors.length>0||guard.blocked.length>0;
        row.status=row.failures.length?'failed':'passed';
      }catch(error){row.failure={category:failureCategory(error),message:String(error)};}
      finally{await Promise.allSettled([context?.close(),server.close()]);}
    }
    report.status=report.viewports.every((v:any)=>v.status==='passed')?'passed':'failed';
    report.requiresReview=report.viewports.some((v:any)=>v.requiresReview);
  }catch(error){report.failure={category:failureCategory(error),message:String(error)};}
  finally{
    try{await browser?.close();}catch(error){report.cleanupError=String(error);report.status='failed';}
    report.elapsedMs=performance.now()-started;await jsonWrite(join(output,'report.json'),report);
  }
  return report;
}
