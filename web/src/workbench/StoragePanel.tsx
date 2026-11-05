import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { TextInput } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { SettingRow, SettingSection } from '@/components/settings/SettingRow'
import { isDesktop, pickDirectory, revealProjectFolder } from '@/lib/desktop'
import { api, errorText, post } from './api'
import { useWorkspace } from './Recovery'

interface LibraryOverview { path: string; exists: boolean; empty: boolean; recognized: boolean; projects: number; templates: number; palettes: number; trash: number }
interface Locations { program: string; program_mode: 'development' | 'installed'; library: string; project: string | null; data: string; installation: { status: string; message: string; registered_directory?: string; registered_version?: string } }
export function LibraryLocationDialog({ current, onClose, onSave }: { current: string; onClose: () => void; onSave: (path: string, mode: 'switch' | 'migrate') => Promise<void> }) {
  const [path, setPath] = useState(current)
  const [mode, setMode] = useState<'switch' | 'migrate'>('switch')
  const [overview, setOverview] = useState<LibraryOverview | null>(null)
  const [checkedPath, setCheckedPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  async function inspect() {
    const candidate = path.trim(); setChecking(true); setError(''); setOverview(null)
    try { const result = await post<LibraryOverview>('/storage/inspect', { path: candidate }); setOverview(result); setCheckedPath(candidate) }
    catch (e) { setError(errorText(e)) } finally { setChecking(false) }
  }
  async function save() {
    if (!overview || checkedPath !== path.trim()) return
    setBusy(true); setError('')
    try { await onSave(overview.path, mode) } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <Dialog open title="模板与配色库位置" description="库目录保存全局模板、配色和回收站；各项目的数据与绘图仍保存在自己的项目文件夹。" width={740} anchor="workbench-root" busy={busy} onOpenChange={(v) => { if (!v) onClose() }} footer={<><Button onClick={onClose} disabled={busy}>取消</Button><Button variant="primary" disabled={busy || checking || !overview || checkedPath !== path.trim() || (mode === 'migrate' && !overview.empty)} onClick={() => void save()} data-wb-path-confirm>{busy ? '正在校验并复制…' : mode === 'migrate' ? '复制并迁移到此目录' : '使用此目录'}</Button></>}>
    <div className="wb-storage-mode"><Button active={mode === 'switch'} disabled={busy} data-wb-library-mode="switch" onClick={() => setMode('switch')}>切换或创建库</Button><Button active={mode === 'migrate'} disabled={busy} data-wb-library-mode="migrate" onClick={() => { setMode('migrate'); if (path === current) { setPath(''); setOverview(null) } }}>迁移当前库</Button></div>
    <p className="wb-muted">{mode === 'migrate' ? '将当前库复制到空目录，逐文件校验后切换。原库保留，可随时切回；外部项目文件不搬动。' : '切换只更换当前使用的库；原库和项目保持原位。空目录会创建新库并加入入门模板。'}</p>
    <label className="wb-field">{mode === 'migrate' ? '迁移目标目录' : '模板与配色库目录'}<div className="wb-path-row"><TextInput aria-label="目录路径" value={path} disabled={busy} placeholder="输入完整目录路径" onChange={(e) => { setPath(e.target.value); setOverview(null) }} data-wb-path-input />{isDesktop() && <Button disabled={busy} variant="secondary" onClick={async () => { try { const value = await pickDirectory('选择模板与配色库目录'); if (value) { setPath(value); setOverview(null); setError('') } } catch (e) { setError(errorText(e)) } }}>选择文件夹…</Button>}</div></label>
    <Button variant="secondary" data-wb-library-inspect disabled={busy || checking || !path.trim()} onClick={() => void inspect()}>{checking ? '正在检查…' : '检查此目录'}</Button>
    {overview && checkedPath === path.trim() && <div className="wb-library-overview" data-wb-library-overview><strong>{overview.empty ? '空目录' : overview.recognized ? '已识别工作台库' : '此目录尚不是工作台库'}</strong><p>{overview.templates} 个模板 · {overview.palettes} 个配色 · {overview.projects} 个登记项目 · {overview.trash} 个回收站项目</p><p className="wb-muted">{mode === 'migrate' && !overview.empty ? '目标已有内容，请选择空目录；需要使用已有库时请选择“切换或创建库”。' : !overview.recognized && !overview.empty ? '确认使用后会在此创建库文件，现有其他文件保持原位。' : '确认后才会更换库位置。'}</p></div>}
    {error && <p className="wb-error" role="alert">{error}</p>}
  </Dialog>
}

export function StorageSettings({ projectId, onChangeRoot }: { projectId?: string; onChangeRoot: () => void }) {
  const workspace = useWorkspace()
  const [locations, setLocations] = useState<Locations | null>(null)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  async function refresh() {
    setChecking(true); setError('')
    try { setLocations(await api<Locations>(`/storage/locations${projectId ? `?project_id=${projectId}` : ''}`)) }
    catch (e) { setError(errorText(e)) } finally { setChecking(false) }
  }
  useEffect(() => { let live = true; setChecking(true); void api<Locations>(`/storage/locations${projectId ? `?project_id=${projectId}` : ''}`).then((r) => { if (live) setLocations(r) }).catch((e) => { if (live) setError(errorText(e)) }).finally(() => { if (live) setChecking(false) }); return () => { live = false } }, [projectId, workspace.root])
  async function open(path: string) {
    try { if (isDesktop()) { if (!await revealProjectFolder(path)) setError(`请手动打开：${path}`) } else { await navigator.clipboard.writeText(path); setError('路径已复制。') } }
    catch (e) { setError(errorText(e)) }
  }
  return <><SettingSection title="文件与存储位置" description="程序、公共资源库和项目各自独立存放。">
    <SettingRow label={locations?.program_mode === 'development' ? '源码程序位置' : '程序安装位置'} description={locations?.program ?? '正在读取…'}><Button variant="secondary" disabled={!locations?.program} onClick={() => void open(locations!.program)} data-wb-open-program>{isDesktop() ? '打开文件夹' : '复制路径'}</Button></SettingRow>
    <SettingRow label="模板与配色库" description={locations?.library ?? workspace.root}><div className="wb-toolbar"><Button variant="secondary" onClick={() => void open(locations?.library ?? workspace.root)}>打开位置</Button><Button variant="secondary" onClick={onChangeRoot} data-wb-settings-root>切换或迁移…</Button></div></SettingRow>
    <SettingRow label="当前项目位置" description={locations?.project ?? '尚未打开项目'}><Button variant="secondary" disabled={!locations?.project} onClick={() => void open(locations!.project!)}>打开文件夹</Button></SettingRow>
    <div className={`wb-installation-check ${locations?.installation?.status === 'mismatch' || locations?.installation?.status === 'missing' ? 'is-error' : ''}`} data-wb-installation-check><span>{locations?.installation?.message ?? '正在读取安装信息…'}</span><Button variant="secondary" disabled={checking} data-wb-check-installation onClick={() => void refresh()}>{checking ? '正在检查…' : '重新检查'}</Button></div>
    {locations?.installation?.registered_directory && <details><summary>安装登记详情</summary><p className="wb-mono-path">{locations.installation.registered_directory} · {locations.installation.registered_version}</p></details>}
    {error && <p className="wb-error" role="alert">{error}</p>}
  </SettingSection><SettingSection title="工作区显示"><SettingRow label="界面密度"><div data-wb-density><Select ariaLabel="界面密度" value={workspace.preferences.density} onChange={(v) => workspace.setPreferences({ density: v as 'standard' | 'compact' })} options={[{ value: 'standard', label: '标准' }, { value: 'compact', label: '紧凑' }]} /></div></SettingRow></SettingSection></>
}
