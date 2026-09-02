import { describe, expect, it, vi } from 'vitest'
import { ConnectionTestService } from '../src/services/connection-test-service.js'

describe('ConnectionTestService', () => {
  it('uses upstream model discovery and allows it to resolve the stored key', async () => {
    const discoverModels = vi.fn(async () => [{ id: 'deepseek-v4-pro' }])
    const service = new ConnectionTestService(() => ({ llmDiscoverModels: discoverModels } as never))

    await expect(service.test({
      provider: 'packycode',
      name: 'PackyCode',
      baseUrl: 'https://relay.example/v1',
      apiKey: '',
      models: [],
    })).resolves.toEqual({ status: 'success', modelCount: 1, models: [{ id: 'deepseek-v4-pro' }] })
    expect(discoverModels).toHaveBeenCalledWith('llm-pi-ai', {
      provider: 'packycode',
      baseURL: 'https://relay.example/v1',
      api: 'openai-completions',
    })
  })

  it('reports every upstream discovery failure as a failure', async () => {
    const service = new ConnectionTestService(() => ({
      llmDiscoverModels: async () => {
        throw new Error('/models answered 500')
      },
    } as never))

    await expect(service.test({
      provider: 'packycode',
      name: 'PackyCode',
      baseUrl: 'https://relay.example/v1',
      apiKey: '',
      models: [],
    })).resolves.toEqual({ status: 'unreachable', detail: '/models answered 500' })
  })
})
