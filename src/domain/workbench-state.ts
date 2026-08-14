import type {
  AgentPresetEntry,
  JobView,
  ModelReasoningEffort,
  SessionSummary,
  SkillEntry,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { HistoryEntry } from '@deepseek-ai/dsh-host-apiproxy/api'

export type ConnectionPhase = 'idle' | 'starting' | 'connected' | 'reconnecting' | 'error'

export interface SessionListItem {
  readonly id: string
  readonly title: string
  readonly cwd?: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly agentPreset?: string
}

export interface ChatBlock {
  readonly kind: 'text' | 'reasoning' | 'image'
  readonly text: string
}

export interface ChatItem {
  readonly id: string
  readonly seq: number
  readonly time: number
  readonly kind: 'message' | 'context' | 'tool' | 'notice'
  readonly role?: 'user' | 'assistant'
  readonly title?: string
  readonly status?: 'running' | 'success' | 'error' | 'info'
  readonly blocks?: readonly ChatBlock[]
  readonly detail?: string
}

export interface PendingApprovalView {
  readonly key: string
  readonly toolName: string
  readonly reason?: string
}

export interface QuestionOptionView {
  readonly label: string
  readonly description?: string
}

export interface PendingQuestionView {
  readonly key: string
  readonly questions: readonly {
    readonly id: string
    readonly question: string
    readonly header?: string
    readonly detail?: string
    readonly options: readonly QuestionOptionView[]
    readonly multiSelect: boolean
  }[]
}

export interface ModelView {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning: readonly ModelReasoningEffort[]
}

export interface ActiveSessionView {
  readonly id: string
  readonly title: string
  readonly running: boolean
  readonly blank: boolean
  readonly agentPreset?: string
  readonly hasMore: boolean
  readonly model?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  readonly models: readonly ModelView[]
  readonly messages: readonly ChatItem[]
  readonly todos: readonly { readonly content: string; readonly status: string }[]
  readonly skills: readonly SkillEntry[]
  readonly jobs: readonly JobView[]
  readonly approvals: readonly PendingApprovalView[]
  readonly questions: readonly PendingQuestionView[]
  readonly subagentCount: number
  readonly subagents: readonly SubagentView[]
  readonly parentSessionId?: string
  readonly subagentMode?: 'one-shot' | 'continuable'
  readonly permissions?: PermissionView
  readonly commands?: readonly CommandEntry[]
  readonly plan?: { readonly active: boolean; readonly pending: boolean }
  readonly goal?: GoalView
  readonly tokenUsage?: TokenUsageView
}

export type SubagentView = {
  readonly kind: 'child'
  readonly id: string
  readonly activity: 'running' | 'inactive'
  readonly hasChildren: boolean
  readonly mode: 'one-shot' | 'continuable'
  readonly label?: string
} | {
  readonly kind: 'diagnostic'
  readonly id: string
  readonly reason: string
}

export interface PermissionView {
  readonly currentValue: string
  readonly options: readonly { readonly value: string; readonly name: string; readonly description?: string }[]
}

/**
 * A slash-command entry shown in the composer menu. `host` commands are
 * registered by the Harness runtime (`/compact`, `/plan`, …) and execute when
 * the composed line is sent; `extension` commands are handled locally by this
 * extension (model / reasoning / preset pickers).
 */
export interface CommandEntry {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
  readonly kind: 'host' | 'extension'
}

/** Extension-owned slash commands, appended after the runtime's host list. */
export const EXTENSION_COMMANDS: readonly CommandEntry[] = [
  { name: 'model', description: '切换当前会话模型（Flash / Pro）', kind: 'extension' },
  { name: 'reasoning', description: '切换推理等级（off / high / max）', kind: 'extension' },
  { name: 'preset', description: '切换 Agent Preset（standard / code / minimal / cordis）', kind: 'extension' },
]

/** Projects the runtime `commands/list` payload into menu entries plus the local extensions. */
export function projectionCommands(value: unknown): readonly CommandEntry[] {
  const hosts: CommandEntry[] = []
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item) || typeof item.name !== 'string' || typeof item.description !== 'string'
        || item.description.trim() === '') continue
      const input = isRecord(item.input) && typeof item.input.hint === 'string' && item.input.hint.trim() !== ''
        ? { hint: item.input.hint }
        : undefined
      hosts.push({ name: item.name, description: item.description, ...(input === undefined ? {} : { input }), kind: 'host' })
    }
  }
  hosts.sort((left, right) => left.name < right.name ? -1 : 1)
  return [...hosts, ...EXTENSION_COMMANDS]
}

export interface TokenUsageView {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** Projects the harness `tokenUsage` session projection (0 when absent). */
export function projectionTokenUsage(value: unknown): TokenUsageView | undefined {
  if (!isRecord(value)) return undefined
  const uncachedInputTokens = value.uncachedInputTokens
  const outputTokens = value.outputTokens
  const cacheReadTokens = value.cacheReadTokens
  const cacheWriteTokens = value.cacheWriteTokens
  if (typeof uncachedInputTokens !== 'number' || typeof outputTokens !== 'number'
    || typeof cacheReadTokens !== 'number' || typeof cacheWriteTokens !== 'number') return undefined
  return { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

export interface GoalView {
  readonly id: string
  readonly revision: number
  readonly objective: string
  readonly phase: 'active' | 'paused' | 'blocked' | 'complete'
  readonly maxGoalRounds: number
  readonly roundsStarted: number
  readonly blockedReason?: string
}

export interface HarnessWorkbenchState {
  readonly phase: ConnectionPhase
  readonly error?: string
  readonly hasApiKey: boolean
  readonly sessions: readonly SessionListItem[]
  readonly active?: ActiveSessionView
  readonly presets: readonly AgentPresetEntry[]
}

/** Converts a Host summary to the small, stable DTO sent into the webview. */
export function sessionListItem(summary: SessionSummary): SessionListItem {
  const title = projectionTitle(summary.projections?.values)
  return {
    id: String(summary.sessionId),
    title: title ?? (summary.blank ? '新对话' : fallbackTitle(summary)),
    ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
    updatedAt: summary.updatedAt,
    running: summary.running,
    blank: summary.blank,
    ...(summary.agentPreset === undefined ? {} : { agentPreset: summary.agentPreset }),
  }
}

export function projectionTitle(values: unknown): string | undefined {
  if (!isRecord(values)) return undefined
  const title = values.title
  return typeof title === 'string' && title.trim() !== '' ? title : undefined
}

export function projectionPermissions(value: unknown): PermissionView | undefined {
  if (!isRecord(value) || typeof value.currentValue !== 'string' || !Array.isArray(value.options)) return undefined
  const options = value.options.flatMap((option) => {
    if (!isRecord(option) || typeof option.value !== 'string' || typeof option.name !== 'string') return []
    return [{
      value: option.value,
      name: option.name,
      ...(typeof option.description === 'string' ? { description: option.description } : {}),
    }]
  })
  return { currentValue: value.currentValue, options }
}

export function projectionPlan(value: unknown): { readonly active: boolean; readonly pending: boolean } | undefined {
  if (!isRecord(value) || typeof value.active !== 'boolean' || typeof value.pending !== 'boolean') return undefined
  return { active: value.active, pending: value.pending }
}

export function projectionGoal(value: unknown): GoalView | undefined {
  if (!isRecord(value) || !isRecord(value.goal)) return undefined
  const goal = value.goal
  if (typeof goal.id !== 'string' || typeof goal.revision !== 'number' || typeof goal.objective !== 'string'
    || !isGoalPhase(goal.phase) || typeof goal.maxGoalRounds !== 'number') return undefined
  const blockedReason = isRecord(goal.blockedReason) && typeof goal.blockedReason.message === 'string'
    ? goal.blockedReason.message
    : undefined
  return {
    id: goal.id,
    revision: goal.revision,
    objective: goal.objective,
    phase: goal.phase,
    maxGoalRounds: goal.maxGoalRounds,
    roundsStarted: typeof value.roundsStarted === 'number' ? value.roundsStarted : 0,
    ...(blockedReason === undefined ? {} : { blockedReason }),
  }
}

/**
 * Projects the append-only Harness event log into a native chat transcript.
 * Raw events remain the source of truth; this function is intentionally pure.
 */
export function projectConversation(entries: readonly HistoryEntry[]): {
  readonly messages: ChatItem[]
  readonly todos: { readonly content: string; readonly status: string }[]
} {
  const messages: ChatItem[] = []
  const finalSteps = new Set<string>()
  const partials = new Map<string, PartialBlocks>()
  let todos: { readonly content: string; readonly status: string }[] = []

  for (const { event } of entries) {
    if (event.type === 'assistant/message') {
      finalSteps.add(stepKey(event.data.turn, event.data.step))
    }
  }

  for (const { event } of entries) {
    switch (event.type) {
      case 'user/message': {
        if (isReplacement(event.surfaceOp)) break
        const source = event.data.source
        const human = source.kind === 'user'
        messages.push({
          id: `event-${event.seq}`,
          seq: event.seq,
          time: event.time,
          kind: human ? 'message' : 'context',
          role: 'user',
          ...(!human ? { title: contextTitle(source) } : {}),
          blocks: projectBlocks(event.data.content),
        })
        break
      }
      case 'assistant/chunk': {
        const key = stepKey(event.data.turn, event.data.step)
        if (finalSteps.has(key)) break
        const partial = partials.get(key) ?? new PartialBlocks(event.seq, event.time)
        partial.push(event.data.chunk)
        partials.set(key, partial)
        break
      }
      case 'assistant/message': {
        if (isReplacement(event.surfaceOp)) break
        const blocks = projectBlocks(event.data.message.content)
        if (blocks.length > 0) {
          messages.push({
            id: `event-${event.seq}`,
            seq: event.seq,
            time: event.time,
            kind: 'message',
            role: 'assistant',
            blocks,
          })
        }
        break
      }
      case 'tool/call': {
        messages.push({
          id: `tool-${String(event.data.callId)}-call`,
          seq: event.seq,
          time: event.time,
          kind: 'tool',
          title: event.data.name,
          status: 'running',
          detail: prettyJson(event.data.arguments),
        })
        break
      }
      case 'tool/result': {
        messages.push({
          id: `tool-${String(event.data.message.source.callId)}-result`,
          seq: event.seq,
          time: event.time,
          kind: 'tool',
          title: '工具结果',
          status: event.data.error === undefined ? 'success' : 'error',
          detail: blockText(event.data.message.content),
        })
        break
      }
      case 'todo/write':
        todos = event.data.todos.map((item) => ({ content: item.content, status: item.status }))
        break
      case 'turn/end':
        if (event.data.reason.kind !== 'completed') {
          messages.push({
            id: `turn-${event.data.turn}-end`,
            seq: event.seq,
            time: event.time,
            kind: 'notice',
            title: turnEndTitle(event.data.reason.kind),
            status: event.data.reason.kind === 'error' ? 'error' : 'info',
            ...('error' in event.data.reason ? { detail: event.data.reason.error.message } : {}),
          })
        }
        break
      default:
        break
    }
  }

  for (const [key, partial] of partials) {
    messages.push({
      id: `partial-${key}`,
      seq: partial.seq,
      time: partial.time,
      kind: 'message',
      role: 'assistant',
      status: 'running',
      blocks: partial.blocks(),
    })
  }
  messages.sort((left, right) => left.seq - right.seq)
  return { messages, todos }
}

class PartialBlocks {
  readonly seq: number
  readonly time: number
  private readonly values = new Map<number, ChatBlock>()

  constructor(seq: number, time: number) {
    this.seq = seq
    this.time = time
  }

  push(chunk: Extract<HistoryEntry['event'], { type: 'assistant/chunk' }>['data']['chunk']): void {
    switch (chunk.type) {
      case 'block-start':
        if (chunk.blockType === 'text' || chunk.blockType === 'reasoning') {
          this.values.set(chunk.index, { kind: chunk.blockType, text: '' })
        }
        break
      case 'text-delta':
        this.append(chunk.index, 'text', chunk.text)
        break
      case 'reasoning-delta':
        this.append(chunk.index, 'reasoning', chunk.text)
        break
      case 'block-end': {
        const blocks = projectBlocks([chunk.block])
        const block = blocks[0]
        if (block !== undefined) this.values.set(chunk.index, block)
        break
      }
      default:
        break
    }
  }

  blocks(): ChatBlock[] {
    return [...this.values.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)
  }

  private append(index: number, kind: 'text' | 'reasoning', text: string): void {
    const previous = this.values.get(index)
    this.values.set(index, { kind, text: (previous?.kind === kind ? previous.text : '') + text })
  }
}

function projectBlocks(blocks: readonly unknown[]): ChatBlock[] {
  const result: ChatBlock[] = []
  for (const value of blocks) {
    if (!isRecord(value) || typeof value.type !== 'string') continue
    if ((value.type === 'text' || value.type === 'reasoning') && typeof value.text === 'string') {
      result.push({ kind: value.type, text: value.text })
    } else if (value.type === 'image') {
      result.push({ kind: 'image', text: '[图片附件]' })
    }
  }
  return result
}

function blockText(blocks: readonly unknown[]): string {
  const output: string[] = []
  const visit = (values: readonly unknown[]): void => {
    for (const value of values) {
      if (!isRecord(value)) continue
      if (typeof value.text === 'string') output.push(value.text)
      if (Array.isArray(value.content)) visit(value.content)
    }
  }
  visit(blocks)
  return output.join('\n').trim() || '完成'
}

function fallbackTitle(summary: SessionSummary): string {
  const folder = summary.cwd?.split(/[\\/]/u).filter(Boolean).at(-1)
  return folder === undefined ? `会话 ${String(summary.sessionId).slice(0, 8)}` : folder
}

function contextTitle(source: { readonly kind: string }): string {
  return source.kind === 'plugin' ? '上下文' : source.kind
}

function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), undefined, 2)
  } catch {
    return value
  }
}

function turnEndTitle(kind: string): string {
  if (kind === 'aborted') return '已停止生成'
  if (kind === 'max-tokens') return '已达到输出上限'
  if (kind === 'blocked') return '任务被阻止'
  return '本轮执行失败'
}

function isReplacement(value: unknown): boolean {
  return isRecord(value) && value.op === 'replace'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isGoalPhase(value: unknown): value is GoalView['phase'] {
  return value === 'active' || value === 'paused' || value === 'blocked' || value === 'complete'
}
