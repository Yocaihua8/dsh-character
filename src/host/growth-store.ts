import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { Character } from '../shared/types.js'
import type { GrowthChange, GrowthConfig, GrowthEntry, GrowthRound, GrowthState } from '../shared/growth.js'
import { CharacterError } from './store.js'

const int = z.number().int().nonnegative()
const source = z.strictObject({ roundId: z.string(), sessionId: z.string(), seq: int, quote: z.string().max(2000) })
export const growthEntrySchema = z.strictObject({ id: z.string().min(1).max(100), kind: z.enum(['personality', 'interaction', 'experience']),
  content: z.string().trim().min(1).max(600), reason: z.string().max(1000), sources: z.array(source).max(12), manual: z.boolean() })
const entries = z.array(growthEntrySchema).max(24)
const configSchema = z.strictObject({ revision: int, model: z.strictObject({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().optional() }).nullable(),
  fallbackToMain: z.boolean().optional() })
const stateSchema = z.strictObject({ characterId: z.string(), revision: int, epoch: int, baseRevision: int,
  enabled: z.boolean(), learning: z.boolean(), since: int, entries,
  history: z.array(z.strictObject({ revision: int, time: int, reason: z.string(), before: entries, after: entries })).max(100),
  rounds: z.array(z.strictObject({ id: z.string(), sessionId: z.string(), seq: int, time: int, user: z.string().max(6000), assistant: z.string().max(6000) })).max(120),
  progress: z.record(z.string(), int), barriers: z.record(z.string(), int), pending: int, lastRoundAt: int, status: z.string(),
})
export const characterGrowthDomain = defineDomain({ name: 'dsh_character_growth', version: 1, tables: {
  settings: domainTable<'global', GrowthConfig>(configSchema), roles: domainTable<string, GrowthState>(stateSchema),
} })
const clone = <T>(value: T): T => structuredClone(value)
export const emptyGrowth = (character: Character): GrowthState => ({ characterId: character.id, revision: 0, epoch: 0,
  baseRevision: character.revision, enabled: false, learning: true, since: 0, entries: [], history: [], rounds: [],
  progress: {}, barriers: {}, pending: 0, lastRoundAt: 0, status: '' })

/** A single role document is the transaction boundary: evidence, versions and barriers commit together. */
export class GrowthStore {
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  private roles = new Map<string, GrowthState>()
  private config: GrowthConfig
  constructor(private readonly domain: Domain<typeof characterGrowthDomain>) {
    this.config = clone(domain.table('settings').get('global') ?? { revision: 0, model: null })
    for (const [id, value] of domain.table('roles').entries()) this.roles.set(id, clone(value))
  }
  static async open(ctx: Context): Promise<GrowthStore> { return new GrowthStore(await ctx.storageDomain.open(characterGrowthDomain)) }
  settings(): GrowthConfig { return clone(this.config) }
  list(): GrowthState[] { return [...this.roles.values()].map(clone) }
  get(character: Character): GrowthState { return clone(this.roles.get(character.id) ?? emptyGrowth(character)) }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new CharacterError('closed', '成长服务已关闭。'))
    const task = this.tail.then(fn).catch(error => { throw error instanceof CharacterError ? error : new CharacterError('storage', '成长保存失败，原成长状态已保留。') })
    this.tail = task.catch(() => {})
    return task
  }
  setConfig(value: GrowthConfig): Promise<GrowthConfig> {
    return this.serial(async () => {
      if (!configSchema.safeParse(value).success) throw new CharacterError('invalid-request', '成长模型设置无效。')
      if (value.revision !== this.config.revision) throw new CharacterError('conflict', '整理模型已更新，请刷新后重试。')
      const next = { ...clone(value), revision: value.revision + 1 }
      await this.domain.table('settings').put('global', next)
      this.config = next
      return clone(next)
    })
  }
  update(character: Character, change: (state: GrowthState) => boolean | void, guard: () => boolean = () => true): Promise<GrowthState> {
    return this.serial(async () => {
      if (!guard()) throw new CharacterError('conflict', '成长任务已失效，未写入迟到结果。')
      const next = this.get(character)
      if (change(next) === false) return next
      next.revision++
      stateSchema.parse(next)
      await this.domain.table('roles').put(character.id, next)
      this.roles.set(character.id, clone(next))
      return clone(next)
    })
  }
  change(character: Character, request: GrowthChange, now: number): Promise<GrowthState> {
    return this.update(character, state => {
      if (state.revision !== request.expectedRevision) throw new CharacterError('conflict', '成长记录已更新，请刷新后重试；修改内容尚未保存。')
      const before = clone(state.entries)
      state.epoch++
      state.status = ''
      switch (request.action) {
        case 'enable':
          if (!this.config.model) throw new CharacterError('invalid-request', '请先选择固定整理模型。')
          if (!state.enabled) state.since = now
          state.enabled = true; state.learning = true; break
        case 'disable': state.enabled = false; break
        case 'pause': state.learning = false; break
        case 'resume': state.learning = true; break
        case 'retry': break
        case 'correct': {
          const entry = state.entries.find(item => item.id === request.entryId)
          if (!entry || !request.content?.trim() || request.content.trim().length > 600) throw new CharacterError('invalid-request', '请选择成长条目，纠正内容为 1–600 字。')
          entry.content = request.content.trim(); entry.manual = true; entry.reason = '用户手动纠正；自动学习不能覆盖。'
          // Previous chat quotes explain the old version, not the owner's replacement text.
          entry.sources = []
          break
        }
        case 'withdraw':
          if (!state.entries.some(item => item.id === request.entryId)) throw new CharacterError('not-found', '成长条目已不存在。')
          state.entries = state.entries.filter(item => item.id !== request.entryId); break
        case 'restore': {
          const version = state.history.find(item => item.revision === request.version)
          if (!version) throw new CharacterError('not-found', '此版本不在保留的最近 100 次变化中。')
          state.entries = clone(version.after); state.baseRevision = 0; break
        }
        case 'clear': state.entries = []; state.history = []; state.baseRevision = character.revision; before.length = 0; break
        default: throw new CharacterError('invalid-request', '未知成长操作。')
      }
      if (['correct', 'withdraw', 'restore', 'clear'].includes(request.action)) {
        state.barriers = { ...state.progress }; state.rounds = []; state.pending = 0
        const labels: Partial<Record<GrowthChange['action'], string>> = { correct: '纠正', withdraw: '撤回', restore: '恢复版本', clear: '清空' }
        recordGrowth(state, before, `用户${labels[request.action]}`, now)
      }
    })
  }
  enqueue(character: Character, round: GrowthRound, epoch: number): Promise<GrowthState> {
    return this.update(character, state => {
      if (!state.enabled || !state.learning || state.epoch !== epoch || round.time < state.since
        || round.seq <= (state.progress[round.sessionId] ?? -1)) return false
      state.progress[round.sessionId] = round.seq
      state.rounds.push(round); state.rounds = state.rounds.slice(-120)
      state.pending = Math.min(120, state.pending + 1); state.lastRoundAt = round.time
    })
  }
  async close(): Promise<void> { this.closed = true; await this.tail; await this.domain.close() }
}
export function recordGrowth(state: GrowthState, before: GrowthEntry[], reason: string, now: number): void {
  state.history.push({ revision: state.revision + 1, time: now, reason, before: clone(before), after: clone(state.entries) })
  state.history = state.history.slice(-100)
}
