import type { Schema } from './model'
export { PRODUCT_NAME as WORKBENCH_NAME } from '@/lib/brand'
export interface Snapshot {
  columns: string[]; index: unknown[]; values: unknown[][]; dtypes: string[]
  row_sources: number[]; column_sources: number[]; source: Record<string, unknown>
  row_count: number; column_count: number; preview_row_count?: number; preview_column_count?: number
}
export interface Plot {
  id: string; project_id: string; name: string; state: 'CODE_EDITABLE' | 'TAVOTTO_ONLY'
  code: string; data: Snapshot | null; schema: Schema; source: { kind: string; template_id?: string; original_path?: string }
  revision: number; saved_revision: number; preview_url?: string; error?: string
}
export interface Project { id: string; name: string; path: string; plots: Plot[]; plot_count?: number }
export interface Template {
  id: string; name: string; scope: 'global' | 'project'; project_id?: string; category_id?: string; favorite: boolean
  code: string; data: Snapshot | null; schema: Schema; preview_url?: string; revision: number
}
export interface Category { id: string; name: string; scope: 'global' | 'project'; project_id?: string }
export interface Status { root: string; version: string; projects: Project[] }
export interface Job {
  id: string; status: 'running' | 'success' | 'error' | 'cancelled'; error?: string; traceback?: string
  result?: { run_id: string; preview_url: string; data?: Snapshot; schema?: Schema }
}
export interface Run { runId: string; fingerprint: string; previewUrl: string }
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
export const STARTER_CODE = `import matplotlib.pyplot as plt\n\ndef example_data():\n    import pandas as pd\n    return pd.DataFrame({"x": [1, 2, 3, 4, 5], "y": [2, 4, 3, 6, 7]})\n\ndef build_figure(data):\n    fig, ax = plt.subplots(figsize=(5, 3.5))\n    ax.plot(data.iloc[:, 0], data.iloc[:, 1], "o-", color="#29465b")\n    ax.set(xlabel="x", ylabel="y")\n    fig.tight_layout()\n    return fig\n`
