import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Download } from '@/components/ui/icons'
import { download, type Snapshot } from './api'
import { DataTable, DataTransform } from './DataWizard'

export function DataPreviewDialog({ data, onChange, onClose, onError, disabled, canExport = true }: {
  data: Snapshot; onChange: (data: Snapshot) => void; onClose: () => void; onError: (error: unknown) => void; disabled?: boolean; canExport?: boolean
}) {
  const [transforming, setTransforming] = useState(false)
  function exportData() {
    void download('/data/workbook', 'data.xlsx', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) }).catch(onError)
  }
  return <Dialog open busy={transforming} anchor="workbench-data-preview" title="查看数据" description="可以交换行列或转置数据；更改后需重新运行。" width={1100} height="min(78vh, 760px)" onOpenChange={(v) => { if (!v) onClose() }}
    footer={<>{canExport && <Button disabled={transforming} onClick={exportData}><Download />导出本次绘图数据</Button>}<Button disabled={transforming} variant="primary" onClick={onClose}>完成</Button></>}>
    <div className="wb-data-dialog"><DataTransform data={data} onChange={onChange} disabled={disabled} onBusyChange={setTransforming} /><DataTable data={data} /></div>
  </Dialog>
}
import { useState } from 'react'
