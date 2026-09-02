import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { isProjectionCacheFailure, recoverStaleProjectionCache } from '../src/runtime/projection-cache-recovery.js'

describe('gateway stale-cache self-heal', () => {
  it('classifies a dsh projection-cache schema failure from stderr', () => {
    expect(isProjectionCacheFailure("domain 'session_projcache': stored record 'x' does not match its schema")).toBe(true)
    expect(isProjectionCacheFailure('ZodError: expected boolean, received undefined')).toBe(true)
    expect(isProjectionCacheFailure('session-projection-cache: invalid-record')).toBe(true)
    expect(isProjectionCacheFailure('ECONNREFUSED 127.0.0.1:1234')).toBe(false)
    expect(isProjectionCacheFailure('')).toBe(false)
  })

  it('backs up and removes stale projection cache files, returning true', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-cache-recover-'))
    try {
      const storages = join(home, 'storages')
      await mkdir(storages, { recursive: true })
      await writeFile(join(storages, 'session_projcache.json'), '{}')
      await mkdir(join(storages, 'session_projcache'))

      expect(await recoverStaleProjectionCache(home)).toBe(true)
      // Both the old-format file and the partial new-format dir are gone.
      // (The dir may be empty and removed by rename; the file must be gone.)
      const { existsSync } = await import('node:fs')
      expect(existsSync(join(storages, 'session_projcache.json'))).toBe(false)
      const backups = await import('node:fs/promises').then((m) => m.readdir(storages))
      expect(backups.some((name) => name.startsWith('backup-session_projcache-'))).toBe(true)
      // Idempotent: a second call clears nothing.
      expect(await recoverStaleProjectionCache(home)).toBe(false)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('returns false when no cache exists', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-cache-recover-empty-'))
    try {
      expect(await recoverStaleProjectionCache(home)).toBe(false)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
