import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, assembleContextFor, type Agent, type SessionStartSource } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import Characters from '../lib/index.js'
import SourceCharacters from '../src/index.js'
import { TYPERT } from '../lib/typert.host.js'
import { EMPTY_CHARACTER_FIELDS } from '../src/shared/types.js'
import { BUILTIN_WHALE_GIRL_ID, BUILTIN_WHALE_GIRL_FIELDS } from '../src/host/builtins.js'

function imageDependencies(ctx: Context) {
  ctx.provide('attachments', { imageLimits: { maxImageBytes: 2 * 1024 * 1024, mediaTypes: ['image/png', 'image/jpeg', 'image/webp'] } } as never)
  ctx.provide('connection', { fetch: { register: () => async () => {} } } as never)
}

/** Harness 0.2.2-rc.1: AgentRegistry registers its own turnBoundary unit during init. */
function projectionDependencies(ctx: Context) {
  const state = { lastTurn: 0, openTurnStartSeq: null, lastStepStartSeq: null, lastStepBoundary: null }
  ctx.provide('sessionProjections', {
    stateOf: () => state,
    register: async () => ({ stateOf: () => state, dispose: async () => {} }),
  } as never)
}

test('built Host and generated RPC load, enforce schemas/resources, persist and unload cleanly', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-character-host-'))
  const ctx = new Context()
  imageDependencies(ctx)
  ctx.provide('agents', { list: () => [], roots: () => [], get: () => undefined } as never)
  ctx.provide('sessions', {} as never)
  ctx.provide('sessionProjections', {} as never)
  const storage = ctx.plugin(Storage); await storage
  const json = ctx.plugin(StorageJson, { root: directory }); await json
  const domain = ctx.plugin(StorageDomain, { backend: 'json' }); await domain
  const prompt = ctx.plugin(SystemPrompt, {}); await prompt
  const registry = ctx.plugin(TypertRegistry); await registry
  const unregister = ctx.typert.register(TYPERT)
  let fork = ctx.plugin(Characters); await fork
  t.after(async () => {
    await fork.dispose()
    unregister()
    await registry.dispose(); await prompt.dispose(); await domain.dispose(); await json.dispose(); await storage.dispose()
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep) && directory.includes('dsh-character-host-'))
    await rm(directory, { recursive: true, force: true })
  })
  const signal = new AbortController().signal
  const builtins = await ctx.characters.listCharacters(signal)
  assert.deepEqual(builtins, [{ ...BUILTIN_WHALE_GIRL_FIELDS, id: BUILTIN_WHALE_GIRL_ID, revision: 1, archived: false }])
  const visual = (await ctx.characters.listCharacterVisuals(signal))[0]!
  assert.equal(visual.source, 'builtin')
  assert.equal(visual.revision, 0)
  assert.deepEqual(await ctx.characters.getDefaultCharacter(signal), { characterId: null, revision: 0, character: null, unavailableReason: '' })
  for (const kind of ['shared-session', 'channel-user']) {
    const visitor = ctx.extend({ invocation: { peer: { principal: { kind } } } })
    await assert.rejects(visitor.characters.listCharacterVisuals(signal), /所有者/)
    await assert.rejects(visitor.characters.getGrowth(BUILTIN_WHALE_GIRL_ID, signal), /所有者/)
    await assert.rejects(visitor.characters.configureGrowth({ revision: 0, model: null }, signal), /所有者/)
    await assert.rejects(visitor.characters.changeGrowth({ characterId: BUILTIN_WHALE_GIRL_ID, expectedRevision: 0, action: 'enable' }, signal), /所有者/)
    await assert.rejects(visitor.characters.registerGrowthSession('session-one', signal), /所有者/)
    await assert.rejects(visitor.characters.resetCharacterAvatar(BUILTIN_WHALE_GIRL_ID, 0, signal), /所有者/)
    await assert.rejects(visitor.characters.getDefaultCharacter(signal), /所有者/)
    await assert.rejects(visitor.characters.setDefaultCharacter(BUILTIN_WHALE_GIRL_ID, 0, signal), /所有者/)
  }
  const saved = await ctx.characters.saveCharacter({ fields: { ...EMPTY_CHARACTER_FIELDS, name: '青禾', style: '简明、温和' } }, signal)
  assert.equal((await ctx.characters.getCharacter(saved.id, signal)).revision, 1)
  const defaultCharacter = await ctx.characters.setDefaultCharacter(saved.id, 0, signal)
  assert.equal(defaultCharacter.characterId, saved.id)
  await assert.rejects(ctx.characters.saveCharacter({ id: saved.id, expectedRevision: 0, fields: saved }, signal), /已被更新|格式无效/)
  const markers = remoteMethods(ctx.characters)
  assert.equal(markers.length, 14)
  for (const method of ['getBinding', 'bindCharacter']) {
    assert.equal(markers.find(marker => marker.method === method)!.resources!.session!('session-one', saved.id), 'session-one')
  }
  assert.equal(TYPERT.invocations.length, 14)
  for (const descriptor of TYPERT.invocations) assert.equal(descriptor.cancellation?.parameter, 'signal')
  const saveSchema = TYPERT.invocations.find(descriptor => descriptor.method === 'saveCharacter')!.parameters[0]!.strictCodec!.create()
  assert.equal(saveSchema.safeParse({ fields: { ...EMPTY_CHARACTER_FIELDS, name: '合法' } }).success, true)
  assert.equal(saveSchema.safeParse({ fields: EMPTY_CHARACTER_FIELDS, unexpected: true }).success, false)
  const defaultSchema = TYPERT.invocations.find(descriptor => descriptor.method === 'setDefaultCharacter')!.parameters[0]!.strictCodec!.create()
  assert.equal(defaultSchema.safeParse(null).success, true)
  assert.equal(defaultSchema.safeParse(saved.id).success, true)
  assert.equal(defaultSchema.safeParse({ characterId: saved.id }).success, false)
  assert.equal(defaultSchema.safeParse(1).success, false)
  const absent = await ctx.characters.getBinding('not-open', signal)
  assert.equal(absent.canBind, false)
  await assert.rejects(ctx.characters.bindCharacter('not-open', saved.id, signal), /尚未打开/)
  const editedBuiltin = await ctx.characters.saveCharacter({
    id: BUILTIN_WHALE_GIRL_ID,
    expectedRevision: 1,
    fields: { ...BUILTIN_WHALE_GIRL_FIELDS, name: '鲸鱼娘的用户自定义名称', style: '用户保留的表达习惯' },
  }, signal)
  const archivedBuiltin = await ctx.characters.archiveCharacter(editedBuiltin.id, editedBuiltin.revision, signal)
  await fork.dispose()
  assert.equal(ctx.get('characters'), undefined)
  fork = ctx.plugin(Characters); await fork
  const reopened = await ctx.characters.listCharacters(signal)
  assert.equal(reopened.length, 2)
  assert.deepEqual(reopened.find(character => character.id === saved.id), saved)
  assert.deepEqual(reopened.find(character => character.id === BUILTIN_WHALE_GIRL_ID), archivedBuiltin)
  assert.deepEqual(await ctx.characters.getDefaultCharacter(signal), defaultCharacter)
})

test('failed UI-only image storage does not block existing character operations or rewrite records', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-character-visual-host-'))
  const ctx = new Context()
  imageDependencies(ctx)
  ctx.provide('agents', { list: () => [], roots: () => [], get: () => undefined } as never)
  ctx.provide('sessions', {} as never)
  ctx.provide('sessionProjections', {} as never)
  const storage = ctx.plugin(Storage); await storage
  const json = ctx.plugin(StorageJson, { root: directory }); await json
  const domain = ctx.plugin(StorageDomain, { backend: 'json' }); await domain
  const prompt = ctx.plugin(SystemPrompt, {}); await prompt
  const registry = ctx.plugin(TypertRegistry); await registry
  const unregister = ctx.typert.register(TYPERT)
  await writeFile(join(directory, 'dsh_character_visuals.json'), 'invalid persisted image metadata')
  const fork = ctx.plugin(Characters); await fork
  t.after(async () => {
    await fork.dispose(); unregister(); await registry.dispose(); await prompt.dispose()
    await domain.dispose(); await json.dispose(); await storage.dispose()
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep) && directory.includes('dsh-character-visual-host-'))
    await rm(directory, { recursive: true, force: true })
  })
  const abort = new AbortController().signal
  await assert.rejects(ctx.characters.listCharacterVisuals(abort), /图片存储无法打开/)
  const saved = await ctx.characters.saveCharacter({ fields: { ...EMPTY_CHARACTER_FIELDS, name: '图片故障仍可管理人设' } }, abort)
  assert.deepEqual(await ctx.characters.getCharacter(saved.id, abort), saved)
  assert.equal((await ctx.characters.listCharacters(abort)).length, 2)
})

test('failed authoritative storage blocks main-agent steps, leaves subagents alone, and releases its gate on unload', async t => {
  const ctx = new Context()
  imageDependencies(ctx)
  const main = { id: 'main', session: { id: 'main', header: { origin: 'user' } } } as unknown as Agent
  const child = { id: 'child', session: { id: 'child', header: { origin: 'subagent', delegationDepth: 1 } } } as unknown as Agent
  ctx.provide('agents', { list: () => [main, child], roots: () => [main], get: () => undefined } as never)
  ctx.provide('sessions', {} as never)
  ctx.provide('sessionProjections', {} as never)
  ctx.provide('storageDomain', { open: async () => { throw new Error('authoritative storage is corrupt') } } as never)
  const prompt = ctx.plugin(SystemPrompt, {}); await prompt
  const registry = ctx.plugin(TypertRegistry); await registry
  const unregister = ctx.typert.register(TYPERT)
  const plugin = ctx.plugin(Characters); await plugin
  t.after(async () => {
    await plugin.dispose(); unregister(); await registry.dispose(); await prompt.dispose()
  })
  const signal = new AbortController().signal
  let entered = 0
  const next = async () => { entered++; return { kind: 'enter' as const, messages: [] } }
  const step = (agent: Agent) => agentEvents(ctx, agent).waterfall('agent/pre-step', { messages: [], turn: 1, step: 1, signal }, next)
  await assert.rejects(step(main), /人设存储无法打开/u)
  assert.equal(entered, 0)
  assert.equal((await step(child)).kind, 'enter')
  assert.equal(entered, 1)
  await assert.rejects(ctx.characters.listCharacters(signal), /人设存储无法打开/u)
  await plugin.dispose()
  assert.equal((await step(main)).kind, 'enter')
  assert.equal(entered, 2)
})

test('synchronous avatar route registration failure and faulty disposers release domains for re-enable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-character-registration-test-'))
  const ctx = new Context()
  const activeRoutes = new Set<string>()
  let registration = 0
  let failRegistration = true
  let failDisposal = false
  ctx.provide('agents', { list: () => [], roots: () => [], get: () => undefined } as never)
  ctx.provide('sessions', {} as never)
  ctx.provide('sessionProjections', {} as never)
  ctx.provide('attachments', { imageLimits: { maxImageBytes: 2 * 1024 * 1024, mediaTypes: ['image/jpeg'] } } as never)
  ctx.provide('connection', { fetch: { register: (route: { path: string }) => {
    if (failRegistration && ++registration === 2) throw new Error('duplicate upload route')
    activeRoutes.add(route.path)
    return async () => {
      activeRoutes.delete(route.path)
      if (failDisposal && route.path.endsWith('/avatar')) throw new Error('route disposer failed')
    }
  } } } as never)
  const storage = ctx.plugin(Storage); await storage
  const json = ctx.plugin(StorageJson, { root: directory }); await json
  const domain = ctx.plugin(StorageDomain, { backend: 'json' }); await domain
  const prompt = ctx.plugin(SystemPrompt, {}); await prompt
  const registry = ctx.plugin(TypertRegistry); await registry
  t.after(async () => {
    await registry.dispose(); await prompt.dispose(); await domain.dispose(); await json.dispose(); await storage.dispose()
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep) && directory.includes('dsh-character-registration-test-'))
    await rm(directory, { recursive: true, force: true })
  })
  const failed = ctx.plugin(SourceCharacters)
  await assert.rejects(async () => { await failed }, /duplicate upload route/)
  await failed.dispose()
  assert.equal(ctx.storageDomain.get('dsh_character'), undefined)
  assert.equal(ctx.storageDomain.get('dsh_character_visuals'), undefined)
  assert.equal(ctx.storageDomain.get('dsh_character_preferences'), undefined)
  assert.equal(activeRoutes.size, 0)
  failRegistration = false
  const reenabled = ctx.plugin(SourceCharacters); await reenabled
  assert.equal((await ctx.characters.listCharacters(new AbortController().signal)).length, 1)
  assert.equal((await ctx.characters.listCharacterVisuals(new AbortController().signal))[0]!.source, 'builtin')
  assert.equal((await ctx.characters.getDefaultCharacter(new AbortController().signal)).characterId, null)
  failDisposal = true
  await reenabled.dispose()
  assert.equal(activeRoutes.size, 0)
  assert.equal(ctx.storageDomain.get('dsh_character'), undefined)
  assert.equal(ctx.storageDomain.get('dsh_character_visuals'), undefined)
  assert.equal(ctx.storageDomain.get('dsh_character_preferences'), undefined)
  failDisposal = false
  const final = ctx.plugin(SourceCharacters); await final
  assert.equal((await ctx.characters.listCharacters(new AbortController().signal)).length, 1)
  await final.dispose()
})

test('default preference storage failure is explicit while ordinary character management stays available', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-character-default-host-'))
  const ctx = new Context()
  imageDependencies(ctx)
  ctx.provide('agents', { list: () => [], roots: () => [], get: () => undefined } as never)
  ctx.provide('sessions', {} as never)
  ctx.provide('sessionProjections', {} as never)
  const storage = ctx.plugin(Storage); await storage
  const json = ctx.plugin(StorageJson, { root: directory }); await json
  const domain = ctx.plugin(StorageDomain, { backend: 'json' }); await domain
  const prompt = ctx.plugin(SystemPrompt, {}); await prompt
  const registry = ctx.plugin(TypertRegistry); await registry
  await writeFile(join(directory, 'dsh_character_preferences.json'), 'corrupt preference metadata')
  const fork = ctx.plugin(SourceCharacters); await fork
  t.after(async () => {
    await fork.dispose(); await registry.dispose(); await prompt.dispose(); await domain.dispose(); await json.dispose(); await storage.dispose()
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep) && directory.includes('dsh-character-default-host-'))
    await rm(directory, { recursive: true, force: true })
  })
  const signal = new AbortController().signal
  await assert.rejects(ctx.characters.getDefaultCharacter(signal), /默认角色设置无法读取/)
  await assert.rejects(ctx.characters.setDefaultCharacter(null, 0, signal), /默认角色设置无法读取/)
  const saved = await ctx.characters.saveCharacter({ fields: { ...EMPTY_CHARACTER_FIELDS, name: '偏好故障仍保留角色管理' } }, signal)
  assert.equal((await ctx.characters.getCharacter(saved.id, signal)).name, saved.name)
  for (const kind of ['shared-session', 'channel-user']) {
    const visitor = ctx.extend({ invocation: { peer: { principal: { kind } } } })
    await assert.rejects(visitor.characters.getDefaultCharacter(signal), /所有者/)
    await assert.rejects(visitor.characters.setDefaultCharacter(null, 0, signal), /所有者/)
  }
})

test('startup announced during Host initialization can await default preferences without a readiness cycle', { timeout: 5_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-character-default-race-'))
  const ctx = new Context()
  imageDependencies(ctx)
  projectionDependencies(ctx)
  const storage = ctx.plugin(Storage); await storage
  const json = ctx.plugin(StorageJson, { root: directory }); await json
  const domain = ctx.plugin(StorageDomain, { backend: 'json' }); await domain
  const prompt = ctx.plugin(SystemPrompt, {}); await prompt
  const sessions = ctx.plugin(SessionStore); await sessions
  const agents = ctx.plugin(AgentRegistry); await agents
  const registry = ctx.plugin(TypertRegistry); await registry
  let scopeOwner!: Context
  const consumer = ctx.plugin(Object.assign((injected: Context) => { scopeOwner = injected }, {
    inject: ['agents', 'sessions', 'systemPrompt', 'sessionProjections'],
  })); await consumer
  await writeFile(join(directory, 'dsh_character_preferences.json'), JSON.stringify({
    unit: { name: 'dsh_character_preferences', version: 1 }, global: null,
    tables: { settings: { default: { characterId: BUILTIN_WHALE_GIRL_ID, revision: 1 } } },
  }))
  const agent = {} as Agent
  const scope = createScope(scopeOwner, agent)
  const session = scope.ctx.sessions.create(SessionId('during-host-startup'))
  Object.assign(agent, {
    id: session.id, ctx: scope.ctx, session, status: 'idle',
    options: { provider: 'test-provider', model: 'test-model' }, inbox: { nextTurn: [], nextStep: [] },
    runMaintenance: async (action: (signal: AbortSignal) => Promise<unknown>) => action(new AbortController().signal),
  })
  const originalList = ctx.agents.list.bind(ctx.agents)
  let announced: Promise<void> | undefined
  let detach: (() => void) | undefined
  t.mock.method(ctx.agents, 'list', () => {
    if (!announced) {
      detach = scope.ctx.agents.enter(agent)
      announced = scope.ctx.agents.announce(agent, 'startup')
    }
    return originalList()
  })
  const fork = ctx.plugin(SourceCharacters); await fork
  t.after(async () => {
    await fork.dispose(); detach?.(); await scope.dispose(); await consumer.dispose(); await registry.dispose(); await agents.dispose(); await sessions.dispose()
    await prompt.dispose(); await domain.dispose(); await json.dispose(); await storage.dispose()
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep) && directory.includes('dsh-character-default-race-'))
    await rm(directory, { recursive: true, force: true })
  })
  const signal = new AbortController().signal
  const status = await ctx.characters.getDefaultCharacter(signal)
  await announced
  assert.equal(status.characterId, BUILTIN_WHALE_GIRL_ID)
  const bound = await ctx.characters.getBinding(session.id, signal)
  assert.equal(bound.binding?.characterId, BUILTIN_WHALE_GIRL_ID)
  assert.equal(bound.binding?.locked, false)
})

test('creation before storage opens retains its source without backfilling old blanks or hiding preference failures', { timeout: 10_000 }, async t => {
  for (const corruptPreferences of [false, true]) await t.test(corruptPreferences ? 'failed preferences' : 'stored default', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-character-early-create-'))
    const ctx = new Context()
    imageDependencies(ctx)
    projectionDependencies(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: directory })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(SystemPrompt, { personaPrefix: 'DEFAULT MODEL IDENTITY' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TypertRegistry)
    let owner!: Context
    await ctx.plugin(Object.assign((injected: Context) => { owner = injected }, {
      inject: ['agents', 'sessions', 'systemPrompt', 'sessionProjections'],
    }))
    await writeFile(join(directory, 'dsh_character_preferences.json'), corruptPreferences ? 'invalid preferences' : JSON.stringify({
      unit: { name: 'dsh_character_preferences', version: 1 }, global: null,
      tables: { settings: { default: { characterId: BUILTIN_WHALE_GIRL_ID, revision: 1 } } },
    }))
    const scopes: (() => Promise<void>)[] = []
    async function create(id: string, source: SessionStartSource = 'startup', child = false): Promise<Agent> {
      const agent = {} as Agent
      const scope = createScope(owner, agent)
      const session = scope.ctx.sessions.create(SessionId(id), { meta: child ? { origin: 'subagent' } : undefined })
      Object.assign(agent, {
        id: session.id, ctx: scope.ctx, session, status: 'idle', options: {}, inbox: { nextTurn: [], nextStep: [] },
      })
      const detach = scope.ctx.agents.enter(agent)
      scopes.push(async () => { detach(); await scope.dispose() })
      try { await scope.ctx.agents.announce(agent, source) }
      catch (error) { detach(); throw error }
      return agent
    }
    const oldBlank = await create('blank-before-plugin-enable')
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const opening = new Promise<void>(resolve => { entered = resolve })
    const originalOpen = ctx.storageDomain.open.bind(ctx.storageDomain)
    t.mock.method(ctx.storageDomain, 'open', async definition => {
      if (definition.name === 'dsh_character') { entered(); await blocked }
      return originalOpen(definition)
    })
    const plugin = ctx.plugin(SourceCharacters); await plugin
    t.after(async () => {
      release()
      await plugin.dispose()
      for (const dispose of scopes.reverse()) await dispose()
      await ctx.fiber.dispose()
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep) && directory.includes('dsh-character-early-create-'))
      await rm(directory, { recursive: true, force: true })
    })
    await opening
    let completed = false
    const creation = create('startup-before-storage-open').then(agent => { completed = true; return agent })
    const resumed = create('resume-before-storage-open', 'resume')
    const rejected = corruptPreferences ? assert.rejects(creation, /默认角色设置无法读取/) : undefined
    await create('child-before-storage-open', 'startup', true)
    assert.equal(completed, false)
    release()
    await resumed
    const signal = new AbortController().signal
    for (const id of [oldBlank.id, 'resume-before-storage-open']) {
      assert.equal((await ctx.characters.getBinding(id, signal)).binding, null)
    }
    if (corruptPreferences) {
      await rejected
      assert.equal(ctx.agents.get(SessionId('startup-before-storage-open')), undefined)
      assert.equal((await ctx.characters.getBinding('startup-before-storage-open', signal)).binding, null)
      assert.equal((await ctx.characters.listCharacters(signal)).length, 1)
      await assert.rejects(ctx.characters.getDefaultCharacter(signal), /默认角色设置无法读取/)
    } else {
      const fresh = await creation
      assert.equal((await ctx.characters.getBinding(fresh.id, signal)).binding?.characterId, BUILTIN_WHALE_GIRL_ID)
      await agentEvents(ctx, fresh).waterfall('agent/pre-step', {
        turn: 1, step: 1, messages: [], signal,
      }, async () => ({ kind: 'enter', messages: [] }))
      const prompt = renderPrompt(await ctx.systemPrompt.assemble(assembleContextFor(fresh)))
      assert.match(prompt, /鲸鱼娘/)
      assert.doesNotMatch(prompt, /DEFAULT MODEL IDENTITY/)
    }
  })
})
