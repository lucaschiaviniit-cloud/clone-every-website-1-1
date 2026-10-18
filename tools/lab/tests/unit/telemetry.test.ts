import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openRecorder, readEvents, summarizeRun, importTokens, compareSummaries, updateHistory } from '../../../../scripts/telemetry.mjs';
import { main } from '../../../../scripts/metrics.mjs';

async function temp(t: any) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clone-telemetry-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function event(type: string, offset: number, fields: any = {}) {
  return { schemaVersion: 1, runId: 'example', writerId: 'same', eventId: `${type}-${offset}-${fields.taskId ?? fields.source ?? ""}`, timestamp: new Date(Date.UTC(2026, 0, 1) + offset).toISOString(), type, ...fields };
}
async function fixture(dir: string, events: any[], suffix = '') {
  await fs.mkdir(path.join(dir, 'metrics'), { recursive: true });
  await fs.writeFile(path.join(dir, 'metrics/events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n' + suffix);
}

test('overlapping work excludes only exclusive user wait and task totals avoid parent double counts', async t => {
  const dir = await temp(t);
  await fixture(dir, [event('run.start', 0, { scope: 'full-workflow' }),
    event('task.start', 0, { taskId: 'parent', phase: 'reconstruction' }),
    event('task.start', 1000, { taskId: 'a', phase: 'reconstruction', parentTaskId: 'parent' }),
    event('wait.start', 2000, { taskId: 'approval' }),
    event('task.start', 3000, { taskId: 'b', phase: 'reconstruction', parentTaskId: 'parent', rework: true, attempt: 2 }),
    event('task.end', 5000, { taskId: 'a', durationMs: 4000, durationSource: 'monotonic', outcome: 'passed' }),
    event('task.end', 6000, { taskId: 'b', durationMs: 3000, durationSource: 'monotonic', outcome: 'passed' }),
    event('task.end', 6000, { taskId: 'parent', durationMs: 6000, durationSource: 'monotonic', outcome: 'passed' }),
    event('wait.end', 8000, { taskId: 'approval' }), event('run.end', 10000, { outcome: 'passed' })]);
  const summary = await summarizeRun(dir);
  assert.equal(summary.timings.elapsedMs, 10000);
  assert.equal(summary.timings.userWaitMs, 6000);
  assert.equal(summary.timings.exclusiveUserWaitMs, 2000);
  assert.equal(summary.timings.elapsedWithoutExclusiveUserWaitMs, 8000);
  assert.equal(summary.timings.taskSumMs, 7000);
  assert.equal(summary.timings.phases.reconstruction.wallMs, 5000);
  assert.equal(summary.timings.phases.reconstruction.reworkMs, 3000);
  assert.equal(summary.completeness.complete, true);
  assert.equal(summary.tokens.total, null);
  const report = await fs.readFile(path.join(dir, 'metrics/summary.md'), 'utf8');
  assert.ok(report.length <= 2000);
  assert.ok(report.split('\n').length <= 16);
});

test('crash recovery preserves complete rows, deduplicates events and never invents missing durations', async t => {
  const dir = await temp(t), start = event('run.start', 0);
  await fixture(dir, [start, start, event('task.start', 10, { taskId: 'unfinished' }), event('wait.start', 20, { taskId: 'pending' })], '{"type":');
  const summary = await summarizeRun(dir);
  assert.equal(summary.completeness.complete, false);
  assert.equal(summary.completeness.duplicateEventsIgnored, 1);
  assert.equal(summary.completeness.malformedRows, 1);
  assert.equal(summary.completeness.incompleteTasks, 1);
  assert.equal(summary.completeness.incompleteWaits, 1);
  assert.equal(summary.timings.taskSumMs, 0);
  assert.equal(summary.timings.elapsedMs, 20);
  assert.equal(summary.outcome, 'incomplete');
});

test('independent recorder streams and monotonic span timings retain result and original failure', async t => {
  const dir = await temp(t), one = openRecorder(dir, { mode: 'standard' }), two = openRecorder(dir);
  one.event('run.start', { scope: 'full-workflow' });
  assert.equal(await one.span('analysis', 'success', async () => 42), 42);
  const failure = new Error('original failure');
  await assert.rejects(one.span('verification', 'failure', async () => { throw failure; }), e => e === failure);
  two.event('quality', { outcome: 'failed', failed: 1 }); await two.flush();
  one.event('run.end', { outcome: 'failed' }); await one.flush();
  const events = await readEvents(dir);
  const ends = events.events.filter(e => e.type === 'task.end');
  assert.equal(ends.length, 2);
  assert.ok(ends.every(e => e.durationMs >= 0 && e.durationSource === 'monotonic'));
  assert.equal(events.events.filter(e => e.type === 'issue').length, 1);
  const names = await fs.readdir(path.join(dir, 'metrics'));
  assert.equal(names.filter(n => n.startsWith('events-')).length, 2);
  assert.equal((await one.summarize())?.timings.failedTasks, 1);
});

test('cross-process task times use UTC observation rather than incomparable monotonic clocks', async t => {
  const dir = await temp(t);
  await fixture(dir, [event('task.start', 0, { taskId: 'cli', writerId: 'one' }), event('task.end', 2000, { taskId: 'cli', writerId: 'two', durationMs: 999, durationSource: 'monotonic' })]);
  const summary = await summarizeRun(dir, { write: false });
  assert.equal(summary.timings.taskSumMs, 2000);
  assert.equal(summary.completeness.missingRunStart, true);
});

test('write failure is fail-open, warns once and preserves wrapped work result', async t => {
  const dir = await temp(t), warnings: string[] = [];
  await fs.writeFile(path.join(dir, 'metrics'), 'file blocks telemetry directory');
  const recorder = openRecorder(dir, { warning: (v: string) => warnings.push(v) });
  recorder.event('run.start'); await recorder.flush();
  assert.equal(await recorder.span('capture', 'main work', async () => 'still works'), 'still works');
  recorder.event('run.end'); await recorder.flush();
  assert.equal(await recorder.summarize(), null);
  assert.equal(warnings.length, 1);
  assert.equal(recorder.stats.failed, true);
});

test('off mode produces no metrics directory and budget records aggregate loss without oversized logs', async t => {
  const off = await temp(t), recorder = openRecorder(off, { mode: 'off' });
  recorder.event('run.start'); await recorder.span('capture', 'work', async () => 0); await recorder.flush();
  assert.equal(await recorder.summarize(), null);
  await assert.rejects(fs.stat(path.join(off, 'metrics')), { code: 'ENOENT' });
  const dir = await temp(t), limited = openRecorder(dir, { mode: 'standard', maxBytes: 5000 });
  limited.event('run.start');
  for (let n = 0; n < 200; n++) limited.event('issue', { symptom: 'x'.repeat(1000), issueId: String(n) });
  limited.event('run.end'); await limited.flush();
  const data = await readEvents(dir);
  assert.ok(data.bytes <= 5000, String(data.bytes));
  assert.ok(data.detailLost > 0);
  const summary = await limited.summarize(); assert.equal(summary?.completeness.complete, false);
});

test('token imports are idempotent, expose observed zero and update completion without double counting subsets', async t => {
  const dir = await temp(t), source = path.join(dir, 'selected.jsonl');
  await fs.writeFile(source, [
    { type: 'turn.completed', id: 'a', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5 } },
    { type: 'turn.completed', id: 'b', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } },
  ].map(v => JSON.stringify(v)).join('\n') + '\n');
  const options = { counter: 'incremental', scope: 'run', scopeId: 'dedicated-session', dedicated: true };
  await importTokens(dir, source, options);
  assert.equal((await summarizeRun(dir, { write: false })).tokens.status, 'partial');
  await importTokens(dir, source, { ...options, complete: true });
  const tokens = (await summarizeRun(dir, { write: false })).tokens;
  assert.equal(tokens.status, 'complete'); assert.equal(tokens.total, 120);
  assert.equal(tokens.cachedInput, 40); assert.equal(tokens.reasoning, 5);
  assert.equal(tokens.observedEvents, 2);
  const zeroDir = await temp(t); await fs.writeFile(source, JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } }) + '\n');
  await importTokens(zeroDir, source, { ...options, complete: true });
  assert.equal((await summarizeRun(zeroDir, { write: false })).tokens.total, 0);
});

test('cumulative tokens use latest snapshot, resets require explicit segments and session totals stay unallocated', async t => {
  const dir = await temp(t);
  const base = { source: 'official-export', scope: 'run', scopeId: 'one', dedicated: true, counter: 'cumulative', complete: true, agentId: 'root' };
  await fixture(dir, [event('tokens', 0, { ...base, usage: { input: 100, output: 10 } }), event('tokens', 1, { ...base, usage: { input: 200, output: 20 } }),
    event('tokens', 2, { ...base, usage: { input: 50, output: 5 } }),
    event('tokens', 3, { ...base, segmentId: 'explicit-reset', usage: { input: 60, output: 6 } }),
    event('tokens', 4, { ...base, scope: 'session', dedicated: false, usage: { input: 1000, output: 100 } })]);
  const tokens = (await summarizeRun(dir, { write: false })).tokens;
  assert.equal(tokens.total, 286); assert.equal(tokens.status, 'partial');
  assert.equal(tokens.sessionMeasurements.length, 1); assert.ok(tokens.warnings.some(w => w.includes('decreased')));
  const source = path.join(dir, 'unused.jsonl'); await fs.writeFile(source, '');
  await assert.rejects(importTokens(dir, source, { counter: 'incremental', scope: 'run', scopeId: 'shared' }), /dedicated/);
});

test('aggregate agent totals exclude covered child counters and missing cache details remain unavailable', async t => {
  const dir = await temp(t), base = { scope: 'run', scopeId: 'one', dedicated: true, counter: 'incremental', complete: true };
  await fixture(dir, [event('tokens', 0, { ...base, source: 'root', agentId: 'root', includesAgents: ['child'], usage: { input: 100, output: 10 } }), event('tokens', 1, { ...base, source: 'child', agentId: 'child', usage: { input: 40, output: 4 } })]);
  const tokens = (await summarizeRun(dir, { write: false })).tokens;
  assert.equal(tokens.total, 110); assert.equal(tokens.cachedInput, null); assert.equal(tokens.reasoning, null);
});

test('invalid token rows mark partial data without interpreting arbitrary usage objects', async t => {
  const dir = await temp(t), source = path.join(dir, 'selected.jsonl');
  await fs.writeFile(source, ['{invalid', JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 100 } }), JSON.stringify({ type: 'unrelated', usage: { input_tokens: 999, output_tokens: 999 } })].join('\n'));
  const result = await importTokens(dir, source, { counter: 'incremental', scope: 'session', scopeId: 'shared-session' });
  assert.equal(result.imported, 0); assert.equal(result.malformed, 2);
  assert.equal((await summarizeRun(dir, { write: false })).tokens.total, null);
});

test('maintenance history replaces a run entry and comparison refuses unsupported quality claims', async t => {
  const dir = await temp(t);
  await fixture(dir, [event('run.start', 0, { metadata: { caseId: 'case', scopeId: 'one', environment: 'fixed', cache: 'warm', model: 'model' } }), event('run.end', 1000, { outcome: 'passed' })]);
  const summary = await summarizeRun(dir, { write: false });
  const history = path.join(dir, 'external-maintenance/history.jsonl');
  await updateHistory(history, summary); await updateHistory(history, summary);
  assert.equal((await fs.readFile(history, 'utf8')).trim().split('\n').length, 1);
  assert.equal(compareSummaries(summary, summary).comparable, false);
  const quality = { planned: 5, executed: 5, passed: 5, failed: 0, unverified: 0, essentialOpen: 0, build: true, independence: true };
  const withQuality = { ...summary, quality };
  assert.equal(compareSummaries(withQuality, withQuality).comparable, true);
  assert.equal(compareSummaries(withQuality, { ...withQuality, quality: { ...quality, executed: 4 } }).comparable, false);
});

test('CLI rejects unknown flags, missing fields and invalid outcome without silent successful recording', async t => {
  const dir = await temp(t);
  await assert.rejects(main(['start', '--run', dir, '--unknown', 'x']), /Unknown/);
  await assert.rejects(main(['start', '--run', dir]), /scope/);
  await assert.rejects(main(['end', '--run', dir, '--outcome', 'perfect']), /Invalid/);
  await assert.rejects(main(['task-start', '--run', dir, '--task', 'a', '--phase', 'analysis', '--attempt', 'no']), /integer/);
  await assert.rejects(main(['overhead', '--output', path.join(dir, 'bench.json'), '--pairs', '4']), /integer/);
});


test('declared missing agent usage marks observed run tokens partial', async t => {
  const dir = await temp(t);
  await fixture(dir, [event('run.start', 0, { metadata: { expectedAgents: ['root', 'child'] } }), event('tokens', 1, { source: 'official', scope: 'run', scopeId: 'one', dedicated: true, counter: 'incremental', complete: true, agentId: 'root', usage: { input: 20, output: 2 } }), event('run.end', 2, { outcome: 'passed' })]);
  const summary = await summarizeRun(dir, { write: false });
  assert.equal(summary.tokens.status, 'partial');
  assert.deepEqual(summary.tokens.missingAgents, ['child']);
  assert.equal(summary.tokens.total, 22);
});


test('minimum metadata updates merge into run identity without changing lifecycle boundaries', async t => {
  const dir = await temp(t), dataFile = path.join(dir, 'metadata.json');
  const recorder = openRecorder(dir, { mode: 'minimum' });
  recorder.event('run.start', { scope: 'full-workflow', metadata: { node: 'v22', cache: 'unknown' } });
  recorder.event('run.metadata', { metadata: { caseId: 'case', environment: { browser: 'chromium' }, cache: 'warm' } });
  await recorder.flush();
  await fs.writeFile(dataFile, JSON.stringify({ scopeId: 'homepage-desktop', model: 'selected-model', expectedAgents: ['root'] }));
  await main(['metadata', '--run', dir, '--data', dataFile, '--mode', 'minimum']);
  const summary = await summarizeRun(dir, { write: false });
  assert.deepEqual(summary.metadata, { node: 'v22', cache: 'warm', caseId: 'case', environment: { browser: 'chromium' }, scopeId: 'homepage-desktop', model: 'selected-model', expectedAgents: ['root'] });
  assert.equal((await readEvents(dir)).events.filter(e => e.type === 'run.start').length, 1);
  assert.equal(summary.completeness.missingRunEnd, true);
  assert.deepEqual(summary.tokens.missingAgents, ['root']);
  await fs.writeFile(dataFile, '[]');
  await assert.rejects(main(['metadata', '--run', dir, '--data', dataFile]), /must be an object/);
});
