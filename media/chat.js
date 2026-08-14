const vscode = acquireVsCodeApi()

const byId = (id) => document.getElementById(id)
const elements = {
  connection: byId('connection'),
  historyToggle: byId('history-toggle'),
  historyPanel: byId('history-panel'),
  historyClose: byId('history-close'),
  historySearch: byId('history-search'),
  sessionList: byId('session-list'),
  newSession: byId('new-session'),
  sessionTitle: byId('session-title'),
  backParent: byId('back-parent'),
  fork: byId('fork'),
  model: byId('model'),
  reasoning: byId('reasoning'),
  preset: byId('preset'),
  permission: byId('permission'),
  keyBanner: byId('key-banner'),
  setApiKey: byId('set-api-key'),
  openSettings: byId('open-settings'),
  loading: byId('loading'),
  error: byId('error'),
  errorMessage: byId('error-message'),
  retry: byId('retry'),
  showLogs: byId('show-logs'),
  chat: byId('chat'),
  conversation: byId('conversation'),
  loadOlder: byId('load-older'),
  empty: byId('empty'),
  messages: byId('messages'),
  details: byId('details'),
  detailsToggle: byId('details-toggle'),
  detailContent: byId('detail-content'),
  todoCount: byId('todo-count'),
  skillCount: byId('skill-count'),
  jobCount: byId('job-count'),
  agentCount: byId('agent-count'),
  interactions: byId('interactions'),
  prompt: byId('prompt'),
  commandMenu: byId('command-menu'),
  attach: byId('attach'),
  attachSelection: byId('attach-selection'),
  imageInput: byId('image-input'),
  attachmentRail: byId('attachment-rail'),
  send: byId('send'),
  composerStatus: byId('composer-status'),
}

let payload
let currentDetail = 'todos'
let previousTail = ''
let attachments = []
let searchResults = []
let searchTimer
let menuState = null
let menuLoadedSession = null

window.addEventListener('message', (event) => {
  if (event.data?.type === 'searchResults') {
    if (event.data.query === elements.historySearch.value.trim()) {
      searchResults = event.data.results
      renderSessions()
    }
    return
  }
  if (event.data?.type === 'selectionAttached') {
    insertSelection(event.data)
    return
  }
  if (event.data?.type !== 'state') return
  payload = event.data
  render()
})

elements.historyToggle.addEventListener('click', () => toggleHistory(true))
elements.historyClose.addEventListener('click', () => toggleHistory(false))
elements.historySearch.addEventListener('input', () => {
  clearTimeout(searchTimer)
  const query = elements.historySearch.value.trim()
  if (query === '') {
    searchResults = []
    renderSessions()
  } else {
    searchResults = []
    renderSessions()
    searchTimer = setTimeout(() => post('searchSessions', { query }), 180)
  }
})
elements.newSession.addEventListener('click', () => post('newSession'))
elements.sessionTitle.addEventListener('click', () => post('rename'))
elements.backParent.addEventListener('click', () => post('selectParent'))
elements.fork.addEventListener('click', () => post('fork'))
elements.setApiKey.addEventListener('click', () => post('setApiKey'))
elements.openSettings.addEventListener('click', () => post('openSettings'))
elements.retry.addEventListener('click', () => post('retry'))
elements.showLogs.addEventListener('click', () => post('showLogs'))
elements.loadOlder.addEventListener('click', () => post('loadOlder'))
elements.detailsToggle.addEventListener('click', () => elements.details.classList.toggle('hidden'))
elements.send.addEventListener('click', () => {
  if (payload?.state.active?.running) post('cancel')
  else sendPrompt()
})
elements.prompt.addEventListener('input', () => {
  resizePrompt()
  updateCommandMenu()
})
elements.prompt.addEventListener('keydown', (event) => {
  if (menuState && menuState.items.length > 0) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      menuState.index = (menuState.index + 1) % menuState.items.length
      renderCommandMenu()
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      menuState.index = (menuState.index - 1 + menuState.items.length) % menuState.items.length
      renderCommandMenu()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      chooseCommand(menuState.items[menuState.index])
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      if (menuState.items[menuState.index]) {
        const name = menuState.items[menuState.index].name
        closeCommandMenu()
        insertCommand(name)
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeCommandMenu()
      return
    }
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    sendPrompt()
  }
})
elements.prompt.addEventListener('blur', () => {
  setTimeout(() => { if (!elements.commandMenu.matches(':hover')) closeCommandMenu() }, 120)
})
elements.attach.addEventListener('click', () => elements.imageInput.click())
elements.attachSelection.addEventListener('click', () => post('attachSelection'))
elements.imageInput.addEventListener('change', async () => {
  const files = [...elements.imageInput.files]
  elements.imageInput.value = ''
  const available = Math.max(0, 8 - attachments.length)
  const accepted = files.slice(0, available).filter((file) => file.size <= 12_000_000)
  const serialized = await Promise.all(accepted.map(readImage))
  attachments = [...attachments, ...serialized]
  renderAttachmentRail()
  renderComposer(payload?.state.active)
})
elements.model.addEventListener('change', () => {
  const option = elements.model.selectedOptions[0]
  if (!option) return
  post('setModel', {
    provider: option.dataset.provider,
    model: option.value,
    reasoningEffort: elements.reasoning.value,
  })
})
elements.reasoning.addEventListener('change', () => post('setReasoning', { value: elements.reasoning.value }))
elements.preset.addEventListener('change', () => post('setPreset', { value: elements.preset.value }))
elements.permission.addEventListener('change', () => post('setPermission', { value: elements.permission.value }))
for (const tab of document.querySelectorAll('[data-detail]')) {
  tab.addEventListener('click', () => {
    currentDetail = tab.dataset.detail
    renderDetails()
  })
}

function render() {
  if (!payload) return
  const { state } = payload
  const active = state.active
  renderPhase(state)
  renderSessions()
  renderSelectors(active)
  elements.keyBanner.classList.toggle('hidden', state.hasApiKey)
  elements.sessionTitle.textContent = active?.title || '新对话'
  elements.sessionTitle.disabled = !active || !!active.parentSessionId
  elements.backParent.classList.toggle('hidden', !active?.parentSessionId)
  elements.fork.disabled = !active || active.blank
  elements.loadOlder.classList.toggle('hidden', !active?.hasMore)
  renderMessages(active)
  renderInteractions(active)
  renderAttachmentRail()
  renderDetails()
  renderComposer(active)
  updateCommandMenu()
}

function renderPhase(state) {
  const phase = state.phase
  elements.connection.className = `connection ${phase}`
  elements.connection.textContent = phase === 'connected' ? '已连接' : phase === 'reconnecting' ? '重连中' : phase === 'error' ? '异常' : '启动中'
  const failed = phase === 'error'
  const loading = phase === 'idle' || phase === 'starting'
  elements.loading.classList.toggle('hidden', !loading)
  elements.error.classList.toggle('hidden', !failed)
  elements.chat.classList.toggle('hidden', loading || failed)
  if (failed) elements.errorMessage.textContent = state.error || '未知错误'
}

function renderSessions() {
  if (!payload) return
  const query = elements.historySearch.value.trim()
  const snippets = new Map(searchResults.map((result) => [result.sessionId, result.snippet]))
  const resultIds = new Set(searchResults.map((result) => result.sessionId))
  const sessions = query === '' ? payload.state.sessions : payload.state.sessions.filter((session) => resultIds.has(session.id))
  const fragment = document.createDocumentFragment()
  for (const session of sessions) {
    const button = node('button', 'session-row')
    if (session.id === payload.state.active?.id) button.classList.add('active')
    const top = node('span', 'session-row-top')
    top.append(node('span', 'session-name', session.title), node('span', `running-dot${session.running ? ' active' : ''}`))
    const meta = node('span', 'session-meta', formatRelativeTime(session.updatedAt))
    if (session.agentPreset) meta.append(` · ${session.agentPreset}`)
    button.append(top, meta)
    const snippet = snippets.get(session.id)
    if (snippet) button.append(node('span', 'session-snippet', snippet))
    button.addEventListener('click', () => {
      post('selectSession', { sessionId: session.id })
      toggleHistory(false)
    })
    fragment.append(button)
  }
  if (sessions.length === 0) fragment.append(node('p', 'muted-empty', '没有匹配的会话'))
  elements.sessionList.replaceChildren(fragment)
}

function renderSelectors(active) {
  const realModels = active?.models || []
  const models = realModels.length > 0
    ? realModels
    : payload.fallbackOptions.models.map((item) => ({
      provider: payload.configuration.provider,
      id: item.id,
      name: item.label,
      description: item.description,
      reasoning: [],
    }))
  const modelFragment = document.createDocumentFragment()
  for (const model of models) {
    const option = document.createElement('option')
    option.value = model.id
    option.dataset.provider = model.provider
    option.textContent = model.name
    option.title = model.description || ''
    if (model.id === (active?.model?.model || payload.configuration.model)
      && model.provider === (active?.model?.provider || payload.configuration.provider)) option.selected = true
    modelFragment.append(option)
  }
  elements.model.replaceChildren(modelFragment)

  const selectedModel = models.find((model) => model.id === elements.model.value && model.provider === elements.model.selectedOptions[0]?.dataset.provider)
  const reasoning = selectedModel?.reasoning?.length > 0 ? selectedModel.reasoning : payload.fallbackOptions.reasoning
  replaceOptions(elements.reasoning, reasoning, active?.model?.reasoningEffort || payload.configuration.reasoningEffort)

  const presets = payload.state.presets.length > 0
    ? payload.state.presets.filter((item) => !item.broken).map((item) => ({ id: item.id, label: item.name || item.id, description: item.description }))
    : payload.fallbackOptions.presets
  replaceOptions(elements.preset, presets, active?.agentPreset || payload.configuration.agentPreset)

  const disabled = !active || !!active.parentSessionId || payload.state.phase !== 'connected'
  elements.model.disabled = disabled
  elements.reasoning.disabled = disabled
  elements.preset.disabled = !!active?.parentSessionId || payload.state.phase !== 'connected'
  const permissions = active?.permissions
  if (permissions) {
    replaceOptions(elements.permission, permissions.options, permissions.currentValue)
    elements.permission.classList.remove('hidden')
    elements.permission.disabled = active.running || payload.state.phase !== 'connected'
  } else {
    elements.permission.classList.add('hidden')
  }
}

function replaceOptions(select, options, selected) {
  const fragment = document.createDocumentFragment()
  for (const item of options) {
    const option = document.createElement('option')
    option.value = item.id
    option.textContent = item.label || item.name || item.id
    option.title = item.description || ''
    option.selected = item.id === selected
    fragment.append(option)
  }
  select.replaceChildren(fragment)
}

// Incremental message list: elements are keyed by stable message id and only
// new/changed items touch the DOM during streaming, instead of rebuilding the
// whole transcript on every 16ms state push.
const renderedMessages = new Map() // id -> { element, checksum }
let renderedOrder = []
let renderedSessionKey = ''

function renderMessages(active) {
  const sessionKey = active ? `${active.id}|${active.subagentMode || ''}|${active.parentSessionId || ''}` : ''
  if (sessionKey !== renderedSessionKey) {
    renderedMessages.clear()
    renderedOrder = []
    renderedSessionKey = sessionKey
  }
  const shouldStick = isNearBottom(elements.conversation)
  const messages = active?.messages || []
  const currentIds = new Set(messages.map((item) => item.id))

  for (const id of [...renderedOrder]) {
    if (!currentIds.has(id)) {
      renderedMessages.get(id)?.element.remove()
      renderedMessages.delete(id)
    }
  }
  renderedOrder = renderedOrder.filter((id) => currentIds.has(id))

  for (const item of messages) {
    const checksum = messageChecksum(item)
    const existing = renderedMessages.get(item.id)
    if (existing !== undefined && existing.checksum === checksum) continue
    const element = renderMessage(item)
    if (existing !== undefined) {
      existing.element.replaceWith(element)
      existing.element = element
      existing.checksum = checksum
    } else {
      const anchor = nextRenderedId(item.id, messages)
      const anchorElement = anchor === undefined ? undefined : renderedMessages.get(anchor)?.element
      elements.messages.insertBefore(element, anchorElement ?? null)
      renderedMessages.set(item.id, { element, checksum })
      renderedOrder.push(item.id)
    }
  }

  elements.empty.classList.toggle('hidden', messages.length > 0)
  const tail = messages.at(-1)?.id || ''
  if (shouldStick || tail !== previousTail) elements.conversation.scrollTop = elements.conversation.scrollHeight
  previousTail = tail
}

function messageChecksum(item) {
  const blocks = (item.blocks || []).map((block) => `${block.kind}:${block.text.length}`).join(',')
  return `${item.kind}|${item.role || ''}|${item.status || ''}|${item.title || ''}|${(item.detail || '').length}|${blocks}`
}

function nextRenderedId(id, messages) {
  const start = messages.findIndex((item) => item.id === id)
  for (let i = start + 1; i < messages.length; i += 1) {
    if (renderedMessages.has(messages[i].id)) return messages[i].id
  }
  return undefined
}

function renderMessage(item) {
  if (item.kind === 'tool') return renderTool(item)
  if (item.kind === 'context') return renderContext(item)
  if (item.kind === 'notice') {
    const notice = node('div', `notice ${item.status || ''}`)
    notice.append(node('strong', '', item.title || '状态'))
    if (item.detail) notice.append(node('span', '', item.detail))
    return notice
  }
  const article = node('article', `message ${item.role || ''}`)
  const label = node('div', 'message-label', item.role === 'user' ? '你' : 'DeepSeek')
  article.append(label)
  const body = node('div', 'message-body')
  for (const block of item.blocks || []) {
    if (block.kind === 'reasoning') {
      const details = node('details', 'reasoning-block')
      details.append(node('summary', '', '推理过程'), node('pre', '', block.text))
      body.append(details)
    } else if (block.kind === 'text' && (item.role === 'user' || item.role === 'assistant')) {
      const content = node('div', 'content-block md')
      content.append(renderMarkdown(block.text))
      body.append(content)
    } else {
      body.append(node('div', `content-block ${block.kind}`, block.text))
    }
  }
  if (item.status === 'running') body.append(node('span', 'typing-indicator', '● ● ●'))
  article.append(body)
  return article
}

function renderTool(item) {
  const details = node('details', `tool-card ${item.status || ''}`)
  const summary = node('summary')
  summary.append(node('span', 'tool-status'), node('span', 'tool-title', item.title || '工具'))
  details.append(summary)
  if (item.detail) details.append(node('pre', 'tool-detail', item.detail))
  return details
}

function renderContext(item) {
  const details = node('details', 'context-card')
  details.append(node('summary', '', item.title || '上下文'))
  const text = (item.blocks || []).map((block) => block.text).join('\n')
  details.append(node('pre', '', text))
  return details
}

function renderInteractions(active) {
  const fragment = document.createDocumentFragment()
  for (const approval of active?.approvals || []) {
    const card = node('section', 'interaction-card warning')
    card.append(node('strong', '', `需要批准：${approval.toolName}`))
    if (approval.reason) card.append(node('p', '', approval.reason))
    const actions = node('div', 'interaction-actions')
    const reject = node('button', 'secondary-button', '拒绝')
    reject.addEventListener('click', () => post('answerApproval', { key: approval.key, outcome: 'rejected' }))
    const allow = node('button', 'primary-button', '允许一次')
    allow.addEventListener('click', () => post('answerApproval', { key: approval.key, outcome: 'allowed-once' }))
    actions.append(reject, allow)
    card.append(actions)
    fragment.append(card)
  }
  for (const pending of active?.questions || []) fragment.append(renderQuestions(pending))
  elements.interactions.replaceChildren(fragment)
}

function renderQuestions(pending) {
  const form = node('form', 'interaction-card question-card')
  form.append(node('strong', '', 'Harness 需要你的选择'))
  for (const question of pending.questions) {
    const fieldset = document.createElement('fieldset')
    const legend = node('legend', '', question.header || question.question)
    fieldset.append(legend)
    if (question.header) fieldset.append(node('p', 'question-text', question.question))
    if (question.detail) fieldset.append(node('pre', 'question-detail', question.detail))
    for (const option of question.options) {
      const label = node('label', 'question-option')
      const input = document.createElement('input')
      input.type = question.multiSelect ? 'checkbox' : 'radio'
      input.name = `question-${question.id}`
      input.value = option.label
      label.append(input, node('span', '', option.label))
      if (option.description) label.append(node('small', '', option.description))
      fieldset.append(label)
    }
    const custom = document.createElement('input')
    custom.className = 'custom-answer'
    custom.name = `custom-${question.id}`
    custom.placeholder = '其他回答（可选）'
    fieldset.append(custom)
    form.append(fieldset)
  }
  const submit = node('button', 'primary-button', '提交回答')
  submit.type = 'submit'
  form.append(submit)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const answers = pending.questions.map((question) => ({
      id: question.id,
      selected: [...form.querySelectorAll(`[name="question-${cssEscape(question.id)}"]:checked`)].map((input) => input.value),
      custom: form.querySelector(`[name="custom-${cssEscape(question.id)}"]`)?.value || undefined,
    }))
    post('answerQuestions', { key: pending.key, answers })
  })
  return form
}

function renderDetails() {
  if (!payload) return
  const active = payload.state.active
  elements.todoCount.textContent = String(active?.todos.length || 0)
  elements.skillCount.textContent = String(active?.skills.length || 0)
  elements.jobCount.textContent = String(active?.jobs.length || 0)
  elements.agentCount.textContent = String(active?.subagents.length || 0)
  for (const tab of document.querySelectorAll('[data-detail]')) tab.classList.toggle('active', tab.dataset.detail === currentDetail)
  const fragment = document.createDocumentFragment()
  if (currentDetail === 'todos') {
    if (active?.plan) {
      const mode = node('div', 'plan-mode-row')
      const text = active.plan.pending ? 'Plan 模式切换中' : active.plan.active ? 'Plan 模式已开启' : 'Plan 模式已关闭'
      mode.append(node('span', '', text))
      const toggle = node('button', 'secondary-button', active.plan.active ? '关闭' : '开启')
      toggle.disabled = active.plan.pending || active.running
      toggle.addEventListener('click', () => post('setPlan', { active: !active.plan.active }))
      mode.append(toggle)
      fragment.append(mode)
    }
    for (const todo of active?.todos || []) {
      const row = node('div', `todo-row ${todo.status}`)
      row.append(node('span', 'todo-check', todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : '○'), node('span', '', todo.content))
      fragment.append(row)
    }
  } else if (currentDetail === 'goal') {
    const goal = active?.goal
    if (!goal) {
      const create = node('button', 'primary-button', '创建持续目标')
      create.addEventListener('click', () => post('createGoal'))
      fragment.append(create)
    } else {
      const card = node('section', 'goal-card')
      card.append(node('strong', '', goal.objective))
      card.append(node('span', 'goal-meta', `${goal.phase} · ${goal.roundsStarted}/${goal.maxGoalRounds} 轮`))
      if (goal.blockedReason) card.append(node('p', '', goal.blockedReason))
      const actions = node('div', 'goal-actions')
      if (goal.phase === 'active') actions.append(goalButton('暂停', 'pause'))
      if (goal.phase === 'paused' || goal.phase === 'blocked') actions.append(goalButton('继续', 'resume'))
      if (goal.phase !== 'complete') actions.append(goalButton('标记完成', 'complete'))
      actions.append(goalButton('清除', 'clear', true))
      card.append(actions)
      fragment.append(card)
    }
  } else if (currentDetail === 'skills') {
    for (const skill of active?.skills || []) {
      const button = node('button', 'skill-row')
      button.append(node('strong', '', `/${skill.name}`), node('span', '', skill.description))
      button.addEventListener('click', () => {
        elements.prompt.value = `/${skill.name} `
        resizePrompt()
        elements.prompt.focus()
      })
      fragment.append(button)
    }
  } else if (currentDetail === 'agents') {
    for (const agent of active?.subagents || []) {
      if (agent.kind === 'diagnostic') {
        fragment.append(node('div', 'subagent-row diagnostic', `${agent.id.slice(0, 8)} · ${agent.reason}`))
        continue
      }
      const button = node('button', 'subagent-row')
      button.append(node('span', `job-status ${agent.activity}`), node('strong', '', agent.label || `Agent ${agent.id.slice(0, 8)}`))
      button.append(node('small', '', `${agent.mode === 'continuable' ? '可继续对话' : '一次性'}${agent.hasChildren ? ' · 有子 Agent' : ''}`))
      button.addEventListener('click', () => post('selectSubagent', { sessionId: agent.id, mode: agent.mode }))
      fragment.append(button)
    }
  } else if (currentDetail === 'jobs') {
    for (const job of active?.jobs || []) {
      const row = node('div', 'job-row')
      row.append(node('span', `job-status ${job.status}`), node('div', '', job.label))
      if (job.detail) row.append(node('small', '', job.detail))
      fragment.append(row)
    }
  }
  if (!fragment.childNodes.length) fragment.append(node('p', 'muted-empty', '暂无内容'))
  elements.detailContent.replaceChildren(fragment)
}

function goalButton(label, action, secondary = false) {
  const button = node('button', secondary ? 'secondary-button' : 'primary-button', label)
  button.addEventListener('click', () => post('mutateGoal', { action }))
  return button
}

function renderComposer(active) {
  const ready = payload.state.phase === 'connected' || payload.state.phase === 'reconnecting'
  elements.prompt.disabled = !ready
  if (active?.subagentMode === 'one-shot') elements.prompt.disabled = true
  elements.send.disabled = !ready || (!active?.running && elements.prompt.value.trim() === '' && attachments.length === 0)
  elements.send.textContent = active?.running ? '■' : '↑'
  elements.send.title = active?.running ? '停止生成' : '发送 (Enter)'
  const usageText = tokenUsageText(active?.tokenUsage)
  elements.composerStatus.textContent = (active?.subagentMode === 'one-shot'
    ? '一次性子 Agent · 只读'
    : active?.running ? '运行中 · Enter 加入队列' : active?.model?.model || (active?.subagentMode === 'continuable' ? '可继续子 Agent' : '')) + usageText
}

function tokenUsageText(usage) {
  if (!usage) return ''
  const input = usage.uncachedInputTokens + usage.cacheReadTokens
  const output = usage.outputTokens
  if (input === 0 && output === 0) return ''
  return ` · ↑${formatTokens(input)} / ↓${formatTokens(output)}`
}

function formatTokens(count) {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}

function updateCommandMenu() {
  const active = payload?.state?.active
  const token = currentCommandToken(elements.prompt)
  if (token === undefined || !active) {
    closeCommandMenu()
    return
  }
  if (!menuState || menuState.query !== token) menuState = { query: token, index: 0, items: [] }
  const commands = active.commands || []
  if (menuLoadedSession !== active.id && commands.every((command) => command.kind === 'extension')) {
    menuLoadedSession = active.id
    post('loadCommands')
  }
  const query = token.toLowerCase()
  const items = commands.filter((command) => {
    const name = command.name.toLowerCase()
    return query === '' || name.includes(query) || command.description.toLowerCase().includes(query)
  })
  items.sort((left, right) => rank(left.name, query) - rank(right.name, query))
  menuState.items = items
  if (menuState.index >= items.length) menuState.index = Math.max(0, items.length - 1)
  renderCommandMenu()
}

function currentCommandToken(textarea) {
  const before = textarea.value.slice(0, textarea.selectionStart)
  const match = /(?:^|\s)\/([a-zA-Z0-9_-]*)$/.exec(before)
  return match ? match[1] : undefined
}

function rank(name, query) {
  if (query === '') return 0
  return name.toLowerCase().startsWith(query) ? 0 : 1
}

function renderCommandMenu() {
  const menu = elements.commandMenu
  if (!menuState || menuState.items.length === 0) {
    menu.classList.add('hidden')
    menu.replaceChildren()
    return
  }
  const fragment = document.createDocumentFragment()
  menuState.items.forEach((command, index) => {
    const button = node('button', `command-menu-item${index === menuState.index ? ' active' : ''}`)
    button.type = 'button'
    button.setAttribute('role', 'option')
    button.setAttribute('aria-selected', String(index === menuState.index))
    const name = node('span', 'command-name', `/${command.name}`)
    const desc = node('span', 'command-desc', command.description)
    button.append(name, desc)
    if (command.input?.hint) button.append(node('span', 'command-hint', command.input.hint))
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', () => chooseCommand(command))
    fragment.append(button)
  })
  menu.replaceChildren(fragment)
  menu.classList.remove('hidden')
}

function chooseCommand(command) {
  closeCommandMenu()
  if (command.kind === 'extension') {
    post('runCommand', { name: command.name })
    return
  }
  insertCommand(command.name)
}

function insertCommand(name) {
  elements.prompt.value = `/${name} `
  resizePrompt()
  elements.prompt.focus()
  elements.prompt.setSelectionRange(elements.prompt.value.length, elements.prompt.value.length)
}

function closeCommandMenu() {
  menuState = null
  elements.commandMenu.classList.add('hidden')
  elements.commandMenu.replaceChildren()
}

function sendPrompt() {
  closeCommandMenu()
  const text = elements.prompt.value.trim()
  if (!text && attachments.length === 0) return
  post('sendPrompt', { text, mode: 'queue', images: attachments.map(({ mediaType, data, name }) => ({ mediaType, data, name })) })
  elements.prompt.value = ''
  attachments = []
  renderAttachmentRail()
  resizePrompt()
}

function renderAttachmentRail() {
  const fragment = document.createDocumentFragment()
  attachments.forEach((attachment, index) => {
    const item = node('div', 'attachment-item')
    const image = document.createElement('img')
    image.src = `data:${attachment.mediaType};base64,${attachment.data}`
    image.alt = attachment.name || '图片附件'
    const remove = node('button', 'attachment-remove', '×')
    remove.title = '移除图片'
    remove.addEventListener('click', () => {
      attachments.splice(index, 1)
      renderAttachmentRail()
      renderComposer(payload?.state.active)
    })
    item.append(image, remove)
    fragment.append(item)
  })
  elements.attachmentRail.replaceChildren(fragment)
  elements.attachmentRail.classList.toggle('hidden', attachments.length === 0)
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      if (comma < 0) reject(new Error('图片读取失败'))
      else resolve({ mediaType: file.type, data: result.slice(comma + 1), name: file.name })
    }, { once: true })
    reader.addEventListener('error', () => reject(reader.error || new Error('图片读取失败')), { once: true })
    reader.readAsDataURL(file)
  })
}

function resizePrompt() {
  elements.prompt.style.height = 'auto'
  elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, 180)}px`
  if (payload) renderComposer(payload.state.active)
}

function toggleHistory(open) {
  elements.historyPanel.classList.toggle('hidden', !open)
  if (open) elements.historySearch.focus()
}

function post(type, data = {}) {
  vscode.postMessage({ type, ...data })
}

function node(tag, className = '', text = '') {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text) element.textContent = text
  return element
}

function isNearBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 100
}

function formatRelativeTime(time) {
  const delta = Date.now() - time
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  return new Date(time).toLocaleDateString()
}

function cssEscape(value) {
  return window.CSS?.escape ? window.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}

// ---------- Markdown rendering (XSS-safe: every text node via textContent) ----------

function renderMarkdown(text) {
  const fragment = document.createDocumentFragment()
  const lines = text.split(/\r?\n/)
  let paragraph = []
  let list = null
  let listOrdered = false
  let code = null // { lang, lines }

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    const p = node('p', 'md-paragraph')
    p.append(renderInline(paragraph.join(' ')))
    fragment.append(p)
    paragraph = []
  }
  const flushList = () => {
    if (list === null) return
    const wrap = node(listOrdered ? 'ol' : 'ul', 'md-list')
    for (const item of list) wrap.append(item)
    fragment.append(wrap)
    list = null
  }
  const flushCode = () => {
    if (code === null) return
    const wrap = node('div', 'md-codeblock')
    const header = node('div', 'md-codeblock-header')
    header.append(node('span', 'md-codeblock-lang', code.lang || '代码'))
    const copy = node('button', 'md-copy', '复制')
    copy.type = 'button'
    copy.addEventListener('click', () => copyText(code.lines.join('\n')))
    header.append(copy)
    const pre = node('pre')
    const inner = node('code')
    inner.textContent = code.lines.join('\n')
    pre.append(inner)
    wrap.append(header, pre)
    fragment.append(wrap)
    code = null
  }

  for (const raw of lines) {
    if (code !== null) {
      if (/^\s*```\s*$/.test(raw)) flushCode()
      else code.lines.push(raw)
      continue
    }
    const fenceOpen = /^\s*```([\w+-]*)\s*$/.exec(raw)
    if (fenceOpen) {
      flushParagraph()
      flushList()
      code = { lang: fenceOpen[1] || '', lines: [] }
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(raw)
    if (heading) {
      flushParagraph()
      flushList()
      const h = node(`h${Math.min(heading[1].length + 1, 4)}`, 'md-heading')
      h.append(renderInline(heading[2]))
      fragment.append(h)
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      flushParagraph()
      flushList()
      fragment.append(node('hr', 'md-hr'))
      continue
    }
    const quote = /^>\s?(.*)$/.exec(raw)
    if (quote) {
      flushParagraph()
      flushList()
      const q = node('blockquote', 'md-quote')
      q.append(renderInline(quote[1]))
      fragment.append(q)
      continue
    }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(raw)
    if (item) {
      flushParagraph()
      if (list === null) {
        list = []
        listOrdered = /^\s*\d+/.test(raw)
      }
      const li = node('li', 'md-list-item')
      li.append(renderInline(item[1]))
      list.push(li)
      continue
    }
    if (raw.trim() === '') {
      flushParagraph()
      flushList()
      continue
    }
    paragraph.push(raw.trim())
  }
  flushParagraph()
  flushList()
  flushCode()
  return fragment
}

// Only http(s) links are recognized; everything else stays plain text.
const INLINE_TOKEN = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g

function renderInline(text) {
  const fragment = document.createDocumentFragment()
  let last = 0
  let match
  INLINE_TOKEN.lastIndex = 0
  while ((match = INLINE_TOKEN.exec(text)) !== null) {
    if (match.index > last) fragment.append(document.createTextNode(text.slice(last, match.index)))
    const token = match[0]
    if (token.startsWith('**')) {
      fragment.append(node('strong', 'md-strong', token.slice(2, -2)))
    } else if (token.startsWith('`')) {
      fragment.append(node('code', 'md-inline-code', token.slice(1, -1)))
    } else if (token.startsWith('[')) {
      const close = token.lastIndexOf('](')
      const label = token.slice(1, close)
      const url = token.slice(close + 2, -1)
      const link = node('a', 'md-link', label)
      link.href = url
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.addEventListener('click', (event) => {
        event.preventDefault()
        post('openExternal', { url })
      })
      fragment.append(link)
    } else {
      fragment.append(node('em', 'md-em', token.slice(1, -1)))
    }
    last = match.index + token.length
  }
  if (last < text.length) fragment.append(document.createTextNode(text.slice(last)))
  return fragment
}

function copyText(text) {
  if (navigator.clipboard?.writeText !== undefined) {
    navigator.clipboard.writeText(text).catch(() => legacyCopy(text))
  } else {
    legacyCopy(text)
  }
}

function legacyCopy(text) {
  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  try {
    document.execCommand('copy')
  } catch {
    // Clipboard unavailable; the user can still select the text manually.
  }
  area.remove()
}

function insertSelection(selection) {
  if (!selection || !selection.text) return
  const fileName = selection.file ? selection.file.split(/[\\/]/).pop() : '选区'
  const ext = fileName.includes('.') ? fileName.split('.').pop() : ''
  const range = selection.startLine !== undefined && selection.endLine !== undefined
    ? ` (${selection.startLine}-${selection.endLine} 行)`
    : ''
  const snippet = `[来自 ${fileName}${range} 的选区${selection.tooLong ? '（已截断）' : ''}]:\n\`\`\`${ext}\n${selection.text}\n\`\`\`\n\n`
  const prompt = elements.prompt
  const start = prompt.selectionStart ?? prompt.value.length
  const end = prompt.selectionEnd ?? start
  prompt.value = prompt.value.slice(0, start) + snippet + prompt.value.slice(end)
  resizePrompt()
  renderComposer(payload?.state.active)
  prompt.focus()
  prompt.setSelectionRange(prompt.value.length, prompt.value.length)
}

vscode.postMessage({ type: 'ready' })
