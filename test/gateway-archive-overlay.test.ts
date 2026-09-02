import { describe, expect, it, vi } from 'vitest'
import { RESTORED_ARCHIVE_STATE_KEY } from '../src/domain/archived-sessions.js'

// HarnessGatewayService imports `vscode` at the top level; provide a minimal
// mock so the module graph loads under vitest's node environment.
vi.mock('vscode', () => ({
  EventEmitter: class {
    fire(): void {}
    event = (): { dispose(): void } => ({ dispose: () => {} })
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: () => undefined, update: async () => {} }),
  },
  l10n: { t: (message: string): string => message },
  env: { openExternal: async () => true },
}))

import { HarnessGatewayService } from '../src/gateway/harness-gateway-service.js'
import type { WorktreeService } from '../src/editor/worktree-service.js'
import type { HarnessHostRuntime } from '../src/runtime/web-runtime.js'
import type { ConfigurationService } from '../src/config/configuration.js'
import type { ConnectionSettingsService } from '../src/services/connection-settings-service.js'
import type { Memento, OutputChannel } from 'vscode'

/** A no-op worktree service so archive-overlay tests never touch git. */
function stubWorktreeService(): WorktreeService {
  return {
    prepare: async () => ({ cwd: '', isolated: false }),
    cleanupOrphans: async () => [],
    recordFor: () => undefined,
    repoRootFor: () => undefined,
    displayCwd: (_sessionId: string, fallback: string | undefined) => fallback,
    diffText: async () => undefined,
    mergeBack: async () => ({ ok: false, message: 'stub' }),
    discard: async () => ({ ok: false, message: 'stub' }),
    dispose: () => undefined,
  } as unknown as WorktreeService
}

/**
 * Builds a HarnessGatewayService whose internal client and archive state are
 * controlled directly, so the archive revision guard, rollback and baseline
 * gating invariants can be exercised without a live Gateway.
 */

interface TestClient {
  workspace: {
    list: ReturnType<typeof vi.fn>
    archiveSession: ReturnType<typeof vi.fn>
  }
  sessions: {
    list: ReturnType<typeof vi.fn>
    history: ReturnType<typeof vi.fn>
    models: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    selectModel: ReturnType<typeof vi.fn>
  }
  skills: { list: ReturnType<typeof vi.fn> }
  subagents: { list: ReturnType<typeof vi.fn> }
  agentPresets: { list: ReturnType<typeof vi.fn> }
  host: { describe: ReturnType<typeof vi.fn> }
}

function createService(options: {
  archived?: readonly string[]
  restored?: readonly string[]
  client?: TestClient
} = {}): { service: GatewayTestHarness; client: TestClient } {
  const client = options.client ?? ({} as TestClient)
  client.workspace ??= {
    list: vi.fn(),
    archiveSession: vi.fn(),
  }
  client.sessions ??= {
    list: vi.fn().mockResolvedValue({ result: { ok: true, value: { items: [] } } }),
    history: vi.fn().mockResolvedValue({ result: { ok: true, value: { events: [], hasMore: false } } }),
    models: vi.fn().mockResolvedValue({ result: { ok: true, value: { current: {}, groups: [] } } }),
    create: vi.fn(),
    selectModel: vi.fn().mockResolvedValue({ result: { ok: true, value: { selected: {} } } }),
  }
  client.skills ??= { list: vi.fn().mockResolvedValue({ result: { ok: true, value: { skills: [] } } }) }
  client.subagents ??= { list: vi.fn().mockResolvedValue({ result: { ok: true, value: { entries: [] } } }) }
  client.agentPresets ??= { list: vi.fn().mockResolvedValue({ result: { ok: true, value: { presets: [] } } }) }
  client.host ??= { describe: vi.fn().mockResolvedValue({ result: { ok: true, value: {} } }) }

  const runtime = {
    onDidChangeState: () => ({ dispose: () => {} }),
    state: { phase: 'idle' as const },
    start: vi.fn().mockResolvedValue('http://127.0.0.1:0'),
    stop: vi.fn(),
    restart: vi.fn(),
    dispose: vi.fn(),
  } as unknown as HarnessHostRuntime

  const configuration = {
    get: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high', agentPreset: 'standard' }),
    setAgentPresetIfKnown: vi.fn(),
  } as unknown as ConfigurationService

  const connectionSettings = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    refresh: vi.fn(),
    onDidChange: () => ({ dispose: () => {} }),
  } as unknown as ConnectionSettingsService

  const output = { appendLine: vi.fn() } as unknown as OutputChannel
  const state = new Map<string, unknown>()
  if (options.restored !== undefined) state.set(RESTORED_ARCHIVE_STATE_KEY, [...options.restored])
  const globalState = {
    get: (key: string) => state.get(key),
    update: vi.fn(async (key: string, value: unknown) => { state.set(key, value) }),
  } as unknown as Memento

  const service = new HarnessGatewayService(
    runtime,
    configuration,
    connectionSettings,
    output,
    globalState,
    stubWorktreeService(),
  ) as unknown as GatewayTestHarness

  // Seed the official archive set and baseline so the tests exercise the
  // post-baseline behaviour.
  service.archives.archivedIds = new Set(options.archived ?? [])
  service.archives.baselineLoaded = true
  if (options.archived !== undefined) service.archives.revision += 1
  service.client = client
  return { service, client }
}

/** Structural view of the private gateway state the tests drive directly. */
interface GatewayTestHarness {
  client: TestClient | undefined
  summaries: Map<string, { blank?: boolean; origin?: string; parentSessionId?: string }>
  archives: {
    archivedIds: Set<string>
    restoredIds: Set<string>
    revision: number
    baselineLoaded: boolean
    install: (ids: readonly string[], persist?: boolean) => void
    isArchived: (id: string) => boolean
    refresh: () => Promise<void>
    archive: (id: string, exists: (id: string) => boolean) => Promise<void>
  }
  activeSessionId: string | undefined
  globalState: { get: (key: string) => unknown; update: (key: string, value: unknown) => Promise<void> }
  fireChange: () => void
}

describe('HarnessGatewayService archive overlay', () => {
  it('discards a stale workspace.list response after a host archive frame advanced the revision', async () => {
    const { service, client } = createService({ archived: [] })
    service.archives.archivedIds = new Set()

    // Simulate refreshArchiveSet issuing workspace.list (revision captured),
    // then a host frame updating the set before the RPC settles.
    client.workspace.list.mockImplementation(async () => {
      service.archives.install(['a'], true) // host frame wins
      return { result: { ok: true, value: { archivedSessionIds: [] } } }
    })
    await service.archives.refresh()

    // The stale [] response must not clobber the host's ['a'].
    expect(service.archives.isArchived('a')).toBe(true)
    expect(service.archives.archivedIds.has('a')).toBe(true)
  })

  it('applies a workspace.list response that is still current', async () => {
    const { service, client } = createService({ archived: [] })
    client.workspace.list.mockResolvedValue({ result: { ok: true, value: { archivedSessionIds: ['b'] } } })
    await service.archives.refresh()
    expect(service.archives.archivedIds.has('b')).toBe(true)
    expect(service.archives.baselineLoaded).toBe(true)
  })

  it('restores the exact overlay snapshot when archiveSession persistence fails', async () => {
    const { service, client } = createService({ archived: [], restored: ['keep'] })
    service.summaries.set('target', { blank: false })
    client.workspace.archiveSession.mockResolvedValue({ result: { ok: true, value: { archivedSessionIds: ['target'] } } })
    // Force the persist step to fail after the RPC succeeded.
    service.globalState.update = async () => { throw new Error('disk full') }

    await expect(service.archives.archive('target', (id) => service.summaries.has(id))).rejects.toThrow('disk full')
    // The unrelated overlay id survives; the failed archive id is rolled back.
    expect(service.archives.restoredIds.has('keep')).toBe(true)
    expect(service.archives.restoredIds.has('target')).toBe(false)
  })

  it('treats nothing as archived until the baseline is loaded', () => {
    const { service } = createService({ archived: ['hidden'] })
    service.archives.baselineLoaded = false
    service.archives.archivedIds = new Set(['hidden'])
    expect(service.archives.isArchived('hidden')).toBe(false)
  })

  it('sweeps a session the host frame archives (no restore overlay)', () => {
    const { service } = createService({ archived: [] })
    service.activeSessionId = 'active'
    service.archives.archivedIds = new Set()
    // host/archived-sessions-changed archives the open session; without a
    // restore overlay it becomes archived and the sweep runs. In this harness
    // the fallback selection cannot resolve without a live client, so the
    // sweep's leaveArchivedSelection fails safely and logs; the invariant
    // under test is that the session is now considered archived.
    service.archives.install(['active'], true)
    expect(service.archives.isArchived('active')).toBe(true)
  })

  it('archives a blank draft so unwanted new-conversation stubs can be hidden', async () => {
    const { service, client } = createService({ archived: [] })
    service.summaries.set('blank-draft', { blank: true })
    client.workspace.archiveSession.mockResolvedValue({ result: { ok: true, value: { archivedSessionIds: ['blank-draft'] } } })

    await service.archives.archive('blank-draft', (id) => service.summaries.has(id))

    expect(client.workspace.archiveSession).toHaveBeenCalledWith({ sessionId: 'blank-draft' })
    expect(service.archives.isArchived('blank-draft')).toBe(true)
  })
})
