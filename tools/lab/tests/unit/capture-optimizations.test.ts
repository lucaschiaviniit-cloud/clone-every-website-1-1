import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { changedSelectors } from '../../src/capture-delta.js';
import { CaptureMediaCache,type RecordedResponse } from '../../src/replay/capture-media-cache.js';
import { preflight,failureCategory } from '../../src/browser/preflight.js';
import type { ElementSnapshot } from '../../src/core/schema.js';

test('Indexed snapshot delta preserves first-match semantics, duplicates, tags and changed fields',()=>{
  const previous=Array.from({length:1000},(_,i)=>({selector:'#n'+(i%200),tag:i%2?'p':'div',attributes:{id:String(i)},styles:{opacity:'1'},box:{x:i,y:0,width:1,height:1}} as unknown as ElementSnapshot));
  const current=structuredClone(previous);current[10].styles.opacity='0';current[20].tag='canvas';current[30].box.y=1;
  current.push({...current[0],selector:'#new'});
  const expected=current.filter(e=>{const before=previous.find(p=>p.selector===e.selector&&p.tag===e.tag);return !before||JSON.stringify([before.attributes,before.styles,before.box])!==JSON.stringify([e.attributes,e.styles,e.box]);}).map(e=>e.selector);
  assert.deepEqual(changedSelectors(previous,current),expected);
});

const request=(url='https://fixture.test/movie.mp4',headers:Record<string,string>={},type='media')=>({url:()=>url,headers:()=>headers,resourceType:()=>type});
const response=(body='0123456789',headers:Record<string,string>={'cache-control':'public, max-age=60'},status=200):RecordedResponse=>({status:()=>status,statusText:()=>status===206?'Partial Content':'OK',headers:()=>headers,body:async()=>Buffer.from(body)});

test('Media cache retains exact bytes/range, distinguishes query, headers and context, and expires',async()=>{
  const cache=new CaptureMediaCache(),key=cache.key(request(undefined,{range:'bytes=0-'}))!;
  const headers={'cache-control':'public, max-age=60','content-range':'bytes 0-9/10','content-length':'10'};
  await cache.store(key,response('0123456789',headers,206),100,1000);
  assert.equal(cache.get(key,1001)?.body.toString(),'0123456789');assert.equal(cache.get(key,1001)?.status,206);
  assert.equal(cache.get(key,1001)?.headers['content-range'],'bytes 0-9/10');
  assert.notEqual(key,cache.key(request(undefined,{range:'bytes=3-5'})));
  assert.notEqual(key,cache.key(request('https://fixture.test/movie.mp4?v=2',{range:'bytes=0-'})));
  assert.notEqual(key,cache.key(request(undefined,{range:'bytes=0-',accept:'video/webm'})));
  assert.equal(new CaptureMediaCache().get(key,1001),undefined);assert.equal(cache.get(key,61000),undefined);
});

test('Media cache bypasses private, mutable, stale, compressed, conditional and incomplete responses',async()=>{
  const cache=new CaptureMediaCache(),key=cache.key(request())!;
  for(const headers of ([{cookie:'a=b'},{authorization:'Bearer private'},{'if-range':'etag'},{'cache-control':'no-cache'},{'cache-control':'max-age=0'},{'if-none-match':'etag'}] as Record<string,string>[]))assert.equal(cache.key(request(undefined,headers)),undefined);
  assert.equal(cache.key(request(undefined,{},'fetch')),undefined);
  for(const headers of ([ {},{'cache-control':'no-store, max-age=60'},{'cache-control':'private, max-age=60'},{'cache-control':'no-cache, max-age=60'},{'cache-control':'immutable'},{'cache-control':'max-age=60','set-cookie':'private'}, {'cache-control':'max-age=60',vary:'accept, *'}, {'cache-control':'max-age=60','content-encoding':'gzip'}, {'cache-control':'max-age=60',age:'61'}, {'cache-control':'max-age=60',date:'Thu, 01 Jan 1970 00:00:00 GMT'}] as Record<string,string>[])) {
    await cache.store(key,response('0123456789',headers),100,120000);assert.equal(cache.get(key,120001),undefined,JSON.stringify(headers));
  }
  await cache.store(key,response('345',{'cache-control':'max-age=60','content-range':'bytes 3-5/10'},206),100,1000);assert.equal(cache.get(key,1001),undefined);
  await cache.store(key,response('0123456789',{'cache-control':'max-age=60','content-length':'11'}),100,1000);assert.equal(cache.get(key,1001),undefined);
  for(const control of ['s-max-age=60','max-age=60garbage','max-age=60, max-age=0']) {
    await cache.store(key,response('0123456789',{'cache-control':control}),100,1000);assert.equal(cache.get(key,1001),undefined);
  }
});

test('Media cache respects its memory bound and never stores oversized bodies',async()=>{
  const cache=new CaptureMediaCache(10);
  await cache.store('a',response('123456'),100,1000);await cache.store('b',response('abcdef'),100,1000);
  assert.equal(cache.get('a',1001),undefined);assert.equal(cache.get('b',1001)?.body.toString(),'abcdef');
  await cache.store('c',response('oversized-body'),100,1000);assert.equal(cache.get('c',1001),undefined);
});

test('Preflight classifies space failure before launching a browser or opening a server',async t=>{
  const out=await mkdtemp(join(tmpdir(),'clone-preflight-'));t.after(()=>rm(out,{recursive:true,force:true}));
  const report=await preflight(out,Number.MAX_SAFE_INTEGER);
  assert.equal(report.status,'failed');assert.equal(report.failure.category,'space');assert.equal(report.targetContacted,false);
  assert.deepEqual(report.checks.map((c:any)=>c.name),['space']);
  assert.deepEqual(JSON.parse(await readFile(join(out,'preflight.json'),'utf8')),report);
  assert.equal(failureCategory(new Error('EPERM bind')),'permissions');assert.equal(failureCategory(new Error("Executable doesn't exist")),'dependencies');
});
