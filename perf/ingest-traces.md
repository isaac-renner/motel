# Ingest Traces

## Goal

Reduce `TelemetryStore.ingestTraces` latency on realistic multi-trace OTLP batches.

## Benchmark

```bash
bun run bench:ingest-traces --warmups 1 --iterations 5
```

## Primary Metrics

- `ingest_traces_ms`
- `ingest_traces_mad_ms`

## Seed Shape

The benchmark ingests one OTLP trace payload containing:

- many traces
- many spans per trace
- nested parent/child structure
- several span attributes per span
- one event per non-root span

This stresses:

- span row inserts
- span attribute fanout
- FTS operation inserts
- trace summary upserts

## Files In Scope

- `src/services/TelemetryStore.ts`
- `scripts/bench-ingest-traces.ts`

## Likely Hypotheses

1. repeated object merges and repeated JSON serialization are inflating per-span CPU cost
2. resource-level values can be precomputed once per resource batch instead of once per span
3. summary upserts or attribute fanout may dominate large batches

## Baseline

Measured on 2026-04-18 with:

```bash
bun run bench:ingest-traces --warmups 1 --iterations 5
```

on:

- `100` traces
- `64` spans per trace
- `6400` inserted spans per run

Current median:

- `ingest_traces_ms = 3103.0ms`

## Discarded Experiment

Tried batching trace summary recomputation across all touched trace ids instead of running one summary upsert per trace.

Result:

- no meaningful improvement over baseline
- reverted

Conclusion:

- the current writer bottleneck is probably not just per-trace summary query dispatch overhead
- the next likely hotspots are attribute fanout, FTS maintenance, or per-span serialization work

## First Keep

Changed attribute fanout writes to use cached multi-row insert statements instead of one SQLite call per attribute row.

Result:

- `ingest_traces_ms = 3064.2ms`

Small but real improvement.

## Second Keep

Changed span-operation FTS maintenance from per-span delete/insert calls to batched maintenance after each payload transaction.

What changed:

- collect touched `(trace_id, span_id, operation_name)` tuples during ingest
- batch `DELETE FROM span_operation_fts ...` in chunks
- batch `INSERT INTO span_operation_fts ... VALUES ...` in chunks

Current median after both keeps:

- `ingest_traces_ms = 1428.5ms`

## Root Cause

The dominant ingest bottleneck was not trace-summary recomputation.

The big writer-path cost was span-operation FTS maintenance done one span at a time:

- one `DELETE` per span
- one `INSERT` per span

Batching those writes cut the benchmark roughly in half.

## Next Best Hypothesis

The next likely writer-side targets are:

- log-body FTS maintenance during `ingestLogs`
- remaining per-span attribute fanout overhead
- event / attribute JSON serialization cost on very large batches
