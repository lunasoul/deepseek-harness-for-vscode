import { describe, expect, it } from 'vitest'
import { shouldPinStreamFrame } from '../src/webview/streaming-message/scroll-policy.js'

describe('stream frame scroll policy', () => {
  it('pins while following, with no pending pointer interaction', () => {
    expect(shouldPinStreamFrame(true, false)).toBe(true)
  })

  it('never pins while a pointer interaction is in flight', () => {
    expect(shouldPinStreamFrame(true, true)).toBe(false)
    expect(shouldPinStreamFrame(false, true)).toBe(false)
  })

  it('never pins once the reader left the bottom (followStream off)', () => {
    expect(shouldPinStreamFrame(false, false)).toBe(false)
  })

  it('pins even when one frame outgrew any proximity threshold', () => {
    // Regression: an isNearBottom gate here self-locks — a frame that renders
    // enough new text to outgrow the threshold leaves the position farther
    // than the threshold from the bottom, the next frame's probe fails too,
    // and the view never pins again although the reader never moved. Follow
    // intent is the reader's input alone.
    expect(shouldPinStreamFrame(true, false)).toBe(true)
  })
})
