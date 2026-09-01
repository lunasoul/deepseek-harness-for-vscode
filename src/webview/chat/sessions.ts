import type { ActiveSessionView, PermissionView } from '../../domain/workbench-state.js'
import { FULL_ACCESS_PERMISSION_ID, PERMISSION_PRESET_IDS } from '../../domain/permissions.js'
import { applyIcon, icon } from '../icons.js'
import { composerConfigurationInput } from '../composer-configuration/adapter.js'
import { permissionSelectOptions, type PermissionSelectOption } from '../permission/adapter.js'
import { clearPastedImages } from './images.js'
import { closeTimeline } from './timeline.js'
import {
  components,
  elements,
  node,
  payload,
  post,
  searchResults,
  selectorSignature,
  setSelectorSignature,
  t,
  workspaceFolderOpen,
} from './context.js'
import { formatRelativeTime } from './utils.js'

let showingArchived = false

export function renderSessions(): void {
  if (!payload) return
  const query = elements.historySearch.value.trim()
  const snippets = new Map(searchResults.map((result) => [result.sessionId, result.snippet]))
  const resultIds = new Set(searchResults.map((result) => result.sessionId))
  const pool = showingArchived ? payload.state.archivedSessions : payload.state.sessions
  const sessions = query === '' ? pool : pool.filter((session) => resultIds.has(session.id))
  const fragment = document.createDocumentFragment()
  for (const session of sessions) {
    // Every row can be archived, including blank drafts: an unwanted
    // new-conversation stub is hidden exactly like any other conversation.
    const canArchive = true
    const wrap = node('div', 'session-row-wrap')
    const button = node('button', `session-row${canArchive ? ' has-archive-action' : ''}${session.isolated === true ? ' has-worktree-action' : ''}`) as HTMLButtonElement
    if (session.id === payload.state.active?.id) button.classList.add('active')
    const top = node('span', 'session-row-top')
    top.append(node('span', 'session-name', session.title), node('span', `running-dot${session.running ? ' active' : ''}`))
    if (session.meta?.pinned === true) { const mark = node('span', 'session-mark'); applyIcon(mark, icon('pin', 10)); top.append(mark) }
    const meta = node('span', 'session-meta', formatRelativeTime(session.updatedAt))
    if (session.agentPreset) meta.append(` · ${session.agentPreset}`)
    button.append(top, meta)
    if (session.shared === true) {
      const shared = node('span', 'session-tag shared', t('sharedWorkspaceTag'))
      shared.title = t('sharedWorkspaceHint')
      shared.setAttribute('aria-label', t('sharedWorkspaceHint'))
      button.append(shared)
    }
    const tags = session.meta?.tags ?? []
    if (tags.length > 0) {
      const tagRow = node('span', 'session-tags')
      for (const tag of tags) tagRow.append(node('span', 'session-tag', tag))
      button.append(tagRow)
    }
    const snippet = snippets.get(session.id)
    if (snippet) button.append(node('span', 'session-snippet', snippet))
    button.addEventListener('click', () => {
      components.composerConfiguration.reset()
      closeTimeline()
      clearPastedImages()
      post('selectSession', { sessionId: session.id })
      toggleHistory(false)
    })
    wrap.append(button)
    const actions = node('div', 'session-row-actions')
    const pinned = session.meta?.pinned === true
    const pin = metaAction(pinned ? t('unpinSession') : t('pinSession'), pinned ? icon('pin', 12) : icon('unpin', 12), () => post('toggleSessionPin', { sessionId: session.id }))
    if (pinned) pin.classList.add('active')
    actions.append(pin)
    actions.append(metaAction(t('editSessionTags'), '#', () => post('editSessionTags', { sessionId: session.id })))
    if (canArchive) {
      const action = node('button', 'icon-button compact session-archive-action') as HTMLButtonElement
      action.type = 'button'
      action.title = showingArchived ? t('restoreSession') : t('archiveSession')
      action.setAttribute('aria-label', action.title)
      applyIcon(action, showingArchived ? icon('restore', 12) : icon('archive', 12))
      action.addEventListener('click', (event) => {
        event.stopPropagation()
        if (showingArchived) {
          post('restoreSession', { sessionId: session.id })
          // Follow the row back to the default list instead of leaving the user
          // staring at the archived view it just left.
          showingArchived = false
          renderSessions()
          return
        }
        post('archiveSession', { sessionId: session.id })
      })
      actions.append(action)
    }
    wrap.append(actions)
    if (session.isolated === true) {
      const action = node('button', 'icon-button compact session-worktree-action') as HTMLButtonElement
      action.type = 'button'
      action.title = t('worktreeActions')
      action.setAttribute('aria-label', action.title)
      applyIcon(action, icon('fork', 12))
      action.addEventListener('click', (event) => {
        event.stopPropagation()
        post('worktreeAction', { sessionId: session.id })
      })
      wrap.append(action)
    }
    fragment.append(wrap)
  }
  if (sessions.length === 0) {
    const archivedHits = query === '' || showingArchived
      ? []
      : payload.state.archivedSessions.filter((session) => resultIds.has(session.id))
    if (archivedHits.length > 0) {
      fragment.append(node('p', 'muted-empty', t('archivedSearchHint', { count: String(archivedHits.length) })))
    } else if (showingArchived && query !== '') {
      // Archived rows exist but none match the search query.
      fragment.append(node('p', 'muted-empty', t('noMatchingArchivedConversations')))
    } else if (showingArchived) {
      fragment.append(node('p', 'muted-empty', t('noArchivedConversations')))
    } else if (query === '') {
      // No conversations belong to this window's scope — either the project
      // has no history yet, or no project is open at all.
      fragment.append(node('p', 'muted-empty', t(workspaceFolderOpen ? 'noProjectConversations' : 'historyNeedsProject')))
    } else {
      fragment.append(node('p', 'muted-empty', t('noMatchingConversations')))
    }
  }
  elements.sessionList.replaceChildren(fragment)
  renderHistoryFilter()
}

function renderHistoryFilter(): void {
  if (!payload) return
  const archivedCount = payload.state.archivedSessions.length
  elements.historyArchived.classList.toggle('active', showingArchived)
  elements.historyArchived.setAttribute('aria-pressed', String(showingArchived))
  elements.historyArchived.textContent = archivedCount === 0
    ? t('archivedConversations')
    : `${t('archivedConversations')} ${archivedCount}`
}

export function toggleArchivedHistory(): void {
  showingArchived = !showingArchived
  renderSessions()
}

export function renderSelectors(active: ActiveSessionView | undefined): void {
  if (!payload) return
  const nextSignature = JSON.stringify({
    sessionId: active?.id,
    phase: payload.state.phase,
    configuration: payload.configuration,
    fallbackOptions: payload.fallbackOptions,
    presets: payload.state.presets,
    models: active?.models,
    model: active?.model,
    agentPreset: active?.agentPreset,
    parentSessionId: active?.parentSessionId,
    permissions: active?.permissions,
    running: active?.running,
    effortIntent: active?.effortIntent,
  })
  if (nextSignature === selectorSignature) return
  setSelectorSignature(nextSignature)
  components.composerConfiguration.update(composerConfigurationInput(payload))
  const permissions = active?.permissions
  if (permissions) {
    renderPermissionOptions(permissions)
    elements.permission.classList.remove('hidden')
    elements.permissionToggle.disabled = active?.running === true || payload.state.phase !== 'connected'
    elements.permissionToggle.classList.toggle('danger', permissions.currentValue === FULL_ACCESS_PERMISSION_ID)
  } else {
    elements.permission.classList.add('hidden')
    closePermissionPopup()
  }
}

function renderPermissionOptions(permissions: PermissionView): void {
  const runtimeOptions = permissionSelectOptions(permissions)
  const options = mergePermissionOptions(runtimeOptions, permissions.currentValue)
  const selected = options.find((option) => option.id === permissions.currentValue)
  elements.permissionToggleLabel.textContent = selected?.label ?? permissions.currentValue
  const fragment = document.createDocumentFragment()
  for (const item of options) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `permission-option${item.id === permissions.currentValue ? ' active' : ''}`
    button.setAttribute('role', 'option')
    button.setAttribute('aria-selected', String(item.id === permissions.currentValue))
    button.title = item.description || ''
    const label = document.createElement('span')
    label.className = 'permission-option-label'
    label.textContent = item.label || item.id
    button.append(label)
    const check = document.createElement('span')
    check.className = 'permission-option-check'
    applyIcon(check, item.id === permissions.currentValue ? icon('check', 12) : '')
    button.append(check)
    if (item.disabled) {
      button.disabled = true
    } else {
      button.addEventListener('click', () => {
        // Full access bypasses every prompt; require an explicit confirmation
        // first, like the official Web UI does.
        if (item.id === FULL_ACCESS_PERMISSION_ID && permissions.currentValue !== FULL_ACCESS_PERMISSION_ID) {
          closePermissionPopup()
          openPermissionConfirm()
          return
        }
        post('setPermission', { value: item.id })
        closePermissionPopup()
      })
    }
    fragment.append(button)
  }
  elements.permissionOptions.replaceChildren(fragment)
}

/**
 * The Harness runtime projection may arrive with only a `currentValue` and no
 * `options` list (older builds / some providers). The extension always offers
 * the three sandbox presets, so merge the runtime options with a static
 * fallback list to keep the selector usable.
 */
function mergePermissionOptions(
  runtimeOptions: readonly PermissionSelectOption[],
  currentValue: string,
): readonly PermissionSelectOption[] {
  const fallback: readonly PermissionSelectOption[] = PERMISSION_PRESET_IDS.map((id) => ({
    id,
    label: id,
    disabled: false,
  }))
  const map = new Map<string, PermissionSelectOption>()
  for (const option of runtimeOptions) map.set(option.id, option)
  for (const option of fallback) if (!map.has(option.id)) map.set(option.id, option)
  const options = [...map.values()]
  if (!options.some((option) => option.id === currentValue)) {
    options.push({ id: currentValue, label: currentValue, disabled: false })
  }
  return options
}

export function togglePermissionPopup(): void {
  if (elements.permissionPopup.classList.contains('hidden')) openPermissionPopup()
  else closePermissionPopup()
}

function openPermissionPopup(): void {
  if (elements.permissionToggle.disabled) return
  closePermissionConfirm()
  anchorPermissionOverlay(elements.permissionPopup, elements.permissionToggle)
  elements.permissionPopup.classList.remove('hidden')
  elements.permissionToggle.classList.add('active')
  elements.permissionToggle.setAttribute('aria-expanded', 'true')
}

export function closePermissionPopup(): void {
  elements.permissionPopup.classList.add('hidden')
  resetPermissionOverlayAnchor(elements.permissionPopup)
  elements.permissionToggle.classList.remove('active')
  elements.permissionToggle.setAttribute('aria-expanded', 'false')
}

export function openPermissionConfirm(): void {
  anchorPermissionOverlay(elements.permissionConfirm, elements.permissionToggle)
  elements.permissionConfirm.classList.remove('hidden')
  elements.permissionConfirmAccept.focus()
}

export function closePermissionConfirm(refocus = false): void {
  elements.permissionConfirm.classList.add('hidden')
  resetPermissionOverlayAnchor(elements.permissionConfirm)
  if (refocus) elements.permissionToggle.focus()
}

/**
 * The permission popups are DOM children of .composer-tools, which switches to
 * overflow: hidden below 680px (chat-responsive.css) so the toolbar cannot
 * push the shell apart on narrow sidebars. That clip also cut off these
 * upward-opening overlays, making the selector silently vanish on narrow
 * windows. position: fixed escapes every ancestor clip while staying glued to
 * the toggle's current viewport position.
 */
function anchorPermissionOverlay(overlay: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect()
  const width = Math.min(220, window.innerWidth - 16)
  const left = Math.max(4, Math.min(rect.left, window.innerWidth - width - 4))
  overlay.style.position = 'fixed'
  overlay.style.left = left + 'px'
  overlay.style.bottom = Math.max(4, window.innerHeight - rect.top + 6) + 'px'
}

function resetPermissionOverlayAnchor(overlay: HTMLElement): void {
  overlay.style.position = ''
  overlay.style.left = ''
  overlay.style.bottom = ''
}

export function toggleHistory(open: boolean): void {
  if (open) components.pluginCenter.close()
  elements.historyPanel.classList.toggle('hidden', !open)
  if (open) {
    renderSessions()
    elements.historySearch.focus()
  }
}

function metaAction(label: string, glyph: string, onClick: () => void): HTMLButtonElement {
  const action = node('button', 'icon-button compact session-archive-action') as HTMLButtonElement
  action.type = 'button'
  action.title = label
  action.setAttribute('aria-label', label)
  applyIcon(action, glyph)
  action.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick()
  })
  return action
}
