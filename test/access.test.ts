import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { requireOwner } from '../src/host/access.js'

test('only owner and local Host can manage the character library', () => {
  const signal = new AbortController().signal
  const invocation = (kind: string) => ({ peer: { principal: { kind } } }) as unknown as RemoteInvocation
  assert.doesNotThrow(() => requireOwner(undefined, signal))
  assert.doesNotThrow(() => requireOwner(invocation('owner'), signal))
  for (const kind of ['shared-session', 'channel-user']) assert.throws(() => requireOwner(invocation(kind), signal), /所有者/)
  const cancelled = new AbortController()
  cancelled.abort()
  assert.throws(() => requireOwner(invocation('owner'), cancelled.signal), { name: 'AbortError' })
})
