import { createHash } from 'node:crypto';
import type { APIResponse,Request } from 'playwright';

export type RecordedResponse=Pick<APIResponse,'headers'|'status'|'statusText'|'body'>;
export interface CachedMedia {
  body:Buffer;headers:Record<string,string>;status:number;statusText:string;expiresAt:number;
}
/** Bounded to one browser context. Never reuse mutable API data or cross-viewport variants. */
export class CaptureMediaCache {
  private entries=new Map<string,CachedMedia>();
  private bytes=0;
  constructor(private maxBytes=32*1024*1024) {}
  key(req:Pick<Request,'url'|'resourceType'|'headers'>) {
    const headers=req.headers(),control=headers['cache-control']??'';
    if(!['image','media'].includes(req.resourceType())||headers.cookie||headers.authorization||headers['if-range']||headers['if-none-match']||headers['if-modified-since']||/no-cache|no-store|max-age\s*=\s*0/i.test(control)||headers.pragma)return undefined;
    // All headers participate, including Range, Accept and client hints. Never serialize secrets.
    return createHash('sha256').update(JSON.stringify([req.url(),req.resourceType(),Object.entries(headers).sort(([a],[b])=>a.localeCompare(b))])).digest('hex');
  }
  get(key:string,now=Date.now()) {
    const value=this.entries.get(key);
    if(value&&value.expiresAt>now)return value;
    if(value){this.entries.delete(key);this.bytes-=value.body.length;}
    return undefined;
  }
  async store(key:string,response:RecordedResponse,maxBodyBytes:number,now=Date.now()) {
    const headers=response.headers(),control=headers['cache-control']??'',status=response.status();
    const maxAge=/(?:^|,)\s*max-age\s*=\s*(?:"(\d+)"|(\d+))\s*(?:,|$)/i.exec(control);
    // Cache only explicitly fresh media; an immutable directive alone has no freshness lifetime.
    if(![200,206].includes(status)||!maxAge||control.split(',').filter(part=>/^\s*max-age\s*=/i.test(part)).length!==1||/no-cache|no-store|private/i.test(control)||headers['set-cookie']||headers.vary?.split(',').some(h=>h.trim()==='*')||headers['content-encoding'])return;
    const date=Date.parse(headers.date??''),apparentAge=Number.isFinite(date)?Math.max(0,now-date):0;
    const lifetime=Number(maxAge[1]??maxAge[2])*1000-Math.max(Number(headers.age??0)*1000,apparentAge);
    if(!Number.isFinite(lifetime)||lifetime<=0)return;
    const declared=Number(headers['content-length']);
    if(declared>Math.min(maxBodyBytes,this.maxBytes))return;
    const body=await response.body();
    if(!body.length||body.length>Math.min(maxBodyBytes,this.maxBytes)||(declared>0&&declared!==body.length))return;
    if(status===206) {
      const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers['content-range']??'');
      if(!range||Number(range[1])!==0||Number(range[2])+1!==Number(range[3])||Number(range[3])!==body.length)return;
    }else if(headers['content-range'])return;
    const old=this.entries.get(key);if(old){this.bytes-=old.body.length;this.entries.delete(key);}
    while(this.bytes+body.length>this.maxBytes&&this.entries.size){const first=this.entries.keys().next().value!;this.bytes-=this.entries.get(first)!.body.length;this.entries.delete(first);}
    this.entries.set(key,{body,headers,status,statusText:response.statusText(),expiresAt:now+lifetime});this.bytes+=body.length;
  }
}
