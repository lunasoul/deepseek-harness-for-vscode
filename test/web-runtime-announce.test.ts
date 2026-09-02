import { describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => ({
  EventEmitter: class {
    fire(): void {}
    event = (): { dispose(): void } => ({ dispose: () => {} })
  },
  l10n: { t: (message: string): string => message },
}))

import { parseGatewayAnnouncement } from '../src/runtime/web-runtime.js'

describe('parseGatewayAnnouncement', () => {
  it('keeps the launch-token query the client trades for its session cookie', () => {
    expect(parseGatewayAnnouncement(
      'dsh gateway: http://127.0.0.1:64906/?token=gJxP2W0RYm6Fu8FR3ipoJnQqIbTIm3GYzI-Vd9uNPbE',
    )).toBe('http://127.0.0.1:64906/?token=gJxP2W0RYm6Fu8FR3ipoJnQqIbTIm3GYzI-Vd9uNPbE')
  })

  it('still accepts the bare URL announced without a connection service', () => {
    expect(parseGatewayAnnouncement('dsh gateway: http://127.0.0.1:43123')).toBe('http://127.0.0.1:43123')
  })

  it('ignores unrelated stdout lines', () => {
    expect(parseGatewayAnnouncement('(node:1) ExperimentalWarning: SQLite is an experimental feature')).toBeUndefined()
    expect(parseGatewayAnnouncement('dsh gateway: http://localhost:43123/?token=abc')).toBeUndefined()
  })
})
