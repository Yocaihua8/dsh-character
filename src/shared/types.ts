/** User-authored, model-independent character definition. */
export interface CharacterFields {
  name: string
  identity: string
  background: string
  personality: string
  values: string
  style: string
  boundaries: string
}

export interface Character extends CharacterFields {
  id: string
  revision: number
  archived: boolean
}

export interface SaveCharacterRequest {
  id?: string
  expectedRevision?: number
  fields: CharacterFields
}

export interface CharacterBinding {
  sessionId: string
  characterId: string
  locked: boolean
}

export interface CharacterBindingStatus {
  binding: CharacterBinding | null
  character: Character | null
  canBind: boolean
  reason: string
}

export const CHARACTER_NAME_LIMIT = 80
export const CHARACTER_TEXT_LIMIT = 16_000

export const EMPTY_CHARACTER_FIELDS: CharacterFields = {
  name: '', identity: '', background: '', personality: '', values: '', style: '', boundaries: '',
}

/** Owner-selected role applied only to genuinely new main-agent sessions. */
export interface DefaultCharacterStatus {
  characterId: string | null
  revision: number
  character: Character | null
  unavailableReason: string
}
