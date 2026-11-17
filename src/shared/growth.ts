export interface GrowthModel { provider: string; model: string; reasoningEffort?: string }
export interface GrowthModelOption extends GrowthModel { label: string; efforts: string[] }
export interface GrowthConfig { revision: number; model: GrowthModel | null; fallbackToMain?: boolean }
export interface GrowthSource { roundId: string; sessionId: string; seq: number; quote: string }
export interface GrowthEntry {
  id: string
  kind: 'personality' | 'interaction' | 'experience'
  content: string
  reason: string
  sources: GrowthSource[]
  manual: boolean
}
export interface GrowthRound {
  id: string; sessionId: string; seq: number; time: number
  user: string; assistant: string
}
export interface GrowthVersion {
  revision: number; time: number; reason: string
  before: GrowthEntry[]; after: GrowthEntry[]
}
export interface GrowthState {
  characterId: string; revision: number; epoch: number; baseRevision: number
  enabled: boolean; learning: boolean; since: number
  entries: GrowthEntry[]; history: GrowthVersion[]; rounds: GrowthRound[]
  progress: Record<string, number>; barriers: Record<string, number>
  pending: number; lastRoundAt: number; status: string
}
export interface GrowthStatus {
  state: GrowthState; config: GrowthConfig; applied: boolean; message: string
  models: GrowthModelOption[]; usingFallback?: boolean
}
export interface GrowthChange {
  characterId: string; expectedRevision: number
  action: 'enable' | 'disable' | 'pause' | 'resume' | 'correct' | 'withdraw' | 'restore' | 'clear' | 'retry'
  entryId?: string; content?: string; version?: number
}
