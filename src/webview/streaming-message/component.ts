import type { ChatBlock, ChatItem } from '../../domain/workbench-state.js'
import { createSequentialActivityDots } from '../activity-indicator/component.js'
import { applyIcon, icon } from '../icons.js'
import { nextStreamText, shouldRebuildStreamFrame, STREAMING_REBUILD_CHAR_THRESHOLD, STREAMING_REBUILD_MIN_INTERVAL_MS } from './model.js'

type StreamingMessage = Pick<ChatItem, 'status' | 'blocks'>

interface StreamState {
  rendered: string
  target: string
  frame: number | undefined
  /** Authoritative adapter-reported reasoning tokens, once the usage chunk lands. */
  tokens?: number
  /** Monotonic live estimate so the counter only grows while streaming. */
  labelTokens?: number
  /** Whether the reasoning content keeps auto-scrolling to its own bottom. */
  follow?: boolean
  /** Text handed to the last full markdown rebuild ('' before the first). */
  lastRendered: string
  /** Timestamp of the last full markdown rebuild. */
  lastRenderAt: number
}

/** Rough live token estimate for streamed reasoning text (≈4 chars/token). */
function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.trim().length / 4))
}

/** Owns reasoning disclosure state and smooth incremental assistant text. */
export class StreamingMessageComponent {
  private readonly streams = new WeakMap<HTMLElement, StreamState>()

  constructor(private readonly options: {
    readonly document: Document
    readonly reasoningLabel: () => string
    /** "Thinking… · 1,234 tokens" once a running reasoning block has text or usage. */
    readonly thinkingLabel: (tokens?: number) => string
    /** "Thought for 12s · 342 tokens" style label once a reasoning block has known timing. */
    readonly reasoningDoneLabel: (elapsedMs: number, tokens?: number) => string
    readonly renderMarkdown: (target: HTMLElement, source: string) => void
    readonly onStreamFrame: () => void
  }) {}

  render(body: HTMLElement, item: StreamingMessage): void {
    const running = item.status === 'running'
    for (const [index, block] of (item.blocks ?? []).entries()) {
      body.append(this.renderBlock(block, index, running))
    }
    if (running) body.append(createSequentialActivityDots(this.options.document))
  }

  patch(body: HTMLElement, item: StreamingMessage): boolean {
    const blocks = item.blocks ?? []
    const renderedBlocks = Array.from(body.children).filter((child) => !child.classList.contains('streaming-indicator'))
    const running = item.status === 'running'
    // Streaming appends blocks (a new reasoning block starts, a text block
    // follows a tool call). Growing is a normal patch, not a structure change:
    // render the new blocks instead of bailing to a full re-render — a full
    // re-render would rebuild every reasoning <details> closed and make the
    // reader's expand snap shut in real time.
    if (renderedBlocks.length < blocks.length) {
      for (let index = renderedBlocks.length; index < blocks.length; index += 1) {
        const block = blocks[index]
        if (block !== undefined) body.insertBefore(this.renderBlock(block, index, running), body.querySelector('.streaming-indicator'))
      }
    } else if (renderedBlocks.length > blocks.length) {
      return false
    }
    const settled = Array.from(body.children).filter((child) => !child.classList.contains('streaming-indicator'))
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]
      const rendered = settled[index]
      if (block === undefined || !(rendered instanceof HTMLElement)) return false
      if (!this.patchBlock(rendered, block, running)) return false
    }
    const indicator = body.querySelector('.streaming-indicator')
    if (running && indicator === null) body.append(createSequentialActivityDots(this.options.document))
    else if (!running) indicator?.remove()
    return true
  }

  private renderBlock(block: ChatBlock, index: number, messageRunning: boolean): HTMLElement {
    const running = messageRunning && block.streaming === true
    if (block.kind === 'reasoning') {
      const details = this.options.document.createElement('details')
      details.className = `reasoning-block${running ? ' running' : ''}`
      details.dataset.disclosureKey = `reasoning-${index}`
      // Like the DSH Web UI, the thinking block stays collapsed by default;
      // the summary row carries a one-line live preview while it streams, and
      // the reader expands it explicitly if they want the full reasoning.
      details.dataset.autoOpen = 'false'
      details.open = false
      // A collapse by the reader overrides the streaming auto-open. The toggle
      // is tracked manually (the summary click arrives before `open` flips, so
      // "not open" alone cannot distinguish "was open" from "was closed").
      details.addEventListener('toggle', () => {
        if (!details.open) details.dataset.readerCollapsed = 'true'
        else delete details.dataset.readerCollapsed
      })
      const summary = this.options.document.createElement('summary')
      summary.append(this.reasoningDot(), this.label(running, block), this.reasoningPreview(block.text), this.chevron())
      const content = this.options.document.createElement('div')
      content.className = `reasoning-content markdown-body${running ? ' streaming-content' : ''}`
      this.renderContent(content, block, running)
      details.append(summary, content)
      return details
    }
    const content = this.options.document.createElement('div')
    content.className = `content-block ${block.kind}${block.kind === 'text' ? ' markdown-body' : ''}${running ? ' streaming-content' : ''}`
    this.renderContent(content, block, running)
    return content
  }

  private patchBlock(rendered: HTMLElement, block: ChatBlock, messageRunning: boolean): boolean {
    const running = messageRunning && block.streaming === true
    if (block.kind === 'reasoning') {
      if (!(rendered instanceof HTMLDetailsElement) || !rendered.classList.contains('reasoning-block')) return false
      const content = rendered.querySelector<HTMLElement>('.reasoning-content')
      const label = rendered.querySelector<HTMLElement>('.reasoning-label')
      if (content === null || label === null) return false
      rendered.classList.toggle('running', running)
      // The disclosure stays whatever the reader set it to: no per-frame
      // force-close (which made an explicit expand snap back instantly).
      // Initial render starts collapsed; the summary row keeps the live
      // one-line preview while streaming.
      label.textContent = this.labelText(running, block)
      const summary = rendered.querySelector<HTMLElement>('.reasoning-summary')
      if (summary !== null) {
        const value = this.reasoningPreviewText(block.text)
        summary.textContent = value
        summary.title = value
      }
      content.classList.toggle('streaming-content', running)
      this.renderContent(content, block, running)
      return true
    }
    if (!rendered.classList.contains('content-block') || !rendered.classList.contains(block.kind)) return false
    rendered.classList.toggle('streaming-content', running)
    this.renderContent(rendered, block, running)
    return true
  }

  private renderContent(target: HTMLElement, block: ChatBlock, running: boolean): void {
    if (block.kind === 'image') {
      this.finishStream(target)
      target.textContent = block.text
    } else if (running) {
      this.stream(target, block.text, block.reasoningTokens)
    } else {
      this.finishStream(target)
      this.options.renderMarkdown(target, block.text)
    }
  }

  private stream(target: HTMLElement, text: string, tokens?: number): void {
    let state = this.streams.get(target)
    if (state === undefined) {
      target.textContent = ''
      state = { rendered: '', target: text, frame: undefined, follow: true, lastRendered: '', lastRenderAt: 0, ...(tokens === undefined ? {} : { tokens }) }
      this.streams.set(target, state)
      // The reasoning content auto-follows its own stream, but an intentional
      // scroll-up inside the card must win: once the reader moves off the
      // bottom the card stops being yanked down, and resumes only after they
      // scroll back to its very bottom.
      if (target.classList.contains('reasoning-content') && target.dataset.followBound === undefined) {
        target.dataset.followBound = 'true'
        target.addEventListener('scroll', () => {
          const current = this.streams.get(target)
          if (current === undefined) return
          const atBottom = target.scrollHeight - target.scrollTop - target.clientHeight <= 4
          if (atBottom) current.follow = true
          else if (current.follow !== false) current.follow = false
        }, { passive: true })
      }
    } else {
      state.target = text
      if (tokens !== undefined) state.tokens = tokens
    }
    if (state.frame === undefined) this.schedule(target, state)
  }

  private schedule(target: HTMLElement, state: StreamState): void {
    state.frame = requestAnimationFrame(() => {
      state.frame = undefined
      if (!target.isConnected) return
      state.rendered = nextStreamText(state.rendered, state.target)
      // Full-block markdown rebuilds (markdown-it + DOMPurify + innerHTML) are
      // expensive and scale with the accumulated text. Rebuilding on every rAF
      // frame makes long replies janky on the webview's main thread. The first
      // visible frame renders immediately; subsequent frames are throttled by
      // accumulated text and elapsed time, and the final frame always rebuilds
      // so the stream lands exactly on its target.
      const now = Date.now()
      if (shouldRebuildStreamFrame(
        { rendered: state.rendered, target: state.target, lastRendered: state.lastRendered, lastRenderAt: state.lastRenderAt },
        now,
        STREAMING_REBUILD_MIN_INTERVAL_MS,
        STREAMING_REBUILD_CHAR_THRESHOLD,
      )) {
        this.options.renderMarkdown(target, state.rendered)
        state.lastRendered = state.rendered
        state.lastRenderAt = now
      }
      if (target.classList.contains('reasoning-content')) {
        if (state.follow !== false) target.scrollTop = target.scrollHeight
        this.updateStreamingLabel(target, state)
      }
      this.options.onStreamFrame()
      if (state.rendered !== state.target) this.schedule(target, state)
    })
  }

  /** Keeps the "Thinking… · N tokens" label ticking while reasoning streams. */
  private updateStreamingLabel(target: HTMLElement, state: StreamState): void {
    const label = target.closest('.reasoning-block')?.querySelector('.reasoning-label')
    if (!(label instanceof HTMLElement)) return
    if (state.tokens !== undefined) {
      label.textContent = this.options.thinkingLabel(state.tokens)
      return
    }
    const estimate = estimateTokens(state.rendered)
    if (estimate <= (state.labelTokens ?? 0)) return
    state.labelTokens = estimate
    label.textContent = this.options.thinkingLabel(estimate)
  }

  private finishStream(target: HTMLElement): void {
    const state = this.streams.get(target)
    if (state?.frame !== undefined) cancelAnimationFrame(state.frame)
    this.streams.delete(target)
  }

  private reasoningPreview(text: string): HTMLElement {
    const preview = this.options.document.createElement('span')
    preview.className = 'reasoning-summary'
    const value = this.reasoningPreviewText(text)
    preview.textContent = value
    preview.title = value
    return preview
  }

  /**
   * One-line live preview of the *newest* thought text. The DSH reasoning
   * stream usually opens with a fixed lead-in (the user message echo) that
   * never changes, so previewing the first line looks frozen; taking the tail
   * makes the row visibly stream with every new thought fragment.
   */
  private reasoningPreviewText(text: string): string {
    const single = text.replace(/\s+/g, ' ').trim()
    if (single === '') return ''
    const MAX = 100
    return single.length > MAX ? `…${single.slice(-MAX)}` : single
  }

  private reasoningDot(): HTMLElement {
    const dot = this.options.document.createElement('span')
    dot.className = 'reasoning-dot'
    applyIcon(dot, icon('atom', 12))
    return dot
  }

  private label(running: boolean, block?: ChatBlock): HTMLElement {
    const label = this.options.document.createElement('span')
    label.className = 'reasoning-label'
    label.textContent = this.labelText(running, block)
    return label
  }

  private labelText(running: boolean, block?: ChatBlock): string {
    if (running) return this.options.thinkingLabel(this.liveTokens(block))
    if (block?.duration !== undefined) {
      const elapsed = Math.max(0, (block.duration.endedAt ?? Date.now()) - block.duration.startedAt)
      return this.options.reasoningDoneLabel(elapsed, block.reasoningTokens)
    }
    return this.options.reasoningLabel()
  }

  /** Adapter-reported count when known, else a live estimate from the streamed text. */
  private liveTokens(block: ChatBlock | undefined): number | undefined {
    if (block === undefined || block.kind !== 'reasoning') return undefined
    if (block.reasoningTokens !== undefined) return block.reasoningTokens
    if (block.text.trim() === '') return undefined
    return estimateTokens(block.text)
  }

  private chevron(): HTMLElement {
    const chevron = this.options.document.createElement('span')
    chevron.className = 'reasoning-chevron'
    chevron.textContent = '⌄'
    chevron.setAttribute('aria-hidden', 'true')
    return chevron
  }
}
