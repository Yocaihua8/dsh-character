import { readFile } from 'node:fs/promises'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { CHARACTER_AVATAR_PATH, CHARACTER_AVATAR_UPLOAD_PATH } from '../shared/visuals.js'
import { CharacterError } from './store.js'
import type { CharacterVisualStore } from './visuals.js'

function revision(value: string | null, required: boolean): number | undefined {
  if (value === null && !required) return undefined
  if (value === null || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new CharacterError('invalid-request', '图片修订号无效。')
  }
  return Number(value)
}

/** The streaming route bounds memory before image decoding, even without Content-Length. */
async function readBody(request: Request, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw new CharacterError('invalid-request', `图片大小不能超过 ${limit} 字节。`)
  }
  if (!request.body) throw new CharacterError('invalid-request', '请选择图片。')
  const reader = request.body.getReader()
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const result = await reader.read()
      signal.throwIfAborted()
      if (result.done) break
      size += result.value.byteLength
      if (size > limit) throw new CharacterError('invalid-request', `图片大小不能超过 ${limit} 字节。`)
      chunks.push(result.value)
    }
    const data = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
    return data
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Register only through ctx.connection.fetch: the carrier authenticates and admits owner peers. */
export function characterAvatarRoute(
  ready: Promise<CharacterVisualStore>,
  lifetime: AbortSignal,
  builtin: URL,
): ConnectionFetchRoute {
  return avatarRoute(ready, lifetime, builtin, false)
}

export function characterAvatarUploadRoute(
  ready: Promise<CharacterVisualStore>,
  lifetime: AbortSignal,
  builtin: URL,
): ConnectionFetchRoute {
  return avatarRoute(ready, lifetime, builtin, true)
}

function avatarRoute(ready: Promise<CharacterVisualStore>, lifetime: AbortSignal, builtin: URL, upload: boolean): ConnectionFetchRoute {
  return {
    // rc.2's Node bridge attaches a body to every streaming route, even GET/HEAD.
    // Use distinct exact paths because the registry owns paths, not path-method pairs.
    path: upload ? CHARACTER_AVATAR_UPLOAD_PATH : CHARACTER_AVATAR_PATH,
    methods: upload ? ['POST'] : ['GET', 'HEAD'], requestBody: upload ? 'streaming' : 'buffered',
    async fetch(request) {
      const signal = AbortSignal.any([request.signal, lifetime])
      try {
        signal.throwIfAborted()
        const store = await ready
        signal.throwIfAborted()
        const url = new URL(request.url)
        const characterId = url.searchParams.get('characterId')
        if (!characterId) throw new CharacterError('invalid-request', '请指定角色。')
        if (request.method === 'POST') {
          const expected = revision(url.searchParams.get('expectedRevision'), true)!
          const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
          // Verify the character before accepting or persisting any binary object.
          store.get(characterId)
          const data = await readBody(request, store.maxBytes, signal)
          const visual = await store.upload(characterId, expected, data, mediaType, signal)
          return Response.json(visual, { headers: { 'Cache-Control': 'no-store' } })
        }
        const stored = await store.read(characterId, revision(url.searchParams.get('revision'), false), signal)
        const data = stored === 'builtin' ? await readFile(builtin, { signal }) : stored.data
        signal.throwIfAborted()
        return new Response(request.method === 'HEAD' ? null : new Uint8Array(data), { headers: {
          'Content-Type': stored === 'builtin' ? 'image/jpeg' : stored.mediaType,
          'Content-Length': String(data.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
        } })
      } catch (error) {
        const code = signal.aborted ? 'cancelled' : error instanceof CharacterError ? error.code : 'storage'
        const message = signal.aborted ? '图片操作已取消。' : error instanceof CharacterError ? error.message : '角色图片操作失败，请重试。'
        const status = code === 'conflict' ? 409 : code === 'not-found' ? 404 : code === 'invalid-request' ? 400 : code === 'cancelled' ? 499 : code === 'closed' ? 503 : 500
        return Response.json({ error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store' } })
      }
    },
  }
}
