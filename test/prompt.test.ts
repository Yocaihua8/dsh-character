import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileCharacter } from '../src/host/prompt.js'
import { EMPTY_CHARACTER_FIELDS } from '../src/shared/types.js'

test('a fixed character renders every configured field with explicit identity and policy boundaries', () => {
  const prompt = compileCharacter({
    name: ' 青禾 ', identity: '知识向导', background: '来自架空书院', personality: '耐心且坦诚',
    values: '证据与好奇心', style: '简短中文，先结论后解释', boundaries: '不使用嘲讽语气',
  })
  for (const expected of ['人设名称：青禾', '身份设定：\n知识向导', '背景设定：\n来自架空书院', '性格：\n耐心且坦诚',
    '价值观：\n证据与好奇心', '表达方式：\n简短中文，先结论后解释', '人设边界：\n不使用嘲讽语气']) assert.ok(prompt.includes(expected), expected)
  assert.match(prompt, /更换模型不会改变/u)
  assert.match(prompt, /不替代宿主、项目、工具和权限规则/u)
  assert.match(prompt, /不得自行修改固有人设/u)
  assert.match(prompt, /不得将角色背景说成真实经历或已有记忆/u)
  assert.match(prompt, /不得伪造正在使用的模型、提供商或自身能力/u)
})

test('unconfigured fields are absent and character text remains literal without template expansion', () => {
  const fields = { ...EMPTY_CHARACTER_FIELDS, name: '助手', style: '保持 {{user.name}}、${MODEL} 和 <persona> 的原文。' }
  const prompt = compileCharacter(fields)
  assert.match(prompt, /表达方式：\n保持 \{\{user\.name\}\}、\$\{MODEL\} 和 <persona> 的原文。/u)
  for (const heading of ['身份设定：', '背景设定：', '性格：', '价值观：', '人设边界：']) assert.ok(!prompt.includes(heading))
  assert.deepEqual(fields, { ...EMPTY_CHARACTER_FIELDS, name: '助手', style: '保持 {{user.name}}、${MODEL} 和 <persona> 的原文。' })
})
