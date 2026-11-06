import { useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { FileCodeCorner, LayoutGrid, Upload, Trash2, RefreshCw } from '@/components/ui/icons'
import { errorText, type Snapshot } from './api'

export function TemplateFiles({ codeName, data, disabled, onCode, onExcel, onRemoveCode, onRemoveData }: {
  codeName?: string; data: Snapshot | null; disabled: boolean
  onCode: (code: string, name: string) => void; onExcel: (file: File) => void
  onRemoveCode: () => void; onRemoveData: () => void
}) {
  const picker = useRef<HTMLInputElement>(null)
  const replacement = useRef<HTMLInputElement>(null)
  const sequence = useRef(0)
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  const [dragging, setDragging] = useState(false)
  async function accept(files: File[]) {
    if (disabled || !files.length) return
    setError('')
    const scripts = files.filter((f) => /\.py$/i.test(f.name))
    const tables = files.filter((f) => /\.(xlsx|xls)$/i.test(f.name))
    if (files.length > 2 || scripts.length > 1 || tables.length > 1 || scripts.length + tables.length !== files.length) {
      setError('最多选择两个文件：一个 Python（.py）和一个 Excel（.xlsx / .xls）。'); return
    }
    if (scripts[0]?.size > 2_000_000 || tables[0]?.size > 128 * 1024 * 1024) {
      setError('Python 不得超过 2 MB，Excel 不得超过 128 MB。'); return
    }
    const token = ++sequence.current
    setReading(true)
    try {
      const code = scripts[0] ? await scripts[0].text() : null
      if (token !== sequence.current) return
      if (code !== null) onCode(code.replace(/^\uFEFF/, ''), scripts[0].name)
      if (tables[0]) onExcel(tables[0])
    } catch (e) { setError(errorText(e)) }
    finally { if (token === sequence.current) setReading(false) }
  }
  const excelName = data ? String(data.source.filename ?? 'data.xlsx') : ''
  function replace(kind: 'code' | 'excel') { if (replacement.current) { replacement.current.accept = kind === 'code' ? '.py' : '.xlsx,.xls'; replacement.current.click() } }
  return <section className={`wb-template-files ${dragging ? 'is-dragging' : ''}`} data-wb-template-files
    onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true) }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }}
    onDrop={(e) => { e.preventDefault(); setDragging(false); void accept(Array.from(e.dataTransfer.files)) }}>
    <input hidden multiple type="file" accept=".py,.xlsx,.xls" ref={picker} data-wb-template-upload disabled={disabled || reading} onChange={(e) => { void accept(Array.from(e.target.files ?? [])); e.currentTarget.value = '' }} />
    <input hidden type="file" ref={replacement} data-wb-template-replace disabled={disabled || reading} onChange={(e) => { void accept(Array.from(e.target.files ?? [])); e.currentTarget.value = '' }} />
    <div className="wb-template-upload-heading"><div><strong>代码与 Excel 数据</strong><p>拖入文件，或选择一个 .py 和一个 Excel；可以分两次上传。</p></div><Button variant="secondary" disabled={disabled || reading} data-wb-template-upload-trigger onClick={() => picker.current?.click()}><Upload />上传数据和代码</Button></div>
    <h3 className="wb-uploaded-title">已上传文件</h3><div className="wb-uploaded-files">{(['code', 'excel'] as const).map((kind) => {
      const filename = kind === 'code' ? codeName : excelName
      return <div className="wb-uploaded-file" data-wb-uploaded-file={kind} key={kind}><span className={`wb-file-app-icon is-${kind}`}>{kind === 'code' ? <FileCodeCorner /> : <LayoutGrid />}<small>{kind === 'code' ? 'PY' : 'X'}</small></span><div><strong>{filename || (kind === 'code' ? '尚未上传 Python' : '尚未上传 Excel')}</strong><small>{kind === 'excel' && data ? `${data.row_count} 行 × ${data.column_count} 列 · 运行时生成 data.xlsx` : kind === 'code' ? 'Python 绘图代码' : 'Excel 绘图数据'}</small></div>{filename && <div className="wb-toolbar"><Button title={`替换${kind === 'code' ? '代码' : 'Excel'}`} disabled={disabled || reading} data-wb-file-replace={kind} onClick={() => replace(kind)}><RefreshCw />替换</Button><Button title={`删除${kind === 'code' ? '代码' : 'Excel'}`} disabled={disabled || reading} data-wb-file-delete={kind} onClick={kind === 'code' ? onRemoveCode : onRemoveData}><Trash2 />删除</Button></div>}</div>
    })}</div><p className="wb-help wb-template-input-hint">Excel 文件须与 Python 代码位于同一目录。软件将最终选区统一保存为 data.xlsx，代码请读取该文件或使用 data 表格。</p>{error && <p className="wb-error" role="alert">{error}</p>}
  </section>
}
