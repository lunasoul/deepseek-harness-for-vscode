/**
 * Locally-owned per-session state that the harness never persists for us:
 * reasoning-effort intents, session metadata (pin/tags), per-turn edited-file
 * cards, and the auto-title marker. Every mutation is transactional — the
 * candidate map is persisted to the Memento first, then committed to memory —
 * so a failed write can never leave a ghost state the UI echoes as durable.
 */
import * as vscode from 'vscode'
import type { HistoryEntry } from '@deepseek-ai/dsh-client-connection/client'
import type { EffortIntent } from '../domain/session-effort.js'
import { readSessionMeta, type SessionMeta } from '../domain/session-meta.js'
import { metaSortRank } from '../domain/session-meta.js'
import { projectSessionChanges, type SessionChangesView } from '../domain/session-changes.js'
import type { TurnChangesView } from '../domain/workbench-state.js'
import { lastAssistantSeq } from './gateway-helpers.js'

const EFFORT_INTENT_STATE_KEY = 'deepseekHarness.sessionEffortIntents'
const SESSION_META_STATE_KEY = 'deepseekHarness.sessionMeta'
const TURN_CHANGES_STATE_KEY = 'deepseekHarness.sessionTurnChanges'

/** One recorded per-turn edited-file card for a session. */
interface TurnChangesEntry {
  readonly seq: number
  readonly turn: number
  readonly conclusionSeq: number
  readonly changes: SessionChangesView
}

export class SessionMetaStore {
  /** Per-session reasoning-effort intent ('auto' is an extension-side layer). */
  private readonly effortIntents = new Map<string, EffortIntent>()
  /** Locally-owned session metadata (pin / tags). */
  private readonly metaBySession = new Map<string, SessionMeta>()
  /** Per-session finished-turn edited-file cards, kept with the transcript. */
  private readonly turnChangesBySession = new Map<string, TurnChangesEntry[]>()
  // Sessions whose title was generated from their first user message. A
  // session is only auto-named once; after that the title is the user's to
  // edit, so a later message never overwrites a manual rename.
  private readonly autoTitledSessions = new Set<string>()

  constructor(
    private readonly globalState: vscode.Memento,
    private readonly output: vscode.OutputChannel,
  ) {
    loadEffortIntents(globalState.get(EFFORT_INTENT_STATE_KEY), this.effortIntents)
    loadSessionMeta(globalState.get(SESSION_META_STATE_KEY), this.metaBySession)
    loadTurnChanges(globalState.get(TURN_CHANGES_STATE_KEY), this.turnChangesBySession)
  }

  effortIntentFor(sessionId: string): EffortIntent | undefined {
    return this.effortIntents.get(sessionId)
  }

  /**
   * Commits one reasoning-effort intent after the harness accepted it.
   * Persistence failure keeps the previous in-memory intent, so the UI never
   * claims a durable change that was not written.
   */
  async setEffortIntent(sessionId: string, intent: EffortIntent): Promise<void> {
    const candidate = new Map(this.effortIntents)
    candidate.set(sessionId, intent)
    try {
      await this.persistEffortIntents(candidate)
      this.effortIntents.clear()
      for (const [key, value] of candidate) this.effortIntents.set(key, value)
    } catch {
      // persistEffortIntents already logged the failure.
    }
  }

  metaFor(sessionId: string): SessionMeta | undefined {
    return this.metaBySession.get(sessionId)
  }

  /** Pin/tags sort rank, or 0 when the session carries no meta. */
  metaSortRankFor(sessionId: string): number {
    return metaSortRank(this.metaBySession.get(sessionId))
  }

  /**
   * Persists the candidate meta before committing it to memory: a failed write
   * must not leave a ghost state that the UI would echo as if it had worked.
   */
  async updateMeta(sessionId: string, update: (meta: SessionMeta | undefined) => SessionMeta): Promise<void> {
    const next = update(this.metaFor(sessionId))
    const candidate = new Map(this.metaBySession)
    if (readSessionMeta(next) === undefined) candidate.delete(sessionId)
    else candidate.set(sessionId, next)
    await this.persistSessionMeta(candidate)
    this.metaBySession.clear()
    for (const [key, value] of candidate) this.metaBySession.set(key, value)
  }

  /** Drops every trace of one removed session; persistence is best-effort. */
  removeSession(sessionId: string): void {
    if (this.effortIntents.delete(sessionId)) void this.persistEffortIntents().catch(() => undefined)
    if (this.metaBySession.delete(sessionId)) void this.persistSessionMeta().catch(() => undefined)
  }

  /** The recorded turn cards for one session, in transcript order. */
  turnChangesFor(sessionId: string): TurnChangesView[] {
    return (this.turnChangesBySession.get(sessionId) ?? []).map((entry) => ({
      seq: entry.seq,
      turn: entry.turn,
      conclusionId: `event-${entry.conclusionSeq}`,
      changes: entry.changes,
    }))
  }

  /**
   * Snapshots one finished turn's edited-file card so it stays with the
   * transcript (below that turn's conclusion) instead of being replaced by
   * the newest turn. Only the active session's entries are known here — the
   * in-memory transcript belongs to the active conversation — so background
   * sessions' turn cards are recorded when their turn ends while selected.
   */
  recordTurnChanges(
    sessionId: string,
    event: HistoryEntry['event'],
    entries: readonly HistoryEntry[],
    isActiveSession: boolean,
    sessionExists: (sessionId: string) => boolean,
  ): void {
    if (!isActiveSession || event.type !== 'turn/end') return
    const turn = typeof event.data?.turn === 'number' ? event.data.turn : undefined
    if (turn === undefined) return
    const changes = projectSessionChanges(entries)
    if (changes === undefined || changes.files.length === 0) return
    const conclusionSeq = lastAssistantSeq(entries)
    if (conclusionSeq === undefined) return
    const existing = this.turnChangesBySession.get(sessionId) ?? []
    const next = existing.filter((candidate) => candidate.turn !== turn)
    next.push({ seq: event.seq, turn, conclusionSeq, changes })
    next.sort((left, right) => left.turn - right.turn)
    this.turnChangesBySession.set(sessionId, next)
    for (const key of Array.from(this.turnChangesBySession.keys())) {
      if (key !== sessionId && !sessionExists(key)) this.turnChangesBySession.delete(key)
    }
    void this.persistTurnChanges()
  }

  /** True once the session has been auto-named; a manual rename marks it too. */
  markAutoTitled(sessionId: string): boolean {
    if (this.autoTitledSessions.has(sessionId)) return false
    this.autoTitledSessions.add(sessionId)
    return true
  }

  isAutoTitled(sessionId: string): boolean {
    return this.autoTitledSessions.has(sessionId)
  }

  clearAutoTitled(sessionId: string): void {
    this.autoTitledSessions.delete(sessionId)
  }

  private async persistEffortIntents(source: ReadonlyMap<string, EffortIntent> = this.effortIntents): Promise<void> {
    try {
      await this.globalState.update(EFFORT_INTENT_STATE_KEY, Object.fromEntries(source))
    } catch (cause) {
      this.output.appendLine(vscode.l10n.t('[gateway] Failed to save the session reasoning intent: {0}', errorMessageFor(cause)))
      throw cause
    }
  }

  private async persistSessionMeta(source: ReadonlyMap<string, SessionMeta> = this.metaBySession): Promise<void> {
    try {
      await this.globalState.update(SESSION_META_STATE_KEY, Object.fromEntries(source))
    } catch (cause) {
      this.output.appendLine(vscode.l10n.t('[gateway] Failed to save the session metadata: {0}', errorMessageFor(cause)))
      throw cause
    }
  }

  private persistTurnChanges(): void {
    void this.globalState.update(TURN_CHANGES_STATE_KEY, Object.fromEntries(this.turnChangesBySession))
  }
}

function errorMessageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function isEffortIntent(value: unknown): value is EffortIntent {
  return value === 'auto' || value === 'off' || value === 'low' || value === 'high' || value === 'max'
}

function loadEffortIntents(raw: unknown, target: Map<string, EffortIntent>): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
  for (const [sessionId, value] of Object.entries(raw)) {
    if (isEffortIntent(value)) target.set(sessionId, value)
  }
}

function loadSessionMeta(raw: unknown, target: Map<string, SessionMeta>): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
  for (const [sessionId, value] of Object.entries(raw)) {
    const meta = readSessionMeta(value)
    if (meta !== undefined) target.set(sessionId, meta)
  }
}

function loadTurnChanges(raw: unknown, target: Map<string, TurnChangesEntry[]>): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
  for (const [sessionId, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue
    const entries = value.filter((entry): entry is TurnChangesEntry =>
      typeof entry === 'object' && entry !== null
      && typeof (entry as { seq?: unknown }).seq === 'number'
      && typeof (entry as { turn?: unknown }).turn === 'number'
      && typeof (entry as { conclusionSeq?: unknown }).conclusionSeq === 'number'
      && typeof (entry as { changes?: unknown }).changes === 'object')
    if (entries.length > 0) target.set(sessionId, entries)
  }
}
