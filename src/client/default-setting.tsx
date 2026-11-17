import { useEffect, useState } from 'react'
import { Button, IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Character } from '../shared/types.js'
import type { DefaultCharacterController } from './defaults.js'

const noDefault = ':no-default'

export function DefaultCharacterSetting({ controller, characters, disabled, onReload }: {
  controller: DefaultCharacterController
  characters: Character[]
  disabled: boolean
  onReload(): void
}) {
  const [open, setOpen] = useState(false)
  const status = controller.status
  const choice = characters.find(character => character.id === controller.selectedId)
  const unavailableChoice = controller.selectedId !== null && (!choice || choice.archived)
  const choiceLabel = controller.selectedId === null ? '不自动选择' : choice?.name ?? (status?.characterId === controller.selectedId ? status.character?.name : null) ?? '角色已不存在'
  const savedLabel = !status ? '尚未读取' : status.characterId === null ? '不自动选择' : status.character?.name ?? '角色已不存在'
  const locked = disabled || controller.busy || controller.loading || !status
  useEffect(() => { if (locked) setOpen(false) }, [locked])
  return <section className="dsh-character-default" aria-label="新会话默认角色">
    <div className="dsh-character-default-heading"><h3>默认角色</h3><p className="dsh-character-muted">仅影响之后新建的主会话。</p></div>
    <div className="dsh-character-default-controls">
      <Menu open={open} onClose={() => setOpen(false)} portal compact autoFocus align="start" className="dsh-character-default-select" listClassName="dsh-character-default-menu"
        selectedId={controller.selectedId ?? noDefault}
        items={[{ id: noDefault, label: '不自动选择' }, ...characters.filter(character => !character.archived).map(character => ({ id: character.id, label: character.name }))]}
        onSelect={id => { setOpen(false); controller.choose(id === noDefault ? null : id) }}
        anchor={<Button variant="toolbar" disabled={locked} aria-label={`默认角色：${choiceLabel}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}><span>{controller.loading && !status ? '正在读取…' : `${choiceLabel}${unavailableChoice ? '（不可用）' : ''}`}</span><IconChevronDownOutlineRegular /></Button>} />
      {controller.dirty && <Button variant="primary" size="sm" disabled={locked || controller.conflict || unavailableChoice} onClick={() => void controller.save()}>{controller.busy ? '保存中…' : '保存默认设置'}</Button>}
    </div>
    {controller.dirty && <p className="dsh-character-default-saved">{controller.conflict ? '上次读取：' : '已保存：'}{savedLabel} · 有未保存的选择</p>}
    {!!status?.unavailableReason && <p className="dsh-character-default-warning" role="status">{status.unavailableReason}</p>}
    {controller.error && <p className="dsh-character-error" role="alert">{controller.error}</p>}
    {controller.conflict && <Button variant="outline" size="sm" disabled={locked} onClick={onReload}>加载最新默认设置</Button>}
    {!status && controller.error && <Button variant="outline" size="sm" disabled={disabled || controller.loading} onClick={() => void controller.refresh()}>重新读取</Button>}
    <p className="dsh-character-status" role="status" aria-live="polite">{controller.message}</p>
  </section>
}
