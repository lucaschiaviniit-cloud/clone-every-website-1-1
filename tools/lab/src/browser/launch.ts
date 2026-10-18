import { chromium,type Browser } from 'playwright';
import os from 'node:os';
import { readFile,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hash } from '../core/artifacts.js';
import type { CaptureConfig,Viewport } from '../core/schema.js';
export async function launchBrowser():Promise<Browser> { return chromium.launch({headless:true,args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run']}); }
export async function newContext(browser:Browser,config:CaptureConfig,viewport:Viewport) {
  const context=await browser.newContext({viewport:{width:viewport.width,height:viewport.height},deviceScaleFactor:1,locale:config.locale,timezoneId:config.timezoneId,reducedMotion:config.reducedMotion,colorScheme:config.colorScheme,serviceWorkers:'block',acceptDownloads:false});
  // tsx preserves nested function names with this helper in serialized evaluate callbacks.
  // It supplies no website logic and does not replace any browser API.
  await context.addInitScript({content:"globalThis.__name = (fn, name) => Object.defineProperty(fn, 'name', { value: name, configurable: true });"});
  return context;
}
export async function environment(browser:Browser) {
  return {node:process.version,os:os.platform(),osRelease:os.release(),arch:os.arch(),browser:browser.version(),browserExecutable:chromium.executablePath(),cpu:os.cpus()[0]?.model,cpuCount:os.cpus().length,totalMemoryBytes:os.totalmem(),packageLockSha256:hash(await readFile('package-lock.json')),software:await softwareFingerprint(),network:'unthrottled; GET only; persistent sessions disabled',headless:true};
}
export async function softwareFingerprint() {
  const files:{file:string;sha256:string}[]=[];
  const walk=async(dir:string)=>{for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(dir,entry.name);if(entry.isDirectory())await walk(path);else if(entry.isFile())files.push({file:path.replaceAll('\\','/'),sha256:hash(await readFile(path))});}};
  for(const dir of ['src','fixtures','configs','assets'])await walk(dir);
  for(const file of ['package.json','package-lock.json','tsconfig.json','docs/reuse-lock.json'])files.push({file,sha256:hash(await readFile(file))});
  return {sha256:hash(JSON.stringify(files)),files};
}
