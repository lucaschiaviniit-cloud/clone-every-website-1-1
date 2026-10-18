import type { Page } from 'playwright';
import type { CaptureConfig,Scenario,ScenarioExpectation } from '../core/schema.js';

export interface ReadinessObservation {
  mode:'fixed'|'adaptive'; status:'ready'|'fallback'|'failed'; elapsedMs:number;
  selectors:string[]; checks?:unknown; reason?:string;
  timelineOrigin:'natural scenarios start at first time action after settle';
}
export async function settle(page:Page,config:CaptureConfig,useReady=true):Promise<ReadinessObservation> {
  const start=performance.now(),origin='natural scenarios start at first time action after settle' as const;
  await page.waitForLoadState('domcontentloaded',{timeout:config.timeoutMs});
  if(useReady&&config.readySelector)await page.locator(config.readySelector).waitFor({timeout:config.timeoutMs});
  if(!config.readiness) {
    await page.evaluate(async timeout=>{
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([document.fonts.ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Font readiness timed out')),timeout);})]);}
      finally{clearTimeout(timer);}
    },config.timeoutMs);
    await page.waitForTimeout(config.settleMs);
    return {mode:'fixed',status:'ready',elapsedMs:performance.now()-start,selectors:[],timelineOrigin:origin};
  }
  const options=config.readiness,selectors=options.selectors??[config.readySelector??'body'];
  const timeout=options.timeoutMs??config.timeoutMs,deadline=performance.now()+timeout;
  const stableMs=options.stableMs??150,pollMs=options.pollMs??50;
  let previous='',stableSince=performance.now(),checks:unknown,reason='readiness deadline exceeded';
  try {
    while(performance.now()<deadline) {
      const observed=await page.evaluate(({selectors,fonts,images})=>{
        const roots=selectors.map(selector=>document.querySelector(selector));
        const imagesToCheck=[...new Set(roots.flatMap(root=>root?[...(root.matches('img')?[root as HTMLImageElement]:[]),...root.querySelectorAll('img')]:[]))];
        const pendingImages=images?imagesToCheck.filter(img=>!img.complete||img.naturalWidth===0).length:0;
        const boxes=roots.map(root=>root?{selector:selectors[roots.indexOf(root)],rect:[root.getBoundingClientRect().x,root.getBoundingClientRect().y,root.getBoundingClientRect().width,root.getBoundingClientRect().height]}:null);
        return {ready:roots.every(Boolean)&&(!fonts||document.fonts.status==='loaded')&&pendingImages===0,missingSelectors:selectors.filter((_,i)=>!roots[i]),fontStatus:document.fonts.status,pendingImages,boxes};
      },{selectors,fonts:options.fonts??true,images:options.images??true});
      checks=observed;
      const signature=JSON.stringify(observed.boxes);
      if(signature!==previous||!observed.ready){previous=signature;stableSince=performance.now();}
      if(observed.ready&&performance.now()-stableSince>=stableMs) {
        // Decode concurrently under one deadline; no per-image delays and no global animation stability.
        if(options.images!==false)await page.evaluate(async ({selectors,timeout})=>{
          const roots=selectors.map(selector=>document.querySelector(selector));
          const images=[...new Set(roots.flatMap(root=>root?[...(root.matches('img')?[root as HTMLImageElement]:[]),...root.querySelectorAll('img')]:[]))];
          let timer:ReturnType<typeof setTimeout>|undefined;
          try{await Promise.race([Promise.all(images.map(image=>image.decode())),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Image decoding timed out')),timeout);})]);}
          finally{clearTimeout(timer);}
        },{selectors,timeout:Math.max(1,deadline-performance.now())});
        return {mode:'adaptive',status:'ready',elapsedMs:performance.now()-start,selectors,checks,timelineOrigin:origin};
      }
      await page.waitForTimeout(Math.min(pollMs,Math.max(0,deadline-performance.now())));
    }
  }catch(e){reason=String(e);}
  if(options.fallback==='fail')throw new Error(`READINESS_FAILED: ${reason}`);
  await page.waitForTimeout(config.settleMs);
  return {mode:'adaptive',status:'fallback',elapsedMs:performance.now()-start,selectors,checks,reason,timelineOrigin:origin};
}
export async function seekMotion(page:Page,atMs:number) {
  return page.evaluate(t=>{
    const result=[];
    for(const a of document.getAnimations()) {
      try{a.pause();a.currentTime=t;result.push({type:a.constructor.name,currentTime:a.currentTime,status:'captured'});}catch(e){result.push({type:a.constructor.name,status:'unsupported',error:String(e)});}
    }
    return {nominalTimeMs:t,actualBrowserTimeMs:performance.now(),animations:result};
  },atMs);
}
// Preserve the historical origin: first natural time scenario, after settle. Readiness
// never resets or seeks this timeline; loading animations need separate checkpoints.
const naturalOrigins=new WeakMap<Page,number>();
async function scrollPosition(page:Page,selector?:string) {
  return page.evaluate(selector=>{
    const el=selector?document.querySelector(selector):null;
    return el?{x:el.scrollLeft,y:el.scrollTop}:{x:scrollX,y:scrollY};
  },selector);
}
async function mediaState(page:Page,selector?:string) {
  if(!selector)return undefined;
  return page.locator(selector).first().evaluate(el=>el instanceof HTMLMediaElement?{currentTime:el.currentTime,paused:el.paused,ended:el.ended,readyState:el.readyState}:undefined).catch(()=>undefined);
}
async function expectation(page:Page,e:ScenarioExpectation,beforeScroll?:{x:number;y:number},beforeMedia?:{currentTime:number}) {
  const loc=e.selector?page.locator(e.selector).first():null;
  const exists=loc?await loc.count()>0:true;
  const absentHidden=!exists&&e.visible===false&&e.attribute===undefined&&e.text===undefined&&e.visuallyVisible===undefined&&e.mediaReady===undefined&&e.videoPlaying===undefined;
  let pass=exists||absentHidden;const observed:Record<string,unknown>={exists,...(absentHidden?{visible:false,visibilityScope:'Absent element satisfies a pure hidden expectation'}:{})};
  // Evaluate every requested check so a failure still gives useful diagnostics.
  if(loc&&exists) {
    if(e.attribute){observed.attribute=await loc.getAttribute(e.attribute);pass=observed.attribute===e.value&&pass;}
    if(e.text!==undefined){observed.text=await loc.textContent();pass=observed.text===e.text&&pass;}
    if(e.visible!==undefined){observed.visible=await loc.isVisible();pass=observed.visible===e.visible&&pass;}
    if(e.visuallyVisible!==undefined){
      observed.visuallyVisible=await loc.evaluate(el=>{
        const rect=el.getBoundingClientRect(),style=getComputedStyle(el);
        if(style.visibility==='hidden'||style.visibility==='collapse'||rect.width<=0||rect.height<=0||rect.bottom<=0||rect.right<=0||rect.top>=innerHeight||rect.left>=innerWidth)return false;
        for(let current:Element|null=el;current;){const cs=getComputedStyle(current);if(cs.display==='none'||Number(cs.opacity)===0||cs.contentVisibility==='hidden')return false;const root=current.getRootNode();current=current.parentElement??(root instanceof ShadowRoot?root.host:null);}
        return true;
      });
      pass=observed.visuallyVisible===e.visuallyVisible&&pass;
      observed.visibilityScope='DOM/ancestor opacity and viewport; does not prove unoccluded rendering';
    }
    if(e.mediaReady!==undefined){
      observed.mediaReady=await loc.evaluate(async el=>{
        if(el instanceof HTMLMediaElement)return el.readyState>=2;
        if(!(el instanceof HTMLImageElement)||!el.complete||el.naturalWidth===0)return false;
        let timer:ReturnType<typeof setTimeout>|undefined;
        try{return await Promise.race([el.decode().then(()=>true,()=>false),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),2000);})]);}
        finally{clearTimeout(timer);}
      });
      observed.mediaReadinessScope='Image decode observed; media readyState>=2 does not prove video playback';
      pass=observed.mediaReady===e.mediaReady&&pass;
    }
    if(e.videoPlaying!==undefined){
      const after=await mediaState(page,e.selector);
      const advanced=!!after&&!!beforeMedia&&after.currentTime>beforeMedia.currentTime+0.001;
      observed.video={...after,beforeTime:beforeMedia?.currentTime,advanced};
      // !paused is insufficient: stalled/empty video must never pass as playing.
      observed.videoPlaying=!!after&&!after.paused&&!after.ended&&after.readyState>=2&&advanced;
      pass=observed.videoPlaying===e.videoPlaying&&pass;
    }
  }
  if(e.scrollChanged!==undefined) {
    const after=await scrollPosition(page,e.selector),delta=beforeScroll?Math.hypot(after.x-beforeScroll.x,after.y-beforeScroll.y):null;
    observed.scroll={before:beforeScroll,after,delta};
    observed.scrollChanged=delta!==null&&delta>(e.minScrollDelta??1);
    pass=delta!==null&&observed.scrollChanged===e.scrollChanged&&pass;
  }
  return {pass,observed};
}
export async function runScenario(page:Page,s:Scenario,protocol:CaptureConfig['motionProtocol']='waapi-seek') {
  const result:{id:string;executed:boolean;assertion:'pass'|'fail'|'not-applicable';error?:string;expected?:unknown;observed?:unknown;precondition?:unknown;motion?:unknown;actualBrowserTimeMs?:number}={id:s.id,executed:false,assertion:'not-applicable'};
  try {
    if(s.precondition) {
      // Movement assertions need a before/after action and cannot certify a precondition.
      if(s.precondition.scrollChanged!==undefined||s.precondition.videoPlaying!==undefined)throw new Error('Movement/playback preconditions require an action interval; use expect');
      const checked=await expectation(page,s.precondition);
      result.precondition={expected:s.precondition,...checked};
      if(!checked.pass)throw new Error('Scenario precondition not met');
    }
    const beforeScroll=s.expect?.scrollChanged!==undefined?await scrollPosition(page,s.expect.selector):undefined;
    const beforeMedia=s.expect?.videoPlaying!==undefined?await mediaState(page,s.expect.selector):undefined;
    if(s.action==='time') {
      if(protocol==='waapi-seek')result.motion=await seekMotion(page,s.atMs??0);
      else {
        const now=await page.evaluate(()=>performance.now());
        if(!naturalOrigins.has(page))naturalOrigins.set(page,now);
        const origin=naturalOrigins.get(page)!;
        const wait=Math.max(0,(s.atMs??0)-(now-origin));if(wait)await page.waitForTimeout(wait);
        result.motion={protocol,nominalTimeMs:s.atMs??0,actualElapsedMs:await page.evaluate(()=>performance.now())-origin,note:'Natural JS/video/GSAP runtime after settle; sampling overhead may exceed nominal time'};
      }
    } else if(s.action==='scroll') {
      await page.evaluate(async progress=>{
        const target=(document.documentElement.scrollHeight-innerHeight)*progress,start=scrollY;
        const steps=Math.max(1,Math.ceil(Math.abs(target-start)/200));
        for(let i=1;i<=steps;i++){window.scrollTo({top:start+(target-start)*i/steps,behavior:'instant'});await new Promise<void>(r=>requestAnimationFrame(()=>r()));}
      },s.progress??0);
    } else if(s.action==='wheel') {
      if(s.selector)await page.locator(s.selector).first().hover({timeout:2000});
      await page.mouse.wheel(s.deltaX??0,s.deltaY??400);
    } else if(s.action==='swipe') {
      if(!s.from||!s.to)throw new Error('swipe requires from and to coordinates');
      if(page.context().browser()?.browserType().name()!=='chromium')throw new Error('UNSUPPORTED: real touch swipe requires Chromium CDP');
      const session=await page.context().newCDPSession(page);
      try {
        const steps=s.steps??12;
        await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...s.from,id:0}]});
        for(let i=1;i<=steps;i++){
          await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:s.from.x+(s.to.x-s.from.x)*i/steps,y:s.from.y+(s.to.y-s.from.y)*i/steps,id:0}]});
          await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>r())));
        }
        await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      }finally{await session.detach();}
    } else if(s.action==='resize') {
      if(!s.width||!s.height)throw new Error('resize requires width and height');
      await page.setViewportSize({width:s.width,height:s.height});
    } else if(s.action==='key')await page.keyboard.press(s.key??'Tab');
    else {
      const loc=page.locator(s.selector??'__missing__').first();
      if(await loc.count()===0)throw new Error('Scenario target not found');
      if(s.action==='hover')await loc.hover({timeout:2000});
      else if(s.action==='focus')await loc.focus({timeout:2000});
      else if(s.action==='click') {
        const safe=await loc.evaluate(el=>!(el.closest('form')||el.closest('a[href]')||el.matches('input,textarea,select,[type=submit]')));
        if(!safe)throw new Error('Unsafe click refused: form or navigation');
        await loc.click({timeout:2000});
      }
    }
    if(s.waitMs)await page.waitForTimeout(s.waitMs);
    await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
    if(protocol==='waapi-seek')await page.evaluate(()=>document.getAnimations().forEach(a=>{if(a.playState!=='paused'){a.pause();a.currentTime=0;}}));
    result.executed=true;result.actualBrowserTimeMs=await page.evaluate(()=>performance.now());
    if(s.expect) {
      result.expected=s.expect;
      const checked=await expectation(page,s.expect,beforeScroll,beforeMedia);
      result.observed=checked.observed;result.assertion=checked.pass?'pass':'fail';
    }
  }catch(e){result.error=String(e);if(s.expect)result.assertion='fail';}
  return result;
}
