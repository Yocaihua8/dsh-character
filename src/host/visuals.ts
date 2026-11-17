import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId, isImageAdmissionError, type AttachmentStore, type ImageAttachmentRef, type ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { BUILTIN_WHALE_GIRL_ID } from './builtins.js'
import { CharacterError, type CharacterStore } from './store.js'
import { CHARACTER_AVATAR_MAX_BYTES, CHARACTER_AVATAR_PATH, type CharacterVisual } from '../shared/visuals.js'

interface VisualRecord {
  characterId: string
  revision: number
  attachment: ImageAttachmentRef | null
}

const dimensions = z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() })
const attachmentSchema = z.strictObject({
  attachmentId: z.string().min(1).transform(AttachmentId),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  bytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  name: z.string().optional(),
  originalDimensions: dimensions.optional(),
})

/** Independent domain keeps 0.1.x character records readable during rollback. */
export const characterVisualDomain = defineDomain({
  name: 'dsh_character_visuals',
  version: 1,
  tables: {
    portraits: domainTable<string, VisualRecord>(z.strictObject({
      characterId: z.string().min(1), revision: z.number().int().positive(), attachment: attachmentSchema.nullable(),
    })),
  },
})

export class CharacterVisualStore {
  private tail: Promise<unknown> = Promise.resolve()
  private closing = false
  private closePromise?: Promise<void>

  constructor(
    private readonly domain: Domain<typeof characterVisualDomain>,
    private readonly characters: CharacterStore,
    private readonly attachments: AttachmentStore,
  ) {}

  static async open(ctx: Context, characters: CharacterStore): Promise<CharacterVisualStore> {
    try { return new CharacterVisualStore(await ctx.storageDomain.open(characterVisualDomain), characters, ctx.attachments) }
    catch { throw new CharacterError('storage', '角色图片存储无法打开，已有角色资料和会话绑定不受影响。') }
  }

  get maxBytes(): number { return Math.min(CHARACTER_AVATAR_MAX_BYTES, this.attachments.imageLimits.maxImageBytes) }

  list(): CharacterVisual[] { return this.characters.list().map(character => this.get(character.id)) }

  get(characterId: string): CharacterVisual {
    this.characters.get(characterId)
    const record = this.domain.table('portraits').get(characterId)
    const source = record?.attachment ? 'upload' : characterId === BUILTIN_WHALE_GIRL_ID ? 'builtin' : 'none'
    const revision = record?.revision ?? 0
    return {
      characterId, revision, source,
      url: source === 'none' ? null : `${CHARACTER_AVATAR_PATH}?${new URLSearchParams({ characterId, revision: String(revision) })}`,
    }
  }

  async read(characterId: string, revision: number | undefined, signal: AbortSignal): Promise<{ data: Uint8Array; mediaType: ImageMediaType } | 'builtin'> {
    signal.throwIfAborted()
    const current = this.get(characterId)
    if (revision !== undefined && revision !== current.revision) throw new CharacterError('conflict', '角色图片已更新，请刷新后查看。')
    if (current.source === 'none') throw new CharacterError('not-found', '此角色尚未设置图片。')
    if (current.source === 'builtin') return 'builtin'
    const ref = this.domain.table('portraits').get(characterId)!.attachment!
    try {
      const stored = await this.attachments.readImage(ref, signal)
      return { data: stored.data, mediaType: stored.ref.mediaType }
    } catch (error) {
      if (signal.aborted) throw signal.reason
      throw new CharacterError('storage', '角色图片读取失败，请检查宿主附件存储。')
    }
  }

  upload(characterId: string, expectedRevision: number, data: Uint8Array, mediaType: string, signal: AbortSignal): Promise<CharacterVisual> {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mediaType)
      || !this.attachments.imageLimits.mediaTypes.includes(mediaType as ImageMediaType)) {
      return Promise.reject(new CharacterError('invalid-request', '请选择 PNG、JPEG 或 WebP 图片。'))
    }
    if (!data.length || data.length > this.maxBytes) {
      return Promise.reject(new CharacterError('invalid-request', `图片不能为空，大小不能超过 ${this.maxBytes} 字节。`))
    }
    return this.mutate(async () => {
      signal.throwIfAborted()
      const current = this.checkRevision(characterId, expectedRevision)
      let attachment: ImageAttachmentRef
      try {
        attachment = await this.attachments.saveImage({ data, mediaType: mediaType as ImageMediaType })
      } catch (error) {
        if (isImageAdmissionError(error)) throw new CharacterError('invalid-request', '图片无法通过宿主校验，请确认格式、尺寸与内容有效。')
        throw error
      }
      signal.throwIfAborted()
      await this.domain.table('portraits').put(characterId, { characterId, revision: current.revision + 1, attachment })
      return this.get(characterId)
    })
  }

  reset(characterId: string, expectedRevision: number, signal: AbortSignal): Promise<CharacterVisual> {
    return this.mutate(async () => {
      signal.throwIfAborted()
      const current = this.checkRevision(characterId, expectedRevision)
      await this.domain.table('portraits').put(characterId, { characterId, revision: current.revision + 1, attachment: null })
      return this.get(characterId)
    })
  }

  close(): Promise<void> {
    this.closing = true
    return this.closePromise ??= this.tail.then(() => this.domain.close())
  }

  private checkRevision(characterId: string, expected: number): CharacterVisual {
    if (!Number.isSafeInteger(expected) || expected < 0) throw new CharacterError('invalid-request', '图片修订号无效。')
    const current = this.get(characterId)
    if (current.revision !== expected) throw new CharacterError('conflict', '角色图片已被更新，请刷新后再保存。')
    return current
  }

  private mutate<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new CharacterError('closed', '角色图片服务正在关闭。'))
    const operation = this.tail.then(action).catch(error => {
      if (error instanceof CharacterError || error instanceof Error && error.name === 'AbortError') throw error
      throw new CharacterError('storage', '角色图片保存失败，原有图片仍然有效，请重试。')
    })
    this.tail = operation.catch(() => {})
    return operation
  }
}
