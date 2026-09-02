/**
 * Gateway wire-type mapping for the dsh 0.1.2 Typert Remote protocol.
 *
 * dsh 0.1.2 replaced the host-apiproxy / client-connection domain clients
 * with the Typert Remote wire (unary `POST /api/<ns>/<method>` + the
 * `/api/remote.mux` WebSocket). This module is the single type seam that
 * keeps the old workbench vocabulary compiling against the new wire shapes:
 * names stay, sources change, and the handful of renamed fields are bridged
 * here so call sites keep their meaning.
 */
import type { PromptContentPart as WirePromptContentPart } from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  SessionControlFrame as WireControlFrame,
  SessionEventEntry,
  SessionFollowFrame as WireFollowFrame,
  SessionJob,
  SessionPage as WirePage,
  SessionQueuedItem,
  SessionSummary as WireSessionSummary,
  SkillEntry as WireSkillEntry,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  SubagentAddress as WireSubagentAddress,
  SubagentListEntry as WireSubagentListEntry,
} from '@deepseek-ai/dsh-subagent/client'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'

export type { SessionId } from '@deepseek-ai/dsh-session/types'
export type { RpcId, ConnectionRpcResult as RpcResult, ConnectionRpcFailure as RpcFailure } from '@deepseek-ai/dsh-client-connection'
export type { MessageId } from '@deepseek-ai/dsh-llm/brand'

/** One raw conversation event, as consumed by the workbench projections. */
export interface HistoryEntry {
  readonly event: SessionEvent
}

/** Session list row; `agentPreset` is an extension-side memo carried by the summary. */
export type SessionSummary = WireSessionSummary & { readonly agentPreset?: string }

/** Live queue row; content blocks are JSON-safe wire values. */
export type QueuedInboxItem = SessionQueuedItem

/** Background job row (session-controller renamed it `SessionJob`). */
export type JobView = SessionJob

/** Skill catalog entry (same shape, new home). */
export type SkillEntry = WireSkillEntry

/** Sub-agent catalog entry. */
export type SubagentListEntry = WireSubagentListEntry

/** Durable parent/child address selecting subagent transport. */
export type SubagentAddress = WireSubagentAddress

/** One prompt part accepted by the session/subagent prompt RPCs. */
export type PromptContentPart = WirePromptContentPart

/** Model catalog with the current selection carried on `current` (default + local memo). */
export type SessionModels = {
  readonly default: import('@deepseek-ai/dsh-api-session-controller/types').ModelSelection
  readonly current: import('@deepseek-ai/dsh-api-session-controller/types').ModelSelection
  readonly groups: readonly import('@deepseek-ai/dsh-api-session-controller/types').ModelProviderGroup[]
  readonly failures: readonly import('@deepseek-ai/dsh-api-session-controller/types').ModelCatalogFailure[]
  readonly routableProviders: readonly string[]
}

/** One session page (history) or follow snapshot record before chunk expansion. */
export type SessionHistoryRecord = SessionEventEntry | import('@deepseek-ai/dsh-api-session-controller/types').SessionChunkRun

/** One session event stream frame (snapshot + delta) from `session/follow`. */
export type FollowFrame = WireFollowFrame

/** Host-wide live state stream frame from `session/control`. */
export type ControlFrame = WireControlFrame

/** One backward history page. */
export type SessionPage = WirePage

/** Session-address discriminator (ordinary session or direct subagent child). */
export type SessionAddress = import('@deepseek-ai/dsh-api-session-controller/types').SessionAddress

/** One Host-wide forwarded remote event (the `$events` stream items). */
export interface RemoteEvent {
  readonly event: string
  readonly args: readonly unknown[]
}

/** Stable remote-endpoint function descriptors for the typed client seam. */
export interface RemoteRpc {
  call<T>(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T>
  stream(endpoint: string, args: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<unknown>
}

/** Local session id brand helper (mints a v4-like id; callers persist it). */
export function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Stringifies a session address for log / map keys. */
export function addressKey(address: SessionAddress): string {
  return address.kind === 'session' ? `session:${String(address.sessionId)}` : `subagent:${String(address.parentSessionId)}/${String(address.childSessionId)}`
}
