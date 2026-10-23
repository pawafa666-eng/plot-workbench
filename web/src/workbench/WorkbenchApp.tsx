import { useEffect, useRef, useState } from 'react'
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
import { PlotEditor, TemplateEditor } from './Editors'
import { TemplateLibrary } from './TemplateLibrary'
import './workbench.css'

type Route = { kind: 'home' } | { kind: 'project'; id: string } | { kind: 'templates'; scope?: 'global' | 'project' } | { kind: 'plot'; plot: Plot } | { kind: 'template'; template?: Template; scope?: 'global' | 'project' } | { kind: 'trash' }
type NameDialog = { title: string; label: string; value: string; confirm: string; run: (value: string) => Promise<void> }
export function WorkbenchApp() {
  const [status, setStatus] = useState<Status | null>(null)
  const [route, setRoute] = useState<Route>({ kind: 'home' })
  const [project, setProject] = useState<Project | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [error, setError] = useState('')
  const [rootDialog, setRootDialog] = useState(false)
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ title: string; text: string; run: () => Promise<void> } | null>(null)
  const [pathDialog, setPathDialog] = useState(false)
  const [draftDirty, setDraftDirty] = useState(false)
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
  function createProject() { setNameDialog({ title: '新建绘图项目', label: '项目名称', value: '', confirm: '创建项目', run: async (name) => { const next = await post<Project>('/projects', { name }); await refreshStatus(); await openProject(next.id) } }) }
  function createPlot() {
    if (!project) return
    const id = project.id
    setNameDialog({ title: '新建图', label: '图名称', value: '', confirm: '创建图', run: async (name) => { const next = await post<Plot>(`/projects/${id}/plots`, { name }); await refreshProject(id); setRoute({ kind: 'plot', plot: next }) } })
  }
  async function showTrash() { await perform(async () => { const result = await api<{ items: typeof trash }>('/trash'); setTrash(result.items); setRoute({ kind: 'trash' }) }) }
  const showProjectNav = !!project && route.kind !== 'home'
  const libraryMode = route.kind === 'templates' || route.kind === 'template'
  const activeProject = route.kind === 'project' || route.kind === 'plot'
  const projectCards = status?.projects ?? []
  return <TooltipProvider><div className="wb-app" data-workbench-app>
    <header className="wb-topbar"><div className="wb-brand"><span className="wb-brand-symbol" aria-hidden><i /><i /><i /></span><span>{WORKBENCH_NAME}</span><span className="wb-version">研究绘图工作台</span></div><div className="wb-topbar-breadcrumb"><span>工作空间</span>{showProjectNav && <><ChevronRight /><span>{project?.name}</span></>}{libraryMode && <><ChevronRight /><span>模板库</span></>}</div><div className="wb-topbar-right"><span className="wb-local-dot" />本地运行<IconButton label="设置" tip={false} data-wb-settings onClick={() => runMenuAction('menu-check-updates')}><Settings /></IconButton><IconButton label="更换工作空间" tip={false} onClick={() => { if (!draftDirty || window.confirm('当前编辑尚未保存，切换工作空间将丢弃修改。')) setRootDialog(true) }}><FolderOpen /></IconButton></div></header>
    <div className="wb-app-body"><aside className="wb-main-sidebar" onClickCapture={(event) => { if (draftDirty && (event.target as HTMLElement).closest('button') && !window.confirm('当前编辑尚未保存，离开后将丢弃修改。')) { event.preventDefault(); event.stopPropagation() } }}><div className="wb-nav-group"><Button active={route.kind === 'home'} onClick={() => setRoute({ kind: 'home' })} data-wb-nav-home><LayoutGrid />项目首页</Button><Button active={libraryMode} onClick={() => { void perform(async () => { await refreshTemplates(); setRoute({ kind: 'templates' }) }) }} data-wb-nav-templates><BookOpen />模板库</Button></div><div className="wb-sidebar-label"><span>我的项目</span><IconButton label="新建项目" tip={false} onClick={createProject}><Plus /></IconButton></div><nav className="wb-project-nav">{projectCards.map((item) => <Button key={item.id} active={activeProject && project?.id === item.id} onClick={() => openProject(item.id)} data-wb-project-nav={item.id}><Folder /><span>{item.name}</span></Button>)}</nav><div className="wb-sidebar-bottom"><Button active={route.kind === 'trash'} onClick={showTrash}><Trash2 />回收站</Button><button className="wb-root-path" onClick={() => setRootDialog(true)} title={status?.root} data-wb-root-path><FolderOpen /><span>{status?.root ?? '选择工作目录'}</span></button><div className="wb-attribution">基于 <a href={UPSTREAM_URL} target="_blank" rel="noreferrer">Tavotto v0.18.0</a><br />AGPL-3.0-only</div></div></aside>
      <main className={`wb-main-content ${route.kind === 'plot' || route.kind === 'template' ? 'is-editor' : ''}`}>
        {error && <div className="wb-global-error" role="alert"><span>{error}</span><Button onClick={() => setError('')}>关闭</Button></div>}
        {!status && <div className="wb-loading"><RefreshCw /><p>正在打开本地工作空间…</p>{error && <Button variant="secondary" onClick={() => perform(async () => { await refreshStatus(); await refreshTemplates() })}>重试连接</Button>}</div>}
        {status && route.kind === 'home' && <><div className="wb-page-heading"><div><div className="wb-eyebrow">YOUR RESEARCH, IN FIGURES</div><h1>每一张图，<span className="wb-heading-serif">都有来处。</span></h1><p>把数据、绘图方法与最终图形，放在同一个项目里。</p></div><div className="wb-toolbar"><Button variant="secondary" onClick={() => setPathDialog(true)}><FolderOpen />打开已有项目</Button><Button variant="primary" onClick={createProject} data-wb-project-create><Plus />新建项目</Button></div></div><div className="wb-home-summary"><div><span className="wb-summary-number">{String(projectCards.length).padStart(2, '0')}</span><span>绘图项目</span></div><div><span className="wb-summary-number">{String(templates.filter((t) => t.scope === 'global').length).padStart(2, '0')}</span><span>全局模板</span></div><p>从数据到方法，从代码到细节。<br /><span>让研究中的图，清晰、可复用、可追溯。</span></p></div><div className="wb-section-heading wb-project-list-heading"><h2>项目</h2><span className="wb-muted">保存在本地工作空间</span></div><div className="wb-project-grid">{projectCards.map((item, i) => <article className="wb-project-card" key={item.id} data-wb-project-card={item.id}><div className="wb-project-card-top"><span className="wb-project-number">{String(i + 1).padStart(2, '0')}</span><Folder /></div><Button className="wb-project-card-title" onClick={() => openProject(item.id)}><h3>{item.name}</h3><ArrowUpRight /></Button><p>{item.plot_count ?? (Array.isArray(item.plots) ? item.plots.length : 0)} 张图 · 本地项目</p><div className="wb-project-card-bottom"><span title={item.path}>{item.path}</span><Button onClick={() => openProject(item.id)}>打开<ChevronRight /></Button></div></article>)}<Button className="wb-new-project-card" onClick={createProject}><FolderPlus /><strong>新建绘图项目</strong><span>为下一项研究留一张纸</span></Button></div><div className="wb-home-foot"><span>01 导入数据</span><ChevronRight /><span>02 运行绘图</span><ChevronRight /><span>03 Tavotto 精修</span><ChevronRight /><span>04 导出成果</span></div></>}
        {status && route.kind === 'project' && project && <><div className="wb-page-heading"><div><div className="wb-eyebrow">RESEARCH PROJECT</div><h1>{project.name}<IconButton label="重命名项目" tip={false} onClick={() => setNameDialog({ title: '重命名项目', label: '项目名称', value: project.name, confirm: '保存名称', run: async (name) => { await patch(`/projects/${project.id}`, { name }); await refreshProject(); await refreshStatus() } })}><Pencil /></IconButton></h1><p className="wb-mono-path">{project.path}</p></div><div className="wb-toolbar"><Button variant="secondary" onClick={() => setRoute({ kind: 'templates', scope: 'project' })}><BookOpen />项目模板</Button><Button variant="primary" onClick={createPlot} data-wb-plot-create><Plus />新建图</Button></div></div><div className="wb-project-overview"><span><strong>{project.plots?.length ?? 0}</strong> 张图</span><span>项目中的图与模板独立保存</span><Button variant="danger" onClick={() => setConfirmDelete({ title: '将项目移入回收站？', text: `「${project.name}」及其中的图将移入回收站，可稍后恢复。`, run: async () => { await remove(`/projects/${project.id}`); setProject(null); setRoute({ kind: 'home' }); await refreshStatus(); await refreshTemplates(null) } })}><Trash2 />删除项目</Button></div><div className="wb-plot-grid">{(project.plots ?? []).map((plot) => <article className="wb-plot-card" key={plot.id} data-wb-plot-card={plot.id}><Button className="wb-plot-thumb" onClick={() => perform(async () => setRoute({ kind: 'plot', plot: await api<Plot>(`/plots/${plot.id}`) }))}>{plot.preview_url ? <img src={plot.preview_url} alt={plot.name} /> : <div className="wb-card-empty"><ChartLine /><span>等待首次运行</span></div>}</Button><div className="wb-plot-card-info"><h3>{plot.name}</h3><span className="wb-plot-state">{plot.state === 'TAVOTTO_ONLY' ? 'Tavotto 继续编辑' : '代码可编辑'}</span><div className="wb-card-footer"><Button variant="secondary" onClick={() => perform(async () => setRoute({ kind: 'plot', plot: await api<Plot>(`/plots/${plot.id}`) }))}>打开图<ChevronRight /></Button><div className="wb-toolbar"><IconButton label={`重命名 ${plot.name}`} tip={false} onClick={() => setNameDialog({ title: '重命名图', label: '图名称', value: plot.name, confirm: '保存名称', run: async (name) => { await patch(`/plots/${plot.id}`, { name }); await refreshProject() } })}><Pencil /></IconButton><IconButton label={`删除 ${plot.name}`} tip={false} onClick={() => setConfirmDelete({ title: '将图移入回收站？', text: `「${plot.name}」可以从回收站恢复。`, run: async () => { await remove(`/plots/${plot.id}`); await refreshProject() } })}><Trash2 /></IconButton></div></div></div></article>)}<Button className="wb-new-project-card wb-new-plot-card" onClick={createPlot}><Plus /><strong>新建图</strong><span>从模板或 Python 代码开始</span></Button></div></>}
        {status && route.kind === 'templates' && <TemplateLibrary key={route.scope ?? 'global'} defaultScope={route.scope} templates={templates} categories={categories} projectId={project?.id} projectName={project?.name} onRefresh={() => refreshTemplates()} onEdit={(template, scope) => setRoute({ kind: 'template', template, scope })} />}
        {status && route.kind === 'template' && <TemplateEditor onDirtyChange={setDraftDirty} key={route.template?.id || 'new'} initial={route.template} defaultScope={route.scope} projectId={project?.id} categories={categories} onBack={() => setRoute({ kind: 'templates', scope: route.scope ?? route.template?.scope })} onSaved={() => { void perform(async () => { await refreshTemplates(); setRoute({ kind: 'templates' }) }) }} />}
        {status && route.kind === 'plot' && <PlotEditor onDirtyChange={setDraftDirty} key={route.plot.id} initial={route.plot} templates={templates} onBack={() => { if (project) void openProject(project.id); else setRoute({ kind: 'home' }) }} onChanged={() => { void refreshProject(); void refreshStatus() }} />}
        {status && route.kind === 'trash' && <><div className="wb-page-heading"><div><div className="wb-eyebrow">RECOVERY</div><h1>回收站</h1><p>误删的项目、图与模板，可以从这里找回来。</p></div><Button variant="secondary" onClick={showTrash}><RefreshCw />刷新</Button></div><div className="wb-trash-list">{trash.map((item) => <div key={item.id}><Trash2 /><strong>{item.name ?? item.id}</strong><span className="wb-muted">{item.kind === 'project' ? '项目' : item.kind === 'plot' ? '图' : '模板'}</span><span className="wb-muted">{item.deleted_at ?? ''}</span><Button variant="secondary" onClick={() => perform(async () => { await post(`/trash/${item.id}/restore`); await refreshStatus(); await refreshTemplates(); await showTrash() })}>恢复</Button></div>)}</div>{trash.length === 0 && <div className="wb-empty-state"><Trash2 /><h2>回收站是空的</h2><p>删除的内容会在这里等待恢复。</p></div>}</>}
      </main></div>
    {rootDialog && <RootDialog current={status?.root ?? ''} onClose={() => setRootDialog(false)} onSave={async (path) => { await perform(async () => { const next = await post<Status>('/root', { path }); localStorage.setItem('workbench.selectedRoot', next.root); setStatus(next); setProject(null); setRoute({ kind: 'home' }); await refreshTemplates(null); setRootDialog(false) }) }} />}
    {pathDialog && <PathDialog title="打开已有项目" description="选择包含 Plot Workbench 项目的目录。" onClose={() => setPathDialog(false)} onSave={async (path) => { await perform(async () => { const next = await post<Project>('/projects/open', { path }); await refreshStatus(); await openProject(next.id); setPathDialog(false) }) }} />}
    {nameDialog && <Dialog open title={nameDialog.title} onOpenChange={(v) => { if (!v) setNameDialog(null) }} footer={<Button variant="primary" disabled={!nameDialog.value.trim()} onClick={() => perform(async () => { await nameDialog.run(nameDialog.value); setNameDialog(null) })} data-wb-name-confirm>{nameDialog.confirm}</Button>}><label className="wb-field">{nameDialog.label}<TextInput autoFocus value={nameDialog.value} onChange={(e) => setNameDialog({ ...nameDialog, value: e.target.value })} data-wb-name-input /></label></Dialog>}
    {confirmDelete && <Dialog open title={confirmDelete.title} description={confirmDelete.text} onOpenChange={(v) => { if (!v) setConfirmDelete(null) }} footer={<><Button onClick={() => setConfirmDelete(null)}>取消</Button><Button variant="danger" onClick={() => perform(async () => { await confirmDelete.run(); setConfirmDelete(null) })}>移入回收站</Button></>}>{null}</Dialog>}
    <SettingsDialog />
  </div></TooltipProvider>
}
function RootDialog({ current, onClose, onSave }: { current: string; onClose: () => void; onSave: (path: string) => Promise<void> }) {
  return <PathDialog title="选择你的工作空间" description="所有项目、模板和图都保存在此目录。选择一个便于备份的位置。" current={current} onClose={onClose} onSave={onSave} root />
}
function PathDialog({ title, description, current = '', onClose, onSave, root }: { title: string; description: string; current?: string; onClose: () => void; onSave: (path: string) => Promise<void>; root?: boolean }) {
  const [path, setPath] = useState(current)
  return <Dialog open title={title} description={description} width={640} anchor={root ? 'workbench-root' : 'workbench-open-project'} onOpenChange={(v) => { if (!v) onClose() }} footer={<><Button onClick={onClose}>稍后设置</Button><Button variant="primary" disabled={!path.trim()} onClick={() => onSave(path)} data-wb-path-confirm>{root ? '使用此工作空间' : '打开项目'}</Button></>}><div className="wb-directory-illustration"><FolderOpen /><div><strong>{root ? '为研究图形，留一个固定的位置。' : '接着上次的工作继续。'}</strong><p>图形与数据保留在你的电脑中。</p></div></div><label className="wb-field">{root ? '工作空间目录' : '项目目录'}<div className="wb-path-row"><TextInput aria-label="目录路径" value={path} placeholder="D:\\Research\\Figures" onChange={(e) => setPath(e.target.value)} data-wb-path-input />{isDesktop() && <Button variant="secondary" onClick={async () => { const next = await pickDirectory(title); if (next) setPath(next) }}>选择目录…</Button>}</div></label>{!isDesktop() && <p className="wb-help">浏览器模式：请输入本机服务可以访问的完整目录路径。</p>}</Dialog>
}
