import { principalOf, RemoteError, type RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'

/** The private character library is editable only by the local Host owner. */
export function requireOwner(invocation: RemoteInvocation | undefined, signal: AbortSignal): void {
  signal.throwIfAborted()
  if (principalOf(invocation)) {
    throw new RemoteError('character/failed', '角色管理仅允许此 Harness 实例的所有者操作。', { reason: 'forbidden' })
  }
}
