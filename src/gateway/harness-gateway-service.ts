import * as vscode from 'vscode'
import type {
  ClientResponse,
  HistoryEntry,
  HostFrame,
  IApiClient,
  JobView,
  MuxFrame,
  RpcId,
  RpcResponse,
  SessionId,
  SessionModels,
  SessionSummary,
  SkillEntry,
  SubagentAddress,
  SubagentListEntry,
} from '@deepseek-ai/dsh-client-connection/client'
import type { PromptContentPart } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { AgentPresetEntry } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ConfigurationService } from '../config/configuration.js'
import {
  projectConversation,
  projectionCommands,
  projectionGoal,
  projectionPermissions,
  projectionPlan,
  projectionTitle,
  projectionTokenUsage,
  sessionListItem,
  type CommandEntry,
  type HarnessWorkbenchState,
  type PendingApprovalView,
  type PendingQuestionView,
  type SubagentView,
} from '../domain/workbench-state.js'
import type { HarnessHostRuntime } from '../runtime/web-runtime.js'
import type { CredentialStore } from '../security/credential-store.js'
import { NodeGatewayClient } from './node-gateway-client.js'

interface PendingApprovalRecord extends PendingApprovalView {
  readonly rpcId: RpcId
  readonly approvalId: string
}

interface PendingQuestionRecord extends PendingQuestionView {
  readonly rpcId: RpcId
}

/**
 * Application service for the native VS Code workbench. It owns Gateway
 * connectivity and durable session state; neither the webview nor the runtime
 * launcher contains Harness business logic.
 */
export class HarnessGatewayService implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>()
  private readonly runtimeSubscription: vscode.Disposable
  private client: IApiClient | undefined
  private streamAbort: AbortController | undefined
  private summaries = new Map<string, SessionSummary>()
  private entries: HistoryEntry[] = []
  private hasMore = false
  private activeSessionId: string | undefined
  private models: SessionModels | undefined
  private presets: readonly AgentPresetEntry[] = []
  private skills: readonly SkillEntry[] = []
  private jobs: readonly JobView[] = []
  private approvals = new Map<string, PendingApprovalRecord>()
  private questions = new Map<string, PendingQuestionRecord>()
  private subagentCount = 0
  private subagents: SubagentListEntry[] = []
  private subagentAddress: SubagentAddress | undefined
  private projections: Record<string, unknown> = {}
  private commands: readonly CommandEntry[] = projectionCommands(undefined)
  private phase: HarnessWorkbenchState['phase'] = 'idle'
  private error: string | undefined
  private publishScheduled = false

  readonly onDidChange = this.changeEmitter.event

  constructor(
    private readonly runtime: HarnessHostRuntime,
    private readonly configuration: ConfigurationService,
    private readonly credentials: CredentialStore,
    private readonly output: vscode.OutputChannel,
  ) {
    this.runtimeSubscription = runtime.onDidChangeState((state) => {
      if (state.phase === 'error') {
        this.phase = 'error'
        this.error = state.error
        this.fireChange()
      }
    })
  }

  async start(): Promise<void> {
    this.phase = 'starting'
    this.error = undefined
    this.fireChange()
    try {
      const url = await this.runtime.start()
      this.client = new NodeGatewayClient(url)
      valueOf(await this.client.host.describe({}))
      this.startEventStreams()
      await Promise.all([this.refreshSessionList(), this.refreshPresets()])
      const requested = this.activeSessionId
      const next = requested !== undefined && this.summaries.has(requested)
        ? requested
        : this.orderedSummaries()[0]?.sessionId
      if (next !== undefined) await this.openSession(String(next))
      this.phase = 'connected'
    } catch (cause) {
      this.phase = 'error'
      this.error = errorMessage(cause)
      this.output.appendLine(`[gateway] ${this.error}`)
    }
    this.fireChange()
  }

  async restart(): Promise<void> {
    this.disconnect()
    await this.runtime.restart()
    await this.start()
  }

  async snapshot(): Promise<HarnessWorkbenchState> {
    const apiKey = await this.credentials.getApiKey()
    const hasApiKey = apiKey !== undefined && apiKey.trim() !== ''
    const tokenUsage = projectionTokenUsage(this.projections.tokenUsage)
    const summaries = this.orderedSummaries().map(sessionListItem)
    const activeSummary = this.activeSessionId === undefined ? undefined : this.summaries.get(this.activeSessionId)
    const projected = projectConversation(this.entries)
    const permissions = projectionPermissions(this.projections.permissions)
    const plan = projectionPlan(this.projections.plan)
    const goal = projectionGoal(this.projections.goal)
    const active = activeSummary === undefined ? undefined : {
      id: String(activeSummary.sessionId),
      title: sessionListItem(activeSummary).title,
      running: activeSummary.running,
      blank: activeSummary.blank,
      ...(activeSummary.agentPreset === undefined ? {} : { agentPreset: activeSummary.agentPreset }),
      hasMore: this.hasMore,
      ...(this.models === undefined ? {} : { model: this.models.current }),
      models: this.models?.groups.flatMap((group) => group.models.map((model) => ({
        provider: group.id,
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        reasoning: model.reasoning?.efforts ?? [],
      }))) ?? [],
      messages: projected.messages,
      todos: projected.todos,
      skills: this.skills,
      jobs: this.jobs,
      approvals: [...this.approvals.values()].map(stripApprovalTransport),
      questions: [...this.questions.values()].map(stripQuestionTransport),
      subagentCount: this.subagentCount,
      subagents: this.subagents.map(subagentView),
      ...(this.subagentAddress === undefined ? {} : {
        parentSessionId: String(this.subagentAddress.parentSessionId),
        subagentMode: this.subagentAddress.mode,
      }),
      ...(permissions === undefined ? {} : { permissions }),
      commands: this.commands,
      ...(plan === undefined ? {} : { plan }),
      ...(goal === undefined ? {} : { goal }),
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
    }
    return {
      phase: this.phase,
      ...(this.error === undefined ? {} : { error: this.error }),
      hasApiKey,
      sessions: summaries,
      ...(active === undefined ? {} : { active }),
      presets: this.presets,
    }
  }

  async createSession(): Promise<string> {
    const client = this.requireClient()
    const config = this.configuration.get()
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
    const created = valueOf(await client.sessions.create({ cwd, agentPreset: config.agentPreset }))
    await this.refreshSessionList()
    await this.selectSession(String(created.sessionId))
    await this.selectModel(config.provider, config.model, config.reasoningEffort, false)
    return String(created.sessionId)
  }

  async searchSessions(query: string): Promise<{ readonly sessionId: string; readonly snippet: string }[]> {
    const normalized = query.trim()
    if (normalized === '') return []
    const result = valueOf(await this.requireClient().sessions.search({ query: normalized }))
    return result.items.map((item) => ({ sessionId: String(item.sessionId), snippet: item.snippet }))
  }

  async selectSession(sessionId: string): Promise<void> {
    if (!this.summaries.has(sessionId)) await this.refreshSessionList()
    if (!this.summaries.has(sessionId)) throw new Error('找不到该会话。')
    this.activeSessionId = sessionId
    this.subagentAddress = undefined
    this.entries = []
    this.hasMore = false
    this.models = undefined
    this.skills = []
    this.jobs = []
    this.approvals.clear()
    this.questions.clear()
    this.subagentCount = 0
    this.subagents = []
    this.projections = {}
    this.commands = projectionCommands(undefined)
    this.fireChange()

    const client = this.requireClient()
    const id = sessionId as SessionId
    const [history, models, skills, subagents] = await Promise.all([
      client.sessions.history({ sessionId: id, maxMessages: 80 }),
      client.sessions.models({ sessionId: id }),
      client.skills.list({ sessionId: id }),
      client.subagents.list({ parentSessionId: id }),
    ])
    const historyValue = valueOf(history)
    this.entries = historyValue.events
    this.hasMore = historyValue.hasMore
    this.models = valueOf(models)
    this.skills = valueOf(skills).skills
    this.subagents = valueOf(subagents).entries
    this.subagentCount = this.subagents.length
    this.projections = recordValue(historyValue.projections?.values)
    this.applyTitleProjection(sessionId, projectionTitle(historyValue.projections?.values))
    this.fireChange()
  }

  /** Opens ordinary sessions directly and resolves subagent transport through its direct parent. */
  async openSession(sessionId: string): Promise<void> {
    await this.openSessionWithRetry(sessionId, OPEN_SESSION_ATTEMPTS)
  }

  /**
   * The gateway serves the HTTP API before its session store has finished
   * loading persisted sessions; calling session APIs in that window yields a
   * transient `session "…" not found (not attached)` from skills/history.
   * Retry with backoff so the first auto-opened session at startup does not
   * fail the whole workbench (observed on Windows, first run after reload).
   */
  private async openSessionWithRetry(sessionId: string, attempts: number): Promise<void> {
    try {
      await this.openSessionOnce(sessionId)
    } catch (cause) {
      if (attempts > 0 && isTransientSessionError(cause)) {
        await sleep(OPEN_SESSION_RETRY_DELAY_MS)
        await this.openSessionWithRetry(sessionId, attempts - 1)
        return
      }
      throw cause
    }
  }

  private async openSessionOnce(sessionId: string): Promise<void> {
    let summary = this.summaries.get(sessionId)
    if (summary === undefined) {
      await this.refreshSessionList()
      summary = this.summaries.get(sessionId)
    }
    if (summary?.origin === 'subagent' && summary.parentSessionId !== undefined) {
      await this.selectSession(String(summary.parentSessionId))
      const child = this.subagents.find((entry) => entry.kind === 'child' && String(entry.id) === sessionId)
      if (child === undefined || child.kind !== 'child') throw new Error('无法从父会话解析该子 Agent。')
      await this.selectSubagent(sessionId, child.mode)
      return
    }
    await this.selectSession(sessionId)
  }

  async loadOlder(): Promise<void> {
    const sessionId = this.requireActiveSession()
    const beforeSeq = this.entries[0]?.event.seq
    if (beforeSeq === undefined || !this.hasMore) return
    const page = this.subagentAddress === undefined
      ? valueOf(await this.requireClient().sessions.history({
        sessionId: sessionId as SessionId,
        beforeSeq,
        maxMessages: 60,
      }))
      : valueOf(await this.requireClient().subagents.history({
        ...this.subagentAddress,
        beforeSeq,
        maxMessages: 60,
      }))
    const existing = new Set(this.entries.map((entry) => entry.event.seq))
    this.entries = [...page.events.filter((entry) => !existing.has(entry.event.seq)), ...this.entries]
    this.hasMore = page.hasMore
    this.fireChange()
  }

  async prompt(
    text: string,
    mode: 'queue' | 'steer' = 'queue',
    images: readonly PromptImage[] = [],
    selection?: PromptSelection,
  ): Promise<void> {
    const normalized = text.trim()
    if (normalized === '' && images.length === 0 && selection === undefined) return
    if (this.activeSessionId === undefined) await this.createSession()
    const sessionId = this.requireActiveSession()
    const content: PromptContentPart[] = [
      ...(selection === undefined ? [] : [selectionPart(selection)]),
      ...(normalized === '' ? [] : [{ type: 'text' as const, text: normalized }]),
      ...images.map((image) => ({
        type: 'image' as const,
        mediaType: image.mediaType,
        data: image.data,
        ...(image.name === undefined ? {} : { name: image.name }),
      })),
    ]
    if (this.subagentAddress === undefined) {
      valueOf(await this.requireClient().sessions.prompt({
        sessionId: sessionId as SessionId,
        mode,
        content,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }))
    } else {
      if (this.subagentAddress.mode === 'one-shot') throw new Error('一次性子 Agent 的历史为只读。')
      if (images.length > 0) throw new Error('子 Agent 继续对话暂不支持图片。')
      valueOf(await this.requireClient().subagents.prompt({
        ...this.subagentAddress,
        content: content.flatMap((part) => part.type === 'text' ? [{ type: 'text' as const, text: part.text }] : []),
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }))
    }
  }

  async cancel(): Promise<void> {
    const sessionId = this.requireActiveSession()
    if (this.subagentAddress === undefined) {
      valueOf(await this.requireClient().sessions.cancel({ sessionId: sessionId as SessionId }))
    } else if (this.subagentAddress.mode === 'continuable') {
      valueOf(await this.requireClient().subagents.interrupt(this.subagentAddress))
    }
  }

  async selectSubagent(childSessionId: string, mode: 'one-shot' | 'continuable'): Promise<void> {
    const parentSessionId = this.subagentAddress?.childSessionId ?? this.requireActiveSession() as SessionId
    const address: SubagentAddress = {
      parentSessionId,
      childSessionId: childSessionId as SessionId,
      mode,
    }
    const history = valueOf(await this.requireClient().subagents.history({ ...address, maxMessages: 80 }))
    const list = valueOf(await this.requireClient().subagents.list({ parentSessionId: childSessionId as SessionId }))
    this.subagentAddress = address
    this.activeSessionId = childSessionId
    this.entries = history.events
    this.hasMore = history.hasMore
    this.models = undefined
    this.skills = []
    this.jobs = []
    this.subagents = list.entries
    this.subagentCount = list.entries.length
    this.projections = recordValue(history.projections?.values)
    this.approvals.clear()
    this.questions.clear()
    this.fireChange()
  }

  async selectParentSession(): Promise<void> {
    const parent = this.subagentAddress?.parentSessionId
    if (parent === undefined) return
    await this.selectSession(String(parent))
  }

  async selectModel(provider: string, model: string, reasoningEffort?: string, persist = true): Promise<void> {
    if (this.subagentAddress !== undefined) throw new Error('子 Agent 使用创建时确定的模型。')
    const sessionId = this.requireActiveSession()
    const selected = valueOf(await this.requireClient().sessions.selectModel({
      sessionId: sessionId as SessionId,
      provider,
      model,
      ...(reasoningEffort === undefined || reasoningEffort === '' ? {} : { reasoningEffort }),
    }))
    if (this.models !== undefined) this.models = { ...this.models, current: selected.selected }
    if (persist) {
      await this.configuration.setModelIfKnown(model)
      if (reasoningEffort !== undefined) await this.configuration.setReasoningEffortIfKnown(reasoningEffort)
    }
    this.fireChange()
  }

  async selectReasoning(reasoningEffort: string): Promise<void> {
    const current = this.models?.current
    if (current === undefined) throw new Error('当前会话尚未加载模型目录。')
    await this.selectModel(current.provider, current.model, reasoningEffort)
  }

  async selectPreset(agentPreset: string): Promise<void> {
    await this.configuration.setAgentPresetIfKnown(agentPreset)
    const sessionId = this.activeSessionId
    const summary = sessionId === undefined ? undefined : this.summaries.get(sessionId)
    if (sessionId !== undefined && summary?.blank === true) {
      valueOf(await this.requireClient().agentPresets.select({
        sessionId: sessionId as SessionId,
        agentPreset,
      }))
      this.summaries.set(sessionId, { ...summary, agentPreset })
    }
    this.fireChange()
  }

  async selectPermission(value: string): Promise<void> {
    if (value === 'custom') return
    await this.prompt(`/permission ${value}`)
  }

  /** Refreshes the slash-command menu from the active session's host registration. */
  async refreshCommands(): Promise<void> {
    const sessionId = this.activeSessionId
    if (sessionId === undefined) return
    const client = this.requireClient()
    if (!(client instanceof NodeGatewayClient)) return
    try {
      this.commands = projectionCommands(await client.listCommands(sessionId))
    } catch (cause) {
      this.commands = projectionCommands(undefined)
      this.output.appendLine(`[gateway] 命令列表刷新失败：${errorMessage(cause)}`)
    }
    this.fireChange()
  }

  async setPlanMode(active: boolean): Promise<void> {
    await this.prompt(active ? '/plan' : '/plan off')
  }

  async createGoal(objective: string): Promise<void> {
    const sessionId = this.requireActiveSession()
    valueOf(await this.requireClient().goals.create({ sessionId: sessionId as SessionId, objective }))
  }

  async mutateGoal(action: 'pause' | 'resume' | 'complete' | 'clear'): Promise<void> {
    const sessionId = this.requireActiveSession()
    const goal = projectionGoal(this.projections.goal)
    if (goal === undefined) throw new Error('当前会话没有目标。')
    const ref = { id: goal.id as never, revision: goal.revision }
    const api = this.requireClient().goals
    if (action === 'pause') valueOf(await api.pause({ sessionId: sessionId as SessionId, ref }))
    else if (action === 'resume') valueOf(await api.resume({ sessionId: sessionId as SessionId, ref }))
    else if (action === 'complete') valueOf(await api.complete({ sessionId: sessionId as SessionId, ref }))
    else valueOf(await api.clear({ sessionId: sessionId as SessionId, ref }))
  }

  async rename(title: string): Promise<void> {
    const sessionId = this.requireActiveSession()
    const renamed = valueOf(await this.requireClient().sessions.rename({
      sessionId: sessionId as SessionId,
      title,
    }))
    this.applyTitleProjection(sessionId, renamed.title)
    this.fireChange()
  }

  async fork(atSeq?: number): Promise<void> {
    const sessionId = this.requireActiveSession()
    const forked = valueOf(await this.requireClient().sessions.fork({
      sessionId: sessionId as SessionId,
      ...(atSeq === undefined ? {} : { atSeq }),
    }))
    await this.refreshSessionList()
    await this.selectSession(String(forked.sessionId))
  }

  async answerApproval(key: string, outcome: 'allowed-once' | 'rejected'): Promise<void> {
    const pending = this.approvals.get(key)
    if (pending === undefined) throw new Error('该审批已失效。')
    await this.respond(pending.rpcId, {
      sessionId: this.requireActiveSession(),
      approvalId: pending.approvalId,
      outcome,
    })
  }

  async answerQuestions(
    key: string,
    answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[],
  ): Promise<void> {
    const pending = this.questions.get(key)
    if (pending === undefined) throw new Error('该问题已失效。')
    await this.respond(pending.rpcId, {
      sessionId: this.requireActiveSession(),
      answer: {
        answers: answers.map((answer) => ({
          id: answer.id,
          selected: [...answer.selected],
          ...(answer.custom === undefined || answer.custom.trim() === '' ? {} : { custom: answer.custom.trim() }),
        })),
      },
    })
  }

  dispose(): void {
    this.disconnect()
    this.runtimeSubscription.dispose()
    this.changeEmitter.dispose()
  }

  private startEventStreams(): void {
    this.streamAbort?.abort()
    const abort = new AbortController()
    this.streamAbort = abort
    void this.pumpMux(abort.signal)
    void this.pumpHost(abort.signal)
  }

  private async pumpMux(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        for await (const envelope of this.requireClient().events.mux({}, signal, () => this.markConnected())) {
          this.handleMux(envelope.rpcId, envelope.payload)
        }
      } catch (cause) {
        if (!signal.aborted) this.output.appendLine(`[gateway] mux 重连：${errorMessage(cause)}`)
      }
      if (!signal.aborted) await this.waitToReconnect(signal)
    }
  }

  private async pumpHost(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        for await (const envelope of this.requireClient().events.host({}, signal, () => this.markConnected())) {
          this.handleHost(envelope.payload)
        }
      } catch (cause) {
        if (!signal.aborted) this.output.appendLine(`[gateway] host 重连：${errorMessage(cause)}`)
      }
      if (!signal.aborted) await this.waitToReconnect(signal)
    }
  }

  private handleMux(rpcId: RpcId, frame: MuxFrame): void {
    if (frame.type === 'session/event') {
      const id = String(frame.sessionId)
      if (id === this.activeSessionId) this.acceptEvent({ event: frame.event, ...(frame.view === undefined ? {} : { view: frame.view }) })
      const summary = this.summaries.get(id)
      if (summary !== undefined) {
        this.summaries.set(id, {
          ...summary,
          updatedAt: Math.max(summary.updatedAt, frame.event.time),
          blank: frame.event.type === 'turn/start' ? false : summary.blank,
        })
      }
    } else if (frame.type === 'approval/requested' && String(frame.sessionId) === this.activeSessionId) {
      const key = `approval:${String(rpcId)}`
      this.approvals.set(key, {
        key,
        rpcId,
        approvalId: String(frame.approvalId),
        toolName: frame.toolName,
        ...(frame.reason === undefined ? {} : { reason: frame.reason }),
      })
    } else if (frame.type === 'approval/resolved') {
      for (const [key, pending] of this.approvals) {
        if (pending.approvalId === String(frame.approvalId)) this.approvals.delete(key)
      }
    } else if (frame.type === 'question/requested' && String(frame.sessionId) === this.activeSessionId) {
      const key = `question:${String(rpcId)}`
      this.questions.set(key, {
        key,
        rpcId,
        questions: frame.questions.map((question) => ({
          id: question.id,
          question: question.question,
          ...(question.header === undefined ? {} : { header: question.header }),
          ...(question.detail === undefined ? {} : { detail: question.detail }),
          options: question.options ?? [],
          multiSelect: question.multiSelect ?? false,
        })),
      })
    } else if (frame.type === 'question/resolved') {
      this.questions.delete(`question:${String(frame.questionRpcId)}`)
    } else if (frame.type === 'session/jobs' && String(frame.sessionId) === this.activeSessionId) {
      this.jobs = frame.jobs
    } else if (frame.type === 'session/projection') {
      if (String(frame.sessionId) === this.activeSessionId) this.projections[frame.key] = frame.value
      if (frame.key === 'title') this.applyTitleProjection(String(frame.sessionId), typeof frame.value === 'string' ? frame.value : undefined)
    }
    this.fireChange()
  }

  private handleHost(frame: HostFrame): void {
    if (frame.type === 'host/session-added') {
      void this.refreshSessionList()
    } else if (frame.type === 'host/session-removed') {
      this.summaries.delete(String(frame.sessionId))
    } else if (frame.type === 'host/session-status') {
      const id = String(frame.sessionId)
      const summary = this.summaries.get(id)
      if (summary !== undefined) this.summaries.set(id, { ...summary, running: frame.running, blank: frame.running ? false : summary.blank })
    } else if (frame.type === 'host/agent-error') {
      this.output.appendLine(`[agent ${String(frame.sessionId)}] ${frame.message}`)
    }
    this.fireChange()
  }

  private acceptEvent(entry: HistoryEntry): void {
    const lastSeq = this.entries.at(-1)?.event.seq
    if (lastSeq !== undefined && entry.event.seq > lastSeq + 1) {
      void this.repairHistory()
      return
    }
    const existing = this.entries.findIndex((value) => value.event.seq === entry.event.seq)
    if (existing >= 0) this.entries[existing] = entry
    else this.entries.push(entry)
  }

  private async repairHistory(): Promise<void> {
    if (this.activeSessionId === undefined) return
    try {
      const history = this.subagentAddress === undefined
        ? valueOf(await this.requireClient().sessions.history({
          sessionId: this.activeSessionId as SessionId,
          maxMessages: 80,
        }))
        : valueOf(await this.requireClient().subagents.history({
          ...this.subagentAddress,
          maxMessages: 80,
        }))
      this.entries = history.events
      this.hasMore = history.hasMore
      this.fireChange()
    } catch (cause) {
      this.output.appendLine(`[gateway] 历史修复失败：${errorMessage(cause)}`)
    }
  }

  private async refreshSessionList(): Promise<void> {
    const items = valueOf(await this.requireClient().sessions.list({})).items
    this.summaries = new Map(items.map((summary) => [String(summary.sessionId), summary]))
    this.fireChange()
  }

  private async refreshPresets(): Promise<void> {
    this.presets = valueOf(await this.requireClient().agentPresets.list({})).presets
    this.fireChange()
  }

  private orderedSummaries(): SessionSummary[] {
    return [...this.summaries.values()].sort((left, right) => right.updatedAt - left.updatedAt)
  }

  private applyTitleProjection(sessionId: string, title: string | undefined): void {
    if (title === undefined) return
    const summary = this.summaries.get(sessionId)
    if (summary === undefined) return
    const existing = summary.projections
    const projections = existing === undefined
      ? { asOfSeq: -1, values: { title } }
      : { ...existing, values: { ...existing.values, title } }
    this.summaries.set(sessionId, { ...summary, projections })
  }

  private async respond(rpcId: RpcId, value: unknown): Promise<void> {
    const message: ClientResponse = { type: 'client-response', rpcId, result: { ok: true, value } }
    const receipt = await this.requireClient().respond(message)
    if (!receipt.accepted) throw new Error(`Harness 拒绝响应：${receipt.reason}`)
  }

  private markConnected(): void {
    this.phase = 'connected'
    this.error = undefined
    this.fireChange()
  }

  private async waitToReconnect(signal: AbortSignal): Promise<void> {
    this.phase = 'reconnecting'
    this.fireChange()
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 800)
      signal.addEventListener('abort', () => {
        clearTimeout(timeout)
        resolve()
      }, { once: true })
    })
    if (!signal.aborted) {
      await this.refreshSessionList().catch((cause: unknown) => {
        this.output.appendLine(`[gateway] 重连基线失败：${errorMessage(cause)}`)
      })
      await this.repairHistory()
    }
  }

  private requireClient(): IApiClient {
    if (this.client === undefined) throw new Error('Harness Gateway 尚未连接。')
    return this.client
  }

  private requireActiveSession(): string {
    if (this.activeSessionId === undefined) throw new Error('请先新建或选择一个会话。')
    return this.activeSessionId
  }

  private disconnect(): void {
    this.streamAbort?.abort()
    this.streamAbort = undefined
    this.client = undefined
    this.phase = 'idle'
  }

  private fireChange(): void {
    if (this.publishScheduled) return
    this.publishScheduled = true
    setTimeout(() => {
      this.publishScheduled = false
      this.changeEmitter.fire()
    }, 16)
  }
}

export interface PromptImage {
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly data: string
  readonly name?: string
}

/** A snapshot of the active editor selection attached as prompt context. */
export interface PromptSelection {
  readonly file?: string
  readonly text: string
  readonly startLine?: number
  readonly endLine?: number
  readonly tooLong?: boolean
}

function selectionPart(selection: PromptSelection): PromptContentPart {
  const name = selection.file === undefined ? '选区' : selection.file.split(/[\\/]/u).pop() ?? '选区'
  const ext = name.includes('.') ? name.split('.').pop() ?? '' : ''
  const range = selection.startLine !== undefined && selection.endLine !== undefined
    ? ` (${selection.startLine}-${selection.endLine} 行)`
    : ''
  const truncated = selection.tooLong === true ? '（已截断）' : ''
  return {
    type: 'text',
    text: `[选区: ${name}${range}${truncated}]\n\`\`\`${ext}\n${selection.text}\n\`\`\``,
  }
}

function valueOf<T>(response: RpcResponse<T>): T {
  if (!response.result.ok) throw new Error(response.result.error.message)
  return response.result.value
}

function stripApprovalTransport(value: PendingApprovalRecord): PendingApprovalView {
  return {
    key: value.key,
    toolName: value.toolName,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  }
}

function stripQuestionTransport(value: PendingQuestionRecord): PendingQuestionView {
  return { key: value.key, questions: value.questions }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

const OPEN_SESSION_ATTEMPTS = 10
const OPEN_SESSION_RETRY_DELAY_MS = 800

/** True for the transient gateway-startup "session not attached" failure. */
function isTransientSessionError(cause: unknown): boolean {
  return errorMessage(cause).includes('not found (not attached)')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? { ...value } : {}
}

function subagentView(entry: SubagentListEntry): SubagentView {
  if (entry.kind === 'diagnostic') return { kind: 'diagnostic', id: String(entry.id), reason: entry.reason }
  return {
    kind: 'child',
    id: String(entry.id),
    activity: entry.activity,
    hasChildren: entry.hasChildren,
    mode: entry.mode,
    ...('label' in entry && entry.label !== undefined ? { label: entry.label } : {}),
  }
}
