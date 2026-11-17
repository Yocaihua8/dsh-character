import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Button, Menu, Modal, Toast, IconUserOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TYPERT_REMOTE } from '../../lib/typert.remote-client.js'
import type { Character } from '../shared/types.js'
import { CharacterBindingController } from './controller.js'
import type { BindingPort, CharactersRpc } from './controller.js'
import { CharacterManager, createManagerCache } from './manager.js'
import type { CharacterManagerHandle, ManagerCache } from './manager.js'
import styles from './style.css'
import type { GrowthRpc } from './growth.js'
import { unwrap } from './controller.js'
import { GrowthNotices } from './growth-controller.js'

interface ComposerBinding extends Omit<BindingPort, 'changed'> {
  subscribe(listener: () => void): () => void
}

/** The host's settings sidebar can leave less room than a usable editor on a small window. */
function CharacterSettings({ rpc, cache }: { rpc: CharactersRpc; cache: ManagerCache }) {
  const container = useRef<HTMLDivElement>(null)
  const managerRef = useRef<CharacterManagerHandle>(null)
  const [narrow, setNarrow] = useState(false)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    let previous = false
    const measure = () => {
      const width = element.getBoundingClientRect().width
      if (width <= 0) return
      const next = width < 300
      if (next && !previous) setOpen(true)
      previous = next; setNarrow(next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return <div ref={container} className="dsh-character-settings">
    {narrow ? <>
      <div className="dsh-character-settings-launcher"><p>角色库</p><Button variant="outline" size="sm" aria-label="打开角色库" title="打开角色库" onClick={() => setOpen(true)}>打开</Button></div>
      <Modal open={open} title="角色管理" closeLabel="关闭角色管理" className="dsh-character-dialog" contentClassName="dsh-character-dialog-body" onClose={() => managerRef.current?.requestClose()}>
        {open && <CharacterManager ref={managerRef} rpc={rpc} cache={cache} cacheKey="settings" onClose={() => setOpen(false)} />}
      </Modal>
    </> : <CharacterManager rpc={rpc} cache={cache} cacheKey="settings" />}
  </div>
}

function CharacterSelector({ binding, cache, growthNotices }: { binding: ComposerBinding; cache: ManagerCache; growthNotices: GrowthNotices }) {
  const [, render] = useReducer((value: number) => value + 1, 0)
  const controller = useMemo(() => new CharacterBindingController({ ...binding, changed: render }), [binding])
  const [open, setOpen] = useState(false)
  const [manager, setManager] = useState<{ character?: Character; tab?: 'persona' | 'growth' } | null>(null)
  const managerRef = useRef<CharacterManagerHandle>(null)
  const [dismissed, setDismissed] = useState('')
  useLayoutEffect(() => {
    controller.reconcile()
    const unsubscribe = binding.subscribe(() => { controller.reconcile(); render() })
    return () => { unsubscribe(); controller.dispose() }
  }, [binding, controller])
  const [growthNotice, setGrowthNotice] = useState('')
  const current = controller.status?.character
  useEffect(() => {
    const signal = new AbortController()
    const rpc = binding.rpc as CharactersRpc & GrowthRpc
    let reading = false
    const refresh = async () => {
      if (reading) return
      reading = true
      try {
        await unwrap(rpc.registerGrowthSession(binding.read().sessionId, signal.signal))
        if (current) {
          const status = await unwrap(rpc.getGrowth(current.id, signal.signal))
          if (!signal.signal.aborted) setGrowthNotice(growthNotices.read(status, current.revision))
        }
      } catch { if (!signal.signal.aborted) setGrowthNotice('成长不可用') }
      finally { reading = false }
    }
    void refresh()
    const interval = setInterval(() => void refresh(), 30_000)
    return () => { signal.abort(); clearInterval(interval); setGrowthNotice('') }
  }, [binding, current?.id, current?.revision, growthNotices])
  const available = binding.read().available
  const canBind = controller.canBind
  const locked = !!controller.status && !canBind
  const notice = controller.error || controller.message
  const showMenu = () => {
    if (!available || controller.pending) return
    setOpen(value => !value); setDismissed('')
    if (!open) void controller.refresh().then(() => { if (controller.canBind) void controller.loadChoices() })
  }
  const choices = controller.characters.map(character => ({ id: character.id, label: character.name, disabled: !canBind }))
  return <div className="dsh-character-composer" data-character-selector="true">
    <Menu open={open} onClose={() => setOpen(false)} side="top" align="end" portal compact autoFocus
      selectedId={current?.id} items={[
        { type: 'label', id: 'status', text: controller.loading ? '正在读取角色…' : current ? `当前：${current.name}${current.archived ? ' · 已归档' : ''}` : '尚未选择角色' },
        ...(canBind ? choices : []),
        ...(canBind && !choices.length ? [{ type: 'label' as const, id: 'empty', text: controller.choicesLoading ? '正在读取角色列表…' : controller.catalogError || '暂无可用角色，请先创建。' }] : []),
        ...(locked ? [{ type: 'label' as const, id: 'locked', text: controller.status?.reason || '角色已固定；更换角色请新建会话。' }] : []),
        ...(canBind ? [{ type: 'label' as const, id: 'first-turn', text: '首轮开始后角色固定。' }] : []),
        ...(growthNotice ? [{ type: 'label' as const, id: 'growth-notice', text: growthNotice }] : []),
      ]}
      footer={[{ id: ':manage', label: current ? '查看 / 编辑角色' : '管理角色' }, ...(current ? [{ id: ':growth', label: '查看成长' }] : [])]}
      onSelect={id => {
        setOpen(false)
        if (id === ':manage') setManager(current ? { character: current } : {})
        else if (id === ':growth' && current) { growthNotices.acknowledge(current.id); setGrowthNotice(''); setManager({ character: current, tab: 'growth' }) }
        else if (canBind) { setDismissed(''); void controller.bind(id) }
      }}
      anchor={<Button variant="ghost" size="sm" type="button" className="dsh-character-trigger" disabled={!available || controller.pending}
        aria-label={current ? `角色：${current.name}${locked ? '，已固定' : ''}` : '选择角色'} aria-haspopup="menu" aria-expanded={open} aria-busy={controller.pending}
        title={!available ? '角色用于直接对话的主会话' : current ? `${current.name}${locked ? ' · 已固定，换角色请新建会话' : ' · 首条聊天后固定'}` : '选择角色；首条聊天后固定'} onClick={showMenu}>
        <IconUserOutlineRegular /><span className="dsh-character-trigger-name">{controller.pending ? '选择中…' : current?.name || '角色'}</span>{growthNotice && <span className="dsh-character-growth-dot" title={growthNotice} aria-label={growthNotice} />}
      </Button>} />
    <span className="dsh-character-sr" role="status" aria-live="polite">{notice}</span>
    {notice && notice !== dismissed && <Toast key={notice} text={notice} holdMs={5000} onDone={() => setDismissed(notice)} />}
    <Modal open={manager !== null} title="角色管理" closeLabel="关闭角色管理" className="dsh-character-dialog" contentClassName="dsh-character-dialog-body"
      onClose={() => managerRef.current?.requestClose()}>
      {manager && <CharacterManager ref={managerRef} cache={cache} cacheKey={'session:' + binding.read().sessionId} rpc={binding.rpc} initialCharacter={manager.character} initialTab={manager.tab}
        onClose={() => { setManager(null); void controller.refresh(); if (controller.canBind) void controller.loadChoices() }} />}
    </Modal>
  </div>
}

function composerBinding(ctx: Context, sessionId: SessionId, rpc: CharactersRpc): ComposerBinding {
  const session = ctx.sessions.binding(sessionId)!
  return {
    rpc,
    read: () => {
      const snapshot = session.session.getSnapshot()
      return { sessionId, available: ctx.sessions.binding(sessionId) === session && !snapshot.removed && snapshot.openState === 'open' && snapshot.subagent === null,
        mayBind: snapshot.blank && !snapshot.running && !snapshot.awaitingFirstTurn && !snapshot.pendingSubmissions.length }
    },
    subscribe: listener => session.session.subscribe(listener),
  }
}

export const inject = ['remote', 'slots', 'sessions']

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  const ui = ctx.inject(['remote.characters', 'slots', 'sessions'], scope => {
    const style = document.createElement('style')
    style.dataset.dshPlugin = 'dsh-character'; style.textContent = styles; document.head.append(style)
    scope.effect(() => () => style.remove())
    const rpc = scope.remote.characters as unknown as CharactersRpc
    const cache = createManagerCache()
    const growthNotices = new GrowthNotices()
    scope.effect(() => () => cache.dispose())
    scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section', id: 'dsh-character', order: 36, label: () => '角色', inject: () => ({ rpc, cache }),
    }, CharacterSettings))
    scope.slots.inject('conversation.input.right', () => scope.slots.register({
      name: 'conversation.input.right', id: 'dsh-character', order: 90, inject: sessionId => ({ binding: composerBinding(scope, sessionId, rpc), cache, growthNotices }),
    }, CharacterSelector))
  })
  try { await ui } catch (error) { await ui.dispose(); await unmountRemote(); throw error }
  return async () => { await ui.dispose(); await unmountRemote() }
}
