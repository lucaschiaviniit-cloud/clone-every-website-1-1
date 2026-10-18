import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { launchBrowser } from './launch.js';
import { localServer } from '../replay/local-server.js';
import { jsonWrite } from '../core/artifacts.js';

export function failureCategory(error:unknown) {
  const text=String(error);
  if(/ENOSPC|insufficient free space/i.test(text))return 'space';
  if(/EPERM|EACCES|permission denied|operation not permitted/i.test(text))return 'permissions';
  if(/executable.*doesn.t exist|cannot find|module not found/i.test(text))return 'dependencies';
  return 'runtime';
}

/** Local checks only: no target request, no corpus, and no retry after a deterministic failure. */
export async function preflight(out:string,minFreeBytes=512*1024*1024) {
  const checks:any[]=[],started=performance.now();
  const report:any={schemaVersion:1,kind:'clone-preflight',createdAt:new Date().toISOString(),status:'failed',checks,minFreeBytes,targetContacted:false};
  let server:Awaited<ReturnType<typeof localServer>>|undefined;
  let browser:Awaited<ReturnType<typeof launchBrowser>>|undefined;
  let stage='space';
  try {
    const fs=await statfs(out),freeBytes=fs.bavail*fs.bsize;
    checks.push({name:stage,freeBytes,status:freeBytes>=minFreeBytes?'passed':'failed',limitation:'Minimum startup reserve, not a prediction of final corpus/package size.'});
    if(freeBytes<minFreeBytes)throw new Error(`Insufficient free space: ${freeBytes} bytes, minimum ${minFreeBytes}`);
    stage='loopback';
    server=await localServer(async(_req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><title>Clone preflight</title><p id="ready">local runtime ready</p>');});
    checks.push({name:stage,status:'passed'});
    stage='browser';browser=await launchBrowser();
    const page=await browser.newPage();
    await page.goto(server.origin,{waitUntil:'domcontentloaded',timeout:10000});
    if(await page.locator('#ready').textContent()!=='local runtime ready')throw new Error('Local browser execution receipt missing');
    report.browser=browser.version();checks.push({name:stage,status:'passed'});report.status='passed';
  }catch(error){report.failure={stage,category:failureCategory(error),message:String(error)};}
  finally {
    const cleanup=await Promise.allSettled([browser?.close(),server?.close()]);
    report.cleanupErrors=cleanup.flatMap(r=>r.status==='rejected'?[String(r.reason)]:[]);
    if(report.cleanupErrors.length)report.status='failed';
    report.elapsedMs=performance.now()-started;
    await jsonWrite(join(out,'preflight.json'),report);
  }
  return report;
}
