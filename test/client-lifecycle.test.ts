import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { Context, Service } from '@deepseek-ai/cordis'

test('browser bundle mounts settings and composer slots, then removes slots, styles and RPC', async () => {
  const require = createRequire(import.meta.url)
  let client!: { apply: (ctx: Context) => unknown; inject: string[] }
  const state = { remote: 0, slots: 0, styles: 0 }
  const names: string[] = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition: { id: string; factory: (require: (name: string) => unknown) => typeof client }) => {
      assert.equal(definition.id, 'dsh-character')
      client = definition.factory(name => name === '@deepseek-ai/dsh-client-ui-primitives' ? {} : require(name))
    } } },
    document: { createElement: () => ({ dataset: {}, textContent: '', remove: () => { state.styles-- } }), head: { append: () => { state.styles++ } } },
  }
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox)
  assert.ok(client)
  const ctx = new Context()
  class SlotsFixture extends Service {
    constructor(ctx: Context) { super(ctx, 'slots') }
    inject(_name: string, callback: () => () => void) { return this.ctx.effect(callback) }
    register(options: { name: string; id: string; label?: () => string }) {
      names.push(options.name); assert.equal(options.id, 'dsh-character')
      if (options.name === 'settings.section') assert.equal(options.label?.(), '角色')
      state.slots++
      return () => { state.slots-- }
    }
  }
  const slots = ctx.plugin(SlotsFixture); await slots
  ctx.provide('sessions', {})
  ctx.provide('remote.characters', {})
  ctx.provide('remote', { $mount: async (contribution: { package: string }) => {
    assert.equal(contribution.package, 'dsh-character'); state.remote++
    return () => { state.remote-- }
  } })
  const plugin = ctx.plugin(client); await plugin
  assert.deepEqual(names, ['settings.section', 'conversation.input.right'])
  assert.deepEqual(state, { remote: 1, slots: 2, styles: 1 })
  await plugin.dispose()
  assert.deepEqual(state, { remote: 0, slots: 0, styles: 0 })
  await slots.dispose()
})
