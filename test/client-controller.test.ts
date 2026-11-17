import test from 'node:test'
import assert from 'node:assert/strict'
import type { Character, CharacterBindingStatus } from '../src/shared/types.js'
import { CharacterBindingController, CharacterEditorController, blankDraft } from '../src/client/controller.js'
import type { BindingContext, CharactersRpc, RemoteResult } from '../src/client/controller.js'

const record = (id = 'one', revision = 1): Character => ({ ...blankDraft(), id, revision, archived: false, name: id })
const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
const failed = <T>(reason: string, message = '失败'): RemoteResult<T> => ({ ok: false, error: { code: 'character/failed', message, details: { reason } } })
const status = (sessionId = 's1', character = record(), canBind = true): CharacterBindingStatus => ({ binding: { sessionId, characterId: character.id, locked: !canBind }, character, canBind, reason: canBind ? '' : '角色已固定' })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
function rpc(overrides: Partial<CharactersRpc> = {}): CharactersRpc {
  return {
    listCharacters: async () => ok([record()]), getCharacter: async id => ok(record(id, 2)),
    saveCharacter: async input => ok({ ...input.fields, id: input.id ?? 'created', revision: (input.expectedRevision ?? 0) + 1, archived: false }),
    archiveCharacter: async (id, revision) => ok({ ...record(id, revision + 1), archived: true }),
    getBinding: async id => ok(status(id)), bindCharacter: async (id, characterId) => ok(status(id, record(characterId))),
    ...overrides,
  }
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve))

test('failed save retains the full draft and saved revision', async () => {
  const editor = new CharacterEditorController(rpc({ saveCharacter: async () => failed('storage', '磁盘写入失败') }), () => {}, record())
  await editor.refresh(); editor.edit('personality', '保留这份性格草稿')
  const draft = editor.draft
  await editor.save()
  assert.equal(editor.draft, draft)
  assert.equal(editor.selected?.revision, 1)
  assert.equal(editor.dirty, true)
  assert.equal(editor.error, '磁盘写入失败')
  assert.equal(editor.busy, false)
  editor.dispose()
})

for (const reason of ['conflict', 'revision-conflict']) {
  test(`real RPC failure shape ${reason} preserves draft and offers explicit reload`, async () => {
    const editor = new CharacterEditorController(rpc({ saveCharacter: async () => failed(reason) }), () => {}, record())
    await editor.refresh(); editor.edit('style', '我的修改')
    await editor.save()
    assert.equal(editor.conflict, true)
    assert.equal(editor.draft?.style, '我的修改')
    assert.equal(editor.selected?.revision, 1)
    assert.match(editor.error, /当前草稿已保留/)
    await editor.reloadSelected()
    assert.equal(editor.conflict, false)
    assert.equal(editor.selected?.revision, 2)
    assert.equal(editor.draft?.style, '')
    editor.dispose()
  })
}

test('typing during save is preserved while the returned revision becomes the next baseline', async () => {
  const pending = deferred<RemoteResult<Character>>()
  const editor = new CharacterEditorController(rpc({ saveCharacter: async () => pending.promise }), () => {}, record())
  await editor.refresh(); editor.edit('style', '提交内容')
  const saving = editor.save()
  editor.edit('style', '提交后继续输入')
  pending.resolve(ok({ ...record('one', 2), style: '提交内容' })); await saving
  assert.equal(editor.draft?.style, '提交后继续输入')
  assert.equal(editor.selected?.revision, 2)
  assert.equal(editor.dirty, true)
  assert.match(editor.message, /未保存修改/)
  editor.dispose()
})

test('a save answer cannot replace a different selected character even when transport ignores abort', async () => {
  const pending = deferred<RemoteResult<Character>>()
  let signal!: AbortSignal
  const editor = new CharacterEditorController(rpc({ saveCharacter: async (_request, abort) => { signal = abort; return pending.promise } }), () => {}, record())
  await editor.refresh(); editor.edit('name', '更新')
  const saving = editor.save(); editor.select(record('two'))
  assert.equal(signal.aborted, true)
  pending.resolve(ok(record('one', 2))); await saving
  assert.equal(editor.selected?.id, 'two')
  assert.equal(editor.draft?.name, 'two')
  assert.equal(editor.message, '')
  editor.dispose()
})

test('archived character remains editable and saves without becoming available to new sessions', async () => {
  let requestCount = 0
  const archived = { ...record(), archived: true }
  const editor = new CharacterEditorController(rpc({ listCharacters: async () => ok([archived]), saveCharacter: async input => {
    requestCount++; return ok({ ...archived, ...input.fields, revision: 2 })
  } }), () => {}, archived)
  await editor.refresh(); editor.edit('values', '新的价值观')
  assert.equal(editor.dirty, true)
  await editor.save()
  assert.equal(requestCount, 1)
  assert.equal(editor.selected?.archived, true)
  assert.equal(editor.selected?.values, '新的价值观')
  await editor.archive()
  assert.equal(requestCount, 1)
  editor.dispose()
})

test('refresh updates a clean selected record but preserves the revision baseline of an edited draft', async () => {
  let revision = 2
  const editor = new CharacterEditorController(rpc({ listCharacters: async () => ok([{ ...record('one', revision), style: '远端版本' }]) }), () => {}, record())
  await editor.refresh()
  assert.equal(editor.selected?.revision, 2)
  assert.equal(editor.draft?.style, '远端版本')
  editor.edit('style', '本地尚未保存')
  revision = 3
  await editor.refresh()
  assert.equal(editor.characters[0]?.revision, 3)
  assert.equal(editor.selected?.revision, 2)
  assert.equal(editor.draft?.style, '本地尚未保存')
  editor.dispose()
})

test('a stale list response cannot roll back a just-saved record', async () => {
  const pending = deferred<RemoteResult<Character[]>>()
  let reads = 0
  const editor = new CharacterEditorController(rpc({ listCharacters: async () => ++reads === 1 ? ok([record()]) : pending.promise }), () => {}, record())
  await editor.refresh()
  const refresh = editor.refresh()
  editor.edit('name', '新名称'); await editor.save()
  pending.resolve(ok([record()])); await refresh
  assert.equal(editor.characters[0]?.revision, 2)
  assert.equal(editor.characters[0]?.name, '新名称')
  editor.dispose()
})

test('editor disposal cancels outstanding requests without publishing late changes', async () => {
  const pending = deferred<RemoteResult<Character[]>>()
  let signal!: AbortSignal; let renders = 0
  const editor = new CharacterEditorController(rpc({ listCharacters: async abort => { signal = abort; return pending.promise } }), () => { renders++ })
  const loading = editor.refresh(); const before = renders
  editor.dispose(); pending.resolve(ok([record()])); await loading
  assert.equal(signal.aborted, true)
  assert.equal(renders, before)
  assert.deepEqual(editor.characters, [])
})

test('readonly caller can inspect the bound character while owner-only list denies editing', async () => {
  const editor = new CharacterEditorController(rpc({ listCharacters: async () => failed('forbidden', '需要所有者权限') }), () => {}, record())
  await editor.refresh(); editor.edit('name', '不应生效'); await editor.save()
  assert.equal(editor.canManage, false)
  assert.equal(editor.draft?.name, 'one')
  assert.match(editor.error, /所有者权限/)
  editor.dispose()
})

test('late binding reads and writes never populate another conversation', async () => {
  const oldRead = deferred<RemoteResult<CharacterBindingStatus>>()
  const oldWrite = deferred<RemoteResult<CharacterBindingStatus>>()
  let context: BindingContext = { sessionId: 's1', available: true, mayBind: true }
  let readCount = 0; let writeSignal!: AbortSignal
  const controller = new CharacterBindingController({ read: () => context, changed: () => {}, rpc: rpc({
    getBinding: async id => ++readCount === 1 ? oldRead.promise : ok(status(id, record('two'))),
    bindCharacter: async (_id, _characterId, abort) => { writeSignal = abort; return oldWrite.promise },
  }) })
  controller.reconcile()
  context = { ...context, sessionId: 's2' }; controller.reconcile(); await settle()
  oldRead.resolve(ok(status('s1'))); await settle()
  assert.equal(controller.status?.binding?.sessionId, 's2')
  const selecting = controller.bind('one')
  context = { ...context, sessionId: 's3' }; controller.reconcile(); await settle()
  oldWrite.resolve(ok(status('s2'))); await selecting
  assert.equal(writeSignal.aborted, true)
  assert.equal(controller.status?.binding?.sessionId, 's3')
  assert.equal(controller.message, '')
  controller.dispose()
})

test('first-turn lock disables rebinding and refreshes the authoritative binding', async () => {
  let context: BindingContext = { sessionId: 's1', available: true, mayBind: true }
  let writes = 0
  const controller = new CharacterBindingController({ read: () => context, changed: () => {}, rpc: rpc({
    getBinding: async id => ok(status(id, record(), context.mayBind)),
    bindCharacter: async id => { writes++; return ok(status(id)) },
  }) })
  controller.reconcile(); await settle(); assert.equal(controller.canBind, true)
  context = { ...context, mayBind: false }; controller.reconcile(); await settle()
  assert.equal(controller.canBind, false)
  assert.equal(controller.status?.binding?.locked, true)
  await controller.bind('two'); assert.equal(writes, 0)
  controller.dispose()
})

test('archived choices are filtered and binding disposal cleans up every pending request', async () => {
  let signal!: AbortSignal; let changes = 0
  const delayed = deferred<RemoteResult<CharacterBindingStatus>>()
  const controller = new CharacterBindingController({ read: () => ({ sessionId: 's1', available: true, mayBind: true }), changed: () => { changes++ }, rpc: rpc({
    listCharacters: async () => ok([record(), { ...record('old'), archived: true }]),
    getBinding: async (_id, abort) => { signal = abort; return delayed.promise },
  }) })
  await controller.loadChoices(); assert.deepEqual(controller.characters.map(item => item.id), ['one'])
  const reading = controller.refresh(); const before = changes
  controller.dispose(); delayed.resolve(ok(status())); await reading
  assert.equal(signal.aborted, true)
  assert.equal(changes, before)
  assert.equal(controller.status, null)
})
