import {test} from 'node:test';
import assert from 'node:assert/strict';
import {launchBrowser,newContext} from '../../src/browser/launch.js';
import {loadConfig} from '../../src/capture.js';
import {runScenario} from '../../src/browser/scenarios.js';

test('Removed elements satisfy pure hidden expectations without satisfying missing attribute checks',async()=>{
  const config=await loadConfig('configs/fixture.json'),browser=await launchBrowser(),context=await newContext(browser,config,config.viewports[0]);
  try {
    const page=await context.newPage();await page.setContent('<button id="remove" onclick="this.remove()">Remove</button>');
    const removed=await runScenario(page,{id:'remove',action:'click',selector:'#remove',expect:{selector:'#remove',visible:false}});
    assert.equal(removed.assertion,'pass');assert.equal((removed.observed as any).exists,false);
    assert.equal((await runScenario(page,{id:'visible',action:'time',expect:{selector:'#missing',visible:true}})).assertion,'fail');
    assert.equal((await runScenario(page,{id:'attribute',action:'time',expect:{selector:'#missing',visible:false,attribute:'data-value',value:'yes'}})).assertion,'fail');
  }finally{await context.close();await browser.close();}
});
