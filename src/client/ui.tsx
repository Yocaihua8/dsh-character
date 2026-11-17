import { useState, type ReactNode } from 'react'
import { Button, Menu, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

export function CharacterSelect({ label, value, options, onChange, disabled = false }: {
  label: string; value: string; options: { id: string; label: string; disabled?: boolean }[]; onChange(id: string): void; disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  return <Menu open={open && !disabled} onClose={() => setOpen(false)} portal autoFocus compact align="end" minWidthFromAnchor className="dsh-character-select-shell" listClassName="dsh-character-select-menu" selectedId={value} items={options}
    onSelect={id => { setOpen(false); onChange(id) }} anchor={<Button variant="toolbar" disabled={disabled} className="dsh-character-select" aria-label={label} aria-haspopup="menu" aria-expanded={open && !disabled} onClick={() => setOpen(!open)}><span>{options.find(item => item.id === value)?.label ?? '请选择'}</span><IconChevronDownOutlineRegular /></Button>} />
}
export function SettingRow({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <div className="dsh-character-setting-row"><div className="dsh-character-row-copy"><span>{title}</span>{description && <span className="dsh-character-muted">{description}</span>}</div><div className="dsh-character-row-control">{children}</div></div>
}
export function ActionRow({ title, description, value, onClick, disabled }: { title: string; description?: string; value?: string; onClick(): void; disabled?: boolean }) {
  return <button type="button" className="dsh-character-action-row" disabled={disabled} onClick={onClick}><span className="dsh-character-row-copy"><span>{title}</span>{description && <span className="dsh-character-muted">{description}</span>}</span>{value && <span className="dsh-character-action-value">{value}</span>}<IconChevronRightOutlineRegular /></button>
}
export function PersonaField({ label, value }: { label: string; value: string }) {
  const [expanded, setExpanded] = useState(false)
  return <section className="dsh-character-persona-section"><h3>{label}</h3><p className={value.length > 130 && !expanded ? 'dsh-character-clamp' : ''}>{value || '尚未填写'}</p>{value.length > 130 && <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '展开全部'}</Button>}</section>
}
export const formatDate = (time: number) => new Date(time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
