import whaleGirl from '../../characters/whale-girl.json' with { type: 'json' }
import type { CharacterFields } from '../shared/types.js'

/** A stable identity makes startup idempotent without matching user-authored names. */
export const BUILTIN_WHALE_GIRL_ID = 'builtin:whale-girl'
export const BUILTIN_WHALE_GIRL_FIELDS: Readonly<CharacterFields> = Object.freeze(whaleGirl.fields)
