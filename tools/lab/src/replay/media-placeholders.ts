import { readFile } from 'node:fs/promises';
import type { Request } from 'playwright';
import type { CaptureConfig,Resource } from '../core/schema.js';

export interface MediaPlaceholder {body:Buffer;mime:string;substitution:NonNullable<Resource['substitution']>}
const videoPath=new URL('../../assets/media/placeholder.mp4',import.meta.url);
let sharedVideo:Promise<Buffer>|undefined;
export const loadPlaceholderVideo=()=>sharedVideo??=readFile(videoPath);

export function placeholderKind(raw:string,type:string,config:CaptureConfig):'image'|'video'|'unsupported-stream'|null {
  if(config.mediaMode!=='placeholders'||config.mediaPlaceholders?.preserveUrls?.includes(raw))return null;
  const u=new URL(raw),nested=u.searchParams.get('url');
  const path=nested?new URL(nested,u.origin).pathname:u.pathname;
  if(type==='script'||type==='stylesheet'||type==='font'||type==='document')return null;
  if(/\.(?:svg|ico)$/i.test(path))return null;
  if(/(?:^|\/|_|-)(?:favicon|logo|icons?)(?:\/|_|-|\.|$)/i.test(path))return null;
  // Keep audio, fonts, vectors, scripts and API data. Never infer a photo from
  // arbitrary binary fetches used by workers or application logic.
  if(/\.(?:m3u8|mpd|m4s|ts)$/i.test(path))return 'unsupported-stream';
  if(/\.(?:mp4|webm|mov|m4v|ogv)$/i.test(path)||type==='media'&&!/\.(?:mp3|wav|ogg|m4a|aac|flac)$/i.test(path))return 'video';
  if(type==='image'||/\.(?:png|jpe?g|webp|avif|gif|bmp)$/i.test(path))return 'image';
  return null;
}

export async function makeMediaPlaceholder(req:Request,config:CaptureConfig):Promise<MediaPlaceholder|null> {
  const kind=placeholderKind(req.url(),req.resourceType(),config);
  if(kind===null)return null;
  if(kind==='unsupported-stream')throw new Error('PLACEHOLDER_STREAM_UNSUPPORTED: streaming manifests/segments need a dedicated adapter or an explicit preserveUrls exception');
  if(kind==='video')return {body:await loadPlaceholderVideo(),mime:'video/mp4',substitution:{kind,originalBodyDownloaded:false,dimensionsSource:'shared-video',width:720,height:1280,limitations:['One shared 8-second local video; original duration, frames and audio are intentionally replaced.','CSS/markup must define original media geometry; intrinsic-only sizing requires explicit adaptation.']}};
  let dimensions=config.mediaPlaceholders?.imageDimensions?.[req.url()];
  let dimensionsSource:NonNullable<Resource['substitution']>['dimensionsSource']=dimensions?'configured':'fallback';
  if(!dimensions) {
    try {
      // Read declared intrinsic dimensions only. Measuring an auto-sized box
      // before loading would incorrectly treat its collapsed size as truth.
      dimensions=await req.frame().evaluate(url=>{
        const image=[...document.images].find(el=>el.currentSrc===url||el.src===url);
        if(!image)return undefined;
        const width=Number(image.getAttribute('width')),height=Number(image.getAttribute('height'));
        return width>0&&height>0&&width<=16384&&height<=16384?{width:Math.round(width),height:Math.round(height)}:undefined;
      },req.url());
      if(dimensions)dimensionsSource='markup';
    }catch{/* Workers and detached frames have no readable document. */}
  }
  const {width,height}=dimensions??{width:640,height:360};
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#d4d4d4"/><path d="M0 0L${width} ${height}M${width} 0L0 ${height}" stroke="#b8b8b8" stroke-width="2"/></svg>`;
  return {body:Buffer.from(svg),mime:'image/svg+xml',substitution:{kind,originalBodyDownloaded:false,dimensionsSource,width,height,limitations:dimensionsSource==='fallback'?['Original intrinsic image dimensions unavailable without downloading; supply imageDimensions or verify CSS aspect ratio.']:[]}};
}
