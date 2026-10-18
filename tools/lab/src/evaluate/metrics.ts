import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { writeFile,mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ElementSnapshot,Snapshot } from '../core/schema.js';

export function imageMetrics(aBytes:Buffer,bBytes:Buffer) {
  const a=PNG.sync.read(aBytes),b=PNG.sync.read(bBytes);
  if(a.width!==b.width||a.height!==b.height)throw new Error(`Invalid comparison dimensions ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  const diff=new PNG({width:a.width,height:a.height}),heat=new PNG({width:a.width,height:a.height});
  const changed=pixelmatch(a.data,b.data,diff.data,a.width,a.height,{threshold:.1,includeAA:true});
  let absoluteError=0,rawChanged=0;
  for(let i=0;i<a.data.length;i+=4){let sum=0;for(let c=0;c<3;c++)sum+=Math.abs(a.data[i+c]-b.data[i+c]);absoluteError+=sum;if(sum)rawChanged++;heat.data[i]=Math.min(255,sum);heat.data[i+1]=Math.max(0,128-sum);heat.data[i+2]=0;heat.data[i+3]=255;}
  const pixels=a.width*a.height;
  return {metrics:{width:a.width,height:a.height,pixels,changedPixels:changed,changedPixelRatio:changed/pixels,rawChangedPixelRatio:rawChanged/pixels,maeRgb:absoluteError/(pixels*3),maeNormalized:absoluteError/(pixels*3*255),pixelmatchThreshold:.1,includeAntialiasing:true,masks:[]},diff,heat};
}
export async function writeDiffs(result:ReturnType<typeof imageMetrics>,diffPath:string,heatPath:string){await mkdir(dirname(diffPath),{recursive:true});await writeFile(diffPath,PNG.sync.write(result.diff));await writeFile(heatPath,PNG.sync.write(result.heat));}
export function mean(values:number[]) {return values.length?values.reduce((a,b)=>a+b,0)/values.length:0;}
export function quantile(values:number[],q:number){const s=[...values].sort((a,b)=>a-b);if(!s.length)return null;const i=(s.length-1)*q,lo=Math.floor(i);return s[lo]+(s[Math.ceil(i)]-s[lo])*(i-lo);}
export function stats(values:number[]){return {n:values.length,median:quantile(values,.5),min:values.length?Math.min(...values):null,max:values.length?Math.max(...values):null,iqr:values.length?(quantile(values,.75)!-quantile(values,.25)!):null};}
export function matchElements(a:ElementSnapshot[],b:ElementSnapshot[]) {
  const used=new Set<ElementSnapshot>(),pairs:{a:ElementSnapshot;b:ElementSnapshot;confidence:number;method:string}[]=[],missing:string[]=[];
  for(const el of a) {
    const other=b.find(x=>!used.has(x)&&x.tag===el.tag&&(el.id?x.id===el.id:el.testId?x.testId===el.testId:x.selector===el.selector));
    if(!other){missing.push(el.selector);continue;}used.add(other);
    pairs.push({a:el,b:other,confidence:el.id||el.testId?1:el.text===other.text?0.95:0.6,method:el.id?'id+tag':el.testId?'testid+tag':'selector path+tag; tree dependent'});
  }
  return {pairs,missing,extra:b.filter(x=>!used.has(x)).map(x=>x.selector)};
}
const TYPO=['font-family','font-size','font-weight','font-style','line-height','letter-spacing','white-space'];
export function structuralMetrics(a:Snapshot,b:Snapshot) {
  const m=matchElements(a.elements,b.elements),errors:number[]=[],styleEqual:boolean[]=[],typographyEqual:boolean[]=[],textEqual:boolean[]=[],lineCountEqual:boolean[]=[],domEqual:boolean[]=[];
  const offenders=[];
  for(const p of m.pairs) {
    const error=Math.max(...(['pageX','pageY','width','height'] as const).map(k=>Math.abs(p.a.box[k]-p.b.box[k])));errors.push(error);
    if(error>1)offenders.push({selector:p.a.selector,maxBoxErrorPx:error,confidence:p.confidence});
    for(const k of Object.keys(p.a.styles))styleEqual.push(p.a.styles[k]===p.b.styles[k]);
    for(const k of TYPO)typographyEqual.push(p.a.styles[k]===p.b.styles[k]);
    textEqual.push(p.a.text===p.b.text);lineCountEqual.push(p.a.textRects.length===p.b.textRects.length);
    const attrs=(e:ElementSnapshot)=>Object.fromEntries(Object.entries(e.attributes).filter(([k])=>!['nonce','data-ready'].includes(k)).sort());
    domEqual.push(JSON.stringify(attrs(p.a))===JSON.stringify(attrs(p.b))&&p.a.text===p.b.text);
  }
  const rate=(v:boolean[])=>v.length?v.filter(Boolean).length/v.length:null;
  return {matching:{paired:m.pairs.length,reference:a.elements.length,replica:b.elements.length,missing:m.missing,extra:m.extra,referenceCoverage:a.elements.length?m.pairs.length/a.elements.length:null,method:'id/testid + tag, else selector path + tag; ids are snapshot-local',confidenceCounts:{one:m.pairs.filter(p=>p.confidence===1).length,point95:m.pairs.filter(p=>p.confidence===.95).length,point6:m.pairs.filter(p=>p.confidence===.6).length}},geometry:{meanBoxErrorPx:mean(errors),maxBoxErrorPx:errors.length?Math.max(...errors):null,within1pxRate:errors.length?errors.filter(e=>e<=1).length/errors.length:null,offenders:offenders.sort((x,y)=>y.maxBoxErrorPx-x.maxBoxErrorPx).slice(0,12),pageHeightDeltaPx:b.scroll.height-a.scroll.height},style:{equalPropertyRate:rate(styleEqual),comparedProperties:styleEqual.length},typography:{equalPropertyRate:rate(typographyEqual),textEqualRate:rate(textEqual),textRectCountEqualRate:rate(lineCountEqual),renderedFonts:'Not compared per element: CDP rendered font evidence only at capture'},dom:{equalNodeRate:rate(domEqual)}};
}
export function motionMetrics(a:Snapshot,b:Snapshot) {
  const aa=a.animations,bb=b.animations;
  const targets=aa.map(anim=>{
    const other=bb.find(x=>x.target===anim.target&&x.type===anim.type),ae=a.elements.find(e=>e.selector===anim.target),be=b.elements.find(e=>e.selector===anim.target);
    return {target:anim.target,type:anim.type,matched:!!other,currentTimeErrorMs:other?Math.abs(Number(anim.currentTime)-Number(other.currentTime)):null,keyframesEqual:other?JSON.stringify(anim.keyframes)===JSON.stringify(other.keyframes):false,timingEqual:other?JSON.stringify(anim.timing)===JSON.stringify(other.timing):false,transformEqual:!!ae&&!!be&&ae.styles.transform===be.styles.transform,opacityEqual:!!ae&&!!be&&ae.styles.opacity===be.styles.opacity};
  });
  const canvas=a.canvases.map(c=>{const other=b.canvases.find(x=>x.selector===c.selector);return {selector:c.selector,matched:!!other,pixelsEqual:!!c.snapshot&&c.snapshot===other?.snapshot,context:'unsupported: no deep context instrumentation',scene:'unsupported'};});
  return {css:targets.filter(x=>x.type==='CSSAnimation'||x.type==='CSSTransition'),waapi:targets.filter(x=>x.type!=='CSSAnimation'&&x.type!=='CSSTransition'),canvas,referenceAnimations:aa.length,replicaAnimations:bb.length,matchedAnimations:targets.filter(t=>t.matched).length,transformEqualRate:targets.length?targets.filter(t=>t.transformEqual).length/targets.length:null,jsGsapLenis:'unsupported: no internal object capture',webglScene:'unsupported; canvas pixels only'};
}
