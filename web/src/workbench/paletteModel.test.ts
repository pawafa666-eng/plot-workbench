import { describe, expect, it } from 'vitest'
import { expandGradient, normalizeHex, samplePixel } from './paletteModel'

describe('palette color operations', () => {
  it('normalizes short and long hexadecimal colors', () => {
    expect(normalizeHex('#a1b')).toBe('#AA11BB')
    expect(normalizeHex('bbccdd')).toBe('#BBCCDD')
    expect(normalizeHex('#12')).toBeNull()
    expect(normalizeHex('#abcdef00')).toBeNull()
  })

  it('inserts exactly the requested colors between adjacent endpoints', () => {
    expect(expandGradient(['#111111', '#000000', '#FFFFFF', '#222222'], 1, 2, 3))
      .toEqual(['#111111', '#000000', '#808080', '#FFFFFF', '#222222'])
    const result = expandGradient(['#008000', '#FF0000'], 1, 0, 100)
    expect(result).toHaveLength(100)
    expect([result[0], result[99]]).toEqual(['#008000', '#FF0000'])
    expect(() => expandGradient(['#000000', '#444444', '#FFFFFF'], 0, 2, 5)).toThrow()
    expect(() => expandGradient(['#000000', '#FFFFFF'], 0, 1, 1)).toThrow()
  })

  it('composites transparent image pixels against white', () => {
    expect(samplePixel([255, 0, 0, 128])).toBe('#FF7F7F')
    expect(samplePixel([0, 0, 0, 0])).toBe('#FFFFFF')
    expect(samplePixel([0, 128, 255, 255])).toBe('#0080FF')
  })
})
