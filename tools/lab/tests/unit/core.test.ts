import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import { EvidenceSchema } from '../../src/core/schema.js';
import { hash,safePath,Artifacts,verifyCorpus } from '../../src/core/artifacts.js';
import { splitRules } from '../../src/adapters/ai-site-cloner.js';
import { safeHeaders,publicUrl,normalizeUrl } from '../../src/adapters/webembedding.js';
import { toHeaders,detectBundler } from '../../src/third-party/rever-helpers.js';
import { isAIUrl,installNodeGuard } from '../../src/replay/security.js';
import { transformHtml,remapText,resourcePath,type Variant } from '../../src/reconstruction/builders.js';
import { imageMetrics,stats } from '../../src/evaluate/metrics.js';
import { mediaRange } from '../../src/replay/ranges.js';

test('Video ranges use complete captured bytes and never invent missing segments',()=>{
  const body=Buffer.from('0123456789');
  const range=mediaRange(body,206,'bytes 0-9/10','bytes=3-5');
  assert.equal(range.status,206);assert.equal(range.body.toString(),'345');assert.equal(range.contentRange,'bytes 3-5/10');
  assert.equal(mediaRange(body,206,'bytes 0-9/10',undefined).status,200);
  assert.equal(mediaRange(body,200,undefined,'bytes=-2').body.toString(),'89');
  assert.equal(mediaRange(body,200,undefined,'bytes=10-').status,416);
  const partial=mediaRange(Buffer.from('345'),206,'bytes 3-5/10','bytes=0-');
  assert.equal(partial.body.toString(),'345');assert.equal(partial.contentRange,'bytes 3-5/10');
});

test('Schema refuses captured without artifact and SHA256',()=>{
  assert.equal(EvidenceSchema.safeParse({schemaVersion:1,id:'x',kind:'D01',captureId:'c',pageId:'home',stateId:'s',viewportId:'v',source:{method:'test'},timestampIso:new Date().toISOString(),status:'captured'}).success,false);
  assert.equal(hash('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.throws(()=>safePath(process.cwd(),'../escape'));
});
test('Copied CSS parser exposes media and hover rules',()=>{
  const rules=splitRules('@media(max-width:500px){.cta:hover { color:red; }}');
  assert.equal(rules[0].selector,'.cta:hover');assert.match(rules[0].media,/500px/);assert.match(rules[0].body,/color:red/);
});
test('Copied rever-browser HAR/bundler helpers and webEmbedding header policy',()=>{
  assert.deepEqual(toHeaders({'warning':'a\nb'}),[{name:'warning',value:'a'},{name:'warning',value:'b'}]);
  assert.equal(detectBundler('var __webpack_require__ = 1').name,'webpack');
  assert.equal(detectBundler('import.meta.url').name,'vite');assert.equal(detectBundler('plain()').name,'unknown');
  assert.deepEqual(safeHeaders({'content-type':'text/plain','authorization':'secret','set-cookie':'secret','content-encoding':'gzip','content-length':'2'},true),{'content-type':'text/plain'});
  assert.equal(new URL(publicUrl('https://example.test/?token=abc&size=2')).searchParams.get('token'),'[REDACTED]');
  assert.equal(normalizeUrl('https://example.test/a?b=2&a=1#x'),'https://example.test/a?b=2&a=1');
});
test('AI providers, local inference endpoints and remote Node network are refused',async()=>{
  assert.equal(isAIUrl('https://api.openai.com/v1/responses'),true);assert.equal(isAIUrl('http://127.0.0.1:11434/api/generate'),true);
  assert.equal(isAIUrl('https://generativelanguage.googleapis.com/v1/models'),true);assert.equal(isAIUrl('http://127.0.0.1/api/status'),false);
  installNodeGuard();
  await assert.rejects(async()=>fetch('https://api.openai.com/v1/responses'),/AI_RUNTIME_FORBIDDEN/);
  await assert.rejects(async()=>fetch('https://example.test/'),/NODE_REMOTE_FORBIDDEN/);
});
test('HTML transformations remove script/handlers recursively and preserve source order',()=>{
  const v:Variant={id:'test',builder:'static-snapshot',js:false,css:true,assets:true,har:false,state:false,motion:false};
  const html=transformHtml('<html><body onclick="danger()"><script src="/a.js"></script><template shadowrootmode="open"><script>bad()</script><b>keep</b></template><p>Text</p></body></html>',v);
  assert.doesNotMatch(html,/<script|onclick/);assert.match(html,/<b>keep<\/b>/);assert.match(html,/shadowrootmode="open"/);
  const origin='https://example.test';assert.equal(resourcePath(origin+'/a.js?x=1',origin),'/a.js?x=1');
  assert.equal(remapText('https://example.test/a.js',origin,[{url:origin+'/a.js'} as any]),'/a.js');
});
test('Pixel differences and repetition dispersion are measured',()=>{
  const a=new PNG({width:2,height:2});a.data.fill(255);const b=PNG.sync.read(PNG.sync.write(a));b.data[0]=0;
  const same=imageMetrics(PNG.sync.write(a),PNG.sync.write(a));assert.equal(same.metrics.maeNormalized,0);assert.equal(same.metrics.changedPixels,0);
  assert.ok(imageMetrics(PNG.sync.write(a),PNG.sync.write(b)).metrics.maeNormalized>0);
  assert.deepEqual(stats([1,2,3]),{n:3,median:2,min:1,max:3,iqr:1});
});
