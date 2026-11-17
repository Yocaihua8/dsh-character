// Generated from shared/ by scripts/sync-shared.mjs. Edit the shared source.
/** Trusted, same-process Host capability. Never expose these methods as model tools or owner RPCs. */
export const EXECUTION_POLICY_VERSION = 1

export interface AutomationExecutionDomain {
  readonly domainId: string
  readonly revision: number
  readonly protectedRoots: readonly string[]
  /** Domain-common skills plus this session's explicit reads; never derived from private protected paths. */
  readonly readableRoots: readonly string[]
}
export interface AutomationExecutionRegistration {
  readonly sessionId: string
  readonly protectedRoots?: readonly string[]
  readonly readableRoots?: readonly string[]
}
export interface AutomationExecutionPolicyService {
  readonly version: typeof EXECUTION_POLICY_VERSION
  /** Storage is loaded and legacy bindings have been classified. Unknown/corrupt state never resolves as normal. */
  readonly ready: Promise<void>
  /** Synchronous for commit-time guards. Throws before readiness or after a storage failure. */
  resolveForSession(sessionId: string): AutomationExecutionDomain | undefined
  /** Permanent registration; protection is shared by the domain, while explicit reads belong to this session. */
  registerAutomation(input: AutomationExecutionRegistration): Promise<void>
  /** The automation owner supplies every retained binding, including deleted and uncertain ones. */
  completeMigration(entries: readonly AutomationExecutionRegistration[]): Promise<void>
  /** Add canonical roots protected in every automation execution domain. */
  registerProtectedRoots(roots: readonly string[]): Promise<void>
  /** Native create/resume calls this before publishing a child or fork. */
  inheritSession(sessionId: string, parentSessionId?: string): Promise<void>
  /** Serialize the final memory transaction with isolation registration, including its awaited file write. */
  withMemoryAccess<T>(sessionId: string, operation: () => Promise<T>): Promise<T>
  /** Register the exact trusted ToolDefinition object; restarting requires fresh registrations. */
  registerProtectedTool(definition: object): () => void
  /** Read-only availability for recommendation catalogs; never infer admission from tool names. */
  isProtectedTool(definition: object): boolean
  /** Final executor check against the actual resolved definition; ordinary sessions are unchanged. */
  assertToolAllowed(sessionId: string, definition: object): void
  /** A registration is announced immediately so in-flight memory admission can be revoked. */
  subscribe(listener: (sessionIds: readonly string[]) => void): () => void
}
