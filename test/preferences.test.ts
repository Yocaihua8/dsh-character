import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { CharacterStore, CharacterError } from '../src/host/store.js'
import { CharacterPreferences } from '../src/host/preferences.js'
import { EMPTY_CHARACTER_FIELDS } from '../src/shared/types.js'

const hasCode = (code: string) => (error: unknown) => error instanceof CharacterError && error.code === code

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-character-preferences-test-'))
  const ctx = new Context()
  const storage = ctx.plugin(Storage); await storage
  const json = ctx.plugin(StorageJson, { root: directory }); await json
  const domain = ctx.plugin(StorageDomain, { backend: 'json' }); await domain
  const characters = await CharacterStore.open(ctx)
  const first = await characters.save({ fields: { ...EMPTY_CHARACTER_FIELDS, name: '第一位角色' } })
  const second = await characters.save({ fields: { ...EMPTY_CHARACTER_FIELDS, name: '第二位角色' } })
  await characters.bind('existing-session', first.id)
  await characters.lock('existing-session')
  const preferences = await CharacterPreferences.open(ctx, characters)
  t.after(async () => {
    await preferences.close(); await characters.close(); await domain.dispose(); await json.dispose(); await storage.dispose()
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep) && directory.includes('dsh-character-preferences-test-'))
    await rm(directory, { recursive: true, force: true })
  })
  return { ctx, characters, preferences, first, second, directory, file: join(directory, 'dsh_character_preferences.json') }
}

test('default role starts unset and persists independently without changing role revisions or old bindings', async t => {
  const { ctx, characters, preferences, first, second, directory, file } = await setup(t)
  const roleBytes = await readFile(join(directory, 'dsh_character.json'), 'utf8')
  assert.deepEqual(preferences.get(), { characterId: null, revision: 0, character: null, unavailableReason: '' })
  assert.equal(preferences.forNewSession(), undefined)
  const saved = await preferences.set(second.id, 0)
  assert.deepEqual(saved, { characterId: second.id, revision: 1, character: second, unavailableReason: '' })
  saved.character!.name = '不允许改写持久资料'
  assert.equal(preferences.forNewSession()!.name, second.name)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).tables.settings.default, { characterId: second.id, revision: 1 })
  await preferences.close()
  const reopened = await CharacterPreferences.open(ctx, characters)
  try {
    assert.equal(reopened.get().characterId, second.id)
    assert.equal(reopened.get().revision, 1)
    assert.equal(reopened.forNewSession()!.id, second.id)
    assert.deepEqual(await reopened.set(null, 1), { characterId: null, revision: 2, character: null, unavailableReason: '' })
    assert.equal(reopened.forNewSession(), undefined)
  } finally { await reopened.close() }
  assert.equal(await readFile(join(directory, 'dsh_character.json'), 'utf8'), roleBytes)
  assert.deepEqual(characters.getBinding('existing-session'), { sessionId: 'existing-session', characterId: first.id, locked: true })
})

test('concurrent default edits use CAS; invalid or archived candidates never replace the saved setting', async t => {
  const { characters, preferences, first, second } = await setup(t)
  const edits = await Promise.allSettled([preferences.set(first.id, 0), preferences.set(second.id, 0)])
  assert.equal(edits[0]!.status, 'fulfilled')
  assert.equal(edits[1]!.status, 'rejected')
  if (edits[1]!.status === 'rejected') assert.ok(hasCode('conflict')(edits[1]!.reason))
  assert.equal(preferences.get().characterId, first.id)
  await assert.rejects(preferences.set(second.id, 0), hasCode('conflict'))
  await assert.rejects(preferences.set('missing', 1), hasCode('not-found'))
  await characters.archive(second.id, second.revision)
  await assert.rejects(preferences.set(second.id, 1), hasCode('archived'))
  for (const id of ['', ' ', 123, undefined]) await assert.rejects(preferences.set(id as string, 1), hasCode('invalid-request'))
  for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN]) await assert.rejects(preferences.set(null, revision), hasCode('invalid-request'))
  assert.equal(preferences.get().revision, 1)
})

test('JSON persistence failure leaves the current default visible and a later retry succeeds', async t => {
  const { preferences, first, second, file } = await setup(t)
  const saved = await preferences.set(first.id, 0)
  const bytes = await readFile(file, 'utf8')
  await rename(file, `${file}.saved`)
  await mkdir(file)
  try {
    await assert.rejects(preferences.set(second.id, 1), hasCode('storage'))
    await assert.rejects(preferences.set(null, 1), hasCode('storage'))
    assert.deepEqual(preferences.get(), saved)
    assert.equal(await readFile(`${file}.saved`, 'utf8'), bytes)
  } finally { await rmdir(file); await rename(`${file}.saved`, file) }
  assert.equal((await preferences.set(second.id, 1)).revision, 2)
})

test('archived and missing defaults remain explicit settings but stop providing roles for new sessions', async t => {
  const { ctx, characters, preferences, first, second } = await setup(t)
  await preferences.set(first.id, 0)
  const archived = await characters.archive(first.id, first.revision)
  assert.equal(preferences.get().characterId, first.id)
  assert.deepEqual(preferences.get().character, archived)
  assert.match(preferences.get().unavailableReason, /归档/)
  assert.equal(preferences.forNewSession(), undefined)
  assert.equal(characters.getBinding('existing-session')!.characterId, first.id)
  await preferences.set(second.id, 1)
  // Represents a separately removed role record, not an automatic preference reset.
  await ctx.storageDomain.get('dsh_character')!.table('characters').delete(second.id)
  assert.equal(preferences.get().characterId, second.id)
  assert.equal(preferences.get().revision, 2)
  assert.equal(preferences.get().character, null)
  assert.match(preferences.get().unavailableReason, /不存在/)
  assert.equal(preferences.forNewSession(), undefined)
  assert.equal((await preferences.set(null, 2)).revision, 3)
})

test('strict preference storage rejects extra fields, wrong versions and malformed records without rewriting data', async t => {
  const { ctx, characters, preferences, first, file } = await setup(t)
  await preferences.set(first.id, 0)
  await preferences.close()
  const original = JSON.parse(await readFile(file, 'utf8'))
  for (const mutate of [
    (value: any) => { value.tables.settings.default.extra = 'unexpected' },
    (value: any) => { value.tables.settings.default.revision = -1 },
    (value: any) => { value.tables.settings.default.characterId = ' ' },
    (value: any) => { value.unit.version = 2 },
  ]) {
    const data = structuredClone(original)
    mutate(data)
    const invalid = JSON.stringify(data)
    await writeFile(file, invalid)
    await assert.rejects(CharacterPreferences.open(ctx, characters), hasCode('storage'))
    assert.equal(await readFile(file, 'utf8'), invalid)
    assert.equal(characters.get(first.id).name, first.name)
  }
  await writeFile(file, JSON.stringify(original))
  const reopened = await CharacterPreferences.open(ctx, characters)
  try { assert.equal(reopened.get().characterId, first.id) } finally { await reopened.close() }
})

test('preference shutdown drains accepted saves, refuses later writes and frees the domain for reload', async t => {
  const { ctx, characters, preferences, first } = await setup(t)
  const accepted = preferences.set(first.id, 0)
  const closing = preferences.close()
  await assert.rejects(preferences.set(null, 0), hasCode('closed'))
  assert.equal((await accepted).revision, 1)
  await closing
  assert.equal(ctx.storageDomain.get('dsh_character_preferences'), undefined)
  const reopened = await CharacterPreferences.open(ctx, characters)
  try { assert.equal(reopened.get().characterId, first.id) } finally { await reopened.close() }
})
