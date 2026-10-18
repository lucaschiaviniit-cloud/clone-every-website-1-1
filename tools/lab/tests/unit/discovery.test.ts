import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDiscoverableAsset } from '../../src/replay/security.js';

test('Asset discovery follows emitted asset requests without authorizing arbitrary APIs or documents',()=>{
  for(const [url,type] of [
    ['https://cdn.example.test/asset.webp','image'],
    ['https://cdn.example.test/font','font'],
    ['https://cdn.example.test/worker.js','script'],
    ['https://cdn.example.test/scene.glb','fetch'],
    ['https://cdn.example.test/frame.bin','fetch'],
    ['https://cdn.example.test/config.json','xhr'],
  ])assert.equal(isDiscoverableAsset(url,type),true,url);
  for(const [url,type] of [
    ['https://cdn.example.test/unrelated','document'],
    ['https://api.example.test/private-data','fetch'],
    ['https://www.googletagmanager.com/gtm.js','script'],
    ['https://api.openai.com/v1/responses','fetch'],
    ['http://127.0.0.1/private.png','image'],
    ['http://192.168.1.1/private.png','image'],
    ['https://user:password@cdn.example.test/a.js','script'],
  ])assert.equal(isDiscoverableAsset(url,type),false,url);
});
