# Lightweight controller

Use only for the current run's metrics or an explicit maintenance review. Normal capture uses minimum mode: buffered local events, task durations, errors via task outcomes, review waits and quality results. No dedicated LLM call, browser capture, service or database is added. `--metrics-mode off` disables wrapper telemetry; `standard` also records issue notes. Diagnostic detail is explicitly scoped per invocation.

Artifacts are run-local `metrics/events-WRITER.jsonl`, `run-metrics.json`, `summary.md`. Buffered writers are independent and bounded; losses/incomplete rows remain visible. The 2 MiB budget is shared against observed streams, so concurrent independent writers can temporarily exceed it; small loss sidecars preserve aggregate loss. A telemetry error warns once and lets the main operation continue. Required quality/integrity checks remain enforced.

Capture starts the observed run. Reconstruction before that boundary is not retroactively measured. Review approval closes the user wait; workspace creation opens initial reconstruction; first source comparison closes that candidate task. Later corrections need explicit task markers. Final verified delivery closes the run. A stopped run is incomplete until recorded as ended/abandoned. Agent active time is unavailable unless supplied by an authoritative environment.

Commands from the skill root:

```text
node scripts/metrics.mjs summary --run RUN
node scripts/metrics.mjs task-start --run RUN --task fix-menu-2 --phase correction --attempt 2 --rework
node scripts/metrics.mjs task-end --run RUN --task fix-menu-2 --phase correction --outcome passed
node scripts/metrics.mjs issue --run RUN --id menu-scroll --phase correction --category behavior --symptom "Scroll blocked after menu close" --status resolved --solution "Restored body overflow" --mode standard
node scripts/metrics.mjs metadata --run RUN --data RUN/measurement-context.json
```

Record a short issue note only when useful, during normal work. Do not write a narrative every step or load full log streams into agent context. Summary is generated without a model and is bounded to 2,000 characters. Reading it or writing notes still consumes agent tokens; token overhead is not claimed zero.

Metadata may record stable caseId/scopeId, machine/browser environment, warm/cold cache, model and tool version. Automatically available capture metadata is recorded; unobserved cache/model data stays unknown. Comparable histories require complete same-scope quality and matching environment/cache/model metadata. Different targets or failed runs are not silently ranked as improvements.

## Tokens

Token import is optional. Use only a selected actual Codex CLI JSONL stream or export exposing official usage fields; the controller does not scan global sessions, start a second agent or discover counters in this chat. If unavailable, report unavailable. CLI event format is documented in [OpenAI Docs](https://learn.chatgpt.com/docs/non-interactive-mode#make-output-machine-readable).

```text
node scripts/metrics.mjs token-import --run RUN --file SELECTED_RUN.jsonl --counter incremental --scope run --scope-id DEDICATED_SESSION --dedicated --complete
```

Declare incremental versus cumulative according to the source semantics. Cumulative resets require a distinct `--segment`. Run attribution requires a dedicated scope; shared session totals stay session-scoped. Use `--agent` and `--includes-agents` for scoped parent/child totals; declare expectedAgents in metadata to detect missing usage. Reimports deduplicate. Cached input/reasoning counters are subsets, not extra totals. Unknown components remain null; interrupted/incomplete streams remain partial. No automatic euro estimate is made.

## Maintenance and overhead

Select an external history path explicitly with `summary --history PATH` or `CLONE_METRICS_HISTORY`; there is no implicit history loading during new-target reconstruction. The environment-selected history is updated after run end. Review a compact batch of runs and choose one hypothesis to test. History holds metrics, not prior target solutions.

```text
node scripts/metrics.mjs compare --before BEFORE/run-metrics.json --after AFTER/run-metrics.json
node scripts/metrics.mjs overhead --output EXTERNAL_REPORT.json --pairs 5 --iterations 500000 --mode minimum
```

Overhead trials alternate deterministic workloads with monitoring on/off and include writes, flush, selected synthetic usage import and report. The 1% target and short-run 100 ms allowance are experimental budgets. Synthetic results do not establish real-site time/token overhead or the V1 speedup. Keep minimum default until representative runs justify standard. No polling, screenshots, context rereads or AI analysis are needed for collection.
