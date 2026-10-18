import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { loadState, verifyApproval, writeState, within } from './state.mjs';
import { openRecorder } from './telemetry.mjs';

try {
  const { values } = parseArgs({ options: { run: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('Create a fresh source workspace ONLY after valid explicit user approval.\nnode scripts/workspace.mjs --run RUN --out FRESH_SOURCE_DIRECTORY\nNo components are generated automatically; the skill coordinates agent reconstruction from the approved artifacts.');
  } else {
    const { path, state } = await loadState(values.run);
    const identity = await verifyApproval(state);
    if (!values.out) throw new Error('--out is required');
    if (state.sourceDir) throw new Error(`Source workspace already recorded: ${state.sourceDir}. Resume it instead of creating another silently`);
    const destination = resolve(values.out);
    if (within(state.captureDir, destination) || within(state.baselineDir, destination)) throw new Error('Source output must be separate from the immutable corpus and baseline');
    await mkdir(dirname(destination), { recursive: true });
    await mkdir(destination);
    const startedAt = new Date().toISOString();
    const sourceState = { schemaVersion: 1, targetUrl: state.targetUrl, phase: 'source_in_progress', runState: path, approvedCaptureDir: state.captureDir, approvedBaselineDir: state.baselineDir, approvedIdentity: identity, startedAt, verified: false, next: 'Read the skill Phase B reference and reconstruct from the approved artifacts; preserve the replay' };
    await writeFile(resolve(destination, 'reconstruction-state.json'), JSON.stringify(sourceState, null, 2) + '\n', { flag: 'wx' });
    await writeFile(resolve(destination, 'RECONSTRUCTION_HANDOFF.md'), `# Current-run source reconstruction\n\nTarget: ${state.targetUrl}\n\nPhase: source_in_progress. The user approved the local build's accuracy; source reconstruction has not yet been completed.\n\n- Run state: ${path}\n- Approved capture: ${state.captureDir}\n- Approved baseline: ${state.baselineDir}\n- Corpus SHA256: ${identity.corpusSha256}\n- Baseline SHA256: ${identity.baselineSha256}\n\nUse only this run's evidence and generic skill references. No historical target examples or expected benchmark answers. Keep the approved replay unchanged. Classify recovered/adapted/rewritten code, preserve original CSS/assets and motion evidence, implement editable components, then validate the independent build. Record actual checks and unresolved limitations here.\n`, { flag: 'wx' });
    state.phase = 'source_in_progress';state.sourceDir = destination;state.sourceReconstructionStarted = true;
    state.history = [...(state.history || []), { at: startedAt, phase: state.phase, reason: 'Created separate source workspace after checking current approval hashes' }];
    await writeState(path, state);
    const telemetry=openRecorder(dirname(path),{mode:state.metricsMode??'minimum'});
    telemetry.event('task.start',{taskId:'reconstruction',phase:'reconstruction',taskName:'Editable source reconstruction'});
    await telemetry.summarize();
    console.log(JSON.stringify({ phase: state.phase, sourceDir: destination, componentsGenerated: false }));
  }
} catch (error) { console.error(error.message);process.exitCode = 1; }
