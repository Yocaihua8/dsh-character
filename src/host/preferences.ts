import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { Character, DefaultCharacterStatus } from '../shared/types.js'
import { CharacterError, type CharacterStore } from './store.js'

interface DefaultCharacterPreference {
  characterId: string | null
  revision: number
}

/** Defaults have their own domain; older plugin versions can still read role records. */
export const characterPreferencesDomain = defineDomain({
  name: 'dsh_character_preferences',
  version: 1,
  tables: {
    settings: domainTable<'default', DefaultCharacterPreference>(z.strictObject({
      characterId: z.string().min(1).refine(value => value.trim().length > 0).nullable(),
      revision: z.number().int().nonnegative(),
    })),
  },
})

export class CharacterPreferences {
  private tail: Promise<unknown> = Promise.resolve()
  private closing = false
  private closePromise?: Promise<void>

  constructor(private readonly domain: Domain<typeof characterPreferencesDomain>, private readonly characters: CharacterStore) {}

  static async open(ctx: Context, characters: CharacterStore): Promise<CharacterPreferences> {
    try { return new CharacterPreferences(await ctx.storageDomain.open(characterPreferencesDomain), characters) }
    catch { throw new CharacterError('storage', '默认角色设置无法读取，请检查宿主存储；已有角色与会话绑定不会被重置。') }
  }

  get(): DefaultCharacterStatus {
    try {
      const preference = this.domain.table('settings').get('default') ?? { characterId: null, revision: 0 }
      if (preference.characterId === null) return { ...preference, character: null, unavailableReason: '' }
      let character: Character
      try { character = this.characters.get(preference.characterId) }
      catch (error) {
        if (error instanceof CharacterError && error.code === 'not-found') {
          return { ...preference, character: null, unavailableReason: '默认角色已不存在，新会话暂不自动绑定；请选择其他角色。' }
        }
        throw error
      }
      return {
        ...preference, character,
        unavailableReason: character.archived ? '默认角色已归档，新会话暂不自动绑定；请选择其他角色。' : '',
      }
    } catch (error) { throw this.asError(error) }
  }

  set(characterId: string | null, expectedRevision: number): Promise<DefaultCharacterStatus> {
    if (characterId !== null && (typeof characterId !== 'string' || !characterId.trim())) {
      return Promise.reject(new CharacterError('invalid-request', '默认角色 ID 无效。'))
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return Promise.reject(new CharacterError('invalid-request', '默认角色设置修订号无效。'))
    }
    if (this.closing) return Promise.reject(new CharacterError('closed', '默认角色服务正在关闭。'))
    const operation = this.tail.then(async () => {
      const current = this.get()
      if (current.revision !== expectedRevision) throw new CharacterError('conflict', '默认角色已在其他窗口更新，请刷新后重试。')
      if (characterId !== null) {
        const character = this.characters.get(characterId)
        if (character.archived) throw new CharacterError('archived', '已归档的角色不能设为新会话的默认角色。')
      }
      await this.domain.table('settings').put('default', { characterId, revision: current.revision + 1 })
      return this.get()
    }).catch(error => { throw this.asError(error) })
    this.tail = operation.catch(() => {})
    return operation
  }

  forNewSession(): Character | undefined {
    const current = this.get()
    return current.unavailableReason || !current.character ? undefined : current.character
  }

  close(): Promise<void> {
    this.closing = true
    return this.closePromise ??= this.tail.then(() => this.domain.close())
  }

  private asError(error: unknown): CharacterError {
    return error instanceof CharacterError ? error : new CharacterError('storage', '默认角色设置保存或读取失败；原有设置尚未确认改变。')
  }
}
