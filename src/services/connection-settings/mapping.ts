/**
 * Pure mapping helpers for the connection-settings control plane: input
 * normalization, relay provider/profile wire shapes, provider views, and the
 * small object guards they share. Stateless — the service class in
 * `../connection-settings-service.ts` drives these with a live client.
 */
import type {
  ConfigurableProviderView,
  SettingsNamespaceView,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import { validateBaseUrl } from '../../domain/base-url.js'
import { modelCapacity } from '../../domain/model-capacity.js'
import { supportsImageInput } from '../../domain/model-modalities.js'
import {
  DEEPSEEK_OFFICIAL_BASE_URL,
  DEEPSEEK_OFFICIAL_PROVIDER,
  providerKeyEnv,
  providerRoute,
  type CustomProvider,
} from '../../domain/provider.js'
import type {
  ConnectionProviderView,
  ConnectionSettingsInput,
} from '../../domain/connection-settings.js'

export const PI_AI_SETTINGS_NS = 'llm-pi-ai'
export const DEEPSEEK_SETTINGS_NS = 'llm-deepseek'

/** The slice of the API client the settings adapter talks to. */
export type ProviderControlClient = Pick<IApiClient, 'settings' | 'credentials' | 'llm'>

/** Reads `{ result: { ok: true, value } | { ok: false, error } }` envelopes. */
export function valueOf<T>(response: { readonly result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly message: string } } }): T {
  if (!response.result.ok) throw new Error(response.result.error.message)
  return response.result.value
}

/** Walks a possibly-undefined nested object path, returning undefined on the way. */
export function valueAt(root: unknown, path: readonly string[]): unknown {
  let current = root
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** The `apiKeyEnv` a relay profile addresses, with the conventional fallback. */
export function credentialRefForProfile(profile: unknown, provider: string): string {
  return stringField(profile, 'apiKeyEnv') ?? providerKeyEnv(provider)
}

/** The credential ref used for one provider, official route included. */
export function credentialRef(entry: ConfigurableProviderView, namespace: SettingsNamespaceView | undefined): string {
  if (entry.provider === DEEPSEEK_OFFICIAL_PROVIDER) return 'DEEPSEEK_API_KEY'
  return credentialRefForProfile(valueAt(namespace?.value, entry.settingsPath), entry.provider)
}

export function normalizeInput(input: ConnectionSettingsInput): ConnectionSettingsInput {
  const name = input.name.trim()
  const baseUrl = input.baseUrl.trim()
  const apiKey = input.apiKey.trim()
  if (input.provider !== DEEPSEEK_OFFICIAL_PROVIDER && name === '') throw new Error('The provider name cannot be empty.')
  if (baseUrl === '') {
    if (input.provider === DEEPSEEK_OFFICIAL_PROVIDER) {
      return { ...input, name, baseUrl: DEEPSEEK_OFFICIAL_BASE_URL, apiKey }
    }
    throw new Error('The provider base URL cannot be empty.')
  }
  if (!validateBaseUrl(baseUrl).valid) throw new Error('The Base URL must be a valid http(s) URL.')
  const models = input.provider === DEEPSEEK_OFFICIAL_PROVIDER
    ? []
    : normalizeRelayModels(input.models)
  return { ...input, name, baseUrl, apiKey, models }
}

/**
 * A custom relay endpoint is addressed by the model ids it actually exposes
 * (e.g. a Volcengine Ark model id or endpoint). Empty input keeps the
 * extension's DeepSeek defaults so existing behavior is preserved.
 */
export function normalizeRelayModels(models: readonly string[] | undefined): readonly string[] {
  const ids = (models ?? [])
    .map((model) => model.trim())
    .filter((model) => model !== '')
  return [...new Set(ids)]
}

/** Reasoning effort wire map the extension writes for custom relay models. */
export const RELAY_REASONING_EFFORTS = { off: null, low: 'low', high: 'high', max: 'max' } as const

/** Map shape written by builds before the low tier existed (pre rc.7). */
const LEGACY_RELAY_REASONING_EFFORTS = { off: null, high: 'high', max: 'max' } as const

export function isLegacyRelayReasoningEfforts(efforts: object): boolean {
  const entries = Object.entries(efforts)
  const legacy = Object.entries(LEGACY_RELAY_REASONING_EFFORTS) as [string, unknown][]
  return entries.length === legacy.length
    && legacy.every(([key, value]) => (efforts as Record<string, unknown>)[key] === value)
}

/** Wire model entries carrying the extension's effort map, modalities and capacity. */
export function relayModels(models: readonly string[]): { id: string; reasoningEfforts: object; input?: readonly string[]; contextWindow?: number; maxTokens?: number }[] {
  const ids = models.length > 0 ? models : ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']
  return ids.map((id) => {
    const capacity = modelCapacity(id)
    return {
      id,
      reasoningEfforts: { ...RELAY_REASONING_EFFORTS },
      // The pi-ai adapter serves an entry without `input` as text-only, so a
      // vision route must declare its modalities or image prompts are rejected
      // at admission even after the session switched to it.
      ...(supportsImageInput(id) ? { input: ['text', 'image'] } : {}),
      ...(capacity === undefined ? {} : {
        contextWindow: capacity.contextWindow,
        ...(capacity.maxTokens === undefined ? {} : { maxTokens: capacity.maxTokens }),
      }),
    }
  })
}

export function deepSeekRelayProfile(displayName: string, baseURL: string, apiKeyEnv: string, models?: readonly string[]): object {
  return {
    displayName,
    apiKeyEnv,
    api: 'openai-completions',
    baseURL,
    compat: relayCompat(),
    models: relayModels(models ?? []),
  }
}

export function relayCompat(): object {
  return {
    thinkingFormat: 'deepseek',
    supportsReasoningEffort: true,
    supportsDeveloperRole: false,
  }
}

/** Shapes one provider directory entry into the extension's small view. */
export function providerView(
  entry: ConfigurableProviderView,
  namespace: SettingsNamespaceView | undefined,
  credential: { readonly configured: boolean; readonly writable: boolean } | undefined,
): ConnectionProviderView {
  const profile = valueAt(namespace?.value, entry.settingsPath)
  const baseUrl = stringField(profile, 'baseURL')
    ?? (entry.provider === DEEPSEEK_OFFICIAL_PROVIDER ? DEEPSEEK_OFFICIAL_BASE_URL : '')
  return {
    id: entry.provider,
    name: entry.displayName,
    baseUrl,
    models: modelsField(profile),
    apiKeyConfigured: credential?.configured === true,
    credentialWritable: credential?.writable === true,
    removable: entry.settingsPath.length > 0 && valueAt(namespace?.user, entry.settingsPath) !== undefined,
  }
}

/** The relay profile imported from a legacy base URL (hostname-derived name). */
export function importedRelay(baseUrl: string, apiKey: string | undefined): {
  route: string
  provider: CustomProvider
} {
  const hostname = new URL(baseUrl).hostname.replace(/^www\./u, '')
  const name = `Imported ${hostname}`
  return {
    route: providerRoute(name),
    provider: { name, baseUrl, apiKey: apiKey?.trim() ?? '' },
  }
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && field.trim() !== '' ? field.trim() : undefined
}

function modelsField(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const models = (value as Record<string, unknown>)['models']
  if (!Array.isArray(models)) return []
  return models
    .map((model) => (typeof model === 'object' && model !== null
      ? stringField(model, 'id')
      : typeof model === 'string' ? model : undefined))
    .filter((model): model is string => model !== undefined)
}
