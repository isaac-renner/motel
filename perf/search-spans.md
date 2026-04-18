# Search Spans

## Goal

Reduce `TelemetryStore.searchSpans` latency on datasets with many traces and many spans per trace.

## Benchmark

```bash
bun run bench:search-spans --warmups 1 --iterations 7
```

## Primary Metrics

- `search_spans_ms`
- `search_spans_mad_ms`

## Seed Shape

The benchmark seeds:

- many traces under `service.name=bench-api`
- one `search.target` span per trace
- parent operation `request.root`
- many additional non-matching spans per trace

This stresses the current search path that:

1. finds matching span ids
2. loads all spans for every matching trace
3. rebuilds full span items for all spans in those traces
4. filters back down to the original matching rows

## Files In Scope

- `src/services/TelemetryStore.ts`
- `scripts/bench-search-spans.ts`

## Likely Hypothesis

`searchSpans` is over-fetching and over-parsing because it reconstructs every span in matching traces when the result only needs the matched spans plus a small amount of context.

## Baseline

Measured on 2026-04-18 with:

```bash
bun run bench:search-spans --warmups 1 --iterations 5
```

on:

- `250` traces
- `48` spans per trace
- `100` requested results

Initial median:

- `search_spans_ms = 4135.5ms`

## First Keep

Changed `searchSpans` to:

- fetch candidate `SpanRow`s directly instead of only ids
- avoid loading every span in every matching trace
- resolve root operation, parent operation, and depth lazily for only the matched rows
- reuse a prepared parent-context lookup query

Current median after the change:

- `search_spans_ms = 3945.0ms`

This is a real win, but still leaves `searchSpans` far too slow.

## Second Keep

Changed the read path and query shape further:

1. switched read queries onto readonly query services instead of the writer store
2. rewrote the FTS operation filter from a correlated `EXISTS (...) MATCH ?` predicate to an FTS-first join:

```sql
INNER JOIN (
  SELECT trace_id, span_id
  FROM span_operation_fts
  WHERE span_operation_fts MATCH ?
) AS span_operation_match
ON span_operation_match.trace_id = s.trace_id
AND span_operation_match.span_id = s.span_id
```

Current median after those changes:

- `search_spans_ms = 2373.5ms`

This is the architectural win over the earlier `3945.0ms` result.

## Third Keep

Changed the FTS filter shape in `TelemetryStore.searchSpans` from a correlated predicate:

```sql
EXISTS (
  SELECT 1
  FROM span_operation_fts
  WHERE span_operation_fts.trace_id = s.trace_id
    AND span_operation_fts.span_id = s.span_id
    AND span_operation_fts MATCH ?
)
```

to an FTS-first join:

```sql
INNER JOIN (
  SELECT trace_id, span_id
  FROM span_operation_fts
  WHERE span_operation_fts MATCH ?
) AS span_operation_match
ON span_operation_match.trace_id = s.trace_id
AND span_operation_match.span_id = s.span_id
```

Current median after the join rewrite on the readonly path:

- `search_spans_ms = 3.6ms`

This is the dramatic win.

## Root Cause

The dominant problem was not JS span reconstruction alone. It was the SQL plan shape:

- the old correlated `EXISTS` FTS predicate caused SQLite to do far more work than necessary
- using the writer store for read-heavy queries made it worse
- once reads moved to the readonly query path and the query started from the FTS match set, latency collapsed from seconds to single-digit milliseconds on the benchmark dataset

## Next Best Hypothesis

The next worthwhile target is probably no longer `searchSpans`. Better candidates are:

- `searchTraceSummaries` if it uses a similar FTS predicate shape
- trace/log stats endpoints
- refresh-driven trace list queries
