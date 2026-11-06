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
  validation_state?: 'pending'; updated_at?: string; created_at?: string; base_code?: string
}
export interface Project { id: string; name: string; path: string; working_directory?: string; plots: Plot[]; plot_count?: number; updated_at?: string; created_at?: string; preview_url?: string; missing?: boolean }
export interface Template {
  id: string; name: string; scope: 'global' | 'project'; project_id?: string; category_id?: string; favorite: boolean
  code: string; data: Snapshot | null; schema: Schema; preview_url?: string; outputs?: FigureOutput[]; revision: number
  validation_state?: 'pending'
}
export interface Category { id: string; name: string; scope: 'global' | 'project'; project_id?: string }
export interface Status { root: string; version: string; projects: Project[]; library_confirmed?: boolean }
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
export async function download(path: string, filename: string, init: RequestInit = {}): Promise<void> {
  const response = await fetch(`/api/workbench${path}`, { credentials: 'same-origin', ...init })
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.message ?? body.error ?? '导出失败') }
  const href = URL.createObjectURL(await response.blob())
  const link = document.createElement('a'); link.href = href; link.download = filename; link.click()
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}
export const STARTER_CODE = `import pandas as pd
import matplotlib.pyplot as plt

# Excel 与代码在同一目录；软件将选区统一保存为 data.xlsx。
data = pd.read_excel("data.xlsx", sheet_name="Data")
x, y = data.iloc[:, 0], data.iloc[:, 1]

fig, ax = plt.subplots(figsize=(5, 3.5))
ax.plot(x, y, "o-", color="#29465b")
ax.set(xlabel=str(data.columns[0]), ylabel=str(data.columns[1]))
fig.tight_layout()
`
