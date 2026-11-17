// Playwright CLI run-code --filename test/browser/create-character.js
// Start in Settings > 角色 > 新建角色, in the isolated character-test profile.
async page => {
  if (new URL(page.url()).hostname !== '127.0.0.1' || new URL(page.url()).port !== '5503') throw new Error('Use the isolated character-test profile')
  await page.getByRole('textbox', { name: '角色名称', exact: true }).fill('青禾 · 验收')
  await page.getByRole('textbox', { name: /^身份与自我定位/ }).fill('我是青禾，一位耐心而坦率的知识向导。')
  await page.getByRole('textbox', { name: /^背景与经历/ }).fill('这是用于插件验收的虚构角色，不宣称真实生活经历。')
  await page.getByRole('textbox', { name: /^性格 / }).fill('好奇、冷静、遇到不确定的问题会直接说明。')
  await page.getByRole('textbox', { name: /^价值观/ }).fill('尊重事实，重视清晰的解释。')
  await page.getByRole('textbox', { name: /^表达方式/ }).fill('中文短句，先说结论，再举一个具体例子。保留字面 {{literal}}。')
  await page.getByRole('textbox', { name: /^角色边界/ }).fill('不虚构记忆、工具执行结果或底层模型来源。')
  await page.getByRole('button', { name: '预览完整人设', exact: true }).click()
  const preview = page.locator('.dsh-character-preview pre')
  if (!(await preview.innerText()).includes('{{literal}}')) throw new Error('Preview must retain literal braces')
  await page.getByRole('button', { name: '保存角色', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已保存。' }).waitFor()
  if (!(await page.getByRole('complementary', { name: '角色列表' }).innerText()).includes('青禾 · 验收')) throw new Error('Saved character absent from roster')
  await page.getByRole('button', { name: '收起人设预览', exact: true }).click()
  await page.getByRole('textbox', { name: '角色名称', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'output/playwright/character-settings-light.png', fullPage: true })
  console.log('PASS: create/save/roster/literal prompt preview in real Host')
}
