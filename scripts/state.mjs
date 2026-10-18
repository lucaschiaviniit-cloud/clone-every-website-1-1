import { readFile, writeFile, readdir, lstat, rename } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const skillRoot = resolve(import.meta.dirname, '..');
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const within = (parent, child) => {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
};
export async function loadState(runDirectory) {
  if (!runDirectory) throw new Error('--run is required');
  const run = resolve(runDirectory), path = resolve(run, 'state.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  if (state.schemaVersion !== 1 || !state.targetUrl || !state.captureDir || !state.baselineDir) throw new Error('Unsupported or incomplete run state');
  if (!within(run, state.captureDir) || !within(run, state.baselineDir)) throw new Error('Capture and baseline must stay inside this run');
  return { run, path, state };
}
export async function inventory(directory) {
  const base = resolve(directory), entries = [];
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = resolve(folder, entry.name), stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`Symlink is not allowed in baseline inventory: ${path}`);
      if (stat.isDirectory()) await visit(path);
      else if (stat.isFile()) entries.push({ path: relative(base, path).split(sep).join('/'), sha256: sha256(await readFile(path)) });
      else throw new Error(`Unsupported baseline entry: ${path}`);
    }
  }
  await visit(base);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!entries.length) throw new Error('Baseline is empty');
  return { entries, sha256: sha256(JSON.stringify(entries)) };
}
export async function currentIdentity(state) {
  const engine = resolve(skillRoot, 'tools/lab');
  const processResult = spawnSync(process.execPath, [resolve(engine, 'node_modules/tsx/dist/cli.mjs'), resolve(engine, 'src/cli.ts'), 'verify', '--capture', state.captureDir], {
    cwd: engine, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
  });
  if (processResult.error) throw processResult.error;
  if (processResult.status !== 0) throw new Error(`Corpus verification failed: ${(processResult.stderr || processResult.stdout).trim()}`);
  const verified = JSON.parse(processResult.stdout.trim());
  if (verified.status !== 'complete' || !verified.corpusSha256) throw new Error('Capture is not complete');
  const baseline = await inventory(state.baselineDir);
  const manifest = JSON.parse(await readFile(resolve(state.captureDir, 'manifest.json'), 'utf8'));
  if(manifest.scope?.kind==='fusion-selective'||manifest.config?.selective)throw new Error('Selective Fusion evidence cannot authorize Clone source reconstruction');
  if (manifest.targetUrl !== state.targetUrl) throw new Error('Run target differs from captured target');
  const engineFiles = [];
  for (const directory of ['src', 'configs', 'assets']) {
    engineFiles.push(...(await inventory(resolve(engine, directory))).entries.map(entry => ({ ...entry, path: `${directory}/${entry.path}` })));
  }
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json']) engineFiles.push({ path: file, sha256: sha256(await readFile(resolve(engine, file))) });
  engineFiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const engineSha256 = sha256(JSON.stringify({ nodeVersion: process.versions.node, files: engineFiles }));
  return { corpusSha256: verified.corpusSha256, baselineSha256: baseline.sha256, engineSha256, baselineFiles: baseline.entries.length };
}
export async function verifyApproval(state) {
  if (!['approved_for_source', 'source_in_progress', 'source_verified'].includes(state.phase) || !state.approval) throw new Error('Source reconstruction requires explicit approval of this local build');
  const identity = await currentIdentity(state), approval = state.approval;
  if (!approval.confirmationText?.trim() || sha256(approval.confirmationText) !== approval.confirmationSha256) throw new Error('Approval confirmation is missing or altered');
  if (approval.targetUrl !== state.targetUrl || approval.baselineDir !== resolve(state.baselineDir) || approval.corpusSha256 !== identity.corpusSha256 || approval.baselineSha256 !== identity.baselineSha256) throw new Error('Approval is stale: target/corpus/baseline changed; user review is required again');
  if (approval.engineSha256 !== identity.engineSha256) throw new Error('Approval is stale: replay engine or Node version changed; user review is required again');
  return identity;
}
export async function writeState(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, path);
  const sourcePhase = ['approved_for_source', 'source_in_progress', 'source_verified'].includes(state.phase);
  const handoff = `# Current run handoff\n\nTarget: ${state.targetUrl}\nPhase: ${state.phase}\n\nRun state (authoritative): ${path}\nCapture: ${state.captureDir}\nBaseline: ${state.baselineDir}\nCorpus SHA256: ${state.corpusSha256}\nBaseline SHA256: ${state.baselineSha256}\nPreview URL: ${state.preview?.url ?? 'not recorded'}\nSource workspace: ${state.sourceDir ?? 'not created'}\n\n${sourcePhase ? 'The explicit accuracy decision is recorded in state.json. Recheck it with scripts/review.mjs --check before resuming; a changed target/corpus/baseline invalidates approval. Read the source-reconstruction reference. Source completion and fidelity have not been established merely by recording approval or creating a workspace.' : 'STOP before source reconstruction. Show the working local build and its limitations, then obtain the user accuracy decision for these exact artifacts.'}\n\nUse only this run and the skill references for the current phase. Do not load previous target examples, old memories, benchmark solutions or unrelated projects. Preserve the approved baseline and record actual checks, missing behavior and the next action. If this handoff and state disagree after an interrupted write, verify and use state.json as the authoritative record.\n`;
  const v1=`\nV1 index: ${state.analysisDir??'not indexed'}\nMetrics: ${resolve(path,'..','metrics','summary.md')} (read only for a measurement review)\nSource verification: ${state.verification?.reportFile??'not finalized'}\nNext: ${state.phase==='source_verified'?'Recheck the recorded source report before delivering changed files.':sourcePhase?'Use current-run dossiers, reconstruct editable components, compare with verify-source.mjs.':'Present the local replay for the user accuracy decision.'}\n`;
  await writeFile(resolve(path, '..', 'AGENT_HANDOFF.md'), handoff+v1);
}
