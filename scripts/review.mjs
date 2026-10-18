import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadState, currentIdentity, verifyApproval, writeState, sha256 } from './state.mjs';
import { openRecorder } from './telemetry.mjs';

try {
  const { values } = parseArgs({ options: { run: { type: 'string' }, 'confirmation-file': { type: 'string' }, check: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('Record an ACTUAL user accuracy confirmation for the current local build.\nnode scripts/review.mjs --run RUN --confirmation-file USER_TEXT.txt\nnode scripts/review.mjs --run RUN --check\nThe coordinator must obtain the user decision; this tool verifies hashes, not authorship.');
  } else {
    const { path, state } = await loadState(values.run);
    if (values.check) {
      console.log(JSON.stringify({ approval: 'valid', ...await verifyApproval(state) }));
    } else if (state.approval && ['approved_for_source', 'source_in_progress', 'source_verified'].includes(state.phase)) {
      console.log(JSON.stringify({ approval: 'already_valid', ...await verifyApproval(state) }));
    } else {
      if (state.phase !== 'awaiting_user_review') throw new Error('The local build must be completed and awaiting user review');
      if (!values['confirmation-file']) throw new Error('--confirmation-file is required; do not infer user approval');
      const confirmationText = (await readFile(resolve(values['confirmation-file']), 'utf8')).trim();
      if (!confirmationText || confirmationText.length > 65536) throw new Error('Provide the actual nonempty user confirmation, at most 64 KiB');
      const identity = await currentIdentity(state);
      if (state.corpusSha256 !== identity.corpusSha256 || state.baselineSha256 !== identity.baselineSha256) throw new Error('Baseline changed since it was presented. Refresh review state and obtain user confirmation for the new build');
      const reviewedAt = new Date().toISOString();
      state.approval = { reviewedAt, targetUrl: state.targetUrl, baselineDir: resolve(state.baselineDir), ...identity, confirmationText, confirmationSha256: sha256(confirmationText) };
      state.phase = 'approved_for_source';
      state.history = [...(state.history || []), { at: reviewedAt, phase: state.phase, reason: 'Recorded explicit user accuracy confirmation for these verified artifacts' }];
      await writeState(path, state);
      const telemetry=openRecorder(resolve(path,'..'),{mode:state.metricsMode??'minimum'});
      telemetry.event('wait.end',{taskId:'replay-review'});
      telemetry.event('review',{status:'approved',baselineSha256:identity.baselineSha256});
      await telemetry.summarize();
      console.log(JSON.stringify({ phase: state.phase, ...identity, next: 'Create a separate source workspace with scripts/workspace.mjs' }));
    }
  }
} catch (error) { console.error(error.message);process.exitCode = 1; }
