import { describe, expect, it } from 'vitest'
import { canCommitRun, expandRanges, fingerprintOf, type Range, DEFAULT_SCHEMA } from './model'

describe('workbench draft and data gates', () => {
  it('requires the successful run to describe the current editable draft', () => {
    expect(canCommitRun('draft-b', { runId: 'run-a', fingerprint: 'draft-a' }, false)).toBe(false)
    expect(canCommitRun('draft-a', { runId: 'run-a', fingerprint: 'draft-a' }, false)).toBe(true)
    expect(canCommitRun('draft-a', { runId: 'run-a', fingerprint: 'draft-a' }, true)).toBe(false)
    expect(canCommitRun('draft-a', null, false)).toBe(false)
  })
  it('interprets zero only as the first start or last end boundary', () => {
    expect(expandRanges([{ start: 0, end: 0 }], 4)).toEqual([0, 1, 2, 3])
    expect(expandRanges([{ start: 1, end: 2 }, { start: 4, end: 4 }], 4)).toEqual([0, 1, 3])
    expect(expandRanges([{ start: 0, end: 2 }, { start: 4, end: 0 }], 4)).toEqual([0, 1, 3])
    expect(() => expandRanges([{ start: 1, end: 2 }, { start: 0, end: 4 }] as Range[], 4)).toThrow()
    expect(() => expandRanges([{ start: 1, end: 0 }, { start: 3, end: 4 }] as Range[], 4)).toThrow()
    expect(() => expandRanges([{ start: 4, end: 7 }], 4)).toThrow()
  })
  it('rejects overlapping or empty selections instead of silently plotting another range', () => {
    expect(() => expandRanges([{ start: 1, end: 3 }, { start: 3, end: 4 }], 4)).toThrow()
    expect(() => expandRanges([], 4)).toThrow()
    expect(() => expandRanges([{ start: 0, end: 0 }], 0)).toThrow()
  })
  it('invalidates a saved run when its template or external source changes', () => {
    const code = 'def build_figure(data): return None'
    expect(fingerprintOf(code, null, DEFAULT_SCHEMA, { templateId: 'template-a' })).not.toBe(
      fingerprintOf(code, null, DEFAULT_SCHEMA, { templateId: 'template-b' }),
    )
    expect(fingerprintOf(code, null, DEFAULT_SCHEMA, { originalPath: 'a.py' })).not.toBe(
      fingerprintOf(code, null, DEFAULT_SCHEMA, { originalPath: 'b.py' }),
    )
  })
})
