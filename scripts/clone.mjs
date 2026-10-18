#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createServer } from 'node:net';
import { openRecorder } from './telemetry.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lab = join(repo, 'tools', 'lab');
let values, positionals;
try { ({ values, positionals } = parseArgs({ allowPositionals: true, options: {
  help: { type: 'boolean', short: 'h' }, out: { type: 'string' },
  config: { type: 'string' }, 'prepare-only': { type: 'boolean' },
  'asset-host': { type: 'string', multiple: true }, port: { type: 'string' },
  'metrics-mode': { type: 'string' },
  media: { type: 'string' },
} })); } catch (error) { console.error(`${error.message}\nUse --help for options.`); process.exit(1); }
if (values.help) {
  console.log(`Usage: node scripts/clone.mjs <page-url> [--out runs/name] [--config config.json]
       [--asset-host cdn.example.test] [--port N] [--prepare-only]

Phase 1: fresh GET-only capture -> integrity-checked local frontend replay -> STOP for user review.
Phase 2: agents reconstruct editable components ONLY after explicit user approval of that baseline.

--prepare-only writes a target-derived config, state and handoff without browser, network or dependencies.
--config adds target-specific safe menu/hover/focus/scroll scenarios and capture settings.
--asset-host permits an additional page asset/data host; repeat as needed.
--port chooses the preview port; a free loopback port is proposed when omitted.
--metrics-mode off|minimum|standard|diagnostic (minimum by default); no extra model calls.
--media original|placeholders is required unless mediaMode is explicit in --config.
The agent asks for this choice before capture; this CLI never silently chooses placeholders.
Placeholders skip original photos/videos and use neutral images plus one bundled video.
SVG/icons/fonts remain original. Layout/interactions must still be checked; original media timing/content is excluded.
Default discovery includes page-requested script/CSS/image/font/media and asset-file fetches.
Unlisted third-party API endpoints, tracking, POST, WebSockets and AI calls remain blocked.
Default load/scroll scenarios provide PARTIAL interaction coverage. No target is bundled.

Install local engine dependencies first: npm ci --prefix tools/lab
Install Chromium once: npm --prefix tools/lab run setup:browser
No paid API key or competing cloning tool is used. This command does not generate editable source.`);
  process.exit(0);
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function json(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + '\n'); }
async function inventory(root) {
  const files = [];
  async function walk(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isSymbolicLink()) throw new Error('Baseline symlinks are not supported');
      if (item.isDirectory()) await walk(path);
      else if (item.isFile()) files.push({ path: relative(root, path).replaceAll('\\', '/'), sha256: sha256(await readFile(path)) });
    }
  }
  await walk(root);
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function quote(value) { return process.platform === 'win32' ? "'" + value.replaceAll("'", "''") + "'" : "'" + value.replaceAll("'", "'\"'\"'") + "'"; }
function run(command, args) {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd: lab, stdio: 'inherit', shell: false, windowsHide: true });
    child.once('error', fail);
    child.once('exit', (code, signal) => code === 0 ? ok() : fail(new Error(`Deterministic engine exited ${code ?? signal}`)));
  });
}
async function availablePort() {
  const server = createServer();
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const port = server.address().port;
  await new Promise((ok, fail) => server.close(error => error ? fail(error) : ok()));
  return port;
}

let state, out, telemetry;
try {
  if (positionals.length !== 1) throw new Error('Supply exactly one page URL; use --help for options.');
  const target = new URL(positionals[0]);
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.hash) throw new Error('Use an HTTP(S) page URL without credentials or fragment.');
  if ([...target.searchParams.keys()].some(k => /password|passwd|token|secret|session|api[_-]?key|access[_-]?key|email/i.test(k))) throw new Error('Sensitive URL parameters cannot be captured.');
  const defaults = JSON.parse(await readFile(join(lab, 'configs', 'capture.json'), 'utf8'));
  const overrides = values.config ? JSON.parse(await readFile(resolve(values.config), 'utf8')) : {};
  const mediaMode=values.media??overrides.mediaMode;
  if(mediaMode===undefined)throw new Error('MEDIA_CHOICE_REQUIRED: Ask the user for a faithful copy with original assets or photo/video placeholders, then pass --media original|placeholders. No capture was started.');
  if(!['original','placeholders'].includes(mediaMode))throw new Error('--media must be placeholders or original');
  let port = values.port !== undefined ? Number(values.port) : 4173;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be an integer between 1 and 65535.');
  const slug = (target.hostname + target.pathname).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').slice(0, 90);
  out = resolve(values.out ?? join(process.cwd(), 'runs', `${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  await mkdir(out, { recursive: true });
  if ((await readdir(out)).length) throw new Error('Output directory must be empty. Use a new --out to preserve existing capture/approval.');
  telemetry = openRecorder(out,{mode:values['metrics-mode']??'minimum'});
  telemetry.event('run.start',{scope:'capture-to-delivery',metadata:{node:process.version}});
  if(overrides.selective)throw new Error('Use Design Fusion selective capture; clone-site requires a complete replay baseline.');
  const hosts = [...new Set([target.hostname, ...(overrides.allowedHosts ?? []), ...(values['asset-host'] ?? [])])];
  for (const host of hosts) {
    const parsed = new URL('https://' + host);
    if (parsed.host !== host || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error(`Invalid --asset-host: ${host}`);
  }
  const config = { ...defaults, ...overrides, mediaMode, allowedHosts: hosts, ownershipAuthorization: {
    source: 'User-supplied page URL through clone-site CLI',
    statement: `Read-only acquisition requested for ${target.href}; this records a capture request, not an ownership claim or publication authorization.`,
    recordedAt: new Date().toISOString(),
  } };
  const configPath = join(out, 'capture-config.json');
  const captureDir = join(out, 'corpus');
  const baselineDir = join(captureDir, 'replays', 'v2');
  const tsx = join(lab, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const cli = join(lab, 'src', 'cli.ts');
  const previewArgs = [tsx, cli, 'serve', '--capture', captureDir, '--variant', 'v2', '--port', String(port)];
  state = { schemaVersion: 1, targetUrl: target.href, phase: 'prepared', createdAt: new Date().toISOString(),
    captureDir, baselineDir, configPath, corpusSha256: null, baselineSha256: null,
    preview: { port, url: `http://127.0.0.1:${port}${target.pathname}${target.search}`, command: ['node', ...previewArgs.map(quote)].join(' ') },
    sourceReconstructionStarted: false, approval: null,
    interactionCoverage: config.scenarios.some(s => ['hover', 'focus', 'click', 'key','wheel','swipe','resize'].includes(s.action)) ? 'configured-scenarios-only' : 'partial-load-and-scroll-only',
    metricsMode:values['metrics-mode']??'minimum',
    mediaMode,
    analysisDir:join(out,'analysis'),
  };
  await json(configPath, config);
  await json(join(out, 'state.json'), state);
  const handoff = () => `# Local frontend review handoff\n\nTarget: ${state.targetUrl}\nPhase: ${state.phase}\n\nThis run is phase 1: deterministic acquisition and original frontend replay. It is NOT independently reconstructed editable website source. No source agent may start yet.\n\nCorpus: ${captureDir}\nCorpus SHA256: ${state.corpusSha256 ?? 'not captured'}\nBaseline: ${baselineDir}\nBaseline SHA256: ${state.baselineSha256 ?? 'not built'}\nMedia mode: ${state.mediaMode}; placeholders intentionally replace original photo/video content and timing.\nInteraction coverage: ${state.interactionCoverage}\n\nPreview command:\n\n\`\`\`\n${state.preview.command}\n\`\`\`\n\nPreview URL: ${state.preview.url}\n\nBefore requesting user review, inspect missing assets, errors, configured UI states and responsive layout. Iterate phase 1 if necessary; keep measured natural clock variation distinct from structural errors. Load/scroll defaults do not verify hover, menus, focus, WebGL internals or every frame. The asset inventory includes observed bodies only, with per-file hashes; no inferred backend data.\n\nSTOP after showing the local baseline. Only an explicit user confirmation that THIS baseline is sufficiently accurate permits phase 2. Record that confirmation with scripts/review.mjs; approval must bind a freshly verified corpus and baseline file inventory. Any changed bytes invalidate it.\n\nAfter valid approval, scripts/workspace.mjs prepares a separate source workspace. Agents must analyze only the approved local corpus/build plus generic technique references, then create human-editable components and compare against the approved baseline. Do not reuse captured application bundles as the reconstructed application runtime. Preserve asset/CSS/shader provenance. No previous targets or benchmark examples are inputs.\n`;
  await writeFile(join(out, 'AGENT_HANDOFF.md'), handoff()+`\nV1 index: ${state.analysisDir}\nRead references/v1-workflow.md for on-demand dossiers. Metrics are outside the corpus under metrics/.\n`);
  if (values['prepare-only']) {
    telemetry.event('run.end',{outcome:'prepared-only'});await telemetry.summarize();
    console.log(JSON.stringify({ status: 'prepared', runDir: out, targetUrl: state.targetUrl, phase: state.phase, browserStarted: false, networkUsed: false, sourceReconstructionStarted: false }, null, 2));
    process.exit(0);
  }
  try { await access(tsx); } catch { throw new Error('Engine dependencies missing. Run npm ci --prefix tools/lab, then npm --prefix tools/lab run setup:browser.'); }
  state.phase='preflight';await json(join(out,'state.json'),state);
  await telemetry.span('preflight','check local runtime',()=>run(process.execPath,[tsx,cli,'preflight','--out',out]));
  const preflight=JSON.parse(await readFile(join(out,'preflight.json'),'utf8'));
  if(preflight.status!=='passed')throw new Error('Preflight execution receipt missing or failed');
  if(values.port===undefined) {
    port=await availablePort();state.preview.port=port;previewArgs[previewArgs.length-1]=String(port);
    state.preview.url=`http://127.0.0.1:${port}${target.pathname}${target.search}`;
    state.preview.command=['node',...previewArgs.map(quote)].join(' ');
  }
  state.phase = 'capturing'; await json(join(out, 'state.json'), state);
  await telemetry.span('capture','acquire page',()=>run(process.execPath, [tsx, cli, 'capture', '--url', target.href, '--config', configPath, '--out', captureDir]));
  await telemetry.span('replay','build V2',()=>run(process.execPath, [tsx, cli, 'build', '--capture', captureDir,'--variant','v2']));
  state.phase='checking_replay';await json(join(out,'state.json'),state);
  await telemetry.span('verification','check replay startup',()=>run(process.execPath,[tsx,cli,'replay-check','--capture',captureDir,'--out',join(out,'replay-checks')]));
  const startup=JSON.parse(await readFile(join(out,'replay-checks/report.json'),'utf8'));
  const built=await readFile(join(baselineDir,'build.json'));
  const captured=JSON.parse(await readFile(join(captureDir,'manifest.json'),'utf8'));
  if(startup.status!=='passed'||startup.corpusSha256!==captured.corpusSha256||startup.buildSha256!==sha256(built))throw new Error('Replay startup receipt missing, failed or stale');
  state.startupCheck={report:join(out,'replay-checks/report.json'),sha256:sha256(await readFile(join(out,'replay-checks/report.json'))),requiresReview:startup.requiresReview};
  await telemetry.span('analysis','inventory and index',()=>run(process.execPath,[tsx,cli,'inventory','--capture',captureDir,'--out',state.analysisDir]));
  const manifest = JSON.parse(await readFile(join(captureDir, 'manifest.json'), 'utf8'));
  const {ownershipAuthorization,...scopeConfig}=config;
  telemetry.event('run.metadata',{metadata:{caseId:sha256(target.href),scopeId:sha256(JSON.stringify(scopeConfig)),mediaMode,placeholderResponses:manifest.resources.filter(r=>r.substitution).length,placeholderUniqueBodies:new Set(manifest.resources.filter(r=>r.substitution).map(r=>r.sha256)).size,environment:{node:manifest.environment.node,os:manifest.environment.os,arch:manifest.environment.arch,browser:manifest.environment.browser,cpu:manifest.environment.cpu},cache:'not-measured',model:null,toolVersion:manifest.environment.software?.sha256}});
  if (manifest.status !== 'complete') throw new Error('Capture is blocked; source phase remains locked.');
  const invalid = [];
  for (const ref of manifest.states) {
    const evidence = JSON.parse(await readFile(join(captureDir, ref.assertionFile), 'utf8'));
    if (!evidence.result.executed || evidence.result.assertion === 'fail') invalid.push(`${ref.viewportId}/${ref.stateId}`);
  }
  if (invalid.length) throw new Error(`Reference scenarios failed: ${invalid.join(', ')}. Repair configuration and acquire a fresh run before review.`);
  state.phase = 'awaiting_user_review';
  state.corpusSha256 = manifest.corpusSha256;
  const files = await inventory(baselineDir);
  state.baselineSha256 = sha256(JSON.stringify(files));
  state.completedAt = new Date().toISOString();
  await json(join(out, 'baseline-inventory.json'), files);
  await json(join(out, 'state.json'), state);
  await writeFile(join(out, 'AGENT_HANDOFF.md'), handoff()+`\nV1 index: ${state.analysisDir}\nRead references/v1-workflow.md for on-demand dossiers. Metrics are outside the corpus under metrics/.\n`);
  telemetry.event('wait.start',{taskId:'replay-review',reason:'Awaiting user accuracy decision'});
  await telemetry.summarize();
  console.log(JSON.stringify({ status: 'awaiting_user_review', runDir: out, preview: state.preview, corpusSha256: state.corpusSha256, baselineSha256: state.baselineSha256, sourceReconstructionStarted: false }, null, 2));
} catch (error) {
  if(telemetry){telemetry.event('run.end',{outcome:'failed',error:String(error)});await telemetry.summarize();}
  if (state && out) { state.phase = 'blocked'; state.error = String(error); await json(join(out, 'state.json'), state); await writeFile(join(out,'AGENT_HANDOFF.md'),`# Clone blocked\n\nTarget: ${state.targetUrl}\nPhase: blocked\nMedia: ${state.mediaMode}\nError: ${state.error}\n\nInspect state.json, preflight.json and replay-checks/report.json when present. Preserve failed evidence. Retry a deterministic environment failure only after its cause changes. No source reconstruction or accuracy approval has occurred.\n`); }
  console.error(String(error)); process.exitCode = 1;
}
