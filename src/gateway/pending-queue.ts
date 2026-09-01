/**
 * The FIFO of per-session prompt configurations that could not be applied
 * immediately because a turn was already running. Each prompt admitted while
 * the session was busy owns one slot here (config-bearing or `none` marker so
 * alignment with the runtime queue is kept), and the slots are applied at the
 * next turn boundary — never mid-flight.
 */
import type { PromptConfiguration } from '../domain/prompt-configuration.js'
import type { PromptEffortSignals } from '../domain/session-effort.js'

/**
 * One FIFO slot aligned with the runtime queue: a configuration awaiting
 * application at the next turn boundary, or a `none` marker keeping the
 * alignment for a queued prompt that carried no configuration.
 */
export type PendingConfigEntry =
  | { readonly configuration: PromptConfiguration; readonly signals?: PromptEffortSignals }
  | { readonly none: true }

export interface PendingConfigurationOptions {
  /** Whether the runtime reports a turn running for the session. */
  readonly isRunning: (sessionId: string) => boolean
  /** Applies one deferred configuration; called at a turn boundary. */
  readonly apply: (configuration: PromptConfiguration, signals?: PromptEffortSignals) => Promise<void>
  /** Reports a failed deferred application; the slot stays for the next boundary. */
  readonly onApplyFailure: (message: string) => void
}

export class PendingConfigurationQueue {
  private readonly pending = new Map<string, PendingConfigEntry[]>()
  /** Sessions for which this client admitted a prompt whose turn events have
   * not arrived yet; guards the idle fast path against same-client rapid sends. */
  private readonly admitted = new Set<string>()

  constructor(private readonly options: PendingConfigurationOptions) {}

  /** True while events or this client's own admission say a turn is running. */
  isTurnRunning(sessionId: string): boolean {
    return this.options.isRunning(sessionId) || this.admitted.has(sessionId)
  }

  /** True when a prompt sent right now would queue behind a running turn. */
  isBusy(sessionId: string): boolean {
    return this.isTurnRunning(sessionId)
  }

  /** Marks one session as busy for this client (optimistic pre-turn admission). */
  admit(sessionId: string): void {
    this.admitted.add(sessionId)
  }

  /** The turn settled (or the session vanished): the admission marker is gone. */
  release(sessionId: string): void {
    this.admitted.delete(sessionId)
    if (!this.options.isRunning(sessionId)) this.flush(sessionId)
  }

  /** Removes only the admission marker (send failed; no turn is settling). */
  forget(sessionId: string): void {
    this.admitted.delete(sessionId)
  }

  /** Appends one slot; returns it so the caller can roll it back on failure. */
  pend(sessionId: string, entry: PendingConfigEntry): PendingConfigEntry {
    const list = this.pending.get(sessionId)
    if (list === undefined) this.pending.set(sessionId, [entry])
    else list.push(entry)
    return entry
  }

  /** Removes exactly one slot (admission failed; the prompt never ran). */
  unpend(sessionId: string, entry: PendingConfigEntry): void {
    const list = this.pending.get(sessionId)
    if (list === undefined) return
    const index = list.indexOf(entry)
    if (index !== -1) list.splice(index, 1)
    if (list.length === 0) this.pending.delete(sessionId)
  }

  /** Drops every slot for one session (its runtime queue was rewritten). */
  dropForSession(sessionId: string): void {
    this.pending.delete(sessionId)
  }

  /**
   * Applies the oldest queued configuration at a turn boundary. Runs only when
   * no turn is believed to be running (never mutates a live turn); a skipped
   * or failed application retries at the next boundary instead of losing the
   * user's configuration. `none` markers are consumed to keep FIFO alignment
   * with the runtime queue.
   */
  flush(sessionId: string): void {
    const list = this.pending.get(sessionId)
    const entry = list?.[0]
    if (entry === undefined) return
    if (this.isTurnRunning(sessionId)) return
    if ('none' in entry) {
      list!.shift()
      if (list!.length === 0) this.pending.delete(sessionId)
      return
    }
    void this.options.apply(entry.configuration, entry.signals).then(
      () => {
        const current = this.pending.get(sessionId)
        if (current === undefined || current[0] !== entry) return
        current.shift()
        if (current.length === 0) this.pending.delete(sessionId)
      },
      (cause: unknown) => {
        this.options.onApplyFailure(cause instanceof Error ? cause.message : String(cause))
      },
    )
  }
}
