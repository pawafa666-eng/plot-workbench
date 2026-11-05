import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { TextInput } from '@/components/ui/Input'
import { Folder, FolderOpen, FolderPlus, LayoutGrid, LayoutList, Plus, ChevronRight } from '@/components/ui/icons'
import type { Project } from './api'
import { useWorkspace } from './Recovery'

export function ProjectHome({ projects, templateCount, onOpen, onCreate, onOpenFolder, onRecovery }: { projects: Project[]; templateCount: number; onOpen: (id: string) => void; onCreate: () => void; onOpenFolder: () => void; onRecovery: () => void }) {
  const workspace = useWorkspace()
  const [query, setQuery] = useState('')
  const visible = projects.filter((p) => `${p.name} ${p.working_directory ?? p.path}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => (b.updated_at ?? b.created_at ?? '').localeCompare(a.updated_at ?? a.created_at ?? ''))
  const view = workspace.preferences.project_view
  return <div className="wb-project-home"><div className="wb-page-heading"><div><h1>项目</h1><p>继续最近的绘图，或打开已有项目文件夹。</p></div><div className="wb-toolbar"><Button variant="secondary" onClick={onOpenFolder}><FolderOpen />打开项目文件夹</Button><Button variant="primary" onClick={onCreate} data-wb-project-create><Plus />新建项目</Button></div></div>
    <div className="wb-home-status"><span><strong>{projects.length}</strong> 个项目</span><span><strong>{templateCount}</strong> 个全局模板</span><Button variant="secondary" data-wb-recovery-open onClick={onRecovery}>恢复草稿{workspace.drafts.length ? `（${workspace.drafts.length}）` : ''}</Button></div>
    {workspace.problems.length > 0 && <p className="wb-error">{workspace.problems.join(' ')}</p>}
    <div className="wb-project-list-toolbar"><TextInput aria-label="搜索项目" placeholder="搜索项目名称或路径…" value={query} onChange={(e) => setQuery(e.target.value)} data-wb-project-search /><span className="wb-muted">{visible.length} 个项目 · 最近修改在前</span><div className="wb-toolbar"><Button active={view === 'cards'} onClick={() => workspace.setPreferences({ project_view: 'cards' })} data-wb-project-view="cards"><LayoutGrid />卡片</Button><Button active={view === 'list'} onClick={() => workspace.setPreferences({ project_view: 'list' })} data-wb-project-view="list"><LayoutList />列表</Button></div></div>
    <div className={`wb-project-grid ${view === 'list' ? 'is-list' : ''}`} data-wb-project-list>{visible.map((project) => <article className="wb-project-card" key={project.id} data-wb-project-card={project.id}>
      <Button className="wb-project-card-preview" onClick={() => onOpen(project.id)} aria-label={`打开项目 ${project.name}`}>{project.preview_url ? <img src={project.preview_url} alt={`${project.name}图形预览`} loading="lazy" /> : <span><Folder /><span>项目预览</span></span>}</Button>
      <div className="wb-project-card-content"><Button className="wb-project-card-title" onClick={() => onOpen(project.id)}><h3>{project.name}</h3></Button><p>{project.plot_count ?? (Array.isArray(project.plots) ? project.plots.length : 0)} 张图{project.missing ? ' · 项目目录不可用' : ''}</p><p className="wb-muted">{project.updated_at || project.created_at ? `修改于 ${new Date(project.updated_at ?? project.created_at!).toLocaleString()}` : '旧版未记录修改时间'}</p><div className="wb-project-card-bottom"><span title={project.working_directory ?? project.path}>{project.working_directory ?? project.path}</span><Button onClick={() => onOpen(project.id)}>打开<ChevronRight /></Button></div></div>
    </article>)}</div>
    {!visible.length && <div className="wb-empty-state"><FolderPlus /><h2>{query ? '没有匹配的项目' : '开始一个绘图项目'}</h2><p>{query ? '可以修改搜索词，或打开其他项目文件夹。' : '选择已有数据文件夹，代码和原始数据保留在原位置。'}</p><Button variant="secondary" onClick={onCreate}>新建项目</Button></div>}
  </div>
}
