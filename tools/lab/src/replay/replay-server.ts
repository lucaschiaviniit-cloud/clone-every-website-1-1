import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { jsonRead,hash,verifyCorpus,safePath } from '../core/artifacts.js';
import { localServer } from './local-server.js';
import { allowedResource,remapText,resourcePath,transformHtml,type Variant } from '../reconstruction/builders.js';
import { safeHeaders } from '../adapters/webembedding.js';
import { mediaRange } from './ranges.js';
import { adaptPlaylist } from './playlists.js';

export async function replayServer(root:string,variantId:string,viewportId:string,port=0,responsiveAssets=false) {
  const m=await verifyCorpus(root);
  if(m.scope?.kind==='fusion-selective')throw new Error('Selective Fusion evidence is not a complete Clone replay');
  const build=await jsonRead<any>(join(root,'replays',variantId,'build.json')),v=build.variant as Variant;
  if(build.corpusSha256!==m.corpusSha256)throw new Error('Build/corpus drift');
  const index=build.builds.find((b:any)=>b.viewportId===viewportId);if(!index)throw new Error('Viewport not built');
  const indexBytes=await readFile(join(root,'replays',variantId,index.file));if(hash(indexBytes)!==index.sha256)throw new Error('Built HTML hash mismatch');
  const sourceOrigin=new URL(m.targetUrl).origin;
  const resources=[...m.resources.filter(r=>r.viewportId===viewportId),...(responsiveAssets?m.resources.filter(r=>r.viewportId!==viewportId):[])];
  const resourceBytes=new Map<string,Buffer>();
  const requests:{url:string;status:number;matched:boolean;sha256?:string;originalSha256?:string;type?:string}[]=[];
  const server=await localServer(async(req,res)=>{
    const path=req.url??'/';
    if(req.method!=='GET'){requests.push({url:path,status:405,matched:false});res.writeHead(405);res.end();return;}
    const r=resources.find(r=>resourcePath(r.url,sourceOrigin)===path&&allowedResource(r,v));
    if(path===new URL(m.targetUrl).pathname+new URL(m.targetUrl).search) {
      const original=m.resources.find(r=>r.viewportId===viewportId&&r.url===m.targetUrl);
      if(original)for(const [k,value] of Object.entries(safeHeaders(original.headers,true)))if(!['content-type','location'].includes(k.toLowerCase()))res.setHeader(k,value);
      // Additional restrictive policy also protects a manual local preview. Original
      // CSP is retained as a separate policy; this never relaxes its restrictions.
      const offlineCsp="default-src 'self' data: blob:; connect-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; frame-src 'self'; form-action 'none'; object-src 'none'; base-uri 'self'";
      res.setHeader('content-security-policy',original?.headers['content-security-policy']?[original.headers['content-security-policy'],offlineCsp]:offlineCsp);
      res.setHeader('content-type','text/html; charset=utf-8');res.end(indexBytes);requests.push({url:path,status:200,matched:true,sha256:hash(indexBytes),originalSha256:original?.sha256,type:'document'});return;
    }
    if(!r?.file){requests.push({url:path,status:404,matched:false});res.writeHead(404,{'content-type':'text/plain'});res.end('Recorded resource unavailable');return;}
    let body:Buffer=resourceBytes.get(r.file)??await readFile(safePath(root,r.file));const originalHash=hash(body);
    if(originalHash!==r.sha256)throw new Error('Resource integrity mismatch');
    resourceBytes.set(r.file,body);
    if(/mpegurl/i.test(r.mime)||/\.m3u8(?:\?|$)/i.test(r.url)) {
      body=Buffer.from(adaptPlaylist(body.toString('utf8'),r.url,sourceOrigin));
    }else if(/text\/|javascript|json|svg\+xml/.test(r.mime)) {
      let text=remapText(body.toString('utf8'),sourceOrigin,m.resources,/text\/html/.test(r.mime)?'html':/text\/x-component/.test(r.mime)?'flight':'text');
      if(/text\/html/.test(r.mime))text=transformHtml(text,v);
      body=Buffer.from(text);
    }
    for(const [k,value] of Object.entries(safeHeaders(r.headers,true)))res.setHeader(k,k.toLowerCase()==='location'?remapText(value,sourceOrigin,m.resources):value);
    let status=r.status;
    if(/video\/|audio\//.test(r.mime)) {
      const ranged=mediaRange(body,r.status,r.headers['content-range'],req.headers.range);
      body=ranged.body;status=ranged.status;
      if(ranged.contentRange)res.setHeader('content-range',ranged.contentRange);else res.removeHeader('content-range');
      res.setHeader('accept-ranges','bytes');res.setHeader('content-length',body.length);
    }
    res.setHeader('content-type',r.mime);res.statusCode=status;res.end(body);
    requests.push({url:path,status,matched:true,sha256:hash(body),originalSha256:originalHash,type:r.type});
  },port);
  return {...server,requests,variant:v,manifest:m};
}
