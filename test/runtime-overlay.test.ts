import { describe, expect, it } from 'vitest'
import { renderOverlay } from '../src/runtime/runtime-overlay.js'

describe('Harness Web profile overlay', () => {
  it('projects model, reasoning and agent preset defaults', () => {
    const overlay = renderOverlay({
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      agentPreset: 'code',
      provider: 'deepseek-official',
      permissionMode: 'workspace-write',
      baseUrl: undefined,
      autoAttachSelection: true,
    })
    expect(overlay).toContain('reasoningEffort: max')
    expect(overlay).toContain('model: deepseek-v4-pro')
    expect(overlay).toContain('default: code')
  })

  it('disables thinking and safely quotes custom provider ids', () => {
    const overlay = renderOverlay({
      model: 'deepseek-v4-flash',
      reasoningEffort: 'off',
      agentPreset: 'standard',
      provider: 'custom: route',
      permissionMode: 'read-only',
      baseUrl: 'https://example.test',
      autoAttachSelection: false,
    })
    expect(overlay).toContain('thinking: disabled')
    expect(overlay).toContain('provider: "custom: route"')
  })
})
