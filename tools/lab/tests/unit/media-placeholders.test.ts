import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/capture.js';
import { ConfigSchema } from '../../src/core/schema.js';
import { placeholderKind,loadPlaceholderVideo } from '../../src/replay/media-placeholders.js';
import { spawnSync } from 'node:child_process';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('Media mode is explicit, keeps direct engine compatibility and rejects invalid configuration',async()=>{
  const config=await loadConfig('configs/fixture.json');
  assert.equal(config.mediaMode,'original');
  assert.equal(placeholderKind('https://example.test/photo.jpg','image',config),null);
  assert.throws(()=>ConfigSchema.parse({...config,mediaMode:'stock'}));
  assert.throws(()=>ConfigSchema.parse({...config,mediaPlaceholders:{imageDimensions:{x:{width:0,height:10}}}}));
});
test('Placeholder classification covers responsive/optimized images and file videos, preserving essential assets',async()=>{
  const config={...await loadConfig('configs/fixture.json'),mediaMode:'placeholders' as const};
  for(const [url,type,expected] of [
    ['/photo.jpg','image','image'],['/_next/image?url=%2Fphoto.avif&w=640&q=75','image','image'],
    ['/_next/image?url=%2Flogo-dark.png&w=640','image',null],['/clip.mp4','media','video'],
    ['/texture.webp','fetch','image'],['/logo.svg','image',null],['/favicon.ico','image',null],
    ['/icons/nav.png','image',null],['/font.woff2','font',null],['/worker.ts','script',null],
    ['/data.json','fetch',null],['/voice.mp3','media',null],['/scene.glb','fetch',null],
    ['/stream.m3u8','fetch','unsupported-stream'],['/segment.m4s','fetch','unsupported-stream'],
  ] as const)assert.equal(placeholderKind('https://example.test'+url,type,config),expected,url);
  config.mediaPlaceholders={preserveUrls:['https://example.test/photo.jpg']};
  assert.equal(placeholderKind('https://example.test/photo.jpg','image',config),null);
});
test('Shared video is bundled and loaded once without networking',async()=>{
  const [one,two]=await Promise.all([loadPlaceholderVideo(),loadPlaceholderVideo()]);
  const provenance=JSON.parse(await readFile('assets/media/provenance.json','utf8'));
  assert.equal(one,two);assert.equal(one.length,provenance.bytes);assert.equal(one.subarray(4,8).toString(),'ftyp');
  assert.equal(createHash('sha256').update(one).digest('hex'),provenance.sha256);
});

test('Wrapper preparation records the explicit original or placeholder media choice',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'media-placeholder-config-'));
  try {
    for(const mode of ['placeholders','original']) {
      const out=join(dir,mode),args=[resolve('../../scripts/clone.mjs'),'https://example.test/','--out',out,'--prepare-only','--media',mode];
      const result=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
      const config=JSON.parse(await readFile(join(out,'capture-config.json'),'utf8')),state=JSON.parse(await readFile(join(out,'state.json'),'utf8'));
      assert.equal(config.mediaMode,mode);assert.equal(state.mediaMode,config.mediaMode);assert.equal(state.sourceReconstructionStarted,false);
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});
