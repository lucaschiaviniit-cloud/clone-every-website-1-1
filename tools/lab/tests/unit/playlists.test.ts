import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptPlaylist } from '../../src/replay/playlists.js';
import { resourcePath } from '../../src/reconstruction/builders.js';
import { isDiscoverableAsset } from '../../src/replay/security.js';

test('Identical HLS bytes adapt per original URL including root-relative keys and cross-origin segments',()=>{
  const body='#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/key.bin"\nsegment.ts\n../next/segment.m4s\nhttps://segments.example.test/v/2.ts\n';
  const origin='https://page.example.test',a=adaptPlaylist(body,'https://cdn.example.test/a/list.m3u8',origin),b=adaptPlaylist(body,'https://cdn.example.test/b/list.m3u8',origin);
  assert.notEqual(a,b);
  assert.ok(a.includes(resourcePath('https://cdn.example.test/a/segment.ts',origin)));
  assert.ok(b.includes(resourcePath('https://cdn.example.test/b/segment.ts',origin)));
  assert.ok(a.includes(`URI="${resourcePath('https://cdn.example.test/key.bin',origin)}"`));
  assert.ok(a.includes(resourcePath('https://segments.example.test/v/2.ts',origin)));
  assert.equal(isDiscoverableAsset('https://cdn.example.test/live/list.m3u8','fetch'),true);
  assert.equal(isDiscoverableAsset('https://cdn.example.test/live/2.ts','fetch'),true);
});
