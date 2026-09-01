/**
 * Git shell-layer helpers shared by the worktree isolation service. Every
 * function here is stateless: it takes a `GitRunner` (or defaults to the real
 * `git` binary) and returns plain data, so the service class stays focused on
 * session worktree policy while this module owns "how to talk to git".
 */
import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import type { ExecFileOptions } from 'node:child_process'
import * as path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type ExecResult = { stdout: string; stderr: string }

/** Injectable git runner so tests never touch a real repository. */
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<ExecResult>

/** The real `git` binary, as used by production (32 MiB output buffer). */
export function runGit(cwd: string, args: readonly string[]): Promise<ExecResult> {
  const options: ExecFileOptions = { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  return execFileAsync('git', [...args], options) as Promise<ExecResult>
}

/**
 * Probes the git binary and the workspace's repository status in one call.
 * A missing `git` executable (`ENOENT` from the child process) is reported
 * separately from a non-git directory so the caller can tell the user apart:
 * "install Git / add it to PATH" vs "this folder is not a repository".
 */
export async function gitRoot(run: GitRunner, cwd: string): Promise<{ root: string | undefined; gitNotFound: boolean }> {
  try {
    const { stdout } = await run(cwd, ['rev-parse', '--show-toplevel'])
    const root = stdout.trim()
    return { root: root === '' ? undefined : root, gitNotFound: false }
  } catch (error) {
    return { root: undefined, gitNotFound: isGitNotFound(error) }
  }
}

/** Whether a git invocation failed because the executable itself is absent. */
export function isGitNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/** The checked-out branch name, or `undefined` on a detached HEAD. */
export async function currentBranch(run: GitRunner, repoRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = stdout.trim()
    return branch === 'HEAD' ? undefined : branch
  } catch {
    return undefined
  }
}

/** Whether the main worktree has uncommitted changes (porcelain status non-empty). */
export async function worktreeDirty(run: GitRunner, repoRoot: string): Promise<boolean> {
  try {
    const { stdout } = await run(repoRoot, ['status', '--porcelain'])
    return stdout.trim() !== ''
  } catch {
    // If status is unreadable, err on the side of not touching the worktree.
    return true
  }
}

/** Whether a path exists on disk (worktree directories are the usual target). */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/** Immediate subdirectories of `dir` (skips files and unreadable entries). */
export async function listSubdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

/** The repository's default branch (origin/HEAD), falling back to `main`. */
export async function defaultBranch(run: GitRunner, repoRoot: string): Promise<string> {
  try {
    const { stdout } = await run(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    const branch = stdout.trim()
    if (branch !== '' && !branch.endsWith('/HEAD')) return branch.replace(/^origin\//u, '')
  } catch {
    // origin/HEAD is unset for local-only repositories.
  }
  return 'main'
}

const EXCLUDE_ENTRY = '.dsh-worktrees/\n'

/**
 * Ensures `.dsh-worktrees/` is ignored by the repository (via the local, never
 * committed `.git/info/exclude`) so the isolation directory and its worktrees
 * do not pollute `git status` of the main checkout. Best-effort: a failure
 * here never fails session creation.
 */
export async function ignoreDshWorktrees(repoRoot: string): Promise<void> {
  try {
    const gitDir = joinPathLike(repoRoot, '.git', 'info', 'exclude')
    let content = ''
    try {
      content = await readFile(gitDir, 'utf8')
    } catch {
      await mkdir(dirnameLike(repoRoot, gitDir), { recursive: true })
    }
    if (content.split('\n').includes('.dsh-worktrees/')) return
    await appendFile(gitDir, content.endsWith('\n') ? EXCLUDE_ENTRY : `\n${EXCLUDE_ENTRY}`)
  } catch {
    // Never fail session creation over an exclude-entry nicety.
  }
}

/** Preserve the separator style returned by the injected/real git root. */
export function joinPathLike(root: string, ...parts: string[]): string {
  const join = isWindowsPath(root) ? path.win32.join : path.posix.join
  return join(root, ...parts).replaceAll('\\', '/')
}

export function dirnameLike(root: string, value: string): string {
  return isWindowsPath(root) ? path.win32.dirname(value) : path.posix.dirname(value)
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.includes('\\')
}
