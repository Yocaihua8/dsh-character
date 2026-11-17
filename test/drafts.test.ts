import test from 'node:test'
import assert from 'node:assert/strict'
import type { Character } from '../src/shared/types.js'
import type { CharactersRpc, RemoteResult } from '../src/client/controller.js'
import { blankDraft } from '../src/client/controller.js'
import { CharacterManagerCache, closeDecision } from '../src/client/drafts.js'

const record = (id = 'one', revision = 1): Character => ({ ...blankDraft(), id, revision, archived: false, name: id })
const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
function rpc(overrides: Partial<CharactersRpc> = {}): CharactersRpc {
  return {
    listCharacters: async () => ok([record()]), getCharacter: async id => ok(record(id)),
    saveCharacter: async input => ok({ ...input.fields, id: input.id ?? 'created', revision: (input.expectedRevision ?? 0) + 1, archived: false }),
    archiveCharacter: async (id, revision) => ok({ ...record(id, revision + 1), archived: true }),
    getBinding: async () => ok({ binding: null, character: null, canBind: true, reason: '' }),
    bindCharacter: async () => ok({ binding: null, character: null, canBind: true, reason: '' }),
    ...overrides,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
const initialState = () => ({ view: 'edit', tab: 'identity', avatarDraft: null as Uint8Array | null })

test('all exit paths use a guard that blocks busy operations before asking about unsaved work', () => {
  assert.equal(closeDecision({ busy: false, dirty: false }), 'allow')
  assert.equal(closeDecision({ busy: false, dirty: true }), 'confirm')
  assert.equal(closeDecision({ busy: true, dirty: false }), 'blocked')
  assert.equal(closeDecision({ busy: true, dirty: true }), 'blocked')
})

test('settings remount restores editor draft, selection, tab and pending avatar without invoking a new initializer', async () => {
  const cache = new CharacterManagerCache<ReturnType<typeof initialState>>()
  const transport = rpc()
  const first = cache.get('settings', transport, initialState, record())
  await first.editor.refresh()
  let renders = 0
  const unsubscribe = first.editor.subscribe(() => { renders++ })
  first.editor.edit('style', '保留尚未提交的语气')
  first.state.tab = 'principles'
  first.state.avatarDraft = new Uint8Array([1, 2, 3])
  unsubscribe()
  const detachedRenders = renders
  first.editor.edit('values', '保留价值观')
  assert.equal(renders, detachedRenders)
  const restored = cache.get('settings', transport, () => { throw new Error('must not recreate state') }, record('different'))
  assert.equal(restored, first)
  assert.equal(restored.editor.selected?.id, 'one')
  assert.equal(restored.editor.draft?.style, '保留尚未提交的语气')
  assert.equal(restored.editor.draft?.values, '保留价值观')
  assert.equal(restored.editor.dirty, true)
  assert.equal(restored.state.tab, 'principles')
  assert.deepEqual(restored.state.avatarDraft, new Uint8Array([1, 2, 3]))
  cache.dispose()
})

test('a save completing while settings is detached preserves newer typing and refreshes the saved revision on return', async () => {
  const pending = deferred<RemoteResult<Character>>()
  const cache = new CharacterManagerCache<ReturnType<typeof initialState>>()
  const transport = rpc({ saveCharacter: async () => pending.promise })
  const { editor } = cache.get('settings', transport, initialState, record())
  await editor.refresh()
  let oldRenders = 0
  const detach = editor.subscribe(() => { oldRenders++ })
  editor.edit('style', '提交给宿主的版本')
  const saving = editor.save()
  editor.edit('style', '保存期间继续输入')
  detach()
  const before = oldRenders
  pending.resolve(ok({ ...record('one', 2), style: '提交给宿主的版本' }))
  await saving
  assert.equal(oldRenders, before)
  const returned = cache.get('settings', transport, initialState)
  assert.equal(returned.editor.selected?.revision, 2)
  assert.equal(returned.editor.draft?.style, '保存期间继续输入')
  assert.equal(returned.editor.busy, false)
  assert.equal(returned.editor.dirty, true)
  let newRenders = 0
  returned.editor.subscribe(() => { newRenders++ })
  returned.editor.edit('background', '新输入')
  assert.equal(newRenders, 1)
  cache.dispose()
})

test('failed writes after unmount retain the draft and error for the next mount', async () => {
  const pending = deferred<RemoteResult<Character>>()
  const cache = new CharacterManagerCache<ReturnType<typeof initialState>>()
  const transport = rpc({ saveCharacter: async () => pending.promise })
  const { editor } = cache.get('settings', transport, initialState, record())
  await editor.refresh()
  editor.edit('name', '尚未保存的名字')
  const save = editor.save()
  pending.resolve({ ok: false, error: { message: '存储失败', details: { reason: 'storage' } } })
  await save
  const restored = cache.get('settings', transport, initialState)
  assert.equal(restored.editor.draft?.name, '尚未保存的名字')
  assert.equal(restored.editor.error, '存储失败')
  assert.equal(restored.editor.selected?.revision, 1)
  cache.dispose()
})

test('manager surfaces have independent drafts and a fresh plugin cache cannot restore a previous activation', async () => {
  const cache = new CharacterManagerCache<ReturnType<typeof initialState>>()
  const transport = rpc()
  const settings = cache.get('settings', transport, initialState, record())
  const session = cache.get('session:one', transport, initialState, record())
  await settings.editor.refresh(); await session.editor.refresh()
  settings.editor.edit('name', '设置页面的草稿')
  session.editor.edit('name', '会话页面的草稿')
  assert.equal(settings.editor.draft?.name, '设置页面的草稿')
  assert.equal(session.editor.draft?.name, '会话页面的草稿')
  cache.dispose()
  assert.throws(() => cache.get('settings', transport, initialState), /已停用/)
  const fresh = new CharacterManagerCache<ReturnType<typeof initialState>>()
  assert.equal(fresh.get('settings', transport, initialState, record()).editor.draft?.name, 'one')
  fresh.dispose()
})

test('plugin disposal aborts requests, releases UI resources once and prevents late notification', async () => {
  const pending = deferred<RemoteResult<Character[]>>()
  let signal!: AbortSignal
  let disposals = 0
  let renders = 0
  const cache = new CharacterManagerCache(() => { disposals++ })
  const { editor } = cache.get('settings', rpc({ listCharacters: async abort => { signal = abort; return pending.promise } }), initialState)
  editor.subscribe(() => { renders++ })
  const loading = editor.refresh()
  const before = renders
  cache.dispose(); cache.dispose()
  pending.resolve(ok([record()])); await loading
  assert.equal(signal.aborted, true)
  assert.equal(disposals, 1)
  assert.equal(renders, before)
  assert.deepEqual(editor.characters, [])
})

test('a faulty UI resource disposer does not skip cleanup of other surfaces', () => {
  const disposed: string[] = []
  const cache = new CharacterManagerCache<{ key: string }>(state => {
    disposed.push(state.key)
    if (state.key === 'settings') throw new Error('dispose failure')
  })
  const transport = rpc()
  cache.get('settings', transport, () => ({ key: 'settings' }))
  const second = cache.get('session', transport, () => ({ key: 'session' }), record())
  assert.throws(() => cache.dispose(), AggregateError)
  assert.deepEqual(disposed, ['settings', 'session'])
  second.editor.select(record('other'))
  assert.equal(second.editor.selected?.id, 'one')
  cache.dispose()
})
