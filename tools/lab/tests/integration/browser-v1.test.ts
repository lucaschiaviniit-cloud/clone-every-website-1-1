import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { loadConfig } from '../../src/capture.js';
import { launchBrowser,newContext } from '../../src/browser/launch.js';
import { runScenario,settle } from '../../src/browser/scenarios.js';
import { ConfigSchema } from '../../src/core/schema.js';
import { snapshot } from '../../src/extractors/snapshot.js';
import { localServer } from '../../src/replay/local-server.js';

async function withPage(html:string,run:(page:Page)=>Promise<void>) {
  const server=await localServer(async(_req,res)=>{res.setHeader('content-type','text/html');res.end(html);});
  const browser=await launchBrowser();
  const config=await loadConfig('configs/fixture.json');
  const context=await newContext(browser,config,config.viewports[0]);
  try{const page=await context.newPage();await page.goto(server.origin+'/');await run(page);}
  finally{await context.close();await browser.close();await server.close();}
}

test('Real wheel detects overlay lock and recovers after close, with resize and return scroll', {timeout:30000},async()=>{
  await withPage(`<style>body{margin:0;height:5000px;overflow:hidden}#overlay{position:fixed;inset:0;background:white}</style><div id="overlay"><button id="close">Close</button></div><script>document.querySelector('#close').onclick=()=>{document.querySelector('#overlay').hidden=true;document.body.style.overflow='auto'}</script>`,async page=>{
    const blocked=await runScenario(page,{id:'locked',action:'wheel',deltaY:500,waitMs:50,expect:{scrollChanged:true}});
    assert.equal(blocked.executed,true);assert.equal(blocked.assertion,'fail');
    const close=await runScenario(page,{id:'close',action:'click',selector:'#close',expect:{selector:'#overlay',visible:false}});
    assert.equal(close.assertion,'pass');
    const wheel=await runScenario(page,{id:'unlocked',action:'wheel',deltaY:500,waitMs:50,expect:{scrollChanged:true}});
    assert.equal(wheel.assertion,'pass');
    const back=await runScenario(page,{id:'back',action:'wheel',deltaY:-300,waitMs:50,expect:{scrollChanged:true}});
    assert.equal(back.assertion,'pass');
    await runScenario(page,{id:'top',action:'scroll',progress:0});assert.equal(await page.evaluate(()=>scrollY),0);
    const resize=await runScenario(page,{id:'resize',action:'resize',width:390,height:800});
    assert.equal(resize.executed,true);assert.deepEqual(page.viewportSize(),{width:390,height:800});
  });
});

test('Snapshot distinguishes ancestor opacity, media presence and advisory blank canvas', {timeout:30000},async()=>{
  await withPage(`<div style="opacity:0"><img id="transparent" width="20" height="20" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Crect width='20' height='20' fill='red'/%3E%3C/svg%3E"></div><canvas id="blank" width="20" height="20"></canvas><canvas id="painted" width="20" height="20"></canvas><script>const c=document.querySelector('#painted').getContext('2d');c.fillStyle='red';c.fillRect(0,0,10,20)</script>`,async page=>{
    await page.locator('#transparent').evaluate((img:HTMLImageElement)=>img.decode());
    const s=await snapshot(page,200),image=s.elements.find(el=>el.id==='transparent')!;
    assert.equal(image.visible,false);assert.equal(image.effectiveOpacity,0);
    const media=s.media!.find(item=>item.selector==='#transparent')!;
    assert.equal(media.ready,true);assert.equal(media.visible,false);assert.equal(media.decoded,'not-observed');
    const hidden=await runScenario(page,{id:'hidden',action:'time',atMs:0,expect:{selector:'#transparent',visuallyVisible:true,mediaReady:true}});
    assert.equal(hidden.assertion,'fail');
    assert.equal(s.canvases.find(c=>c.selector==='#blank').appearance.transparent,true);
    assert.equal(s.canvases.find(c=>c.selector==='#blank').appearance.advisory,true);
    assert.equal(s.canvases.find(c=>c.selector==='#painted').appearance.transparent,false);
    assert.equal(s.canvases.find(c=>c.selector==='#painted').appearance.uniform,false);
    const truncated=await snapshot(page,1);assert.equal(truncated.truncated,true);assert.ok(truncated.limitations?.some(text=>text.includes('truncated')));
  });
});

test('Stationary media does not pass videoPlaying solely because paused is false', {timeout:30000},async()=>{
  await withPage('<video id="stalled"></video>',async page=>{
    // A ready but stalled player is a synthetic fixture for the false-positive case.
    await page.locator('#stalled').evaluate(el=>Object.defineProperties(el,{paused:{get:()=>false},readyState:{get:()=>4}}));
    const stalled=await runScenario(page,{id:'stalled',action:'time',atMs:0,waitMs:50,expect:{selector:'#stalled',videoPlaying:true}});
    assert.equal(stalled.executed,true);assert.equal(stalled.assertion,'fail');
    assert.equal((stalled.observed as any).video.advanced,false);
  });
});

test('Playing video requires observed advancement from a live local canvas stream', {timeout:30000},async()=>{
  await withPage('<canvas id="source" width="20" height="20"></canvas><video id="playing" muted></video>',async page=>{
    await page.evaluate(async()=>{
      const canvas=document.querySelector<HTMLCanvasElement>('#source')!,video=document.querySelector<HTMLVideoElement>('#playing')!;
      const context=canvas.getContext('2d')!;
      const draw=()=>{context.fillStyle=`rgb(${Math.floor(performance.now())%255},0,0)`;context.fillRect(0,0,20,20);requestAnimationFrame(draw);};draw();
      video.srcObject=canvas.captureStream(30);await video.play();
    });
    const playing=await runScenario(page,{id:'playing',action:'time',atMs:0,waitMs:150,expect:{selector:'#playing',videoPlaying:true}});
    assert.equal(playing.assertion,'pass');assert.equal((playing.observed as any).video.advanced,true);
  });
});

test('Adaptive readiness is local, bounded and reports fallback without altering natural time origin', {timeout:30000},async()=>{
  await withPage('<style>@keyframes spin{to{transform:rotate(360deg)}}#moving{animation:spin 1s infinite}#stable{width:20px;height:20px}</style><div id="stable"></div><div id="moving">Continuous animation</div>',async page=>{
    const config=await loadConfig('configs/fixture.json');config.settleMs=0;delete config.readySelector;
    config.readiness={selectors:['#stable'],stableMs:20,pollMs:10,timeoutMs:500,fallback:'fail'};
    const ready=await settle(page,config);assert.equal(ready.status,'ready');assert.equal(ready.mode,'adaptive');
    const first=await runScenario(page,{id:'origin',action:'time',atMs:0},'natural-sampled');
    await settle(page,config);
    const later=await runScenario(page,{id:'later',action:'time',atMs:120},'natural-sampled');
    assert.ok((later.motion as any).actualElapsedMs>=119);assert.equal((first.motion as any).nominalTimeMs,0);
    config.readiness={selectors:['#absent'],timeoutMs:30,pollMs:10,fallback:'fixed'};
    const fallback=await settle(page,config);assert.equal(fallback.status,'fallback');assert.ok(fallback.reason);
    config.readiness.fallback='fail';await assert.rejects(()=>settle(page,config),/READINESS_FAILED/);
    delete config.readiness;const legacy=await settle(page,config);assert.equal(legacy.mode,'fixed');
  });
});

test('Touch swipes use browser input and preserve scenario metadata through schema', {timeout:30000},async()=>{
  const config=await loadConfig('configs/fixture.json');
  config.scenarios=[{id:'gesture',action:'swipe',from:{x:100,y:300},to:{x:100,y:50},steps:5,dependsOn:['open'],sections:['hero'],sharedSystems:['scroll']}];
  const parsed=ConfigSchema.parse(config);assert.deepEqual(parsed.scenarios[0].dependsOn,['open']);
  await withPage('<div style="height:3000px">Touch test</div><script>document.addEventListener("touchstart",()=>document.documentElement.dataset.touched="yes")</script>',async page=>{
    const gesture=await runScenario(page,{id:'gesture',action:'swipe',from:{x:100,y:300},to:{x:100,y:50},steps:5,expect:{selector:'html',attribute:'data-touched',value:'yes'}});
    assert.equal(gesture.executed,true);assert.equal(gesture.assertion,'pass');
  });
});
