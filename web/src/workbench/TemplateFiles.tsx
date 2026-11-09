import { useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Upload, Trash2, RefreshCw } from '@/components/ui/icons'
import pythonIcon from '../../assets/workbench/python.svg'
import excelIcon from '../../assets/workbench/excel.svg'
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
  const [helpOpen, setHelpOpen] = useState(false)
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
    <div className="wb-template-upload-heading"><strong>代码与数据</strong><div className="wb-toolbar"><Button data-wb-template-help onClick={() => setHelpOpen(true)}>提示</Button><Button variant="secondary" disabled={disabled || reading} data-wb-template-upload-trigger onClick={() => picker.current?.click()}><Upload />上传数据和代码</Button></div></div>
    <div className="wb-uploaded-files">{(['code', 'excel'] as const).map((kind) => {
      const filename = kind === 'code' ? codeName : excelName
      return <div className="wb-uploaded-file" data-wb-uploaded-file={kind} data-wb-file-state={filename ? 'ready' : 'missing'} key={kind}><span className={`wb-file-app-icon is-${kind}`}><img src={kind === 'code' ? pythonIcon : excelIcon} alt="" aria-hidden="true" /></span><div><strong>{filename || (kind === 'code' ? '尚未上传 Python' : '尚未上传 Excel')}</strong><small>{kind === 'excel' && data ? `${data.row_count} 行 × ${data.column_count} 列 · 运行时生成 data.xlsx` : kind === 'code' ? 'Python 绘图代码' : 'Excel 绘图数据'}</small></div>{filename && <div className="wb-toolbar"><Button title={`替换${kind === 'code' ? '代码' : 'Excel'}`} disabled={disabled || reading} data-wb-file-replace={kind} onClick={() => replace(kind)}><RefreshCw />替换</Button><Button title={`删除${kind === 'code' ? '代码' : 'Excel'}`} disabled={disabled || reading} data-wb-file-delete={kind} onClick={kind === 'code' ? onRemoveCode : onRemoveData}><Trash2 />删除</Button></div>}</div>
    })}</div>{error && <p className="wb-error" role="alert">{error}</p>}
    {helpOpen && <Dialog open title="上传提示" description="创建可重复使用的数据绘图模板。" anchor="workbench-template-help" width={680} onOpenChange={(v) => setHelpOpen(v)} footer={<Button variant="primary" onClick={() => setHelpOpen(false)}>知道了</Button>}>
      <div className="wb-template-help-content"><h3>准备代码与数据</h3><ul><li>上传一个 Python 代码文件（.py）和一个 Excel 数据表（.xlsx 或 .xls），可同时拖入，也可分开选择。</li><li>不要将绘图数据写死在代码中；请让代码读取与脚本同级的 <code>data.xlsx</code> 文件。软件会把选中的数据整理为这个文件，供代码运行使用。</li><li>数据应覆盖模板实际使用的范围；使用模板时可从自己的 Excel 中选择需要的行和列。</li></ul><pre>{"from pathlib import Path\nimport pandas as pd\ndata = pd.read_excel(Path(__file__).with_name('data.xlsx'))"}</pre><h3>确认数据要求</h3><p>运行成功后，分别为行数和列数设置适用范围。行数不含表头，数据不能为空：</p><ul><li><strong>+ 至少：</strong>例如 2+ 表示至少 2 行（或列）。</li><li><strong>− 至多：</strong>例如 2− 表示至多 2 行（或列）。</li><li><strong>± 数量不限：</strong>当前数量仅作示例，实际行数或列数可变。</li><li><strong>无符号：</strong>例如 2 表示必须恰好为 2 行（或列）。</li></ul><p>请根据代码的实际要求核查设置；更换数据后仍需运行验证。</p></div>
    </Dialog>}
  </section>
}
