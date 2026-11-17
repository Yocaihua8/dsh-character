import test from 'node:test'
import assert from 'node:assert/strict'
import { GrowthController, GrowthNotices, growthPresentation, type GrowthRpc } from '../src/client/growth-controller.js'
import type { GrowthStatus, GrowthEntry } from '../src/shared/growth.js'
import type { RemoteResult } from '../src/client/controller.js'

const entry: GrowthEntry = { id: 'entry', kind: 'interaction', content: '先给结论', reason: '用户长期纠正', manual: false, sources: [] }
const status = (): GrowthStatus => ({
  state: { characterId: 'whale', revision: 1, epoch: 0, baseRevision: 1, enabled: true, learning: true, since: 1, entries: [], history: [], rounds: [], progress: {}, barriers: {}, pending: 0, lastRoundAt: 0, status: '' },
  config: { revision: 1, model: { provider: 'provider', model: 'flash', reasoningEffort: 'low' } },
  applied: false, message: '已开启：从新建的本人主聊天积累成长。 兼容模式：校验本人主聊天来源；无法保证自动化派生会话永久排除。',
  models: [{ provider: 'provider', model: 'flash', label: 'Flash', efforts: ['low', 'high'] }],
})
const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value: structuredClone(value) })
const conflict = (): RemoteResult<never> => ({ ok: false, error: { message: 'conflict', details: { reason: 'revision-conflict' } } })
function fixture() {
  let value = status()
  const writes: unknown[] = []
  const rpc: GrowthRpc = {
    getGrowth: async () => ok(value),
    configureGrowth: async config => { writes.push(config); if (config.revision !== value.config.revision) return conflict(); value.config = { ...config, revision: config.revision + 1 }; return ok(value.config) },
    changeGrowth: async request => { writes.push(request); if (request.expectedRevision !== value.state.revision) return conflict(); value.state.revision++; if (request.action === 'correct') value.state.entries = value.state.entries.map(item => item.id === request.entryId ? { ...item, content: request.content!, manual: true } : item); return ok(value.state) },
    registerGrowthSession: async () => ok(true),
  }
  return { rpc, writes, value, controller: new GrowthController(rpc) }
}
test('enabled with no entries is waiting, not failure; compatibility stays separate', () => {
  const view = growthPresentation(status(), 1)
  assert.equal(view.title, '已开启，等待新聊天'); assert.equal(view.problem, false); assert.equal(view.retry, false)
  assert.match(view.compatibility, /兼容模式/); assert.doesNotMatch(view.description, /兼容模式/)
})
test('growth status distinguishes paused, off, unavailable, revalidation and failures', () => {
  const value = status(); value.state.learning = false; value.message = '学习已暂停，继续使用已有成长。'
  assert.equal(growthPresentation(value, 1).title, '学习已暂停')
  value.state.enabled = false; assert.equal(growthPresentation(value, 1).title, '成长已关闭')
  value.state.enabled = true; value.models = []; assert.equal(growthPresentation(value, 1).title, '整理模型不可用'); assert.equal(growthPresentation(value, 1).retry, false)
  value.models = status().models; assert.equal(growthPresentation(value, 2).title, '等待人设重新核验')
  value.message = '模型请求超时，原状态保留。'; assert.equal(growthPresentation(value, 1).retry, true)
})
test('normal empty extraction is not an error and existing entries remain applied', () => {
  const value = status(); value.state.entries = [entry]; value.applied = true; value.message = '本批没有通过核验的成长，已有表现保持不变。'
  assert.equal(growthPresentation(value, 1).problem, false); assert.equal(growthPresentation(value, 1).title, '已有成长')
})
test('active fallback is a notice instead of a failure while total outage stays a problem', () => {
  const value = status(); value.models = []; value.usingFallback = true
  value.message = '已开启：从新建的本人主聊天积累成长。 固定整理模型当前不可用，已回退使用主聊天模型整理；恢复后自动切回。'
  const view = growthPresentation(value, 1)
  assert.equal(view.title, '已回退主聊天模型整理'); assert.equal(view.problem, false); assert.equal(view.retry, false)
  assert.match(view.description, /主聊天模型/)
  value.usingFallback = false
  assert.equal(growthPresentation(value, 1).title, '整理模型不可用'); assert.equal(growthPresentation(value, 1).problem, true)
})
test('composer shows only new history or genuine problems, acknowledgment clears changes', () => {
  const notice = new GrowthNotices(), value = status()
  assert.equal(notice.read(value, 1), '')
  value.state.history.push({ revision: 2, time: 2, before: [], after: [entry], reason: 'learned' })
  assert.equal(notice.read(value, 1), '成长有新变化')
  notice.acknowledge('whale'); assert.equal(notice.read(value, 1), '')
  value.message = '模型请求失败'; assert.equal(notice.read(value, 1), '成长需要关注')
  value.state.enabled = false; assert.equal(notice.read(value, 1), '')
})
test('an initial existing growth snapshot is not falsely advertised as a new update', () => {
  const value = status(); value.state.history.push({ revision: 8, time: 8, before: [], after: [entry], reason: 'previous' })
  assert.equal(new GrowthNotices().read(value, 1), '')
})
test('model draft keeps its original revision across refresh and conflicts until explicit rebase', async () => {
  const { controller, value, writes } = fixture()
  await controller.refresh('whale'); controller.openModel(); controller.editModel({ provider: 'provider', model: 'flash', reasoningEffort: 'high' })
  value.config.revision = 2; await controller.refresh('whale')
  assert.equal(controller.modelDraft?.revision, 1)
  assert.equal(await controller.saveModel('whale'), false); assert.equal(controller.conflict, true)
  assert.equal(controller.modelDraft?.model?.reasoningEffort, 'high'); assert.equal(value.config.model?.reasoningEffort, 'low')
  await controller.refresh('whale', true); assert.equal(await controller.saveModel('whale'), true)
  assert.equal(value.config.model?.reasoningEffort, 'high'); assert.equal(controller.modelDraft, undefined); assert.equal(writes.length, 2)
})
test('correction conflict retains draft and saved entry; explicit refresh can retry', async () => {
  const { controller, value } = fixture(); value.state.entries = [entry]
  await controller.refresh('whale'); controller.editEntry('whale', entry); controller.editText('先给简短结论')
  value.state.revision = 2; await controller.refresh('whale')
  assert.equal(await controller.correct(), false); assert.equal(value.state.entries[0].content, entry.content)
  assert.equal(controller.editing?.text, '先给简短结论'); assert.equal(controller.editing?.revision, 1)
  await controller.refresh('whale', true); assert.equal(await controller.correct(), true)
  assert.equal(value.state.entries[0].manual, true); assert.equal(controller.editing, undefined)
})
test('transport failure preserves model selection and stored records', async () => {
  const { controller, rpc, value } = fixture(); await controller.refresh('whale'); controller.openModel()
  controller.editModel({ provider: 'provider', model: 'flash', reasoningEffort: 'high' })
  rpc.configureGrowth = async () => { throw new Error('disk full') }
  assert.equal(await controller.saveModel('whale'), false); assert.match(controller.error, /disk full/)
  assert.equal(controller.modelDirty, true); assert.equal(value.config.model?.reasoningEffort, 'low')
})
test('detached view retains draft and receives save result after resubscribe', async () => {
  const { controller, value } = fixture(); value.state.entries = [entry]; await controller.refresh('whale')
  const detach = controller.subscribe(() => {}); controller.editEntry('whale', entry); controller.editText('先结论后细节'); detach()
  assert.equal(controller.dirty, true); assert.equal(await controller.correct(), true)
  assert.equal(controller.status('whale')?.state.entries[0].content, '先结论后细节')
})
test('late reads canceled by a write cannot overwrite the newly saved state', async () => {
  const { controller, rpc, value } = fixture(); value.state.entries = [entry]; await controller.refresh('whale')
  let resolve!: (value: RemoteResult<GrowthStatus>) => void
  rpc.getGrowth = () => new Promise(done => { resolve = done })
  const stale = structuredClone(value), reading = controller.refresh('whale')
  controller.editEntry('whale', entry); controller.editText('saved')
  rpc.getGrowth = async () => ok(value)
  await controller.correct(); resolve(ok(stale)); await reading
  assert.equal(controller.status('whale')?.state.entries[0].content, 'saved')
})
test('disposal ignores a late write and clears subscriptions', async () => {
  const { controller, rpc } = fixture(); await controller.refresh('whale'); controller.openModel(); controller.editModel({ provider: 'provider', model: 'flash', reasoningEffort: 'high' })
  let resolve!: (value: RemoteResult<GrowthStatus['config']>) => void
  rpc.configureGrowth = () => new Promise(done => { resolve = done })
  const writing = controller.saveModel('whale'); controller.dispose()
  resolve(ok({ revision: 2, model: { provider: 'provider', model: 'flash', reasoningEffort: 'high' } }))
  assert.equal(await writing, false); assert.equal(controller.config?.revision, 1)
})
