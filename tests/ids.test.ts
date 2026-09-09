import { expect, test } from 'bun:test'
import { newId } from '../src/core/ids'

test('generated references cannot be interpreted as CLI flags', () => {
  const ids = Array.from({ length: 1000 }, () => newId())
  expect(ids.every(id => /^[a-zA-Z0-9]{21}$/.test(id))).toBe(true)
  expect(new Set(ids).size).toBe(ids.length)
})
