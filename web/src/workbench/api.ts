import type { Schema } from './model'
export { PRODUCT_NAME as WORKBENCH_NAME } from '@/lib/brand'
export interface Snapshot {
  columns: string[]; index: unknown[]; values: unknown[][]; dtypes: string[]
  row_sources: number[]; column_sources: number[]; source: Record<string, unknown>
  row_count: number; column_count: number; preview_row_count?: number; preview_column_count?: number
}
export interface FigureOutput { stem: string; title?: string; preview_url: string }
export function figureOutputs(value: { outputs?: FigureOutput[]; preview_url?: string }): FigureOutput[] {
  return value.outputs?.length ? value.outputs : value.preview_url ? [{ stem: 'figure', preview_url: value.preview_url }] : []
}
export interface Plot {
  id: string; project_id: string; name: string; state: 'CODE_EDITABLE' | 'TAVOTTO_ONLY'
  code: string; data: Snapshot | null; schema: Schema; source: { kind: string; template_id?: string; original_path?: string }
  revision: number; saved_revision: number; preview_url?: string; outputs?: FigureOutput[]; export_directory?: string; error?: string
}
export interface Project { id: string; name: string; path: string; working_directory?: string; plots: Plot[]; plot_count?: number }
export interface Template {
  id: string; name: string; scope: 'global' | 'project'; project_id?: string; category_id?: string; favorite: boolean
  code: string; data: Snapshot | null; schema: Schema; preview_url?: string; outputs?: FigureOutput[]; revision: number
}
export interface Category { id: string; name: string; scope: 'global' | 'project'; project_id?: string }
export interface Status { root: string; version: string; projects: Project[] }
export interface Job {
  id: string; status: 'running' | 'success' | 'error' | 'cancelled'; error?: string; traceback?: string
  result?: { run_id: string; preview_url: string; outputs?: FigureOutput[]; data?: Snapshot; schema?: Schema }
}
export interface Run { runId: string; fingerprint: string; previewUrl: string; outputs?: FigureOutput[] }
export class WorkbenchError extends Error {
  code?: string
  detail?: unknown
  constructor(message: string, code?: string, detail?: unknown) { super(message); this.code = code; this.detail = detail }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/workbench${path}`, { credentials: 'same-origin', ...init, headers: { ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...init.headers } })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new WorkbenchError(String(body.message ?? body.error ?? `请求失败 (${response.status})`), String(body.code ?? ''), body)
  return body as T
}
export const post = <T,>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body: JSON.stringify(body) })
export const patch = <T,>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
export const remove = (path: string) => api<unknown>(path, { method: 'DELETE' })
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
export async function download(path: string, filename: string): Promise<void> {
  const response = await fetch(`/api/workbench${path}`, { credentials: 'same-origin' })
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.message ?? body.error ?? '导出失败') }
  const href = URL.createObjectURL(await response.blob())
  const link = document.createElement('a'); link.href = href; link.download = filename; link.click()
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}
export const STARTER_CODE = `import matplotlib.pyplot as plt\n\n# 导入的数据可直接通过 data 使用；未导入时使用下面的示例。\nif "data" in globals() and data is not None:\n    x, y = data.iloc[:, 0], data.iloc[:, 1]\nelse:\n    x, y = [1, 2, 3, 4, 5], [2, 4, 3, 6, 7]\n\nfig, ax = plt.subplots(figsize=(5, 3.5))\nax.plot(x, y, "o-", color="#29465b")\nax.set(xlabel="x", ylabel="y")\nfig.tight_layout()\n`
