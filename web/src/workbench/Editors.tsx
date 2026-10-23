import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { TextInput } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Dialog } from '@/components/ui/Dialog'
import { Tab, TabList, TabPanel } from '@/components/ui/Tabs'
import { BookOpen, ChevronDown, ChevronRight, Download, FileCodeCorner, Play, Save, Upload } from '@/components/ui/icons'
import { isDesktop, pickDirectory, pickScriptFile } from '@/lib/desktop'
import { DataTable, DataTransform, DataWizard } from './DataWizard'
import { download, errorText, figureOutputs, patch, post, STARTER_CODE, type Category, type FigureOutput, type Plot, type Run, type Snapshot, type Template } from './api'
import { canCommitRun, DEFAULT_SCHEMA, fingerprintOf, schemaSummary, type Schema } from './model'
import { TavottoEditor, type TavottoSession } from './TavottoEditor'
import { useRenderJob } from './useRenderJob'

export function PlotEditor({ initial, templates, onChanged, onBack, onDirtyChange }: { initial: Plot; templates: Template[]; onChanged: (plot: Plot) => void; onBack: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const [plot, setPlot] = useState(initial)
  const [code, setCode] = useState(initial.code || STARTER_CODE)
  const [data, setData] = useState<Snapshot | null>(initial.data)
  const [schema, setSchema] = useState<Schema>(initial.schema ?? DEFAULT_SCHEMA)
  const [templateId, setTemplateId] = useState(initial.source?.template_id)
  const [originalPath, setOriginalPath] = useState(initial.source?.original_path ?? '')
  const [codeOpen, setCodeOpen] = useState(false)
  const [dataOpen, setDataOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [compatible, setCompatible] = useState<Template[]>([])
  const [checkingTemplates, setCheckingTemplates] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [session, setSession] = useState<TavottoSession | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const [outputs, setOutputs] = useState(() => figureOutputs(initial))
  const [selectedStem, setSelectedStem] = useState(() => figureOutputs(initial)[0]?.stem ?? 'figure')
  const selectedOutput = outputs.find((output) => output.stem === selectedStem) ?? outputs[0]
  const stem = selectedOutput?.stem ?? 'figure'
  const preview = selectedOutput?.preview_url ?? ''
  const [savedFingerprint, setSavedFingerprint] = useState(figureOutputs(initial).length ? fingerprintOf(initial.code || STARTER_CODE, initial.data, initial.schema ?? DEFAULT_SCHEMA, { templateId: initial.source?.template_id ?? null, originalPath: initial.source?.original_path ?? null }) : '')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const codeFileRef = useRef<HTMLInputElement>(null)
  const jobs = useRenderJob()
  const locked = plot.state === 'TAVOTTO_ONLY'
  const origin = { templateId: templateId ?? null, originalPath: originalPath || null }
  const fingerprint = fingerprintOf(code, data, schema, origin)
  const current = canCommitRun(fingerprint, run, jobs.busy)
  const saved = savedFingerprint === fingerprint && !!preview && !jobs.busy
  const dirty = savedFingerprint !== fingerprint
  useDraftGuard(dirty || !!session, onDirtyChange)
  useEffect(() => {
    if (!pickerOpen) return
    if (!data) { setCompatible(templates); return }
    let active = true
    setCompatible([]); setCheckingTemplates(true)
    void post<{ templates: Template[] }>('/templates/compatible', { data, project_id: initial.project_id }).then((result) => { if (active) setCompatible(result.templates) }).catch((e) => { if (active) setError(errorText(e)) }).finally(() => { if (active) setCheckingTemplates(false) })
    return () => { active = false }
  }, [pickerOpen, data, templates, initial.project_id])
  async function render() {
    setError(''); setMessage(''); setRun(null)
    const result = await jobs.start(`/plots/${plot.id}/render`, { code, data, schema, template_id: templateId, original_path: originalPath || undefined })
    if (result?.status === 'success' && result.result) {
      const nextData = result.result.data ?? data
      const nextSchema = result.result.schema ?? schema
      const nextOutputs = figureOutputs(result.result)
      setData(nextData); setSchema(nextSchema); setOutputs(nextOutputs)
      if (!nextOutputs.some((output) => output.stem === selectedStem)) setSelectedStem(nextOutputs[0]?.stem ?? 'figure')
      setRun({ runId: result.result.run_id, fingerprint: fingerprintOf(code, nextData, nextSchema, origin), previewUrl: result.result.preview_url, outputs: nextOutputs })
      setMessage(`运行成功，共 ${nextOutputs.length} 张图。保存将保存本次全部结果。`)
    }
  }
  async function save() {
    if (!current || !run) return
    setSaving(true); setError('')
    try {
      const next = await post<Plot>(`/plots/${plot.id}/save`, { run_id: run.runId })
      setPlot(next); setOriginalPath(next.source?.original_path ?? ''); setSavedFingerprint(fingerprint); onChanged(next); setMessage('已保存到项目。')
    } catch (e) { setError(errorText(e)) } finally { setSaving(false) }
  }
  async function openTavotto() {
    setSaving(true); setError('')
    try { setSession(await post<TavottoSession>(`/plots/${plot.id}/tavotto/open`, { stem })) }
    catch (e) { setError(errorText(e)) } finally { setSaving(false) }
  }
  function acceptPlot(next: Plot) {
    setPlot(next); setCode(next.code); setData(next.data); setSchema(next.schema); setOriginalPath(next.source?.original_path ?? ''); setOutputs(figureOutputs(next))
    setSavedFingerprint(fingerprintOf(next.code, next.data, next.schema, { templateId: next.source?.template_id ?? null, originalPath: next.source?.original_path ?? null })); setSession(null); setRun(null); onChanged(next); setMessage('Tavotto 修改已验证并保存。')
  }
  async function importCode() {
    setError('')
    if (isDesktop()) {
      try {
        const path = await pickScriptFile('选择 Python 绘图代码')
        if (!path) return
        const script = await post<{ code: string; name: string; path: string }>('/scripts/read', { path })
        setCode(script.code); setOriginalPath(script.path); setTemplateId(undefined); setCodeOpen(true)
        setMessage(`已导入 ${script.name}.py。运行并保存后，可将代码另存或替换原文件。`)
      } catch (e) { setError(errorText(e)) }
      return
    }
    codeFileRef.current?.click()
  }
  function acceptCodeFile(file?: File) {
    if (!file) return
    void file.text().then((text) => {
      setCode(text.replace(/^\uFEFF/, '')); setOriginalPath(''); setTemplateId(undefined); setCodeOpen(true)
      setMessage(`已导入 ${file.name}。运行并保存后可导出代码包。`)
    }).catch((e) => setError(errorText(e)))
  }
  if (session) return <TavottoEditor session={session} onFinish={acceptPlot} onCancel={() => setSession(null)} />
  return <div className="wb-plot-editor" data-wb-plot-editor>
    <div className="wb-page-heading"><div><h1>{plot.name}</h1><p>{locked ? '已进入 Tavotto 编辑流程 · 代码、数据和模板只读' : '运行 Python 代码后保存结果。'}</p></div><div className="wb-toolbar"><Button onClick={() => { if (!dirty || window.confirm('当前代码或数据尚未保存，离开后将丢弃这些修改。')) onBack() }}>返回项目</Button><Button variant="secondary" disabled={!saved || saving} onClick={openTavotto} data-wb-open-tavotto>使用 Tavotto 继续编辑</Button><Button variant="primary" disabled={!saved || saving} onClick={() => setExportOpen(true)} data-wb-export><Download />导出</Button></div></div>
    <div className="wb-editor-bar"><div className="wb-toolbar"><input ref={codeFileRef} hidden type="file" accept=".py" data-wb-plot-code-upload onChange={(e) => { acceptCodeFile(e.target.files?.[0]); e.currentTarget.value = '' }} /><Button active={codeOpen} onClick={() => setCodeOpen(!codeOpen)} data-wb-code-toggle>{codeOpen ? <ChevronDown /> : <ChevronRight />}<FileCodeCorner />Python 代码</Button><Button disabled={locked || jobs.busy} onClick={() => void importCode()}><Upload />导入代码</Button><Button disabled={locked || jobs.busy} onClick={() => setImportOpen(true)}><Upload />导入数据</Button><Button active={dataOpen} disabled={!data} onClick={() => setDataOpen(!dataOpen)}>数据 {data ? `${data.row_count} × ${data.column_count}` : ''}</Button><Button disabled={locked || jobs.busy} onClick={() => setPickerOpen(true)}><BookOpen />选择模板</Button></div><div className="wb-toolbar"><span className={`wb-status-dot ${dirty ? 'is-dirty' : ''}`}>{jobs.busy ? '正在运行' : dirty ? '有未保存修改' : '已保存'}</span>{jobs.busy ? <Button variant="secondary" onClick={jobs.cancel}>取消运行</Button> : <Button variant="secondary" disabled={locked || saving} onClick={render} data-wb-run><Play />运行</Button>}<Button variant="primary" disabled={!current || saving || locked} loading={saving} onClick={save} data-wb-save><Save />保存</Button></div></div>
    {(error || jobs.error) && <ErrorPanel error={error || jobs.error} traceback={jobs.job?.traceback} />}
    {message && !error && !jobs.error && <div className="wb-notice" role="status">{message}</div>}
    {locked && <div className="wb-lock-notice">此图已完成 Tavotto 写回。请使用「使用 Tavotto 继续编辑」调整图中元素。</div>}
    <div className={`wb-figure-workspace ${codeOpen ? 'has-code' : ''}`}>
      {codeOpen && <CodePane code={code} onChange={setCode} readOnly={locked || jobs.busy} />}
      <FigurePreview outputs={outputs} selectedStem={stem} onSelect={setSelectedStem} stale={!!preview && !current && dirty} busy={jobs.busy} />
    </div>
    {dataOpen && data && <div className="wb-data-drawer"><DataTransform data={data} disabled={locked || jobs.busy} onChange={setData} /><DataTable data={data} /></div>}
    {importOpen && <DataWizard onClose={() => setImportOpen(false)} onImport={(next) => { setData(next); setDataOpen(true); setImportOpen(false); setMessage('数据已导入，请重新运行。') }} />}
    {pickerOpen && <Dialog open title="选择绘图模板" description={data ? '仅显示与当前数据维度和列类型兼容的模板。' : '选入模板后可使用示例数据，或导入自己的数据。'} onOpenChange={setPickerOpen} width={900} anchor="workbench-template-picker"><div className="wb-template-picker">{compatible.map((template) => <TemplateChoice key={template.id} template={template} onClick={() => { setCode(template.code); setSchema(template.schema); setTemplateId(template.id); setOriginalPath(''); if (!data) setData(template.data); setPickerOpen(false); setCodeOpen(true) }} />)}{compatible.length === 0 && <p className="wb-empty-inline">{checkingTemplates ? '正在检查模板兼容性…' : '暂无兼容模板，可在模板库调整数据规范。'}</p>}</div></Dialog>}
    {exportOpen && <ExportDialog plot={plot} stem={stem} hasOriginalPath={!!plot.source?.original_path} onClose={() => setExportOpen(false)} />}
  </div>
}

export function TemplateEditor({ initial, categories, projectId, defaultScope = 'global', onSaved, onBack, onDirtyChange }: { initial?: Template; categories: Category[]; projectId?: string; defaultScope?: 'global' | 'project'; onSaved: (template: Template) => void; onBack: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const [name, setName] = useState(initial?.name ?? '未命名模板')
  const [code, setCode] = useState(initial?.code ?? STARTER_CODE)
  const [data, setData] = useState<Snapshot | null>(initial?.data ?? null)
  const [schema, setSchema] = useState<Schema>(initial?.schema ?? DEFAULT_SCHEMA)
  const [scope, setScope] = useState<'global' | 'project'>(initial?.scope ?? defaultScope)
  const [categoryId, setCategoryId] = useState(initial?.category_id ?? 'uncategorized')
  const [outputs, setOutputs] = useState(() => initial ? figureOutputs(initial) : [])
  const [selectedStem, setSelectedStem] = useState(() => initial ? figureOutputs(initial)[0]?.stem ?? 'figure' : 'figure')
  const selectedOutput = outputs.find((output) => output.stem === selectedStem) ?? outputs[0]
  const preview = selectedOutput?.preview_url ?? ''
  const [run, setRun] = useState<Run | null>(null)
  const [savedFingerprint, setSavedFingerprint] = useState(initial?.id ? fingerprintOf(initial.code, initial.data, initial.schema) : '')
  const [importOpen, setImportOpen] = useState(false)
  const [metadataOpen, setMetadataOpen] = useState(false)
  const [dataOpen, setDataOpen] = useState(false)
  const [error, setError] = useState('')
  const uploadRef = useRef<HTMLInputElement>(null)
  const jobs = useRenderJob()
  const fingerprint = fingerprintOf(code, data, schema)
  const valid = canCommitRun(fingerprint, run, jobs.busy)
  const contentChanged = fingerprint !== savedFingerprint
  useDraftGuard(contentChanged || name !== (initial?.name ?? '未命名模板') || categoryId !== (initial?.category_id ?? 'uncategorized'), onDirtyChange)
  async function validate() {
    setError(''); setRun(null)
    const result = await jobs.start('/templates/validate', { code, data, schema })
    if (result?.status === 'success' && result.result) {
      const nextData = result.result.data ?? data; const nextSchema = result.result.schema ?? schema
      const nextOutputs = figureOutputs(result.result)
      setData(nextData); setSchema(nextSchema); setOutputs(nextOutputs)
      if (!nextOutputs.some((output) => output.stem === selectedStem)) setSelectedStem(nextOutputs[0]?.stem ?? 'figure')
      setRun({ runId: result.result.run_id, fingerprint: fingerprintOf(code, nextData, nextSchema), previewUrl: result.result.preview_url, outputs: nextOutputs })
    }
  }
  async function save() {
    setError('')
    try {
      const metadata = { name, category_id: categoryId || 'uncategorized', ...(!initial?.id ? { scope, project_id: scope === 'project' ? projectId : undefined } : {}) }
      const payload = contentChanged || !initial?.id ? { ...metadata, code, data, schema, run_id: run?.runId } : metadata
      const template = initial?.id ? await patch<Template>(`/templates/${initial.id}`, payload) : await post<Template>('/templates', payload)
      setSavedFingerprint(fingerprint); onSaved(template)
    } catch (e) { setError(errorText(e)) }
  }
  return <div className="wb-template-editor" data-wb-template-editor>
    <div className="wb-page-heading"><div><h1>{initial?.id ? '编辑模板' : '创建模板'}</h1><p>运行验证后保存模板。</p></div><div className="wb-toolbar"><Button onClick={() => { if (!contentChanged || window.confirm('模板代码或数据尚未保存，离开后将丢弃修改。')) onBack() }}>返回模板库</Button><Button variant="primary" disabled={!name.trim() || jobs.busy || ((contentChanged || !initial?.id) && !valid)} onClick={save} data-wb-template-save><Save />保存模板</Button></div></div>
    <div className="wb-template-metadata"><label className="wb-name-input">模板名称<TextInput aria-label="模板名称" value={name} onChange={(e) => setName(e.target.value)} /></label><label className="wb-field-inline">存放位置<Select ariaLabel="存放位置" value={scope} disabled={!!initial?.id} onChange={(v) => { setScope(v as 'global' | 'project'); setCategoryId('uncategorized') }} options={[{ value: 'global', label: '全局模板库' }, ...(projectId || initial?.project_id ? [{ value: 'project', label: '项目模板库' }] : [])]} /></label><label className="wb-field-inline">分类<Select ariaLabel="模板分类" value={categoryId || 'uncategorized'} onChange={setCategoryId} options={[{ value: 'uncategorized', label: '未分类' }, ...categories.filter((c) => c.scope === scope && c.id !== 'uncategorized').map((c) => ({ value: c.id, label: c.name }))]} /></label><Button variant="secondary" disabled={jobs.busy} onClick={() => setMetadataOpen(true)}>数据规范</Button></div>
    <div className="wb-editor-bar"><div className="wb-toolbar"><input hidden ref={uploadRef} type="file" accept=".py" data-wb-template-upload onChange={(e) => { const file = e.target.files?.[0]; if (file) void file.text().then((text) => { setCode(text); if (!initial) setName(file.name.replace(/\.py$/i, '')) }) }} /><Button disabled={jobs.busy} onClick={() => uploadRef.current?.click()}><Upload />上传 Python</Button><Button disabled={jobs.busy} onClick={() => setImportOpen(true)}>导入示例数据</Button><Button disabled={!data} active={dataOpen} onClick={() => setDataOpen(!dataOpen)}>查看数据{data ? ` ${data.row_count} × ${data.column_count}` : ''}</Button><span className="wb-muted">支持普通脚本与 build_figure(data) 模板</span></div>{jobs.busy ? <Button variant="secondary" onClick={jobs.cancel}>取消运行</Button> : <Button variant="secondary" onClick={validate} data-wb-template-run><Play />运行并验证</Button>}</div>
    {(error || jobs.error) && <ErrorPanel error={error || jobs.error} traceback={jobs.job?.traceback} />}
    <div className="wb-figure-workspace has-code"><CodePane code={code} onChange={setCode} readOnly={jobs.busy} /><FigurePreview outputs={outputs} selectedStem={selectedOutput?.stem ?? 'figure'} onSelect={setSelectedStem} stale={!!preview && contentChanged && !valid} busy={jobs.busy} /></div>
    {dataOpen && data && <div className="wb-data-drawer"><DataTransform data={data} onChange={setData} disabled={jobs.busy} /><DataTable data={data} /></div>}
    {importOpen && <DataWizard onClose={() => setImportOpen(false)} onImport={(next) => { setData(next); setDataOpen(true); setImportOpen(false) }} />}
    {metadataOpen && <SchemaDialog schema={schema} onClose={() => setMetadataOpen(false)} onChange={(next) => { setSchema(next); setMetadataOpen(false) }} />}
  </div>
}
function CodePane({ code, onChange, readOnly }: { code: string; onChange: (code: string) => void; readOnly?: boolean }) {
  const lines = code.split('\n').length
  return <section className="wb-code-pane"><div className="wb-pane-heading"><span>Python</span><span>{readOnly ? '只读' : '可编辑'} · {lines} 行</span></div><textarea aria-label="Python 代码" spellCheck={false} value={code} readOnly={readOnly} data-wb-code onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => {
    if (e.key === 'Tab' && !readOnly) { e.preventDefault(); const el = e.currentTarget; const start = el.selectionStart; const end = el.selectionEnd; onChange(code.slice(0, start) + '    ' + code.slice(end)); requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = start + 4 }) }
  }} /><div className="wb-code-hint">普通 matplotlib 脚本可直接运行；兼容 build_figure(data) 模板</div></section>
}
function FigurePreview({ outputs, selectedStem, onSelect, stale, busy }: { outputs: FigureOutput[]; selectedStem: string; onSelect: (stem: string) => void; stale: boolean; busy: boolean }) {
  const previewId = useId()
  const selected = outputs.find((output) => output.stem === selectedStem) ?? outputs[0]
  const url = selected?.preview_url ?? ''
  const panelId = `${previewId}-${selected?.stem ?? 'empty'}`
  return <section className="wb-preview-pane" data-wb-preview><div className="wb-pane-heading"><span>图形预览{outputs.length > 1 ? ` · ${outputs.length} 张图` : ''}</span><span>{busy ? '正在运行…' : stale ? '旧预览 · 修改尚未运行' : url ? '已运行' : '等待首次运行'}</span></div>{outputs.length > 1 && <div className="wb-output-tabs"><TabList label="运行结果">{outputs.map((output, index) => <Tab key={output.stem} active={selected?.stem === output.stem} panelId={`${previewId}-${output.stem}`} onClick={() => onSelect(output.stem)} data-wb-output={output.stem}><img src={output.preview_url} alt="" /><span>{output.title || `图 ${index + 1}`}</span></Tab>)}</TabList></div>}<TabPanel id={panelId} className="wb-preview-surface" aria-label={outputs.length > 1 ? undefined : '图形预览'} aria-labelledby={outputs.length > 1 ? `${panelId}-tab` : undefined}>{url ? <img data-wb-preview-image src={url} alt={selected?.title || '绘图结果预览'} /> : <div className="wb-preview-empty"><h3>暂无预览</h3><p>运行代码后显示结果。</p></div>}{busy && <div className="wb-running">正在运行 Python…</div>}</TabPanel><div className="wb-editor-foot">{stale ? '请重新运行并保存后再导出。' : 'PNG · 600 dpi / SVG / PDF'}</div></section>
}
export function TemplateChoice({ template, onClick }: { template: Template; onClick: () => void }) {
  return <Button className="wb-template-choice" onClick={onClick}><div className="wb-choice-preview">{template.preview_url ? <img src={template.preview_url} alt="" /> : <BookOpen />}</div><strong>{template.name}</strong><span className="wb-muted">{schemaSummary(template.schema)}</span></Button>
}
function ErrorPanel({ error, traceback }: { error: string; traceback?: string }) {
  const [expanded, setExpanded] = useState(false)
  return <div className="wb-error" role="alert"><div className="wb-toolbar"><strong>运行未完成</strong><span>{error}</span>{traceback && <Button onClick={() => setExpanded(!expanded)}>{expanded ? '收起详情' : '查看详情'}</Button>}</div>{expanded && <pre>{traceback}</pre>}</div>
}
function SchemaDialog({ schema, onChange, onClose }: { schema: Schema; onChange: (schema: Schema) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(schema)
  const [roles, setRoles] = useState(JSON.stringify(schema.column_roles ?? [], null, 2))
  const [error, setError] = useState('')
  return <Dialog open title="模板数据规范" description="固定或可变行列数；列角色 index 从 1 开始。" onOpenChange={(v) => { if (!v) onClose() }} width={580} footer={<Button variant="primary" onClick={() => { try { const parsed = JSON.parse(roles); if (!Array.isArray(parsed) || parsed.some((r: { index?: number; dtype?: string }) => !Number.isInteger(r.index) || (r.index ?? 0) < 1 || !['numeric', 'text', 'any'].includes(r.dtype ?? ''))) throw new Error('列角色应为数组，包含 index、name 和 dtype (numeric/text/any)。'); onChange({ ...draft, column_roles: parsed }) } catch (e) { setError(errorText(e)) } }}>应用规范</Button>}>
    <div className="wb-schema-editor">{(['rows', 'columns'] as const).map((key) => <div key={key} className="wb-schema-axis"><strong>{key === 'rows' ? '行数' : '列数'}</strong><Select ariaLabel={`${key}模式`} value={draft[key].mode} onChange={(mode) => setDraft({ ...draft, [key]: { mode, ...(mode === 'fixed' ? { value: 2 } : { min: 1 }) } })} options={[{ value: 'variable', label: '可变' }, { value: 'fixed', label: '固定' }]} /><TextInput aria-label={`${key}数量`} type="number" min={1} value={draft[key].mode === 'fixed' ? draft[key].value : draft[key].min ?? 1} onChange={(e) => setDraft({ ...draft, [key]: { ...draft[key], [draft[key].mode === 'fixed' ? 'value' : 'min']: Number(e.target.value) } })} /><span className="wb-muted">{draft[key].mode === 'fixed' ? '恰好' : '至少'}</span></div>)}<label className="wb-field">说明<TextInput value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label><label className="wb-field">列角色（JSON）<textarea className="wb-json-input" aria-label="列角色 JSON" spellCheck={false} value={roles} onChange={(e) => setRoles(e.target.value)} /></label><p className="wb-help">示例：[{`{"index":1,"name":"x","dtype":"numeric"}`}]{' '}数值列可用于横轴、纵轴或误差值。</p>{error && <p className="wb-error">{error}</p>}</div>
  </Dialog>
}
function ExportDialog({ plot, stem, hasOriginalPath, onClose }: { plot: Plot; stem: string; hasOriginalPath: boolean; onClose: () => void }) {
  const [directory, setDirectory] = useState(() => plot.export_directory ?? localStorage.getItem('workbench.exportDirectory') ?? '')
  const [replace, setReplace] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  async function exportImage(format: string) {
    setError('')
    try {
      if (isDesktop()) { const result = await post<{ path: string }>(`/plots/${plot.id}/export-image`, { format, stem }); setMessage(`已保存：${result.path}`) }
      else { await download(`/plots/${plot.id}/export?format=${format}&stem=${encodeURIComponent(stem)}`, `${plot.name}${stem === 'figure' ? '' : `-${stem}`}.${format}`); setMessage(`${format.toUpperCase()} 已导出。`) }
    }
    catch (e) { setError(errorText(e)) }
  }
  async function exportCode() {
    setError(''); setMessage('')
    try {
      if (replace) {
        if (!hasOriginalPath) throw new Error('此子图没有可替换的外部 Python 源文件。')
        const result = await post<{ path: string; backup?: string }>(`/plots/${plot.id}/export-code`, { replace: true })
        setMessage(`已替换 ${result.path}${result.backup ? `；原文件备份：${result.backup}` : ''}`)
        return
      }
      if (!directory && !isDesktop()) { await download(`/plots/${plot.id}/code-package`, `${plot.name}-code.zip`); setMessage('代码与数据包已下载。'); return }
      const chosen = directory || await pickDirectory('选择代码导出目录')
      if (!chosen) return
      const result = await post<{ path: string; backup?: string }>(`/plots/${plot.id}/export-code`, { directory: chosen, replace })
      localStorage.setItem('workbench.exportDirectory', chosen); setDirectory(chosen); setMessage(`已导出至 ${result.path}${result.backup ? `；备份：${result.backup}` : ''}`)
    } catch (e) { setError(errorText(e)) }
  }
  return <Dialog open title="导出图形与代码" description={plot.name} onOpenChange={(v) => { if (!v) onClose() }} width={580} anchor="workbench-export"><div className="wb-export-form"><h3>图形文件</h3><div className="wb-export-formats">{['png', 'svg', 'pdf'].map((format) => <Button key={format} variant="secondary" onClick={() => exportImage(format)} data-wb-export-format={format}><Download />{format.toUpperCase()}{format === 'png' && <span className="wb-muted">600 dpi</span>}</Button>)}</div><div className="wb-divider" /><h3>Python 代码与数据</h3><p className="wb-help">导出独立运行的脚本及数据快照。模板源文件受到保护。</p>{!replace && <div className="wb-path-row"><TextInput aria-label="代码导出目录" placeholder={isDesktop() ? '请选择输出目录' : '输入服务器可访问的目录；留空则下载 ZIP'} value={directory} onChange={(e) => setDirectory(e.target.value)} />{isDesktop() && <Button onClick={async () => { const path = await pickDirectory('选择代码导出目录'); if (path) setDirectory(path) }}>浏览…</Button>}</div>}{hasOriginalPath ? <Select ariaLabel="代码保存方式" value={replace ? 'replace' : 'new'} onChange={(v) => setReplace(v === 'replace')} options={[{ value: 'new', label: '另存为新代码文件' }, { value: 'replace', label: '替换原始 Python 文件（自动备份）' }]} /> : <p className="wb-help">此子图没有可替换的外部源文件；另存时会保留已有文件并创建新文件。</p>}<Button variant="secondary" onClick={exportCode}><FileCodeCorner />{replace ? '替换原始代码' : !directory && !isDesktop() ? '下载代码包 ZIP' : '导出代码与数据'}</Button>{error && <p className="wb-error" role="alert">{error}</p>}{message && <p className="wb-notice" role="status">{message}</p>}</div></Dialog>
}
function useDraftGuard(dirty: boolean, onDirtyChange?: (dirty: boolean) => void) {
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false) }, [dirty, onDirtyChange])
  useEffect(() => {
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])
}
