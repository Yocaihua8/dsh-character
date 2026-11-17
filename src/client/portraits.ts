import type { CharacterVisual } from '../shared/visuals.js'
import { CHARACTER_AVATAR_MAX_BYTES, CHARACTER_AVATAR_UPLOAD_PATH } from '../shared/visuals.js'
import { RequestGate, unwrap } from './controller.js'
import type { RemoteResult } from './controller.js'

export interface CharacterVisualsRpc {
  listCharacterVisuals(signal: AbortSignal): Promise<RemoteResult<CharacterVisual[]>>
  resetCharacterAvatar(id: string, expectedRevision: number, signal: AbortSignal): Promise<RemoteResult<CharacterVisual>>
}

/** The document deployment base also preserves the desktop shell's authenticated fetch route. */
export function characterImageUrl(path: string): string {
  return new URL(path.replace(/^\//, ''), document.baseURI).href
}

/** Image drafts are independent of persona drafts and live until explicitly discarded. */
export class CharacterPortraitController {
  visuals = new Map<string, CharacterVisual>()
  file: File | null = null
  previewUrl: string | null = null
  characterId: string | null = null
  busy = false
  loading = false
  error = ''
  message = ''
  private disposed = false
  private draftRevision = 0
  private readGate = new RequestGate()
  private writeGate = new RequestGate()
  private listeners = new Set<() => void>()

  constructor(private readonly rpc: CharacterVisualsRpc) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  get dirty(): boolean { return this.file !== null }
  visual(id: string): CharacterVisual | undefined { return this.visuals.get(id) }

  async refresh(options: { acceptDraftRevision?: boolean } = {}): Promise<void> {
    if (this.disposed || this.busy) return
    const request = this.readGate.start()
    this.loading = true; this.error = ''; this.notify()
    try {
      const records = await unwrap(this.rpc.listCharacterVisuals(request.signal))
      if (request.current() && !this.disposed) {
        this.visuals = new Map(records.map(item => [item.characterId, item]))
        if (options.acceptDraftRevision && this.characterId) this.draftRevision = this.visuals.get(this.characterId)?.revision ?? 0
      }
    } catch (error) {
      if (request.current() && !this.disposed) this.error = this.messageOf(error)
    } finally {
      if (request.current() && !this.disposed) { this.loading = false; this.notify() }
    }
  }

  choose(characterId: string, file: File): void {
    if (this.disposed || this.busy) return
    this.error = ''; this.message = ''
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      this.error = '请选择 PNG、JPEG 或 WebP 图片。'; this.notify(); return
    }
    if (file.size > CHARACTER_AVATAR_MAX_BYTES || !file.size) {
      this.error = '图片不能为空，且不能超过 2 MiB。'; this.notify(); return
    }
    this.releasePreview()
    this.file = file; this.characterId = characterId; this.draftRevision = this.visuals.get(characterId)?.revision ?? 0
    this.previewUrl = URL.createObjectURL(file); this.notify()
  }

  discard(): void {
    if (this.disposed || this.busy) return
    this.releasePreview(); this.file = null; this.characterId = null; this.error = ''; this.message = ''; this.notify()
  }

  async save(): Promise<void> {
    if (this.disposed || this.busy || !this.file || !this.characterId) return
    const file = this.file; const id = this.characterId
    const revision = this.draftRevision
    await this.write(async signal => {
      const url = new URL(characterImageUrl(CHARACTER_AVATAR_UPLOAD_PATH))
      url.searchParams.set('characterId', id); url.searchParams.set('expectedRevision', String(revision))
      const response = await fetch(url, { method: 'POST', body: file, headers: { 'Content-Type': file.type }, credentials: 'include', signal })
      const result = await response.json() as CharacterVisual | { error: { code?: string; message?: string } }
      if (!response.ok || 'error' in result) {
        const error = 'error' in result ? result.error : undefined
        throw new Error(error?.code === 'conflict' ? '配图已在其他窗口更新。所选图片已保留，请刷新配图后重试。' : error?.message || '配图保存失败，请重试。')
      }
      return result
    }, () => {
      if (this.file === file) { this.releasePreview(); this.file = null; this.characterId = null }
      this.message = '配图已保存。'
    })
  }

  async reset(characterId: string): Promise<void> {
    if (this.disposed || this.busy) return
    await this.write(signal => unwrap(this.rpc.resetCharacterAvatar(characterId, this.visuals.get(characterId)?.revision ?? 0, signal)), () => {
      this.releasePreview(); this.file = null; this.characterId = null; this.message = '已恢复默认配图。'
    })
  }

  private async write(action: (signal: AbortSignal) => Promise<CharacterVisual>, complete: () => void): Promise<void> {
    const request = this.writeGate.start()
    this.readGate.cancel(); this.loading = false; this.busy = true; this.error = ''; this.message = ''; this.notify()
    try {
      const record = await action(request.signal)
      if (!request.current() || this.disposed) return
      this.visuals.set(record.characterId, record); complete()
    } catch (error) {
      if (request.current() && !this.disposed) this.error = this.messageOf(error)
    } finally {
      if (request.current() && !this.disposed) { this.busy = false; this.notify() }
    }
  }

  private messageOf(error: unknown): string { return error instanceof Error ? error.message : '配图操作失败，请重试。' }
  private releasePreview(): void { if (this.previewUrl) URL.revokeObjectURL(this.previewUrl); this.previewUrl = null }
  private notify(): void { if (!this.disposed) this.listeners.forEach(listener => listener()) }
  dispose(): void { this.disposed = true; this.readGate.cancel(); this.writeGate.cancel(); this.releasePreview(); this.file = null; this.listeners.clear() }
}
