// Run after selecting the bundled Whale Girl and opening 查看 / 编辑角色 in a fresh isolated profile.
async page => {
  if (new URL(page.url()).host !== '127.0.0.1:5503') throw new Error('Use only the isolated acceptance profile')
  const dialog = page.getByRole('dialog', { name: '角色', exact: true })
  const fields = [
    ['角色名称', '鲸鱼娘'],
    ['身份与自我定位', '社区二创角色'],
    ['背景与经历', '白米饭'],
    ['性格', '小傲娇'],
    ['价值观', '诚实'],
    ['表达方式', '本鲸'],
    ['角色边界', '不得编造工具结果'],
  ]
  for (const [label, expected] of fields) {
    const value = await dialog.getByRole('textbox', { name: new RegExp(`^${label}`) }).inputValue()
    if (!value.includes(expected)) throw new Error(`Missing bundled field: ${label}`)
  }
  if (!(await page.getByRole('button', { name: '角色：鲸鱼娘', exact: true }).isVisible())) throw new Error('Binding is not reflected in the composer')
  if (!(await dialog.getByRole('button', { name: '保存角色', exact: true }).isDisabled())) throw new Error('Fresh record should have no unsaved edits')
  await page.setViewportSize({ width: 1280, height: 900 })
  await dialog.getByRole('button', { name: '关闭角色管理' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'output/playwright/whale-builtin-editor.png' })
  console.log('Bundled Whale Girl: seven fields, persisted binding and clean editor verified.')
}
