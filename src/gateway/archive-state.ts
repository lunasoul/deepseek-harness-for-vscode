/**
 * The archived-session set and its durable restore overlay. The bundled
 * runtime has no unarchive RPC, so "restore" is a workbench-side overlay on
 * the official archive set; every mutation is transactional (snapshot →
 * RPC/persist → rollback on failure) so a failed operation can never leave a
 * partial overlay on disk.
 */
import * as vscode from 'vscode'
import type { SessionSummary } from './gateway-wire.js'
import {
  RESTORED_ARCHIVE_STATE_KEY,
  isEffectivelyArchived,
  partitionSessionLists,
  pruneRestoredArchiveIds,
  readRestoredArchiveIds,
} from '../domain/archived-sessions.js'
import { errorMessage } from './gateway-helpers.js'

export interface ArchiveStateOptions {
  readonly globalState: vscode.Memento
  readonly output: vscode.OutputChannel
  /** `workspace.list` RPC returning the official archived-id set. */
  readonly listArchived: () => Promise<string[]>
  /** `workspace.archiveSession` RPC for one session. */
  readonly archiveSession: (sessionId: string) => Promise<string[]>
  /** Opens the first suitable visible session after leaving an archived one. */
  readonly openSession: (sessionId: string) => Promise<void>
  /** Falls back to a fresh session when nothing visible remains. */
  readonly createSession: () => Promise<string>
  /** The sessions considered visible (not archived, in-workspace), ordered. */
  readonly visibleSummaries: () => readonly SessionSummary[]
  /** Notifies the host that the archive overlay changed. */
  readonly fireChange: () => void
}

export class ArchiveState {
  private archivedIds = new Set<string>()
  // Restore overlay is persisted as a whole array via globalState, which is
  // shared across VS Code windows: concurrent archive/restore from two windows
  // is last-write-wins and may overwrite the other window's overlay. This is a
  // known, accepted limitation of the workbench-side restore (the official
  // runtime has no unarchive RPC); each window keeps its own in-memory view
  // and re-syncs on the next host snapshot.
  private restoredIds = new Set<string>()
  private revision = 0
  private baselineLoaded = false

  constructor(private readonly options: ArchiveStateOptions) {
    this.restoredIds = new Set(readRestoredArchiveIds(options.globalState.get(RESTORED_ARCHIVE_STATE_KEY)))
  }

  /** The full partition (active + archived rows) for one session list. */
  partition<T extends { readonly id: string }>(sessions: readonly T[]): { readonly active: readonly T[]; readonly archived: readonly T[] } {
    return partitionSessionLists(sessions, this.archivedIds, this.restoredIds)
  }

  /**
   * Whether a session is archived. Until the official archive set has been
   * loaded once, an empty archivedIds must not be treated as authoritative:
   * a startup failure of workspace.list would otherwise expose (or hide) the
   * wrong sessions. Be conservative until the baseline is known.
   */
  isArchived(sessionId: string): boolean {
    if (!this.baselineLoaded) return false
    return isEffectivelyArchived(sessionId, this.archivedIds, this.restoredIds)
  }

  /**
   * Fetches the official archive set and installs it, unless a newer
   * authoritative refresh or host event advanced the revision while the RPC
   * was in flight. Failures keep the previous set.
   */
  async refresh(): Promise<void> {
    const revision = this.revision
    try {
      const archived = await this.options.listArchived()
      if (this.revision !== revision) return
      // Establish the baseline before installing the set: install sweeps the
      // active selection, and the sweep must see the baseline as loaded to
      // treat archived ids as authoritative.
      this.baselineLoaded = true
      this.install(archived)
    } catch (cause) {
      // Keep the previous set: a transient failure should not unhide archived sessions.
      this.options.output.appendLine(vscode.l10n.t('[gateway] Failed to load the archived session set: {0}', errorMessage(cause)))
    }
    this.options.fireChange()
  }

  /**
   * Applies an authoritative archived-id snapshot. With `persist` (host events
   * and standalone refreshes) the pruned overlay is written in the background;
   * transactional callers pass false and own the single persist call after the
   * whole operation succeeds, so no concurrent write can leak a partial overlay.
   */
  install(ids: readonly string[], persist = true): void {
    const next = new Set(ids)
    const pruned = pruneRestoredArchiveIds(next, this.restoredIds)
    const archivedChanged = next.size !== this.archivedIds.size
      || [...next].some((id) => !this.archivedIds.has(id))
    this.archivedIds = next
    this.revision += archivedChanged ? 1 : 0
    if (persist && pruned.size !== this.restoredIds.size) {
      this.restoredIds = new Set(pruned)
      void this.persistRestoredIds().catch((cause: unknown) => {
        // Background pruning must not fail the caller; persistRestoredIds already
        // logs the underlying failure.
        this.options.output.appendLine(vscode.l10n.t('[gateway] Failed to persist pruned restored sessions: {0}', errorMessage(cause)))
      })
    }
    // Sweep after the overlay has been applied: a session that was restored in
    // this workbench and is archived again must be swept now that its restore
    // overlay is gone. Every authoritative archive-set change sweeps the active
    // selection — a session archived by another window / the official Web UI,
    // or one that became archived while offline and re-enters via the reconnect
    // baseline — instead of staying selected while only visible in the
    // Archived filter.
    this.sweepArchivedSelection()
  }

  /**
   * Host-event path: the snapshot is authoritative, so establish the baseline
   * before installing it (the sweep inside install() needs the baseline loaded
   * to treat archived ids as authoritative, even on the first frame).
   */
  installFromHost(ids: readonly string[]): void {
    this.baselineLoaded = true
    this.install(ids)
  }

  /**
   * Hides one history row via the official archive set. Blank drafts may be
   * archived too; unknown ids are a no-op. Transactional: a failed RPC or
   * persist rolls the overlay back exactly.
   */
  async archive(sessionId: string, sessionExists: (id: string) => boolean): Promise<void> {
    if (!sessionExists(sessionId)) return
    const snapshot = new Set(this.restoredIds)
    this.restoredIds.delete(sessionId)
    try {
      const confirmed = await this.options.archiveSession(sessionId)
      this.install(confirmed, false)
    } catch (cause) {
      await this.rollback(snapshot, cause)
      throw cause
    }
    try {
      await this.persistRestoredIds()
    } catch (cause) {
      await this.rollback(snapshot, cause)
      throw cause
    }
    this.options.fireChange()
  }

  /**
   * Brings a Harness-archived session back to the default list. Transactional
   * like archive(): a failed persistence rolls back the exact pre-operation
   * overlay so it cannot report a restore that would vanish after restart,
   * cannot drop an ID that was already present before this call, and cannot
   * leave a stale partial overlay on disk from a concurrent host frame.
   */
  async restore(sessionId: string): Promise<void> {
    if (!this.isArchived(sessionId)) return
    const snapshot = new Set(this.restoredIds)
    this.restoredIds.add(sessionId)
    try {
      await this.persistRestoredIds()
    } catch (cause) {
      this.restoredIds = new Set(snapshot)
      try {
        await this.persistRestoredIds()
      } catch (persistCause) {
        this.options.output.appendLine(vscode.l10n.t('[gateway] Failed to roll back the restored session list: {0}', errorMessage(persistCause)))
      }
      throw cause
    }
    this.options.fireChange()
  }

  /** A new connection must re-establish the official archive baseline. */
  markDisconnected(): void {
    this.revision += 1
    this.baselineLoaded = false
  }

  private async rollback(snapshot: ReadonlySet<string>, cause: unknown): Promise<void> {
    this.restoredIds = new Set(snapshot)
    try {
      await this.persistRestoredIds()
    } catch (persistCause) {
      this.options.output.appendLine(vscode.l10n.t('[gateway] Failed to roll back the restored session list: {0}', errorMessage(persistCause)))
    }
    this.options.output.appendLine(vscode.l10n.t('[gateway] Archive operation failed: {0}', errorMessage(cause)))
  }

  private sweepArchivedSelection(): void {
    void this.leaveArchivedSelection().catch((cause: unknown) => {
      this.options.output.appendLine(vscode.l10n.t('[gateway] Failed to leave the archived session: {0}', errorMessage(cause)))
    })
  }

  private async leaveArchivedSelection(): Promise<void> {
    const next = this.options.visibleSummaries()[0]
    if (next !== undefined) {
      // openSession resolves sub-agent rows through their parent; selectSession
      // would route a sub-agent through the ordinary session APIs.
      await this.options.openSession(String(next.sessionId))
      return
    }
    await this.options.createSession()
  }

  private async persistRestoredIds(): Promise<void> {
    try {
      await this.options.globalState.update(RESTORED_ARCHIVE_STATE_KEY, [...this.restoredIds])
    } catch (cause) {
      this.options.output.appendLine(vscode.l10n.t('[gateway] Failed to save the restored session list: {0}', errorMessage(cause)))
      throw cause
    }
  }
}

