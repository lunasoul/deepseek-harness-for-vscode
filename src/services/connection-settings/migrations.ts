/**
 * One-shot settings/healing passes run at connect time, in order, before the
 * first refresh. Each migration is idempotent — re-running it on an
 * already-updated profile is a no-op — and each grows the wire state written
 * by older builds toward the shape this extension reads today.
 */
import type { SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'
import type { ConfigurationService } from '../../config/configuration.js'
import { modelCapacity } from '../../domain/model-capacity.js'
import { supportsImageInput } from '../../domain/model-modalities.js'
import { DEEPSEEK_OFFICIAL_PROVIDER, isDeepSeekOfficialBaseUrl, providerRoute } from '../../domain/provider.js'
import type { CredentialStore } from '../../security/credential-store.js'
import {
  DEEPSEEK_SETTINGS_NS,
  PI_AI_SETTINGS_NS,
  RELAY_REASONING_EFFORTS,
  credentialRefForProfile,
  deepSeekRelayProfile,
  importedRelay,
  isLegacyRelayReasoningEfforts,
  valueAt,
  valueOf,
  type ProviderControlClient,
} from './mapping.js'

/** Everything a migration needs from the live service. */
export interface MigrationContext {
  readonly client: ProviderControlClient
  readonly configuration: ConfigurationService
  readonly legacyCredentials: CredentialStore
}

/** Runs the full migration chain; the service calls this before connecting. */
export async function runMigrations(context: MigrationContext): Promise<void> {
  await migrateLegacySettings(context)
  await migrateRelayReasoningEfforts(context)
  await migrateRelayCapacities(context)
  await migrateRelayImageModalities(context)
}

/**
 * Imports settings written by older extension builds: pre-relay providers
 * (extension settings + secrets) and an optionally relay-flagged legacy base
 * URL are pushed into the harness namespaces, then the plaintext copies are
 * removed so DSH remains the single authority.
 */
async function migrateLegacySettings(context: MigrationContext): Promise<void> {
  const { client, configuration, legacyCredentials } = context
  const described = await client.settingsDescribe()
  if (!described.writable) return
  const piAi = described.namespaces.find((item) => item.ns === PI_AI_SETTINGS_NS)
  const deepSeek = described.namespaces.find((item) => item.ns === DEEPSEEK_SETTINGS_NS)
  const legacyKey = await legacyCredentials.getApiKey()
  const legacyBaseUrl = configuration.getLegacyBaseUrl()
  const legacyRelay = legacyBaseUrl !== undefined && !isDeepSeekOfficialBaseUrl(legacyBaseUrl)
    ? importedRelay(legacyBaseUrl, legacyKey)
    : undefined

  if (piAi !== undefined) {
    const legacyProviders = [
      ...configuration.getLegacyProviders(),
      ...(legacyRelay === undefined ? [] : [legacyRelay.provider]),
    ]
    const ops: SettingsPathOpView[] = []
    const pendingCredentials: { ref: string; value: string }[] = []
    const candidates = legacyProviders.map((provider) => {
      const route = providerRoute(provider.name)
      const existing = valueAt(piAi.value, ['providers', route])
      const ref = credentialRefForProfile(existing, route)
      return { provider, route, existing, ref }
    })
    const refs = [...new Set(candidates.map((candidate) => candidate.ref))]
    const credentialState = refs.length === 0
      ? { credentials: {} }
      : await client.credentialsDescribe(refs)
    for (const candidate of candidates) {
      if (candidate.existing === undefined) {
        ops.push({
          op: 'set',
          path: ['providers', candidate.route],
          value: deepSeekRelayProfile(candidate.provider.name, candidate.provider.baseUrl, candidate.ref) as import('@deepseek-ai/dsh-util-values').JsonValue,
        })
      }
      const credentialInfo = (await client.credentialsDescribe([candidate.ref]))[candidate.ref]
      if (candidate.provider.apiKey.trim() !== '' && credentialInfo?.configured !== true) {
        pendingCredentials.push({ ref: candidate.ref, value: candidate.provider.apiKey })
      }
    }
    if (ops.length > 0) {
      await client.settingsMutate(PI_AI_SETTINGS_NS, ops, piAi.revision)
    }
    for (const credential of pendingCredentials) {
      await client.credentialsSet(credential.ref, credential.value)
    }
  } else if (legacyRelay !== undefined) {
    throw new Error('Harness cannot migrate the legacy relay because llm-pi-ai is unavailable.')
  }

  if (legacyRelay === undefined && legacyKey !== undefined && legacyKey.trim() !== '') {
    const status = await client.credentialsDescribe(['DEEPSEEK_API_KEY'])
    if (status['DEEPSEEK_API_KEY']?.configured !== true) {
      await client.credentialsSet('DEEPSEEK_API_KEY', legacyKey.trim())
    }
  }
  if (deepSeek !== undefined && legacyBaseUrl !== undefined && legacyRelay === undefined && valueAt(deepSeek.user, ['baseURL']) === undefined) {
    await client.settingsMutate(DEEPSEEK_SETTINGS_NS, [{ op: 'set', path: ['baseURL'], value: legacyBaseUrl }], deepSeek.revision)
  }
  if (legacyRelay !== undefined && configuration.get().provider === DEEPSEEK_OFFICIAL_PROVIDER) {
    await configuration.setProvider(legacyRelay.route)
  }
  // Migration is complete only after every upstream write above succeeded.
  // Remove plaintext legacy copies so DSH remains the single authority.
  if (configuration.getLegacyProviders().length > 0) await configuration.clearLegacyProviders()
  if (legacyKey !== undefined && legacyKey.trim() !== '') await legacyCredentials.clearApiKey()
  if (legacyBaseUrl !== undefined) await configuration.clearLegacyBaseUrl()
}

/**
 * Tops up reasoning effort maps on custom relays written by older builds.
 * Harness 0.1.0-rc.7 added the `low` tier; relay profiles persist their own
 * reasoningEfforts map, so existing installs keep showing the old stops
 * until the map is healed. Idempotent: already-current maps are untouched.
 */
async function migrateRelayReasoningEfforts(context: MigrationContext): Promise<void> {
  const client = context.client
  const described = await client.settingsDescribe()
  if (!described.writable) return
  const piAi = described.namespaces.find((item) => item.ns === PI_AI_SETTINGS_NS)
  if (piAi === undefined) return
  const providers = valueAt(piAi.user, ['providers'])
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return
  const ops: SettingsPathOpView[] = []
  for (const [route, profile] of Object.entries(providers)) {
    const models = valueAt(profile, ['models'])
    if (!Array.isArray(models)) continue
    let changed = false
    const upgraded = models.map((model) => {
      if (typeof model !== 'object' || model === null || Array.isArray(model)) return model
      const efforts = (model as Record<string, unknown>)['reasoningEfforts']
      if (typeof efforts !== 'object' || efforts === null || Array.isArray(efforts)) return model
      if ('low' in efforts) return model
      changed = true
      // Extension-written legacy maps are replaced wholesale so the stop
      // order stays canonical; customized maps only gain the missing entry.
      const next = isLegacyRelayReasoningEfforts(efforts)
        ? { ...RELAY_REASONING_EFFORTS }
        : { off: null, low: 'low', ...efforts }
      return { ...(model as Record<string, unknown>), reasoningEfforts: next }
    })
    if (changed) ops.push({ op: 'set', path: ['providers', route, 'models'], value: upgraded })
  }
  if (ops.length === 0) return
  await client.settingsMutate(PI_AI_SETTINGS_NS, ops, piAi.revision)
}

/**
 * Fills in contextWindow/maxTokens on relay models written by older builds.
 * The pi-ai adapter falls back to a 256K default when a model entry carries
 * no capacity, which misstates 1M-window models; writing the known capacity
 * makes the context meter accurate for Auto and manual selections alike.
 * Idempotent: entries that already carry a capacity are untouched, and ids
 * outside the capacity table keep their entries as-is.
 */
async function migrateRelayCapacities(context: MigrationContext): Promise<void> {
  const client = context.client
  const described = await client.settingsDescribe()
  if (!described.writable) return
  const piAi = described.namespaces.find((item) => item.ns === PI_AI_SETTINGS_NS)
  if (piAi === undefined) return
  const providers = valueAt(piAi.user, ['providers'])
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return
  const ops: SettingsPathOpView[] = []
  for (const [route, profile] of Object.entries(providers)) {
    const models = valueAt(profile, ['models'])
    if (!Array.isArray(models)) continue
    let changed = false
    const upgraded = models.map((model) => {
      if (typeof model !== 'object' || model === null || Array.isArray(model)) return model
      const record = model as Record<string, unknown>
      const id = record['id']
      if (typeof id !== 'string' || record['contextWindow'] !== undefined) return model
      const capacity = modelCapacity(id)
      if (capacity === undefined) return model
      changed = true
      return {
        ...record,
        contextWindow: capacity.contextWindow,
        ...(capacity.maxTokens === undefined ? {} : { maxTokens: capacity.maxTokens }),
      }
    })
    if (changed) ops.push({ op: 'set', path: ['providers', route, 'models'], value: upgraded })
  }
  if (ops.length === 0) return
  await client.settingsMutate(PI_AI_SETTINGS_NS, ops, piAi.revision)
}

/**
 * Declares image input on relay vision models written by older builds. The
 * pi-ai adapter serves an entry without `input` as text-only, so a relay
 * vision model rejected image prompts even after the session switched to it.
 * Idempotent: entries that already declare modalities are untouched, and ids
 * without the vision naming convention keep their entries as-is.
 */
async function migrateRelayImageModalities(context: MigrationContext): Promise<void> {
  const client = context.client
  const described = await client.settingsDescribe()
  if (!described.writable) return
  const piAi = described.namespaces.find((item) => item.ns === PI_AI_SETTINGS_NS)
  if (piAi === undefined) return
  const providers = valueAt(piAi.user, ['providers'])
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return
  const ops: SettingsPathOpView[] = []
  for (const [route, profile] of Object.entries(providers)) {
    const models = valueAt(profile, ['models'])
    if (!Array.isArray(models)) continue
    let changed = false
    const upgraded = models.map((model) => {
      if (typeof model !== 'object' || model === null || Array.isArray(model)) return model
      const record = model as Record<string, unknown>
      const id = record['id']
      if (typeof id !== 'string' || !supportsImageInput(id)) return model
      // pi-ai's declaredInput treats an empty list as undeclared too.
      const input = record['input']
      if (Array.isArray(input) && input.length > 0) return model
      changed = true
      return { ...record, input: ['text', 'image'] }
    })
    if (changed) ops.push({ op: 'set', path: ['providers', route, 'models'], value: upgraded })
  }
  if (ops.length === 0) return
  await client.settingsMutate(PI_AI_SETTINGS_NS, ops, piAi.revision)
}
