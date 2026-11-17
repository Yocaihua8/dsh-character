import type { GrowthChange, GrowthConfig, GrowthEntry, GrowthModel, GrowthModelOption, GrowthState, GrowthStatus } from '../shared/growth.js'
import { CharacterRpcError, RequestGate, unwrap, type RemoteResult } from './controller.js'

export interface GrowthRpc {
  getGrowth(characterId: string, signal: AbortSignal): Promise<RemoteResult<GrowthStatus>>
  configureGrowth(config: GrowthConfig, signal: AbortSignal): Promise<RemoteResult<GrowthConfig>>
  changeGrowth(request: GrowthChange, signal: AbortSignal): Promise<RemoteResult<GrowthState>>
  registerGrowthSession(sessionId: string, signal: AbortSignal): Promise<RemoteResult<boolean>>
}
export const modelKey = (model: GrowthModel) => JSON.stringify([model.provider, model.model])
export const modelLabel = (config: GrowthConfig | undefined, models: GrowthModelOption[]) => {
  if (!config?.model) return '尚未选择'
  const selected = config.model
  return `${models.find(item => modelKey(item) === modelKey(selected))?.label ?? selected.model} · ${selected.reasoningEffort ?? '默认档位'}`
}

/** Presentation only: the host remains authoritative about application and learning. */
export function growthPresentation(value: GrowthStatus, baseRevision: number) {
  const { state, config } = value
  const available = !!config.model && value.models.some(item => modelKey(item) === modelKey(config.model!))
  const fallback = !!value.usingFallback
  const compatibility = value.message.includes('兼容模式：') ? value.message.slice(value.message.indexOf('兼容模式：')) : ''
  const message = value.message.replace(/\s*兼容模式：.*$/s, '').trim()
  const rechecking = state.baseRevision !== baseRevision
  const ordinary = /^(成长已关闭|已开启：|学习已暂停|本批没有通过核验的成长)/.test(message)
  const problem = state.enabled && (!!message && !ordinary || rechecking || !available && !fallback)
  const title = !state.enabled ? '成长已关闭' : rechecking ? '等待人设重新核验' : !available && !fallback ? '整理模型不可用'
    : fallback ? '已回退主聊天模型整理' : problem ? '整理需要关注' : !state.learning ? '学习已暂停' : state.entries.length ? '已有成长' : '已开启，等待新聊天'
  const description = !state.enabled ? '下一轮使用基本人设，成长记录保留。' : rechecking ? message
    : !available && !fallback ? `整理已暂停。${value.applied ? '已有成长继续使用。' : '当前使用基本人设。'}`
    : fallback ? '固定整理模型当前不可用，正以主聊天模型整理；恢复后自动切回。'
    : problem ? message : !state.learning ? (value.applied ? '暂停积累，继续使用已有成长。' : '暂停积累，目前使用基本人设。')
    : state.entries.length ? (value.applied ? '经过核验的相处方式从下一轮使用。' : '条目已保留，当前未应用成长。')
    : '从开启后的新主聊天开始积累，目前使用基本人设。'
  return { title, description, compatibility, problem, retry: state.enabled && available && problem }
}

/** Drafts and in-flight writes belong to the plugin activation, just like persona drafts. */
export class GrowthController {
  records = new Map<string, GrowthStatus>()
  errors = new Map<string, string>()
  loading = new Set<string>()
  config?: GrowthConfig
  models: GrowthModelOption[] = []
  modelDraft?: GrowthConfig
  editing?: { characterId: string; id: string; revision: number; text: string; original: string }
  busy = false
  error = ''
  conflict = false
  message = ''
  private disposed = false
  private readGates = new Map<string, RequestGate>()
  private writeGate = new RequestGate()
  private listeners = new Set<() => void>()
  constructor(private readonly rpc: GrowthRpc) {}
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  get modelDirty() {
    if (!this.modelDraft) return false
    return JSON.stringify(this.modelDraft.model) !== JSON.stringify(this.config?.model)
      || !!this.modelDraft.fallbackToMain !== !!this.config?.fallbackToMain
  }
  get dirty() { return this.modelDirty || !!this.editing && this.editing.text !== this.editing.original }
  status(id: string) {
    const value = this.records.get(id)
    return value && { ...value, config: this.config ?? value.config, models: this.models }
  }
  async refresh(id: string, rebase = false): Promise<void> {
    if (this.disposed || this.busy) return
    let gate = this.readGates.get(id)
    if (!gate) this.readGates.set(id, gate = new RequestGate())
    const request = gate.start()
    this.loading.add(id); this.notify()
    try {
      const value = await unwrap(this.rpc.getGrowth(id, request.signal))
      if (!request.current() || this.disposed) return
      this.records.set(id, value); this.errors.delete(id)
      if (!this.config || value.config.revision >= this.config.revision) { this.config = value.config; this.models = value.models }
      if (rebase) {
        if (this.modelDraft) this.modelDraft = { ...this.modelDraft, revision: value.config.revision }
        if (this.editing?.characterId === id) this.editing = { ...this.editing, revision: value.state.revision }
        this.error = ''; this.conflict = false; this.message = '已加载最新版本，草稿保留；请确认后再保存。'
      }
    } catch (error) {
      if (request.current() && !this.disposed) this.errors.set(id, this.messageOf(error))
    } finally { if (request.current() && !this.disposed) { this.loading.delete(id); this.notify() } }
  }
  openModel() { if (!this.modelDraft && this.config) this.modelDraft = structuredClone(this.config); this.error = ''; this.conflict = false; this.notify() }
  editModel(model: GrowthModel | null) { if (this.busy || !this.modelDraft) return; this.modelDraft = { ...this.modelDraft, model }; this.message = ''; this.notify() }
  editFallback(on: boolean) { if (this.busy || !this.modelDraft) return; this.modelDraft = { ...this.modelDraft, fallbackToMain: on }; this.message = ''; this.notify() }
  editEntry(characterId: string, entry: GrowthEntry) {
    const value = this.records.get(characterId)
    if (!value || this.busy) return
    this.editing = { characterId, id: entry.id, revision: value.state.revision, text: entry.content, original: entry.content }
    this.error = ''; this.conflict = false; this.notify()
  }
  editText(text: string) { if (this.editing && !this.busy) { this.editing = { ...this.editing, text }; this.notify() } }
  discard() { if (this.busy) return; this.modelDraft = undefined; this.editing = undefined; this.error = ''; this.conflict = false; this.notify() }
  async saveModel(characterId: string): Promise<boolean> {
    if (!this.modelDraft?.model || !this.modelDirty || this.conflict) return false
    const submitted = structuredClone(this.modelDraft)
    const saved = await this.write(async signal => {
      const config = await unwrap(this.rpc.configureGrowth(submitted, signal))
      return () => { this.config = config; this.modelDraft = undefined; this.message = '整理模型已保存，所有角色共用。' }
    })
    if (saved) await this.refresh(characterId)
    return saved
  }
  async correct(): Promise<boolean> {
    const draft = this.editing
    if (!draft || !draft.text.trim() || this.conflict) return false
    return this.change(draft.characterId, 'correct', { entryId: draft.id, content: draft.text }, draft.revision)
  }
  async change(characterId: string, action: GrowthChange['action'], extra: Partial<Pick<GrowthChange, 'entryId' | 'content' | 'version'>> = {}, revision?: number): Promise<boolean> {
    const value = this.records.get(characterId)
    if (!value) return false
    const saved = await this.write(async signal => {
      const state = await unwrap(this.rpc.changeGrowth({ characterId, action, expectedRevision: revision ?? value.state.revision, ...extra }, signal))
      return () => {
        this.records.set(characterId, { ...value, state })
        if (action === 'correct') this.editing = undefined
        this.message = action === 'retry' ? '已请求重新整理。' : '成长设置已保存；下一轮采用更新。'
      }
    })
    if (saved) await this.refresh(characterId)
    return saved
  }
  private async write(run: (signal: AbortSignal) => Promise<() => void>): Promise<boolean> {
    if (this.disposed || this.busy) return false
    for (const gate of this.readGates.values()) gate.cancel()
    this.loading.clear()
    const request = this.writeGate.start()
    this.busy = true; this.error = ''; this.message = ''; this.conflict = false; this.notify()
    try {
      const commit = await run(request.signal)
      if (!request.current() || this.disposed) return false
      commit(); return true
    } catch (error) {
      if (request.current() && !this.disposed) {
        this.conflict = error instanceof CharacterRpcError && ['conflict', 'revision-conflict'].includes(error.reason)
        this.error = this.conflict ? '内容已在其他窗口更新。原数据和草稿已保留，请显式加载最新版本后重试。' : this.messageOf(error)
      }
      return false
    } finally { if (request.current() && !this.disposed) { this.busy = false; this.notify() } }
  }
  private messageOf(error: unknown) { return error instanceof Error ? error.message : '成长服务暂不可用，请重试。' }
  private notify() { if (!this.disposed) this.listeners.forEach(listener => listener()) }
  dispose() { this.disposed = true; this.writeGate.cancel(); this.readGates.forEach(gate => gate.cancel()); this.listeners.clear() }
}

/** Seeing an existing snapshot is not a new update. Opening growth acknowledges its version. */
export class GrowthNotices {
  private seen = new Map<string, number>()
  private latest = new Map<string, number>()
  read(value: GrowthStatus, baseRevision: number) {
    const id = value.state.characterId, revision = value.state.history.at(-1)?.revision ?? 0
    if (!this.seen.has(id)) this.seen.set(id, revision)
    this.latest.set(id, revision)
    if (growthPresentation(value, baseRevision).problem) return '成长需要关注'
    return value.state.enabled && revision > (this.seen.get(id) ?? 0) ? '成长有新变化' : ''
  }
  acknowledge(id: string) { this.seen.set(id, this.latest.get(id) ?? this.seen.get(id) ?? 0) }
}
