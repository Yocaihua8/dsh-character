import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, assembleContextFor, type Agent, type SessionStartSource, type TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, SessionLogOffset, type CreateSessionOptions } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { PERSONA_PREFIX_SECTION, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createScope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { CharacterRuntime } from '../src/host/runtime.js'
import { CharacterStore } from '../src/host/store.js'
import { EMPTY_CHARACTER_FIELDS, type Character } from '../src/shared/types.js'

function memoryStore() {
  const tables = new Map<string, Map<string, unknown>>()
  const control: { beforePut?: (table: string, value: unknown) => Promise<void> } = {}
  const domain = {
    table(name: string) {
      if (!tables.has(name)) tables.set(name, new Map())
      const values = tables.get(name)!
      return {
        get: (key: string) => values.get(key),
        entries: () => [...values.entries()],
        async put(key: string, value: unknown) {
          await control.beforePut?.(name, value)
          values.set(key, structuredClone(value))
        },
        async delete(key: string) { values.delete(key) },
      }
    },
    async close() {},
  }
  return { store: new CharacterStore(domain as unknown as ConstructorParameters<typeof CharacterStore>[0]), control }
}

async function harness(defaultCharacter?: () => Promise<Character | undefined>, growth?: (character: Character) => string) {
  const root = new Context()
  await root.plugin(SystemPrompt, { personaPrefix: 'DEFAULT MODEL IDENTITY' })
  await root.plugin(SessionStore)
  // Harness 0.2.2-rc.1: AgentRegistry registers the turnBoundary unit itself,
  // so the projection registry must exist before the agents service starts.
  await root.plugin(SessionProjectionRegistry)
  await root.plugin(AgentRegistry)
  let ctx!: Context
  await root.plugin(Object.assign((injected: Context) => { ctx = injected }, {
    inject: ['agents', 'sessions', 'systemPrompt', 'sessionProjections'],
  }))
  const { store, control } = memoryStore()
  const runtime = new CharacterRuntime(ctx, store, defaultCharacter, growth)
  const character = (name = '星河') => store.save({ fields: { ...EMPTY_CHARACTER_FIELDS, name, identity: '跨模型固定身份 {{literal}}' } })
  async function agent(id: string, options: {
    meta?: CreateSessionOptions['meta']; owner?: Agent; parentScope?: ScopeKey; setup?: (ctx: Context) => void
    source?: SessionStartSource; history?: boolean; signal?: AbortSignal
  } = {}) {
    const value = {} as Agent
    const scope = createScope(ctx, value, options.parentScope ? { parent: options.parentScope } : undefined)
    const session = scope.ctx.sessions.create(SessionId(id), {
      meta: options.meta,
      ...(options.meta?.isSeeded ? { seed: [], inheritedEventCount: SessionLogOffset(0) } : {}),
    })
    let status: 'idle' | 'running' = 'idle'
    let maintenance = false
    const turnSignal = new AbortController().signal
    Object.assign(value, {
      id: session.id, ctx: scope.ctx, session, options: { provider: 'provider-a', model: 'model-a' },
      inbox: { nextTurn: [], nextStep: [] },
      runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>) {
        if (maintenance || status !== 'idle') throw new Error('busy')
        maintenance = true
        return task(turnSignal).finally(() => { maintenance = false })
      },
      cancel() {}, whenIdle: async () => {},
    })
    Object.defineProperty(value, 'status', { get: () => status })
    options.setup?.(scope.ctx)
    const detach = scope.ctx.agents.enter(value, options.owner)
    if (options.history) {
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }
    await scope.ctx.agents.announce(value, options.source ?? 'startup', options.signal)
    return {
      value,
      begin(turn: number) {
        if (maintenance) throw new Error('maintenance owns idle')
        status = 'running'
        session.append('turn/start', { turn })
      },
      end(turn: number) { session.append('turn/end', { turn, reason: { kind: 'completed' } }); status = 'idle' },
      step(turn: number, step = 1) {
        return agentEvents(ctx, value).waterfall('agent/pre-step', { turn, step, messages: [], signal: turnSignal }, async () => ({ kind: 'enter', messages: [] }))
      },
      async prompt() { return renderPrompt(await ctx.systemPrompt.assemble(assembleContextFor(value))) },
      async dispose() { detach(); await scope.dispose() },
    }
  }
  return { root, ctx, store, control, runtime, character, agent, async dispose() { await runtime.dispose(); await root.fiber.dispose(); await store.close() } }
}

test('scoped character preserves guidance, literal text, other sessions, child persona, and model routing', async () => {
  const h = await harness()
  try {
    h.ctx.systemPrompt.section({ name: 'tool:guide', order: 1000, text: 'KEEP TOOL GUIDANCE' })
    await h.runtime.init()
    const c = await h.character()
    const main = await h.agent('main')
    const other = await h.agent('other')
    assert.match(await main.prompt(), /DEFAULT MODEL IDENTITY/)
    await h.runtime.bind(main.value.id, c.id)
    const before = await main.prompt()
    assert.match(before, /星河/)
    assert.match(before, /\{\{literal\}\}/)
    assert.match(before, /powered by DeepSeek Harness/)
    assert.match(before, /KEEP TOOL GUIDANCE/)
    assert.doesNotMatch(before, /DEFAULT MODEL IDENTITY/)
    Object.assign(main.value.options, { provider: 'provider-b', model: 'model-b' })
    assert.equal(await main.prompt(), before)
    assert.match(await other.prompt(), /DEFAULT MODEL IDENTITY/)
    const child = await h.agent('child', { owner: main.value, meta: { origin: 'subagent', delegationDepth: 1, parentSession: main.value.id }, setup(ctx) {
      ctx.systemPrompt.section({ name: PERSONA_PREFIX_SECTION, order: 0, text: 'CHILD TASK PERSONA' })
    } })
    assert.match(await child.prompt(), /CHILD TASK PERSONA/)
    assert.equal(h.store.getBinding(child.value.id), undefined)
    await assert.rejects(h.runtime.bind(child.value.id, c.id), /子 agent/)
    await h.runtime.dispose()
    assert.match(await main.prompt(), /DEFAULT MODEL IDENTITY/)
    const reenabled = new CharacterRuntime(h.ctx, h.store)
    try {
      await reenabled.init()
      assert.match(await main.prompt(), /星河/)
      assert.match(await child.prompt(), /CHILD TASK PERSONA/)
    } finally { await reenabled.dispose() }
  } finally { await h.dispose() }
})

test('turn/start captures the revision synchronously; steps and retries retain it; next turn updates', async () => {
  const h = await harness()
  try {
    await h.runtime.init()
    const c = await h.character('版本一')
    const main = await h.agent('turns')
    await h.runtime.bind(main.value.id, c.id)
    main.begin(1)
    await h.store.save({ id: c.id, expectedRevision: c.revision, fields: { ...EMPTY_CHARACTER_FIELDS, identity: c.identity, name: '版本二' } })
    await main.step(1)
    assert.match(await main.prompt(), /版本一/)
    assert.equal(h.store.getBinding(main.value.id)?.locked, true)
    await main.step(1, 2)
    await main.step(1, 2)
    assert.match(await main.prompt(), /版本一/)
    main.end(1)
    main.begin(2)
    await main.step(2)
    assert.match(await main.prompt(), /版本二/)
    main.end(2)
    await assert.rejects(h.runtime.bind(main.value.id, c.id), /此会话已开始/)
    await main.dispose()
    const cleared = await h.agent('turns')
    assert.match(await cleared.prompt(), /版本二/)
    assert.equal(h.runtime.bindingStatus(cleared.value.id).canBind, false)
    await assert.rejects(h.runtime.bind(cleared.value.id, c.id), /此会话已开始/)
  } finally { await h.dispose() }
})

test('concurrent roles and shared-role sessions remain isolated across SDK compaction surface replacement', async () => {
  const h = await harness()
  try {
    await h.runtime.init()
    const alpha = await h.character('角色甲')
    const beta = await h.character('角色乙')
    const first = await h.agent('role-a-first')
    const second = await h.agent('role-b')
    const shared = await h.agent('role-a-shared')
    await Promise.all([
      h.runtime.bind(first.value.id, alpha.id),
      h.runtime.bind(second.value.id, beta.id),
      h.runtime.bind(shared.value.id, alpha.id),
    ])
    first.begin(1)
    second.begin(1)
    await Promise.all([first.step(1), second.step(1)])
    await h.store.save({ id: alpha.id, expectedRevision: alpha.revision, fields: { ...EMPTY_CHARACTER_FIELDS, name: '角色甲新版' } })
    shared.begin(1)
    await shared.step(1)

    const session = first.value.session
    const beforeCompaction = h.store.getBinding(session.id)
    const original = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '需要被压缩的历史内容' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const compactionId = CompactionId('character-runtime-compaction')
    const summary = [{ type: 'text' as const, text: '压缩后的上下文摘要' }]
    session.append('compaction/start', { compactionId, turn: 1 })
    session.append('compaction/summary', {
      compactionId, summary, shadowedRange: { start: original.seq, end: original.seq },
      shadowedSeqs: [original.seq], shadowedTokenCount: 12, provider: 'fixture', model: 'manual-summary',
    })
    const replacement = session.append('user/message', createUserMessage({ content: summary, source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq],
    })
    session.append('compaction/end', { compactionId, turn: 1 })
    assert.deepEqual(session.surface.nodes, [replacement.seq])
    assert.deepEqual(h.store.getBinding(session.id), beforeCompaction)
    await Promise.all([first.step(1, 2), second.step(1, 2), shared.step(1, 2)])
    const [firstPrompt, secondPrompt, sharedPrompt] = await Promise.all([first.prompt(), second.prompt(), shared.prompt()])
    assert.match(firstPrompt, /人设名称：角色甲(?:\n|$)/)
    assert.doesNotMatch(firstPrompt, /角色乙|角色甲新版/)
    assert.match(secondPrompt, /人设名称：角色乙/)
    assert.doesNotMatch(secondPrompt, /角色甲/)
    assert.match(sharedPrompt, /人设名称：角色甲新版/)
    assert.doesNotMatch(sharedPrompt, /角色乙/)
    first.end(1)
    second.end(1)
    shared.end(1)
    first.begin(2)
    await first.step(2)
    assert.match(await first.prompt(), /角色甲新版/)
    first.end(2)
  } finally { await h.dispose() }
})

test('fork inherits durable binding without live parent; archived roles resume; subagents never inherit', async () => {
  const h = await harness()
  try {
    const c = await h.character()
    await h.store.bind('historical-parent', c.id)
    await h.store.lock('historical-parent')
    await h.store.archive(c.id, c.revision)
    await h.runtime.init()
    const fork = await h.agent('fork', { meta: { parentSession: SessionId('historical-parent') } })
    assert.deepEqual(h.store.getBinding('fork'), { sessionId: 'fork', characterId: c.id, locked: true })
    assert.match(await fork.prompt(), /星河/)
    await fork.dispose()
    const resumed = await h.agent('fork')
    assert.match(await resumed.prompt(), /星河/)
    const child = await h.agent('restored-child', { meta: { origin: 'subagent', parentSession: SessionId('historical-parent') } })
    assert.equal(h.store.getBinding(child.value.id), undefined)
    assert.match(await child.prompt(), /DEFAULT MODEL IDENTITY/)
  } finally { await h.dispose() }
})

test('complete sections and duplicate same-scope personas reject binding without replacing original contributions', async () => {
  const h = await harness()
  try {
    await h.runtime.init()
    const c = await h.character()
    const complete = await h.agent('complete', { setup(ctx) { ctx.systemPrompt.section({ name: 'custom:complete', order: 5, text: 'WHOLE PROMPT', complete: true }) } })
    await assert.rejects(h.runtime.bind(complete.value.id, c.id), /完整系统提示词/)
    assert.equal(await complete.prompt(), 'WHOLE PROMPT')
    assert.equal(h.store.getBinding(complete.value.id), undefined)
    const duplicate = await h.agent('duplicate', { setup(ctx) { ctx.systemPrompt.section({ name: PERSONA_PREFIX_SECTION, order: 0, text: 'OWNED BY OTHER' }) } })
    await assert.rejects(h.runtime.bind(duplicate.value.id, c.id), /其他插件占用/)
    assert.match(await duplicate.prompt(), /OWNED BY OTHER/)
    const generation = createScope(h.ctx, {})
    generation.ctx.systemPrompt.section({ name: PERSONA_PREFIX_SECTION, order: 0, text: 'COMPLETE PREFIX', complete: true })
    const scopedComplete = await h.agent('complete-prefix', { parentScope: (await import('@deepseek-ai/dsh-scope')).scopeOf(generation.ctx) })
    await assert.rejects(h.runtime.bind(scopedComplete.value.id, c.id), /完整系统提示词/)
    assert.equal(await scopedComplete.prompt(), 'COMPLETE PREFIX')
  } finally { await h.dispose() }
})

test('registry changes and dynamic assembly interference are rejected before a bound model step', async () => {
  const h = await harness()
  try {
    await h.runtime.init()
    const c = await h.character()
    const main = await h.agent('dynamic')
    let interfere = false
    h.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next()
      return interfere ? { ...assembly, sections: [{ name: 'custom:dynamic', text: 'REPLACEMENT' }] } : assembly
    })
    await h.runtime.bind(main.value.id, c.id)
    main.begin(1)
    await main.step(1)
    interfere = true
    await assert.rejects(main.step(1, 2), /完整系统提示词/)
    interfere = false
    await main.step(1, 2)
    const remove = h.ctx.systemPrompt.section({ name: 'new:complete', order: 5, text: '', complete: true })
    await assert.rejects(main.step(1, 3), /完整系统提示词/)
    remove()
    await main.step(1, 3)
    main.end(1)
  } finally { await h.dispose() }
})

test('failed persistence restores the old prefix; maintenance blocks a concurrent turn during binding', async () => {
  const h = await harness()
  try {
    await h.runtime.init()
    const c = await h.character()
    const main = await h.agent('disk')
    h.control.beforePut = async table => { if (table === 'bindings') throw new Error('disk failure') }
    await assert.rejects(h.runtime.bind(main.value.id, c.id), /存储/)
    assert.equal(h.store.getBinding(main.value.id), undefined)
    assert.match(await main.prompt(), /DEFAULT MODEL IDENTITY/)
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    h.control.beforePut = async table => { if (table === 'bindings') { entered(); await blocked } }
    const binding = h.runtime.bind(main.value.id, c.id)
    await started
    assert.throws(() => main.begin(1), /maintenance owns idle/)
    assert.equal(h.store.getBinding(main.value.id), undefined)
    release()
    await binding
    assert.match(await main.prompt(), /星河/)
  } finally { await h.dispose() }
})

test('turn lock persistence is awaited and a write failure prevents model-step admission', async () => {
  const h = await harness()
  try {
    await h.runtime.init()
    const c = await h.character()
    const main = await h.agent('lock-failure')
    await h.runtime.bind(main.value.id, c.id)
    h.control.beforePut = async table => { if (table === 'bindings') throw new Error('lock disk failure') }
    main.begin(1)
    await assert.rejects(main.step(1), /存储/)
    main.end(1)
    h.control.beforePut = undefined
    main.begin(2)
    await main.step(2)
    assert.equal(h.store.getBinding(main.value.id)?.locked, true)
    main.end(2)
  } finally { await h.dispose() }
})

test('hot enable defers running sessions to the next turn and isolates incompatible retained sessions', async () => {
  const h = await harness()
  try {
    const c = await h.character()
    await h.store.bind('running', c.id)
    await h.store.bind('bad-existing', c.id)
    const main = await h.agent('running')
    const bad = await h.agent('bad-existing', { setup(ctx) { ctx.systemPrompt.section({ name: 'bad:complete', order: 0, text: 'BAD', complete: true }) } })
    main.begin(1)
    await h.runtime.init()
    assert.match(h.runtime.bindingStatus(bad.value.id).reason, /完整系统提示词/)
    await main.step(1)
    assert.match(await main.prompt(), /DEFAULT MODEL IDENTITY/)
    main.end(1)
    main.begin(2)
    await main.step(2)
    assert.match(await main.prompt(), /星河/)
    main.end(2)
    bad.begin(1)
    await assert.rejects(bad.step(1), /完整系统提示词/)
    bad.end(1)
    const healthy = await h.agent('healthy')
    await h.runtime.bind(healthy.value.id, c.id)
    assert.match(await healthy.prompt(), /星河/)
  } finally { await h.dispose() }
})

test('new main sessions use the selected default; manual changes and future defaults stay independent', async () => {
  let selected: Character | undefined
  const h = await harness(async () => selected)
  try {
    await h.runtime.init()
    selected = await h.character('默认甲')
    const alpha = selected
    const beta = await h.character('默认乙')
    const first = await h.agent('default-first')
    const second = await h.agent('default-second')
    for (const main of [first, second]) {
      assert.deepEqual(h.store.getBinding(main.value.id), { sessionId: main.value.id, characterId: alpha.id, locked: false })
      assert.match(await main.prompt(), /默认甲/)
      assert.equal(h.runtime.bindingStatus(main.value.id).canBind, true)
    }
    await h.runtime.bind(first.value.id, beta.id)
    assert.match(await first.prompt(), /默认乙/)
    assert.match(await second.prompt(), /默认甲/)
    selected = beta
    const third = await h.agent('default-third')
    assert.match(await third.prompt(), /默认乙/)
    assert.equal(h.store.getBinding(second.value.id)?.characterId, alpha.id)
    selected = undefined
    const none = await h.agent('default-disabled')
    assert.equal(h.store.getBinding(none.value.id), undefined)
    assert.match(await none.prompt(), /DEFAULT MODEL IDENTITY/)
    second.begin(1)
    await second.step(1)
    second.end(1)
    await assert.rejects(h.runtime.bind(second.value.id, beta.id), /此会话已开始/)
  } finally { await h.dispose() }
})

test('defaults never backfill retained, resumed, cleared, compacted, seeded, or already started sessions', async () => {
  let selected: Character | undefined
  let selections = 0
  const resolveDefault = async () => { selections++; return selected }
  const h = await harness(resolveDefault)
  try {
    const oldBlank = await h.agent('default-retained-blank')
    const oldHistory = await h.agent('default-retained-history', { history: true })
    selected = await h.character('新默认')
    await h.runtime.init()
    for (const source of ['resume', 'clear', 'compact'] as const) {
      const restored = await h.agent(`default-${source}`, { source })
      assert.equal(h.store.getBinding(restored.value.id), undefined)
      assert.match(await restored.prompt(), /DEFAULT MODEL IDENTITY/)
    }
    const seeded = await h.agent('default-seeded', { meta: { isSeeded: true } })
    const started = await h.agent('default-started', { history: true })
    for (const main of [oldBlank, oldHistory, seeded, started]) {
      assert.equal(h.store.getBinding(main.value.id), undefined)
      assert.match(await main.prompt(), /DEFAULT MODEL IDENTITY/)
    }
    oldBlank.begin(1)
    await oldBlank.step(1)
    oldBlank.end(1)
    assert.equal(selections, 0)
    const bound = await h.agent('default-before-reload')
    assert.equal(selections, 1)
    await h.runtime.dispose()
    const reenabled = new CharacterRuntime(h.ctx, h.store, resolveDefault)
    try {
      await reenabled.init()
      assert.match(await bound.prompt(), /新默认/)
      assert.match(await oldBlank.prompt(), /DEFAULT MODEL IDENTITY/)
      assert.equal(selections, 1)
      await bound.dispose()
      const resumed = await h.agent('default-before-reload', { source: 'resume' })
      assert.match(await resumed.prompt(), /新默认/)
      assert.equal(selections, 1)
    } finally { await reenabled.dispose() }
  } finally { await h.dispose() }
})

test('defaults preserve existing and fork bindings while unbound forks and all child forms remain unbound', async () => {
  let selected: Character | undefined
  let selections = 0
  const h = await harness(async () => { selections++; return selected })
  try {
    selected = await h.character('默认身份')
    const inherited = await h.character('父角色')
    await h.store.bind('default-parent', inherited.id)
    await h.store.lock('default-parent')
    await h.store.bind('default-existing', inherited.id)
    await h.store.archive(inherited.id, inherited.revision)
    await h.runtime.init()
    const existing = await h.agent('default-existing')
    const fork = await h.agent('default-fork', { meta: { parentSession: SessionId('default-parent'), isSeeded: true } })
    assert.match(await existing.prompt(), /父角色/)
    assert.match(await fork.prompt(), /父角色/)
    assert.equal(h.store.getBinding(fork.value.id)?.locked, true)
    const unboundFork = await h.agent('default-unbound-fork', { meta: { parentSession: SessionId('unbound-parent') } })
    const originChild = await h.agent('default-origin-child', { meta: { origin: 'subagent' } })
    const depthChild = await h.agent('default-depth-child', { meta: { delegationDepth: 1 } })
    const ownedChild = await h.agent('default-owned-child', { owner: existing.value, meta: { origin: 'subagent', delegationDepth: 1, parentSession: existing.value.id } })
    for (const main of [unboundFork, originChild, depthChild, ownedChild]) {
      assert.equal(h.store.getBinding(main.value.id), undefined)
      assert.match(await main.prompt(), /DEFAULT MODEL IDENTITY/)
    }
    assert.equal(selections, 0)
  } finally { await h.dispose() }
})

test('a default is resolved once and durably committed before serial creation releases queued work', async () => {
  let selected: Character | undefined
  let selections = 0
  const h = await harness(async () => { selections++; return selected })
  try {
    selected = await h.character('创建时默认')
    const original = selected
    const next = await h.character('稍后默认')
    await h.runtime.init()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    h.control.beforePut = async table => { if (table === 'bindings') { entered(); await blocked } }
    let published = false
    const creation = h.agent('default-durable').then(value => { published = true; return value })
    await started
    selected = next
    assert.equal(published, false)
    assert.equal(h.store.getBinding('default-durable'), undefined)
    release()
    const main = await creation
    assert.equal(h.store.getBinding(main.value.id)?.characterId, original.id)
    assert.match(await main.prompt(), /创建时默认/)
    assert.equal(selections, 1)
    h.control.beforePut = undefined
    const later = await h.agent('default-later')
    assert.match(await later.prompt(), /稍后默认/)
  } finally { await h.dispose() }
})

test('failed default resolution, persistence, and prompt conflicts reject creation without silent model admission', async () => {
  let selected: Character | undefined
  let failResolution = false
  const h = await harness(async () => {
    if (failResolution) throw new Error('default preferences unavailable')
    return selected
  })
  try {
    selected = await h.character()
    await h.runtime.init()
    failResolution = true
    await assert.rejects(h.agent('default-read-error'), /default preferences unavailable/)
    failResolution = false
    h.control.beforePut = async table => { if (table === 'bindings') throw new Error('disk failed') }
    await assert.rejects(h.agent('default-write-error'), /存储/)
    h.control.beforePut = undefined
    await assert.rejects(h.agent('default-complete', { setup(ctx) {
      ctx.systemPrompt.section({ name: 'default:complete', order: 0, text: 'COMPLETE', complete: true })
    } }), /完整系统提示词/)
    await assert.rejects(h.agent('default-duplicate', { setup(ctx) {
      ctx.systemPrompt.section({ name: PERSONA_PREFIX_SECTION, order: 0, text: 'OTHER OWNER' })
    } }), /其他插件占用/)
    for (const id of ['default-read-error', 'default-write-error', 'default-complete', 'default-duplicate']) {
      assert.equal(h.store.getBinding(id), undefined)
      const agent = h.ctx.agents.get(SessionId(id))!
      let admitted = false
      await assert.rejects(agentEvents(h.ctx, agent).waterfall('agent/pre-step', {
        turn: 1, step: 1, messages: [], signal: new AbortController().signal,
      }, async () => { admitted = true; return { kind: 'enter', messages: [] } }))
      assert.equal(admitted, false)
      const prompt = renderPrompt(await h.ctx.systemPrompt.assemble(assembleContextFor(agent)))
      assert.doesNotMatch(prompt, /人设名称：星河/)
    }
    assert.match(await (await h.agent('default-after-error')).prompt(), /星河/)
  } finally { await h.dispose() }
})

test('archiving the default stops new bindings and an archive during slow validation fails safely', async () => {
  let selected: Character | undefined
  const h = await harness(async () => selected)
  try {
    selected = await h.character('待归档默认')
    const original = selected
    await h.runtime.init()
    const bound = await h.agent('default-archive-existing')
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    let held = false
    h.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (context.agent?.id === 'default-archive-race' && !held) {
        held = true
        entered()
        await blocked
      }
      return next()
    })
    const creation = h.agent('default-archive-race')
    const rejection = assert.rejects(creation, /归档/)
    await started
    selected = await h.store.archive(original.id, original.revision)
    release()
    await rejection
    assert.equal(h.store.getBinding('default-archive-race'), undefined)
    const later = await h.agent('default-after-archive')
    assert.equal(h.store.getBinding(later.value.id), undefined)
    assert.match(await later.prompt(), /DEFAULT MODEL IDENTITY/)
    assert.match(await bound.prompt(), /待归档默认/)
    await bound.dispose()
    assert.match(await (await h.agent('default-archive-existing', { source: 'resume' })).prompt(), /待归档默认/)
  } finally { await h.dispose() }
})

test('default initialization cancellation or plugin disposal cannot commit an unfinished binding', async () => {
  for (const mode of ['cancel', 'dispose'] as const) {
    let selected: Character | undefined
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    const h = await harness(async () => { entered(); await blocked; return selected })
    try {
      selected = await h.character()
      await h.runtime.init()
      const controller = new AbortController()
      const creation = h.agent(`default-${mode}`, { signal: controller.signal })
      const rejection = assert.rejects(creation, mode === 'cancel' ? /abort/i : /停用/)
      await started
      const disposal = mode === 'dispose' ? h.runtime.dispose() : undefined
      if (mode === 'cancel') controller.abort()
      release()
      await rejection
      await disposal
      assert.equal(h.store.getBinding(`default-${mode}`), undefined)
    } finally { await h.dispose() }
  }
})

test('default-bound sessions keep turn snapshots through edits, retries, and model changes', async () => {
  let selected: Character | undefined
  const h = await harness(async () => selected)
  try {
    selected = await h.character('默认版本一')
    await h.runtime.init()
    const main = await h.agent('default-turns')
    main.begin(1)
    selected = await h.store.save({
      id: selected.id, expectedRevision: selected.revision,
      fields: { ...EMPTY_CHARACTER_FIELDS, name: '默认版本二' },
    })
    await main.step(1)
    Object.assign(main.value.options, { model: 'different-model' })
    await main.step(1, 2)
    await main.step(1, 2)
    assert.match(await main.prompt(), /默认版本一/)
    assert.doesNotMatch(await main.prompt(), /默认版本二/)
    main.end(1)
    main.begin(2)
    await main.step(2)
    assert.match(await main.prompt(), /默认版本二/)
    main.end(2)
    assert.equal(h.store.getBinding(main.value.id)?.locked, true)
  } finally { await h.dispose() }
})


test('growth and base revisions freeze together across tools, retries and model switches', async () => {
  let growth = '\nGROWTH revision 1'
  const h = await harness(undefined, () => growth)
  try {
    await h.runtime.init()
    const character = await h.character()
    const main = await h.agent('growth-snapshot')
    await h.runtime.bind(main.value.id, character.id)
    main.begin(1); await main.step(1)
    assert.match(await main.prompt(), /GROWTH revision 1/)
    growth = '\nGROWTH revision 2'
    Object.assign(main.value.options, { provider: 'different-provider', model: 'different-model' })
    await main.step(1, 2); await main.step(1, 2)
    assert.match(await main.prompt(), /GROWTH revision 1/)
    assert.doesNotMatch(await main.prompt(), /GROWTH revision 2/)
    main.end(1); main.begin(2); await main.step(2)
    assert.match(await main.prompt(), /GROWTH revision 2/)
    growth = ''; main.end(2); main.begin(3); await main.step(3)
    assert.doesNotMatch(await main.prompt(), /GROWTH revision/)
    assert.match(await main.prompt(), /星河/)
  } finally { await h.dispose() }
})

test('turn state is read from the agents service, then the pre-0.2.2 registry, and never assumed', async () => {
  const h = await harness()
  const { agents, sessionProjections: projections } = h.ctx
  const seq = 7 as unknown as TurnBoundaryProjection['openTurnStartSeq']
  const boundary = (openTurnStartSeq: TurnBoundaryProjection['openTurnStartSeq'], lastTurn: number): TurnBoundaryProjection =>
    ({ openTurnStartSeq, lastStepStartSeq: null, lastStepBoundary: null, lastTurn })
  // Simulate a host without the 0.2.2 agents reader: shadow the inherited method
  // and serve the fold through the registry entry point the older hosts had.
  function useLegacyRegistry(state: TurnBoundaryProjection | undefined) {
    Object.defineProperty(agents, 'turnBoundaryOf', { configurable: true, value: undefined })
    Object.defineProperty(projections, 'stateOf', { configurable: true, value: () => state })
  }
  try {
    await h.runtime.init()
    const c = await h.character()
    assert.equal(typeof agents.turnBoundaryOf, 'function')
    const current = await h.agent('boundary-agents-service', { history: true })
    await assert.rejects(h.runtime.bind(current.value.id, c.id), /此会话已开始/)
    useLegacyRegistry(boundary(null, 0))
    const legacy = await h.agent('boundary-legacy-idle')
    assert.equal((await h.runtime.bind(legacy.value.id, c.id)).binding?.characterId, c.id)
    const started = await h.agent('boundary-legacy-started')
    useLegacyRegistry(boundary(null, 1))
    await assert.rejects(h.runtime.bind(started.value.id, c.id), /此会话已开始/)
    const open = await h.agent('boundary-legacy-open')
    useLegacyRegistry(boundary(seq, 0))
    await assert.rejects(h.runtime.bind(open.value.id, c.id), /此会话已开始/)
    const unreadable = await h.agent('boundary-legacy-unreadable')
    useLegacyRegistry(undefined)
    await assert.rejects(h.runtime.bind(unreadable.value.id, c.id), /无法读取会话轮次状态/)
  } finally {
    delete (agents as unknown as { turnBoundaryOf?: unknown }).turnBoundaryOf
    delete (projections as unknown as { stateOf?: unknown }).stateOf
    await h.dispose()
  }
})
