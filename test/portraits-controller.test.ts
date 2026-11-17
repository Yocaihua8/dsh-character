import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { CharacterPortraitController, characterImageUrl } from '../src/client/portraits.js'
import type { CharacterVisualsRpc } from '../src/client/portraits.js'
import type { RemoteResult } from '../src/client/controller.js'
import type { CharacterVisual } from '../src/shared/visuals.js'
import { CHARACTER_AVATAR_MAX_BYTES } from '../src/shared/visuals.js'

const visual = (revision = 0, id = 'one', source: CharacterVisual['source'] = 'builtin'): CharacterVisual => ({
  characterId: id, revision, source, url: source === 'none' ? null : `/api/dsh-character/avatar?characterId=${id}&revision=${revision}`,
})
const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
const file = (type = 'image/png', size = 8) => new File([new Uint8Array(size)], 'portrait.png', { type })
function rpc(overrides: Partial<CharacterVisualsRpc> = {}): CharacterVisualsRpc {
  return {
    listCharacterVisuals: async () => ok([visual()]),
    resetCharacterAvatar: async (id, revision) => ok(visual(revision + 1, id)),
    ...overrides,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
function browser(t: TestContext, base = 'https://harness.example/team/harness/') {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { baseURI: base } })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous)
    else Reflect.deleteProperty(globalThis, 'document')
  })
  const created: Blob[] = []
  const revoked: string[] = []
  t.mock.method(URL, 'createObjectURL', (blob: Blob) => { created.push(blob); return `blob:preview-${created.length}` })
  t.mock.method(URL, 'revokeObjectURL', (url: string) => { revoked.push(url) })
  return { created, revoked }
}

test('image URLs preserve HTTP deployment prefixes and the authenticated desktop scheme', t => {
  browser(t)
  assert.equal(characterImageUrl('/api/dsh-character/avatar?characterId=one'), 'https://harness.example/team/harness/api/dsh-character/avatar?characterId=one')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { baseURI: 'dsh-app://app/' } })
  assert.equal(characterImageUrl('/api/dsh-character/avatar?characterId=one'), 'dsh-app://app/api/dsh-character/avatar?characterId=one')
})

test('only nonempty PNG, JPEG and WebP within 2 MiB become portrait drafts; bad replacements preserve the last valid choice', async t => {
  const urls = browser(t)
  const controller = new CharacterPortraitController(rpc())
  await controller.refresh()
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
    const selected = file(type)
    controller.choose('one', selected)
    assert.equal(controller.file, selected)
    assert.equal(controller.error, '')
  }
  const valid = controller.file
  const preview = controller.previewUrl
  for (const invalid of [file('image/gif'), file('image/svg+xml'), file('image/png', 0), file('image/png', CHARACTER_AVATAR_MAX_BYTES + 1)]) {
    controller.choose('one', invalid)
    assert.equal(controller.file, valid)
    assert.equal(controller.previewUrl, preview)
    assert.notEqual(controller.error, '')
  }
  assert.equal(urls.created.length, 3)
  assert.deepEqual(urls.revoked, ['blob:preview-1', 'blob:preview-2'])
  controller.choose('one', file('image/png', CHARACTER_AVATAR_MAX_BYTES))
  assert.equal(controller.file?.size, CHARACTER_AVATAR_MAX_BYTES)
  controller.dispose()
  assert.deepEqual(urls.revoked, ['blob:preview-1', 'blob:preview-2', 'blob:preview-3', 'blob:preview-4'])
})

test('HTTP save failure preserves the selected file, preview and saved revision for retry', async t => {
  const urls = browser(t)
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code: 'storage', message: '图片磁盘写入失败' } }, { status: 500 }))
  const controller = new CharacterPortraitController(rpc())
  await controller.refresh()
  const selected = file()
  controller.choose('one', selected)
  await controller.save()
  assert.equal(controller.file, selected)
  assert.equal(controller.previewUrl, 'blob:preview-1')
  assert.equal(controller.visual('one')?.revision, 0)
  assert.equal(controller.busy, false)
  assert.equal(controller.dirty, true)
  assert.equal(controller.error, '图片磁盘写入失败')
  assert.deepEqual(urls.revoked, [])
  controller.dispose()
})

test('save captures the chosen revision; remount refresh cannot silently rebase a draft after another window saves', async t => {
  browser(t)
  let revision = 2
  const expected: number[] = []
  t.mock.method(globalThis, 'fetch', async (input: URL | string | Request) => {
    const url = new URL(String(input))
    const received = Number(url.searchParams.get('expectedRevision'))
    expected.push(received)
    return received === revision
      ? Response.json(visual(++revision, 'one', 'upload'))
      : Response.json({ error: { code: 'conflict', message: '版本冲突' } }, { status: 409 })
  })
  const controller = new CharacterPortraitController(rpc({ listCharacterVisuals: async () => ok([visual(revision)]) }))
  await controller.refresh()
  const selected = file()
  controller.choose('one', selected)
  revision = 3
  await controller.refresh()
  assert.equal(controller.visual('one')?.revision, 3)
  await controller.save()
  assert.deepEqual(expected, [2])
  assert.match(controller.error, /其他窗口更新/)
  assert.equal(controller.file, selected)
  await controller.refresh()
  await controller.save()
  assert.deepEqual(expected, [2, 2])
  await controller.refresh({ acceptDraftRevision: true })
  await controller.save()
  assert.deepEqual(expected, [2, 2, 3])
  assert.equal(controller.visual('one')?.revision, 4)
  assert.equal(controller.file, null)
  assert.equal(controller.dirty, false)
  controller.dispose()
})

test('failed explicit refresh cannot advance the draft revision or clear its selected file', async t => {
  browser(t)
  let calls = 0
  let receivedRevision: string | null = null
  const controller = new CharacterPortraitController(rpc({ listCharacterVisuals: async () => ++calls === 1
    ? ok([visual(4)]) : { ok: false, error: { message: '读取失败' } } }))
  t.mock.method(globalThis, 'fetch', async (input: URL | string | Request) => {
    receivedRevision = new URL(String(input)).searchParams.get('expectedRevision')
    return Response.json({ error: { code: 'conflict', message: '版本冲突' } }, { status: 409 })
  })
  await controller.refresh()
  const selected = file()
  controller.choose('one', selected)
  await controller.refresh({ acceptDraftRevision: true })
  assert.equal(controller.error, '读取失败')
  assert.equal(controller.file, selected)
  await controller.save()
  assert.equal(receivedRevision, '4')
  assert.equal(controller.file, selected)
  controller.dispose()
})

test('successful upload sends the binary file to the deployment URL then releases preview and uses the new revision for reset', async t => {
  const urls = browser(t)
  const selected = file('image/webp')
  let resetRevision = -1
  const controller = new CharacterPortraitController(rpc({ resetCharacterAvatar: async (id, revision) => {
    resetRevision = revision
    return ok(visual(revision + 1, id))
  } }))
  t.mock.method(globalThis, 'fetch', async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    assert.equal(url.origin + url.pathname, 'https://harness.example/team/harness/api/dsh-character/avatar/upload')
    assert.equal(url.searchParams.get('characterId'), 'one')
    assert.equal(url.searchParams.get('expectedRevision'), '0')
    assert.equal(init?.method, 'POST')
    assert.equal(init?.body, selected)
    assert.equal(new Headers(init?.headers).get('Content-Type'), 'image/webp')
    assert.equal(init?.credentials, 'include')
    return Response.json(visual(1, 'one', 'upload'))
  })
  await controller.refresh()
  controller.choose('one', selected)
  await controller.save()
  assert.equal(controller.visual('one')?.source, 'upload')
  assert.equal(controller.visual('one')?.revision, 1)
  assert.equal(controller.file, null)
  assert.equal(controller.previewUrl, null)
  assert.deepEqual(urls.revoked, ['blob:preview-1'])
  assert.equal(controller.message, '配图已保存。')
  await controller.reset('one')
  assert.equal(resetRevision, 1)
  assert.equal(controller.visual('one')?.source, 'builtin')
  assert.equal(controller.visual('one')?.revision, 2)
  assert.equal(controller.message, '已恢复默认配图。')
  controller.dispose()
})

test('a failed reset leaves the previous image and revision intact', async t => {
  browser(t)
  const controller = new CharacterPortraitController(rpc({ listCharacterVisuals: async () => ok([visual(3, 'one', 'upload')]),
    resetCharacterAvatar: async () => ({ ok: false, error: { message: '元数据写入失败' } }),
  }))
  await controller.refresh()
  await controller.reset('one')
  assert.equal(controller.visual('one')?.revision, 3)
  assert.equal(controller.visual('one')?.source, 'upload')
  assert.equal(controller.error, '元数据写入失败')
  assert.equal(controller.busy, false)
  controller.dispose()
})

test('refresh cancelled by upload cannot roll a successful image revision backwards even if transport ignores abort', async t => {
  browser(t)
  const pending = deferred<RemoteResult<CharacterVisual[]>>()
  let listCalls = 0
  let readSignal!: AbortSignal
  const controller = new CharacterPortraitController(rpc({ listCharacterVisuals: async signal => {
    readSignal = signal
    return ++listCalls === 1 ? ok([visual()]) : pending.promise
  } }))
  t.mock.method(globalThis, 'fetch', async () => Response.json(visual(1, 'one', 'upload')))
  await controller.refresh()
  controller.choose('one', file())
  const refreshing = controller.refresh()
  await controller.save()
  assert.equal(readSignal.aborted, true)
  pending.resolve(ok([visual()])); await refreshing
  assert.equal(controller.visual('one')?.revision, 1)
  assert.equal(controller.visual('one')?.source, 'upload')
  controller.dispose()
})

test('settings detach lets a write finish without stale render callbacks and publishes the result on return', async t => {
  browser(t)
  const pending = deferred<Response>()
  let signal!: AbortSignal
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => { signal = init!.signal!; return pending.promise })
  const controller = new CharacterPortraitController(rpc())
  await controller.refresh()
  let renders = 0
  const detach = controller.subscribe(() => { renders++ })
  controller.choose('one', file())
  const saving = controller.save()
  assert.equal(controller.busy, true)
  detach()
  const before = renders
  pending.resolve(Response.json(visual(1, 'one', 'upload'))); await saving
  assert.equal(signal.aborted, false)
  assert.equal(renders, before)
  assert.equal(controller.visual('one')?.revision, 1)
  assert.equal(controller.file, null)
  assert.equal(controller.busy, false)
  controller.dispose()
})

test('plugin disposal aborts an upload and revokes preview exactly once; late response cannot mutate state', async t => {
  const urls = browser(t)
  const pending = deferred<Response>()
  let signal!: AbortSignal
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => { signal = init!.signal!; return pending.promise })
  const controller = new CharacterPortraitController(rpc())
  await controller.refresh()
  let renders = 0
  controller.subscribe(() => { renders++ })
  controller.choose('one', file())
  const saving = controller.save()
  const before = renders
  controller.dispose(); controller.dispose()
  assert.equal(signal.aborted, true)
  assert.deepEqual(urls.revoked, ['blob:preview-1'])
  pending.resolve(Response.json(visual(1, 'one', 'upload'))); await saving
  assert.equal(controller.visual('one')?.revision, 0)
  assert.equal(controller.file, null)
  assert.equal(controller.previewUrl, null)
  assert.equal(renders, before)
})
