import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Button, Input, Modal, SegmentedTabs, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconPlusOutlineRegular, IconSearchOutlineRegular, IconUserOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Character } from '../shared/types.js'
import { CHARACTER_NAME_LIMIT, CHARACTER_TEXT_LIMIT } from '../shared/types.js'
import { compileCharacter } from '../host/prompt.js'
import type { CharacterDraft, CharactersRpc } from './controller.js'
import { CharacterManagerCache, closeDecision } from './drafts.js'
import { CharacterPortraitController, characterImageUrl, type CharacterVisualsRpc } from './portraits.js'
import { DefaultCharacterController, type DefaultsRpc } from './defaults.js'
import { DefaultCharacterSetting } from './default-setting.js'
import { GrowthModelDialog, GrowthModelSetting, GrowthPanel } from './growth.js'
import { GrowthController, growthPresentation, type GrowthRpc } from './growth-controller.js'
import { CharacterSelect, PersonaField } from './ui.js'

type ManagerView = 'gallery' | 'detail' | 'edit' | 'preview'
type DetailTab = 'persona' | 'visuals' | 'growth'
export interface ManagerViewState {
  view: ManagerView
  previewFrom: 'detail' | 'edit'
  tab: DetailTab
  query: string
  filter: 'active' | 'archived'
  modelOpen: boolean
  portraits: CharacterPortraitController
  defaults: DefaultCharacterController
  growth: GrowthController
}
export type ManagerCache = CharacterManagerCache<ManagerViewState>
export function createManagerCache(): ManagerCache { return new CharacterManagerCache(state => { state.portraits.dispose(); state.defaults.dispose(); state.growth.dispose() }) }
export interface CharacterManagerHandle { requestClose(): void }
const fields: { key: Exclude<keyof CharacterDraft, 'name'>; label: string; hint: string; group: string }[] = [
  { key: 'identity', label: '身份与自我定位', hint: '角色是谁，如何理解自己与用户的关系。', group: '基本档案' },
  { key: 'background', label: '背景与经历', hint: '影响角色观点和行为的经历。', group: '基本档案' },
  { key: 'personality', label: '性格', hint: '稳定的性格，以及遇到不同情况时的反应。', group: '性格与表达' },
  { key: 'style', label: '表达方式', hint: '语言、语气、称呼和表达习惯。', group: '性格与表达' },
  { key: 'values', label: '价值观', hint: '角色重视什么，做判断时遵循什么原则。', group: '原则与边界' },
  { key: 'boundaries', label: '角色边界', hint: '不符合角色的表现，以及不应编造的身份或经历。', group: '原则与边界' },
]
function Notice({ text }: { text?: string }) { return text ? <div className="dsh-character-error" role="alert">{text}</div> : null }
function Portrait({ url, name, className = '' }: { url?: string | null; name: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  return <div className={`dsh-character-portrait ${url && !failed ? 'has-image' : 'is-placeholder'} ${className}`}>
    {url && !failed ? <img src={url.startsWith('blob:') ? url : characterImageUrl(url)} alt={`${name}的配图`} loading="lazy" onError={() => setFailed(true)} /> : <IconUserOutlineRegular />}
  </div>
}
export const CharacterManager = forwardRef<CharacterManagerHandle, {
  rpc: CharactersRpc; cache: ManagerCache; cacheKey?: string; initialCharacter?: Character; initialTab?: DetailTab; onClose?: () => void
}>(function CharacterManager({ rpc, cache, cacheKey = 'settings', initialCharacter, initialTab = 'persona', onClose }, ref) {
  const [, render] = useReducer((value: number) => value + 1, 0)
  const entry = useMemo(() => cache.get(cacheKey, rpc, () => ({
    view: initialCharacter ? 'detail' : 'gallery', previewFrom: 'detail', tab: initialTab, query: '', filter: 'active', modelOpen: false,
    portraits: new CharacterPortraitController(rpc as CharactersRpc & CharacterVisualsRpc),
    defaults: new DefaultCharacterController(rpc as CharactersRpc & DefaultsRpc),
    growth: new GrowthController(rpc as CharactersRpc & GrowthRpc),
  }), initialCharacter), [cache, cacheKey, rpc])
  const { editor, state } = entry
  const { portraits, defaults, growth } = state
  const fileInput = useRef<HTMLInputElement>(null)
  const formId = useId()
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; cancelLabel?: string; action: () => void } | null>(null)
  const busy = editor.busy || portraits.busy || defaults.busy || growth.busy
  const dirty = editor.dirty || portraits.dirty || defaults.dirty || growth.dirty
  const readonly = !editor.canManage
  const { draft, selected } = editor
  const visual = selected ? portraits.visual(selected.id) : undefined
  const modelCharacterId = selected?.id ?? editor.characters[0]?.id
  const patch = (change: Partial<ManagerViewState>) => { Object.assign(state, change); render() }
  const discard = () => { editor.discard(); portraits.discard(); defaults.discard(); growth.discard() }
  const guarded = (action: () => void) => {
    const decision = closeDecision({ busy, dirty })
    if (decision === 'blocked') return
    if (decision === 'confirm') setConfirmation({ title: '放弃未保存的修改？', description: `尚未保存的${[editor.dirty && '人设', portraits.dirty && '配图', defaults.dirty && '默认设置', growth.dirty && '成长设置'].filter(Boolean).join('、')}会被丢弃。`, cancelLabel: '继续编辑', action: () => { discard(); action() } })
    else action()
  }
  useImperativeHandle(ref, () => ({ requestClose: () => guarded(() => onClose?.()) }))
  useLayoutEffect(() => {
    const subscriptions = [editor.subscribe(render), portraits.subscribe(render), defaults.subscribe(render), growth.subscribe(render)]
    if (initialCharacter && !editor.dirty && !portraits.dirty && !growth.dirty && !busy) { editor.select(initialCharacter); state.view = 'detail'; state.tab = initialTab }
    void editor.refresh(); void portraits.refresh(); void defaults.refresh()
    return () => subscriptions.forEach(unsubscribe => unsubscribe())
  }, [editor, portraits, defaults, growth])
  const catalogRevision = editor.characters.map(item => `${item.id}:${item.revision}`).join('|')
  useEffect(() => {
    if (!editor.canManage) return
    for (const character of editor.characters) void growth.refresh(character.id)
  }, [growth, catalogRevision, editor.canManage])
  useEffect(() => {
    if (!selected || readonly) return
    const interval = setInterval(() => { if (!growth.busy && !growth.dirty) void growth.refresh(selected.id) }, 30_000)
    return () => clearInterval(interval)
  }, [growth, selected?.id, readonly])
  useEffect(() => {
    if (!dirty) return
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [dirty])
  const openCharacter = (character: Character | null) => guarded(() => { editor.select(character); patch({ view: character ? 'detail' : 'edit', tab: 'persona' }) })
  const back = () => {
    if (state.view === 'preview') { patch({ view: state.previewFrom }); return }
    guarded(() => patch({ view: state.view === 'edit' && selected ? 'detail' : 'gallery' }))
  }
  const preview = () => patch({ view: 'preview', previewFrom: state.view === 'edit' ? 'edit' : 'detail' })
  const openModel = () => { growth.openModel(); patch({ modelOpen: true }) }
  const closeModel = () => guarded(() => { growth.discard(); patch({ modelOpen: false }) })
  const save = async () => { await editor.save(); if (!editor.error && !editor.dirty && editor.selected) { patch({ view: 'detail', tab: 'persona' }); void growth.refresh(editor.selected.id) }; void defaults.refresh() }
  const archive = () => setConfirmation({ title: `归档「${selected!.name}」？`, description: '归档后不再供新会话选择，已有绑定继续使用。本版不提供取消归档，角色资料仍可查看和编辑。', action: () => { void editor.archive().then(() => defaults.refresh()) } })
  const matching = editor.characters.filter(character => (state.filter === 'archived' ? character.archived : !character.archived) && `${character.name}\n${character.identity}`.toLocaleLowerCase().includes(state.query.trim().toLocaleLowerCase()))
  const tabs = [
    { value: 'persona', label: '人设', id: `${formId}-persona-tab`, panelId: `${formId}-persona-panel` },
    { value: 'visuals', label: '配图', id: `${formId}-visuals-tab`, panelId: `${formId}-visuals-panel` },
    { value: 'growth', label: '成长', id: `${formId}-growth-tab`, panelId: `${formId}-growth-panel` },
  ] as const
  return <main className={`dsh-characters dsh-character-view-${state.view}`}>
    {state.view === 'gallery' ? <>
      <header className="dsh-character-header"><div><h2>角色</h2><p>熟悉的搭档，延续到每一段新对话。</p></div><Button variant="outline" size="sm" disabled={readonly || busy} onClick={() => openCharacter(null)}><IconPlusOutlineRegular />新建角色</Button></header>
      <section className="dsh-character-library-settings"><DefaultCharacterSetting controller={defaults} characters={editor.characters} disabled={readonly || busy} onReload={() => setConfirmation({ title: '加载最新默认设置？', description: '所选角色会保留；再次保存时，将替换最新默认设置。', action: () => void defaults.refresh({ acceptDraftRevision: true }) })} /><GrowthModelSetting controller={growth} characterId={modelCharacterId} onOpen={openModel} disabled={readonly || busy} />{modelCharacterId && growth.errors.has(modelCharacterId) && <Notice text={growth.errors.get(modelCharacterId)} />}</section>
      <div className="dsh-character-library-tools"><Input icon={<IconSearchOutlineRegular />} type="search" aria-label="搜索角色" placeholder="搜索名字或身份" value={state.query} onChange={event => patch({ query: event.target.value })} /><CharacterSelect label="角色归档筛选" value={state.filter} options={[{ id: 'active', label: '使用中' }, { id: 'archived', label: '已归档' }]} onChange={filter => patch({ filter: filter as ManagerViewState['filter'] })} /></div>
      <Notice text={editor.error} /><Notice text={portraits.error} />
      {editor.loading && !editor.characters.length ? <p className="dsh-character-muted" role="status">正在读取角色…</p> : !matching.length ? <div className="dsh-character-empty"><h3>{state.query ? '没有找到这个角色' : state.filter === 'archived' ? '没有归档角色' : '从一个名字开始'}</h3><p>{state.query ? '试试其他名字或身份。' : state.filter === 'archived' ? '归档后的角色会出现在这里。' : '写下身份、性格和表达习惯。'}</p></div> : <div className="dsh-character-library" aria-label="角色列表">
        {matching.map(character => { const value = growth.status(character.id); return <button type="button" className="dsh-character-list-item" key={character.id} disabled={busy} onClick={() => openCharacter(character)} aria-label={`查看${character.name}`}><Portrait url={portraits.visual(character.id)?.url} name={character.name} /><span className="dsh-character-list-copy"><span className="dsh-character-list-heading"><strong>{character.name}</strong>{defaults.status?.characterId === character.id && <span className="dsh-character-badge">默认</span>}{character.archived && <span className="dsh-character-badge">已归档</span>}</span><span className="dsh-character-list-identity">{character.identity || '尚未填写身份'}</span><span className="dsh-character-list-status">{value ? growthPresentation(value, character.revision).title : growth.errors.has(character.id) ? '成长状态未读取' : '读取中…'}</span></span><IconChevronRightOutlineRegular /></button> })}
      </div>}

      <Button variant="ghost" size="sm" disabled={editor.loading || busy} onClick={() => { void editor.refresh(); void portraits.refresh(); void defaults.refresh(); for (const character of editor.characters) void growth.refresh(character.id) }}>刷新角色库</Button>
    </> : <>
      <div className="dsh-character-navigation"><Button variant="ghost" size="sm" disabled={busy} onClick={back}><IconChevronLeftOutlineRegular />{state.view === 'preview' ? state.previewFrom === 'edit' ? '返回编辑' : '返回详情' : state.view === 'edit' && selected ? '返回详情' : '角色库'}</Button>{dirty && <span className="dsh-character-unsaved">未保存</span>}</div>
      <div className="dsh-character-sticky-error"><Notice text={editor.error} /></div>
      {state.view === 'detail' && selected && <>
        <header className="dsh-character-detail-header"><Portrait url={visual?.url} name={selected.name} /><div><h2>{selected.name}</h2><p>{selected.identity.split(/(?<=[。！？\n])/u)[0] || '尚未填写身份'}</p><span className="dsh-character-muted">{defaults.status?.characterId === selected.id ? '默认角色 · ' : ''}{selected.archived ? '已归档 · ' : ''}人设版本 {selected.revision}</span></div></header>
        <SegmentedTabs items={tabs} value={state.tab} onChange={tab => guarded(() => patch({ tab: tab as DetailTab }))} label="角色详情" className="dsh-character-detail-tabs" />
        {readonly && <p className="dsh-character-muted">当前为只读查看。管理角色需要宿主所有者权限。</p>}
        <div role="tabpanel" id={`${formId}-${state.tab}-panel`} aria-labelledby={`${formId}-${state.tab}-tab`}>
          {state.tab === 'persona' && <><div className="dsh-character-section-heading"><h3>基本人设</h3><div className="dsh-character-actions"><Button variant="ghost" size="sm" onClick={preview}>完整预览</Button>{!readonly && <Button variant="outline" size="sm" disabled={busy} onClick={() => guarded(() => patch({ view: 'edit' }))}>编辑人设</Button>}</div></div><div className="dsh-character-persona-fields">{fields.map(field => <PersonaField key={`${selected.id}:${field.key}`} label={field.label} value={selected[field.key]} />)}</div>{selected.archived ? <p className="dsh-character-muted">已归档；已有绑定会话继续使用，新会话不可选择。</p> : !readonly && <footer className="dsh-character-detail-footer"><p className="dsh-character-muted">归档后保留资料与已有会话绑定。</p><Button variant="ghost" disabled={busy || dirty} onClick={archive}>归档角色</Button></footer>}</>}
          {state.tab === 'visuals' && <section className="dsh-character-image-editor" aria-label="角色配图"><div className="dsh-character-section-heading"><h3>角色配图</h3><span className="dsh-character-muted">仅用于界面</span></div><Portrait className="dsh-character-artwork" url={portraits.characterId === selected.id ? portraits.previewUrl : visual?.url} name={selected.name} /><p className="dsh-character-muted">PNG、JPEG、WebP · 最大 2 MiB，宿主可能设置更小上限。完整、等比展示。</p><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="dsh-character-sr" aria-label="上传角色配图" tabIndex={-1} onChange={event => { const file = event.target.files?.[0]; if (file) portraits.choose(selected.id, file); event.target.value = '' }} />{!readonly && <div className="dsh-character-actions"><Button variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}>{visual?.source === 'upload' ? '替换配图' : '上传配图'}</Button>{portraits.file ? <><Button variant="primary" disabled={busy} onClick={() => void portraits.save()}>{portraits.busy ? '保存中…' : '保存配图'}</Button><Button variant="ghost" disabled={busy} onClick={() => portraits.discard()}>取消选择</Button></> : visual?.source === 'upload' && <Button variant="ghost" disabled={busy} onClick={() => setConfirmation({ title: '恢复默认配图？', description: '替换当前自定义配图，角色人设与会话绑定不变。', action: () => void portraits.reset(selected.id) })}>恢复默认</Button>}</div>}{portraits.file && <p className="dsh-character-muted">待保存：{portraits.file.name}</p>}<Notice text={portraits.error} />{portraits.error && <Button variant="ghost" size="sm" disabled={busy || portraits.loading} onClick={() => setConfirmation({ title: '加载最新配图版本？', description: '所选图片会保留；再次保存时，将替换最新配图。', action: () => void portraits.refresh({ acceptDraftRevision: true }) })}>加载最新配图版本</Button>}<p className="dsh-character-status" role="status">{portraits.message}</p></section>}
          {state.tab === 'growth' && !readonly && <GrowthPanel key={selected.id} controller={growth} character={selected} onModel={openModel} guarded={guarded} />}
        </div>
        <p className="dsh-character-status" role="status" aria-live="polite">{editor.message}</p>
      </>}
      {state.view === 'edit' && draft && <><header className="dsh-character-edit-heading"><h2>{selected ? `编辑 ${selected.name}` : '创建角色'}</h2><p className="dsh-character-muted">保存后，已绑定会话从下一轮采用更新。</p></header><form id={formId} onSubmit={event => { event.preventDefault(); void save() }} className="dsh-character-edit-form">{['基本档案', '性格与表达', '原则与边界'].map(group => <section key={group}><h3>{group}</h3>{group === '基本档案' && <label className="dsh-character-field">角色名称<Input value={draft.name} readOnly={readonly || busy} required maxLength={CHARACTER_NAME_LIMIT} autoComplete="off" placeholder="这个角色叫什么？" onChange={event => editor.edit('name', event.target.value)} /></label>}{fields.filter(field => field.group === group).map(field => <label className="dsh-character-field" key={field.key}>{field.label}<span className="dsh-character-muted">{field.hint}</span><textarea rows={4} value={draft[field.key]} maxLength={CHARACTER_TEXT_LIMIT} readOnly={readonly || busy} onChange={event => editor.edit(field.key, event.target.value)} /></label>)}</section>)}</form><footer className="dsh-character-edit-footer"><div><p className="dsh-character-muted" role="status">{editor.dirty ? '修改尚未保存' : '已与保存内容同步'}</p>{editor.conflict && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmation({ title: '加载最新人设？', description: '当前草稿会被最新保存的内容替换。请先复制需要保留的内容。', action: () => void editor.reloadSelected() })}>加载最新版本</Button>}</div><div className="dsh-character-actions"><Button variant="ghost" disabled={busy} onClick={back}>取消</Button><Button variant="outline" onClick={preview}>预览</Button><Button type="submit" form={formId} variant="primary" disabled={readonly || busy || editor.conflict || !draft.name.trim() || !!selected && !editor.dirty}>{editor.busy ? '保存中…' : '保存角色'}</Button></div></footer></>}
      {state.view === 'preview' && draft && <section className="dsh-character-preview"><h2>{draft.name || '新角色'}的人设</h2><p className="dsh-character-muted">{state.previewFrom === 'edit' ? '根据当前草稿生成；保存后下一轮生效。' : '基本人设正文；不包含成长、通用记忆或宿主其他提示词。'}</p><pre tabIndex={0}>{compileCharacter(draft)}</pre></section>}
    </>}
    <GrowthModelDialog controller={growth} characterId={modelCharacterId} open={state.modelOpen} onClose={closeModel} onSaved={() => patch({ modelOpen: false })} />
    <Modal open={!!confirmation} title={confirmation?.title ?? ''} description={confirmation?.description} closeLabel="取消" className="dsh-character-modal" onClose={() => { if (!busy) setConfirmation(null) }} footer={<div className="dsh-character-actions"><Button variant="ghost" disabled={busy} onClick={() => setConfirmation(null)}>{confirmation?.cancelLabel ?? '取消'}</Button><Button variant="primary" disabled={busy} onClick={() => { const action = confirmation?.action; setConfirmation(null); action?.() }}>确认</Button></div>} />
  </main>
})
