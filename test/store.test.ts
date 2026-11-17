import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rename, mkdir, rmdir, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { CharacterStore, CharacterError } from '../src/host/store.js'
import { BUILTIN_WHALE_GIRL_ID, BUILTIN_WHALE_GIRL_FIELDS } from '../src/host/builtins.js'
import { EMPTY_CHARACTER_FIELDS, type CharacterFields } from '../src/shared/types.js'

const fields = (name: string, extra: Partial<CharacterFields> = {}): CharacterFields => ({ ...EMPTY_CHARACTER_FIELDS, name, ...extra })
const hasCode = (code: string) => (error: unknown) => error instanceof CharacterError && error.code === code

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-character-test-'))
  const ctx = new Context()
  const storage = ctx.plugin(Storage)
  await storage
  const json = ctx.plugin(StorageJson, { root: directory })
  await json
  const domains = ctx.plugin(StorageDomain, { backend: 'json' })
  await domains
  const store = await CharacterStore.open(ctx)
  t.after(async () => {
    await domains.dispose()
    await json.dispose()
    await storage.dispose()
    const cleanupPath = resolve(directory)
    assert.ok(cleanupPath.startsWith(resolve(tmpdir()) + sep) && cleanupPath.includes('dsh-character-test-'))
    await rm(cleanupPath, { recursive: true, force: true })
  })
  return { ctx, store, file: join(directory, 'dsh_character.json') }
}

test('built-in character initializes durably once, including concurrent and repeated initialization', async t => {
  const { store, file } = await setup(t)
  assert.deepEqual(store.list(), [])
  await Promise.all(Array.from({ length: 4 }, () => store.ensureBuiltinCharacters()))
  const expected = { ...BUILTIN_WHALE_GIRL_FIELDS, id: BUILTIN_WHALE_GIRL_ID, revision: 1, archived: false }
  assert.deepEqual(store.list(), [expected])
  const persisted = await readFile(file, 'utf8')
  assert.deepEqual(JSON.parse(persisted).tables.characters[BUILTIN_WHALE_GIRL_ID], expected)
  await store.ensureBuiltinCharacters()
  assert.deepEqual(store.list(), [expected])
  assert.equal(await readFile(file, 'utf8'), persisted)
  assert.deepEqual(await store.bind('builtin-session', BUILTIN_WHALE_GIRL_ID), {
    sessionId: 'builtin-session', characterId: BUILTIN_WHALE_GIRL_ID, locked: false,
  })
})

test('built-in initialization preserves user edits, archives, existing characters and bindings across reopen', async t => {
  const { ctx, store, file } = await setup(t)
  const custom = await store.save({ fields: fields(BUILTIN_WHALE_GIRL_FIELDS.name, { identity: '用户原有的同名角色' }) })
  await store.bind('custom-session', custom.id)
  await store.lock('custom-session')
  const customBinding = store.getBinding('custom-session')
  await store.ensureBuiltinCharacters()
  assert.deepEqual(store.get(custom.id), custom)
  assert.deepEqual(store.getBinding('custom-session'), customBinding)
  await store.bind('builtin-session', BUILTIN_WHALE_GIRL_ID)
  await store.lock('builtin-session')
  const edited = await store.save({
    id: BUILTIN_WHALE_GIRL_ID, expectedRevision: 1,
    fields: fields('用户改名的小鲸', { style: '用户自己的表达方式' }),
  })
  const archived = await store.archive(edited.id, edited.revision)
  const builtinBinding = store.getBinding('builtin-session')
  const persisted = await readFile(file, 'utf8')
  await store.ensureBuiltinCharacters()
  assert.deepEqual(store.get(BUILTIN_WHALE_GIRL_ID), archived)
  await store.close()
  const reopened = await CharacterStore.open(ctx)
  await reopened.ensureBuiltinCharacters()
  assert.equal(reopened.list().length, 2)
  assert.deepEqual(reopened.get(BUILTIN_WHALE_GIRL_ID), archived)
  assert.deepEqual(reopened.get(custom.id), custom)
  assert.deepEqual(reopened.getBinding('custom-session'), customBinding)
  assert.deepEqual(reopened.getBinding('builtin-session'), builtinBinding)
  assert.equal(await readFile(file, 'utf8'), persisted)
  await assert.rejects(reopened.bind('new-session', BUILTIN_WHALE_GIRL_ID), hasCode('archived'))
})

test('failed built-in persistence reports failure without exposing a phantom character and can be retried', async t => {
  const { store, file } = await setup(t)
  const custom = await store.save({ fields: fields('原有角色') })
  const persisted = await readFile(file, 'utf8')
  await rename(file, `${file}.saved`)
  await mkdir(file)
  await assert.rejects(store.ensureBuiltinCharacters(), hasCode('storage'))
  assert.deepEqual(store.list(), [custom])
  assert.throws(() => store.get(BUILTIN_WHALE_GIRL_ID), hasCode('not-found'))
  assert.equal(await readFile(`${file}.saved`, 'utf8'), persisted)
  await rmdir(file)
  await rename(`${file}.saved`, file)
  await store.ensureBuiltinCharacters()
  assert.deepEqual(store.get(custom.id), custom)
  assert.equal(store.get(BUILTIN_WHALE_GIRL_ID).revision, 1)
  assert.equal(store.list().length, 2)
})

test('characters and fixed bindings persist through close/reopen with detached read values', async t => {
  const { ctx, store } = await setup(t)
  const character = await store.save({ fields: fields('  青禾  ', { identity: '  知识向导  ' }) })
  assert.equal(character.name, '青禾')
  assert.equal(character.identity, '知识向导')
  assert.equal(character.revision, 1)
  character.name = '不能改写存储'
  const listed = store.list()
  listed[0]!.style = '不能改写存储'
  await store.bind('session:one', character.id)
  await store.lock('session:one')
  const binding = store.getBinding('session:one')!
  binding.characterId = '不能改写存储'
  await store.close()
  const reopened = await CharacterStore.open(ctx)
  assert.equal(reopened.get(character.id).name, '青禾')
  assert.equal(reopened.get(character.id).style, '')
  assert.deepEqual(reopened.getBinding('session:one'), { sessionId: 'session:one', characterId: character.id, locked: true })
  await assert.rejects(reopened.bind('session:one', character.id), hasCode('locked'))
})

test('validation trims fields, accepts the exact total limit, and refuses invalid or excessive character data', async t => {
  const { store } = await setup(t)
  await store.save({ fields: fields('名', { background: '字'.repeat(15_999) }) })
  for (const invalid of [fields('   '), fields('名'.repeat(81)), fields('名', { identity: '字'.repeat(16_000) })]) {
    await assert.rejects(store.save({ fields: invalid }), hasCode('invalid-request'))
  }
  await assert.rejects(store.save({ fields: { ...fields('普通'), extra: '不保存' } as CharacterFields }), hasCode('invalid-request'))
  await assert.rejects(store.save({ expectedRevision: 1, fields: fields('普通') }), hasCode('invalid-request'))
  assert.equal(store.list().length, 1)
})

test('concurrent edits use revision CAS and stale archive requests cannot overwrite newer characters', async t => {
  const { store } = await setup(t)
  const first = await store.save({ fields: fields('青禾') })
  const edits = await Promise.allSettled([
    store.save({ id: first.id, expectedRevision: 1, fields: fields('青禾甲') }),
    store.save({ id: first.id, expectedRevision: 1, fields: fields('青禾乙') }),
  ])
  assert.equal(edits.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = edits.find(result => result.status === 'rejected') as PromiseRejectedResult
  assert.ok(hasCode('conflict')(rejected.reason))
  assert.equal(store.get(first.id).revision, 2)
  await assert.rejects(store.archive(first.id, 1), hasCode('conflict'))
  const archived = await store.archive(first.id, 2)
  assert.equal(archived.revision, 3)
  assert.deepEqual(await store.archive(first.id, 3), archived)
  await assert.rejects(store.archive(first.id, 2), hasCode('conflict'))
  const edited = await store.save({ id: first.id, expectedRevision: 3, fields: fields('归档后修订') })
  assert.equal(edited.archived, true)
  assert.equal(edited.revision, 4)
})

test('binding replacement and locking serialize; archive retains bound characters and fork inheritance', async t => {
  const { store } = await setup(t)
  const first = await store.save({ fields: fields('青禾') })
  const second = await store.save({ fields: fields('明川') })
  await store.bind('one', first.id)
  const [replacement, locked] = await Promise.all([store.bind('one', second.id), store.lock('one')])
  assert.equal(replacement.characterId, second.id)
  assert.equal(locked?.locked, true)
  await assert.rejects(store.bind('one', first.id), hasCode('locked'))
  await store.bind('two', first.id)
  const [lockResult, bindResult] = await Promise.allSettled([store.lock('two'), store.bind('two', second.id)])
  assert.equal(lockResult.status, 'fulfilled')
  assert.equal(bindResult.status, 'rejected')
  if (bindResult.status === 'rejected') assert.ok(hasCode('locked')(bindResult.reason))
  await store.archive(second.id, second.revision)
  await assert.rejects(store.bind('new', second.id), hasCode('archived'))
  assert.equal(store.get(store.getBinding('one')!.characterId).archived, true)
  assert.deepEqual(await store.inherit('fork', 'one'), { sessionId: 'fork', characterId: second.id, locked: true })
  assert.deepEqual(await store.inherit('two', 'one'), store.getBinding('two'))
  assert.equal(await store.lock('unbound'), undefined)
  assert.equal(await store.inherit('without-parent', 'unbound'), undefined)
  assert.throws(() => store.get('missing'), hasCode('not-found'))
  await assert.rejects(store.bind('missing-character', 'missing'), hasCode('not-found'))
})

test('a real JSON backend write failure leaves memory unchanged and the next save can succeed', async t => {
  const { store, file } = await setup(t)
  const original = await store.save({ fields: fields('青禾') })
  const before = await readFile(file, 'utf8')
  await rename(file, `${file}.saved`)
  await mkdir(file)
  await assert.rejects(store.save({ id: original.id, expectedRevision: 1, fields: fields('失败保存') }), hasCode('storage'))
  assert.deepEqual(store.get(original.id), original)
  assert.equal(await readFile(`${file}.saved`, 'utf8'), before)
  await rmdir(file)
  await rename(`${file}.saved`, file)
  const retried = await store.save({ id: original.id, expectedRevision: 1, fields: fields('重试成功') })
  assert.equal(retried.revision, 2)
  assert.equal(retried.name, '重试成功')
})

test('corrupt or schema-invalid authoritative data refuses to open without clearing or skipping records', async t => {
  const { ctx, store, file } = await setup(t)
  const character = await store.save({ fields: fields('青禾') })
  await store.close()
  const document = JSON.parse(await readFile(file, 'utf8'))
  document.tables.characters[character.id].revision = 'broken'
  const invalid = JSON.stringify(document)
  await writeFile(file, invalid)
  await assert.rejects(CharacterStore.open(ctx), hasCode('storage'))
  assert.equal(await readFile(file, 'utf8'), invalid)
  await writeFile(file, '{ broken json')
  await assert.rejects(CharacterStore.open(ctx), hasCode('storage'))
  assert.equal(await readFile(file, 'utf8'), '{ broken json')
})

test('closing drains already accepted mutations, rejects later writes, and allows a clean reopen', async t => {
  const { ctx, store } = await setup(t)
  const accepted = store.save({ fields: fields('先入队') })
  const closing = store.close()
  await assert.rejects(store.save({ fields: fields('不能入队') }), hasCode('closed'))
  const saved = await accepted
  await closing
  await store.close()
  const reopened = await CharacterStore.open(ctx)
  assert.equal(reopened.get(saved.id).name, '先入队')
  assert.equal(reopened.list().length, 1)
})
