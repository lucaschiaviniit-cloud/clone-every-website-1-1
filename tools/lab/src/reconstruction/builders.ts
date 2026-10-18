import { parse,serialize,type DefaultTreeAdapterMap } from 'parse5';
import { readFile,mkdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hash,jsonRead,jsonWrite,verifyCorpus } from '../core/artifacts.js';
import type { Manifest,Resource } from '../core/schema.js';
import { remapFlightText,remapHtmlFlight } from '../replay/flight.js';

export interface Variant {id:string;builder:string;js:boolean;css:boolean;assets:boolean;har:boolean;state:boolean;motion:boolean}
export async function variants() {return jsonRead<Variant[]>('configs/variants.json');}
export function resourcePath(raw:string,sourceOrigin:string) {
  const u=new URL(raw);return (u.origin===sourceOrigin?'':`/__origin/${Buffer.from(u.origin).toString('base64url')}`)+u.pathname+u.search;
}
export function remapText(text:string,sourceOrigin:string,resources:Resource[],format:'text'|'html'|'flight'='text') {
  const origins=[...new Set(resources.map(r=>new URL(r.url).origin))].sort((a,b)=>b.length-a.length);
  const remap=(input:string)=>{
  let result=input;
  for(const origin of origins) {
    const local=origin===sourceOrigin?'':`/__origin/${Buffer.from(origin).toString('base64url')}`;
    // A documented literal origin remap, including escaped slash strings in JSON/JS.
    result=result.split(origin).join(local).split(origin.replaceAll('/','\\/')).join(local.replaceAll('/','\\/'));
  }
  return result;
  };
  return format==='html'?remapHtmlFlight(text,remap):format==='flight'?remapFlightText(text,remap):remap(text);
}
type Node=DefaultTreeAdapterMap['node'];
export function transformHtml(html:string,variant:Variant) {
  const doc=parse(html);
  const visit=(node:any)=>{
    if(node.childNodes) {
      node.childNodes=node.childNodes.filter((child:any)=>{
        if(!variant.js&&child.tagName==='script')return false;
        if(!variant.css&&(child.tagName==='style'||(child.tagName==='link'&&child.attrs?.some((a:any)=>a.name==='rel'&&a.value==='stylesheet'))))return false;
        return !(child.tagName==='meta'&&child.attrs?.some((a:any)=>a.name==='http-equiv'&&a.value.toLowerCase()==='refresh'));
      });
      for(const child of node.childNodes)visit(child);
    }
    if(node.content)visit(node.content);
    if(!variant.js&&node.attrs)node.attrs=node.attrs.filter((a:any)=>!a.name.startsWith('on'));
  };visit(doc);return serialize(doc);
}
export async function buildVariants(root:string,selected?:Variant[]) {
  const m=await verifyCorpus(root);if(m.status!=='complete')throw new Error('Cannot build blocked capture');
  if(m.scope?.kind==='fusion-selective')throw new Error('Selective Fusion evidence cannot build a complete Clone replay');
  for(const v of selected??await variants()) {
    const out=join(root,'replays',v.id);await mkdir(out,{recursive:true});
    const builds=[];
    for(const vp of m.config.viewports) {
      let html:string,source:string;
      if(v.builder==='static-snapshot') {
        const baseline=m.states.find(s=>s.viewportId===vp.id&&s.stateId===m.config.scenarios[0].id);if(!baseline)throw new Error('Baseline state missing');
        source=baseline.domFile;html=await readFile(join(root,source),'utf8');
      }else {
        const r=m.resources.find(r=>r.viewportId===vp.id&&r.type==='document'&&r.url===m.targetUrl&&r.file);if(!r?.file)throw new Error('Original HTML unavailable');
        source=r.file;html=await readFile(join(root,source),'utf8');
      }
      const derived=transformHtml(remapText(html,new URL(m.targetUrl).origin,m.resources,'html'),v),file=`index-${vp.id}.html`;
      await writeFile(join(out,file),derived,'utf8');builds.push({viewportId:vp.id,file,sha256:hash(derived),source,sourceSha256:hash(html)});
    }
    if(v.state)await jsonWrite(join(out,'state-catalog.json'),{scenarios:m.config.scenarios,states:m.states,behavior:'Evidence catalog only; original JavaScript remains the interaction engine. No event synthesis.'});
    if(v.motion)await jsonWrite(join(out,'motion-catalog.json'),{protocol:m.config.motionProtocol,evidence:m.evidence.filter(e=>e.kind==='D12'),behavior:'Inspection and validation only; no animation rewrite, no canvas video fallback'});
    await jsonWrite(join(out,'build.json'),{schemaVersion:1,captureId:m.captureId,corpusSha256:m.corpusSha256,variant:v,builds,media:{mode:m.config.mediaMode??'original',placeholderResponses:m.resources.filter(r=>r.substitution).length,originalPhotoVideoContentExcluded:m.config.mediaMode==='placeholders'},fidelity:v.builder==='static-snapshot'?'static visual DOM; CSS animation possible; no original JS; canvases blank':m.config.mediaMode==='placeholders'?'local application replay with explicit media placeholders; original photo/video content and timing excluded; not backend reconstruction':'local replay of distributed frontend; only observed GET data; not backend reconstruction',patchRules:['Literal origin URL remap for captured origins; repair React Flight UTF-8 text framing','HTML parser removes JS/CSS for configured ablation','No CSP or CORS removal; no guessed backend response']});
  }
}
export function allowedResource(r:Resource,v:Variant) {
  if(!r.replayable||!r.file||r.method!=='GET')return false;
  if(!v.js&&(r.type==='script'||/javascript/.test(r.mime)))return false;
  if(!v.css&&(r.type==='stylesheet'||/text\/css/.test(r.mime)))return false;
  if(!v.assets&&(['image','font','media'].includes(r.type)||/image\/|font\/|video\/|audio\//.test(r.mime)))return false;
  if(!v.har&&['fetch','xhr'].includes(r.type))return false;
  return true;
}
