import type { Context } from '@deepseek-ai/cordis'
import { assembleContextFor, type Agent, type SessionStartSource, type TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import '@deepseek-ai/dsh-session-projection'
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import type { Character, CharacterBinding, CharacterBindingStatus } from '../shared/types.js'
import { compileCharacter } from './prompt.js'
import { isRootAgent } from './main-agent.js'
import { CharacterError, type CharacterStore } from './store.js'

/** The pre-0.2.2 registry reader, kept structurally because that host declared no return type here. */
interface LegacyTurnBoundaryReader {
  sessionProjections?: {
    stateOf?: (session: Session, key: string) => {
      readonly lastTurn?: number
      readonly openTurnStartSeq?: number | null
    } | undefined
  }
}

interface AgentState {
  agent: Agent
  text: string
  snapshot?: Character
  turn?: number
  deferredTurn?: number
  lock?: Promise<CharacterBinding | undefined>
  error?: unknown
  disposePrefix?: () => void
  validatedEpoch: number
  setup?: Promise<void>
}

/** Character bindings own only the main agent's deployment persona slot. */
export class CharacterRuntime {
  private readonly states = new Map<Agent, AgentState>()
  private readonly listeners: (() => void)[] = []
  private readonly pending = new Set<Promise<unknown>>()
  private epoch = 0
  private closed = false
  private initialization?: Promise<void>
  private disposal?: Promise<void>

  constructor(
    private readonly ctx: Context,
    private readonly store: CharacterStore,
    private readonly defaultCharacter?: () => Promise<Character | undefined>,
    private readonly growthText?: (character: Character) => string,
  ) {}

  get ready(): Promise<void> { return this.init() }

  init(pendingCreations?: ReadonlySet<Agent>): Promise<void> {
    if (this.initialization) return this.initialization
    this.assertOpen()
    this.listeners.push(
      this.ctx.on('system-prompt/change', () => { this.epoch++ }),
      this.ctx.on('agent/created', async ({ agent, source, signal }) => {
        await this.initializeCreatedAgent(agent, source, signal)
        return undefined
      }),
      this.ctx.on('agent/disposed', ({ agent }) => this.detach(agent)),
      this.ctx.on('session/event', (session, event) => {
        const agent = this.ctx.agents.get(session.id)
        if (!agent || agent.session !== session) return
        const state = this.states.get(agent)
        if (!state) return
        if (event.type === 'turn/start') this.startTurn(state, event.data.turn)
        if (event.type === 'turn/end' && state.turn === event.data.turn) {
          state.turn = undefined
          state.snapshot = undefined
          state.lock = undefined
          state.error = undefined
        }
      }),
      this.ctx.on('agent/pre-step', async (payload, next) => {
        if (this.closed || !this.isMain(payload.agent)) return next()
        await this.attach(payload.agent, true)
        const state = this.states.get(payload.agent)
        if (!state || state.deferredTurn === payload.turn) return next()
        if (state.turn !== payload.turn) this.startTurn(state, payload.turn)
        if (state.error) throw state.error
        await state.lock
        if (state.error) throw state.error
        if (state.snapshot) {
          await this.track(this.ensurePrefix(state, payload.signal))
          await this.validate(state, payload.signal, true)
        }
        return next()
      }),
    )
    this.initialization = this.track((async () => {
      for (const agent of this.ctx.agents.list()) {
        // The Host's early creation gate retains the source while storage opens.
        // It initializes these agents after ready, without turning them into resumes.
        if (!pendingCreations?.has(agent)) await this.attach(agent, true)
      }
    })())
    return this.initialization
  }

  /** Also used for creation announcements held before runtime listeners existed. */
  initializeCreatedAgent(agent: Agent, source: SessionStartSource, signal?: AbortSignal): Promise<void> {
    this.assertOpen()
    return this.attach(agent, false, source, signal)
  }

  bindingStatus(sessionId: string): CharacterBindingStatus {
    this.assertOpen()
    const binding = this.store.getBinding(sessionId) ?? null
    const character = binding ? this.store.get(binding.characterId) : null
    const agent = this.ctx.agents.get(SessionId(sessionId))
    let reason = ''
    if (!agent) reason = '请先打开会话。'
    else if (!this.isMain(agent)) reason = '子 agent 使用原有任务身份，不能绑定人设。'
    else if (binding?.locked || this.hasStarted(agent.session)) reason = '此会话已开始，换人设请另开会话。'
    else if (agent.status !== 'idle') reason = '请等待当前回复结束。'
    const failure = agent && this.states.get(agent)?.error
    if (failure) reason = failure instanceof Error ? failure.message : '人设配置无法加载。'
    return { binding, character, canBind: reason === '', reason }
  }

  async bind(sessionId: string, characterId: string): Promise<CharacterBindingStatus> {
    await this.init()
    this.assertOpen()
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (!agent) throw new CharacterError('not-found', '会话尚未打开。')
    const status = this.bindingStatus(sessionId)
    if (!status.canBind) throw new CharacterError('locked', status.reason)
    // Maintenance claims the idle phase synchronously. Input queued during disk
    // commit cannot start a turn until the new binding has become durable.
    return this.track(agent.runMaintenance(async signal => {
      this.assertLive(agent)
      const latest = this.bindingStatus(sessionId)
      if (!latest.canBind) throw new CharacterError('locked', latest.reason)
      await this.attach(agent, false)
      const state = this.states.get(agent)!
      const character = this.store.get(characterId)
      const binding = await this.commitBinding(state, character, signal)
      return { binding, character: this.store.get(characterId), canBind: true, reason: '' }
    }))
  }

  /** The caller owns either the maintenance boundary or serial agent creation. */
  private async commitBinding(state: AgentState, character: Character, signal?: AbortSignal): Promise<CharacterBinding> {
    if (character.archived) throw new CharacterError('archived', '已归档人设不能用于新绑定。')
    const previous = { text: state.text, snapshot: state.snapshot, disposePrefix: state.disposePrefix }
    state.snapshot = { ...character }
    state.text = compileCharacter(state.snapshot)
    state.validatedEpoch = -1
    try {
      await this.ensurePrefix(state, signal)
      await this.validate(state, signal)
      signal?.throwIfAborted()
      this.assertLive(state.agent)
      if (this.hasStarted(state.agent.session)) throw new CharacterError('locked', '此会话已开始，换人设请另开会话。')
      // bind rechecks archival inside the store queue. Never publish an identity
      // if validation or the durable write fails, including an archival race.
      return await this.store.bind(state.agent.id, character.id)
    } catch (error) {
      if (!previous.disposePrefix) {
        state.disposePrefix?.()
        state.disposePrefix = undefined
      }
      state.text = previous.text
      state.snapshot = previous.snapshot
      state.validatedEpoch = -1
      throw error
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.closed = true
    for (const dispose of this.listeners.splice(0).reverse()) dispose()
    this.disposal = (async () => {
      await Promise.allSettled([...this.pending])
      for (const agent of [...this.states.keys()]) this.detach(agent)
    })()
    return this.disposal
  }

  private isMain(agent: Agent): boolean {
    return agent.session.header.origin !== 'subagent'
      && !(agent.session.header.delegationDepth && agent.session.header.delegationDepth > 0)
      && isRootAgent(this.ctx.agents, agent)
  }

  /**
   * Turn-boundary facts for one Session. Harness moved this read behind the
   * owning `agents` service in 0.2.2, so both entry points are probed at runtime.
   */
  private turnBoundary(session: Session): { lastTurn: number; openTurnStartSeq: number | null } {
    // Harness 0.2.2-rc.1 and later: `ctx.agents.turnBoundaryOf(session)`.
    // The member is contributed by the owning agent-loop packages rather than by the
    // `dsh-agent` registry type this plugin imports, so it is read structurally.
    const agents = this.ctx.agents as { turnBoundaryOf?(session: Session): TurnBoundaryProjection | undefined }
    const current = agents.turnBoundaryOf?.(session)
    if (current) return { lastTurn: current.lastTurn, openTurnStartSeq: current.openTurnStartSeq }
    // Harness 0.2.1-rc.3 / rc.4 / rc.5: the projection registry was the only reader for this key.
    const legacy = (this.ctx as unknown as LegacyTurnBoundaryReader).sessionProjections?.stateOf?.(session, 'turnBoundary')
    const openTurnStartSeq = legacy?.openTurnStartSeq
    if (legacy && typeof legacy.lastTurn === 'number'
      && (openTurnStartSeq === null || typeof openTurnStartSeq === 'number')) {
      return { lastTurn: legacy.lastTurn, openTurnStartSeq }
    }
    throw new CharacterError('conflict', '无法读取会话轮次状态，请检查 Harness agent-loop 是否就绪。')
  }

  private hasStarted(session: Session): boolean {
    const boundary = this.turnBoundary(session)
    return boundary.lastTurn > 0 || boundary.openTurnStartSeq !== null
  }

  private attach(agent: Agent, existing: boolean, source?: SessionStartSource, signal?: AbortSignal): Promise<void> {
    if (this.closed || !this.isMain(agent)) return Promise.resolve()
    const known = this.states.get(agent)
    if (known) return known.setup ?? Promise.resolve()
    const state: AgentState = { agent, text: '', validatedEpoch: -1 }
    this.states.set(agent, state)
    state.setup = this.track((async () => {
      let binding = this.store.getBinding(agent.id)
      const parent = agent.session.header.parentSession
      if (!binding && parent) binding = await this.store.inherit(agent.id, parent)
      if (!binding && !existing && source === 'startup' && !parent
        && !agent.session.header.isSeeded && !this.hasStarted(agent.session) && this.defaultCharacter) {
        // Resolve once before any slow validation. Later preference changes only
        // affect future sessions; resumed/cleared/forked sessions never backfill.
        const character = await this.defaultCharacter()
        signal?.throwIfAborted()
        this.assertLive(agent)
        if (character && !character.archived) await this.commitBinding(state, character, signal)
        return
      }
      if (!binding || this.closed) return
      if (existing && agent.status === 'running') {
        state.deferredTurn = this.turnBoundary(agent.session).lastTurn
        return
      }
      const character = this.store.get(binding.characterId)
      state.snapshot = character
      state.text = compileCharacter(character)
      await this.ensurePrefix(state)
      await this.validate(state)
      if (!binding.locked && this.hasStarted(agent.session)) await this.store.lock(agent.id)
    })().catch(error => {
      state.disposePrefix?.()
      state.disposePrefix = undefined
      state.error = error
      // One incompatible retained session must not disable character management
      // for every other session when this plugin is enabled.
      if (!existing) throw error
    }))
    return state.setup
  }

  private startTurn(state: AgentState, turn: number): void {
    if (state.turn === turn || state.deferredTurn === turn) return
    state.deferredTurn = undefined
    state.turn = turn
    state.error = undefined
    state.snapshot = undefined
    try {
      const binding = this.store.getBinding(state.agent.id)
      if (!binding) return
      // The synchronous event observer captures the revision before any awaiting
      // listener or concurrent character edit can advance it.
      state.snapshot = this.store.get(binding.characterId)
      // Both immutable revisions are captured synchronously. Tools and retries reuse this text.
      const text = compileCharacter(state.snapshot) + (this.growthText?.(state.snapshot) ?? '')
      if (state.text !== text) state.validatedEpoch = -1
      state.text = text
      state.lock = this.track(this.store.lock(state.agent.id))
      // Session events are fire-and-forget; pre-step awaits the original promise.
      void state.lock.catch(() => {})
    } catch (error) { state.error = error }
  }

  private async ensurePrefix(state: AgentState, signal?: AbortSignal): Promise<void> {
    if (state.disposePrefix) return
    this.assertLive(state.agent)
    // A separate temporary marker detects complete prompts even when their
    // section uses the very prefix name that our scoped override would shadow.
    const probeName = 'dsh-character:compatibility-probe'
    const disposeProbe = state.agent.ctx.systemPrompt.section({ name: probeName, order: 0, text: '', interpolate: false })
    try {
      const assembled = await state.agent.ctx.systemPrompt.assemble(assembleContextFor(state.agent, signal))
      if (!assembled.sections.some(section => section.name === probeName)) throw this.incompatible()
    } finally { disposeProbe() }
    this.assertLive(state.agent)
    try {
      state.disposePrefix = state.agent.ctx.systemPrompt.section({
        name: PERSONA_PREFIX_SECTION,
        order: state.agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        text: () => state.text,
        interpolate: false,
      })
    } catch {
      throw new CharacterError('conflict', '当前会话的人设位置已由其他插件占用，请先解除冲突。')
    }
    state.validatedEpoch = -1
  }

  private async validate(state: AgentState, signal?: AbortSignal, force = false): Promise<void> {
    if (!force && state.validatedEpoch === this.epoch) return
    for (let attempt = 0; attempt < 2; attempt++) {
      const epoch = this.epoch
      const expected = state.text
      const assembly = await state.agent.ctx.systemPrompt.assemble(assembleContextFor(state.agent, signal))
      const prefix = assembly.sections.filter(section => section.name === PERSONA_PREFIX_SECTION)
      if (prefix.length !== 1 || prefix[0]?.text !== expected || prefix[0]?.interpolate !== false) throw this.incompatible()
      if (epoch === this.epoch && expected === state.text) {
        state.validatedEpoch = epoch
        return
      }
    }
    throw new CharacterError('conflict', '提示词配置正在变化，请稍后重试。')
  }

  private incompatible(): CharacterError {
    return new CharacterError('conflict', '当前完整系统提示词或组装插件覆盖了人设位置；请停用 complete 提示词配置后重试。')
  }

  private detach(agent: Agent): void {
    const state = this.states.get(agent)
    this.states.delete(agent)
    state?.disposePrefix?.()
  }

  private assertOpen(): void {
    if (this.closed) throw new CharacterError('closed', '人设插件已停用。')
  }

  private assertLive(agent: Agent): void {
    this.assertOpen()
    if (this.ctx.agents.get(agent.id) !== agent) throw new CharacterError('not-found', '会话已关闭，请重新打开。')
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation)
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation))
    return operation
  }
}
