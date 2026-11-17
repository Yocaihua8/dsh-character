import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rename, rm, rmdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { CharacterStore } from '../src/host/store.js'
import { GrowthStore, recordGrowth } from '../src/host/growth-store.js'
import { GrowthRuntime, growthBatch, isOwnerMessage } from '../src/host/growth-runtime.js'
import { evidenceText, learnGrowth, parseGrowthCandidates, verifiedGrowth } from '../src/host/growth-model.js'
import { EMPTY_CHARACTER_FIELDS } from '../src/shared/types.js'
import type { GrowthEntry, GrowthRound } from '../src/shared/growth.js'

const model = { provider: 'fixed-provider', model: 'fixed-model', reasoningEffort: 'low' }
const round = (n = 1, user = '以后你叫我船长，少拿项目进度开玩笑。'): GrowthRound => ({ id: `chat:${n}`, sessionId: 'chat', seq: n, time: Date.now(), user, assistant: '好的，船长。' })
const entry = (n = 1): GrowthEntry => ({ id: 'address', kind: 'interaction', content: '称呼用户为船长；讨论项目进度时收敛打趣。', reason: '本人长期纠正', manual: false,
  sources: [{ roundId: `chat:${n}`, sessionId: 'chat', seq: n, quote: round(n).user }] })
const candidate = (value = entry(), basis = 'explicit') => { const { manual: _, ...rest } = value; return { ...rest, basis } }
const verdict = (id = 'address', overrides = {}) => JSON.stringify({ decisions: [{ id, supported: true, durable: true, unquotedOwnerEvidence: true,
  preservesCore: true, characterSpecific: true, respectsManual: true, noInventedExperience: true, reason: '通过', ...overrides }] })
async function setup(t: TestContext, llm?: unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-character-growth-test-'))
  const ctx = new Context()
  const storage = ctx.plugin(Storage); await storage
  const json = ctx.plugin(StorageJson, { root: directory }); await json
  const domain = ctx.plugin(StorageDomain, { backend: 'json' }); await domain
  const characters = await CharacterStore.open(ctx)
  const character = await characters.save({ fields: { ...EMPTY_CHARACTER_FIELDS, name: '鲸鱼娘', identity: '鲸鱼精灵', boundaries: '不编造现实经历' } })
  let growth = await GrowthStore.open(ctx)
  const runtimes: GrowthRuntime[] = []
  ctx.provide('llm', (llm ?? {
    listProviders: () => [{ id: model.provider, name: '测试固定路由' }],
    listModels: async () => [{ id: model.model, name: '固定整理模型' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }),
  }) as never)
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close()
    await growth.close(); await characters.close(); await domain.dispose(); await json.dispose(); await storage.dispose()
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep) && directory.includes('dsh-character-growth-test-'))
    await rm(directory, { recursive: true, force: true })
  })
  const enable = async () => { await growth.setConfig({ revision: 0, model }); return growth.change(character, { characterId: character.id, expectedRevision: 0, action: 'enable' }, 0) }
  return { ctx, directory, characters, character, growth, enable,
    reopen: async () => { await growth.close(); growth = await GrowthStore.open(ctx); return growth },
    runtime: (request: Parameters<typeof learnGrowth>[0]) => { const runtime = new GrowthRuntime(ctx, growth, characters, request); runtimes.push(runtime); return runtime },
  }
}

test('growth is off by default, isolated from original domain, survives restart and uses CAS', async t => {
  const h = await setup(t)
  const before = await readFile(join(h.directory, 'dsh_character.json'), 'utf8')
  assert.equal(h.growth.get(h.character).enabled, false)
  await h.enable()
  const results = await Promise.allSettled(['pause', 'disable'].map(action => h.growth.change(h.character, { characterId: h.character.id, expectedRevision: 1, action: action as 'pause' }, Date.now())))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const reopened = await h.reopen()
  assert.equal(reopened.get(h.character).learning, false)
  assert.equal(reopened.settings().model?.model, model.model)
  assert.equal(await readFile(join(h.directory, 'dsh_character.json'), 'utf8'), before)
  const other = await h.characters.save({ fields: { ...EMPTY_CHARACTER_FIELDS, name: '另一个角色' } })
  assert.equal(reopened.get(other).enabled, false)
})

test('atomic persistence failure leaves growth entries, revisions and evidence intact', async t => {
  const h = await setup(t); await h.enable()
  const file = join(h.directory, 'dsh_character_growth.json')
  const original = h.growth.get(h.character)
  await rename(file, file + '.saved'); await mkdir(file)
  try {
    await assert.rejects(h.growth.change(h.character, { characterId: h.character.id, expectedRevision: original.revision, action: 'disable' }, Date.now()), /保存失败/)
    assert.deepEqual(h.growth.get(h.character), original)
  } finally { await rmdir(file); await rename(file + '.saved', file) }
  assert.equal((await h.growth.change(h.character, { characterId: h.character.id, expectedRevision: original.revision, action: 'disable' }, Date.now())).enabled, false)
})

test('deduplicates source progress; withdrawal and clear bar old evidence without erasing base data', async t => {
  const h = await setup(t); const enabled = await h.enable()
  await h.growth.enqueue(h.character, round(), enabled.epoch)
  await h.growth.enqueue(h.character, round(), enabled.epoch)
  assert.equal(h.growth.get(h.character).pending, 1)
  let state = await h.growth.update(h.character, state => { state.entries = [entry()]; recordGrowth(state, [], '已核验', Date.now()) })
  state = await h.growth.change(h.character, { characterId: h.character.id, expectedRevision: state.revision, action: 'correct', entryId: 'address', content: '以后称呼我小船长' }, Date.now())
  assert.equal(state.entries[0]?.manual, true)
  assert.deepEqual(state.entries[0]?.sources, [], 'manual replacement must not cite contradictory old chat text')
  assert.equal(parseGrowthCandidates(JSON.stringify({ candidates: [candidate()] }), [round()], state).length, 0)
  state = await h.growth.change(h.character, { characterId: h.character.id, expectedRevision: state.revision, action: 'withdraw', entryId: 'address' }, Date.now())
  assert.equal(parseGrowthCandidates(JSON.stringify({ candidates: [candidate()] }), [round()], state).length, 0)
  const oldRevision = state.revision
  await h.growth.enqueue(h.character, round(), state.epoch)
  assert.equal(h.growth.get(h.character).revision, oldRevision)
  state = await h.growth.change(h.character, { characterId: h.character.id, expectedRevision: state.revision, action: 'restore', version: state.history[0]!.revision }, Date.now())
  assert.equal(state.baseRevision, 0, 'restoring old versions requires checking the current base')
  assert.equal(h.characters.get(h.character.id).revision, 1)
  state = await h.growth.change(h.character, { characterId: h.character.id, expectedRevision: state.revision, action: 'clear' }, Date.now())
  assert.deepEqual(state.entries, []); assert.deepEqual(state.rounds, [])
  assert.equal(state.history.length, 1); assert.deepEqual(state.history[0]!.before, [])
  assert.equal(state.barriers.chat, 1)
})

test('candidate evidence requires exact owner quotes and three distinct rounds for inference', async t => {
  const h = await setup(t); const state = h.growth.get(h.character)
  const parse = (values: unknown[], rounds = [round()]) => parseGrowthCandidates(JSON.stringify({ candidates: values }), rounds, state)
  assert.equal(parse([candidate()]).length, 1)
  assert.equal(parse([candidate(entry(), 'repeated')]).length, 0)
  const repeated = { ...entry(), sources: [1, 2, 3].map(n => entry(n).sources[0]!) }
  assert.equal(parse([candidate(repeated, 'repeated')], [round(1), round(2), round(3)]).length, 1)
  assert.equal(parse([candidate({ ...entry(), sources: Array(3).fill(entry().sources[0]) }, 'repeated')]).length, 0)
  for (const user of ['> ' + round().user, '```text\n' + round().user + '\n```', '他说：“' + round().user + '”']) assert.equal(parse([candidate()], [round(1, user)]).length, 0)
  assert.equal(parse([candidate()], [round(1, '这次先回答问题')]).length, 0)
  assert.equal(parse([candidate({ ...entry(), sources: [{ ...entry().sources[0]!, quote: '助手说用户喜欢被叫船长' }] })]).length, 0)
  assert.equal(isOwnerMessage({ kind: 'user' }), true)
  for (const source of [{ kind: 'user', principal: {} }, { kind: 'context' }, { kind: 'goal' }]) assert.equal(isOwnerMessage(source), false)
  assert.equal(evidenceText('本人原话\n> 引用'), '本人原话\n')
})

test('independent verification rejects temporary, negative, invented or common-preference candidates', () => {
  for (const key of ['durable', 'supported', 'unquotedOwnerEvidence', 'preservesCore', 'characterSpecific', 'respectsManual', 'noInventedExperience']) {
    assert.deepEqual(verifiedGrowth(verdict('address', { [key]: false }), [entry()]), [])
  }
  assert.equal(verifiedGrowth(verdict(), [entry()]).length, 1)
  assert.throws(() => verifiedGrowth(verdict('unknown'), [entry()]))
})

test('extract and verify share deadline, fixed model and at most two tool-free request stages', async t => {
  const h = await setup(t); const state = h.growth.get(h.character); state.rounds = [round()]
  const calls: { signal: AbortSignal; selection: unknown; prompt: string }[] = []
  const result = await learnGrowth(async (prompt, selection, signal) => {
    calls.push({ signal, selection, prompt })
    return calls.length === 1 ? JSON.stringify({ candidates: [candidate()] }) : verdict()
  }, h.character, state, model, new AbortController().signal)
  assert.equal(calls.length, 2); assert.equal(calls[0]!.signal, calls[1]!.signal)
  assert.deepEqual(calls[0]!.selection, model); assert.equal(result.length, 1)
  assert.match(calls[1]!.prompt, /独立核验/)
  const controller = new AbortController()
  const pending = learnGrowth(async () => new Promise(() => {}), h.character, state, model, controller.signal)
  controller.abort(new Error('timeout fixture'))
  await assert.rejects(pending, /timeout fixture/)
})

test('late completion after disable or model changes is discarded; paused growth still applies', async t => {
  const h = await setup(t); const enabled = await h.enable()
  await h.growth.enqueue(h.character, round(), enabled.epoch)
  let release!: (value: string) => void
  const gate = new Promise<string>(resolve => { release = resolve })
  const runtime = h.runtime(async prompt => prompt.includes('独立核验') ? verdict() : gate)
  const processing = runtime.process(h.character.id)
  await new Promise(resolve => setImmediate(resolve))
  const current = h.growth.get(h.character)
  await runtime.change({ characterId: h.character.id, expectedRevision: current.revision, action: 'disable' })
  release(JSON.stringify({ candidates: [candidate()] })); await processing
  assert.equal(h.growth.get(h.character).entries.length, 0)
  await h.growth.update(h.character, state => { state.enabled = true; state.learning = false; state.entries = [entry()] })
  assert.match(runtime.snapshot(h.character)!.text, /船长/)
  const changed = await h.characters.save({ id: h.character.id, expectedRevision: h.character.revision, fields: { ...EMPTY_CHARACTER_FIELDS, name: h.character.name, personality: '新底色' } })
  assert.equal(runtime.snapshot(changed), undefined)
})

test('successful learning commits atomically and manual protection survives subsequent batches', async t => {
  const h = await setup(t); const enabled = await h.enable()
  await h.growth.enqueue(h.character, round(), enabled.epoch)
  const runtime = h.runtime(async prompt => prompt.includes('独立核验') ? verdict() : JSON.stringify({ candidates: [candidate()] }))
  await runtime.process(h.character.id)
  let state = h.growth.get(h.character)
  assert.equal(state.pending, 0); assert.equal(state.entries.length, 1); assert.equal(state.history.length, 1)
  assert.match(runtime.isolationMessage(), /兼容模式/)
  state = await runtime.change({ characterId: h.character.id, expectedRevision: state.revision, action: 'correct', entryId: 'address', content: '只叫我小船长' })
  await h.growth.enqueue(h.character, round(2), state.epoch)
  await runtime.process(h.character.id)
  assert.equal(h.growth.get(h.character).entries[0]?.content, '只叫我小船长')
  assert.equal(h.growth.get(h.character).entries[0]?.manual, true)
})

test('live completed owner turns ignore runtime context, exclude children, and never backfill inherited events', async t => {
  const h = await setup(t); await h.enable()
  await h.ctx.plugin(SessionStore)
  const session = h.ctx.sessions.create(SessionId('live'))
  const agent = { id: session.id, session }
  const agents = new Map([[String(session.id), agent]])
  h.ctx.provide('agents', { get: (id: string) => agents.get(id), roots: () => [...agents.values()] } as never)
  await h.characters.bind(session.id, h.character.id)
  const runtime = h.runtime(async () => JSON.stringify({ candidates: [] }))
  assert.equal(runtime.register(session.id), true)
  session.append('turn/start', { turn: 1 })
  const original = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '这一次请陪我聊聊天。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '宿主目录时间，不得作为证据' }], source: { kind: 'runtime-context', form: 'snapshot', sections: [] } as never }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '压缩摘要自称用户认可，不能视为本人新证据' }], source: { kind: 'user' } }), { surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq] })
  session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: '好的。' }], source: { kind: 'model', provider: 'chat-provider', model: 'chat-model' } }), stream: [] }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await h.growth.update(h.character, () => false)
  assert.equal(h.growth.get(h.character).pending, 1)
  const child = h.ctx.sessions.create(SessionId('child'), { meta: { origin: 'subagent', delegationDepth: 1, parentSession: session.id } })
  agents.set(child.id, { id: child.id, session: child })
  assert.equal(runtime.register(child.id), false)
  const seed = [...session.snapshotEvents()]
  const fork = h.ctx.sessions.create(SessionId('fork'), { meta: { parentSession: session.id, isSeeded: true }, seed, inheritedEventCount: SessionLogOffset(seed.length) })
  agents.set(fork.id, { id: fork.id, session: fork })
  await h.characters.inherit(fork.id, session.id)
  assert.equal(runtime.register(fork.id), true)
  assert.equal(h.growth.get(h.character).pending, 1, 'fork registration never collects its inherited prefix')
  assert.equal(h.growth.get(h.character).rounds[0]?.user, '这一次请陪我聊聊天。')
  session.append('turn/start', { turn: 2 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '外部来访者' }], source: { kind: 'user', principal: { kind: 'shared-session' } } as never }), { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 2, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: '好的。' }], source: { kind: 'model', provider: 'other-provider', model: 'other-model' } }), stream: [] }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  await h.growth.update(h.character, () => false)
  assert.equal(h.growth.get(h.character).pending, 1)
  await runtime.close()
  const reopened = await GrowthStore.open(h.ctx)
  const resumed = new GrowthRuntime(h.ctx, reopened, h.characters, async () => JSON.stringify({ candidates: [] }))
  assert.equal(resumed.register(session.id), true)
  assert.equal(reopened.get(h.character).pending, 1, 'registration does not replay old events')
  await resumed.close()
})

test('batch size bounds preserve whole rounds and include prior evidence without losing pending order', async t => {
  const h = await setup(t); const state = h.growth.get(h.character)
  state.rounds = Array.from({ length: 20 }, (_, i) => round(i + 1))
  state.pending = 10
  const batch = growthBatch(state)
  assert.equal(batch.pending, 5)
  assert.deepEqual(batch.rounds.slice(0, 5).map(item => item.seq), [11, 12, 13, 14, 15])
  assert.ok(batch.rounds.length <= 12)
  assert.equal(state.rounds.length, 20)
})

test('idle timer persists its due time across restart and triggers only after ten minutes', async t => {
  const h = await setup(t); const enabled = await h.enable()
  await h.growth.enqueue(h.character, round(1, '本次闲聊很轻松'), enabled.epoch)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const runtime = h.runtime(async () => { calls++; return JSON.stringify({ candidates: [] }) })
  t.mock.timers.tick(599_000)
  await Promise.resolve(); assert.equal(calls, 0)
  t.mock.timers.tick(1000)
  await new Promise(resolve => setImmediate(resolve))
  await runtime.process(h.character.id)
  assert.equal(calls, 1)
  assert.equal(h.growth.get(h.character).pending, 0)
})

test('model changes reject in-flight output while concurrent roles use separate state', async t => {
  const h = await setup(t); const enabled = await h.enable()
  await h.growth.enqueue(h.character, round(), enabled.epoch)
  let release!: (value: string) => void
  const gate = new Promise<string>(resolve => { release = resolve })
  const runtime = h.runtime(async prompt => prompt.includes('独立核验') ? verdict() : gate)
  const job = runtime.process(h.character.id)
  await new Promise(resolve => setImmediate(resolve))
  await runtime.configure({ revision: h.growth.settings().revision, model: null }, new AbortController().signal)
  release(JSON.stringify({ candidates: [candidate()] })); await job
  assert.equal(h.growth.get(h.character).entries.length, 0)
  assert.equal(h.growth.get(h.character).pending, 1)
  const other = await h.characters.save({ fields: { ...EMPTY_CHARACTER_FIELDS, name: '其他角色' } })
  assert.equal(runtime.snapshot(other), undefined)
})

test('five queued turns trigger one batch and concurrent requests cannot commit twice', async t => {
  const h = await setup(t); const enabled = await h.enable()
  for (let n = 1; n <= 5; n++) await h.growth.enqueue(h.character, round(n, '普通闲聊'), enabled.epoch)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const runtime = h.runtime(async () => { calls++; return JSON.stringify({ candidates: [] }) })
  t.mock.timers.tick(0)
  await Promise.all([runtime.process(h.character.id), runtime.process(h.character.id)])
  assert.equal(calls, 1); assert.equal(h.growth.get(h.character).pending, 0)
})

test('a changed base suppresses old growth until independent revalidation commits', async t => {
  const h = await setup(t); await h.enable()
  await h.growth.update(h.character, state => { state.entries = [entry()]; recordGrowth(state, [], '已核验', Date.now()) })
  let calls = 0
  const runtime = h.runtime(async () => { calls++; return verdict() })
  const before = runtime.snapshot(h.character)!.text
  await h.growth.update(h.character, state => { state.status = '证据队列变化' })
  assert.equal(runtime.snapshot(h.character)!.text, before, 'queue revisions must not alter effective prompt revisions')
  const changed = await h.characters.save({ id: h.character.id, expectedRevision: 1, fields: { ...EMPTY_CHARACTER_FIELDS, name: h.character.name, personality: '更安静' } })
  assert.equal(runtime.snapshot(changed), undefined)
  await runtime.process(changed.id)
  assert.equal(calls, 1)
  assert.match(runtime.snapshot(changed)!.text, /基本人设修订 2/)
})

test('failed model requests retain evidence and cannot persist provider secrets', async t => {
  const h = await setup(t); const enabled = await h.enable()
  await h.growth.enqueue(h.character, round(), enabled.epoch)
  const runtime = h.runtime(async () => { throw new Error('private-provider-token-must-not-leak') })
  await runtime.process(h.character.id)
  const state = h.growth.get(h.character)
  assert.equal(state.pending, 1); assert.equal(state.entries.length, 0)
  assert.match(state.status, /请求失败|核验输出无效/)
  assert.doesNotMatch(await readFile(join(h.directory, 'dsh_character_growth.json'), 'utf8'), /private-provider-token/)
})

test('fixed organizer outage falls back to the enabled main chat model and reports it', async t => {
  const mainModel = { provider: 'main-provider', model: 'main-model', reasoningEffort: 'high' }
  const h = await setup(t, {
    listProviders: () => [{ id: mainModel.provider, name: '测试主模型' }],
    listModels: async () => [{ id: mainModel.model, name: '主聊天模型' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }, { id: 'low' }] } }),
  })
  await h.growth.setConfig({ revision: 0, model, fallbackToMain: true })
  const enabled = await h.growth.change(h.character, { characterId: h.character.id, expectedRevision: 0, action: 'enable' }, Date.now())
  await h.growth.enqueue(h.character, round(), enabled.epoch)
  h.ctx.provide('agentDefaultModel' as never, { currentSelection: () => mainModel } as never)
  let requested: unknown
  const runtime = h.runtime(async (_prompt, used) => { requested = used; return JSON.stringify({ candidates: [] }) })
  await runtime.process(h.character.id)
  assert.deepEqual(requested, mainModel)
  assert.equal(h.growth.get(h.character).pending, 0)
  const status = await runtime.status(h.character.id, new AbortController().signal)
  assert.equal(status.usingFallback, true)
  assert.match(status.message, /已回退使用主聊天模型/)
})

test('main chat model effort outside its catalog clears to the model default instead of failing', async t => {
  const h = await setup(t, {
    listProviders: () => [{ id: 'main-provider', name: '测试主模型' }],
    listModels: async () => [{ id: 'main-model', name: '主聊天模型' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }),
  })
  await h.growth.setConfig({ revision: 0, model, fallbackToMain: true })
  const enabled = await h.growth.change(h.character, { characterId: h.character.id, expectedRevision: 0, action: 'enable' }, Date.now())
  await h.growth.enqueue(h.character, round(), enabled.epoch)
  h.ctx.provide('agentDefaultModel' as never, { currentSelection: () => ({ provider: 'main-provider', model: 'main-model', reasoningEffort: 'max' }) } as never)
  let requested: unknown
  const runtime = h.runtime(async (_prompt, used) => { requested = used; return JSON.stringify({ candidates: [] }) })
  await runtime.process(h.character.id)
  assert.deepEqual(requested, { provider: 'main-provider', model: 'main-model' })
  assert.equal(h.growth.get(h.character).pending, 0)
})

test('fallback enabled but main model unavailable keeps the fixed-model pause', async t => {
  const h = await setup(t, { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) })
  await h.growth.setConfig({ revision: 0, model, fallbackToMain: true })
  const enabled = await h.growth.change(h.character, { characterId: h.character.id, expectedRevision: 0, action: 'enable' }, Date.now())
  await h.growth.enqueue(h.character, round(), enabled.epoch)
  h.ctx.provide('agentDefaultModel' as never, { currentSelection: () => ({ provider: 'main-provider', model: 'main-model' }) } as never)
  let calls = 0
  const runtime = h.runtime(async () => { calls++; return '{"candidates":[]}' })
  await runtime.process(h.character.id)
  assert.equal(calls, 0)
  assert.equal(h.growth.get(h.character).pending, 1)
  assert.match(h.growth.get(h.character).status, /固定整理模型或推理档位当前不可用/)
  const status = await runtime.status(h.character.id, new AbortController().signal)
  assert.equal(status.usingFallback, false)
})

test('fallback stays off by default even when the main chat model is resolvable', async t => {
  const h = await setup(t, {
    listProviders: () => [{ id: 'main-provider', name: '测试主模型' }],
    listModels: async () => [{ id: 'main-model', name: '主聊天模型' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }] } }),
  })
  const enabled = await h.enable()
  await h.growth.enqueue(h.character, round(), enabled.epoch)
  h.ctx.provide('agentDefaultModel' as never, { currentSelection: () => ({ provider: 'main-provider', model: 'main-model' }) } as never)
  let calls = 0
  const runtime = h.runtime(async () => { calls++; return '{"candidates":[]}' })
  await runtime.process(h.character.id)
  assert.equal(calls, 0)
  assert.match(h.growth.get(h.character).status, /固定整理模型或推理档位当前不可用/)
  const status = await runtime.status(h.character.id, new AbortController().signal)
  assert.equal(status.usingFallback, false)
  assert.equal(status.config.fallbackToMain, undefined)
})

test('fallback preference persists across restart together with the fixed model', async t => {
  const h = await setup(t)
  const saved = await h.growth.setConfig({ revision: 0, model, fallbackToMain: true })
  assert.equal(saved.fallbackToMain, true)
  const reopened = await h.reopen()
  assert.equal(reopened.settings().fallbackToMain, true)
  assert.equal(reopened.settings().model?.model, model.model)
})

test('compatible admission never silently resumes after a previously observed isolation service disappears', async t => {
  const h = await setup(t)
  const runtime = h.runtime(async () => '{"candidates":[]}')
  assert.match(runtime.isolationMessage(), /兼容模式/)
  h.ctx.provide('automationExecutionPolicy' as never, { version: 1, resolveForSession: () => undefined, withMemoryAccess: async (_: string, fn: () => unknown) => fn(), ready: Promise.resolve() } as never)
  assert.equal(runtime.isolationMessage(), '')
  h.ctx.set('automationExecutionPolicy' as never, undefined as never)
  assert.match(runtime.isolationMessage(), /断开|不兼容/)
})

test('the shared 45-second deadline terminates an uncooperative model and ignores its late answer', async t => {
  const h = await setup(t); const enabled = await h.enable()
  await h.growth.enqueue(h.character, round(), enabled.epoch)
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { assert.equal(ms, 45_000); return timeout(20) })
  let release!: (value: string) => void
  let calls = 0
  const runtime = h.runtime(async () => { calls++; return new Promise<string>(resolve => { release = resolve }) })
  await Promise.all([runtime.process(h.character.id), new Promise(resolve => setTimeout(resolve, 50))])
  assert.equal(calls, 1)
  assert.equal(h.growth.get(h.character).pending, 1)
  assert.match(h.growth.get(h.character).status, /45 秒/)
  release(JSON.stringify({ candidates: [candidate()] }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.growth.get(h.character).entries.length, 0)
  assert.equal(calls, 1)
})

test('failed base revalidation preserves protected entries without applying them or retrying in a loop', async t => {
  const h = await setup(t); await h.enable()
  await h.growth.update(h.character, state => { state.entries = [{ ...entry(), manual: true, content: '用户手动设置' }] })
  const changed = await h.characters.save({ id: h.character.id, expectedRevision: 1, fields: { ...EMPTY_CHARACTER_FIELDS, name: h.character.name, boundaries: '新边界' } })
  let calls = 0
  const runtime = h.runtime(async prompt => { calls++; assert.match(prompt, /可信用户设置/); return verdict('address', { preservesCore: false }) })
  await runtime.process(changed.id)
  assert.equal(h.growth.get(changed).entries[0]?.content, '用户手动设置')
  assert.equal(h.growth.get(changed).entries[0]?.manual, true)
  assert.equal(runtime.snapshot(changed), undefined)
  assert.match(h.growth.get(changed).status, /条目已保留/)
  assert.equal(calls, 1)
})

test('restart resumes unfinished base revalidation even without pending evidence', async t => {
  const h = await setup(t); await h.enable()
  await h.growth.update(h.character, state => { state.entries = [{ ...entry(), manual: true }]; state.baseRevision = 0 })
  const reopened = await h.reopen()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const runtime = h.runtime(async () => { calls++; return verdict() })
  assert.equal(runtime.snapshot(h.character), undefined)
  assert.equal(reopened.get(h.character).pending, 0)
  t.mock.timers.tick(0)
  await runtime.process(h.character.id)
  assert.equal(calls, 1)
  assert.ok(runtime.snapshot(h.character))
})

test('owner-turn evidence write failure is visible while base chat and prior growth survive', async t => {
  const h = await setup(t); await h.enable()
  await h.growth.update(h.character, state => { state.entries = [entry()] })
  await h.ctx.plugin(SessionStore)
  const session = h.ctx.sessions.create(SessionId('write-failure'))
  const agent = { id: session.id, session }
  h.ctx.provide('agents', { get: () => agent, roots: () => [agent] } as never)
  await h.characters.bind(session.id, h.character.id)
  const runtime = h.runtime(async () => '{"candidates":[]}')
  assert.equal(runtime.register(session.id), true)
  const original = h.growth.get(h.character)
  const file = join(h.directory, 'dsh_character_growth.json')
  await rename(file, file + '.saved'); await mkdir(file)
  try {
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '普通闲聊' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: '你好。' }], source: { kind: 'model', provider: 'test', model: 'test' } }), stream: [] }, { surfaceOp: 'append' })
    assert.doesNotThrow(() => session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await h.growth.update(h.character, () => false)
    await new Promise(resolve => setImmediate(resolve))
    const status = await runtime.status(h.character.id, new AbortController().signal)
    assert.match(status.message, /成长证据保存失败/)
    assert.equal(status.applied, true)
    assert.deepEqual(h.growth.get(h.character), original)
  } finally { await rmdir(file); await rename(file + '.saved', file) }
})
