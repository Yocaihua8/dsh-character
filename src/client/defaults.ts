import type { DefaultCharacterStatus } from '../shared/types.js'
import { CharacterRpcError, RequestGate, unwrap } from './controller.js'
import type { RemoteResult } from './controller.js'

export interface DefaultsRpc {
  getDefaultCharacter(signal: AbortSignal): Promise<RemoteResult<DefaultCharacterStatus>>
  setDefaultCharacter(characterId: string | null, expectedRevision: number, signal: AbortSignal): Promise<RemoteResult<DefaultCharacterStatus>>
}

/** A saved default and its pending choice are distinct, including after failures or a remount. */
export class DefaultCharacterController {
  status: DefaultCharacterStatus | null = null
  selectedId: string | null = null
  loading = false
  busy = false
  error = ''
  message = ''
  conflict = false
  private draftRevision = 0
  private disposed = false
  private readGate = new RequestGate()
  private writeGate = new RequestGate()
  private listeners = new Set<() => void>()

  constructor(private readonly rpc: DefaultsRpc) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  get dirty(): boolean { return this.status !== null && this.selectedId !== this.status.characterId }

  choose(characterId: string | null): void {
    if (this.disposed || this.busy || !this.status) return
    if (!this.dirty) this.draftRevision = this.status.revision
    this.selectedId = characterId; this.message = ''
    if (!this.dirty) { this.draftRevision = this.status.revision; this.conflict = false }
    if (!this.conflict) this.error = ''
    this.notify()
  }

  discard(): void {
    if (this.disposed || this.busy) return
    this.selectedId = this.status?.characterId ?? null
    this.draftRevision = this.status?.revision ?? 0
    this.error = ''; this.message = ''; this.conflict = false; this.notify()
  }

  /** A normal refresh reports the current persisted value without silently rebasing a pending choice. */
  async refresh(options: { acceptDraftRevision?: boolean } = {}): Promise<void> {
    if (this.disposed || this.busy) return
    const request = this.readGate.start()
    this.loading = true; this.error = ''; this.notify()
    try {
      const record = await unwrap(this.rpc.getDefaultCharacter(request.signal))
      if (!request.current() || this.disposed) return
      const keepChoice = this.dirty
      this.status = record
      if (!keepChoice) this.selectedId = record.characterId
      if (!keepChoice || !this.dirty || options.acceptDraftRevision) {
        this.draftRevision = record.revision; this.conflict = false
      }
      if (options.acceptDraftRevision) this.message = this.dirty ? '已加载最新设置；所选角色已保留，确认后可再次保存。' : '当前已保存的默认设置与所选内容一致。'
    } catch (error) {
      if (request.current() && !this.disposed) this.error = this.messageOf(error)
    } finally {
      if (request.current() && !this.disposed) { this.loading = false; this.notify() }
    }
  }

  async save(): Promise<void> {
    if (this.disposed || this.busy || !this.status || !this.dirty || this.conflict) return
    const id = this.selectedId; const revision = this.draftRevision
    const request = this.writeGate.start()
    this.readGate.cancel(); this.loading = false; this.busy = true; this.error = ''; this.message = ''; this.notify()
    try {
      const record = await unwrap(this.rpc.setDefaultCharacter(id, revision, request.signal))
      if (!request.current() || this.disposed) return
      this.status = record; this.selectedId = record.characterId; this.draftRevision = record.revision; this.conflict = false
      this.message = record.characterId === null ? '已取消自动选择角色，仅之后新建的会话生效。' : '默认角色已保存，仅之后新建的会话使用此设置。'
    } catch (error) {
      if (!request.current() || this.disposed) return
      this.conflict = error instanceof CharacterRpcError && ['conflict', 'revision-conflict'].includes(error.reason)
      this.error = this.conflict ? '默认设置已在其他窗口更新。所选角色已保留，请加载最新设置后再保存。' : this.messageOf(error)
    } finally {
      if (request.current() && !this.disposed) { this.busy = false; this.notify() }
    }
  }

  private messageOf(error: unknown): string { return error instanceof Error ? error.message : '默认角色设置失败，请重试。' }
  private notify(): void { if (!this.disposed) this.listeners.forEach(listener => listener()) }
  dispose(): void { this.disposed = true; this.readGate.cancel(); this.writeGate.cancel(); this.listeners.clear() }
}
