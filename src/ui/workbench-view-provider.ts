import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'
import type { ConfigurationService } from '../config/configuration.js'
import { AGENT_PRESET_OPTIONS, MODEL_OPTIONS, REASONING_OPTIONS } from '../domain/options.js'
import type { HarnessGatewayService, PromptSelection } from '../gateway/harness-gateway-service.js'

export interface WorkbenchViewActions {
  readonly setApiKey: () => Promise<void>
  readonly openSettings: () => Promise<void>
  readonly showLogs: () => void
}

/** Native Codex/Cline-style workbench. No Harness page or iframe is embedded. */
export class WorkbenchViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'deepseekHarness.chatView'

  private view: vscode.WebviewView | undefined
  private readonly subscriptions: vscode.Disposable[]

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly configuration: ConfigurationService,
    private readonly gateway: HarnessGatewayService,
    private readonly actions: WorkbenchViewActions,
  ) {
    this.subscriptions = [gateway.onDidChange(() => { void this.publishState() })]
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    }
    view.webview.html = this.html(view.webview)
    this.subscriptions.push(view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message).catch((cause: unknown) => {
        const detail = cause instanceof Error ? cause.message : String(cause)
        void vscode.window.showErrorMessage(`DeepSeek Harness：${detail}`)
      })
    }))
    void this.gateway.start()
  }

  async refresh(): Promise<void> {
    await this.gateway.restart()
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose()
  }

  private async publishState(): Promise<void> {
    const state = await this.gateway.snapshot()
    await this.view?.webview.postMessage({
      type: 'state',
      state,
      configuration: this.configuration.get(),
      fallbackOptions: {
        models: MODEL_OPTIONS,
        reasoning: REASONING_OPTIONS,
        presets: AGENT_PRESET_OPTIONS,
      },
    })
  }

  private async handleMessage(value: unknown): Promise<void> {
    if (!isRecord(value) || typeof value.type !== 'string') return
    switch (value.type) {
      case 'ready':
        await this.publishState()
        break
      case 'retry':
        await this.refresh()
        break
      case 'setApiKey':
        await this.actions.setApiKey()
        break
      case 'openSettings':
        await this.actions.openSettings()
        break
      case 'showLogs':
        this.actions.showLogs()
        break
      case 'newSession':
        await this.gateway.createSession()
        break
      case 'searchSessions': {
        const query = typeof value.query === 'string' ? value.query : ''
        const results = await this.gateway.searchSessions(query)
        await this.view?.webview.postMessage({ type: 'searchResults', query, results })
        break
      }
      case 'selectSession':
        await this.gateway.openSession(requiredString(value, 'sessionId'))
        break
      case 'selectSubagent': {
        const mode = value.mode === 'continuable' ? 'continuable' : 'one-shot'
        await this.gateway.selectSubagent(requiredString(value, 'sessionId'), mode)
        break
      }
      case 'selectParent':
        await this.gateway.selectParentSession()
        break
      case 'loadOlder':
        await this.gateway.loadOlder()
        break
      case 'sendPrompt':
        await this.gateway.prompt(
          typeof value.text === 'string' ? value.text : '',
          value.mode === 'steer' ? 'steer' : 'queue',
          promptImages(value.images),
          autoSelection(typeof value.text === 'string' ? value.text : ''),
        )
        break
      case 'cancel':
        await this.gateway.cancel()
        break
      case 'setModel':
        await this.gateway.selectModel(
          requiredString(value, 'provider'),
          requiredString(value, 'model'),
          optionalString(value.reasoningEffort),
        )
        break
      case 'setReasoning':
        await this.gateway.selectReasoning(requiredString(value, 'value'))
        break
      case 'setPreset':
        await this.gateway.selectPreset(requiredString(value, 'value'))
        break
      case 'setPermission':
        await this.gateway.selectPermission(requiredString(value, 'value'))
        break
      case 'openExternal': {
        // Only http(s) links from rendered markdown are opened, never local
        // paths or custom schemes.
        const raw = typeof value.url === 'string' ? value.url : ''
        const uri = safeExternalUri(raw)
        if (uri !== undefined) void vscode.env.openExternal(uri)
        break
      }
      case 'attachSelection': {
        // Reads the active editor selection so the webview can attach it to
        // the prompt as explicit context.
        await this.view?.webview.postMessage({ type: 'selectionAttached', ...activeEditorSelection() })
        break
      }
      case 'loadCommands':
        await this.gateway.refreshCommands()
        break
      case 'runCommand':
        await this.runCommand(requiredString(value, 'name'))
        break
      case 'setPlan':
        await this.gateway.setPlanMode(value.active === true)
        break
      case 'createGoal': {
        const objective = await vscode.window.showInputBox({
          title: '创建 Harness Goal',
          prompt: 'Harness 会持续推进该目标，直到完成、暂停或达到轮次限制。',
          validateInput: (input) => input.trim() === '' ? '目标不能为空。' : undefined,
        })
        if (objective !== undefined) await this.gateway.createGoal(objective.trim())
        break
      }
      case 'mutateGoal': {
        const action = goalAction(value.action)
        await this.gateway.mutateGoal(action)
        break
      }
      case 'rename': {
        const current = await this.gateway.snapshot()
        const title = await vscode.window.showInputBox({
          title: '重命名 Harness 会话',
          value: current.active?.title ?? '',
          validateInput: (input) => input.trim() === '' ? '标题不能为空。' : undefined,
        })
        if (title !== undefined) await this.gateway.rename(title)
        break
      }
      case 'fork':
        await this.gateway.fork(numberValue(value.atSeq))
        break
      case 'answerApproval': {
        const outcome = value.outcome === 'allowed-once' ? 'allowed-once' : 'rejected'
        await this.gateway.answerApproval(requiredString(value, 'key'), outcome)
        break
      }
      case 'answerQuestions':
        await this.gateway.answerQuestions(requiredString(value, 'key'), questionAnswers(value.answers))
        break
    }
  }

  private async runCommand(name: string): Promise<void> {
    if (name === 'model') await this.pickModel()
    else if (name === 'reasoning') await this.pickReasoning()
    else if (name === 'preset') await this.pickPreset()
  }

  private async pickModel(): Promise<void> {
    const current = await this.gateway.snapshot()
    const models = current.active?.models ?? []
    const items: ModelPickItem[] = models.map((model) => ({
      label: model.name,
      description: model.provider,
      ...(model.description === undefined ? {} : { detail: model.description }),
      picked: model.id === current.active?.model?.model && model.provider === current.active?.model?.provider,
      provider: model.provider,
      id: model.id,
    }))
    const selected = await vscode.window.showQuickPick(items, {
      title: '切换模型',
      placeHolder: '选择当前会话使用的模型',
    })
    if (selected !== undefined) {
      const reasoning = current.active?.model?.reasoningEffort
      await this.gateway.selectModel(selected.provider, selected.id, reasoning)
    }
  }

  private async pickReasoning(): Promise<void> {
    const items: ValuePickItem[] = REASONING_OPTIONS.map((item) => ({
      label: item.label,
      ...(item.description === undefined ? {} : { detail: item.description }),
      value: item.id,
    }))
    const selected = await vscode.window.showQuickPick(items, {
      title: '切换推理等级',
      placeHolder: '选择当前会话的推理强度',
    })
    if (selected !== undefined) await this.gateway.selectReasoning(selected.value)
  }

  private async pickPreset(): Promise<void> {
    const current = await this.gateway.snapshot()
    const items: ValuePickItem[] = current.presets.length > 0
      ? current.presets.filter((item) => !item.broken).map((item) => ({
        label: item.name || item.id,
        ...(item.description === undefined ? {} : { detail: item.description }),
        value: item.id,
      }))
      : AGENT_PRESET_OPTIONS.map((item) => ({ label: item.label, ...(item.description === undefined ? {} : { detail: item.description }), value: item.id }))
    const selected = await vscode.window.showQuickPick(items, { title: '切换 Agent Preset', placeHolder: '选择当前会话的 Agent 预设' })
    if (selected !== undefined) await this.gateway.selectPreset(selected.value)
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(18).toString('base64')
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.js'))
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css'))
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${style}">
  <title>DeepSeek Harness</title>
</head>
<body>
  <header class="shell-header">
    <div class="brand-row">
      <button id="history-toggle" class="icon-button" title="对话历史" aria-label="对话历史">☰</button>
      <div class="brand"><span class="brand-mark">DS</span><strong>Harness</strong><span id="connection" class="connection"></span></div>
      <div class="header-actions">
        <button id="new-session" class="icon-button" title="新对话" aria-label="新对话">＋</button>
        <button id="open-settings" class="icon-button" title="扩展设置" aria-label="扩展设置">⚙</button>
      </div>
    </div>
    <div class="session-heading">
      <button id="back-parent" class="icon-button compact hidden" title="返回父 Agent" aria-label="返回父 Agent">←</button>
      <button id="session-title" class="title-button" title="重命名会话">新对话</button>
      <button id="fork" class="icon-button compact" title="从当前进度创建分支" aria-label="创建分支">⑂</button>
    </div>
    <div class="selectors" aria-label="会话设置">
      <label><span>模型</span><select id="model"></select></label>
      <label><span>推理</span><select id="reasoning"></select></label>
      <label><span>Agent</span><select id="preset"></select></label>
    </div>
  </header>

  <section id="key-banner" class="key-banner hidden">
    <span>请先在本机 settings.json 配置 DeepSeek API Key。</span>
    <button id="set-api-key">配置</button>
  </section>

  <aside id="history-panel" class="history-panel hidden" aria-label="会话历史">
    <div class="panel-heading"><strong>对话历史</strong><button id="history-close" class="icon-button">×</button></div>
    <input id="history-search" class="search-input" type="search" placeholder="搜索会话…">
    <div id="session-list" class="session-list"></div>
  </aside>

  <main id="workbench" class="workbench">
    <section id="loading" class="center-state">
      <div class="spinner"></div><h2>正在启动 Harness</h2><p>扩展正在启动内置运行时，无需单独部署。</p>
    </section>
    <section id="error" class="center-state hidden">
      <div class="error-icon">!</div><h2>连接失败</h2><p id="error-message"></p>
      <div class="state-actions"><button id="retry" class="primary-button">重试</button><button id="show-logs" class="secondary-button">日志</button></div>
    </section>
    <section id="chat" class="chat hidden">
      <div id="conversation" class="conversation">
        <button id="load-older" class="load-older hidden">加载更早记录</button>
        <section id="empty" class="empty-state">
          <div class="empty-mark">DS</div><h2>我能帮你完成什么？</h2><p>读取代码、编辑文件、运行命令、制定计划，或调用 Harness Agent 完成复杂任务。</p>
        </section>
        <div id="messages" class="messages" aria-live="polite"></div>
      </div>

      <section id="details" class="details hidden">
        <div class="detail-tabs">
          <button data-detail="todos" class="active">计划 <span id="todo-count">0</span></button>
          <button data-detail="goal">Goal</button>
          <button data-detail="skills">Skills <span id="skill-count">0</span></button>
          <button data-detail="agents">Agent <span id="agent-count">0</span></button>
          <button data-detail="jobs">任务 <span id="job-count">0</span></button>
        </div>
        <div id="detail-content" class="detail-content"></div>
      </section>

      <div id="interactions" class="interactions"></div>
      <section class="composer-shell">
        <div id="command-menu" class="command-menu hidden" role="listbox" aria-label="斜杠命令"></div>
        <div id="attachment-rail" class="attachment-rail hidden"></div>
        <textarea id="prompt" rows="1" placeholder="向 DeepSeek Harness 提问… 输入 / 查看命令" aria-label="消息"></textarea>
        <div class="composer-bar">
          <button id="attach" class="text-button" title="添加图片">＋ 图片</button>
          <input id="image-input" class="hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple>
          <button id="attach-selection" class="text-button" title="附加当前编辑器选区到消息">⬒ 选区</button>
          <button id="details-toggle" class="text-button" title="计划、Skills 与后台任务">上下文</button>
          <select id="permission" class="permission-select hidden" title="Harness 文件和命令权限"></select>
          <span id="composer-status" class="composer-status"></span>
          <button id="send" class="send-button" title="发送 (Enter)" aria-label="发送">↑</button>
        </div>
      </section>
      <p class="composer-hint">Enter 发送 · Shift+Enter 换行 · 运行时再次发送会进入队列</p>
    </section>
  </main>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`
  }
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const item = value[key]
  if (typeof item !== 'string' || item.trim() === '') throw new Error(`无效的 ${key}。`)
  return item
}

interface ModelPickItem extends vscode.QuickPickItem {
  readonly provider: string
  readonly id: string
}

interface ValuePickItem extends vscode.QuickPickItem {
  readonly value: string
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function questionAnswers(value: unknown): { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[] {
  if (!Array.isArray(value)) throw new Error('问题答案格式无效。')
  return value.map((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || !Array.isArray(item.selected)) {
      throw new Error('问题答案格式无效。')
    }
    const selected = item.selected.filter((choice): choice is string => typeof choice === 'string')
    const custom = optionalString(item.custom)
    return { id: item.id, selected, ...(custom === undefined ? {} : { custom }) }
  })
}

function promptImages(value: unknown): { readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; readonly data: string; readonly name?: string }[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 8) throw new Error('图片附件格式无效。')
  return value.map((item) => {
    if (!isRecord(item) || !isImageType(item.mediaType) || typeof item.data !== 'string') {
      throw new Error('图片附件格式无效。')
    }
    if (item.data.length > 16_000_000) throw new Error('单张图片不能超过约 12 MB。')
    const name = optionalString(item.name)
    return { mediaType: item.mediaType, data: item.data, ...(name === undefined ? {} : { name }) }
  })
}

function isImageType(value: unknown): value is 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const MAX_SELECTION_CHARS = 16_000

/** Only ever hands out http(s) URLs to the external browser. */
function safeExternalUri(raw: string): vscode.Uri | undefined {
  try {
    const uri = vscode.Uri.parse(raw)
    if (uri.scheme === 'http' || uri.scheme === 'https') return uri
  } catch {
    // Malformed URL: ignore.
  }
  return undefined
}

/** Snapshot of the active editor selection, truncated for prompt embedding. */
function activeEditorSelection(): {
  readonly file?: string
  readonly text?: string
  readonly startLine?: number
  readonly endLine?: number
  readonly tooLong?: boolean
} {
  const editor = vscode.window.activeTextEditor
  if (editor === undefined || editor.selection.isEmpty) return {}
  const { document, selection } = editor
  const text = document.getText(selection)
  const startLine = selection.start.line + 1
  const endLine = selection.end.line + 1
  if (text.length > MAX_SELECTION_CHARS) {
    return { file: document.uri.fsPath, text: text.slice(0, MAX_SELECTION_CHARS), startLine, endLine, tooLong: true }
  }
  return { file: document.uri.fsPath, text, startLine, endLine }
}

/**
 * Auto-attached selection context for the message being sent. Skips when the
 * setting is off, when the editor has no selection, or when the user already
 * embedded that selection manually (via the ⬒ 选区 button), which would
 * otherwise duplicate the code in the prompt.
 */
function autoSelection(text: string): PromptSelection | undefined {
  const selection = activeEditorSelection()
  if (selection.text === undefined) return undefined
  if (hasEmbeddedSelection(text, selection.file)) return undefined
  return {
    text: selection.text,
    ...(selection.file === undefined ? {} : { file: selection.file }),
    ...(selection.startLine === undefined ? {} : { startLine: selection.startLine }),
    ...(selection.endLine === undefined ? {} : { endLine: selection.endLine }),
    ...(selection.tooLong === true ? { tooLong: true } : {}),
  }
}

function hasEmbeddedSelection(text: string, file: string | undefined): boolean {
  if (file === undefined) return false
  const name = file.split(/[\\/]/u).pop() ?? ''
  if (name === '') return false
  return text.includes(`[来自 ${name}`) || text.includes(`[选区: ${name}`)
}

function goalAction(value: unknown): 'pause' | 'resume' | 'complete' | 'clear' {
  if (value === 'pause' || value === 'resume' || value === 'complete' || value === 'clear') return value
  throw new Error('Goal 操作无效。')
}
