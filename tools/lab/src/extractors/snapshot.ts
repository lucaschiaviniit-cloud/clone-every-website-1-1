import type { Page } from 'playwright';
import type { Snapshot } from '../core/schema.js';

// This function is serialized by Playwright; all helpers must live inside it.
export async function snapshot(page:Page,maxElements:number,scope?:{selectors:string[]}):Promise<Snapshot> {
  return page.evaluate(({limit,scope})=>{
    const properties=['display','position','visibility','opacity','z-index','transform','transform-origin','overflow','overflow-x','overflow-y','width','height','min-width','max-width','min-height','max-height','box-sizing','margin-top','margin-right','margin-bottom','margin-left','padding-top','padding-right','padding-bottom','padding-left','gap','row-gap','column-gap','grid-template-columns','flex-direction','flex-wrap','align-items','justify-content','color','background-color','background-image','border','border-radius','box-shadow','font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-transform','white-space','animation-name','animation-duration','animation-delay','animation-timing-function','transition-property','transition-duration','transition-timing-function','content'];
    const path=(el:Element):string=>{
      if(el.id) return `#${CSS.escape(el.id)}`;
      const parent=el.parentElement;
      if(!parent) {const root=el.getRootNode();return root instanceof ShadowRoot?path(root.host)+' >>> '+el.tagName.toLowerCase():el.tagName.toLowerCase();}
      return path(parent)+' > '+el.tagName.toLowerCase()+`:nth-child(${Array.from(parent.children).indexOf(el)+1})`;
    };
    const styles=(cs:CSSStyleDeclaration)=>Object.fromEntries([...properties,...Array.from(cs).filter(k=>k.startsWith('--'))].map(k=>[k,cs.getPropertyValue(k)]));
    const rect=(r:DOMRect)=>({x:r.x,y:r.y,width:r.width,height:r.height});
    const visibility=(el:Element)=>{
      const r=el.getBoundingClientRect(),own=getComputedStyle(el);let opacity=1,hidden=false;
      for(let current:Element|null=el;current;){
        const style=getComputedStyle(current);opacity*=Number(style.opacity);
        if(style.display==='none'||style.contentVisibility==='hidden')hidden=true;
        const root=current.getRootNode();current=current.parentElement??(root instanceof ShadowRoot?root.host:null);
      }
      const visible=!hidden&&own.visibility!=='hidden'&&own.visibility!=='collapse'&&opacity>0&&r.width>0&&r.height>0;
      return {visible,effectiveOpacity:opacity,inViewport:visible&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth};
    };
    const all:Element[]=[],shadows:unknown[]=[],ancestors=new Set<Element>(),seen=new Set<Element>();
    const add=(el:Element)=>{if(seen.has(el))return;seen.add(el);all.push(el);if(el.shadowRoot){shadows.push({host:path(el),mode:'open',html:el.shadowRoot.innerHTML});walk(el.shadowRoot);}};
    const walk=(root:Document|ShadowRoot|Element)=>{for(const el of root.querySelectorAll('*'))add(el);};
    let roots:Element[]=[];
    if(scope) {
      roots=[...new Set(scope.selectors.flatMap(selector=>{
        const matches=[...document.querySelectorAll(selector)];
        if(!matches.length)throw new Error(`Selective snapshot root missing: ${selector}`);
        return matches;
      }))];
      for(const root of roots){for(let parent=root.parentElement;parent;parent=parent.parentElement)ancestors.add(parent);add(root);walk(root);}
      // Ancestors contribute computed layout context; unrelated subtrees are excluded.
      for(const parent of ancestors)if(!seen.has(parent)){seen.add(parent);all.push(parent);}
    }else walk(document);
    const elements=all.slice(0,limit).map((el,i)=>{
      const cs=getComputedStyle(el),r=el.getBoundingClientRect();
      const before=getComputedStyle(el,'::before'),after=getComputedStyle(el,'::after');
      // Measure each direct text node. Selecting every ancestor's descendants
      // duplicates thousands of rectangles on split-letter animated pages.
      const textRects=[...el.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE&&n.textContent?.trim()).flatMap(n=>{const range=document.createRange();range.selectNodeContents(n);return [...range.getClientRects()].map(rect);});
      const attributes=Object.fromEntries([...el.attributes].map(a=>[a.name,/value|nonce|token|secret|password/i.test(a.name)?'[REDACTED]':a.value]));
      return {elementId:`e${i}`,selector:path(el),tag:el.tagName.toLowerCase(),id:el.id,testId:el.getAttribute('data-testid')??'',text:[...el.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent??'').join('').trim(),attributes,box:{...rect(r),pageX:r.x+scrollX,pageY:r.y+scrollY},rects:[...el.getClientRects()].map(rect),...visibility(el),visibilityLimitations:['Does not prove lack of occlusion, crop or a WebGL replacement'],styles:styles(cs),before:before.content==='none'?null:styles(before),after:after.content==='none'?null:styles(after),textRects};
    });
    const sheets=(root:Document|ShadowRoot)=>Array.from(root.styleSheets??[]).map(sheet=>{
      try{return {href:sheet.href,status:'captured',rules:Array.from(sheet.cssRules).map(rule=>({text:rule.cssText,type:rule.type,media:rule instanceof CSSMediaRule?{condition:rule.conditionText,matches:matchMedia(rule.conditionText).matches}:undefined}))};}
      catch(e){return {href:sheet.href,status:'unavailable',error:String(e)};}
    });
    const css:unknown[]=[...sheets(document),...all.filter(el=>el.shadowRoot).flatMap(el=>sheets(el.shadowRoot!).map(s=>({...s,shadowHost:path(el)})))];
    const frames=all.filter((el):el is HTMLIFrameElement=>el instanceof HTMLIFrameElement).map(el=>{
      try {const d=el.contentDocument;if(!d)return {selector:path(el),src:el.src,status:'unavailable',reason:'cross-origin or not loaded'};return {selector:path(el),src:el.src,status:'captured',html:d.documentElement.outerHTML};}catch(e){return {selector:path(el),src:el.src,status:'unavailable',reason:String(e)};}
    });
    const animations=document.getAnimations().filter(a=>!scope||!!(a.effect as KeyframeEffect|null)?.target&&seen.has((a.effect as KeyframeEffect).target!)).map(a=>{
      const effect=a.effect as KeyframeEffect|null,target=effect?.target;
      return {id:a.id,type:a.constructor.name,target:target instanceof Element?path(target):null,playState:a.playState,currentTime:a.currentTime,playbackRate:a.playbackRate,startTime:a.startTime,timing:effect?.getTiming(),computedTiming:effect?.getComputedTiming(),keyframes:effect?.getKeyframes()};
    });
    // JSON has no nonfinite numeric literals. Encode the observed numeric values
    // explicitly instead of allowing JSON.stringify to silently turn them into null.
    const serializableAnimations=JSON.parse(JSON.stringify(animations,(_key,value)=>typeof value==='number'&&!Number.isFinite(value)?String(value):value));
    const media=all.filter(el=>el instanceof HTMLImageElement||el instanceof HTMLMediaElement).map(el=>{
      const common={selector:path(el),tag:el.tagName.toLowerCase(),...visibility(el)};
      if(el instanceof HTMLImageElement)return {...common,source:el.currentSrc||el.src,ready:el.complete&&el.naturalWidth>0,complete:el.complete,naturalWidth:el.naturalWidth,naturalHeight:el.naturalHeight,decoded:'not-observed' as const};
      const video=el as HTMLMediaElement;
      return {...common,source:video.currentSrc||video.src,ready:video.readyState>=2,readyState:video.readyState,currentTime:video.currentTime,paused:video.paused,ended:video.ended,error:video.error?.message};
    });
    const canvases=all.filter((el):el is HTMLCanvasElement=>el instanceof HTMLCanvasElement).map(c=>{
      try {
        // Inspect a small copy; never call getContext on the source canvas, since
        // that would create/change its context. Blank/uniform is advisory only.
        const copy=document.createElement('canvas');copy.width=Math.min(c.width,64);copy.height=Math.min(c.height,64);
        const context=copy.getContext('2d');let appearance:Record<string,unknown>={status:'unknown'};
        if(context&&copy.width&&copy.height){
          context.drawImage(c,0,0,copy.width,copy.height);const pixels=context.getImageData(0,0,copy.width,copy.height).data;
          let transparent=true,uniform=true;
          for(let i=0;i<pixels.length;i+=4){if(pixels[i+3]!==0)transparent=false;for(let channel=0;channel<4;channel++)if(pixels[i+channel]!==pixels[channel])uniform=false;}
          appearance={status:'observed',transparent,uniform,sampleWidth:copy.width,sampleHeight:copy.height,advisory:true,note:'Transparent or uniform pixels may be intentional; WebGL buffer lifetime may affect readback. Visual review required.'};
        }
        return {selector:path(c),width:c.width,height:c.height,box:rect(c.getBoundingClientRect()),...visibility(c),status:'captured',snapshot:c.toDataURL('image/png'),appearance,contextType:'unsupported: no context instrumentation (will not create/change a context)',sceneReconstruction:'unsupported'};
      }catch(e){return {selector:path(c),width:c.width,height:c.height,status:'unavailable',appearance:{status:'unknown',advisory:true},error:String(e)};}
    });
    let clone:HTMLElement;
    if(scope) {
      // Rebuild only selected branches plus shallow ancestors, preserving their context.
      const selected=new Set(all);
      const copyBranch=(el:Element):Element=>{
        const copy=el.cloneNode(false) as Element;
        for(const child of el.childNodes) {
          if(child instanceof Element) {if(selected.has(child))copy.append(copyBranch(child));}
          else if(!ancestors.has(el)||roots.some(root=>root===el||root.contains(el)))copy.append(child.cloneNode(true));
        }
        if(el.shadowRoot){const template=document.createElement('template');template.setAttribute('shadowrootmode','open');template.innerHTML=el.shadowRoot.innerHTML;copy.prepend(template);}
        return copy;
      };
      clone=copyBranch(document.documentElement) as HTMLElement;
    }else clone=document.documentElement.cloneNode(true) as HTMLElement;
    // Declarative shadow templates are a derived serialization of observed open roots.
    if(!scope){
      const originals=Array.from(document.querySelectorAll('*')),copies=Array.from(clone.querySelectorAll('*'));
      // include root before pairing, since querySelectorAll excludes its own root
      const originalsWithoutRoot=originals.filter(el=>el!==document.documentElement);
      originalsWithoutRoot.forEach((el,i)=>{if(el.shadowRoot&&copies[i]){const template=document.createElement('template');template.setAttribute('shadowrootmode','open');template.innerHTML=el.shadowRoot.innerHTML;copies[i].prepend(template);}});
    }
    clone.querySelectorAll('input,textarea').forEach(el=>{el.removeAttribute('value');if(el.tagName==='TEXTAREA')el.textContent='';});
    let session:unknown;
    try{session={cookies:document.cookie.split(';').filter(Boolean).map(s=>({name:s.split('=')[0].trim(),value:'[REDACTED]'})),localStorage:Object.keys(localStorage).map(name=>({name,value:'[REDACTED]'})),sessionStorage:Object.keys(sessionStorage).map(name=>({name,value:'[REDACTED]'}))};}
    catch(e){session={status:'unavailable',error:String(e)};}
    const w=window as any;
    return {url:location.href,timestampIso:new Date().toISOString(),browserTimeMs:performance.now(),scroll:{x:scrollX,y:scrollY,width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},totalElements:all.length,truncated:all.length>limit,...(scope?{scope:{kind:'fusion-selective',selectors:scope.selectors,ancestorSelectors:[...ancestors].map(path),sharedContext:['document-css','document-fonts','runtime-hints','redacted-session']}}:{}),limitations:[...(all.length>limit?[`Element snapshot truncated at ${limit} of ${all.length}; inspect omitted sections separately`]:[]),...(scope?['Selective evidence is not a complete page or standalone replay; CSS/font/runtime context remains shared']:[]),'DOM visibility does not prove actual rendering or WebGL replacement; media readiness is distinct from playback advancement'],elements,html:'<!doctype html>\n'+clone.outerHTML,shadows,frames,css,fonts:Array.from(document.fonts).map(f=>({family:f.family,style:f.style,weight:f.weight,stretch:f.stretch,status:f.status})),animations:serializableAnimations,canvases,media,session,runtime:{gsapExposed:!!w.gsap,lenisExposed:!!w.lenis,threeExposed:!!w.THREE,closedShadow:'unsupported: absent and closed roots cannot be distinguished without instrumentation',jsMotionInternals:'unsupported; external globals are hints only',animationNumberEncoding:'Nonfinite observed numbers use strings Infinity, -Infinity, NaN; finite numbers remain numbers',fontStatus:document.fonts.status,styleProperties:properties,hardware:{userAgent:navigator.userAgent,language:navigator.language,platform:navigator.platform}}};
  },{limit:maxElements,scope}) as Promise<Snapshot>;
}
