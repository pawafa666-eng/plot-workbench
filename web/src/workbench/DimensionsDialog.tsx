import { useState } from 'react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { TextInput } from '@/components/ui/Input'
import { errorText, type Snapshot } from './api'
import type { AxisSchema, Schema } from './model'

export function DimensionsDialog({ schema, data, onClose, onChange }: { schema: Schema; data: Snapshot | null; onClose: () => void; onChange: (schema: Schema) => void | Promise<void> }) {
  const [draft, setDraft] = useState(schema)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function confirm() {
    for (const axis of [draft.rows, draft.columns]) {
      const value = axis.mode === 'fixed' ? axis.value : axis.mode === 'maximum' ? axis.max : axis.min
      if (axis.mode !== 'any' && (!Number.isInteger(value) || (value ?? 0) < 1)) { setError('数量须为正整数。'); return }
    }
    setBusy(true); setError('')
    try { await onChange(draft) } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <Dialog open busy={busy} title="确认模板数据要求" anchor="workbench-dimensions" width={600} onOpenChange={(v) => { if (!v) onClose() }}
    description={data ? `本次输入数据：${data.row_count} 行 × ${data.column_count} 列（行数不含表头）` : '设置模板允许的数据尺寸'}
    footer={<><Button disabled={busy} onClick={onClose}>返回</Button><Button variant="primary" loading={busy} data-wb-dimensions-confirm onClick={() => void confirm()}>确认数据要求</Button></>}>
    <div className="wb-schema-editor">{(['rows', 'columns'] as const).map((key) => {
      const axis = draft[key]
      const value = axis.value ?? axis.min ?? axis.max ?? (key === 'rows' ? data?.row_count : data?.column_count) ?? 1
      return <div key={key} className="wb-schema-axis" data-wb-axis={key}><strong>{key === 'rows' ? '行数' : '列数'}</strong><Select ariaLabel={`${key}模式`} value={axis.mode} onChange={(mode) => setDraft({ ...draft, [key]: { mode, ...(mode === 'fixed' ? { value } : mode === 'maximum' ? { max: value } : mode === 'variable' ? { min: value } : {}) } as AxisSchema })} options={[{ value: 'variable', label: '+ 至少' }, { value: 'maximum', label: '− 至多' }, { value: 'any', label: '± 数量不限' }, { value: 'fixed', label: '无 · 必须相等' }]} /><TextInput aria-label={`${key}数量`} data-wb-axis-count={key} type="number" min={1} disabled={axis.mode === 'any'} value={value} onChange={(e) => setDraft({ ...draft, [key]: { ...axis, [axis.mode === 'fixed' ? 'value' : axis.mode === 'maximum' ? 'max' : 'min']: Number(e.target.value) } })} /></div>
    })}<p className="wb-help">例如 2+ 表示至少 2；2− 表示至多 2；± 表示数量不限；无表示恰好 2。数据均不能为空。这是模板的适用范围声明，换数据后仍需运行验证。</p>{error && <p className="wb-error" role="alert">{error}</p>}</div>
  </Dialog>
}
