import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createDaemonManager } from "../src/daemon.js"

type Sample = {
	readonly totalMs: number
	readonly daemonMs: number
	readonly tuiMs: number
	readonly phases: Readonly<Record<string, number>>
}

const repoRoot = path.resolve(import.meta.dir, "..")
const paintMarkers = ["MOTEL", "TRACES", "TRACE DETAILS"]

const parseNumberArg = (name: string, fallback: number) => {
	const index = process.argv.indexOf(name)
	if (index === -1) return fallback
	const value = Number(process.argv[index + 1])
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

const randomPort = () => 32000 + Math.floor(Math.random() * 10000)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length

const median = (values: readonly number[]) => {
	const sorted = [...values].sort((a, b) => a - b)
	const middle = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 0
		? (sorted[middle - 1]! + sorted[middle]!) / 2
		: sorted[middle]!
}

const mad = (values: readonly number[]) => {
	const center = median(values)
	const deviations = values.map((value) => Math.abs(value - center))
	return median(deviations)
}

const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

const readText = (filePath: string) => {
	try {
		return fs.readFileSync(filePath, "utf8")
	} catch {
		return ""
	}
}

const phasePattern = /\[motel-startup\]\s+(\S+)\s+([0-9.]+)ms/g

const parseStartupPhases = (text: string) => {
	const phases: Record<string, number> = {}
	for (const match of text.matchAll(phasePattern)) {
		const [, phase, value] = match
		const parsed = Number(value)
		if (phase && Number.isFinite(parsed)) phases[phase] = parsed
	}
	return phases
}

const waitForPaint = async (logPath: string, pid: number, timeoutMs: number) => {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const content = readText(logPath)
		if (paintMarkers.every((marker) => content.includes(marker))) return
		if (!isAlive(pid)) {
			throw new Error(`TUI process ${pid} exited before first paint.\n${content}`)
		}
		await sleep(25)
	}
	throw new Error(`Timed out waiting for motel TUI first paint.\n${readText(logPath)}`)
}

const stopProcess = async (proc: Bun.Subprocess) => {
	if (proc.killed || !isAlive(proc.pid)) return
	proc.kill("SIGTERM")
	const exited = await Promise.race([proc.exited.then(() => true), sleep(1000).then(() => false)])
	if (!exited && isAlive(proc.pid)) {
		proc.kill("SIGKILL")
		await proc.exited.catch(() => undefined)
	}
}

const runOne = async (): Promise<Sample> => {
	const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "motel-bench-cold-start-"))
	const databasePath = path.join(runtimeDir, "telemetry.sqlite")
	const port = randomPort()
	const logPath = path.join(runtimeDir, "tui.log")
	const manager = createDaemonManager({
		repoRoot,
		workdir: repoRoot,
		runtimeDir,
		databasePath,
		port,
	})

	const env = {
		...process.env,
		TERM: process.env.TERM ?? "xterm-256color",
		MOTEL_BENCH_STARTUP_PHASES: "1",
		MOTEL_OTEL_BASE_URL: `http://127.0.0.1:${port}`,
		MOTEL_OTEL_QUERY_URL: `http://127.0.0.1:${port}`,
		MOTEL_OTEL_EXPORTER_URL: `http://127.0.0.1:${port}/v1/traces`,
		MOTEL_OTEL_LOGS_EXPORTER_URL: `http://127.0.0.1:${port}/v1/logs`,
		MOTEL_OTEL_PORT: String(port),
		MOTEL_OTEL_DB_PATH: databasePath,
	}

	const startedAt = performance.now()
	let daemonMs = 0
	let tuiProc: Bun.Subprocess | null = null

	try {
		await Effect.runPromise(manager.ensure)
		daemonMs = performance.now() - startedAt

		tuiProc = Bun.spawn({
			cmd: ["script", "-q", logPath, process.execPath, "run", "src/index.tsx"],
			cwd: repoRoot,
			env,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		})

		await waitForPaint(logPath, tuiProc.pid, 5_000)
		const phases = parseStartupPhases(readText(logPath))

		const totalMs = performance.now() - startedAt
		return {
			totalMs,
			daemonMs,
			tuiMs: totalMs - daemonMs,
			phases,
		}
	} finally {
		if (tuiProc) await stopProcess(tuiProc)
		await Effect.runPromise(manager.stop).catch(() => undefined)
		fs.rmSync(runtimeDir, { recursive: true, force: true })
	}
}

const warmups = parseNumberArg("--warmups", 1)
const iterations = parseNumberArg("--iterations", 5)

const summarize = (label: string, values: readonly number[]) => {
	const bestMs = Math.min(...values)
	const worstMs = Math.max(...values)
	const medianMs = median(values)
	const meanMs = mean(values)
	const madMs = mad(values)

	console.log(`${label}:`)
	console.log(`  median ${medianMs.toFixed(1)}ms`)
	console.log(`  mean   ${meanMs.toFixed(1)}ms`)
	console.log(`  best   ${bestMs.toFixed(1)}ms`)
	console.log(`  worst  ${worstMs.toFixed(1)}ms`)
	console.log(`  mad    ${madMs.toFixed(1)}ms`)

	return { bestMs, worstMs, medianMs, meanMs, madMs }
}

const summarizePhase = (label: string, samples: readonly Sample[]) => {
	const values = samples.map((sample) => sample.phases[label]).filter((value): value is number => Number.isFinite(value))
	if (values.length === 0) return null
	return summarize(label, values)
}

const main = async () => {
	const totalRuns = warmups + iterations
	const samples: Sample[] = []

	console.log(`Benchmarking motel cold start (${warmups} warmup, ${iterations} measured)`)
	for (let index = 0; index < totalRuns; index++) {
		const sample = await runOne()
		samples.push(sample)
		const phase = index < warmups ? "warmup" : `run ${index - warmups + 1}`
		console.log(`${phase}: total ${sample.totalMs.toFixed(1)}ms | daemon ${sample.daemonMs.toFixed(1)}ms | tui ${sample.tuiMs.toFixed(1)}ms`)
	}

	const measured = samples.slice(warmups)
	const total = summarize("total", measured.map((sample) => sample.totalMs))
	const daemon = summarize("daemon", measured.map((sample) => sample.daemonMs))
	const tui = summarize("tui", measured.map((sample) => sample.tuiMs))
	const renderer = summarizePhase("renderer_ready", measured)
	const renderCalled = summarizePhase("root_render_called", measured)
	const appRendered = summarizePhase("app_render_started", measured)
	const appReady = summarizePhase("app_render_ready", measured)

	console.log("")
	console.log(`METRIC motel_cold_start_ms=${total.medianMs.toFixed(3)}`)
	console.log(`METRIC motel_cold_start_mad_ms=${total.madMs.toFixed(3)}`)
	console.log(`METRIC motel_daemon_phase_ms=${daemon.medianMs.toFixed(3)}`)
	console.log(`METRIC motel_tui_phase_ms=${tui.medianMs.toFixed(3)}`)
	if (renderer) console.log(`METRIC motel_renderer_ready_ms=${renderer.medianMs.toFixed(3)}`)
	if (renderCalled) console.log(`METRIC motel_root_render_called_ms=${renderCalled.medianMs.toFixed(3)}`)
	if (appRendered) console.log(`METRIC motel_app_render_started_ms=${appRendered.medianMs.toFixed(3)}`)
	if (appReady) console.log(`METRIC motel_app_render_ready_ms=${appReady.medianMs.toFixed(3)}`)
}

await main()
