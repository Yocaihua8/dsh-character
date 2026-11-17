/** UI-only portrait metadata. Never included in character prompts or session messages. */
export interface CharacterVisual {
  characterId: string
  revision: number
  source: 'builtin' | 'upload' | 'none'
  url: string | null
}

export const CHARACTER_AVATAR_PATH = '/api/dsh-character/avatar'
export const CHARACTER_AVATAR_UPLOAD_PATH = `${CHARACTER_AVATAR_PATH}/upload`
export const CHARACTER_AVATAR_MAX_BYTES = 2 * 1024 * 1024
