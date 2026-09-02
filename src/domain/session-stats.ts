import type { HistoryEntry } from '../gateway/gateway-wire.js'
import { elapsedTurnDuration, projectTurnDurations } from './turn-duration.js'

/**
 * Lightweight, deterministic per-session activity summary. The authoritative
 * source is the harness's whole-log `sessionStats` projection; the local
 * window fold below is only a fallback and must be labelled as window-scoped.
 * Token totals are not aggregated here: the harness already projects an
 * authoritative per-session `tokenUsage`, which the workbench surfaces
 * separately. Keeping this projection free of wallet math means it is
 * trivially testable and never depends on pricing.
 */
export interface SessionStatsView {
  /** The number of distinct turns. */
  readonly turns: number
  /** Cumulative wall-clock milliseconds (model + tool time for the projection). */
  readonly durationMs: number
  /** True when the numbers come from the locally loaded history window only. */
  readonly windowScoped?: boolean
}

/**
 * Validates the harness's whole-log `sessionStats` projection. `durationMs`
 * sums `llmMs` (model generation) and `toolMs` (tool execution); the
 * first-token and decode breakdowns are components of those figures, so they
 * are not added again.
 */
export function projectionSessionStats(value: unknown): SessionStatsView | undefined {
  if (!isRecord(value)) return undefined
  const turns = value.turns
  const llmMs = value.llmMs
  const toolMs = value.toolMs
  if (!isCount(turns) || !isDuration(llmMs) || !isDuration(toolMs)) return undefined
  return { turns, durationMs: llmMs + toolMs }
}

/**
 * Projects the event history into a turn count and cumulative duration. Running
 * turns contribute their elapsed time up to `now`, so a live session shows a
 * ticking total; completed turns contribute a stable value. Marked
 * `windowScoped` because it only covers the currently loaded history page.
 */
export function projectSessionStats(
  entries: readonly HistoryEntry[],
  now = Date.now(),
): SessionStatsView {
  const durations = projectTurnDurations(entries)
  let durationMs = 0
  for (const duration of durations.values()) {
    durationMs += elapsedTurnDuration(duration, now)
  }
  return { turns: durations.size, durationMs, windowScoped: true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
