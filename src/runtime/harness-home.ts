import { cpSync, existsSync, mkdirSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'

const MIGRATED = new Set<string>()

/**
 * The extension's persistent harness home (session logs, provider settings,
 * credentials, attachments). It lives OUTSIDE VS Code's globalStorage because
 * VS Code removes an extension's globalStorage on uninstall and on "Reset
 * Extension State" — either silently wipes every session and the provider
 * configuration. A stable per-user directory (~/.dsh/vscode/harness-home)
 * survives extension reinstall, uninstall, and state resets.
 *
 * The legacy globalStorage home is copied over once, so an existing install
 * keeps its data on upgrade.
 */
export function harnessHomePath(context: vscode.ExtensionContext): string {
  const stable = path.join(os.homedir(), '.dsh', 'vscode', 'harness-home')
  const legacy = path.join(context.globalStorageUri.fsPath, 'harness-home')
  migrateOnce(legacy, stable)
  return stable
}

function migrateOnce(legacy: string, stable: string): void {
  if (MIGRATED.has(stable)) return
  MIGRATED.add(stable)
  try {
    if (existsSync(stable) || !existsSync(legacy)) return
    mkdirSync(path.dirname(stable), { recursive: true })
    cpSync(legacy, stable, { recursive: true, preserveTimestamps: true })
  } catch {
    // A failed migration must not block the runtime; the extension simply
    // starts with a fresh stable home and the legacy copy is left untouched.
  }
}