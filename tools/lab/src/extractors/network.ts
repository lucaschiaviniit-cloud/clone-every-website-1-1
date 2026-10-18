import type { APIResponse,BrowserContext,Page,Request,Response } from 'playwright';
import { mkdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Manifest,Resource } from '../core/schema.js';
import { hash, type Artifacts } from '../core/artifacts.js';
import { publicUrl,safeHeaders } from '../adapters/webembedding.js';
import { toHeaders,detectBundler } from '../third-party/rever-helpers.js';
import type { MediaPlaceholder } from '../replay/media-placeholders.js';
import type { RecordedResponse } from '../replay/capture-media-cache.js';

export async function observeNetwork(context:BrowserContext,page:Page,artifacts:Artifacts,viewportId:string,routedCapture=false) {
  const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Debugger.enable');
  const events:unknown[]=[],scripts:unknown[]=[],pending:Promise<void>[]=[],har:any[]=[];
  cdp.on('Network.requestWillBeSent',event=>{
    const req=event.request;events.push({method:'Network.requestWillBeSent',requestId:event.requestId,url:publicUrl(req.url),requestMethod:req.method,type:event.type,timestamp:event.timestamp,wallTime:event.wallTime,initiator:JSON.parse(JSON.stringify(event.initiator,(key,value)=>key==='url'&&typeof value==='string'?publicUrl(value):value)),redirect:event.redirectResponse?{url:publicUrl(event.redirectResponse.url),status:event.redirectResponse.status}:undefined});
  });
  cdp.on('Network.responseReceived',e=>events.push({method:'Network.responseReceived',requestId:e.requestId,url:publicUrl(e.response.url),status:e.response.status,mime:e.response.mimeType,timing:e.response.timing,headers:safeHeaders(e.response.headers as Record<string,string>),timestamp:e.timestamp}));
  cdp.on('Network.loadingFailed',e=>events.push({method:'Network.loadingFailed',requestId:e.requestId,error:e.errorText,timestamp:e.timestamp}));
  cdp.on('Debugger.scriptParsed',e=>scripts.push({scriptId:e.scriptId,url:publicUrl(e.url),sourceMapURL:e.sourceMapURL?publicUrl(new URL(e.sourceMapURL,e.url||artifacts.manifest.targetUrl).href):undefined,hash:e.hash,startLine:e.startLine,endLine:e.endLine,source:'Debugger.scriptParsed; source maps not fetched proactively'}));
  const bodyWrites=new Map<string,Promise<void>>();
  const persistBody=async(sha256:string,body:Buffer)=>{
    let written=bodyWrites.get(sha256);
    if(!written){written=(async()=>{await mkdir(join(artifacts.root,'evidence/assets'),{recursive:true});await writeFile(join(artifacts.root,`evidence/assets/${sha256}.bin`),body);})();bodyWrites.set(sha256,written);}
    await written;
  };
  const recordResponse=(req:Request,response:Response|RecordedResponse,captureSource?:'same-context-media-cache')=>{
    const task=(async()=>{
      const raw=req.url(),url=publicUrl(raw);
      const headers=safeHeaders('allHeaders' in response?await response.allHeaders():response.headers()),mime=headers['content-type']??'';
      const r:Resource={viewportId,url,method:req.method(),type:req.resourceType(),mime,status:response.status(),headers,replayable:false};
      if(captureSource)r.captureSource=captureSource;
      try {
        if(raw!==url)throw new Error('Sensitive URL redacted: response body not persisted');
        if(req.method()!=='GET')throw new Error('Non-GET body excluded');
        const length=Number(headers['content-length']);if(length>artifacts.manifest.config.maxBodyBytes)throw new Error('Body size limit');
        const body=await response.body();if(body.length>artifacts.manifest.config.maxBodyBytes)throw new Error('Body size limit');
        if(length>0&&body.length===0)throw new Error('Empty browser body contradicts nonzero Content-Length; unavailable, not a captured empty file');
        r.sha256=hash(body);r.bytes=body.length;r.file=`evidence/assets/${r.sha256}.bin`;
        await persistBody(r.sha256,body);
        r.replayable=response.status()>=200&&response.status()<400;
      }catch(error){r.error=String(error);}
      artifacts.manifest.resources.push(r);
      har.push({startedDateTime:new Date().toISOString(),time:Math.max(0,req.timing().responseEnd),request:{method:r.method,url:r.url,httpVersion:'HTTP/1.1',headers:toHeaders(safeHeaders(req.headers())),queryString:[...new URL(r.url).searchParams].map(([name,value])=>({name,value})),cookies:[],headersSize:-1,bodySize:0},response:{status:r.status,statusText:response.statusText(),httpVersion:'HTTP/1.1',headers:toHeaders(headers),cookies:[],content:{mimeType:mime,size:r.bytes??0,_bodyFile:r.file,_sha256:r.sha256,_available:!!r.file},redirectURL:headers.location??'',headersSize:-1,bodySize:r.bytes??-1},cache:{},timings:{send:0,wait:Math.max(0,req.timing().responseStart),receive:0},_resourceType:r.type,_viewportId:viewportId,_bodyUnavailable:r.error,...(captureSource?{_captureSource:captureSource}: {})});
    })();pending.push(task);return task;
  };
  const recordPlaceholder=async(req:Request,value:MediaPlaceholder)=>{
    const raw=req.url(),url=publicUrl(raw);
    if(raw!==url)throw new Error('Sensitive URL redacted: placeholder evidence refused');
    const sha256=hash(value.body),file=`evidence/assets/${sha256}.bin`;
    await persistBody(sha256,value.body);
    const r:Resource={viewportId,url,method:'GET',type:req.resourceType(),mime:value.mime,status:200,headers:{'content-type':value.mime,'access-control-allow-origin':'*','cache-control':'no-store'},replayable:true,file,sha256,bytes:value.body.length,substitution:value.substitution};
    artifacts.manifest.resources.push(r);
    har.push({startedDateTime:new Date().toISOString(),time:0,request:{method:'GET',url,httpVersion:'HTTP/1.1',headers:[],queryString:[],cookies:[],headersSize:-1,bodySize:0},response:{status:200,statusText:'Local placeholder',httpVersion:'HTTP/1.1',headers:toHeaders(r.headers),cookies:[],content:{mimeType:r.mime,size:r.bytes,_bodyFile:file,_sha256:sha256,_available:true},redirectURL:'',headersSize:-1,bodySize:r.bytes},cache:{},timings:{send:0,wait:0,receive:0},_resourceType:r.type,_viewportId:viewportId,_synthetic:true,_originalBodyDownloaded:false});
  };
  if(!routedCapture)page.on('response',response=>{void recordResponse(response.request(),response);});
  return {cdp,events,scripts,recordResponse,recordPlaceholder,async finish(){await Promise.all(pending);return {events,scripts,har:{log:{version:'1.2',creator:{name:'deterministic-lab',version:'1.0.0'},entries:har},_bodyStorage:'content._bodyFile points to SHA256 verified bytes; synthetic placeholders explicitly marked; no secret request bodies or cookies',_captureMethod:routedCapture?'Validated route.fetch original GET bytes or explicit local placeholders before fulfill; includes dedicated worker traffic':'Playwright page response.body'}};}};
}
export async function scriptMetadata(m:Manifest,viewportId:string,root:string) {
  const { readFile }=await import('node:fs/promises');
  return Promise.all(m.resources.filter(r=>r.viewportId===viewportId&&(r.type==='script'||/javascript/.test(r.mime))).map(async r=>({url:r.url,file:r.file,sha256:r.sha256,mime:r.mime,bundler:r.file?detectBundler(await readFile(join(root,r.file),'utf8')):null,sourceMap:'Only maps observed in captured traffic are available; no source synthesis'})));
}
