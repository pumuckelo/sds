import { customAlphabet } from 'nanoid'

// IDs and their short references must be safe as positional CLI arguments.
export const newId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 21)
