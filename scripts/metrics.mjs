#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { openRecorder, summarizeRun, importTokens, compareSummaries } from './telemetry.mjs';

const COMMANDS = {
  metadata: ['run', 'data', 'mode'],
  start: ['run', 'scope', 'metadata', 'mode'], end: ['run', 'outcome', 'mode', 'history'],
  'task-start': ['run', 'task', 'phase', 'name', 'attempt', 'parent', 'rework', 'mode'],
  'task-end': ['run', 'task', 'phase', 'outcome', 'mode'],
  'wait-start': ['run', 'task', 'mode'], 'wait-end': ['run', 'task', 'mode'],
  issue: ['run', 'id', 'task', 'phase', 'category', 'symptom', 'cause', 'hypothesis', 'solution', 'status', 'attempts', 'evidence', 'mode'],
  review: ['run', 'decision', 'baseline', 'mode'], quality: ['run', 'data', 'mode'],
  'token-import': ['run', 'file', 'counter', 'scope', 'scope-id', 'dedicated', 'complete', 'agent', 'segment', 'phase', 'includes-agents', 'mode'],
  summary: ['run', 'history'], history: ['file'], compare: ['before', 'after'],
  overhead: ['output', 'pairs', 'iterations', 'mode'],
};
const BOOLEANS = new Set(['rework', 'hypothesis', 'dedicated', 'complete']);
function parse(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS[command]) throw new Error(`Unknown command ${command ?? ''}. Commands: ${Object.keys(COMMANDS).join(', ')}.`);
  const args = {};
  for (let n = 0; n < rest.length; n++) {
    const flag = rest[n]; if (!flag.startsWith('--')) throw new Error(`Expected option, received ${flag}.`);
    const key = flag.slice(2); if (!COMMANDS[command].includes(key) || key in args) throw new Error(`Unknown or repeated option: ${flag}.`);
    if (BOOLEANS.has(key)) args[key] = true;
    else { if (!rest[n + 1] || rest[n + 1].startsWith('--')) throw new Error(`Missing value for ${flag}.`); args[key] = rest[++n]; }
  }
  return { command, args };
}
const need = (args, key) => { if (!args[key]) throw new Error(`--${key} is required.`); return args[key]; };
const choice = (value, values, label) => { if (!values.includes(value)) throw new Error(`Invalid ${label}: ${value}; expected ${values.join(', ')}.`); return value; };
function count(value, fallback, minimum = 0) { const n = value === undefined ? fallback : Number(value); if (!Number.isSafeInteger(n) || n < minimum) throw new Error(`Expected integer >= ${minimum}.`); return n; }
const jsonFile = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2; };

/** Five alternating paired trials, disposable runs, no target or model invocation. */
export async function benchmarkOverhead({ pairs = 5, iterations = 50000, mode = 'standard', output } = {}) {
  if (!Number.isSafeInteger(pairs) || pairs < 5) throw new Error('At least five pairs are required.');
  if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error('Positive workload iterations required.');
  choice(mode, ['minimum', 'standard', 'diagnostic'], 'benchmark mode');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clone-metrics-overhead-'));
  const selectedTokens = path.join(root, 'selected-tokens.jsonl');
  await fs.writeFile(selectedTokens, Array.from({ length: 10 }, (_, n) => JSON.stringify({ type: 'turn.completed', id: `synthetic-${n}`, usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 } })).join('\n') + '\n');
  let pairResults = [];
  async function workload(runDir, enabled) {
    await fs.mkdir(runDir, { recursive: true });
    const recorder = openRecorder(runDir, { mode: enabled ? mode : 'off' });
    const begin = performance.now();
    recorder.event('run.start', { scope: 'synthetic-overhead-benchmark', metadata: { synthetic: true } });
    let hash;
    await recorder.span('benchmark', 'deterministic workload', async () => {
      for (let n = 0; n < iterations; n++) {
        hash = createHash('sha256').update(`fixed-workload-${n}`).digest('hex');
        if (n % Math.max(1, Math.floor(iterations / 50)) === 0) recorder.event('issue', { issueId: `synthetic-${n}`, category: 'unclassified', symptom: 'Synthetic event; no actual defect.', status: 'resolved' });
      }
      await fs.writeFile(path.join(runDir, 'workload-result.txt'), hash);
    });
    if (enabled) await importTokens(runDir, selectedTokens, { counter: 'incremental', scope: 'run', scopeId: path.basename(runDir), dedicated: true, complete: true, mode });
    recorder.event('run.end', { outcome: 'passed' }); await recorder.flush();
    if (enabled) await recorder.summarize();
    return { elapsedMs: performance.now() - begin, checksum: hash };
  }
  try {
    // Warm identical CPU/JIT workload once before measured alternating pairs.
    await workload(path.join(root, 'warm-up'), false);
    for (let n = 0; n < pairs; n++) {
      const order = n % 2 ? [true, false] : [false, true], results = {};
      for (const enabled of order) results[enabled ? 'on' : 'off'] = await workload(path.join(root, `pair-${n}-${enabled ? 'on' : 'off'}`), enabled);
      pairResults.push({ pair: n + 1, order: order.map(v => v ? 'on' : 'off'), offMs: results.off.elapsedMs, onMs: results.on.elapsedMs, differenceMs: results.on.elapsedMs - results.off.elapsedMs, checksumMatches: results.on.checksum === results.off.checksum });
    }
    const offMedianMs = median(pairResults.map(p => p.offMs)), differenceMedianMs = median(pairResults.map(p => p.differenceMs));
    const dispersionMs = median(pairResults.map(p => Math.abs(p.differenceMs - differenceMedianMs)));
    const percent = differenceMedianMs / offMedianMs * 100;
    const inconclusive = Math.abs(differenceMedianMs) <= dispersionMs;
    const report = {
      schemaVersion: 1, generatedAt: new Date().toISOString(), synthetic: true, mode, pairs: pairResults,
      environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length, iterations, cache: 'CPU warm-up; fresh telemetry directories; OS filesystem cache uncontrolled' },
      offMedianMs, differenceMedianMs, dispersionMedianAbsoluteDeviationMs: dispersionMs, differencePercent: percent,
      budget: { percentTarget: 1, shortRunAbsoluteTargetMs: 100, withinPercentTarget: percent <= 1, withinShortAbsoluteTarget: offMedianMs < 10000 && differenceMedianMs <= 100, result: inconclusive ? 'inconclusive-noise' : percent <= 1 ? 'within-percent-target' : offMedianMs < 10000 && differenceMedianMs <= 100 ? 'within-short-absolute-target-only' : 'over-budget' },
      tokenOverhead: null, aiCalls: 0, limitations: 'Synthetic local paired trials include event writes, flush, selected synthetic token import and summary. They do not establish overhead for real capture runs, token overhead, or causal tool improvement. Standard mode adoption requires representative runs.',
    };
    if (output) { await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n'); }
    return report;
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv[0] === '--help') return `Usage: node metrics.mjs <command> [options]\nCommands: ${Object.keys(COMMANDS).join(', ')}\nAll run commands require --run <directory>. Data remains in <run>/metrics, outside corpus.\nToken import requires --file, --counter incremental|cumulative, --scope run|session, --scope-id; run scope requires --dedicated.\nOverhead: --output <json> [--pairs 5] [--iterations 50000] [--mode standard].\n`;
  const { command, args } = parse(argv);
  if (command === 'overhead') return benchmarkOverhead({ pairs: count(args.pairs, 5, 5), iterations: count(args.iterations, 50000, 1), mode: args.mode ?? 'standard', output: need(args, 'output') });
  if (command === 'compare') return compareSummaries(await jsonFile(need(args, 'before')), await jsonFile(need(args, 'after')));
  if (command === 'history') {
    const rows = (await fs.readFile(need(args, 'file'), 'utf8')).split('\n').filter(Boolean).map(v => JSON.parse(v));
    return { runs: rows.length, recent: rows.slice(-3).map(r => ({ runId: r.runId, outcome: r.outcome, elapsedMs: r.timings.elapsedWithoutExclusiveUserWaitMs, tokens: r.tokens.total, complete: r.completeness.complete })), note: 'Inspect matched cases and quality before proposing one measured improvement.' };
  }
  const runDir = need(args, 'run');
  if (command === 'summary') return summarizeRun(runDir, { historyPath: args.history });
  if (command === 'token-import') return importTokens(runDir, need(args, 'file'), { counter: need(args, 'counter'), scope: need(args, 'scope'), scopeId: need(args, 'scope-id'), dedicated: args.dedicated, complete: args.complete, agentId: args.agent, segmentId: args.segment, phase: args.phase, includesAgents: args['includes-agents']?.split(',').filter(Boolean), mode: args.mode });
  const recorder = openRecorder(runDir, { mode: args.mode ?? (command === 'issue' ? 'standard' : undefined) });
  if (command === 'start') recorder.event('run.start', { scope: need(args, 'scope'), metadata: args.metadata ? await jsonFile(args.metadata) : {} });
  if (command === 'end') recorder.event('run.end', { outcome: choice(need(args, 'outcome'), ['passed', 'failed', 'abandoned', 'interrupted'], 'outcome') });
  if (command === 'task-start') recorder.event('task.start', { taskId: need(args, 'task'), phase: need(args, 'phase'), taskName: args.name, parentTaskId: args.parent, attempt: count(args.attempt, 1, 1), rework: args.rework ?? false });
  if (command === 'task-end') recorder.event('task.end', { taskId: need(args, 'task'), phase: args.phase, outcome: choice(need(args, 'outcome'), ['passed', 'failed', 'abandoned', 'interrupted'], 'outcome') });
  if (command.startsWith('wait-')) recorder.event(command.replace('-', '.'), { taskId: need(args, 'task'), source: 'explicit-user-review' });
  if (command === 'review') recorder.event('review', { decision: choice(need(args, 'decision'), ['approved', 'rejected', 'changes-requested'], 'review decision'), baselineId: args.baseline });
  if (command === 'issue') recorder.event('issue', { issueId: need(args, 'id'), taskId: args.task, phase: args.phase, category: choice(need(args, 'category'), ['environment', 'acquisition', 'layout', 'behavior', 'animation-media', 'integration', 'unstable-verification', 'missing-information', 'unclassified'], 'issue category'), symptom: need(args, 'symptom'), cause: args.cause, causeIsHypothesis: args.hypothesis ?? false, solution: args.solution, status: choice(args.status ?? 'open', ['open', 'resolved'], 'issue status'), attempts: count(args.attempts, 1, 1), evidence: args.evidence });
  if (command === 'metadata') { const data = await jsonFile(need(args, 'data')); if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('Metadata data must be an object.'); recorder.event('run.metadata', { metadata: data }); }
  if (command === 'quality') { const data = await jsonFile(need(args, 'data')); if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('Quality data must be an object.'); recorder.event('quality', data); }
  await recorder.flush();
  if (command === 'end') return recorder.summarize({ historyPath: args.history });
  return { command, mode: recorder.mode, recorded: !recorder.stats.failed && recorder.mode !== 'off' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => { if (result !== undefined) console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2)); }).catch(error => { console.error(`[metrics] ${error.message}`); process.exitCode = 1; });
}
