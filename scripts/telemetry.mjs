/** Local, bounded telemetry. Never performs network or model calls. */
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';

export const TELEMETRY_SCHEMA = 1;
export const LOG_BUDGET = 2 * 1024 * 1024;
const MODES = new Set(['off', 'minimum', 'standard', 'diagnostic']);
const BASIC = new Set(['run.start', 'run.metadata', 'run.end', 'task.start', 'task.end', 'wait.start', 'wait.end', 'review', 'quality', 'tokens', 'tokens.import', 'telemetry.loss']);
const compact = (value, depth = 0) => {
  if (typeof value === 'string') return value.slice(0, 500);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || typeof value === 'boolean') return value;
  if (depth > 3) return undefined;
  if (Array.isArray(value)) return value.slice(0, 50).map(v => compact(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40).filter(([, v]) => v !== undefined).map(([k, v]) => [k.slice(0, 80), compact(v, depth + 1)]));
  return undefined;
};
const sha = value => createHash('sha256').update(value).digest('hex');
const finite = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const clock = v => { const n = Date.parse(v); return Number.isFinite(n) ? n : null; };
const safeWarning = (callback, message) => { try { (callback || (v => console.warn(v)))(message); } catch {} };

/** event() only queues bounded data. flush() awaits IO; failures produce one warning. */
export function openRecorder(runDir, options = {}) {
  const mode = options.mode ?? process.env.CLONE_METRICS_MODE ?? 'minimum';
  if (!MODES.has(mode)) throw new Error(`Invalid telemetry mode: ${mode}`);
  const dir = path.join(path.resolve(runDir), 'metrics');
  const writer = randomUUID();
  const file = path.join(dir, `events-${writer}.jsonl`);
  const runId = options.runId ?? path.basename(path.resolve(runDir));
  const maxBytes = options.maxBytes ?? LOG_BUDGET;
  let pending = [], pendingBytes = 0, queuedBytes = 0, bytes = 0, dropped = 0, lostTypes = {}, chain = Promise.resolve(), failed = false, initialized = false, warned = false, ioMs = 0;
  function fail() {
    failed = true;
    pending = []; pendingBytes = 0;
    if (!warned) { warned = true; safeWarning(options.warning, '[metrics] Telemetry unavailable; main operation continues.'); }
  }
  function flush() {
    if (mode === 'off' || failed) return chain;
    const batch = pending.join(''); const batchBytes = Buffer.byteLength(batch); pending = []; pendingBytes = 0; queuedBytes += batchBytes;
    const losses = dropped ? { count: dropped, types: lostTypes } : null;
    dropped = 0; lostTypes = {};
    if (!batch && !losses) return chain;
    chain = chain.then(async () => {
      if (failed) { queuedBytes -= batchBytes; return; }
      const begin = performance.now();
      try {
        if (!initialized) {
          await fs.mkdir(dir, { recursive: true });
          const names = (await fs.readdir(dir)).filter(n => /^events(?:-[\w-]+)?\.jsonl$/.test(n));
          for (const name of names) bytes += (await fs.stat(path.join(dir, name))).size;
          initialized = true;
        }
        const loss = losses ? JSON.stringify({ schemaVersion: TELEMETRY_SCHEMA, runId, eventId: randomUUID(), writerId: writer, timestamp: new Date().toISOString(), type: 'telemetry.loss', ...losses }) + '\n' : '';
        const available = Math.max(0, maxBytes - bytes - 2048);
        if (Buffer.byteLength(batch) <= available && bytes + Buffer.byteLength(batch + loss) <= maxBytes) {
          await fs.appendFile(file, batch + loss);
          bytes += Buffer.byteLength(batch + loss);
        } else {
          const count = batch.split('\n').filter(Boolean).length + (losses?.count ?? 0);
          // One bounded sidecar per writer preserves aggregated loss after the log is full.
          const lossPath = path.join(dir, `loss-${writer}.json`);
          let previous = { count: 0 };
          try { previous = JSON.parse(await fs.readFile(lossPath, 'utf8')); } catch {}
          await atomicJSON(lossPath, { schemaVersion: 1, count: previous.count + count, detailLost: true, timestamp: new Date().toISOString() });
        }
      } catch { fail(); }
      queuedBytes -= batchBytes;
      ioMs += performance.now() - begin;
    });
    return chain;
  }
  function event(type, payload = {}) {
    if (mode === 'off' || failed || (mode === 'minimum' && !BASIC.has(type))) return null;
    const data = compact(payload) ?? {};
    if (type === 'review' && !data.decision && data.status) data.decision = data.status;
    if (type === 'quality' && !data.outcome && data.status) data.outcome = data.status;
    const record = { ...data, schemaVersion: TELEMETRY_SCHEMA, runId, writerId: writer, eventId: data.eventId || randomUUID(), timestamp: data.timestamp || new Date().toISOString(), type };
    const line = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(line) > 8192 || bytes + pendingBytes + queuedBytes + Buffer.byteLength(line) > maxBytes - 2048) {
      dropped++; const lossKey = Object.keys(lostTypes).length < 8 ? String(type).slice(0, 80) : 'other'; lostTypes[lossKey] = (lostTypes[lossKey] ?? 0) + 1;
      return null;
    }
    pending.push(line); pendingBytes += Buffer.byteLength(line);
    if (pendingBytes >= 16384 || pending.length >= 64) void flush();
    return record.eventId;
  }
  async function span(phase, taskName, fn, taskOptions = {}) {
    const taskId = taskOptions.taskId ?? randomUUID();
    const fields = { ...taskOptions, taskId, phase, taskName };
    event('task.start', fields);
    const begin = performance.now();
    let outcome = 'passed';
    try { return await fn(); }
    catch (error) { outcome = 'failed'; event('issue', { phase, taskId, category: 'unclassified', symptom: String(error?.message ?? error), status: 'open', errorCode: error?.code }); throw error; }
    finally { event('task.end', { ...fields, outcome, durationMs: performance.now() - begin, durationSource: 'monotonic' }); await flush(); }
  }
  return {
    mode, event, span, flush,
    get stats() { return { ioMs, failed, logBytesObserved: bytes, pendingBytes }; },
    async summarize(options = {}) { if (mode === 'off') return null; await flush(); try { return await summarizeRun(runDir, options); } catch { fail(); return null; } },
  };
}

async function atomicJSON(file, data) { return atomicText(file, JSON.stringify(data, null, 2) + '\n'); }
async function atomicText(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, data); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}

/** Recover complete JSONL rows, deduplicate event identities, and flag truncated/invalid data. */
export async function readEvents(runDir) {
  const dir = path.join(path.resolve(runDir), 'metrics');
  let files = [];
  try { files = await fs.readdir(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const events = [], seen = new Set(); let malformed = 0, duplicate = 0, detailLost = 0, bytes = 0;
  for (const file of files.filter(n => /^events(?:-[\w-]+)?\.jsonl$/.test(n)).sort()) {
    const full = path.join(dir, file);
    bytes += (await fs.stat(full)).size;
    const lines = createInterface({ input: createReadStream(full), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); if (!event.type || !event.eventId || clock(event.timestamp) === null) throw new Error(); }
      catch { malformed++; continue; }
      if (seen.has(event.eventId)) { duplicate++; continue; }
      seen.add(event.eventId); events.push(event);
      if (event.type === 'telemetry.loss') detailLost += event.count ?? 0;
    }
  }
  for (const file of files.filter(n => /^loss-[\w-]+\.json$/.test(n))) {
    try { detailLost += JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')).count ?? 0; } catch { malformed++; }
  }
  events.sort((a, b) => clock(a.timestamp) - clock(b.timestamp) || (a.type.endsWith('.start') ? -1 : 0) - (b.type.endsWith('.start') ? -1 : 0));
  return { events, malformed, duplicate, detailLost, bytes };
}

function union(intervals) {
  const sorted = intervals.filter(([a, b]) => finite(a) && finite(b) && b >= a).sort((a, b) => a[0] - b[0]);
  const result = [];
  for (const [a, b] of sorted) { const last = result.at(-1); if (last && a <= last[1]) last[1] = Math.max(last[1], b); else result.push([a, b]); }
  return result;
}
const length = intervals => union(intervals).reduce((n, [a, b]) => n + b - a, 0);
function intersection(left, right) { const out = []; for (const [a, b] of union(left)) for (const [c, d] of union(right)) if (Math.max(a, c) < Math.min(b, d)) out.push([Math.max(a, c), Math.min(b, d)]); return out; }
function intervalsFor(events, kind) {
  const starts = new Map(), closed = [], unmatched = [];
  for (const event of events) {
    if (event.type === `${kind}.start`) {
      if (!event.taskId) { unmatched.push(event.eventId); continue; }
      const key = event.taskId;
      if (starts.has(key)) unmatched.push(starts.get(key).eventId);
      starts.set(key, event);
    }
    if (event.type === `${kind}.end`) {
      const start = starts.get(event.taskId);
      if (!start || clock(event.timestamp) < clock(start.timestamp)) { unmatched.push(event.eventId); continue; }
      const durationMs = finite(event.durationMs) && event.durationSource === 'monotonic' && start.writerId === event.writerId ? event.durationMs : clock(event.timestamp) - clock(start.timestamp);
      closed.push({ ...start, ...event, start: clock(start.timestamp), end: clock(event.timestamp), durationMs, durationSource: finite(event.durationMs) && event.durationSource === 'monotonic' && start.writerId === event.writerId ? 'monotonic' : 'utc-observed' });
      starts.delete(event.taskId);
    }
  }
  return { closed, incomplete: [...unmatched, ...[...starts.values()].map(e => e.eventId)] };
}
const TOKEN_FIELDS = ['input', 'output', 'cachedInput', 'reasoning'];
function usageTotals(events, expectedAgents = []) {
  const groups = new Map(), warnings = [], sessions = [];
  let invalid = false;
  for (const e of events.filter(e => e.type === 'tokens')) {
    if (e.scope !== 'run' || e.dedicated !== true) { sessions.push(e); continue; }
    const key = [e.source, e.scopeId, e.agentId ?? 'root', e.segmentId ?? 'initial'].join('|');
    const group = groups.get(key) ?? { events: [], counter: e.counter, includesAgents: e.includesAgents ?? [] };
    if (group.counter !== e.counter) { invalid = true; warnings.push('Mixed counter semantics for one token source; split segments explicitly.'); continue; }
    group.events.push(e); groups.set(key, group);
  }
  const covered = new Set([...groups.values()].flatMap(g => g.includesAgents));
  const totals = { input: 0, output: 0, cachedInput: null, reasoning: null };
  let observed = 0, complete = true;
  for (const group of groups.values()) {
    if (covered.has(group.events[0].agentId)) { warnings.push(`Excluded separately reported agent ${group.events[0].agentId}, covered by an aggregate.`); continue; }
    let value = { input: 0, output: 0, cachedInput: null, reasoning: null }, previous;
    for (const e of group.events) {
      if (!finite(e.usage?.input) || !finite(e.usage?.output)) { invalid = true; continue; }
      if (group.counter === 'cumulative') {
        if (previous && TOKEN_FIELDS.some(k => finite(previous[k]) && finite(e.usage[k]) && e.usage[k] < previous[k])) { invalid = true; warnings.push('Cumulative token counter decreased; use an explicit segment for reset.'); continue; }
        value = { ...e.usage }; previous = e.usage;
      } else for (const k of TOKEN_FIELDS) if (finite(e.usage[k])) value[k] = (value[k] ?? 0) + e.usage[k];
      observed++;
    }
    for (const k of TOKEN_FIELDS) if (finite(value[k])) totals[k] = (totals[k] ?? 0) + value[k];
    const tail = group.events.at(-1);
    const marker = events.filter(e => e.type === 'tokens.import' && e.source === tail.source && e.scopeId === tail.scopeId && (e.agentId ?? 'root') === (tail.agentId ?? 'root') && (e.segmentId ?? 'initial') === (tail.segmentId ?? 'initial')).at(-1);
    complete &&= (marker ? marker.complete === true && !marker.malformed : tail.complete === true);
  }
  const observedAgents = new Set([...groups.values()].flatMap(g => [g.events[0].agentId ?? 'root', ...g.includesAgents]));
  const missingAgents = expectedAgents.filter(a => !observedAgents.has(a));
  if (missingAgents.length) { invalid = true; warnings.push(`Missing usage for agents: ${missingAgents.join(', ')}.`); }
  return { missingAgents, status: observed ? (complete && !invalid ? 'complete' : 'partial') : 'unavailable', ...(observed ? { ...totals, total: totals.input + totals.output } : { input: null, output: null, cachedInput: null, reasoning: null, total: null }), observedEvents: observed, lastEvent: events.filter(e => e.type === 'tokens').at(-1)?.eventId ?? null, sessionMeasurements: sessions.map(e => ({ scopeId: e.scopeId, usage: e.usage, counter: e.counter, eventId: e.eventId })), warnings: [...new Set(warnings)] };
}

export async function summarizeRun(runDir, options = {}) {
  const data = await readEvents(runDir), { events } = data;
  const tasks = intervalsFor(events, 'task'), waits = intervalsFor(events, 'wait');
  const starts = events.filter(e => e.type === 'run.start'), ends = events.filter(e => e.type === 'run.end');
  const start = starts[0], end = ends.at(-1), last = events.at(-1);
  const from = start ? clock(start.timestamp) : events[0] ? clock(events[0].timestamp) : null;
  const to = end ? clock(end.timestamp) : last ? clock(last.timestamp) : null;
  const elapsedMs = from !== null && to !== null ? Math.max(0, to - from) : null;
  const inBoundary = intervals => intervals.map(([a,b]) => [Math.max(a, from ?? a), Math.min(b, to ?? b)]).filter(([a,b]) => b >= a);
  const taskIntervals = inBoundary(tasks.closed.map(t => [t.start, t.end]));
  const waitIntervals = inBoundary(waits.closed.map(t => [t.start, t.end]));
  const waitMs = length(waitIntervals), exclusiveWaitMs = waitMs - length(intersection(waitIntervals, taskIntervals));
  const parents = new Set(tasks.closed.map(t => t.parentTaskId).filter(Boolean));
  const leaves = tasks.closed.filter(t => !parents.has(t.taskId));
  /** @type {Record<string, {taskMs:number, wallMs:number, tasks:number, failures:number, reworkMs:number, intervals?:number[][]}>} */
  const phases = {};
  for (const t of leaves) {
    const phase = t.phase ?? 'unknown';
    phases[phase] ??= { taskMs: 0, wallMs: 0, tasks: 0, failures: 0, reworkMs: 0, intervals: [] };
    const p = phases[phase]; p.taskMs += t.durationMs; p.tasks++; p.failures += t.outcome === 'failed' ? 1 : 0;
    if (t.rework || t.attempt > 1) p.reworkMs += t.durationMs;
    p.intervals.push([t.start, t.end]);
  }
  for (const p of Object.values(phases)) { p.wallMs = length(p.intervals); delete p.intervals; }
  const issues = new Map();
  for (const e of events.filter(e => e.type === 'issue')) {
    const key = e.issueId ?? e.eventId;
    issues.set(key, { ...issues.get(key), ...e });
  }
  const quality = events.filter(e => e.type === 'quality').reduce((state, e) => ({ ...state, ...e }), {});
  const review = events.filter(e => e.type === 'review').at(-1) ?? null;
  const metadata = events.filter(e => e.type === 'run.metadata').reduce((value, e) => ({ ...value, ...e.metadata }), { ...start?.metadata });
  Object.assign(metadata, options.metadata ?? {});
  const summary = {
    schemaVersion: TELEMETRY_SCHEMA, runId: start?.runId ?? events[0]?.runId ?? path.basename(runDir), generatedAt: new Date().toISOString(),
    metadata, outcome: end?.outcome ?? 'incomplete', boundary: { start: start?.timestamp ?? null, end: end?.timestamp ?? null, observedThrough: last?.timestamp ?? null, scope: start?.scope ?? 'observed-only' },
    timings: { elapsedMs, userWaitMs: waitMs, exclusiveUserWaitMs: exclusiveWaitMs, elapsedWithoutExclusiveUserWaitMs: elapsedMs === null ? null : Math.max(0, elapsedMs - exclusiveWaitMs), taskWallMs: length(taskIntervals), taskSumMs: leaves.reduce((n, t) => n + t.durationMs, 0), agentActiveMs: null, failedTasks: leaves.filter(t => t.outcome === 'failed').length, durationSources: { monotonic: leaves.filter(t => t.durationSource === 'monotonic').length, utcObserved: leaves.filter(t => t.durationSource === 'utc-observed').length }, phases },
    completeness: { complete: Boolean(start && end && !tasks.incomplete.length && !waits.incomplete.length && !data.malformed && !data.detailLost), missingRunStart: !start, missingRunEnd: !end, incompleteTasks: tasks.incomplete.length, incompleteWaits: waits.incomplete.length, malformedRows: data.malformed, detailLost: data.detailLost, duplicateEventsIgnored: data.duplicate },
    issues: [...issues.values()], tokens: usageTotals(events, metadata.expectedAgents ?? []), quality: Object.keys(quality).length ? quality : null, replayReview: review,
    overhead: { aiCalls: 0, additionalBrowserCaptures: 0, tokenOverhead: null, logBytes: data.bytes, summaryCharacters: 0, pairedBenchmark: null },
  };
  const report = renderSummary(summary); summary.overhead.summaryCharacters = report.length;
  if (options.write !== false) {
    const dir = path.join(path.resolve(runDir), 'metrics'); await fs.mkdir(dir, { recursive: true });
    await atomicJSON(path.join(dir, 'run-metrics.json'), summary);
    await atomicText(path.join(dir, 'summary.md'), report);
    const historyPath = options.historyPath ?? process.env.CLONE_METRICS_HISTORY;
    if (historyPath && end) await updateHistory(historyPath, summary);
  }
  return summary;
}

export function renderSummary(s) {
  const ms = n => n === null ? 'unavailable' : `${(n / 1000).toFixed(2)} s`;
  const phases = Object.entries(s.timings.phases).sort(([, a], [, b]) => b.taskMs - a.taskMs).slice(0, 3).map(([name, p]) => `${name}: ${ms(p.taskMs)}`).join('; ') || 'unavailable';
  return [
    `# Run ${String(s.runId).slice(0, 100)}`, `Outcome: ${s.outcome}; observation: ${s.completeness.complete ? 'complete' : 'partial'}.`,
    `Elapsed: ${ms(s.timings.elapsedMs)}; exclusive user wait: ${ms(s.timings.exclusiveUserWaitMs)}.`,
    `Without exclusive wait: ${ms(s.timings.elapsedWithoutExclusiveUserWaitMs)}; agent active time: unavailable.`,
    `Tasks: ${ms(s.timings.taskWallMs)} wall; ${ms(s.timings.taskSumMs)} summed (leaf tasks).`,
    `Costliest phases: ${phases}.`, `Failed tasks: ${s.timings.failedTasks}; issues: ${s.issues.length}; open: ${s.issues.filter(i => i.status !== 'resolved').length}.`,
    `Tokens: ${s.tokens.status}${s.tokens.total === null ? '' : `; input ${s.tokens.input}, output ${s.tokens.output}, total ${s.tokens.total}`}. Cache/reasoning are included subsets.`,
    `Replay: ${s.replayReview?.decision ?? 'unavailable'}; source verification: ${s.quality?.outcome ?? 'unavailable'}.`,
    `Missing task/wait closures: ${s.completeness.incompleteTasks}/${s.completeness.incompleteWaits}; malformed rows: ${s.completeness.malformedRows}; detail lost: ${s.completeness.detailLost}.`,
    `Telemetry: ${s.overhead.logBytes} log bytes; 0 model calls; 0 new captures. Time/token overhead: unmeasured for this run.`,
    'Details: run-metrics.json and events-*.jsonl. Baseline and corpus untouched.',
  ].join('\n').slice(0, 1999) + '\n';
}

/** Import only the explicitly selected JSONL. Source mode/scope must be supplied. */
export async function importTokens(runDir, selectedFile, options = {}) {
  if (!['incremental', 'cumulative'].includes(options.counter)) throw new Error('Token counter must explicitly be incremental or cumulative.');
  if (!['run', 'session'].includes(options.scope) || !options.scopeId) throw new Error('Explicit token scope and scopeId are required.');
  if (options.scope === 'run' && options.dedicated !== true) throw new Error('Run attribution requires a dedicated session or reliable selected boundaries (--dedicated).');
  if (options.mode === 'off') return { imported: 0, malformed: 0, source: null, failed: false, disabled: true };
  const sourcePath = path.resolve(selectedFile);
  const source = options.source ?? `codex-jsonl:${sha(sourcePath).slice(0, 16)}`;
  const reader = createInterface({ input: createReadStream(sourcePath), crlfDelay: Infinity });
  const recorder = openRecorder(runDir, { mode: options.mode ?? 'minimum', warning: options.warning });
  let row = 0, imported = 0, malformed = 0;
  try {
    for await (const line of reader) {
      row++; if (!line.trim()) continue;
      let item; try { item = JSON.parse(line); } catch { malformed++; continue; }
      if (item.type !== 'turn.completed') continue;
      const u = item.usage;
      if (!finite(u?.input_tokens) || !finite(u?.output_tokens)) { malformed++; continue; }
      const usage = { input: u.input_tokens, output: u.output_tokens, cachedInput: finite(u.cached_input_tokens) ? u.cached_input_tokens : null, reasoning: finite(u.reasoning_output_tokens) ? u.reasoning_output_tokens : null };
      if ((usage.cachedInput ?? 0) > usage.input || (usage.reasoning ?? 0) > usage.output) { malformed++; continue; }
      const eventId = `token-${sha([source, options.scopeId, options.agentId ?? 'root', options.segmentId ?? 'initial', item.id ?? `${row}:${sha(line)}`].join('|'))}`;
      recorder.event('tokens', { eventId, source, scope: options.scope, scopeId: options.scopeId, dedicated: options.dedicated === true, agentId: options.agentId ?? 'root', includesAgents: options.includesAgents ?? [], segmentId: options.segmentId ?? 'initial', counter: options.counter, complete: options.complete === true, usage, phase: options.phase ?? 'mixed', sourceRow: row });
      imported++;
    }
    recorder.event('tokens.import', { source, scopeId: options.scopeId, agentId: options.agentId ?? 'root', segmentId: options.segmentId ?? 'initial', complete: options.complete === true, malformed });
    if (malformed) recorder.event('telemetry.loss', { count: malformed, reason: 'Invalid selected token records', source });
    await recorder.flush();
  } finally { reader.close(); }
  return { imported, malformed, source, failed: recorder.stats.failed };
}

export async function recordQuality(runDir, data, options = {}) {
  const recorder = openRecorder(runDir, options); recorder.event('quality', data); await recorder.flush(); return recorder.summarize();
}

/** Explicit external maintenance history, keyed by run. No history reads in normal work. */
export async function updateHistory(historyPath, summary) {
  const file = path.resolve(historyPath), lines = [];
  try { for (const row of (await fs.readFile(file, 'utf8')).split('\n')) { if (!row.trim()) continue; try { const v = JSON.parse(row); if (v.runId !== summary.runId) lines.push(v); } catch {} } } catch (e) { if (e.code !== 'ENOENT') throw e; }
  lines.push({ runId: summary.runId, metadata: summary.metadata, outcome: summary.outcome, timings: summary.timings, tokens: summary.tokens, quality: summary.quality, completeness: summary.completeness, replayReview: summary.replayReview?.decision ?? null });
  await fs.mkdir(path.dirname(file), { recursive: true }); await atomicText(file, lines.map(v => JSON.stringify(v)).join('\n') + '\n');
}

export function compareSummaries(before, after) {
  const reasons = [];
  for (const key of ['caseId', 'scopeId', 'environment', 'cache', 'model']) {
    if (before.metadata?.[key] == null || after.metadata?.[key] == null || JSON.stringify(before.metadata[key]) !== JSON.stringify(after.metadata[key])) reasons.push(`Missing or different ${key}.`);
  }
  if (!before.completeness.complete || !after.completeness.complete) reasons.push('Incomplete timing observations.');
  if (before.outcome !== 'passed' || after.outcome !== 'passed') reasons.push('Both runs must complete successfully.');
  if (!before.quality || !after.quality) reasons.push('Missing source quality results.');
  else {
    for (const k of ['planned', 'executed', 'passed', 'failed', 'unverified', 'essentialOpen', 'build', 'independence']) if (before.quality[k] == null || after.quality[k] == null || before.quality[k] !== after.quality[k]) reasons.push(`Missing or different quality ${k}.`);
  }
  const b = before.timings.elapsedWithoutExclusiveUserWaitMs, a = after.timings.elapsedWithoutExclusiveUserWaitMs;
  return { comparable: !reasons.length, reasons, elapsedChangeMs: finite(a) && finite(b) ? a - b : null, elapsedChangePercent: finite(a) && b > 0 ? (a - b) / b * 100 : null, tokenChange: before.tokens.status === 'complete' && after.tokens.status === 'complete' ? after.tokens.total - before.tokens.total : null, interpretation: reasons.length ? 'Observed differences only; improvement not established.' : 'Comparable observations; repeat paired trials before drawing causal conclusions.' };
}
