import { existsSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import * as path from 'node:path'

/** Stale projection-cache schema failures from a dsh upgrade crash the boot. */
export function isProjectionCacheFailure(diagnostics: string): boolean {
  return /session_projcache|session-projection-cache|does not match its schema|ZodError|invalid-record/iu.test(diagnostics)
}

/**
 * Backs up and removes the session projection cache under the harness home.
 * The cache is derived state (safe to rebuild) and its old-format records
 * fail validation after a dsh upgrade, crash-looping the gateway on boot.
 * Returns whether anything was cleared.
 */
export async function recoverStaleProjectionCache(home: string): Promise<boolean> {
  const storages = path.join(home, 'storages')
  const candidates = [
    path.join(storages, 'session_projcache.json'),
    path.join(storages, 'session_projcache'),
  ]
  const existing = candidates.filter((candidate) => existsSync(candidate))
  if (existing.length === 0) return false
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const backup = path.join(storages, 'backup-session_projcache-' + stamp)
  await mkdir(backup, { recursive: true })
  for (const candidate of existing) {
    try {
      await rename(candidate, path.join(backup, path.basename(candidate)))
    } catch {
      // A partially removed cache is fine; the next boot rebuilds it. Never
      // let a failed backup block the boot.
    }
  }
  return true
}
