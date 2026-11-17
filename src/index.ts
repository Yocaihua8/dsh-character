import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { requireOwner } from './host/access.js'
import { isRootAgent } from './host/main-agent.js'
import { CharacterStore, CharacterError } from './host/store.js'
import { CharacterRuntime } from './host/runtime.js'
import { CharacterVisualStore } from './host/visuals.js'
import { CharacterPreferences } from './host/preferences.js'
import { GrowthStore } from './host/growth-store.js'
import { GrowthRuntime } from './host/growth-runtime.js'
import type { GrowthChange, GrowthConfig, GrowthState, GrowthStatus } from './shared/growth.js'
import { characterAvatarRoute, characterAvatarUploadRoute } from './host/visuals-route.js'
import type { Character, CharacterBindingStatus, DefaultCharacterStatus, SaveCharacterRequest } from './shared/types.js'
import type { CharacterVisual } from './shared/visuals.js'

export type * from './shared/types.js'
export type * from './shared/visuals.js'
export type * from './shared/growth.js'

declare module '@deepseek-ai/cordis' {
  interface Context { characters: Characters }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap { 'character/failed': { reason: string } }
}

/** Persistent, owner-authored character library and scoped Agent integration. */
export default class Characters extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'sessionProjections', 'systemPrompt', 'storageDomain', 'typert', 'attachments', 'connection']
  private store!: CharacterStore
  private runtime!: CharacterRuntime
  private readonly storeReady: Promise<void>
  private readonly ready: Promise<void>
  private readonly visualsReady: Promise<CharacterVisualStore>
  private readonly preferencesReady: Promise<CharacterPreferences>
  private readonly growthReady: Promise<GrowthRuntime>
  private growth?: GrowthRuntime
  private readonly lifetime = new AbortController()

  constructor(ctx: Context) {
    super(ctx, 'characters')
    // Install before opening storage. Otherwise a failed domain open could leave
    // restored agents running with the default identity and no runtime guard.
    const isMain = (agent: Agent) => agent.session.header.origin !== 'subagent'
      && (agent.session.header.delegationDepth ?? 0) === 0
      && isRootAgent(ctx.agents, agent)
    const pendingCreations = new Set<Agent>()
    const releaseCreationGate = ctx.on('agent/created', async ({ agent, source, signal }) => {
      if (!isMain(agent)) return undefined
      pendingCreations.add(agent)
      try {
        await this.ready
        this.lifetime.signal.throwIfAborted()
        signal?.throwIfAborted()
        await this.runtime.initializeCreatedAgent(agent, source, signal)
      } finally { pendingCreations.delete(agent) }
      return undefined
    })
    const releaseStartupGate = ctx.on('agent/pre-step', async (payload, next) => {
      if (!isMain(payload.agent)) return next()
      await this.ready
      this.lifetime.signal.throwIfAborted()
      return next()
    })
    this.storeReady = this.initializeStore()
    this.growthReady = this.storeReady.then(async () => this.growth = new GrowthRuntime(ctx, await GrowthStore.open(ctx), this.store))
    this.growthReady.catch(() => ctx.logger.warn('成长服务不可用，继续使用基本人设；成长管理页可显示错误。'))
    this.preferencesReady = this.storeReady.then(() => CharacterPreferences.open(ctx, this.store))
    this.preferencesReady.catch(error => ctx.logger.error('默认角色设置初始化失败：%s', error instanceof Error ? error.message : String(error)))
    this.ready = this.storeReady.then(() => this.initializeRuntime(pendingCreations))
    this.ready.catch(error => ctx.logger.error('角色插件初始化失败：%s', error instanceof Error ? error.message : String(error)))
    // UI-only image failures must not disable previously working character injection.
    this.visualsReady = this.ready.then(() => CharacterVisualStore.open(ctx, this.store))
    this.visualsReady.catch(error => ctx.logger.error('角色图片初始化失败：%s', error instanceof Error ? error.message : String(error)))
    let releaseAvatarRoute: (() => Promise<void>) | undefined
    let releaseAvatarUpload: (() => Promise<void>) | undefined
    // Register cleanup before exact routes: registration can fail synchronously,
    // after asynchronous domain initialization has already started.
    ctx.effect(() => async () => {
      this.lifetime.abort()
      const failures: unknown[] = []
      const dispose = async (action: () => unknown) => {
        try { await action() } catch (error) { failures.push(error) }
      }
      await dispose(() => releaseCreationGate())
      await dispose(() => releaseStartupGate())
      await dispose(() => releaseAvatarRoute?.())
      await dispose(() => releaseAvatarUpload?.())
      await this.ready.catch(() => {})
      const visuals = await this.visualsReady.catch(() => undefined)
      await dispose(() => visuals?.close())
      await dispose(() => this.runtime?.dispose())
      const growth = await this.growthReady.catch(() => undefined)
      await dispose(() => growth?.close())
      const preferences = await this.preferencesReady.catch(() => undefined)
      await dispose(() => preferences?.close())
      await dispose(() => this.store?.close())
      if (failures.length) throw new AggregateError(failures, '角色插件部分资源清理失败。')
    })
    releaseAvatarRoute = ctx.connection.fetch.register(characterAvatarRoute(
      this.visualsReady, this.lifetime.signal, new URL('../characters/whale-girl.jpg', import.meta.url),
    ))
    releaseAvatarUpload = ctx.connection.fetch.register(characterAvatarUploadRoute(
      this.visualsReady, this.lifetime.signal, new URL('../characters/whale-girl.jpg', import.meta.url),
    ))
  }

  private async initializeStore(): Promise<void> {
    this.store = await CharacterStore.open(this.ctx)
    await this.store.ensureBuiltinCharacters()
  }

  private async initializeRuntime(pendingCreations: ReadonlySet<Agent>): Promise<void> {
    this.runtime = new CharacterRuntime(this.ctx, this.store, () => this.preferencesReady.then(preferences => preferences.forNewSession()), character => {
      try { return this.growth?.snapshot(character)?.text ?? '' } catch { return '' }
    })
    await this.runtime.init(pendingCreations)
  }

  private owner(signal: AbortSignal): void {
    requireOwner(this.ctx.invocation, signal)
  }

  private async run<T>(signal: AbortSignal, action: () => T | Promise<T>): Promise<T> {
    try {
      signal.throwIfAborted()
      this.lifetime.signal.throwIfAborted()
      await this.ready
      signal.throwIfAborted()
      this.lifetime.signal.throwIfAborted()
      return await action()
    } catch (error) {
      if (error instanceof RemoteError) throw error
      if (error instanceof CharacterError) throw new RemoteError('character/failed', error.message, { reason: error.code })
      if (signal.aborted || this.lifetime.signal.aborted) throw new RemoteError('character/failed', '操作已取消。', { reason: 'cancelled' })
      this.ctx.logger.warn('角色操作失败：%s', error instanceof Error ? error.message : String(error))
      throw new RemoteError('character/failed', '角色操作失败，请重试；尚未确认保存成功。', { reason: 'failed' })
    }
  }

  @Remote
  async listCharacters(signal: AbortSignal): Promise<Character[]> {
    this.owner(signal)
    return this.run(signal, () => this.store.list())
  }

  @Remote
  async getCharacter(id: string, signal: AbortSignal): Promise<Character> {
    this.owner(signal)
    return this.run(signal, () => this.store.get(id))
  }

  @Remote
  async saveCharacter(request: SaveCharacterRequest, signal: AbortSignal): Promise<Character> {
    this.owner(signal)
    return this.run(signal, async () => {
      const character = await this.store.save(request)
      this.growth?.baseChanged(character)
      return character
    })
  }

  @Remote
  async archiveCharacter(id: string, expectedRevision: number, signal: AbortSignal): Promise<Character> {
    this.owner(signal)
    return this.run(signal, async () => {
      const character = await this.store.archive(id, expectedRevision)
      this.growth?.baseChanged(character)
      return character
    })
  }

  @Remote
  async getDefaultCharacter(signal: AbortSignal): Promise<DefaultCharacterStatus> {
    this.owner(signal)
    return this.run(signal, async () => (await this.preferencesReady).get())
  }

  @Remote
  async setDefaultCharacter(characterId: string | null, expectedRevision: number, signal: AbortSignal): Promise<DefaultCharacterStatus> {
    this.owner(signal)
    return this.run(signal, async () => {
      const preferences = await this.preferencesReady
      signal.throwIfAborted()
      this.lifetime.signal.throwIfAborted()
      return preferences.set(characterId, expectedRevision)
    })
  }

  @Remote
  async listCharacterVisuals(signal: AbortSignal): Promise<CharacterVisual[]> {
    this.owner(signal)
    return this.run(signal, async () => (await this.visualsReady).list())
  }

  @Remote
  async resetCharacterAvatar(characterId: string, expectedRevision: number, signal: AbortSignal): Promise<CharacterVisual> {
    this.owner(signal)
    return this.run(signal, async () => (await this.visualsReady).reset(
      characterId, expectedRevision, AbortSignal.any([signal, this.lifetime.signal]),
    ))
  }

  @Remote({ resources: { session: (sessionId) => SessionId(sessionId) } })
  async getBinding(sessionId: string, signal: AbortSignal): Promise<CharacterBindingStatus> {
    return this.run(signal, () => this.runtime.bindingStatus(sessionId))
  }

  @Remote({ resources: { session: (sessionId) => SessionId(sessionId) } })
  async bindCharacter(sessionId: string, characterId: string, signal: AbortSignal): Promise<CharacterBindingStatus> {
    this.owner(signal)
    return this.run(signal, () => this.runtime.bind(sessionId, characterId))
  }

  @Remote
  async getGrowth(characterId: string, signal: AbortSignal): Promise<GrowthStatus> {
    this.owner(signal)
    return this.run(signal, async () => (await this.growthReady).status(characterId, signal))
  }

  @Remote
  async configureGrowth(config: GrowthConfig, signal: AbortSignal): Promise<GrowthConfig> {
    this.owner(signal)
    return this.run(signal, async () => (await this.growthReady).configure(config, signal))
  }

  @Remote
  async changeGrowth(request: GrowthChange, signal: AbortSignal): Promise<GrowthState> {
    this.owner(signal)
    return this.run(signal, async () => (await this.growthReady).change(request))
  }

  @Remote({ resources: { session: (sessionId) => SessionId(sessionId) } })
  async registerGrowthSession(sessionId: string, signal: AbortSignal): Promise<boolean> {
    this.owner(signal)
    return this.run(signal, async () => (await this.growthReady).register(sessionId))
  }
}
