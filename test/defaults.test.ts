import test from 'node:test'
import assert from 'node:assert/strict'
import { DefaultCharacterController } from '../src/client/defaults.js'
import type { DefaultsRpc } from '../src/client/defaults.js'
import { blankDraft } from '../src/client/controller.js'
import type { RemoteResult } from '../src/client/controller.js'
import type { Character, DefaultCharacterStatus } from '../src/shared/types.js'

const character = (id: string, archived = false): Character => ({ ...blankDraft(), id, name: id, revision: 1, archived })
const status = (id: string | null = 'one', revision = 1): DefaultCharacterStatus => ({ characterId: id, revision, character: id ? character(id) : null, unavailableReason: '' })
const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
const failed = (reason: string, message = '设置保存失败'): RemoteResult<DefaultCharacterStatus> => ({ ok: false, error: { message, details: { reason } } })
function rpc(overrides: Partial<DefaultsRpc> = {}): DefaultsRpc {
  return { getDefaultCharacter: async () => ok(status()), setDefaultCharacter: async (id, revision) => ok(status(id, revision + 1)), ...overrides }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

test('default choice remains separate from the persisted setting until save succeeds', async () => {
  const pending = deferred<RemoteResult<DefaultCharacterStatus>>()
  const controller = new DefaultCharacterController(rpc({ setDefaultCharacter: () => pending.promise }))
  await controller.refresh()
  assert.equal(controller.selectedId, 'one')
  assert.equal(controller.dirty, false)
  controller.choose('two')
  const saving = controller.save()
  assert.equal(controller.busy, true)
  assert.equal(controller.status?.characterId, 'one')
  assert.equal(controller.selectedId, 'two')
  controller.choose('three')
  assert.equal(controller.selectedId, 'two', 'saving blocks another selection')
  pending.resolve(ok(status('two', 2)))
  await saving
  assert.equal(controller.status?.characterId, 'two')
  assert.equal(controller.dirty, false)
  assert.equal(controller.busy, false)
  assert.match(controller.message, /仅之后新建的会话/)
})

test('save failures keep the actual old default and candidate for retry with the same revision', async () => {
  const attempts: Array<[string | null, number]> = []
  const controller = new DefaultCharacterController(rpc({ setDefaultCharacter: async (id, revision) => {
    attempts.push([id, revision])
    return attempts.length === 1 ? failed('storage', '磁盘写入失败') : ok(status(id, revision + 1))
  } }))
  await controller.refresh()
  controller.choose('two')
  await controller.save()
  assert.equal(controller.status?.characterId, 'one')
  assert.equal(controller.status?.revision, 1)
  assert.equal(controller.selectedId, 'two')
  assert.equal(controller.dirty, true)
  assert.equal(controller.error, '磁盘写入失败')
  await controller.save()
  assert.deepEqual(attempts, [['two', 1], ['two', 1]])
  assert.equal(controller.status?.characterId, 'two')
  assert.equal(controller.error, '')
})

test('cancelling the default is explicit and persists null without changing it optimistically', async () => {
  let input: string | null | undefined
  const controller = new DefaultCharacterController(rpc({ setDefaultCharacter: async (id, revision) => { input = id; return ok(status(id, revision + 1)) } }))
  await controller.refresh()
  controller.choose(null)
  assert.equal(controller.status?.characterId, 'one')
  await controller.save()
  assert.equal(input, null)
  assert.equal(controller.status?.characterId, null)
  assert.equal(controller.status?.character, null)
  assert.equal(controller.selectedId, null)
  assert.match(controller.message, /已取消自动选择/)
})

test('normal refresh preserves a pending choice and its CAS revision across a remount', async () => {
  let current = status('one', 1)
  let submittedRevision = -1
  const controller = new DefaultCharacterController(rpc({ getDefaultCharacter: async () => ok(current), setDefaultCharacter: async (_id, revision) => {
    submittedRevision = revision; return failed('conflict')
  } }))
  await controller.refresh()
  controller.choose('two')
  current = status('three', 2)
  await controller.refresh()
  assert.equal(controller.status?.characterId, 'three')
  assert.equal(controller.selectedId, 'two')
  await controller.save()
  assert.equal(submittedRevision, 1, 'refresh cannot silently rebase a pending choice')
  assert.equal(controller.conflict, true)
})

test('CAS conflict requires explicit latest-version acceptance and keeps the chosen role', async () => {
  let current = status('one', 1)
  const attempts: number[] = []
  const controller = new DefaultCharacterController(rpc({ getDefaultCharacter: async () => ok(current), setDefaultCharacter: async (id, revision) => {
    attempts.push(revision)
    if (revision !== current.revision) return failed('conflict')
    current = status(id, revision + 1); return ok(current)
  } }))
  await controller.refresh()
  controller.choose('two')
  current = status('three', 2)
  await controller.save()
  assert.equal(controller.conflict, true)
  assert.equal(controller.selectedId, 'two')
  await controller.save()
  assert.deepEqual(attempts, [1], 'conflict blocks a blind retry')
  await controller.refresh()
  assert.equal(controller.status?.characterId, 'three')
  assert.equal(controller.conflict, true)
  await controller.refresh({ acceptDraftRevision: true })
  assert.equal(controller.selectedId, 'two')
  assert.equal(controller.conflict, false)
  await controller.save()
  assert.deepEqual(attempts, [1, 2])
  assert.equal(controller.status?.characterId, 'two')
})

test('archived and missing defaults retain their identity and reason instead of becoming no-default', async () => {
  for (const value of [
    { ...status('one', 3), character: character('one', true), unavailableReason: '默认角色已归档，新会话暂不自动绑定。' },
    { ...status('missing', 3), character: null, unavailableReason: '默认角色已不存在，请选择其他角色。' },
  ]) {
    const controller = new DefaultCharacterController(rpc({ getDefaultCharacter: async () => ok(value) }))
    await controller.refresh()
    assert.equal(controller.status?.characterId, value.characterId)
    assert.equal(controller.selectedId, value.characterId)
    assert.equal(controller.status?.unavailableReason, value.unavailableReason)
    assert.equal(controller.dirty, false)
    controller.choose(null)
    assert.equal(controller.dirty, true)
    controller.discard()
    assert.equal(controller.selectedId, value.characterId)
  }
})

test('late reads from an older refresh cannot replace the latest status', async () => {
  const old = deferred<RemoteResult<DefaultCharacterStatus>>()
  let calls = 0
  let firstSignal: AbortSignal | undefined
  const controller = new DefaultCharacterController(rpc({ getDefaultCharacter: signal => {
    calls++
    if (calls === 1) { firstSignal = signal; return old.promise }
    return Promise.resolve(ok(status('two', 2)))
  } }))
  const first = controller.refresh()
  await controller.refresh()
  assert.equal(firstSignal?.aborted, true)
  old.resolve(ok(status('one', 1)))
  await first
  assert.equal(controller.status?.characterId, 'two')
  assert.equal(controller.selectedId, 'two')
})

test('save invalidates an earlier refresh so its late response cannot restore the old default', async () => {
  const old = deferred<RemoteResult<DefaultCharacterStatus>>()
  let calls = 0
  const controller = new DefaultCharacterController(rpc({ getDefaultCharacter: () => ++calls === 1 ? Promise.resolve(ok(status())) : old.promise }))
  await controller.refresh()
  const refreshing = controller.refresh()
  controller.choose('two')
  await controller.save()
  old.resolve(ok(status('one', 1)))
  await refreshing
  assert.equal(controller.status?.characterId, 'two')
  assert.equal(controller.status?.revision, 2)
})

test('dispose aborts in-flight saves and ignores late completion and notifications', async () => {
  const pending = deferred<RemoteResult<DefaultCharacterStatus>>()
  let writeSignal: AbortSignal | undefined
  let notifications = 0
  const controller = new DefaultCharacterController(rpc({ setDefaultCharacter: (_id, _revision, signal) => { writeSignal = signal; return pending.promise } }))
  controller.subscribe(() => notifications++)
  await controller.refresh()
  controller.choose('two')
  const saving = controller.save()
  controller.dispose()
  const before = notifications
  assert.equal(writeSignal?.aborted, true)
  pending.resolve(ok(status('two', 2)))
  await saving
  assert.equal(controller.status?.characterId, 'one')
  assert.equal(notifications, before)
})

test('unmounting listeners preserves selection, while failed initial reads cannot write an unknown revision', async () => {
  let writes = 0
  let failRead = true
  const controller = new DefaultCharacterController(rpc({ getDefaultCharacter: async () => failRead ? failed('storage', '读取失败') : ok(status()), setDefaultCharacter: async (id, revision) => { writes++; return ok(status(id, revision + 1)) } }))
  await controller.refresh()
  controller.choose('two')
  await controller.save()
  assert.equal(controller.status, null)
  assert.equal(writes, 0)
  failRead = false
  await controller.refresh()
  let notifications = 0
  const unsubscribe = controller.subscribe(() => notifications++)
  controller.choose('two')
  unsubscribe()
  await controller.refresh()
  assert.equal(controller.selectedId, 'two')
  assert.equal(controller.dirty, true)
  assert.equal(notifications, 1)
})
