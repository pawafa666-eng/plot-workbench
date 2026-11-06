import type { PanelOverride } from '@/types/document'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { TextInput } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Dialog } from '@/components/ui/Dialog'
import { Tab, TabList, TabPanel } from '@/components/ui/Tabs'
import { BookOpen, ChevronDown, ChevronRight, Download, FileCodeCorner, Play, Save, Upload } from '@/components/ui/icons'
import { isDesktop, pickDirectory, pickScriptFile } from '@/lib/desktop'
import { newId } from '@/lib/id'
import { DataTable, DataTransform, DataWizard } from './DataWizard'
import { api, download, errorText, figureOutputs, patch, post, STARTER_CODE, type Category, type FigureOutput, type Job, type Plot, type Run, type Snapshot, type Template } from './api'
import { canCommitRun, DEFAULT_SCHEMA, fingerprintOf, schemaSummary, type Schema } from './model'
import { TavottoEditor, type TavottoSession } from './TavottoEditor'
import { useRenderJob } from './useRenderJob'
import { CodeAssistant } from './CodeAssistant'
import { useAssistantBinding, type AssistantSource, type TemplateAssistantDraft } from './AssistantHost'
import { DraftStatus, useEditorDraft, useWorkspace, type EditorDraft } from './Recovery'
import { HistoryButton } from './HistoryPanel'
import { TemplateFiles } from './TemplateFiles'
import { DimensionsDialog } from './DimensionsDialog'

export function PlotEditor({ initial, templates, onChanged, onBack, onDirtyChange, resumeSession, resumePatches, onReturnAssistant, onNavigationGuard, restoredDraft, onRestoreCopy }: { restoredDraft?: EditorDraft; onRestoreCopy?: (value: Plot | Template) => void; initial: Plot; templates: Template[]; onChanged: (plot: Plot) => void; onBack: () => void; onDirtyChange?: (dirty: boolean) => void; resumeSession?: TavottoSession; resumePatches?: PanelOverride[]; onReturnAssistant?: (source: AssistantSource) => void | Promise<void>; onNavigationGuard?: (guard: (() => boolean) | null) => void }) {
  const workspace = useWorkspace()
  const restored = restoredDraft?.kind === 'plot' ? restoredDraft.content : null
  const [pendingCanvas, setPendingCanvas] = useState(restoredDraft?.kind === 'canvas' ? restoredDraft : null)
  const [plot, setPlot] = useState(initial)
  const [code, setCode] = useState(restored ? String(restored.code) : initial.code || STARTER_CODE)
  const [data, setData] = useState<Snapshot | null>(restored ? restored.data as Snapshot | null : initial.data)
  const [schema, setSchema] = useState<Schema>(restored ? restored.schema as Schema : initial.schema ?? DEFAULT_SCHEMA)
  const [templateId, setTemplateId] = useState(restored?.templateId as string | undefined ?? initial.source?.template_id)
  const [originalPath, setOriginalPath] = useState(restored ? String(restored.originalPath ?? '') : initial.source?.original_path ?? '')
  const [codeOpen, setCodeOpen] = useState(false)
  const [dataOpen, setDataOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [compatible, setCompatible] = useState<Template[]>([])
  const [checkingTemplates, setCheckingTemplates] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [session, setSession] = useState<TavottoSession | null>(resumeSession ?? null)
  const [run, setRun] = useState<Run | null>(null)
  const [outputs, setOutputs] = useState(() => figureOutputs(initial))
  const [selectedStem, setSelectedStem] = useState(() => resumeSession?.stem ?? figureOutputs(initial)[0]?.stem ?? 'figure')
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
  const pendingValidation = plot.validation_state === 'pending'
  const saved = !pendingValidation && savedFingerprint === fingerprint && !!preview && !jobs.busy
  const dirty = savedFingerprint !== fingerprint
  const draft = useEditorDraft({ kind: 'plot', entity_id: plot.id, project_id: plot.project_id, name: plot.name, base_revision: plot.revision,
    content: { code, data, schema, templateId, originalPath, selectedStem }, signature: fingerprint, dirty: dirty && !locked, enabled: !session, restored: restoredDraft?.kind === 'plot' ? restoredDraft : undefined })
  useDraftGuard(dirty || !!session, onDirtyChange)
  useEffect(() => {
    if (!pickerOpen) return
    if (!data) { setCompatible([]); return }
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
      setPlot(next); setOriginalPath(next.source?.original_path ?? ''); setSavedFingerprint(fingerprint); await draft.clear(); onChanged(next); setMessage('已保存到项目。')
    } catch (e) { setError(errorText(e)) } finally { setSaving(false) }
  }
  async function openTavotto() {
    setSaving(true); setError('')
    try {
      if (pendingCanvas) setSession(await post<TavottoSession>(`/plots/${plot.id}/draft-session`, { draft_id: pendingCanvas.id, generation: pendingCanvas.generation, library_root: workspace.root }))
      else setSession(await post<TavottoSession>(`/plots/${plot.id}/tavotto/open`, { stem }))
    }
    catch (e) { setError(errorText(e)) } finally { setSaving(false) }
  }
  function acceptPlot(next: Plot) {
    setPlot(next); setCode(next.code); setData(next.data); setSchema(next.schema); setOriginalPath(next.source?.original_path ?? ''); setOutputs(figureOutputs(next))
    setSavedFingerprint(fingerprintOf(next.code, next.data, next.schema, { templateId: next.source?.template_id ?? null, originalPath: next.source?.original_path ?? null })); setSession(null); setRun(null); onChanged(next); setMessage('图内修改已验证并保存。')
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
  if (session) return <TavottoEditor draftTarget={plot} restoredDraft={pendingCanvas ?? undefined} session={session} resumePatches={resumePatches} targetLabel={`${plot.name} · ${session.stem}`} data={data} schema={schema} onNavigationGuard={onNavigationGuard} onReturnAssistant={onReturnAssistant} onFinish={(next) => { setPendingCanvas(null); acceptPlot(next) }} onCancel={() => { setSession(null); setPendingCanvas(null) }} />
  return <div className="wb-plot-editor" data-wb-plot-editor>
    <div className="wb-page-heading"><div><h1>{plot.name}</h1><p>{locked ? '已进入图内编辑流程 · 代码、数据和模板只读' : '运行 Python 代码后保存结果。'}</p></div><div className="wb-toolbar"><Button onClick={async () => { try { await draft.flush(); onBack() } catch (e) { setError(errorText(e)) } }}>返回项目</Button><HistoryButton kind="plot" entity={plot} onRestored={(value) => onRestoreCopy?.(value)} /><Button variant="secondary" disabled={(!saved && !(pendingValidation && locked) && !pendingCanvas) || saving || jobs.busy} title={!saved && !pendingValidation && !pendingCanvas ? '请先运行并保存当前图' : undefined} onClick={openTavotto} data-wb-open-tavotto>{pendingCanvas ? '运行并恢复图内草稿' : pendingValidation && locked ? '验证历史副本' : '图内编辑'}</Button><Button variant="primary" disabled={!saved || saving} title={!saved ? '请先运行验证并保存当前结果' : undefined} onClick={() => setExportOpen(true)} data-wb-export><Download />导出</Button></div></div>
    <div className="wb-editor-bar"><div className="wb-toolbar"><input ref={codeFileRef} hidden type="file" accept=".py" data-wb-plot-code-upload onChange={(e) => { acceptCodeFile(e.target.files?.[0]); e.currentTarget.value = '' }} /><Button active={codeOpen} onClick={() => setCodeOpen(!codeOpen)} data-wb-code-toggle>{codeOpen ? <ChevronDown /> : <ChevronRight />}<FileCodeCorner />Python 代码</Button><Button disabled={locked || jobs.busy} onClick={() => void importCode()}><Upload />导入代码</Button><Button disabled={locked || jobs.busy} onClick={() => setImportOpen(true)}><Upload />导入数据</Button><Button active={dataOpen} disabled={!data} onClick={() => setDataOpen(!dataOpen)}>数据 {data ? `${data.row_count} × ${data.column_count}` : ''}</Button><Button data-wb-template-picker-open disabled={locked || jobs.busy || !data} title={!data ? '请先导入 Excel 并确认数据选区' : undefined} onClick={() => setPickerOpen(true)}><BookOpen />选择模板</Button></div><div className="wb-toolbar"><span className={`wb-status-dot ${dirty ? 'is-dirty' : ''}`}>{jobs.busy ? '正在运行' : pendingValidation ? '历史副本待验证' : current && dirty ? '已运行 · 待保存' : dirty ? '有未运行修改' : saved ? '已保存' : '等待首次运行'}</span>{jobs.busy ? <Button variant="secondary" onClick={jobs.cancel}>取消运行</Button> : <Button variant="secondary" disabled={locked || saving} onClick={render} data-wb-run><Play />运行</Button>}<Button variant="primary" disabled={!current || saving || locked} title={locked ? '请在图内编辑中完成并保存' : !current ? '请先运行当前代码和数据' : undefined} loading={saving} onClick={save} data-wb-save><Save />保存</Button></div></div>
    <div className="wb-editor-state-row"><DraftStatus draft={draft} />{restoredDraft && <span className="wb-muted">已载入恢复草稿；尚未自动运行。</span>}</div>
    {(error || jobs.error) && <ErrorPanel error={error || jobs.error} traceback={jobs.job?.traceback} />}
    {message && !error && !jobs.error && <div className="wb-notice" role="status">{message}</div>}
    {locked && <div className="wb-lock-notice">此图已完成图内编辑写回。请使用「图内编辑」调整图中元素。</div>}
    <div className={`wb-figure-workspace ${codeOpen ? 'has-code' : ''}`}>
      {codeOpen && <CodePane code={code} onChange={setCode} readOnly={locked || jobs.busy} />}
      <FigurePreview outputs={outputs} selectedStem={stem} onSelect={setSelectedStem} stale={!!preview && !current && dirty} unverified={pendingValidation && !current} busy={jobs.busy} />
    </div>
    {dataOpen && data && <div className="wb-data-drawer"><DataTransform data={data} disabled={locked || jobs.busy} onChange={setData} /><DataTable data={data} />{schema.input_format === 'excel' && <Button onClick={() => void download('/data/workbook', 'data.xlsx', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) }).catch((e) => setError(errorText(e)))}><Download />导出本次绘图数据</Button>}</div>}
    {importOpen && <DataWizard excelOnly onClose={() => setImportOpen(false)} onImport={(next) => { setData(next); setDataOpen(true); setImportOpen(false); setMessage('数据已导入，请重新运行。') }} />}
    {pickerOpen && <Dialog open title="选择绘图模板" description="使用已导入的 Excel 选区，仅显示尺寸和列类型兼容的模板。" onOpenChange={setPickerOpen} width={900} anchor="workbench-template-picker"><div className="wb-template-picker">{compatible.map((template) => <TemplateChoice key={template.id} template={template} onClick={() => { setCode(template.code); setSchema({ ...template.schema, input_format: 'excel' }); setTemplateId(template.id); setOriginalPath(''); setPickerOpen(false); setCodeOpen(true) }} />)}{compatible.length === 0 && <p className="wb-empty-inline">{checkingTemplates ? '正在检查模板兼容性…' : '暂无兼容模板，可在模板库调整数据规范。'}</p>}</div></Dialog>}
    {exportOpen && <ExportDialog plot={plot} stem={stem} hasOriginalPath={!!plot.source?.original_path} onClose={() => setExportOpen(false)} />}
  </div>
}

export type TemplateResume = TemplateAssistantDraft & { code: string; data: Snapshot | null; schema: Schema }
export function TemplateEditor({ initial, categories, projectId, defaultScope = 'global', onSaved, onBack, onDirtyChange, resume, onReturnAssistant, restoredDraft, onRestoreCopy }: { restoredDraft?: EditorDraft; onRestoreCopy?: (value: Plot | Template) => void; initial?: Template; categories: Category[]; projectId?: string; defaultScope?: 'global' | 'project'; onSaved: (template: Template) => void; onBack: () => void; onDirtyChange?: (dirty: boolean) => void; resume?: TemplateResume; onReturnAssistant?: (source: AssistantSource) => void | Promise<void> }) {
  const recovered = restoredDraft?.content
  const [codeOpen, setCodeOpen] = useState(true)
  const [assistantKey] = useState(() => resume?.assistantKey ?? newId('template-draft'))
  const [name, setName] = useState(recovered ? String(recovered.name ?? restoredDraft?.name) : resume?.name ?? initial?.name ?? '未命名模板')
  const [code, setCode] = useState(recovered ? String(recovered.code) : resume?.code ?? initial?.code ?? STARTER_CODE)
  const [data, setData] = useState<Snapshot | null>(recovered ? recovered.data as Snapshot | null : resume ? resume.data : initial?.data ?? null)
  const [schema, setSchema] = useState<Schema>(() => ({ ...(recovered ? recovered.schema as Schema : resume?.schema ?? initial?.schema ?? { rows: { mode: 'any' }, columns: { mode: 'any' } }), input_format: 'excel' }))
  const [scope, setScope] = useState<'global' | 'project'>(restoredDraft?.scope ?? resume?.scope ?? initial?.scope ?? defaultScope)
  const [categoryId, setCategoryId] = useState(recovered ? String(recovered.categoryId ?? 'uncategorized') : resume?.categoryId ?? initial?.category_id ?? 'uncategorized')
  const [outputs, setOutputs] = useState(() => resume?.outputs ?? (initial ? figureOutputs(initial) : []))
  const [selectedStem, setSelectedStem] = useState(() => resume?.selectedStem ?? (initial ? figureOutputs(initial)[0]?.stem ?? 'figure' : 'figure'))
  const selectedOutput = outputs.find((output) => output.stem === selectedStem) ?? outputs[0]
  const preview = selectedOutput?.preview_url ?? ''
  const [run, setRun] = useState<Run | null>(resume?.run ?? null)
  const [savedFingerprint, setSavedFingerprint] = useState(resume?.savedFingerprint ?? (initial?.id ? fingerprintOf(initial.code, initial.data, initial.schema) : ''))
  const pendingValidation = initial?.validation_state === 'pending'
  const [outputFingerprint, setOutputFingerprint] = useState(resume?.outputFingerprint ?? (initial?.id && !pendingValidation ? fingerprintOf(initial.code, initial.data, initial.schema) : ''))
  const [importOpen, setImportOpen] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [dimensionsConfirmed, setDimensionsConfirmed] = useState(resume?.dimensionsConfirmed ?? (!!initial?.id && initial.validation_state !== 'pending'))
  const [dimensionDraft, setDimensionDraft] = useState<Schema | null>(null)
  const [metadataOpen, setMetadataOpen] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [assistantStarted, setAssistantStarted] = useState(false)
  const [dataOpen, setDataOpen] = useState(false)
  const [error, setError] = useState('')
  const jobs = useRenderJob()
  const fingerprint = fingerprintOf(code, data, schema)
  const valid = canCommitRun(fingerprint, run, jobs.busy)
  const contentChanged = fingerprint !== savedFingerprint
  const dirty = contentChanged || name !== (initial?.name ?? '未命名模板') || categoryId !== (initial?.category_id ?? 'uncategorized')
  const draft = useEditorDraft({ kind: 'template', entity_id: initial?.id || undefined, project_id: scope === 'project' ? initial?.project_id ?? projectId : undefined, scope, name, base_revision: initial?.revision ?? 0, content: { code, data, schema, name, categoryId }, signature: fingerprint + JSON.stringify({ name, categoryId, scope }), dirty, restored: restoredDraft })
  const source: AssistantSource = { code, data, schema, contextKey: assistantKey, previewKey: selectedStem, targetLabel: `${name} · ${selectedStem}`,
    templateDraft: { assistantKey, name, scope, categoryId, projectId, outputs, selectedStem, run, savedFingerprint, outputFingerprint, dimensionsConfirmed },
    onPreview: async (result) => {
      if (result.code === undefined) throw new Error('Codex 未返回候选代码。')
      const existing = fingerprint === outputFingerprint && outputs.length ? outputs : undefined
      const [before, after] = await Promise.all([existing ? Promise.resolve(null) : renderTemplateComparison(code, data, schema), renderTemplateComparison(result.code, data, schema)])
      const beforeOutputs = existing ?? (before ? figureOutputs(before) : [])
      const afterOutputs = figureOutputs(after)
      const stems = [...new Set([...beforeOutputs, ...afterOutputs].map((item) => item.stem))].sort((a, b) => Number(b === selectedStem) - Number(a === selectedStem))
      if (!stems.length) throw new Error('没有可比较的图形。')
      const figures = stems.map((stem) => ({ stem, before: beforeOutputs.find((item) => item.stem === stem)?.preview_url ?? '', after: afterOutputs.find((item) => item.stem === stem)?.preview_url ?? '' }))
      return { before: figures[0].before, after: figures[0].after, figures }
    },
    onApply: (result) => { if (result.code === undefined) throw new Error('Codex 未返回可应用的模板代码。'); setCode(result.code); setSchema((s) => ({ ...s, code_filename: s.code_filename ?? 'source.py' })); setRun(null); setDimensionsConfirmed(false); setAssistantStarted(false) },
  }
  const assistant = useAssistantBinding(`template:${source.contextKey}`, source)
  useDraftGuard(dirty, onDirtyChange)
  async function validate() {
    setError(''); setRun(null); setDimensionsConfirmed(false)
    if (!data || !schema.code_filename || !code.trim()) { setError('请先上传 Python 和 Excel，并确认数据选区。'); return }
    const result = await jobs.start('/templates/validate', { code, data, schema })
    if (result?.status === 'success' && result.result) {
      const nextData = result.result.data ?? data; const nextSchema = result.result.schema ?? schema
      const nextOutputs = figureOutputs(result.result)
      setData(nextData); setSchema(nextSchema); setOutputs(nextOutputs)
      setOutputFingerprint(fingerprintOf(code, nextData, nextSchema))
      if (!nextOutputs.some((output) => output.stem === selectedStem)) setSelectedStem(nextOutputs[0]?.stem ?? 'figure')
      setDimensionDraft({ ...nextSchema, rows: { mode: 'fixed', value: nextData!.row_count }, columns: { mode: 'fixed', value: nextData!.column_count } }); setMetadataOpen(true)
      setRun({ runId: result.result.run_id, fingerprint: fingerprintOf(code, nextData, nextSchema), previewUrl: result.result.preview_url, outputs: nextOutputs })
    }
  }
  async function confirmDimensions(next: Schema) {
    if (run && valid) {
      const confirmed = await post<{ schema: Schema }>(`/jobs/${run.runId}/dimensions`, { code, data, schema, dimensions: { rows: next.rows, columns: next.columns } })
      setSchema(confirmed.schema); setRun({ ...run, fingerprint: fingerprintOf(code, data, confirmed.schema) }); setOutputFingerprint(fingerprintOf(code, data, confirmed.schema))
      setDimensionsConfirmed(true)
    } else { setSchema(next); setDimensionsConfirmed(false) }
    setMetadataOpen(false)
  }
  function changeData(next: Snapshot | null) { setData(next); setDimensionsConfirmed(false); setRun(null) }
  async function save() {
    setError('')
    try {
      const metadata = { name, category_id: categoryId || 'uncategorized', ...(!initial?.id ? { scope, project_id: scope === 'project' ? projectId : undefined } : {}) }
      const payload = contentChanged || !initial?.id || pendingValidation ? { ...metadata, code, data, schema, run_id: run?.runId } : metadata
      const template = initial?.id ? await patch<Template>(`/templates/${initial.id}`, payload) : await post<Template>('/templates', payload)
      setSavedFingerprint(fingerprint); await draft.clear(); onSaved(template)
    } catch (e) { setError(errorText(e)) }
  }
  return <div className="wb-template-editor" data-wb-template-editor>
    <div className="wb-page-heading"><div><h1>{initial?.id ? '编辑模板' : '创建模板'}</h1><p>运行验证后保存模板。</p></div><div className="wb-toolbar"><Button onClick={async () => { try { await draft.flush(); onBack() } catch (e) { setError(errorText(e)) } }}>返回模板库</Button>{initial?.id && <HistoryButton kind="template" entity={initial} onRestored={(value) => onRestoreCopy?.(value)} />}<Button variant="primary" title={!valid && (contentChanged || !initial?.id || pendingValidation) ? '请先运行并验证当前模板' : undefined} disabled={!name.trim() || jobs.busy || !data || !schema.code_filename || !dimensionsConfirmed || ((contentChanged || !initial?.id || pendingValidation) && !valid)} onClick={save} data-wb-template-save><Save />保存模板</Button></div></div>
    {pendingValidation && <p className="wb-muted" data-template-pending>此模板尚未验证，请先运行并验证后保存。</p>}
    <div className="wb-template-metadata"><label className="wb-name-input">模板名称<TextInput aria-label="模板名称" value={name} onChange={(e) => setName(e.target.value)} /></label><label className="wb-field-inline">存放位置<Select ariaLabel="存放位置" value={scope} disabled={!!initial?.id} onChange={(v) => { setScope(v as 'global' | 'project'); setCategoryId('uncategorized') }} options={[{ value: 'global', label: '全局模板库' }, ...(projectId || initial?.project_id ? [{ value: 'project', label: '项目模板库' }] : [])]} /></label><label className="wb-field-inline">分类<Select ariaLabel="模板分类" value={categoryId || 'uncategorized'} onChange={setCategoryId} options={[{ value: 'uncategorized', label: '未分类' }, ...categories.filter((c) => c.scope === scope && c.id !== 'uncategorized').map((c) => ({ value: c.id, label: c.name }))]} /></label><Button variant="secondary" disabled={jobs.busy} onClick={() => { setDimensionDraft(schema); setMetadataOpen(true) }}>数据要求</Button></div>
    <div className="wb-editor-bar"><div className="wb-toolbar"><Button active={codeOpen} data-wb-code-toggle onClick={() => setCodeOpen(!codeOpen)}><FileCodeCorner />Python 代码</Button><Button variant="secondary" disabled={jobs.busy} onClick={() => { if (assistant.host && onReturnAssistant) assistant.launch(onReturnAssistant); else { setAssistantStarted(true); setAssistantOpen(true) } }} data-wb-template-assistant><FileCodeCorner />Codex 助手</Button><Button disabled={!data} active={dataOpen} onClick={() => setDataOpen(!dataOpen)}>查看数据{data ? ` ${data.row_count} × ${data.column_count}` : ''}</Button></div>{jobs.busy ? <Button variant="secondary" onClick={jobs.cancel}>取消运行</Button> : <Button disabled={!data || !schema.code_filename || !code.trim()} title={!data || !schema.code_filename ? '请先上传代码与 Excel' : undefined} variant="secondary" data-wb-template-validate onClick={validate} data-wb-template-run><Play />运行并验证</Button>}</div>
    <TemplateFiles codeName={schema.code_filename} data={data} disabled={jobs.busy} onCode={(text, filename) => { setCode(text); setSchema((s) => ({ ...s, code_filename: filename })); if (!initial?.id) setName(filename.replace(/\.py$/i, '')); setRun(null); setDimensionsConfirmed(false) }} onExcel={(file) => { setImportFile(file); setImportOpen(true) }} onRemoveCode={() => { setCode(''); setSchema((s) => ({ ...s, code_filename: undefined })); setRun(null); setDimensionsConfirmed(false) }} onRemoveData={() => changeData(null)} />
    <div className="wb-editor-state-row"><span data-wb-template-state>{jobs.busy ? '正在运行' : valid && dirty ? '已运行 · 待保存' : dirty ? '有未运行修改' : pendingValidation ? '待运行验证' : '已保存'}</span><DraftStatus draft={draft} /></div>
    {(error || jobs.error) && <ErrorPanel error={error || jobs.error} traceback={jobs.job?.traceback} />}
    <div className={`wb-figure-workspace ${codeOpen ? 'has-code' : ''}`}>{codeOpen && <CodePane code={code} onChange={(value) => { setCode(value); setSchema((s) => ({ ...s, code_filename: s.code_filename ?? 'source.py' })); setDimensionsConfirmed(false) }} readOnly={jobs.busy} />}<FigurePreview outputs={outputs} selectedStem={selectedOutput?.stem ?? 'figure'} onSelect={setSelectedStem} stale={!!preview && contentChanged && !valid} unverified={pendingValidation && !valid} busy={jobs.busy} /></div>
    {dataOpen && data && <div className="wb-data-drawer"><DataTransform data={data} onChange={changeData} disabled={jobs.busy} /><DataTable data={data} /><Button onClick={() => void download('/data/workbook', 'data.xlsx', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) }).catch((e) => setError(errorText(e)))}><Download />导出本次绘图数据</Button></div>}
    {importOpen && <DataWizard initialFile={importFile} excelOnly onClose={() => setImportOpen(false)} onImport={(next) => { changeData(next); setDataOpen(true); setImportOpen(false) }} />}
    {metadataOpen && <DimensionsDialog schema={dimensionDraft ?? schema} data={data} onClose={() => setMetadataOpen(false)} onChange={confirmDimensions} />}
    {!assistant.host && assistantStarted && <CodeAssistant {...source} open={assistantOpen} onReopen={() => setAssistantOpen(true)} onClose={() => setAssistantOpen(false)} onDiscard={() => { setAssistantStarted(false); setAssistantOpen(false) }} />}
  </div>
}
async function renderTemplateComparison(code: string, data: Snapshot | null, schema: Schema): Promise<NonNullable<Job['result']>> {
  const { job_id } = await post<{ job_id: string }>('/templates/validate', { code, data, schema })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const job = await api<Job>(`/jobs/${job_id}`)
    if (job.status === 'success' && job.result) return job.result
    if (job.status !== 'running') throw new Error(job.error ?? '图形预览未完成。')
    await new Promise((resolve) => setTimeout(resolve, 650))
  }
  await post(`/jobs/${job_id}/cancel`).catch(() => undefined)
  throw new Error('图形预览超时。')
}
function CodePane({ code, onChange, readOnly }: { code: string; onChange: (code: string) => void; readOnly?: boolean }) {
  const lines = code.split('\n').length
  return <section className="wb-code-pane"><div className="wb-pane-heading"><span>Python</span><span>{readOnly ? '只读' : '可编辑'} · {lines} 行</span></div><textarea aria-label="Python 代码" spellCheck={false} value={code} readOnly={readOnly} data-wb-code onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => {
    if (e.key === 'Tab' && !readOnly) { e.preventDefault(); const el = e.currentTarget; const start = el.selectionStart; const end = el.selectionEnd; onChange(code.slice(0, start) + '    ' + code.slice(end)); requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = start + 4 }) }
  }} /><div className="wb-code-hint">绘图数据来自 Excel；模板代码可读取同级 data.xlsx 或使用 data 表格</div></section>
}
function FigurePreview({ outputs, selectedStem, onSelect, stale, busy, unverified = false }: { unverified?: boolean; outputs: FigureOutput[]; selectedStem: string; onSelect: (stem: string) => void; stale: boolean; busy: boolean }) {
  const previewId = useId()
  const selected = outputs.find((output) => output.stem === selectedStem) ?? outputs[0]
  const url = selected?.preview_url ?? ''
  const panelId = `${previewId}-${selected?.stem ?? 'empty'}`
  return <section className="wb-preview-pane" data-wb-preview><div className="wb-pane-heading"><span>图形预览{outputs.length > 1 ? ` · ${outputs.length} 张图` : ''}</span><span>{busy ? '正在运行…' : unverified ? '历史预览 · 待验证' : stale ? '旧预览 · 修改尚未运行' : url ? '已运行' : '等待首次运行'}</span></div>{outputs.length > 1 && <div className="wb-output-tabs"><TabList label="运行结果">{outputs.map((output, index) => <Tab key={output.stem} active={selected?.stem === output.stem} panelId={`${previewId}-${output.stem}`} onClick={() => onSelect(output.stem)} data-wb-output={output.stem}><img src={output.preview_url} alt="" /><span>{output.title || `图 ${index + 1}`}</span></Tab>)}</TabList></div>}<TabPanel id={panelId} className="wb-preview-surface" aria-label={outputs.length > 1 ? undefined : '图形预览'} aria-labelledby={outputs.length > 1 ? `${panelId}-tab` : undefined}>{url ? <img data-wb-preview-image src={url} alt={selected?.title || '绘图结果预览'} /> : <div className="wb-preview-empty"><h3>暂无预览</h3><p>运行代码后显示结果。</p></div>}{busy && <div className="wb-running">正在运行 Python…</div>}</TabPanel><div className="wb-editor-foot">{unverified ? '此预览来自历史存档，重新验证并保存后才能导出。' : stale ? '请重新运行并保存后再导出。' : 'PNG · 600 dpi / SVG / PDF'}</div></section>
}
export function TemplateChoice({ template, onClick }: { template: Template; onClick: () => void }) {
  return <Button className="wb-template-choice" onClick={onClick}><div className="wb-choice-preview">{template.preview_url ? <img src={template.preview_url} alt="" /> : <BookOpen />}</div><strong>{template.name}</strong><span className="wb-muted">{schemaSummary(template.schema)}</span></Button>
}
function ErrorPanel({ error, traceback }: { error: string; traceback?: string }) {
  const [expanded, setExpanded] = useState(false)
  return <div className="wb-error" role="alert"><div className="wb-toolbar"><strong>运行未完成</strong><span>{error}</span>{traceback && <Button onClick={() => setExpanded(!expanded)}>{expanded ? '收起详情' : '查看详情'}</Button>}</div>{expanded && <pre>{traceback}</pre>}</div>
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
