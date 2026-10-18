#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { readdir, readFile, lstat, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const excluded = new Set(['.git', 'node_modules', '.tmp', '.validation', 'runs', 'captures', 'outputs', 'dist', 'playwright-report', 'test-results']);
const files = [], errors = [];
async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isSymbolicLink()) { errors.push(`Symlink must not enter release: ${relative(root, path)}`); continue; }
    if (item.isDirectory()) { if (!excluded.has(item.name)) await walk(path); continue; }
    if (item.isFile()) files.push(path);
  }
}
await walk(root);
const required = ['LICENSE', 'NOTICE', 'README.md', 'SKILL.md', 'VALIDATION.md',
  'tools/lab/package-lock.json', 'tools/lab/licenses/inter-OFL.txt',
  'tools/lab/licenses/ai-site-cloner-LICENSE', 'tools/lab/licenses/webEmbedding-LICENSE',
  'tools/lab/licenses/rever-browser-LICENSE', 'tools/lab/licenses/rever-browser-NOTICE'];
for (const path of required) {
  try { await access(join(root, path)); } catch { errors.push(`Missing required file: ${path}`); }
}
let links = 0;
for (const path of files) {
  const name = relative(root, path);
  if (/(^|\/)(?:\.DS_Store|Thumbs\.db|\.env(?:\..*)?)$/.test(name)) errors.push(`Private/generated file: ${name}`);
  if ((await lstat(path)).size > 10 * 1024 * 1024) errors.push(`Review unexpectedly large release file: ${name}`);
  if (!['.md', '.mjs', '.ts', '.json', '.yml', '.yaml', '.txt'].includes(extname(path))) continue;
  const body = await readFile(path, 'utf8');
  if (/\/(?:Users|home)\/[A-Za-z0-9_.-]+\//.test(body)) errors.push(`Personal absolute path: ${name}`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(body)) errors.push(`Private key material: ${name}`);
  if (extname(path) !== '.md') continue;
  for (const match of body.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, '').split(/\s+"/)[0];
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const dest = resolve(path, '..', decodeURIComponent(target.split('#')[0]));
    if (dest !== root && !dest.startsWith(root + sep)) { errors.push(`Link escapes release: ${name} -> ${target}`); continue; }
    try { await access(dest); links++; } catch { errors.push(`Broken local link: ${name} -> ${target}`); }
  }
}
const media = JSON.parse(await readFile(join(root, 'tools/lab/assets/media/provenance.json'), 'utf8'));
const video = await readFile(join(root, 'tools/lab/assets/media/placeholder.mp4'));
if (media.kind !== 'procedural-project-asset' || media.license !== 'Apache-2.0') errors.push('Placeholder provenance is not the procedural release asset');
if (media.bytes !== video.length || media.sha256 !== createHash('sha256').update(video).digest('hex')) errors.push('Placeholder bytes do not match provenance');
if (video.subarray(4, 8).toString() !== 'ftyp') errors.push('Placeholder is not an MP4');
const lock = JSON.parse(await readFile(join(root, 'tools/lab/package-lock.json'), 'utf8'));
const inventory = JSON.parse(await readFile(join(root, 'docs/dependencies.json'), 'utf8'));
const expected = Object.entries(lock.packages).filter(([path]) => path).map(([path, pkg]) => ({ path, version: pkg.version, license: pkg.license ?? 'UNKNOWN', integrity: pkg.integrity, optional: pkg.optional ?? false, dev: pkg.dev ?? false }));
if (JSON.stringify(inventory.packages) !== JSON.stringify(expected)) errors.push('Dependency inventory does not match lockfile');
if (expected.some(pkg => pkg.license === 'UNKNOWN')) errors.push('A dependency has undeclared license metadata');
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(JSON.stringify({ status: 'passed', files: files.length, localLinks: links, lockedPackages: expected.length, placeholderBytes: video.length, note: 'Checks package integrity and selected disclosure patterns; not a complete security or legal audit.' }));
