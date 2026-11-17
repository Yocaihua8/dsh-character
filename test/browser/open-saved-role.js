async page => {
  if (new URL(page.url()).host !== '127.0.0.1:5503') throw new Error('Use only the isolated acceptance profile')
  const onboarding = page.getByRole('dialog', { name: '开始使用' })
  if (await onboarding.isVisible()) await onboarding.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '选择角色', exact: true }).click()
  await page.getByRole('menuitem', { name: '管理角色', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '角色', exact: true })
  await dialog.getByRole('checkbox', { name: '显示已归档' }).check()
  await dialog.getByRole('button', { name: /青禾 · 验收 已归档/ }).click()
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 1280, height: 900 })
  await dialog.getByRole('button', { name: '关闭角色管理' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'output/playwright/character-dialog-dark.png' })
}
