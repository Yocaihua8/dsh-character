import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rename, rm, rmdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentError, AttachmentId, type AttachmentStore, type ImageAttachmentRef, type SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { BUILTIN_WHALE_GIRL_ID } from '../src/host/builtins.js'
import { CharacterStore, CharacterError } from '../src/host/store.js'
import { CharacterVisualStore } from '../src/host/visuals.js'
import { characterAvatarRoute, characterAvatarUploadRoute } from '../src/host/visuals-route.js'
import { EMPTY_CHARACTER_FIELDS } from '../src/shared/types.js'
import { CHARACTER_AVATAR_MAX_BYTES, CHARACTER_AVATAR_PATH, CHARACTER_AVATAR_UPLOAD_PATH } from '../src/shared/visuals.js'

const signal = new AbortController().signal
const hasCode = (code: string) => (error: unknown) => error instanceof CharacterError && error.code === code
const bytes = new Uint8Array([1, 2, 3])

/** Binary seam fixture: actual decoding is exercised in the isolated real-host acceptance. */
function attachmentFixture() {
  const objects = new Map<string, Uint8Array>()
  let saves = 0
  let validate: (input: SaveImageAttachment) => Promise<void> = async () => {}
  const service = {
    imageLimits: { maxImageBytes: 8 * 1024 * 1024, mediaTypes: ['image/png', 'image/jpeg', 'image/webp'] },
    async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
      saves++
      await validate(input)
      const attachmentId = AttachmentId(createHash('sha256').update(input.data).digest('hex'))
      objects.set(attachmentId, input.data.slice())
      return { attachmentId, mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 }
    },
    async readImage(ref: ImageAttachmentRef, abort?: AbortSignal) {
      abort?.throwIfAborted()
      const data = objects.get(ref.attachmentId)
      if (!data) throw new AttachmentError('missing test object', 'ATTACHMENT_NOT_FOUND')
      return { ref, data }
    },
  }
  return { service, get saves() { return saves }, objects, validate: (callback: typeof validate) => { validate = callback } }
}

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-character-visual-test-'))
  const ctx = new Context()
  const attachments = attachmentFixture()
  ctx.provide('attachments', attachments.service as unknown as AttachmentStore)
  const storage = ctx.plugin(Storage); await storage
  const json = ctx.plugin(StorageJson, { root: directory }); await json
  const domains = ctx.plugin(StorageDomain, { backend: 'json' }); await domains
  const characters = await CharacterStore.open(ctx)
  await characters.ensureBuiltinCharacters()
  const custom = await characters.save({ fields: { ...EMPTY_CHARACTER_FIELDS, name: '自定义角色' } })
  await characters.bind('original-session', custom.id)
  await characters.lock('original-session')
  const visuals = await CharacterVisualStore.open(ctx, characters)
  const connectionFork = ctx.plugin((inner: Context) => { new HostConnectionService(inner, [], {} as never) }); await connectionFork
  const lifetime = new AbortController()
  const route = characterAvatarRoute(Promise.resolve(visuals), lifetime.signal, new URL('../characters/whale-girl.jpg', import.meta.url))
  const uploadRoute = characterAvatarUploadRoute(Promise.resolve(visuals), lifetime.signal, new URL('../characters/whale-girl.jpg', import.meta.url))
  const release = ctx.connection.fetch.register(route)
  const releaseUpload = ctx.connection.fetch.register(uploadRoute)
  t.after(async () => {
    lifetime.abort()
    await release(); await releaseUpload(); await connectionFork.dispose(); await visuals.close(); await characters.close()
    await domains.dispose(); await json.dispose(); await storage.dispose()
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep) && directory.includes('dsh-character-visual-test-'))
    await rm(directory, { recursive: true, force: true })
  })
  return { ctx, attachments, directory, characters, custom, visuals, route, uploadRoute, release, lifetime, connectionFork }
}

test('portrait domain defaults, isolation, durable uploads and resets preserve original role/session records', async t => {
  const { ctx, characters, custom, visuals, directory } = await setup(t)
  const original = await readFile(join(directory, 'dsh_character.json'), 'utf8')
  assert.equal(visuals.get(BUILTIN_WHALE_GIRL_ID).source, 'builtin')
  assert.deepEqual(visuals.get(custom.id), { characterId: custom.id, revision: 0, source: 'none', url: null })
  const saved = await visuals.upload(custom.id, 0, bytes, 'image/png', signal)
  assert.equal(saved.revision, 1)
  assert.equal(saved.source, 'upload')
  assert.deepEqual((await visuals.read(custom.id, 1, signal)), { data: bytes, mediaType: 'image/png' })
  assert.equal(visuals.get(BUILTIN_WHALE_GIRL_ID).revision, 0)
  await visuals.close()
  const reopened = await CharacterVisualStore.open(ctx, characters)
  try {
    assert.deepEqual(reopened.get(custom.id), saved)
    assert.equal((await reopened.reset(custom.id, 1, signal)).source, 'none')
    assert.equal(reopened.get(custom.id).revision, 2)
    await reopened.upload(BUILTIN_WHALE_GIRL_ID, 0, bytes, 'image/jpeg', signal)
    const reset = await reopened.reset(BUILTIN_WHALE_GIRL_ID, 1, signal)
    assert.equal(reset.source, 'builtin')
    assert.equal(reset.revision, 2)
    assert.equal(await readFile(join(directory, 'dsh_character.json'), 'utf8'), original)
    assert.equal(characters.getBinding('original-session')!.locked, true)
  } finally { await reopened.close() }
})

test('portrait CAS serializes concurrent writes and exposes only durable metadata', async t => {
  const { attachments, custom, visuals } = await setup(t)
  let unblock!: () => void
  const delayed = new Promise<void>(resolve => { unblock = resolve })
  attachments.validate(async () => delayed)
  const first = visuals.upload(custom.id, 0, bytes, 'image/png', signal)
  const second = visuals.upload(custom.id, 0, bytes, 'image/png', signal)
  assert.equal(visuals.get(custom.id).source, 'none')
  unblock()
  assert.equal((await first).revision, 1)
  await assert.rejects(second, hasCode('conflict'))
  assert.equal(attachments.saves, 1)
  await assert.rejects(visuals.reset(custom.id, 0, signal), hasCode('conflict'))
  await assert.rejects(visuals.read(custom.id, 0, signal), hasCode('conflict'))
})

test('metadata persistence failures retain the original portrait and recover without rewriting role data', async t => {
  const { visuals, custom, directory } = await setup(t)
  const saved = await visuals.upload(custom.id, 0, bytes, 'image/png', signal)
  const file = join(directory, 'dsh_character_visuals.json')
  const original = await readFile(file, 'utf8')
  await rename(file, `${file}.saved`)
  await mkdir(file)
  try {
    await assert.rejects(visuals.upload(custom.id, 1, new Uint8Array([4]), 'image/png', signal), hasCode('storage'))
    await assert.rejects(visuals.reset(custom.id, 1, signal), hasCode('storage'))
    assert.deepEqual(visuals.get(custom.id), saved)
    assert.equal(await readFile(`${file}.saved`, 'utf8'), original)
  } finally {
    await rmdir(file)
    await rename(`${file}.saved`, file)
  }
  assert.equal((await visuals.reset(custom.id, 1, signal)).revision, 2)
})

test('image policy respects host limits, rejects unsupported/empty/oversized input and delegates byte validation', async t => {
  const { attachments, visuals, custom } = await setup(t)
  assert.equal(visuals.maxBytes, CHARACTER_AVATAR_MAX_BYTES)
  attachments.service.imageLimits.maxImageBytes = 2
  assert.equal(visuals.maxBytes, 2)
  await assert.rejects(visuals.upload(custom.id, 0, bytes, 'image/png', signal), hasCode('invalid-request'))
  await assert.rejects(visuals.upload(custom.id, 0, new Uint8Array(), 'image/jpeg', signal), hasCode('invalid-request'))
  await assert.rejects(visuals.upload(custom.id, 0, new Uint8Array([1]), 'image/gif', signal), hasCode('invalid-request'))
  assert.equal(attachments.saves, 0)
  attachments.validate(async () => { throw new AttachmentError('invalid bytes or spoofed type', 'IMAGE_TYPE_MISMATCH') })
  await assert.rejects(visuals.upload(custom.id, 0, new Uint8Array([1]), 'image/png', signal), hasCode('invalid-request'))
  assert.equal(attachments.saves, 1)
  assert.equal(visuals.get(custom.id).revision, 0)
  attachments.validate(async () => { throw new AttachmentError('storage unavailable', 'ATTACHMENT_WRITE_FAILED') })
  await assert.rejects(visuals.upload(custom.id, 0, new Uint8Array([1]), 'image/png', signal), hasCode('storage'))
})

test('owner-only native exact routes serve builtin bytes, HEAD, uploads and known character identifiers', async t => {
  const { ctx, custom, visuals, attachments, release } = await setup(t)
  const transport = ctx.connection.createSharedFetchHandler('/api')
  const request = (method: string, id: string, query = '') => new Request(`http://localhost${CHARACTER_AVATAR_PATH}?characterId=${encodeURIComponent(id)}${query}`, { method })
  const denied = await transport.fetch(request('GET', BUILTIN_WHALE_GIRL_ID), { principal: { kind: 'shared-session' } } as never)
  assert.equal(denied.status, 403)
  const owner = ctx.connection.browserPeer
  const builtin = await transport.fetch(request('GET', BUILTIN_WHALE_GIRL_ID, '&revision=0'), owner)
  assert.equal(builtin.status, 200)
  assert.equal(builtin.headers.get('content-type'), 'image/jpeg')
  assert.deepEqual(new Uint8Array(await builtin.arrayBuffer()), new Uint8Array(await readFile(new URL('../characters/whale-girl.jpg', import.meta.url))))
  const head = await transport.fetch(request('HEAD', BUILTIN_WHALE_GIRL_ID), owner)
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  assert.ok(Number(head.headers.get('content-length')) > 0)
  const unknown = await transport.fetch(request('GET', '../../secret?attachmentId=private'), owner)
  assert.equal(unknown.status, 404)
  const post = new Request(`http://localhost${CHARACTER_AVATAR_UPLOAD_PATH}?characterId=${custom.id}&expectedRevision=0`, {
    method: 'POST', body: bytes, headers: { 'Content-Type': 'image/png' },
  })
  assert.equal((await transport.fetch(post, owner)).status, 200)
  assert.equal(visuals.get(custom.id).revision, 1)
  assert.equal(attachments.saves, 1)
  await release()
  assert.equal((await transport.fetch(request('GET', BUILTIN_WHALE_GIRL_ID), owner)).status, 404)
})

test('streaming requests enforce byte caps without Content-Length and report CAS and cancellation errors', async t => {
  const { uploadRoute: route, visuals, custom, attachments, lifetime } = await setup(t)
  attachments.service.imageLimits.maxImageBytes = 2
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes) },
    cancel() { cancelled = true },
  })
  const url = `http://localhost${CHARACTER_AVATAR_UPLOAD_PATH}?characterId=${custom.id}&expectedRevision=0`
  const oversized = new Request(url, { method: 'POST', body: stream, duplex: 'half', headers: { 'Content-Type': 'image/png' } } as RequestInit)
  assert.equal((await route.fetch(oversized)).status, 400)
  assert.equal(cancelled, true)
  assert.equal(attachments.saves, 0)
  await visuals.reset(custom.id, 0, signal)
  const stale = new Request(url, { method: 'POST', body: new Uint8Array([1]), headers: { 'Content-Type': 'image/png' } })
  const staleResponse = await route.fetch(stale)
  assert.equal(staleResponse.status, 409)
  assert.equal((await staleResponse.json()).error.code, 'conflict')
  lifetime.abort()
  assert.equal((await route.fetch(new Request(url))).status, 499)
  await visuals.close()
  await assert.rejects(visuals.reset(custom.id, 1, signal), hasCode('closed'))
})

test('real SDK Node HTTP bridge serves authenticated GET/HEAD without a body and streams POST on its own path', { timeout: 10_000 }, async t => {
  const ctx = new Context()
  const routes = new Map<string, { handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void> }>()
  let ready!: () => void
  const routeReady = new Promise<void>(resolve => { ready = resolve })
  let credential: unknown
  // Only credential persistence is replaced; authentication, route dispatch and
  // Node-to-Fetch bridging all execute the unmodified rc.2 Connection plugin.
  ctx.provide('credentials', { modifyRecord: async (_key: string, callback: (value: unknown) => Promise<unknown>) => {
    const updated = await callback(credential)
    if (updated !== undefined) credential = updated
    return credential
  } } as never)
  ctx.provide('webServer', {
    protocol: 'http:', host: '127.0.0.1',
    register(route: { path: string; handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void> }) {
      routes.set(route.path, route)
      if (route.path === '/api') ready()
      return async () => { routes.delete(route.path) }
    },
  } as never)
  const server = createServer((request, response) => {
    const route = routes.get(request.url?.startsWith('/api/') ? '/api' : request.url?.split('?')[0] ?? '/')
    if (route) {
      Promise.resolve(route.handler(request, response)).catch(() => { response.statusCode = 500; response.end() })
    } else if (ctx.connection.authorizeIndex(request, response)) { response.statusCode = 200; response.end('ready') }
  })
  const fork = ctx.plugin(Connection); await fork
  const lifetime = new AbortController()
  let uploaded: Uint8Array | undefined
  const visual = { characterId: BUILTIN_WHALE_GIRL_ID, revision: 0, source: 'builtin', url: '/unused' }
  const store = {
    maxBytes: 100,
    get: () => visual,
    read: async () => 'builtin',
    upload: async (_id: string, _revision: number, data: Uint8Array) => { uploaded = data; return { ...visual, revision: 1, source: 'upload' } },
  } as unknown as CharacterVisualStore
  const builtin = new URL('../characters/whale-girl.jpg', import.meta.url)
  const releaseRead = ctx.connection.fetch.register(characterAvatarRoute(Promise.resolve(store), lifetime.signal, builtin))
  const releaseWrite = ctx.connection.fetch.register(characterAvatarUploadRoute(Promise.resolve(store), lifetime.signal, builtin))
  t.after(async () => {
    lifetime.abort(); await releaseRead(); await releaseWrite(); await fork.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  await routeReady
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/`
  const login = await fetch(ctx.connection.authenticatedUrl(base), { redirect: 'manual' })
  assert.equal(login.status, 303)
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const url = new URL(`${CHARACTER_AVATAR_PATH}?characterId=${encodeURIComponent(BUILTIN_WHALE_GIRL_ID)}&revision=0`, base)
  assert.equal((await fetch(url)).status, 401)
  const image = await fetch(url, { headers: { Cookie: cookie } })
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/jpeg')
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), new Uint8Array(await readFile(builtin)))
  const head = await fetch(url, { method: 'HEAD', headers: { Cookie: cookie } })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  const post = await fetch(new URL(`${CHARACTER_AVATAR_UPLOAD_PATH}?characterId=${encodeURIComponent(BUILTIN_WHALE_GIRL_ID)}&expectedRevision=0`, base), {
    method: 'POST', body: bytes, headers: { Cookie: cookie, 'Content-Type': 'image/png' },
  })
  assert.equal(post.status, 200)
  assert.deepEqual(uploaded, bytes)
})
