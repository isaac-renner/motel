import { memo, useLayoutEffect, useRef, useState } from "react"
import { isAiSpan, type LogItem, type TraceItem, type TraceSpanItem } from "../domain.ts"
import { formatDuration, lifecycleLabel, splitDuration, truncateText } from "./format.ts"
import { BlankRow, TextLine } from "./primitives.tsx"
import { colors, waterfallColors } from "./theme.ts"

/** Filter spans to only those visible given a set of collapsed span IDs. */
export const getVisibleSpans = (spans: readonly TraceSpanItem[], collapsedIds: ReadonlySet<string>): readonly TraceSpanItem[] => {
	if (collapsedIds.size === 0) return spans
	const result: TraceSpanItem[] = []
	let skipDepth = -1
	for (const span of spans) {
		if (skipDepth >= 0 && span.depth > skipDepth) continue
		skipDepth = -1
		result.push(span)
		if (collapsedIds.has(span.spanId)) {
			skipDepth = span.depth
		}
	}
	return result
}

/** Find the index of a span's parent in the visible list. */
export const findParentIndex = (spans: readonly TraceSpanItem[], index: number): number | null => {
	const span = spans[index]
	if (!span || span.depth === 0) return null
	for (let i = index - 1; i >= 0; i--) {
		if (spans[i]!.depth < span.depth) return i
	}
	return null
}

/** Find the index of a span's first child in the visible list. */
export const findFirstChildIndex = (spans: readonly TraceSpanItem[], index: number): number | null => {
	const span = spans[index]
	const next = spans[index + 1]
	if (span && next && next.depth > span.depth) return index + 1
	return null
}

const INTERESTING_TAGS = [
	"http.method", "http.url", "http.status_code", "http.route",
	"db.system", "db.statement", "db.name",
	"messaging.system", "messaging.destination",
	"error", "error.message",
	"net.peer.name", "net.peer.port",
] as const

const buildTreePrefix = (spans: readonly TraceSpanItem[], index: number): string => {
	const span = spans[index]
	if (span.depth === 0) return ""

	const parts: string[] = []

	const isLastChild = (spanIndex: number, depth: number): boolean => {
		for (let i = spanIndex + 1; i < spans.length; i++) {
			if (spans[i].depth < depth) return true
			if (spans[i].depth === depth) return false
		}
		return true
	}

	parts.push(isLastChild(index, span.depth) ? "\u2514\u2500" : "\u251c\u2500")

	for (let d = span.depth - 1; d >= 1; d--) {
		let parentIndex = index
		for (let i = index - 1; i >= 0; i--) {
			if (spans[i].depth === d) {
				parentIndex = i
				break
			}
			if (spans[i].depth < d) break
		}
		parts.push(isLastChild(parentIndex, d) ? "  " : "\u2502 ")
	}

	return parts.reverse().join("")
}

const PARTIAL_BLOCKS = ["", "\u258f", "\u258e", "\u258d", "\u258c", "\u258b", "\u258a", "\u2589", "\u2588"] as const
const ULTRA_SHORT_MARKERS = ["\u258f", "\u258e", "\u258d", "\u258c"] as const

type WaterfallBarSegment = {
	readonly text: string
	readonly fg: string
	readonly bg?: string
}

const renderWaterfallBar = (
	span: TraceSpanItem,
	trace: TraceItem,
	barWidth: number,
	barColor: string,
	laneColor: string,
	rowBg: string,
): { readonly segments: readonly WaterfallBarSegment[] } => {
	// Timeline semantics: the leading gap (before the bar starts) is the
	// "runway" showing how long after trace start this span kicked in — render
	// it in the lane color. The trailing gap (after the bar ends) is post-span
	// dead time — render it in the row bg so it visually disappears.
	if (barWidth < 3 || trace.durationMs === 0) {
		const trailing = Math.max(0, barWidth - 1)
		const segs: WaterfallBarSegment[] = [{ text: "\u2588", fg: barColor }]
		if (trailing > 0) segs.push({ text: " ".repeat(trailing), fg: rowBg, bg: rowBg })
		return { segments: segs }
	}

	const traceStart = trace.startedAt.getTime()
	const spanStart = span.startTime.getTime()
	const relativeStart = Math.max(0, spanStart - traceStart)
	const startFrac = relativeStart / trace.durationMs
	const endFrac = Math.min(1, Math.max(startFrac, (relativeStart + Math.max(0, span.durationMs)) / trace.durationMs))
	const totalUnits = barWidth * 8
	const startUnits = Math.max(0, Math.min(totalUnits - 1, Math.floor(startFrac * totalUnits)))
	const endUnits = Math.max(startUnits + 1, Math.min(totalUnits, Math.ceil(endFrac * totalUnits)))
	const startCell = Math.floor(startUnits / 8)
	const endCell = Math.floor((endUnits - 1) / 8)
	const startOffset = startUnits % 8
	const endOffset = endUnits % 8
	const segments: WaterfallBarSegment[] = []

	const pushLeading = (cells: number) => {
		if (cells > 0) segments.push({ text: " ".repeat(cells), fg: laneColor, bg: laneColor })
	}
	const pushTrailing = (cells: number) => {
		if (cells > 0) segments.push({ text: " ".repeat(cells), fg: rowBg, bg: rowBg })
	}

	pushLeading(startCell)

	if (startCell === endCell) {
		const singleCellUnits = Math.max(1, endUnits - startUnits)
		if (singleCellUnits <= 4) {
			const centeredMarker = ULTRA_SHORT_MARKERS[Math.max(0, singleCellUnits - 1)] ?? "\u258f"
			// The marker is a left-aligned sliver — the rest of the cell is
			// post-bar space, so it uses the row bg (transparent) rather than
			// carrying the dark lane track past where the span ended.
			segments.push({ text: centeredMarker, fg: barColor, bg: rowBg })
			pushTrailing(Math.max(0, barWidth - startCell - 1))
			return { segments }
		}

		if (startOffset === 0) {
			// Bar fills from the left of the cell; post-bar pixels fall to row bg.
			segments.push({ text: PARTIAL_BLOCKS[singleCellUnits], fg: barColor, bg: rowBg })
		} else {
			// Bar starts partway into the cell; left pixels are lane, right is bar.
			segments.push({ text: PARTIAL_BLOCKS[startOffset], fg: laneColor, bg: barColor })
		}
		pushTrailing(Math.max(0, barWidth - startCell - 1))
		return { segments }
	}

	if (startOffset > 0) {
		// Leading partial: left portion is lane (runway), right is bar.
		segments.push({ text: PARTIAL_BLOCKS[startOffset], fg: laneColor, bg: barColor })
	}

	const fullStartCell = startCell + (startOffset > 0 ? 1 : 0)
	const fullEndCell = endCell - (endOffset > 0 ? 1 : 0)
	const fullCells = Math.max(0, fullEndCell - fullStartCell + 1)
	if (fullCells > 0) {
		segments.push({ text: "\u2588".repeat(fullCells), fg: barColor })
	}

	if (endOffset > 0) {
		// Trailing partial: left portion is bar, right is row bg (transparent).
		segments.push({ text: PARTIAL_BLOCKS[endOffset], fg: barColor, bg: rowBg })
	}

	pushTrailing(Math.max(0, barWidth - endCell - 1))
	return { segments }
}

const durationColor = (durationMs: number) => {
	if (durationMs >= 10_000) return colors.warning
	if (durationMs >= 1_000) return colors.accent
	if (durationMs >= 100) return colors.count
	if (durationMs > 0) return colors.muted
	return colors.muted
}

export const getWaterfallLayout = (contentWidth: number, suffixWidth: number) => {
	// Reserve the two single-space gaps (label↔bar, bar↔suffix) and the
	// duration suffix up-front, then split the remaining width between
	// label (up to 50%, capped at 32) and the bar. Crucially the bar is
	// only guaranteed ≥1 cell — forcing a min of 6 like we used to would
	// push the total past contentWidth at narrow widths and OpenTUI's
	// `<text truncate>` would then append "..." as an overflow suffix.
	// Better to let the bar shrink than to smear ellipses across rows.
	const gapsAndSuffix = suffixWidth + 2
	const remaining = Math.max(4, contentWidth - gapsAndSuffix)
	const labelMaxWidth = Math.max(4, Math.min(Math.floor(remaining * 0.5), 32))
	const barWidth = Math.max(1, contentWidth - labelMaxWidth - gapsAndSuffix)
	return { labelMaxWidth, barWidth } as const
}

export type WaterfallSuffixMetrics = {
	readonly maxDurationWidth: number
	readonly suffixWidth: number
}

/**
 * Compute a shared suffix (duration) width from the visible viewport.
 * Reserving the width once keeps every row's duration right-aligned on the
 * same column regardless of per-row content. Log correlation lives in the
 * span detail pane, not the row suffix.
 */
export const getWaterfallSuffixMetrics = (
	spans: readonly { readonly durationMs: number; readonly spanId: string }[],
): WaterfallSuffixMetrics => {
	let maxDurationWidth = 0
	for (const span of spans) {
		const d = formatDuration(Math.max(0, span.durationMs)).length
		if (d > maxDurationWidth) maxDurationWidth = d
	}
	return { maxDurationWidth, suffixWidth: maxDurationWidth }
}

// Retained for tests: per-row view of the shared layout.
export const getWaterfallColumns = (
	contentWidth: number,
	metrics: WaterfallSuffixMetrics,
) => {
	const { labelMaxWidth, barWidth } = getWaterfallLayout(contentWidth, metrics.suffixWidth)
	return { labelMaxWidth, barWidth, suffixWidth: metrics.suffixWidth } as const
}

export const spanPreviewEntries = (span: TraceSpanItem, logs: readonly LogItem[], maxEntries: number): Array<{ key: string; value: string; isWarning?: boolean }> => {
	const entries = Object.entries(span.tags)
	const interesting = entries.filter(([key]) =>
		INTERESTING_TAGS.includes(key as (typeof INTERESTING_TAGS)[number]) || key.startsWith("error"),
	)
	const rest = entries.filter(([key]) =>
		!INTERESTING_TAGS.includes(key as (typeof INTERESTING_TAGS)[number]) && !key.startsWith("error") && !key.startsWith("otel.") && key !== "span.kind",
	)
	const tagResults: Array<{ key: string; value: string; isWarning?: boolean }> = []
	if (logs.length > 0) {
		tagResults.push({ key: "logs", value: `${logs.length} correlated` })
		tagResults.push({ key: "log", value: logs[0]!.body.replace(/\s+/g, " ") })
	}

	tagResults.push(...[...interesting, ...rest]
		.slice(0, maxEntries - span.warnings.length)
		.map(([key, value]) => ({ key, value })))
	for (const warning of span.warnings) {
		tagResults.push({ key: "warning", value: warning, isWarning: true })
	}
	return tagResults.slice(0, maxEntries)
}

const WaterfallRow = memo(({
	span,
	trace,
	index,
	spans,
	contentWidth,
	selected,
	collapsed,
	hasChildSpans,
	suffixMetrics,
	dimmed,
	onSelect,
}: {
	span: TraceSpanItem
	trace: TraceItem
	index: number
	spans: readonly TraceSpanItem[]
	contentWidth: number
	selected: boolean
	collapsed: boolean
	hasChildSpans: boolean
	suffixMetrics: WaterfallSuffixMetrics
	dimmed: boolean
	onSelect: () => void
}) => {
	const prefix = buildTreePrefix(spans, index)
	const isAi = isAiSpan(span.tags)
	// Indicator column: `!` on error, chevron on collapsible parents,
	// `✦` on AI leaves (LLM payloads detected — enter drills into a
	// specialized chat view), `·` on other leaves. AI parents keep the
	// chevron glyph so tree structure stays readable; the accent color
	// (applied below) carries the "AI content lives here" signal.
	const indicator = span.status === "error" ? "!"
		: hasChildSpans ? (collapsed ? "\u25b8" : "\u25be")
		: isAi ? "\u2726"
		: "\u00b7"
	const opName = span.isRunning ? `${span.operationName} [${lifecycleLabel(span)}]` : span.operationName

	const { labelMaxWidth, barWidth } = getWaterfallLayout(contentWidth, suffixMetrics.suffixWidth)

	// Op name budget = labelMaxWidth minus (prefix + indicator + 1 space).
	// Never force a minimum: at very deep nesting or narrow widths the
	// prefix + indicator may already fill the label column, in which
	// case we render the op as an empty string (or a lone ellipsis) so
	// the line stays within contentWidth. Previous code forced op to 4
	// chars which could push total row width past the pane and make
	// OpenTUI smear "..." across the right edge.
	const opMaxWidth = Math.max(0, labelMaxWidth - prefix.length - 2)
	const opTruncated = opMaxWidth === 0
		? ""
		: opName.length > opMaxWidth
			? `${opName.slice(0, Math.max(0, opMaxWidth - 1))}\u2026`
			: opName
	const labelLen = prefix.length + 2 + opTruncated.length
	const labelPad = " ".repeat(Math.max(0, labelMaxWidth - labelLen))

	const isError = span.status === "error"
	const barColor = selected ? (isError ? waterfallColors.barSelectedError : waterfallColors.barSelected) : isError ? waterfallColors.barError : waterfallColors.bar
	const laneColor = selected ? waterfallColors.barLane : waterfallColors.barBg
	const rowBg = selected ? colors.selectedBg : colors.screenBg
	const { segments } = renderWaterfallBar(span, trace, barWidth, barColor, laneColor, rowBg)
	const bg = selected ? colors.selectedBg : undefined
	// Dimmed rows (non-matching under an active waterfall filter) collapse
	// their palette to the muted separator color so matches stand out.
	// Selection always wins — the selected row keeps its full brightness
	// so you can still see where the cursor is while scanning.
	const treeColor = selected ? colors.separator : dimmed ? colors.separator : colors.treeLine
	const indicatorColor = selected ? colors.selectedText
		: dimmed ? colors.separator
		: isError ? colors.error
		// AI accent outranks parent/leaf color so both AI parents and AI
		// leaves scan as "there's an LLM payload here" from across the
		// waterfall. Error still wins because a failed AI span is first
		// and foremost a failure.
		: isAi ? colors.accent
		: hasChildSpans ? colors.muted
		: colors.passing
	const opColor = selected ? colors.selectedText
		: dimmed ? colors.separator
		: span.isRunning ? colors.warning
		: colors.text

	const durationFg = selected ? colors.selectedText : dimmed ? colors.separator : durationColor(span.durationMs)
	const unitFg = dimmed && !selected ? colors.separator : colors.muted

	// Split the duration so the unit (s/ms) renders dimmer than the number.
	const { number: durNumber, unit: durUnit } = splitDuration(Math.max(0, span.durationMs))
	const durationCell = `${durNumber}${durUnit}`
	const durationPad = " ".repeat(Math.max(0, suffixMetrics.maxDurationWidth - durationCell.length))

	return (
		<box height={1} onMouseDown={onSelect}>
			<TextLine bg={bg}>
				{prefix ? <span fg={treeColor}>{prefix}</span> : null}
				<span fg={indicatorColor}>{indicator}</span>
				<span fg={opColor}>{` ${opTruncated}`}</span>
				<span>{labelPad}</span>
				<span> </span>
				{segments.map((segment, index) => (
					<span key={`${span.spanId}-bar-${index}`} fg={segment.fg} bg={segment.bg}>{segment.text}</span>
				))}
				<span> </span>
				<span>{durationPad}</span>
				<span fg={durationFg}>{durNumber}</span>
				<span fg={unitFg}>{durUnit}</span>
			</TextLine>
		</box>
	)
})
WaterfallRow.displayName = "WaterfallRow"

export const SpanPreview = ({
	span,
	logs,
	contentWidth,
	maxLines,
}: {
	span: TraceSpanItem
	logs: readonly LogItem[]
	contentWidth: number
	maxLines: number
}) => {
	const entries = spanPreviewEntries(span, logs, maxLines)
	if (entries.length === 0) return null

	const maxKeyLen = Math.min(22, entries.reduce((max, e) => Math.max(max, e.key.length), 0))
	const valMaxWidth = Math.max(8, contentWidth - maxKeyLen - 3)
	const indent = " ".repeat(maxKeyLen + 2)

	const lines: Array<{ keyPart: string; valPart: string; isWarning?: boolean }> = []
	for (const entry of entries) {
		const keyStr = entry.key.length > maxKeyLen ? `${entry.key.slice(0, maxKeyLen - 1)}\u2026` : entry.key.padEnd(maxKeyLen)
		const val = entry.value
		if (val.length <= valMaxWidth) {
			lines.push({ keyPart: keyStr, valPart: val, isWarning: entry.isWarning })
		} else {
			let remaining = val
			let first = true
			while (remaining.length > 0) {
				const chunk = remaining.slice(0, valMaxWidth)
				remaining = remaining.slice(valMaxWidth)
				lines.push({ keyPart: first ? keyStr : indent, valPart: chunk, isWarning: entry.isWarning })
				first = false
			}
		}
	}

	return (
		<box flexDirection="column">
			{lines.slice(0, maxLines).map((line, i) => (
				<TextLine key={`preview-${i}`}>
					<span fg={line.isWarning ? colors.error : colors.previewKey}>{line.keyPart}</span>
					<span fg={colors.separator}>  </span>
					<span fg={line.isWarning ? colors.error : colors.muted}>{line.valPart}</span>
				</TextLine>
			))}
		</box>
	)
}

export const WaterfallTimeline = ({
	trace,
	filteredSpans,
	spanLogCounts,
	selectedSpanLogs,
	contentWidth,
	bodyLines,
	selectedSpanIndex,
	collapsedSpanIds,
	matchingSpanIds,
	onSelectSpan,
}: {
	trace: TraceItem
	filteredSpans: readonly TraceSpanItem[]
	spanLogCounts: ReadonlyMap<string, number>
	selectedSpanLogs: readonly LogItem[]
	contentWidth: number
	bodyLines: number
	selectedSpanIndex: number | null
	collapsedSpanIds: ReadonlySet<string>
	/**
	 * When set, spans whose spanId is NOT in this set are dimmed. Null
	 * means no filter active — skip the per-row lookup entirely.
	 */
	matchingSpanIds?: ReadonlySet<string> | null
	onSelectSpan: (index: number) => void
}) => {
	const selectedSpan = selectedSpanIndex !== null ? filteredSpans[selectedSpanIndex] ?? null : null

	const spanIndexById = new Map<string, number>()
	for (let i = 0; i < trace.spans.length; i++) {
		spanIndexById.set(trace.spans[i].spanId, i)
	}

	// Virtual windowing: only render visible rows. We track scroll offset
	// as state so the mouse wheel can scroll the window INDEPENDENTLY of
	// the selected span (mirrors TraceList behavior). Selection still
	// follows: if the user moves selection off-screen via j/k, we nudge
	// the window to keep it visible — but wheel-scrolling never changes
	// selection, only clicking a row does.
	const viewportSize = Math.max(1, bodyLines)
	const maxOffset = Math.max(0, filteredSpans.length - viewportSize)
	const [scrollOffset, setScrollOffset] = useState(0)
	const lastTraceIdRef = useRef<string | null>(null)

	// Reset scroll offset when the trace changes.
	if (trace.traceId !== lastTraceIdRef.current) {
		setScrollOffset(0)
		lastTraceIdRef.current = trace.traceId
	}

	// Auto-follow selection: only if the selected span would be hidden
	// by the current window, shift just enough to bring it back. Runs in
	// layout effect so the visible window is accurate on the same paint
	// that the selection changed.
	useLayoutEffect(() => {
		if (selectedSpanIndex === null) return
		setScrollOffset((current) => {
			if (selectedSpanIndex < current) return selectedSpanIndex
			if (selectedSpanIndex >= current + viewportSize) return selectedSpanIndex - viewportSize + 1
			return current
		})
	}, [selectedSpanIndex, viewportSize])

	const windowStart = Math.max(0, Math.min(scrollOffset, maxOffset))
	const windowSpans = filteredSpans.slice(windowStart, windowStart + viewportSize)
	const blankCount = Math.max(0, viewportSize - windowSpans.length)

	// One shared suffix width, measured from the current viewport, so every
	// row's duration cell lines up on the same right-edge column.
	const suffixMetrics = getWaterfallSuffixMetrics(windowSpans)

	// Mouse wheel scrolls the window without touching selection — matches
	// the trace list, so the user can browse ahead of their cursor freely
	// and click a row to commit. Delta is scaled 1:1 with opentui's wheel
	// reporting (1 notch ≈ 3 rows on most terminals).
	const handleWheel = (event: { scroll?: { direction: string; delta: number }; stopPropagation?: () => void }) => {
		const info = event.scroll
		if (!info || filteredSpans.length === 0) return
		const magnitude = Math.max(1, Math.round(info.delta))
		const signed = info.direction === "up" ? -magnitude : info.direction === "down" ? magnitude : 0
		if (signed === 0) return
		setScrollOffset((current) => Math.max(0, Math.min(current + signed, maxOffset)))
		event.stopPropagation?.()
	}

	return (
		<box flexDirection="column" onMouseScroll={handleWheel}>
			{windowSpans.map((span, index) => {
				const actualIndex = windowStart + index
				const fullIndex = spanIndexById.get(span.spanId) ?? -1
				const dimmed = matchingSpanIds != null && !matchingSpanIds.has(span.spanId)
				return (
					<WaterfallRow
						key={`${trace.traceId}-${span.spanId}`}
						span={span}
						trace={trace}
						index={fullIndex}
						spans={trace.spans}
						contentWidth={contentWidth}
						selected={selectedSpanIndex === actualIndex}
						collapsed={collapsedSpanIds.has(span.spanId)}
						hasChildSpans={fullIndex >= 0 && findFirstChildIndex(trace.spans, fullIndex) !== null}
						suffixMetrics={suffixMetrics}
						dimmed={dimmed}
						onSelect={() => onSelectSpan(actualIndex)}
					/>
				)
			})}
			{Array.from({ length: blankCount }, (_, i) => (
				<BlankRow key={`blank-${i}`} />
			))}
		</box>
	)
}
