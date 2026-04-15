#!/usr/bin/env bun
import { BunRuntime, BunStdio } from "@effect/platform-bun"
import { Effect, Layer, Logger, Schema } from "effect"
import { McpServer, Tool, Toolkit } from "effect/unstable/ai"
import { TraceSpanStatus } from "./domain.js"
import { MotelClient, MotelClientLive } from "./motelClient.js"
import { Locator, LocatorLive } from "./locator.js"

const Attributes = Schema.optional(
	Schema.Record(Schema.String, Schema.String).annotate({
		description:
			"Arbitrary OTel attribute filters. Key is the attribute name WITHOUT the 'attr.' prefix (it is added for you). Values must be strings.",
	}),
)

const Lookback = Schema.optional(
	Schema.String.annotate({
		description:
			"Time window to look back, e.g. '15m', '1h', '6h', '1d'. Max 24h. Default 60m.",
	}),
)

const Limit = Schema.optional(
	Schema.Number.annotate({ description: "Max items to return in this page. Tool defaults apply." }),
)

const Cursor = Schema.optional(
	Schema.String.annotate({
		description:
			"Opaque pagination cursor from a previous response's meta.nextCursor. Pass it back to fetch the next page.",
	}),
)

const ServiceParam = Schema.optional(
	Schema.String.annotate({ description: "Filter by OTel service name (e.g. 'opencode', 'my-app')." }),
)

const Status = Schema.optional(
	TraceSpanStatus.annotate({
		description:
			"Filter by trace health. 'error' = at least one span errored. 'ok' = no errors.",
	}),
)

const StatusTool = Tool.make("motel_status", {
	description:
		"Check which motel instance this shim is connected to. Call this FIRST if any other tool errors, to confirm the connection. Returns url, version, workdir, whether the cwd matches, and how many motel instances are running on this machine.",
	parameters: Tool.EmptyParams,
	success: Schema.Struct({
		connected: Schema.Boolean,
		url: Schema.optional(Schema.String),
		version: Schema.optional(Schema.String),
		workdir: Schema.optional(Schema.String),
		cwdMatch: Schema.optional(Schema.Boolean),
		instanceCount: Schema.optional(Schema.Number),
		source: Schema.optional(Schema.String),
		error: Schema.optional(Schema.String),
	}),
}).annotate(Tool.Readonly, true)

const ServicesTool = Tool.make("motel_services", {
	description:
		"List every OTel service name that has emitted traces or logs recently. Use this to discover what's being observed before narrowing down with motel_search_traces or motel_search_logs.",
	parameters: Tool.EmptyParams,
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const FacetsTool = Tool.make("motel_facets", {
	description:
		"Return distinct values and counts for a given field, so the agent can see what data exists before filtering. For traces, valid fields include 'service', 'operation', 'status'. For logs, 'service', 'severity', 'scope'. Supports attr.<key> fields too.",
	parameters: Schema.Struct({
		type: Schema.Literals(["traces", "logs"]).annotate({
			description: "Which dataset to facet.",
		}),
		field: Schema.String.annotate({
			description: "The column or attr.<key> to return distinct values for.",
		}),
		service: ServiceParam,
		lookback: Lookback,
		limit: Limit,
	}),
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const SearchTracesTool = Tool.make("motel_search_traces", {
	description:
		"Search distributed traces by service, operation, error status, minimum duration, time window, and arbitrary OTel attributes. Returns compact trace summaries with traceId, duration, error count, span count, and a nextCursor. Drill into a specific trace with motel_get_trace. For 'what just broke' investigations, pass status='error' with a short lookback like '15m'.",
	parameters: Schema.Struct({
		service: ServiceParam,
		operation: Schema.optional(
			Schema.String.annotate({ description: "Substring match on span operation name." }),
		),
		status: Status,
		minDurationMs: Schema.optional(
			Schema.Number.annotate({ description: "Only return traces slower than this (ms)." }),
		),
		attributes: Attributes,
		lookback: Lookback,
		limit: Limit,
		cursor: Cursor,
	}),
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const GetTraceTool = Tool.make("motel_get_trace", {
	description:
		"Fetch a single trace by its 32-character hex traceId, including the full span tree ordered parent-first. Use this to drill into a trace found via motel_search_traces. For the logs emitted inside this trace, use motel_get_trace_logs instead.",
	parameters: Schema.Struct({
		traceId: Schema.String.annotate({ description: "Full 32-character hex trace ID." }),
	}),
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const GetTraceLogsTool = Tool.make("motel_get_trace_logs", {
	description:
		"Fetch log records correlated with a specific trace, across all spans. When investigating a failing trace, call this before motel_search_logs — it is the most scoped and usually the most informative log view.",
	parameters: Schema.Struct({
		traceId: Schema.String.annotate({ description: "Full 32-character hex trace ID." }),
		lookback: Lookback,
		limit: Limit,
		cursor: Cursor,
	}),
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const SearchLogsTool = Tool.make("motel_search_logs", {
	description:
		"Search logs by service, trace/span correlation, body substring, time window, and arbitrary OTel attributes. Returns log entries with a nextCursor. For logs tied to a known traceId, prefer motel_get_trace_logs — it is more focused.",
	parameters: Schema.Struct({
		service: ServiceParam,
		traceId: Schema.optional(
			Schema.String.annotate({ description: "Filter by trace ID." }),
		),
		spanId: Schema.optional(
			Schema.String.annotate({ description: "Filter by span ID." }),
		),
		body: Schema.optional(
			Schema.String.annotate({ description: "Substring match on log body (case-sensitive)." }),
		),
		attributes: Attributes,
		lookback: Lookback,
		limit: Limit,
		cursor: Cursor,
	}),
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const TraceStatsTool = Tool.make("motel_traces_stats", {
	description:
		"Aggregate statistics across traces: count, average duration, p95 duration, or error rate, grouped by a field like service, operation, status, or attr.<key>. Use this BEFORE paginating raw traces when you want to understand the shape of the data — for example 'what tools are the slowest' or 'which services are erroring'.",
	parameters: Schema.Struct({
		groupBy: Schema.String.annotate({
			description: "Grouping dimension. Examples: 'service', 'operation', 'status', 'attr.tool.name'.",
		}),
		agg: Schema.Literals(["count", "avg_duration", "p95_duration", "error_rate"]),
		service: ServiceParam,
		operation: Schema.optional(Schema.String),
		status: Status,
		minDurationMs: Schema.optional(Schema.Number),
		attributes: Attributes,
		lookback: Lookback,
		limit: Limit,
	}),
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const LogStatsTool = Tool.make("motel_logs_stats", {
	description:
		"Group and count logs by a field like 'severity', 'service', 'scope', or 'attr.<key>'. Useful for quickly understanding log-level distribution (e.g. how many ERROR logs there are in the last hour) before drilling into individual entries.",
	parameters: Schema.Struct({
		groupBy: Schema.String.annotate({
			description: "Grouping dimension. Examples: 'service', 'severity', 'scope', 'attr.session.id'.",
		}),
		service: ServiceParam,
		traceId: Schema.optional(Schema.String),
		spanId: Schema.optional(Schema.String),
		body: Schema.optional(Schema.String),
		attributes: Attributes,
		lookback: Lookback,
		limit: Limit,
	}),
	success: Schema.Unknown,
}).annotate(Tool.Readonly, true)

const MotelToolkit = Toolkit.make(
	StatusTool,
	ServicesTool,
	FacetsTool,
	SearchTracesTool,
	GetTraceTool,
	GetTraceLogsTool,
	SearchLogsTool,
	TraceStatsTool,
	LogStatsTool,
)

const asResult = <A>(effect: Effect.Effect<A, { readonly message: string }>) =>
	Effect.match(effect, {
		onFailure: (err) => ({ error: err.message }) as unknown,
		onSuccess: (value) => value as unknown,
	})

const ToolHandlers = MotelToolkit.toLayer(
	Effect.gen(function* () {
		const client = yield* MotelClient
		const locator = yield* Locator

		return {
			motel_status: () =>
				Effect.match(locator.resolve, {
					onFailure: (err) => ({
						connected: false as const,
						error: err instanceof Error ? err.message : String(err),
					}),
					onSuccess: (r) => ({
						connected: true as const,
						url: r.url,
						version: r.version,
						workdir: r.workdir,
						cwdMatch: r.cwdMatch,
						instanceCount: r.instanceCount,
						source: r.source,
					}),
				}),

			motel_services: () => asResult(client.services),

			motel_facets: (input) => asResult(client.facets(input)),

			motel_search_traces: (input) => asResult(client.searchTraces(input)),

			motel_get_trace: ({ traceId }) => asResult(client.getTrace(traceId)),

			motel_get_trace_logs: ({ traceId, lookback, limit, cursor }) =>
				asResult(client.getTraceLogs(traceId, { lookback, limit, cursor })),

			motel_search_logs: (input) => asResult(client.searchLogs(input)),

			motel_traces_stats: (input) => asResult(client.traceStats(input)),

			motel_logs_stats: (input) => asResult(client.logStats(input)),
		}
	}),
)

const ServerLayer = McpServer.toolkit(MotelToolkit).pipe(
	Layer.provideMerge(ToolHandlers),
	Layer.provide(MotelClientLive),
	Layer.provide(LocatorLive),
	Layer.provide(
		McpServer.layerStdio({
			name: "motel",
			version: "0.1.0",
		}),
	),
	Layer.provide(BunStdio.layer),
	Layer.provide(Logger.layer([Logger.consolePretty({ stderr: true })])),
)

Layer.launch(ServerLayer).pipe(BunRuntime.runMain)
