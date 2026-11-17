import type { Character } from '../shared/types.js'
import { CharacterEditorController } from './controller.js'
import type { CharactersRpc } from './controller.js'

export type CloseDecision = 'blocked' | 'confirm' | 'allow'

/** Every exit uses the same guard, including Escape and the modal backdrop. */
export function closeDecision(state: { busy: boolean; dirty: boolean }): CloseDecision {
  return state.busy ? 'blocked' : state.dirty ? 'confirm' : 'allow'
}

export interface CharacterManagerEntry<T> {
  readonly editor: CharacterEditorController
  readonly state: T
}

/** Owned by one client plugin activation, never persisted to disk or the model. */
export class CharacterManagerCache<T> {
  private readonly entries = new Map<string, CharacterManagerEntry<T>>()
  private disposed = false

  constructor(private readonly disposeState?: (state: T) => void) {}

  get(key: string, rpc: CharactersRpc, createState: () => T, initial?: Character): CharacterManagerEntry<T> {
    if (this.disposed) throw new Error('角色管理已停用。')
    const existing = this.entries.get(key)
    if (existing) return existing
    const entry = { editor: new CharacterEditorController(rpc, () => {}, initial), state: createState() }
    this.entries.set(key, entry)
    return entry
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const failures: unknown[] = []
    for (const entry of this.entries.values()) {
      entry.editor.dispose()
      try { this.disposeState?.(entry.state) }
      catch (error) { failures.push(error) }
    }
    this.entries.clear()
    if (failures.length) throw new AggregateError(failures, '角色管理界面资源清理失败。')
  }
}
