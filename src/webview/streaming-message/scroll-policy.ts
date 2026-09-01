/**
 * Decides whether a streaming frame should re-pin the conversation to its
 * bottom.
 *
 * Follow intent comes from `followStream` alone: it is flipped off by any
 * scroll that leaves the bottom (wheel-up, touch-drag up, scrollbar drag) and
 * re-armed by touching the very bottom again, so it already encodes "the
 * reader is following the stream".
 *
 * A proximity probe (e.g. isNearBottom) must NOT gate this decision: one frame
 * that renders enough new text to outgrow the probe threshold (typically a
 * large chunk arriving in a single state push) leaves the position farther
 * than the threshold from the bottom, so the next frame's probe fails too and
 * the view never pins again even though the reader never moved — the DeepSeek
 * card appears, but the transcript stays stuck partway up.
 *
 * `interactionArmed` pauses the pin while a pointer interaction (scrollbar
 * grab, text selection) is in flight so the reader's cursor never fights the
 * auto-scroll.
 */
export function shouldPinStreamFrame(followStream: boolean, interactionArmed: boolean): boolean {
  return followStream && !interactionArmed
}
