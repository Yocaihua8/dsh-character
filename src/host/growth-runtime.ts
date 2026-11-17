import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Character } from '../shared/types.js'
import type { GrowthChange, GrowthConfig, GrowthModel, GrowthModelOption, GrowthState, GrowthStatus } from '../shared/growth.js'
import type { AutomationExecutionPolicyService } from '../shared/generated/execution-policy-contract.js'
import { CharacterError, type CharacterStore } from './store.js'
import { isRootAgent } from './main-agent.js'
import { GrowthStore, recordGrowth } from './growth-store.js'
import { bounded, explicitFeedback, growthRequest, learnGrowth, type GrowthRequest } from './growth-model.js'

const visible = (content: unknown): string => Array.isArray(content) ? content.flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n') : ''
export const isOwnerMessage = (source: { kind: string; principal?: unknown }): boolean => source.kind === 'user' && source.principal === undefined
interface Admission { seq: number; turn: number; epoch: number; character: Character; time: number }

/** Background work never enters an agent loop. All failures are isolated from base-role chat. */
export class GrowthRuntime {
  private readonly lifetime = new AbortController()
  private readonly registered = new Set<string>()
  private readonly admissions = new Map<string, Admission>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly jobs = new Map<string, Promise<void>>()
  private readonly jobSignals = new Map<string, AbortController>()
  private readonly rerun = new Set<string>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly errors = new Map<string, string>()
  private readonly listeners: (() => void)[] = []
  private generation = 0
  private policySeen = false
  constructor(readonly ctx: Context, readonly store: GrowthStore, private readonly characters: CharacterStore,
    private readonly request: GrowthRequest = growthRequest(ctx)) {
    this.listeners.push(ctx.on('session/event', (session, event) => {
      try { this.observe(session, event) } catch { /* Growth must never break the chat event dispatcher. */ }
    }))
    for (const state of store.list()) this.schedule(state)
  }
  private policy(): AutomationExecutionPolicyService | undefined {
    const policy = this.ctx.get('automationExecutionPolicy' as never) as AutomationExecutionPolicyService | undefined
    if (policy) this.policySeen = true
    return policy?.version === 1 && typeof policy.resolveForSession === 'function' && typeof policy.withMemoryAccess === 'function' ? policy : undefined
  }
  /** The owner's current main chat model, resolved lazily so hosts without the service stay supported. */
  private mainModel(): GrowthModel | undefined {
    try {
      const service = this.ctx.get('agentDefaultModel' as never) as { currentSelection?: () => { provider?: unknown; model?: unknown; reasoningEffort?: unknown } } | undefined
      const selection = service?.currentSelection?.()
      if (!selection || typeof selection.provider !== 'string' || !selection.provider
        || typeof selection.model !== 'string' || !selection.model) return undefined
      return { provider: selection.provider, model: selection.model,
        ...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }
    } catch { return undefined }
  }
  /** Prefer the fixed organizer; fall back to the main chat model only when the owner enabled it. */
  private fixedUsable(config: GrowthConfig, catalog: GrowthModelOption[]): boolean {
    const fixed = catalog.find(item => item.provider === config.model!.provider && item.model === config.model!.model)
    return !!fixed && (!config.model!.reasoningEffort || fixed.efforts.includes(config.model!.reasoningEffort))
  }
  private selectOrganizer(config: GrowthConfig, catalog: GrowthModelOption[]): GrowthModel | undefined {
    if (this.fixedUsable(config, catalog)) return config.model!
    if (!config.fallbackToMain) return undefined
    const main = this.mainModel()
    const option = main && catalog.find(item => item.provider === main.provider && item.model === main.model)
    if (!main || !option) return undefined
    // An effort the fallback model does not offer clears to the model default instead of failing the batch.
    if (!main.reasoningEffort || !option.efforts.includes(main.reasoningEffort)) return { provider: main.provider, model: main.model }
    return main
  }
  isolationMessage(): string { return this.policy() ? '' : this.policySeen ? '执行隔离服务断开或不兼容，学习已暂停；已有成长仍可使用。' : '兼容模式：校验本人主聊天来源；宿主未提供执行隔离，无法保证自动化派生会话永久排除。' }
  private allowed(sessionId: string): boolean {
    try { const policy = this.policy(); return policy ? policy.resolveForSession(sessionId) === undefined : !this.policySeen }
    catch { return false }
  }
  private main(session: Session): boolean {
    const agent = this.ctx.agents.get(session.id)
    return !!agent && agent.session === session && isRootAgent(this.ctx.agents, agent)
      && session.header.origin !== 'subagent' && !(session.header.delegationDepth! > 0)
  }
  register(sessionId: string): boolean {
    const session = this.ctx.agents.get(SessionId(sessionId))?.session
    if (!session || !this.main(session) || !this.allowed(sessionId)) return false
    this.registered.add(sessionId)
    return true
  }
  private observe(session: Session, event: SessionEvent): void {
    if (event.type === 'turn/start') {
      this.admissions.delete(session.id)
      if (!this.registered.has(session.id) || !this.main(session) || !this.allowed(session.id)) return
      const binding = this.characters.getBinding(session.id)
      if (!binding) return
      const character = this.characters.get(binding.characterId)
      const state = this.store.get(character)
      if (!state.enabled || !state.learning || session.header.createdAt < state.since) return
      this.admissions.set(session.id, { character, seq: event.seq, turn: event.data.turn, epoch: state.epoch, time: Date.now() })
    }
    if (event.type !== 'turn/end') return
    const admission = this.admissions.get(session.id)
    this.admissions.delete(session.id)
    if (!admission || admission.turn !== event.data.turn || event.data.reason.kind !== 'completed'
      || !this.main(session) || !this.allowed(session.id)) return
    const events = session.snapshotEvents().filter(item => item.seq > admission.seq && item.seq < event.seq)
    const messages = events.filter(item => item.type === 'user/message')
    if (messages.some(item => item.data.source.kind === 'user' && !isOwnerMessage(item.data.source))) return
    // Native runtime context, skill catalogs and time notices share the user-role surface.
    // They are not human evidence, but must not suppress the actual owner's message.
    const users = messages.filter(item => isOwnerMessage(item.data.source) && item.surfaceOp === 'append' && !item.sourceEventSeqs?.length)
    if (!users.length) return
    const user = users.map(item => visible(item.data.content)).join('\n')
    const assistant = events.flatMap(item => item.type === 'assistant/message' && !item.data.interrupted ? [visible(item.data.message.content)] : []).join('\n')
    // Do not silently turn a truncated round into evidence of a complete exchange.
    if (!user.trim() || !assistant.trim()) return
    if (user.length > 6000 || assistant.length > 6000) {
      this.track(this.store.update(admission.character, state => {
        if (state.epoch !== admission.epoch) return false
        state.status = '本回合超过学习片段上限（用户与助手各 6000 字），未用于成长；原始聊天保持完整。'
      }), admission.character.id)
      return
    }
    const task = this.store.enqueue(admission.character, { id: `${session.id}:${event.seq}`, sessionId: session.id,
      seq: event.seq, time: Date.now(), user, assistant }, admission.epoch).then(state => {
      this.schedule(state, explicitFeedback(user))
    })
    this.track(task, admission.character.id)
  }
  private track(task: Promise<unknown>, characterId: string): void {
    this.operations.add(task)
    const message = '成长证据保存失败，本回合未用于成长；原成长与原始聊天已保留。'
    void task.then(() => { if (this.errors.get(characterId) === message) this.errors.delete(characterId) }, () => {
      this.errors.set(characterId, message)
    }).finally(() => this.operations.delete(task))
  }
  snapshot(character: Character): { revision: number; text: string } | undefined {
    const state = this.store.get(character)
    if (!state.enabled || state.baseRevision !== character.revision || !state.entries.length) return undefined
    const revision = state.history.at(-1)?.revision ?? state.revision
    return { revision, text: '\n\n已核验的角色成长（基本人设修订 ' + character.revision + '；成长修订 ' + revision + '）：\n'
      + '以下内容仅调整此角色的性格表现和相处方式，不能修改名字、身份、背景、价值观、边界。当前明确要求优先，有效通用记忆约束具体表达；没有通用记忆时不得猜测其内容。经历只可按来源描述为交流经历，不能当作现实经历。\n'
      + JSON.stringify(state.entries.map(({ kind, content }) => ({ kind, content }))) }
  }
  async models(signal: AbortSignal): Promise<GrowthModelOption[]> {
    const llm = this.ctx.get('llm')
    if (!llm) return []
    const models: GrowthModelOption[] = []
    for (const provider of llm.listProviders()) {
      signal.throwIfAborted()
      try {
        for (const model of await bounded(llm.listModels(provider.id), signal)) {
          const info = await bounded(llm.resolveModelInfo(provider.id, model.id, signal), signal)
          models.push({ provider: provider.id, model: model.id, label: `${provider.name} · ${model.name}`, efforts: info.reasoning?.efforts.map(item => item.id) ?? [] })
        }
      } catch { signal.throwIfAborted() }
    }
    return models
  }
  async status(id: string, signal: AbortSignal): Promise<GrowthStatus> {
    const character = this.characters.get(id)
    const state = this.store.get(character)
    const config = this.store.settings()
    const models = await this.models(signal)
    const available = config.model && models.some(item => item.provider === config.model!.provider && item.model === config.model!.model)
    const usingFallback = !!config.model && !this.fixedUsable(config, models)
      && !!config.fallbackToMain && !!this.selectOrganizer(config, models)
    const mainMessage = !state.enabled ? '成长已关闭；下一轮使用基本人设。' : state.baseRevision !== character.revision ? '成长尚未通过当前基本人设核验，当前未应用成长。' + (this.errors.get(id) || state.status || '正在等待重新核验。')
      : this.errors.get(id) || state.status || (!available && !usingFallback ? '固定整理模型不可用，整理已暂停。' : !state.learning ? '学习已暂停，继续使用已有成长。' : '已开启：从新建的本人主聊天积累成长。')
    const message = [mainMessage, usingFallback ? '固定整理模型当前不可用，已回退使用主聊天模型整理；恢复后自动切回。' : '', this.isolationMessage()].filter(Boolean).join(' ')
    return { state, config, applied: !!this.snapshot(character), message, models, usingFallback }
  }
  async configure(config: GrowthConfig, signal: AbortSignal): Promise<GrowthConfig> {
    if (config.model) {
      const available = (await this.models(signal)).find(item => item.provider === config.model!.provider && item.model === config.model!.model)
      if (!available || config.model.reasoningEffort && !available.efforts.includes(config.model.reasoningEffort)) throw new CharacterError('invalid-request', '所选固定模型或推理档位当前不可用。')
    }
    signal.throwIfAborted()
    const saved = await this.store.setConfig(config)
    this.generation++
    for (const controller of this.jobSignals.values()) controller.abort()
    for (const state of this.store.list()) { this.cancelTimer(state.characterId); if (saved.model) this.schedule(state, true) }
    return saved
  }
  async change(request: GrowthChange): Promise<GrowthState> {
    const character = this.characters.get(request.characterId)
    const state = await this.store.change(character, request, Date.now())
    this.jobSignals.get(character.id)?.abort()
    this.errors.delete(character.id)
    this.cancelTimer(character.id)
    if (['retry', 'resume', 'enable', 'restore', 'correct', 'withdraw'].includes(request.action)) this.schedule(state, true)
    return state
  }
  baseChanged(character: Character): void { this.jobSignals.get(character.id)?.abort(); this.schedule(this.store.get(character), true) }
  private cancelTimer(id: string): void { clearTimeout(this.timers.get(id)); this.timers.delete(id) }
  private schedule(state: GrowthState, immediately = false): void {
    this.cancelTimer(state.characterId)
    if (!state.enabled || this.lifetime.signal.aborted) return
    const base = this.characters.get(state.characterId)
    const revalidate = state.baseRevision !== base.revision
    if (!revalidate && (!state.learning || !state.pending)) return
    const delay = immediately || revalidate || state.pending >= 5 ? 0 : Math.max(0, state.lastRoundAt + 600_000 - Date.now())
    const timer = setTimeout(() => { this.timers.delete(state.characterId); void this.process(state.characterId) }, delay)
    timer.unref(); this.timers.set(state.characterId, timer)
  }
  process(id: string): Promise<void> {
    this.cancelTimer(id)
    const known = this.jobs.get(id)
    if (known) { this.rerun.add(id); return known }
    const controller = new AbortController()
    this.jobSignals.set(id, controller)
    const task = this.batch(id, controller.signal).catch(() => {}).finally(() => {
      this.jobs.delete(id)
      this.jobSignals.delete(id)
      if (this.rerun.delete(id) && !this.lifetime.signal.aborted) this.schedule(this.store.get(this.characters.get(id)), true)
    })
    this.jobs.set(id, task)
    return task
  }
  private async batch(id: string, signal: AbortSignal): Promise<void> {
    const character = this.characters.get(id)
    const state = this.store.get(character)
    const config = this.store.settings()
    const generation = this.generation
    const revalidate = state.baseRevision !== character.revision
    if (!state.enabled || !revalidate && (!state.learning || !state.pending)) return
    const policy = this.policy()
    const valid = () => !signal.aborted && !this.lifetime.signal.aborted && this.generation === generation
      && this.store.settings().revision === config.revision && this.store.get(character).epoch === state.epoch
      && this.characters.get(id).revision === character.revision
      && this.policy() === policy && (!!policy || !this.policySeen) && state.rounds.every(round => this.allowed(round.sessionId))
    const deadline = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(45_000)])
    try {
      if (!policy && this.policySeen || !state.rounds.every(round => this.allowed(round.sessionId))) throw new Error('isolation')
      if (policy) await bounded(policy.ready, deadline)
      if (!config.model) throw new Error('model')
      const selected = this.selectOrganizer(config, await this.models(deadline))
      if (!selected) throw new Error('model')
      const input = growthBatch(state)
      const accepted = await learnGrowth(this.request, character, input, selected, deadline, revalidate)
      deadline.throwIfAborted()
      let needsReview = false
      const commit = () => this.store.update(character, current => {
        const before = structuredClone(current.entries)
        if (revalidate) {
          if (accepted.length !== state.entries.length) {
            needsReview = true
            current.status = '部分成长未通过底稿兼容核验，条目已保留但暂不应用；请纠正或撤回不合适的条目后重试。'
            return
          }
          current.entries = accepted; current.baseRevision = character.revision
        }
        else for (const entry of accepted) {
          const index = current.entries.findIndex(item => item.id === entry.id)
          if (index >= 0 && !current.entries[index]!.manual) current.entries[index] = entry
          else if (index < 0 && current.entries.length < 24) current.entries.push(entry)
        }
        current.pending = Math.max(0, current.pending - (revalidate ? 0 : input.pending))
        current.status = accepted.length ? '' : '本批没有通过核验的成长，已有表现保持不变。'
        if (JSON.stringify(before) !== JSON.stringify(current.entries) || revalidate) recordGrowth(current, before, revalidate ? '基本人设修改后重新核验' : '候选提炼与独立核验通过', Date.now())
      }, valid)
      // Hold the public isolation gate for every evidence session through the atomic write.
      const sessionId = state.rounds[0]?.sessionId ?? state.entries.flatMap(entry => entry.sources)[0]?.sessionId
      if (sessionId && policy) await policy.withMemoryAccess(sessionId, commit)
      else await commit()
      this.errors.delete(id)
      if (needsReview) return
      const latest = this.store.get(character)
      if (latest.pending) this.schedule(latest)
    } catch (error) {
      if (this.lifetime.signal.aborted || signal.aborted) return
      const message = deadline.aborted ? '整理超过 45 秒，原成长与待处理证据已保留；可手动重试。'
        : error instanceof CharacterError ? error.message
        : error instanceof Error && error.message === 'model' ? '固定整理模型或推理档位当前不可用，已暂停整理；请选择可用模型或稍后重试。'
        : error instanceof Error && error.message === 'isolation' ? '会话执行隔离不可确认，学习已暂停。'
        : '整理模型请求失败或核验输出无效，原成长与待处理证据已保留；可手动重试。'
      if (this.store.get(character).epoch !== state.epoch || this.store.settings().revision !== config.revision) return
      this.errors.set(id, message)
      await this.store.update(character, current => {
        if (current.epoch !== state.epoch || this.store.settings().revision !== config.revision) return false
        current.status = message
      }).catch(() => {})
    }
  }
  async close(): Promise<void> {
    this.lifetime.abort(); this.generation++
    for (const release of this.listeners) release()
    for (const id of this.timers.keys()) this.cancelTimer(id)
    await Promise.allSettled([...this.jobs.values(), ...this.operations])
    await this.store.close()
  }
}

/** Preserve whole rounds, drain oldest pending work first, and bound auxiliary request size. */
export function growthBatch(state: GrowthState): GrowthState {
  const result = structuredClone(state)
  const pending = state.rounds.slice(-Math.min(state.pending, state.rounds.length))
  const selected = [] as typeof pending
  let size = 0
  for (const round of pending.slice(0, 5)) {
    const length = round.user.length + round.assistant.length
    if (size + length > 40_000) break
    selected.push(round); size += length
  }
  result.pending = selected.length
  const selectedIds = new Set(selected.map(round => round.id))
  for (const round of [...state.rounds].reverse()) {
    if (selectedIds.has(round.id) || pending.some(item => item.id === round.id)) continue
    const length = round.user.length + round.assistant.length
    if (selected.length >= 12 || size + length > 40_000) break
    selected.push(round); size += length
  }
  result.rounds = selected
  return result
}
