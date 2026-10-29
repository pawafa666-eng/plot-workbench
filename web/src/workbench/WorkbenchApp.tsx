import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, IconButton } from '@/components/ui/Button'
import { TextInput } from '@/components/ui/Input'
import { Dialog } from '@/components/ui/Dialog'
import { TooltipProvider } from '@/components/ui/Tooltip'
import { SettingsDialog } from '@/components/SettingsDialog'
import { ArrowUpRight, BookOpen, ChartLine, ChevronRight, Folder, FolderOpen, FolderPlus, LayoutGrid, Pencil, Plus, RefreshCw, Settings, Trash2 } from '@/components/ui/icons'
import { applyLocale } from '@/i18n'
import { isDesktop, onDesktopMenu, pickDirectory } from '@/lib/desktop'
import { runMenuAction } from '@/hooks/menuActions'
import { UPSTREAM_URL } from '@/lib/brand'
import { api, errorText, patch, post, remove, WORKBENCH_NAME, type Category, type Plot, type Project, type Status, type Template } from './api'
import { PlotEditor, TemplateEditor, type TemplateResume } from './Editors'
import { TemplateLibrary } from './TemplateLibrary'
import { AssistantHost, type AssistantSource } from './AssistantHost'
import { PaletteLibrary } from './PaletteLibrary'
import { PaletteEditor } from './PaletteEditor'
import type { Palette } from './paletteModel'
import type { TavottoSession } from './TavottoEditor'
import type { PanelOverride } from '@/types/document'
import './workbench.css'

type Route = { kind: 'palettes' } | { kind: 'palette'; palette?: Palette } | { kind: 'home' } | { kind: 'project'; id: string } | { kind: 'templates'; scope?: 'global' | 'project' } | { kind: 'plot'; plot: Plot; resume?: TavottoSession; resumePatches?: PanelOverride[] } | { kind: 'template'; template?: Template; scope?: 'global' | 'project'; resume?: TemplateResume } | { kind: 'trash' }
type NameDialog = { title: string; label: string; value: string; confirm: string; run: (value: string) => Promise<void> }
export function WorkbenchApp() {
  const [status, setStatus] = useState<Status | null>(null)
  const [route, setRouteState] = useState<Route>({ kind: 'home' })
  const navigationRevision = useRef(0)
  const interactionRevision = useRef(0)
  const navigationGuard = useRef<(() => boolean) | null>(null)
  const setNavigationGuard = useCallback((guard: (() => boolean) | null) => { navigationGuard.current = guard }, [])
  function canLeaveEditor() {
    if (!navigationGuard.current || navigationGuard.current()) return true
    window.alert('图内修改正在同步，请稍等片刻再切换页面。')
    return false
  }
  function setRoute(next: Route) { navigationRevision.current++; setRouteState(next) }
  const [project, setProject] = useState<Project | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [error, setError] = useState('')
  const [rootDialog, setRootDialog] = useState(false)
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ title: string; text: string; run: () => Promise<void> } | null>(null)
  const [pathDialog, setPathDialog] = useState(false)
  const [projectDialog, setProjectDialog] = useState(false)
  const [draftDirty, setDraftDirty] = useState(false)
  const dirtyRef = useRef(false)
  dirtyRef.current = draftDirty
  const [trash, setTrash] = useState<{ id: string; name?: string; kind?: string; deleted_at?: string }[]>([])
  const switchSeq = useRef(0)
  const loaded = useRef(false)
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void onDesktopMenu((action) => {
      if (action === 'menu-settings' || action === 'menu-check-updates' || action === 'menu-diagnostics') runMenuAction(action)
    }).then((stop) => { if (disposed) stop(); else unlisten = stop })
    return () => { disposed = true; unlisten?.() }
  }, [])
  async function refreshStatus() { const next = await api<Status>('/status'); setStatus(next); return next }
  async function refreshTemplates(projectId: string | null = project?.id ?? null) {
    const result = await api<{ templates: Template[]; categories: Category[] }>(`/templates${projectId ? `?project_id=${projectId}` : ''}`)
    setTemplates(result.templates); setCategories(result.categories)
  }
  async function refreshProject(id = project?.id) {
    if (!id) return
    const result = await api<Project>(`/projects/${id}`); setProject(result)
  }
  async function perform(action: () => Promise<unknown>) { setError(''); try { await action() } catch (err) { setError(errorText(err)) } }
  useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    void applyLocale('zh-CN')
    document.title = WORKBENCH_NAME
    void perform(async () => {
      const [next] = await Promise.all([refreshStatus(), refreshTemplates()])
      if (localStorage.getItem('workbench.selectedRoot') !== next.root) setRootDialog(true)
    })
  }, [])
  async function openProject(id: string) {
    const seq = ++switchSeq.current
    setError('')
    try {
      const [next, library] = await Promise.all([api<Project>(`/projects/${id}`), api<{ templates: Template[]; categories: Category[] }>(`/templates?project_id=${id}`)])
      if (seq !== switchSeq.current) return
      setProject(next); setTemplates(library.templates); setCategories(library.categories); setRoute({ kind: 'project', id })
    } catch (e) { if (seq === switchSeq.current) setError(errorText(e)) }
  }
  function createProject() { setProjectDialog(true) }
  function createPlot() {
    if (!project) return
    const id = project.id
    setNameDialog({ title: '新建图', label: '图名称', value: '', confirm: '创建图', run: async (name) => { const next = await post<Plot>(`/projects/${id}/plots`, { name }); await refreshProject(id); setRoute({ kind: 'plot', plot: next }) } })
  }
  async function showTrash() { await perform(async () => { const result = await api<{ items: typeof trash }>('/trash'); setTrash(result.items); setRoute({ kind: 'trash' }) }) }
  async function returnToFigure(plot: Plot, source: AssistantSource) {
    if (!source.sessionId) return
    if (!canLeaveEditor()) return
    if (dirtyRef.current && !window.confirm('当前编辑尚未保存，返回原图将离开当前编辑。确定继续吗？')) return
    const navigation = navigationRevision.current, interaction = interactionRevision.current, wasDirty = dirtyRef.current
    await perform(async () => {
      const [freshPlot, nextProject, library, resume] = await Promise.all([
        api<Plot>(`/plots/${plot.id}`), api<Project>(`/projects/${plot.project_id}`),
        api<{ templates: Template[]; categories: Category[] }>(`/templates?project_id=${plot.project_id}`),
        post<TavottoSession>(`/sessions/${source.sessionId}/resume`, { patches: source.patches ?? [] }),
      ])
      if (navigationRevision.current !== navigation || interactionRevision.current !== interaction || dirtyRef.current !== wasDirty) throw new Error('当前页面在返回期间发生变化，请再次选择返回原图。')
      setProject(nextProject); setTemplates(library.templates); setCategories(library.categories)
      setRoute({ kind: 'plot', plot: freshPlot, resume, resumePatches: source.patches })
    })
  }
  async function returnToTemplate(template: Template | undefined, scope: 'global' | 'project' | undefined, source: AssistantSource) {
    if (!source.templateDraft || source.code === undefined) return
    if (!canLeaveEditor()) return
    if (dirtyRef.current && !window.confirm('当前编辑尚未保存，返回模板将离开当前编辑。确定继续吗？')) return
    const navigation = navigationRevision.current, interaction = interactionRevision.current, wasDirty = dirtyRef.current
    await perform(async () => {
      if (template) {
        const fresh = await api<Template>(`/templates/${template.id}`)
        if (fresh.revision !== template.revision) throw new Error('模板已经变化，请重新打开模板后生成修改。')
      }
      const projectId = source.templateDraft!.projectId
      if (projectId) {
        const [next, library] = await Promise.all([api<Project>(`/projects/${projectId}`), api<{ templates: Template[]; categories: Category[] }>(`/templates?project_id=${projectId}`)])
        if (navigationRevision.current !== navigation || interactionRevision.current !== interaction || dirtyRef.current !== wasDirty) throw new Error('当前页面在返回期间发生变化，请再次选择返回模板。')
        setProject(next); setTemplates(library.templates); setCategories(library.categories)
      }
      if (navigationRevision.current !== navigation || interactionRevision.current !== interaction || dirtyRef.current !== wasDirty) throw new Error('当前页面在返回期间发生变化，请再次选择返回模板。')
      setRoute({ kind: 'template', template, scope, resume: { ...source.templateDraft!, code: source.code!, data: source.data, schema: source.schema } })
    })
  }
  const showProjectNav = !!project && route.kind !== 'home'
  const libraryMode = route.kind === 'templates' || route.kind === 'template'
  const activeProject = route.kind === 'project' || route.kind === 'plot'
  const projectCards = status?.projects ?? []
  return <TooltipProvider><AssistantHost key={status?.root ?? 'loading'}><div className="wb-app" data-workbench-app onPointerDownCapture={() => { interactionRevision.current++ }} onKeyDownCapture={() => { interactionRevision.current++ }} onInputCapture={() => { interactionRevision.current++ }}>
    <header className="wb-topbar"><div className="wb-brand"><span className="wb-brand-symbol" aria-hidden><i /><i /><i /></span><span>{WORKBENCH_NAME}</span></div><div className="wb-topbar-breadcrumb"><span>项目</span>{showProjectNav && <><ChevronRight /><span>{project?.name}</span></>}{libraryMode && <><ChevronRight /><span>模板库</span></>}</div><div className="wb-topbar-right"><span className="wb-local-dot" />本地运行<IconButton label="设置" tip={false} data-wb-settings onClick={() => runMenuAction('menu-check-updates')}><Settings /></IconButton><IconButton label="更换模板库目录" tip={false} onClick={() => { if (canLeaveEditor() && (!draftDirty || window.confirm('当前编辑尚未保存，更换模板库目录将丢弃修改。'))) setRootDialog(true) }}><FolderOpen /></IconButton></div></header>
    <div className="wb-app-body"><aside className="wb-main-sidebar" onClickCapture={(event) => { if ((event.target as HTMLElement).closest('button') && (!canLeaveEditor() || (draftDirty && !window.confirm('当前编辑尚未保存，离开后将丢弃修改。')))) { event.preventDefault(); event.stopPropagation() } }}><div className="wb-nav-group"><Button active={route.kind === 'home'} onClick={() => setRoute({ kind: 'home' })} data-wb-nav-home><LayoutGrid />项目首页</Button><Button active={libraryMode} onClick={() => { void perform(async () => { await refreshTemplates(); setRoute({ kind: 'templates' }) }) }} data-wb-nav-templates><BookOpen />模板库</Button><Button active={route.kind === 'palettes' || route.kind === 'palette'} onClick={() => setRoute({ kind: 'palettes' })} data-wb-nav-palettes><span aria-hidden="true">◉</span>配色表</Button></div><div className="wb-sidebar-label"><span>我的项目</span><IconButton label="新建项目" tip={false} onClick={createProject}><Plus /></IconButton></div><nav className="wb-project-nav">{projectCards.map((item) => <Button key={item.id} active={activeProject && project?.id === item.id} onClick={() => openProject(item.id)} data-wb-project-nav={item.id}><Folder /><span>{item.name}</span></Button>)}</nav><div className="wb-sidebar-bottom"><Button active={route.kind === 'trash'} onClick={showTrash}><Trash2 />回收站</Button><button className="wb-root-path" onClick={() => setRootDialog(true)} title={status?.root} data-wb-root-path><FolderOpen /><span>{status?.root ?? '选择模板库目录'}</span></button><div className="wb-attribution">基于 <a href={UPSTREAM_URL} target="_blank" rel="noreferrer">Tavotto v0.18.0</a><br />AGPL-3.0-only</div></div></aside>
      <main className={`wb-main-content ${route.kind === 'plot' || route.kind === 'template' ? 'is-editor' : ''}`}>
        {error && <div className="wb-global-error" data-wb-global-error role="alert"><span>{error}</span><Button onClick={() => setError('')}>关闭</Button></div>}
        {!status && <div className="wb-loading"><RefreshCw /><p>正在读取项目列表…</p>{error && <Button variant="secondary" onClick={() => perform(async () => { await refreshStatus(); await refreshTemplates() })}>重试连接</Button>}</div>}
        {status && route.kind === 'home' && <><div className="wb-page-heading"><div><h1>项目</h1><p>选择文件夹创建项目，或打开项目文件夹。</p></div><div className="wb-toolbar"><Button variant="secondary" onClick={() => setPathDialog(true)}><FolderOpen />打开项目文件夹</Button><Button variant="primary" onClick={createProject} data-wb-project-create><Plus />新建项目</Button></div></div><div className="wb-home-summary"><div><span className="wb-summary-number">{String(projectCards.length).padStart(2, '0')}</span><span>绘图项目</span></div><div><span className="wb-summary-number">{String(templates.filter((t) => t.scope === 'global').length).padStart(2, '0')}</span><span>全局模板</span></div></div><div className="wb-section-heading wb-project-list-heading"><h2>项目</h2><span className="wb-muted">保存在各项目文件夹</span></div><div className="wb-project-grid">{projectCards.map((item, i) => <article className="wb-project-card" key={item.id} data-wb-project-card={item.id}><div className="wb-project-card-top"><span className="wb-project-number">{String(i + 1).padStart(2, '0')}</span><Folder /></div><Button className="wb-project-card-title" onClick={() => openProject(item.id)}><h3>{item.name}</h3><ArrowUpRight /></Button><p>{item.plot_count ?? (Array.isArray(item.plots) ? item.plots.length : 0)} 张图 · 本地项目</p><div className="wb-project-card-bottom"><span title={item.path}>{item.path}</span><Button onClick={() => openProject(item.id)}>打开<ChevronRight /></Button></div></article>)}<Button className="wb-new-project-card" onClick={createProject}><FolderPlus /><strong>新建绘图项目</strong><span>选择已有文件夹</span></Button></div></>}
        {status && route.kind === 'project' && project && <><div className="wb-page-heading"><div><h1>{project.name}<IconButton label="重命名项目" tip={false} onClick={() => setNameDialog({ title: '重命名项目', label: '项目名称', value: project.name, confirm: '保存名称', run: async (name) => { await patch(`/projects/${project.id}`, { name }); await refreshProject(); await refreshStatus() } })}><Pencil /></IconButton></h1><p className="wb-mono-path">{project.path}</p></div><div className="wb-toolbar"><Button variant="secondary" onClick={() => setRoute({ kind: 'templates', scope: 'project' })}><BookOpen />项目模板</Button><Button variant="primary" onClick={createPlot} data-wb-plot-create><Plus />新建图</Button></div></div><div className="wb-project-overview"><span><strong>{project.plots?.length ?? 0}</strong> 张图</span><span>项目中的图与模板独立保存</span><Button variant="danger" onClick={() => setConfirmDelete({ title: '将项目移入回收站？', text: `「${project.name}」及其中的图将移入回收站，可稍后恢复。`, run: async () => { await remove(`/projects/${project.id}`); setProject(null); setRoute({ kind: 'home' }); await refreshStatus(); await refreshTemplates(null) } })}><Trash2 />删除项目</Button></div><div className="wb-plot-grid">{(project.plots ?? []).map((plot) => <article className="wb-plot-card" key={plot.id} data-wb-plot-card={plot.id}><Button className="wb-plot-thumb" onClick={() => perform(async () => setRoute({ kind: 'plot', plot: await api<Plot>(`/plots/${plot.id}`) }))}>{plot.preview_url ? <img src={plot.preview_url} alt={plot.name} /> : <div className="wb-card-empty"><ChartLine /><span>等待首次运行</span></div>}</Button><div className="wb-plot-card-info"><h3>{plot.name}</h3><span className="wb-plot-state">{plot.state === 'TAVOTTO_ONLY' ? 'Tavotto 继续编辑' : '代码可编辑'}</span><div className="wb-card-footer"><Button variant="secondary" onClick={() => perform(async () => setRoute({ kind: 'plot', plot: await api<Plot>(`/plots/${plot.id}`) }))}>打开图<ChevronRight /></Button><div className="wb-toolbar"><IconButton label={`重命名 ${plot.name}`} tip={false} onClick={() => setNameDialog({ title: '重命名图', label: '图名称', value: plot.name, confirm: '保存名称', run: async (name) => { await patch(`/plots/${plot.id}`, { name }); await refreshProject() } })}><Pencil /></IconButton><IconButton label={`删除 ${plot.name}`} tip={false} onClick={() => setConfirmDelete({ title: '将图移入回收站？', text: `「${plot.name}」可以从回收站恢复。`, run: async () => { await remove(`/plots/${plot.id}`); await refreshProject() } })}><Trash2 /></IconButton></div></div></div></article>)}<Button className="wb-new-project-card wb-new-plot-card" onClick={createPlot}><Plus /><strong>新建图</strong><span>从模板或 Python 代码开始</span></Button></div></>}
        {status && route.kind === 'palettes' && <PaletteLibrary onEdit={(palette) => setRoute({ kind: 'palette', palette })} />}
        {status && route.kind === 'palette' && <PaletteEditor key={route.palette?.id ?? 'new'} initial={route.palette} onDirtyChange={setDraftDirty} onBack={() => setRoute({ kind: 'palettes' })} onSaved={() => setRoute({ kind: 'palettes' })} />}
        {status && route.kind === 'templates' && <TemplateLibrary key={route.scope ?? 'global'} defaultScope={route.scope} templates={templates} categories={categories} projectId={project?.id} projectName={project?.name} onRefresh={() => refreshTemplates()} onEdit={(template, scope) => setRoute({ kind: 'template', template, scope })} />}
        {status && route.kind === 'template' && <TemplateEditor onDirtyChange={setDraftDirty} key={`${route.template?.id || 'new'}:${route.resume ? 'resumed' : 'new'}`} initial={route.template} resume={route.resume} onReturnAssistant={(source) => returnToTemplate(route.template, route.scope, source)} defaultScope={route.scope} projectId={project?.id} categories={categories} onBack={() => setRoute({ kind: 'templates', scope: route.scope ?? route.template?.scope })} onSaved={() => { void perform(async () => { await refreshTemplates(); setRoute({ kind: 'templates' }) }) }} />}
        {status && route.kind === 'plot' && <PlotEditor onDirtyChange={setDraftDirty} onNavigationGuard={setNavigationGuard} key={`${route.plot.id}:${route.resume?.session_id ?? 'new'}`} initial={route.plot} resumeSession={route.resume} resumePatches={route.resumePatches} onReturnAssistant={(source) => returnToFigure(route.plot, source)} templates={templates} onBack={() => { if (project) void openProject(project.id); else setRoute({ kind: 'home' }) }} onChanged={() => { void refreshProject(); void refreshStatus() }} />}
        {status && route.kind === 'trash' && <><div className="wb-page-heading"><div><h1>回收站</h1><p>恢复已删除的项目、图和模板。</p></div><Button variant="secondary" onClick={showTrash}><RefreshCw />刷新</Button></div><div className="wb-trash-list">{trash.map((item) => <div key={item.id}><Trash2 /><strong>{item.name ?? item.id}</strong><span className="wb-muted">{item.kind === 'project' ? '项目' : item.kind === 'plot' ? '图' : '模板'}</span><span className="wb-muted">{item.deleted_at ?? ''}</span><Button variant="secondary" onClick={() => perform(async () => { await post(`/trash/${item.id}/restore`); await refreshStatus(); await refreshTemplates(); await showTrash() })}>恢复</Button></div>)}</div>{trash.length === 0 && <div className="wb-empty-state"><Trash2 /><h2>回收站是空的</h2><p>已删除的内容可在此恢复。</p></div>}</>}
      </main></div>
    {rootDialog && <RootDialog current={status?.root ?? ''} onClose={() => setRootDialog(false)} onSave={async (path) => { await perform(async () => { const next = await post<Status>('/root', { path }); localStorage.setItem('workbench.selectedRoot', next.root); setStatus(next); setProject(null); setRoute({ kind: 'home' }); await refreshTemplates(null); setRootDialog(false) }) }} />}
    {projectDialog && <ProjectDialog onClose={() => setProjectDialog(false)} onSave={async (path, name) => { await perform(async () => { const next = await post<Project>('/projects', { path, name }); await refreshStatus(); await openProject(next.id); setProjectDialog(false) }) }} />}
    {pathDialog && <PathDialog title="打开项目文件夹" description="选择已有项目所在的文件夹。" onClose={() => setPathDialog(false)} onSave={async (path) => { await perform(async () => { const next = await post<Project>('/projects/open', { path }); await refreshStatus(); await openProject(next.id); setPathDialog(false) }) }} />}
    {nameDialog && <Dialog open title={nameDialog.title} onOpenChange={(v) => { if (!v) setNameDialog(null) }} footer={<Button variant="primary" disabled={!nameDialog.value.trim()} onClick={() => perform(async () => { await nameDialog.run(nameDialog.value); setNameDialog(null) })} data-wb-name-confirm>{nameDialog.confirm}</Button>}><label className="wb-field">{nameDialog.label}<TextInput autoFocus value={nameDialog.value} onChange={(e) => setNameDialog({ ...nameDialog, value: e.target.value })} data-wb-name-input /></label></Dialog>}
    {confirmDelete && <Dialog open title={confirmDelete.title} description={confirmDelete.text} onOpenChange={(v) => { if (!v) setConfirmDelete(null) }} footer={<><Button onClick={() => setConfirmDelete(null)}>取消</Button><Button variant="danger" onClick={() => perform(async () => { await confirmDelete.run(); setConfirmDelete(null) })}>移入回收站</Button></>}>{null}</Dialog>}
    <SettingsDialog />
  </div></AssistantHost></TooltipProvider>
}
function RootDialog({ current, onClose, onSave }: { current: string; onClose: () => void; onSave: (path: string) => Promise<void> }) {
  return <PathDialog title="选择模板库目录" description="全局模板与回收站保存在此目录；项目使用各自的文件夹。" current={current} onClose={onClose} onSave={onSave} root />
}
function ProjectDialog({ onClose, onSave }: { onClose: () => void; onSave: (path: string, name: string) => Promise<void> }) {
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  return <Dialog open title="新建项目" description="选择已有文件夹作为项目目录，数据与代码可继续保留在原位置。" anchor="workbench-create-project" onOpenChange={(open) => { if (!open) onClose() }} footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!path.trim()} onClick={() => onSave(path.trim(), name.trim())} data-wb-project-confirm>创建项目</Button></>}><div className="wb-export-form"><label className="wb-field">项目文件夹<div className="wb-path-row"><TextInput aria-label="项目文件夹" value={path} placeholder="选择已有文件夹或输入完整路径" onChange={(e) => setPath(e.target.value)} data-wb-project-path />{isDesktop() && <Button variant="secondary" onClick={async () => { try { const selected = await pickDirectory('选择项目文件夹'); if (selected) { setPath(selected); setError('') } } catch (e) { setError(errorText(e)) } }} data-wb-project-browse>选择文件夹…</Button>}</div></label><label className="wb-field">项目名称（可选）<TextInput aria-label="项目名称（可选）" value={name} placeholder="留空使用文件夹名称" onChange={(e) => setName(e.target.value)} data-wb-project-name /></label><p className="wb-help">项目文件保存在所选文件夹的 .plot-workbench 子目录。</p>{error && <p className="wb-error" role="alert">{error}</p>}</div></Dialog>
}
function PathDialog({ title, description, current = '', onClose, onSave, root }: { title: string; description: string; current?: string; onClose: () => void; onSave: (path: string) => Promise<void>; root?: boolean }) {
  const [path, setPath] = useState(current)
  const [error, setError] = useState('')
  return <Dialog open title={title} description={description} width={640} anchor={root ? 'workbench-root' : 'workbench-open-project'} onOpenChange={(v) => { if (!v) onClose() }} footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!path.trim()} onClick={() => onSave(path.trim())} data-wb-path-confirm>{root ? '使用此目录' : '打开项目'}</Button></>}><label className="wb-field">{root ? '模板库目录' : '项目文件夹'}<div className="wb-path-row"><TextInput aria-label="目录路径" value={path} placeholder="输入完整目录路径" onChange={(e) => setPath(e.target.value)} data-wb-path-input />{isDesktop() && <Button variant="secondary" onClick={async () => { try { const next = await pickDirectory(title); if (next) { setPath(next); setError('') } } catch (e) { setError(errorText(e)) } }}>选择文件夹…</Button>}</div></label>{!isDesktop() && <p className="wb-help">请输入本机服务可以访问的完整目录路径。</p>}{error && <p className="wb-error" role="alert">{error}</p>}</Dialog>
}
