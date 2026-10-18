#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Generate a project-owned placeholder from colors and geometry only.
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'tools/lab/assets/media/placeholder.mp4');
await mkdir(dirname(output), { recursive: true });
const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
  'color=c=0x17212b:s=720x1280:r=24:d=8', '-vf',
  'drawbox=x=120:y=400:w=480:h=480:color=0x718394:t=fill,fade=t=in:st=0:d=1,fade=t=out:st=7:d=1',
  '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '30', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', '-map_metadata', '-1', output];
const result = spawnSync('ffmpeg', args, { encoding: 'utf8' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || 'FFmpeg failed');
const body = await readFile(output);
const provenance = {
  schemaVersion: 1,
  kind: 'procedural-project-asset',
  license: 'Apache-2.0',
  generator: 'scripts/generate-placeholder-video.mjs',
  source: 'FFmpeg lavfi color source, geometric rectangle and fades; no external media, text, fonts or target footage.',
  sha256: createHash('sha256').update(body).digest('hex'),
  bytes: body.length, durationSeconds: 8, width: 720, height: 1280,
  frameRate: 24, codec: 'h264', audio: false,
  encoderVersion: spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).stdout?.split('\n')[0],
  reproducibility: 'Encoder versions can change encoded bytes; regenerate provenance with the asset.'
};
await writeFile(join(dirname(output), 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ asset: 'tools/lab/assets/media/placeholder.mp4', bytes: body.length, sha256: provenance.sha256 }));
