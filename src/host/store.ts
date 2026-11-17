import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { Character, CharacterBinding, CharacterFields, SaveCharacterRequest } from '../shared/types.js'
import { CHARACTER_NAME_LIMIT, CHARACTER_TEXT_LIMIT } from '../shared/types.js'
import { BUILTIN_WHALE_GIRL_FIELDS, BUILTIN_WHALE_GIRL_ID } from './builtins.js'

export type CharacterErrorCode = 'invalid-request' | 'not-found' | 'conflict' | 'archived' | 'locked' | 'storage' | 'closed'

export class CharacterError extends Error {
  constructor(readonly code: CharacterErrorCode, message: string) {
    super(message)
    this.name = 'CharacterError'
  }
}

const fieldNames = ['name', 'identity', 'background', 'personality', 'values', 'style', 'boundaries'] as const
const fieldShape = {
  name: z.string().trim().min(1).max(CHARACTER_NAME_LIMIT),
  identity: z.string().trim(),
  background: z.string().trim(),
  personality: z.string().trim(),
  values: z.string().trim(),
  style: z.string().trim(),
  boundaries: z.string().trim(),
}
const withinLimit = (value: CharacterFields) => fieldNames.reduce((total, field) => total + value[field].length, 0) <= CHARACTER_TEXT_LIMIT
const fieldsSchema = z.strictObject(fieldShape).refine(withinLimit, '人设总内容不能超过 16000 个字符。')
const characterSchema = z.strictObject({
  ...fieldShape,
  id: z.string().min(1),
  revision: z.number().int().positive(),
  archived: z.boolean(),
}).refine(withinLimit, '人设总内容不能超过 16000 个字符。')
const bindingSchema = z.strictObject({
  sessionId: z.string().min(1),
  characterId: z.string().min(1),
  locked: z.boolean(),
})

export const characterDomain = defineDomain({
  name: 'dsh_character',
  version: 1,
  tables: {
    characters: domainTable<string, Character>(characterSchema),
    bindings: domainTable<string, CharacterBinding>(bindingSchema),
  },
})

function identifier(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new CharacterError('invalid-request', `${label}不能为空。`)
  return value
}

function sameBinding(left: CharacterBinding | undefined, right: CharacterBinding | undefined): boolean {
  return left === undefined || right === undefined ? left === right
    : left.sessionId === right.sessionId && left.characterId === right.characterId && left.locked === right.locked
}

/** One authoritative host domain; mutations commit before becoming visible to readers. */
export class CharacterStore {
  private tail: Promise<unknown> = Promise.resolve()
  private closing = false
  private closePromise?: Promise<void>

  constructor(private readonly domain: Domain<typeof characterDomain>) {}

  static async open(ctx: Context): Promise<CharacterStore> {
    try { return new CharacterStore(await ctx.storageDomain.open(characterDomain)) }
    catch { throw new CharacterError('storage', '人设存储无法打开，请检查宿主存储状态；已有数据不会被重置。') }
  }

  /** Install once; edits, renamed records and archives remain owned by the user. */
  ensureBuiltinCharacters(): Promise<void> {
    return this.mutate(async () => {
      const characters = this.domain.table('characters')
      if (characters.get(BUILTIN_WHALE_GIRL_ID)) return
      const parsed = fieldsSchema.safeParse(BUILTIN_WHALE_GIRL_FIELDS)
      if (!parsed.success) throw new CharacterError('invalid-request', '内置鲸鱼娘资料无效，无法初始化角色库。')
      await characters.put(BUILTIN_WHALE_GIRL_ID, {
        ...parsed.data, id: BUILTIN_WHALE_GIRL_ID, revision: 1, archived: false,
      })
    })
  }

  list(): Character[] {
    return this.read(() => [...this.domain.table('characters').entries()].map(([, value]) => ({ ...value })))
  }

  get(id: string): Character {
    identifier(id, '人设 ID')
    return this.read(() => {
      const character = this.domain.table('characters').get(id)
      if (!character) throw new CharacterError('not-found', '已绑定的人设不存在，请检查人设数据。')
      return { ...character }
    })
  }

  getBinding(sessionId: string): CharacterBinding | undefined {
    identifier(sessionId, '会话 ID')
    return this.read(() => {
      const binding = this.domain.table('bindings').get(sessionId)
      return binding && { ...binding }
    })
  }

  async save(request: SaveCharacterRequest): Promise<Character> {
    const parsed = fieldsSchema.safeParse(request?.fields)
    if (!parsed.success) throw new CharacterError('invalid-request', '人设格式无效：名称必填且最多 80 个字符，总内容最多 16000 个字符。')
    const fields = parsed.data
    const id = request.id === undefined ? randomUUID() : identifier(request.id, '人设 ID')
    const expectedRevision = request.expectedRevision
    const existing = request.id !== undefined
    if (!existing && expectedRevision !== undefined) throw new CharacterError('invalid-request', '创建人设不能指定旧版本。')
    return this.mutate(async () => {
      const current = existing ? this.get(id) : undefined
      if (current) this.checkRevision(current, expectedRevision)
      const next: Character = { ...fields, id, revision: (current?.revision ?? 0) + 1, archived: current?.archived ?? false }
      await this.domain.table('characters').put(id, next)
      return { ...next }
    })
  }

  archive(id: string, expectedRevision: number): Promise<Character> {
    identifier(id, '人设 ID')
    return this.mutate(async () => {
      const current = this.get(id)
      this.checkRevision(current, expectedRevision)
      if (current.archived) return current
      const next = { ...current, archived: true, revision: current.revision + 1 }
      await this.domain.table('characters').put(id, next)
      return { ...next }
    })
  }

  bind(sessionId: string, characterId: string): Promise<CharacterBinding> {
    identifier(sessionId, '会话 ID')
    identifier(characterId, '人设 ID')
    return this.mutate(async () => {
      const current = this.getBinding(sessionId)
      if (current?.locked) throw new CharacterError('locked', '此会话的人设已固定，请新建会话选择其他人设。')
      const character = this.get(characterId)
      if (character.archived) throw new CharacterError('archived', '已归档的人设不能绑定到新会话。')
      const next = { sessionId, characterId, locked: false }
      if (!sameBinding(current, next)) await this.domain.table('bindings').put(sessionId, next)
      return { ...next }
    })
  }

  lock(sessionId: string): Promise<CharacterBinding | undefined> {
    identifier(sessionId, '会话 ID')
    return this.mutate(async () => {
      const current = this.getBinding(sessionId)
      if (!current || current.locked) return current
      this.get(current.characterId)
      const next = { ...current, locked: true }
      await this.domain.table('bindings').put(sessionId, next)
      return { ...next }
    })
  }

  inherit(sessionId: string, parentSessionId: string): Promise<CharacterBinding | undefined> {
    identifier(sessionId, '会话 ID')
    identifier(parentSessionId, '父会话 ID')
    return this.mutate(async () => {
      const current = this.getBinding(sessionId)
      if (current) return current
      const parent = this.getBinding(parentSessionId)
      if (!parent) return undefined
      this.get(parent.characterId)
      const next = { ...parent, sessionId }
      await this.domain.table('bindings').put(sessionId, next)
      return { ...next }
    })
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true
      this.closePromise = this.tail.then(() => this.domain.close()).catch(error => { throw this.asError(error) })
    }
    return this.closePromise
  }

  private checkRevision(current: Character, expected: number | undefined): void {
    if (expected !== current.revision) throw new CharacterError('conflict', '人设已被更新，请刷新后再保存。')
  }

  private read<T>(action: () => T): T {
    try { return action() } catch (error) { throw this.asError(error) }
  }

  private mutate<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new CharacterError('closed', '人设插件正在关闭。'))
    const operation = this.tail.then(action).catch(error => { throw this.asError(error) })
    this.tail = operation.catch(() => {})
    return operation
  }

  private asError(error: unknown): CharacterError {
    return error instanceof CharacterError ? error : new CharacterError('storage', '人设存储操作失败；不会使用默认人设代替。')
  }
}
