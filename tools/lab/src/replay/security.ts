import http from 'node:http';
import https from 'node:https';
import type { APIResponse,BrowserContext,Request } from 'playwright';
import { publicUrl } from '../adapters/webembedding.js';
import { makeMediaPlaceholder,type MediaPlaceholder } from './media-placeholders.js';
import type { CaptureConfig } from '../core/schema.js';
import { CaptureMediaCache,type RecordedResponse } from './capture-media-cache.js';
export const isLoopback=(host:string)=>['127.0.0.1','localhost','[::1]','::1'].includes(host);
export function isAIUrl(raw:string) {
  const u=new URL(raw);
  return /(^|\.)(openai\.com|anthropic\.com|cohere\.ai|cohere\.com|mistral\.ai|groq\.com|deepseek\.com|openrouter\.ai|together\.xyz|together\.ai|replicate\.com|huggingface\.co|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com)$/.test(u.hostname)
    || /\/v\d+\/(chat\/completions|completions|responses|messages|generate|embeddings)|\/(api\/generate|api\/chat)|:generateContent/.test(u.pathname);
}
export function installNodeGuard(allowedHosts:string[]=[]) {
  const validate=(raw:string|URL) => {const u=new URL(raw);if(isAIUrl(u.href))throw new Error('AI_RUNTIME_FORBIDDEN');if(!isLoopback(u.hostname)&&!allowedHosts.includes(u.hostname)) throw new Error(`NODE_REMOTE_FORBIDDEN ${u.hostname}`);};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=((input:Parameters<typeof fetch>[0],init?:RequestInit)=>{validate(typeof input==='string'||input instanceof URL?input:input.url);return originalFetch(input,init);}) as typeof fetch;
  for(const mod of [http,https]) {
    const original=mod.request;
    (mod as any).request=(...args:any[])=>{const a=args[0];validate(typeof a==='string'||a instanceof URL?a:`${mod===https?'https':'http'}://${a.hostname??a.host??'localhost'}${a.path??'/'}`);return (original as any)(...args);};
    const originalGet=mod.get;
    (mod as any).get=(...args:any[])=>{const a=args[0];validate(typeof a==='string'||a instanceof URL?a:`${mod===https?'https':'http'}://${a.hostname??a.host??'localhost'}${a.path??'/'}`);return (originalGet as any)(...args);};
  }
}
export interface TrafficAudit { blocked:{url:string;reason:string}[];aiViolations:string[];allowedRequests:number;remoteRequestsTransmitted:number;discoveredAssets:{origin:string;type:string;url:string}[];placeholders?:{url:string;kind:'image'|'video';bytes:number}[];placeholderErrors?:{url:string;reason:string}[];mediaCache?:{hits:number;reusedBodyBytes:number;enabled:boolean} }
const trackingHost=/(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|hotjar\.com|hotjar\.io|clarity\.ms|segment\.com|segment\.io|amplitude\.com|mixpanel\.com|facebook\.net)$/;
const assetExtension=/\.(?:css|m?js|cjs|png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|otf|mp4|webm|ogg|mp3|wav|m3u8|m4s|ts|vtt|wasm|glb|gltf|bin|hdr|ktx2?|dds|json)(?:$)/i;
export function isDiscoverableAsset(raw:string,type:string) {
  const u=new URL(raw);
  // Only page-emitted asset requests can extend capture scope. Never expand it
  // to a crawler, arbitrary document navigation, telemetry or an AI provider.
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||isAIUrl(raw)||trackingHost.test(u.hostname))return false;
  if(isLoopback(u.hostname)||/^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(u.hostname)||u.hostname.endsWith('.local'))return false;
  return ['stylesheet','script','image','font','media'].includes(type)||(['fetch','xhr','other'].includes(type)&&assetExtension.test(u.pathname));
}
export async function browserGuard(context:BrowserContext,allowedOrigins:string[],offline:boolean,documentUrl?:string,captureResponse?:(request:Request,response:RecordedResponse,source?:'same-context-media-cache')=>Promise<void>,options:{discoverAssets?:boolean;mediaConfig?:CaptureConfig;recordPlaceholder?:(request:Request,value:MediaPlaceholder)=>Promise<void>}={}) {
  const audit:TrafficAudit={blocked:[],aiViolations:[],allowedRequests:0,remoteRequestsTransmitted:0,discoveredAssets:[]};
  const mediaCache=captureResponse&&options.mediaConfig&&options.mediaConfig.captureMediaCache!==false?new CaptureMediaCache():undefined;
  if(captureResponse)audit.mediaCache={enabled:!!mediaCache,hits:0,reusedBodyBytes:0};
  await context.route('**/*',async route=>{
    const req=route.request(),u=new URL(req.url());let reason='';
    if(isAIUrl(u.href)) {reason='AI_RUNTIME_FORBIDDEN';audit.aiViolations.push(publicUrl(u.href));}
    else if(req.method()!=='GET')reason='non-GET';
    else if(trackingHost.test(u.hostname))reason='tracking-disabled';
    else if(!allowedOrigins.includes(u.origin)&&!(!offline&&options.discoverAssets&&isDiscoverableAsset(u.href,req.resourceType())))reason=offline?'offline-remote':'host-out-of-scope';
    else if(req.isNavigationRequest()&&req.frame().parentFrame()===null&&documentUrl&&u.href!==documentUrl)reason='homepage-only';
    if(reason) {audit.blocked.push({url:publicUrl(u.href),reason});await route.abort('blockedbyclient');}
    else {
      audit.allowedRequests++;
      if(captureResponse&&options.mediaConfig?.mediaMode==='placeholders') {
        try {
          const replacement=await makeMediaPlaceholder(req,options.mediaConfig);
          if(replacement) {
            if(!options.recordPlaceholder)throw new Error('Placeholder evidence recorder missing');
            await options.recordPlaceholder(req,replacement);
            await route.fulfill({status:200,contentType:replacement.mime,body:replacement.body,headers:{'cache-control':'no-store','access-control-allow-origin':'*'}});
            (audit.placeholders??=[]).push({url:publicUrl(u.href),kind:replacement.substitution.kind,bytes:replacement.body.length});
            return;
          }
        }catch(error) {
          const reason=String(error);(audit.placeholderErrors??=[]).push({url:publicUrl(u.href),reason});
          audit.blocked.push({url:publicUrl(u.href),reason});await route.abort('failed').catch(()=>undefined);return;
        }
      }
      if(!allowedOrigins.includes(u.origin)&&!audit.discoveredAssets.some(a=>a.origin===u.origin&&a.type===req.resourceType()))audit.discoveredAssets.push({origin:u.origin,type:req.resourceType(),url:publicUrl(u.href)});
      if(captureResponse) {
        // Observe original bytes before a worker consumes/transfers its stream.
        // Redirects are returned to Chromium and pass through this guard again.
        let response:APIResponse|undefined;
        try{
          // Request.headers() omits Cookie and other security headers in Playwright.
          const fullHeaders=mediaCache?await req.allHeaders():undefined;
          const key=fullHeaders?mediaCache?.key({url:()=>req.url(),resourceType:()=>req.resourceType(),headers:()=>fullHeaders}):undefined,cached=key?mediaCache?.get(key):undefined;
          if(cached) {
            await captureResponse(req,{headers:()=>cached.headers,status:()=>cached.status,statusText:()=>cached.statusText,body:async()=>cached.body},'same-context-media-cache');
            const headers={...cached.headers};delete headers['transfer-encoding'];delete headers['content-length'];delete headers.connection;
            await route.fulfill({status:cached.status,headers,body:cached.body});
            audit.mediaCache!.hits++;audit.mediaCache!.reusedBodyBytes+=cached.body.length;
          }else {
            if(!isLoopback(u.hostname))audit.remoteRequestsTransmitted++;
            response=await route.fetch({maxRedirects:0,maxRetries:0,timeout:60000});
            await captureResponse(req,response);
            if(key)await mediaCache!.store(key,response,options.mediaConfig!.maxBodyBytes).catch(()=>undefined);
            await route.fulfill({response});
          }
        }
        catch(error){console.error(`capture GET failed ${publicUrl(u.href)}: ${String(error)}`);audit.blocked.push({url:publicUrl(u.href),reason:`capture-fetch-failed: ${String(error)}`});await route.abort('failed').catch(()=>undefined);}
        finally{await response?.dispose().catch(()=>undefined);}
      }else {if(!isLoopback(u.hostname))audit.remoteRequestsTransmitted++;await route.continue();}
    }
  });
  await context.routeWebSocket('**/*',ws=>{audit.blocked.push({url:publicUrl(ws.url()),reason:'websocket-disabled'});ws.close();});
  return audit;
}
export function assertNoAI(audit:TrafficAudit) {if(audit.aiViolations.length)throw new Error(`AI_RUNTIME_FORBIDDEN ${audit.aiViolations.join(',')}`);}
