import type { Character, CharacterBindingStatus, SaveCharacterRequest } from '../shared/types.js'

export const fieldKeys = ['name', 'identity', 'background', 'personality', 'values', 'style', 'boundaries'] as const
export type CharacterDraft = Pick<Character, typeof fieldKeys[number]>
export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { message: string; code?: string; details?: { reason?: string } } }

export interface CharactersRpc {
  listCharacters(signal: AbortSignal): Promise<RemoteResult<Character[]>>
  getCharacter(id: string, signal: AbortSignal): Promise<RemoteResult<Character>>
  saveCharacter(request: SaveCharacterRequest, signal: AbortSignal): Promise<RemoteResult<Character>>
  archiveCharacter(id: string, expectedRevision: number, signal: AbortSignal): Promise<RemoteResult<Character>>
  getBinding(sessionId: string, signal: AbortSignal): Promise<RemoteResult<CharacterBindingStatus>>
  bindCharacter(sessionId: string, characterId: string, signal: AbortSignal): Promise<RemoteResult<CharacterBindingStatus>>
}

export class CharacterRpcError extends Error {
  constructor(message: string, readonly reason = '') { super(message) }
}

export async function unwrap<T>(promise: Promise<RemoteResult<T>>): Promise<T> {
  const result = await promise
  if (!result.ok) throw new CharacterRpcError(result.error.message, result.error.details?.reason ?? result.error.code)
  return result.value
}

export function blankDraft(): CharacterDraft {
  return { name: '', identity: '', background: '', personality: '', values: '', style: '', boundaries: '' }
}

export function fieldsOf(character: Character): CharacterDraft {
  return { name: character.name, identity: character.identity, background: character.background,
    personality: character.personality, values: character.values, style: character.style, boundaries: character.boundaries }
}

function sameFields(a: CharacterDraft, b: CharacterDraft): boolean {
  return fieldKeys.every(key => a[key] === b[key])
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。'
const isConflict = (error: unknown) => error instanceof CharacterRpcError && ['conflict', 'revision-conflict'].includes(error.reason)

/** Invalidates late responses even if a transport does not honor AbortSignal. */
export class RequestGate {
  private controller: AbortController | null = null
  private generation = 0
  start() {
    this.cancel()
    const generation = this.generation
    const controller = this.controller = new AbortController()
    return { signal: controller.signal, current: () => generation === this.generation && !controller.signal.aborted }
  }
  cancel() { this.generation++; this.controller?.abort(); this.controller = null }
}

/** Keeps editor drafts separate from saved records and transport lifetimes. */
export class CharacterEditorController {
  characters: Character[] = []
  selected: Character | null = null
  draft: CharacterDraft | null = null
  loading = false
  busy = false
  canManage = false
  error = ''
  message = ''
  conflict = false
  private disposed = false
  private listGate = new RequestGate()
  private readGate = new RequestGate()
  private writeGate = new RequestGate()
  private listeners = new Set<() => void>()

  constructor(private readonly rpc: CharactersRpc, changed: () => void, initial?: Character) {
    this.listeners.add(changed)
    if (initial) { this.selected = initial; this.draft = fieldsOf(initial) }
  }

  /** Views can detach without destroying an in-flight save or their draft. */
  subscribe(changed: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(changed)
    return () => { this.listeners.delete(changed) }
  }

  get dirty(): boolean {
    return this.draft !== null && !sameFields(this.draft, this.selected ? fieldsOf(this.selected) : blankDraft())
  }

  async refresh(): Promise<void> {
    if (this.disposed) return
    const request = this.listGate.start()
    this.loading = true; this.error = ''; this.notify()
    try {
      const records = await unwrap(this.rpc.listCharacters(request.signal))
      if (!request.current() || this.disposed) return
      this.characters = records; this.canManage = true
      const selected = this.selected && records.find(record => record.id === this.selected!.id)
      if (selected && !this.busy && !this.dirty) {
        this.selected = selected; this.draft = fieldsOf(selected)
      }
    } catch (error) {
      if (!request.current() || this.disposed) return
      if (error instanceof CharacterRpcError && error.reason === 'forbidden') this.canManage = false
      this.error = messageOf(error)
    } finally {
      if (request.current() && !this.disposed) { this.loading = false; this.notify() }
    }
  }

  select(character: Character | null): void {
    if (this.disposed) return
    this.readGate.cancel(); this.writeGate.cancel()
    this.selected = character; this.draft = character ? fieldsOf(character) : blankDraft()
    this.busy = false; this.error = ''; this.message = ''; this.conflict = false; this.notify()
  }

  edit(key: keyof CharacterDraft, value: string): void {
    if (this.disposed || !this.canManage || !this.draft) return
    this.draft = { ...this.draft, [key]: value }; this.message = ''; this.notify()
  }

  discard(): void {
    if (this.disposed) return
    this.draft = this.selected ? fieldsOf(this.selected) : blankDraft()
    this.message = ''; this.notify()
  }

  /** Explicit user choice after a revision conflict; failures leave the draft intact. */
  async reloadSelected(): Promise<void> {
    if (this.disposed || !this.selected || this.busy) return
    const request = this.readGate.start(); const id = this.selected.id; const submitted = this.draft
    this.busy = true; this.error = ''; this.notify()
    try {
      const record = await unwrap(this.rpc.getCharacter(id, request.signal))
      if (!request.current() || this.disposed) return
      this.selected = record
      if (this.draft === submitted) this.draft = fieldsOf(record)
      this.conflict = false
      this.upsert(record); this.message = this.dirty ? '已读取最新版本；加载期间输入的草稿已保留。' : '已加载最新版本。'
    } catch (error) {
      if (request.current() && !this.disposed) this.error = messageOf(error)
    } finally {
      if (request.current() && !this.disposed) { this.busy = false; this.notify() }
    }
  }

  async save(): Promise<void> {
    if (this.disposed || this.busy || !this.canManage || !this.draft) return
    const submitted = this.draft
    const request = this.writeGate.start()
    const input: SaveCharacterRequest = { fields: { ...submitted },
      ...(this.selected ? { id: this.selected.id, expectedRevision: this.selected.revision } : {}) }
    this.busy = true; this.error = ''; this.message = ''; this.conflict = false; this.notify()
    try {
      const record = await unwrap(this.rpc.saveCharacter(input, request.signal))
      if (!request.current() || this.disposed) return
      this.selected = record
      if (this.draft === submitted) this.draft = fieldsOf(record)
      this.upsert(record)
      this.message = this.dirty ? '已保存提交的版本；当前草稿还有未保存修改。' : '已保存。已绑定会话从下一轮开始使用更新，正在进行的回复保持不变。'
    } catch (error) {
      if (!request.current() || this.disposed) return
      this.conflict = isConflict(error)
      this.error = this.conflict ? '角色已在其他窗口更新。当前草稿已保留，请先复制需要的内容，再加载最新版本。' : messageOf(error)
    } finally {
      if (request.current() && !this.disposed) { this.busy = false; this.notify() }
    }
  }

  async archive(): Promise<void> {
    if (this.disposed || this.busy || !this.canManage || !this.selected || this.selected.archived || this.dirty) return
    const request = this.writeGate.start(); const selected = this.selected
    this.busy = true; this.error = ''; this.message = ''; this.notify()
    try {
      const record = await unwrap(this.rpc.archiveCharacter(selected.id, selected.revision, request.signal))
      if (!request.current() || this.disposed) return
      this.selected = record; this.draft = fieldsOf(record); this.upsert(record)
      this.message = '角色已归档；已有绑定会话继续使用，新会话不能再选择。'
    } catch (error) {
      if (!request.current() || this.disposed) return
      this.conflict = isConflict(error)
      this.error = this.conflict ? '角色版本已变化，归档未执行。请加载最新版本后重试。' : messageOf(error)
    } finally {
      if (request.current() && !this.disposed) { this.busy = false; this.notify() }
    }
  }

  private upsert(record: Character): void {
    this.listGate.cancel(); this.loading = false
    this.characters = [...this.characters.filter(item => item.id !== record.id), record]
  }
  private notify(): void { if (!this.disposed) for (const changed of [...this.listeners]) changed() }
  dispose(): void {
    this.disposed = true; this.listGate.cancel(); this.readGate.cancel(); this.writeGate.cancel(); this.listeners.clear()
  }
}

export interface BindingContext { sessionId: string; available: boolean; mayBind: boolean }
export interface BindingPort {
  read(): BindingContext
  rpc: CharactersRpc
  changed(): void
}

/** A composer instance never applies an answer received for another Session. */
export class CharacterBindingController {
  status: CharacterBindingStatus | null = null
  characters: Character[] = []
  loading = false
  choicesLoading = false
  pending = false
  error = ''
  catalogError = ''
  message = ''
  private disposed = false
  private context: BindingContext | null = null
  private readGate = new RequestGate()
  private listGate = new RequestGate()
  private writeGate = new RequestGate()
  constructor(private readonly port: BindingPort) {}

  get canBind(): boolean {
    const now = this.port.read()
    return now.available && now.mayBind && this.status?.canBind === true && !this.pending
  }

  reconcile(): void {
    if (this.disposed) return
    const next = this.port.read()
    const old = this.context
    if (old && old.sessionId === next.sessionId && old.available === next.available && old.mayBind === next.mayBind) return
    this.context = next
    this.readGate.cancel(); this.writeGate.cancel(); this.listGate.cancel()
    this.loading = false; this.choicesLoading = false; this.pending = false; this.error = ''; this.message = ''
    if (!old || old.sessionId !== next.sessionId) { this.status = null; this.characters = []; this.catalogError = '' }
    if (next.available) void this.refresh()
    this.notify()
  }

  async refresh(): Promise<void> {
    const context = this.port.read()
    if (this.disposed || !context.available) return
    const request = this.readGate.start()
    this.loading = true; this.error = ''; this.notify()
    try {
      const result = await unwrap(this.port.rpc.getBinding(context.sessionId, request.signal))
      if (request.current() && this.matches(context)) this.status = result
    } catch (error) {
      if (request.current() && this.matches(context)) this.error = messageOf(error)
    } finally {
      if (request.current() && this.matches(context)) { this.loading = false; this.notify() }
    }
  }

  async loadChoices(): Promise<void> {
    if (this.disposed) return
    const context = this.port.read(); const request = this.listGate.start()
    this.catalogError = ''; this.choicesLoading = true; this.notify()
    try {
      const result = await unwrap(this.port.rpc.listCharacters(request.signal))
      if (request.current() && this.matches(context)) this.characters = result.filter(item => !item.archived)
    } catch (error) {
      if (request.current() && this.matches(context)) { this.characters = []; this.catalogError = messageOf(error) }
    } finally { if (request.current() && this.matches(context)) { this.choicesLoading = false; this.notify() } }
  }

  async bind(characterId: string): Promise<void> {
    if (!this.canBind || this.disposed) return
    const context = this.port.read(); const request = this.writeGate.start()
    this.readGate.cancel(); this.loading = false
    this.pending = true; this.error = ''; this.message = ''; this.notify()
    try {
      const result = await unwrap(this.port.rpc.bindCharacter(context.sessionId, characterId, request.signal))
      if (!request.current() || !this.matches(context)) return
      this.status = result; this.message = `已选择${result.character?.name ? `「${result.character.name}」` : '角色'}，首条聊天后固定。`
    } catch (error) {
      if (!request.current() || !this.matches(context)) return
      this.error = messageOf(error)
      // Host may have locked the Session while this request was in flight.
      const failure = this.error
      await this.refresh()
      if (request.current() && this.matches(context)) this.error = failure
    } finally {
      if (request.current() && this.matches(context)) { this.pending = false; this.notify() }
    }
  }

  private matches(context: BindingContext): boolean {
    const now = this.port.read()
    return !this.disposed && now.available && context.sessionId === now.sessionId && context.mayBind === now.mayBind
  }
  private notify(): void { if (!this.disposed) this.port.changed() }
  dispose(): void { this.disposed = true; this.readGate.cancel(); this.listGate.cancel(); this.writeGate.cancel() }
}
