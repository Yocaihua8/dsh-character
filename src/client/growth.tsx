import { useState } from 'react'
import { Button, Menu, Modal, Switch, IconChevronDownOutlineRegular, IconChevronLeftOutlineRegular, IconInfoOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Character } from '../shared/types.js'
import type { GrowthEntry } from '../shared/growth.js'
import { GrowthController, growthPresentation, modelKey, modelLabel } from './growth-controller.js'
import { ActionRow, CharacterSelect, SettingRow, formatDate } from './ui.js'
export type { GrowthRpc } from './growth-controller.js'

function GrowthError({ controller, characterId }: { controller: GrowthController; characterId: string }) {
  const error = controller.error || controller.errors.get(characterId)
  return error ? <div className="dsh-character-error" role="alert"><p>{error}</p><Button variant="ghost" size="sm" disabled={controller.busy || controller.loading.has(characterId)} onClick={() => void controller.refresh(characterId, true)}>加载最新版本并保留草稿</Button></div> : null
}
export function GrowthModelSetting({ controller, characterId, onOpen, disabled }: { controller: GrowthController; characterId?: string; onOpen(): void; disabled: boolean }) {
  return <ActionRow title="成长整理模型" description="所有角色共用，主聊天切换模型不影响此选择；开启回退后，固定模型不可用时临时使用主聊天模型。" value={modelLabel(controller.config, controller.models)} disabled={disabled || !characterId || !controller.config} onClick={onOpen} />
}
export function GrowthModelDialog({ controller, characterId, open, onClose, onSaved }: { controller: GrowthController; characterId?: string; open: boolean; onClose(): void; onSaved(): void }) {
  const draft = controller.modelDraft
  const selected = draft?.model ? controller.models.find(item => modelKey(item) === modelKey(draft.model!)) : undefined
  const choices = controller.models.map(item => ({ id: modelKey(item), label: item.label }))
  if (draft?.model && !selected) choices.unshift({ id: modelKey(draft.model), label: `${draft.model.model}（不可用）` })
  return <Modal open={open} title="成长整理模型" description="所有角色共用。主聊天切换模型不会改变这里的选择。" closeLabel="关闭模型设置" className="dsh-character-modal" onClose={onClose}
    footer={<div className="dsh-character-actions"><Button variant="ghost" disabled={controller.busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={controller.busy || !selected || !controller.modelDirty || controller.conflict} onClick={() => { if (characterId) void controller.saveModel(characterId).then(saved => { if (saved) onSaved() }) }}>{controller.busy ? '保存中…' : '保存模型'}</Button></div>}>
    {characterId && <GrowthError controller={controller} characterId={characterId} />}
    <SettingRow title="整理模型"><CharacterSelect label="成长整理模型" value={draft?.model ? modelKey(draft.model) : ''} disabled={controller.busy} options={[{ id: '', label: '请选择整理模型', disabled: true }, ...choices]} onChange={id => { const model = controller.models.find(item => modelKey(item) === id); if (model) controller.editModel({ provider: model.provider, model: model.model }) }} /></SettingRow>
    <SettingRow title="推理档位"><CharacterSelect label="整理推理档位" value={draft?.model?.reasoningEffort ?? ''} disabled={controller.busy || !selected} options={[{ id: '', label: '模型默认' }, ...(selected?.efforts ?? []).map(id => ({ id, label: id }))]} onChange={effort => { if (draft?.model) controller.editModel({ provider: draft.model.provider, model: draft.model.model, ...(effort ? { reasoningEffort: effort } : {}) }) }} /></SettingRow>
    <SettingRow title="固定模型不可用时回退" description="固定整理模型或档位不可用时，临时改用主聊天模型整理；恢复后自动切回。"><Switch checked={!!draft?.fallbackToMain} label="回退到主聊天模型" disabled={controller.busy} onChange={on => controller.editFallback(on)} /></SettingRow>
    {!controller.models.length && <p className="dsh-character-muted">暂未读取到可用模型，请先在宿主配置模型，再重新加载。</p>}
    <p className="dsh-character-muted">聊天片段会发送给此模型，并产生额外用量；开启回退后，回退期间按主聊天模型与其档位计。每批最多两次无工具调用，共用 45 秒期限。</p>
  </Modal>
}
function Sources({ entry }: { entry: GrowthEntry }) {
  return entry.sources.length ? <details className="dsh-character-sources"><summary>查看原因与来源 · {entry.sources.length} 条</summary><p>{entry.reason}</p>{entry.sources.map(source => <div key={`${source.roundId}:${source.seq}:${source.quote}`}><p className="dsh-character-muted">聊天 {source.sessionId} · 事件 {source.seq}</p><blockquote>{source.quote}</blockquote></div>)}</details> : <p className="dsh-character-muted">{entry.reason}{entry.manual ? ' · 用户手动设置' : ''}</p>
}
function Entries({ entries }: { entries: GrowthEntry[] }) {
  return entries.length ? <ul className="dsh-character-history-entries">{entries.map(entry => <li key={entry.id}>{entry.content}{entry.manual && <span className="dsh-character-badge">手动保护</span>}<Sources entry={entry} /></li>)}</ul> : <p className="dsh-character-muted">无成长条目</p>
}
export function GrowthPanel({ controller, character, onModel, guarded }: { controller: GrowthController; character: Character; onModel(): void; guarded(action: () => void): void }) {
  const [view, setView] = useState<'settings' | 'entries' | 'history'>('settings')
  const [more, setMore] = useState(false)
  const [confirm, setConfirm] = useState<{ action: 'enable' | 'clear' | 'restore' | 'withdraw'; entryId?: string; version?: number }>()
  const value = controller.status(character.id)
  const busy = controller.busy
  const closeEditing = () => guarded(() => controller.discard())
  const status = value && growthPresentation(value, character.revision)
  const go = (next: typeof view) => guarded(() => setView(next))
  const description = confirm?.action === 'enable' ? `开启后的新聊天片段会发送给 ${modelLabel(controller.config, controller.models)}，产生额外用量。成长自动生效，可以纠正、撤回或关闭。`
    : confirm?.action === 'clear' ? '清空此角色的成长条目、证据片段和旧版本，保留阻止旧证据重学的处理位置。基本人设、通用记忆和原始聊天保持不变。'
    : confirm?.action === 'restore' ? '恢复所选版本的表现，下一轮生效。需要重新核验当前基本人设，并封存旧证据，防止已撤回内容再次生成。'
    : '下一轮不再使用这条变化，并阻止相同旧证据重新生成它。原始聊天保持不变。'
  return <section className="dsh-character-growth" aria-label="角色成长">
    {view !== 'settings' && <Button variant="ghost" size="sm" className="dsh-character-back" disabled={busy} onClick={() => go('settings')}><IconChevronLeftOutlineRegular />成长</Button>}
    <header className="dsh-character-section-heading"><h3>{view === 'settings' ? '角色成长' : view === 'entries' ? '当前表现' : '变化记录'}</h3>
      {view === 'settings' && <Menu open={more} onClose={() => setMore(false)} portal compact autoFocus align="end" items={[
        { id: 'refresh', label: '刷新成长记录', disabled: busy },
        { id: 'clear', label: '清空成长', disabled: busy || !value || !(value.state.entries.length || value.state.rounds.length || value.state.history.length) },
      ]} onSelect={id => { setMore(false); if (id === 'clear') setConfirm({ action: 'clear' }); else void controller.refresh(character.id) }} anchor={<Button variant="ghost" size="sm" aria-label="成长更多操作" aria-haspopup="menu" aria-expanded={more} onClick={() => setMore(!more)}>更多<IconChevronDownOutlineRegular /></Button>} />}
    </header>
    <GrowthError controller={controller} characterId={character.id} />
    {!value ? <p className="dsh-character-muted" role="status">{controller.errors.has(character.id) ? '成长未加载；基本人设仍可使用。' : '正在读取成长…'}</p> : <>
      {view === 'settings' && <>
        <SettingRow title="启用成长" description="在基本人设之外，使用逐渐形成的相处方式。"><Switch checked={value.state.enabled} label="启用成长" disabled={busy || !value.config.model && !value.state.enabled} onChange={enabled => enabled ? setConfirm({ action: 'enable' }) : void controller.change(character.id, 'disable')} /></SettingRow>
        <SettingRow title="自动学习" description="暂停后，继续使用已有成长。"><Switch checked={value.state.learning} label="自动学习" disabled={busy || !value.state.enabled} onChange={learning => void controller.change(character.id, learning ? 'resume' : 'pause')} /></SettingRow>
        <div className="dsh-character-growth-status" role="status"><IconInfoOutlineRegular /><div><strong>{status!.title}</strong><p className="dsh-character-muted">{status!.description}</p>{value.state.pending > 0 && <p className="dsh-character-muted">待整理 {value.state.pending} 个完整回合</p>}{status!.retry && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void controller.change(character.id, 'retry')}>重试整理</Button>}</div></div>
        <ActionRow title="当前表现" description="查看、纠正或撤回相处方式。" value={`${value.state.entries.length} 条`} onClick={() => go('entries')} disabled={busy} />
        <ActionRow title="变化记录" description="查看前后变化和来源，恢复历史版本。" value={value.state.history.length ? formatDate(value.state.history.at(-1)!.time) : '暂无变化'} onClick={() => go('history')} disabled={busy} />
        <GrowthModelSetting controller={controller} characterId={character.id} onOpen={onModel} disabled={busy} />
        <details className="dsh-character-explanation"><summary>成长如何工作</summary><p>只从开启后新建的本人主聊天完整回合积累，累计五回合或空闲十分钟整理。明确长期纠正可提前排队，仍需语义核验。暂停学习保留已有成长；关闭成长从下一轮使用基本人设。</p><p>基本人设由你管理；通用习惯由记忆插件拥有和注入，关闭记忆时不会复制使用。</p>{status!.compatibility && <p>{status!.compatibility}</p>}<p>每个角色独立积累。聊天片段会发送给所选整理模型并产生额外用量；模型不可用时暂停整理，开启回退后临时使用主聊天模型。</p></details>
      </>}
      {view === 'entries' && <>
        <p className="dsh-character-muted">经过核验的性格表现和相处方式；手动纠正的条目受保护。</p>
        {!value.state.entries.length && <div className="dsh-character-empty"><h3>还没有成长条目</h3><p>开启后在新主聊天中自然交流，经过核验的变化会出现在这里。</p></div>}
        {value.state.entries.map(entry => <article className="dsh-character-growth-entry" key={entry.id}><div className="dsh-character-section-heading"><h3>{entry.kind === 'personality' ? '性格表现' : entry.kind === 'interaction' ? '相处习惯' : '交流经历'}</h3>{entry.manual && <span className="dsh-character-badge">手动保护</span>}</div><p>{entry.content}</p><Sources entry={entry} /><div className="dsh-character-actions"><Button variant="ghost" size="sm" disabled={busy} onClick={() => controller.editEntry(character.id, entry)}>纠正</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm({ action: 'withdraw', entryId: entry.id })}>撤回</Button></div></article>)}
      </>}
      {view === 'history' && <>
        <p className="dsh-character-muted">最近 100 次变化。恢复会新增记录，下一轮采用通过核验的版本。</p>
        {!value.state.history.length && <div className="dsh-character-empty"><h3>暂无变化记录</h3><p>成长、纠正与撤回后，可在这里查看前后变化。</p></div>}
        {[...value.state.history].reverse().map(version => <details className="dsh-character-history" key={version.revision}><summary><strong>版本 {version.revision} · {version.reason}</strong><span className="dsh-character-muted">{formatDate(version.time)}</span></summary><h3>变化前</h3><Entries entries={version.before} /><h3>变化后</h3><Entries entries={version.after} /><Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirm({ action: 'restore', version: version.revision })}>恢复此版本</Button></details>)}
      </>}
    </>}
    <p className="dsh-character-status" role="status" aria-live="polite">{controller.message}</p>
    <Modal open={!!confirm} className="dsh-character-modal" title={confirm?.action === 'enable' ? '开启这个角色的成长？' : confirm?.action === 'clear' ? '清空这个角色的成长？' : confirm?.action === 'restore' ? `恢复到版本 ${confirm.version}？` : '撤回这条变化？'} description={description} closeLabel="取消" onClose={() => { if (!busy) setConfirm(undefined) }} footer={<div className="dsh-character-actions"><Button variant="ghost" disabled={busy} onClick={() => setConfirm(undefined)}>取消</Button><Button variant="primary" disabled={busy} onClick={() => { if (confirm) void controller.change(character.id, confirm.action, { entryId: confirm.entryId, version: confirm.version }).then(saved => { if (saved) setConfirm(undefined) }) }}>{busy ? '保存中…' : '确认'}</Button></div>}><GrowthError controller={controller} characterId={character.id} />{confirm?.action === 'enable' && status?.compatibility && <details className="dsh-character-explanation"><summary>兼容模式说明</summary><p>{status.compatibility}</p></details>}</Modal>
    <Modal open={controller.editing?.characterId === character.id} className="dsh-character-modal" title="纠正相处方式" description="保存后下一轮生效，自动学习不能覆盖。身份与价值观请在基本人设中编辑。" closeLabel="取消纠正" onClose={closeEditing} footer={<div className="dsh-character-actions"><Button variant="ghost" disabled={busy} onClick={closeEditing}>取消</Button><Button variant="primary" disabled={busy || controller.conflict || !controller.editing?.text.trim()} onClick={() => void controller.correct()}>{busy ? '保存中…' : '保存纠正'}</Button></div>}><GrowthError controller={controller} characterId={character.id} /><label className="dsh-character-field">纠正内容<textarea disabled={busy} rows={6} maxLength={600} value={controller.editing?.text ?? ''} onChange={event => controller.editText(event.target.value)} /></label></Modal>
  </section>
}
