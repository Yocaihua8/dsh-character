async page => {
  if (new URL(page.url()).host !== '127.0.0.1:5503') throw new Error('Use only the isolated acceptance profile')
  const dialog = page.getByRole('dialog', { name: '角色', exact: true })
  await dialog.waitFor()
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 1280, height: 900 })
  await dialog.getByRole('button', { name: '关闭角色管理' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'output/playwright/character-dialog-light.png' })
  await page.setViewportSize({ width: 420, height: 800 })
  await dialog.getByRole('button', { name: '关闭角色管理' }).scrollIntoViewIfNeeded()
  const size = await page.evaluate(() => {
    const body = document.querySelector('.dsh-character-dialog-body')
    return { viewport: innerWidth, document: document.documentElement.scrollWidth, dialogWidth: body.clientWidth, dialogScroll: body.scrollWidth }
  })
  if (size.document > size.viewport || size.dialogScroll > size.dialogWidth) throw new Error(`Horizontal overflow: ${JSON.stringify(size)}`)
  await page.screenshot({ path: 'output/playwright/character-narrow.png' })
  await page.setViewportSize({ width: 1280, height: 900 })
  await dialog.getByRole('button', { name: '关闭角色管理' }).click()
  if (await page.locator('style[data-dsh-plugin="dsh-character"]').count() !== 1) throw new Error('Duplicate plugin style')
  if (await page.locator('[data-character-selector="true"]').count() !== 1) throw new Error('Duplicate composer entry')
}
