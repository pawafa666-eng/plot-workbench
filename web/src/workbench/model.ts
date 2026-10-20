export interface Range { start: number; end: number }
export interface AxisSchema { mode: 'fixed' | 'variable'; value?: number; min?: number }
export interface Schema { rows: AxisSchema; columns: AxisSchema; column_roles?: { index: number; name: string; dtype: 'numeric' | 'text' | 'any' }[]; description?: string }
export function schemaSummary(schema: Schema): string {
  const axis = (value: AxisSchema) => value.mode === 'fixed' ? `${value.value ?? '?'} ` : `${value.min ?? 0}+ `
  return `${axis(schema.rows)}行 × ${axis(schema.columns)}列`
}
export function canCommitRun(fingerprint: string, run: { runId: string; fingerprint: string } | null, busy: boolean): boolean {
  return !busy && !!run?.runId && run.fingerprint === fingerprint
}
export function expandRanges(ranges: Range[], size: number): number[] {
  if (!ranges.length || size < 1) throw new Error('请选择非空的数据范围。')
  const result = new Set<number>()
  for (const [position, range] of ranges.entries()) {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) throw new Error('范围起止位置应为整数。')
    if (range.start === 0 && position !== 0) throw new Error('只有第一段的起始位置可以为 0。')
    if (range.end === 0 && position !== ranges.length - 1) throw new Error('只有最后一段的结束位置可以为 0。')
    const start = range.start === 0 ? 1 : range.start; const end = range.end === 0 ? size : range.end
    if (start < 1 || end < start || end > size) throw new Error('范围应在数据边界内。')
    for (let i = start; i <= end; i++) {
      if (result.has(i - 1)) throw new Error('数据范围不能重叠。')
      result.add(i - 1)
    }
  }
  return [...result]
}
export const DEFAULT_SCHEMA: Schema = { rows: { mode: 'variable', min: 1 }, columns: { mode: 'variable', min: 1 } }
export const fingerprintOf = (code: string, data: unknown, schema: Schema, origin?: unknown) => JSON.stringify([code, data, schema, origin ?? null])
