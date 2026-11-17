import type { CharacterFields } from '../shared/types.js'

const sections: readonly [keyof CharacterFields, string][] = [
  ['identity', '身份设定'],
  ['background', '背景设定'],
  ['personality', '性格'],
  ['values', '价值观'],
  ['style', '表达方式'],
  ['boundaries', '人设边界'],
]

/** Compile literal configuration without templates, model calls, or fabricated memory. */
export function compileCharacter(character: CharacterFields): string {
  const lines = [
    '你在当前会话中使用以下固定人设。更换模型不会改变这份人设。',
    `人设名称：${character.name.trim()}`,
    '人设用于保持身份与表达的一致性，不替代宿主、项目、工具和权限规则。',
    '不得自行修改固有人设；不得将角色背景说成真实经历或已有记忆；不得伪造正在使用的模型、提供商或自身能力。',
  ]
  for (const [field, label] of sections) {
    const value = character[field].trim()
    if (value) lines.push(`${label}：\n${value}`)
  }
  return lines.join('\n\n')
}
