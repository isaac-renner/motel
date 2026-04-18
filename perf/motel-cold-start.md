# Motel Cold Start

## Goal

Reduce full `motel` cold start time for the user-visible path, not just daemon readiness.

## Benchmark

```bash
bun run bench:motel-cold-start --warmups 1 --iterations 5
```

## Metrics

- `motel_cold_start_ms`
- `motel_cold_start_mad_ms`
- `motel_daemon_phase_ms`
- `motel_tui_phase_ms`

## What It Measures

One cold-start run does this:

1. start a fresh managed daemon on a temp runtime dir and random port
2. spawn the TUI under a PTY
3. wait for the first visible frame markers in the PTY log
4. stop the TUI and daemon

This is intentionally closer to `motel` than the daemon-only benchmark.

## Current Baseline

Initial measurement on 2026-04-18 with `--warmups 1 --iterations 3`:

- total median: `624.3ms`
- daemon median: `309.1ms`
- TUI median: `315.2ms`

After reducing the daemon startup poll interval from `150ms` to `25ms`, measured with `--warmups 1 --iterations 7`:

- total median: `507.0ms`
- daemon median: `194.2ms`
- TUI median: `313.6ms`

That is the first clear keep-worthy cold-start win.

## Startup Markers

The cold-start benchmark can also emit internal startup markers from the TUI process:

- `motel_renderer_ready_ms`
- `motel_root_render_called_ms`
- `motel_app_render_started_ms`
- `motel_app_render_ready_ms`

Current medians after the daemon poll win:

- renderer ready: `15.1ms`
- root render called: `16.1ms`
- app render started: `26.1ms`
- app render ready: `28.4ms`

Interpretation:

- the remaining TUI slice is not dominated by synchronous `App` render logic
- the earlier large cold-start win came from daemon startup polling, not React/TUI code
- future startup work should be skeptical of app-level micro-optimizations unless new evidence says otherwise

## Files In Scope

- `src/daemon.ts`
- `src/index.tsx`
- `src/App.tsx`
- `src/ui/app/useTraceScreenData.ts`
- `src/ui/app/TraceWorkspace.tsx`

## Likely Next Hypotheses

1. the benchmark's PTY/log observation may still be paying some terminal flush overhead beyond in-process render markers
2. initial trace loading or follow-up rerenders may still be causing the slower `~340ms` TUI outliers
3. the next highest-value optimization target may now be trace refresh/search latency rather than cold start

## Guardrails

- keep the benchmark PTY-based so it still measures the real TUI path
- keep the temp runtime dir and random port isolation
- rerun `bun run typecheck` after changes
