import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { CharacterStore, CharacterError } from '../src/host/store.js'
import { CharacterVisualStore } from '../src/host/visuals.js'
import { characterAvatarUploadRoute } from '../src/host/visuals-route.js'
import { EMPTY_CHARACTER_FIELDS } from '../src/shared/types.js'
import { CHARACTER_AVATAR_UPLOAD_PATH } from '../src/shared/visuals.js'

// Optional real-SDK integration: point this at the installed/extracted unmodified
// dsh-attachment-local/lib/index.js. Absence is reported as skipped, never mocked.
const codecModule = process.env.DSH_CHARACTER_CODEC_MODULE
const options = { skip: codecModule ? false : 'Set DSH_CHARACTER_CODEC_MODULE to the real Host attachment-local module.' }

test('real Host codec rejects MIME spoofing and truncated images, detects corruption, and leaves sessions intact', options, async t => {
  const moduleUrl = pathToFileURL(resolve(codecModule!))
  const manifest = JSON.parse(await readFile(new URL('../package.json', moduleUrl), 'utf8'))
  assert.equal(manifest.name, '@deepseek-ai/dsh-attachment-local')
  assert.equal(manifest.version, '0.2.1-rc.3')
  const { default: LocalAttachmentStore } = await import(moduleUrl.href)
  const directory = await mkdtemp(join(tmpdir(), 'dsh-character-real-codec-'))
  const ctx = new Context()
  const attachmentFork = ctx.plugin(LocalAttachmentStore, { dshHome: directory }); await attachmentFork
  const storage = ctx.plugin(Storage); await storage
  const json = ctx.plugin(StorageJson, { root: join(directory, 'storages') }); await json
  const domain = ctx.plugin(StorageDomain, { backend: 'json' }); await domain
  const characters = await CharacterStore.open(ctx)
  const character = await characters.save({ fields: { ...EMPTY_CHARACTER_FIELDS, name: '真实图片测试角色' } })
  await characters.bind('existing-session', character.id)
  await characters.lock('existing-session')
  const originalRoleBytes = await readFile(join(directory, 'storages', 'dsh_character.json'), 'utf8')
  const visuals = await CharacterVisualStore.open(ctx, characters)
  const signal = new AbortController().signal
  t.after(async () => {
    await visuals.close(); await characters.close(); await domain.dispose(); await json.dispose(); await storage.dispose(); await attachmentFork.dispose()
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep) && directory.includes('dsh-character-real-codec-'))
    await rm(directory, { recursive: true, force: true })
  })
  const jpeg = new Uint8Array(await readFile(new URL('../characters/whale-girl.jpg', import.meta.url)))
  const saved = await visuals.upload(character.id, 0, jpeg, 'image/jpeg', signal)
  assert.equal(saved.source, 'upload')
  assert.equal(saved.revision, 1)
  const decoded = await visuals.read(character.id, 1, signal)
  assert.notEqual(decoded, 'builtin')
  if (decoded === 'builtin') throw new Error('Expected uploaded portrait')
  assert.equal(decoded.mediaType, 'image/jpeg')
  assert.ok(decoded.data.length > 0)

  const invalid = (error: unknown) => error instanceof CharacterError && error.code === 'invalid-request'
  await assert.rejects(visuals.upload(character.id, 1, jpeg, 'image/png', signal), invalid)
  // The retained header is sufficient for metadata sniffing; full decoding must fail.
  await assert.rejects(visuals.upload(character.id, 1, jpeg.slice(0, Math.floor(jpeg.length / 2)), 'image/jpeg', signal), invalid)
  await assert.rejects(visuals.upload(character.id, 1, new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png', signal), invalid)
  assert.deepEqual(visuals.get(character.id), saved)

  const data = JSON.parse(await readFile(join(directory, 'storages', 'dsh_character_visuals.json'), 'utf8'))
  const ref = data.tables.portraits[character.id].attachment as ImageAttachmentRef
  const objectPath = (ctx.attachments as AttachmentStore).imageHostPath(ref)!
  assert.ok(resolve(objectPath).startsWith(resolve(directory) + sep))
  const originalImage = await readFile(objectPath)
  const originalMode = (await stat(objectPath)).mode
  await chmod(objectPath, 0o600)
  await writeFile(objectPath, new Uint8Array([0, 1, 2]))
  try {
    await assert.rejects(visuals.read(character.id, 1, signal), (error: unknown) => error instanceof CharacterError && error.code === 'storage')
  } finally { await writeFile(objectPath, originalImage); await chmod(objectPath, originalMode) }
  assert.deepEqual(visuals.get(character.id), saved)
  assert.equal(await readFile(join(directory, 'storages', 'dsh_character.json'), 'utf8'), originalRoleBytes)
  assert.deepEqual(characters.getBinding('existing-session'), { sessionId: 'existing-session', characterId: character.id, locked: true })
  assert.equal((await readdir(directory)).includes('sessions'), false)
})

test('unload cancels an in-flight streaming body before any image or metadata is persisted', async () => {
  const lifetime = new AbortController()
  let cancelled = false
  let uploads = 0
  let notifyRead!: () => void
  const reading = new Promise<void>(resolve => { notifyRead = resolve })
  const stream = new ReadableStream<Uint8Array>({
    pull() { notifyRead() },
    cancel() { cancelled = true },
  })
  // This test isolates body lifecycle; it makes no claim about codec validation.
  const store = { maxBytes: 100, get: () => ({}), upload: () => { uploads++; throw new Error('Must not upload') } } as unknown as CharacterVisualStore
  const route = characterAvatarUploadRoute(Promise.resolve(store), lifetime.signal, new URL('../characters/whale-girl.jpg', import.meta.url))
  const request = new Request(`http://localhost${CHARACTER_AVATAR_UPLOAD_PATH}?characterId=one&expectedRevision=0`, {
    method: 'POST', body: stream, duplex: 'half', headers: { 'Content-Type': 'image/jpeg' },
  } as RequestInit)
  const response = route.fetch(request)
  await reading
  lifetime.abort()
  const completed = await response
  assert.equal(completed.status, 499)
  assert.equal((await completed.json()).error.code, 'cancelled')
  assert.equal(cancelled, true)
  assert.equal(uploads, 0)
})
