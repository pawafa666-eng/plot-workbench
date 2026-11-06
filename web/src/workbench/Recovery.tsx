import { CodeBlock } from '@/components/ui/CodeBlock'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { api, errorText, patch, post, type Plot, type Template } from './api'

export interface EditorDraft {
  id: string; kind: 'plot' | 'template' | 'canvas'; entity_id?: string | null; project_id?: string | null
  scope: 'global' | 'project'; name: string; base_revision: number; generation: number; updated_at?: string
  content: Record<string, unknown>
}
export interface WorkspacePreferences { density: 'standard' | 'compact'; sidebar_collapsed: boolean; project_view: 'cards' | 'list'; codex_model?: string }
type DraftSummary = Omit<EditorDraft, 'content'>
interface Workspace {
  root: string; drafts: DraftSummary[]; problems: string[]; preferences: WorkspacePreferences; preferencesReady: boolean
  refresh: () => Promise<void>; update: (draft: DraftSummary, root: string) => void
  forget: (id: string) => void; register: (flush: () => Promise<void>) => () => void
  flushAll: () => Promise<void>; setPreferences: (value: Partial<WorkspacePreferences>) => void
  deferCleanup: (id: string, task: () => Promise<void>) => void
}
const defaultPreferences: WorkspacePreferences = { density: 'standard', sidebar_collapsed: false, project_view: 'cards' }
const empty: Workspace = { root: '', drafts: [], problems: [], preferences: defaultPreferences, preferencesReady: true, refresh: async () => {}, update: () => {}, forget: () => {}, register: () => () => {}, flushAll: async () => {}, setPreferences: () => {}, deferCleanup: (_id, task) => { void task().catch(() => {}) } }
const Context = createContext<Workspace>(empty)
export const useWorkspace = () => useContext(Context)

export function WorkspaceProvider({ root, children }: { root: string; children: ReactNode }) {
  const [drafts, setDrafts] = useState<DraftSummary[]>([])
  const [problems, setProblems] = useState<string[]>([])
  const [preferences, setPreferenceState] = useState(defaultPreferences)
  const [preferencesReady, setPreferencesReady] = useState(false)
  const localPreferences = useRef<Partial<WorkspacePreferences>>({})
  const currentRoot = useRef(root); currentRoot.current = root
  const flushers = useRef(new Set<() => Promise<void>>())
  const preferenceQueue = useRef(Promise.resolve())
  const cleanupTasks = useRef(new Map<string, () => Promise<void>>())
  const refresh = useCallback(async () => {
    if (!root) return
    const result = await api<{ drafts: DraftSummary[]; problems: string[] }>('/drafts')
    if (currentRoot.current === root) { setDrafts(result.drafts ?? []); setProblems(result.problems ?? []) }
  }, [root])
  useEffect(() => {
    let live = true
    setDrafts([]); setProblems([])
    setPreferencesReady(false)
    void refresh().catch((e) => { if (live) setProblems([errorText(e)]) })
    if (root) void api<Partial<WorkspacePreferences>>('/preferences').then((value) => { if (live) setPreferenceState({ ...defaultPreferences, ...value, ...localPreferences.current }) }).catch((e) => { if (live) setProblems((old) => [...old, `显示设置读取失败：${errorText(e)}`]) }).finally(() => { if (live) setPreferencesReady(true) })
    return () => { live = false }
  }, [refresh, root])
  const update = useCallback((draft: DraftSummary, ownerRoot: string) => { if (currentRoot.current === ownerRoot) setDrafts((old) => [draft, ...old.filter((d) => d.id !== draft.id)]) }, [])
  const forget = useCallback((id: string) => setDrafts((old) => old.filter((d) => d.id !== id)), [])
  const register = useCallback((flush: () => Promise<void>) => { flushers.current.add(flush); return () => { flushers.current.delete(flush) } }, [])
  const deferCleanup = useCallback((id: string, task: () => Promise<void>) => {
    let running: Promise<void> | null = null
    const execute = (): Promise<void> => {
      if (running) return running
      running = task().then(() => { cleanupTasks.current.delete(id) }).finally(() => { running = null })
      return running
    }
    cleanupTasks.current.set(id, execute)
    void execute().catch((e) => setProblems((old) => [...old, `编辑会话关闭失败，切换库前会重试：${errorText(e)}`]))
  }, [])
  const flushAll = useCallback(async () => {
    await Promise.all([...flushers.current].map((flush) => flush()))
    await Promise.all([...cleanupTasks.current.values()].map((close) => close()))
  }, [])
  const setPreferences = useCallback((value: Partial<WorkspacePreferences>) => {
    localPreferences.current = { ...localPreferences.current, ...value }
    setPreferenceState((old) => ({ ...old, ...value }))
    preferenceQueue.current = preferenceQueue.current.then(async () => { await patch('/preferences', value) }).catch((e) => setProblems((old) => [...old, `显示设置保存失败：${errorText(e)}`]))
  }, [])
  return <Context.Provider value={{ root, drafts, problems, preferences, preferencesReady, refresh, update, forget, register, flushAll, setPreferences, deferCleanup }}>{children}</Context.Provider>
}

interface DraftOptions {
  kind: EditorDraft['kind']; entity_id?: string; project_id?: string; scope?: 'global' | 'project'
  name: string; base_revision: number; content: Record<string, unknown>; signature: string; dirty: boolean
  restored?: EditorDraft; enabled?: boolean
}
export function useEditorDraft(options: DraftOptions) {
  const { root, update, forget, register } = useWorkspace()
  const [state, setState] = useState<'idle' | 'waiting' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState('')
  const id = useRef(options.restored?.id ?? crypto.randomUUID().replaceAll('-', ''))
  const generation = useRef(options.restored?.generation ?? 0)
  const latest = useRef(options); latest.current = options
  const savedSignature = useRef('')
  const discarded = useRef(false)
  const clearedSignature = useRef<string | null>(null)
  const mounted = useRef(true)
  const inFlight = useRef<Promise<void> | null>(null)
  const flush = useCallback(async (): Promise<void> => {
    if (inFlight.current) { await inFlight.current; return flush() }
    const value = latest.current
    if (!root || discarded.current || !value.dirty || value.enabled === false || savedSignature.current === value.signature) return
    const signature = value.signature
    if (mounted.current) { setState('saving'); setError('') }
    const work = async () => {
      try {
        const record = await api<DraftSummary>(`/drafts/${id.current}`, { method: 'PUT', body: JSON.stringify({
          kind: value.kind, entity_id: value.entity_id, project_id: value.project_id, scope: value.scope ?? 'global',
          name: value.name, base_revision: value.base_revision, content: value.content,
          generation: generation.current, library_root: root,
        }) })
        generation.current = record.generation; savedSignature.current = signature; update(record, root)
        if (mounted.current) setState(latest.current.signature === signature ? 'saved' : 'waiting')
      } catch (e) { if (mounted.current) { setState('error'); setError(errorText(e)) }; throw e }
    }
    const promise = work(); inFlight.current = promise
    try { await promise } finally { inFlight.current = null }
  }, [root, update])
  useEffect(() => {
    if (options.dirty && options.signature !== clearedSignature.current) discarded.current = false
    if (!root || !options.dirty || options.enabled === false || discarded.current) return
    setState('waiting')
    const timer = setTimeout(() => { void flush().catch(() => {}) }, 700)
    return () => clearTimeout(timer)
  }, [root, options.signature, options.dirty, options.enabled, flush])
  useEffect(() => {
    mounted.current = true
    const release = register(flush)
    const saveOnHide = () => { void flush().catch(() => {}) }
    window.addEventListener('pagehide', saveOnHide)
    return () => { mounted.current = false; window.removeEventListener('pagehide', saveOnHide); release(); void flush().catch(() => {}) }
  }, [flush, register])
  const clear = useCallback(async () => {
    clearedSignature.current = latest.current.signature
    discarded.current = true
    try {
      await inFlight.current
      if (root && generation.current) await api(`/drafts/${id.current}`, { method: 'DELETE', body: JSON.stringify({ generation: generation.current }) })
      forget(id.current)
      id.current = crypto.randomUUID().replaceAll('-', ''); generation.current = 0; savedSignature.current = ''
      if (mounted.current) setState('idle')
    } catch (e) { if (mounted.current) { setState('error'); setError(`正式结果已保留，草稿清理失败：${errorText(e)}`) } }
  }, [root, forget])
  const fork = useCallback(() => { id.current = crypto.randomUUID().replaceAll('-', ''); generation.current = 0; savedSignature.current = ''; discarded.current = false; void flush().catch(() => {}) }, [flush])
  return { state, error, flush, clear, fork, active: !!root }
}

export function DraftStatus({ draft }: { draft: ReturnType<typeof useEditorDraft> }) {
  if (!draft.active) return null
  return <span className={`wb-draft-status ${draft.state === 'error' ? 'is-error' : ''}`} data-wb-draft-status>
    {draft.error || ({ idle: '草稿自动保存在本机', waiting: '草稿等待保存…', saving: '正在保存草稿…', saved: '草稿已保存到本机', error: '草稿未保存' })[draft.state]}
    {draft.state === 'error' && <Button data-wb-draft-fork onClick={draft.fork}>另存一份草稿</Button>}
  </span>
}

export function RecoveryDialog({ onClose, onRecover }: { onClose: () => void; onRecover: (draft: EditorDraft, entity: Plot | Template | null, copied: boolean) => Promise<void> }) {
  const workspace = useWorkspace()
  const [selected, setSelected] = useState<EditorDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const selection = useRef(0)
  async function choose(id: string) {
    const seq = ++selection.current; setSelected(null); setError('')
    try { const value = await api<EditorDraft>(`/drafts/${id}`); if (seq === selection.current) setSelected(value) }
    catch (e) { if (seq === selection.current) setError(errorText(e)) }
  }
  async function recover() {
    if (!selected) return
    setBusy(true); setError('')
    try {
      const result = await post<{ draft: EditorDraft; entity: Plot | Template | null; copied: boolean }>(`/drafts/${selected.id}/restore`, { generation: selected.generation, library_root: workspace.root })
      await onRecover(result.draft, result.entity, result.copied)
      onClose()
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  async function discard() {
    if (!selected || !window.confirm(`移除「${selected.name}」的草稿？正式保存的图和模板保持完整。`)) return
    setBusy(true); setError('')
    try { await api(`/drafts/${selected.id}`, { method: 'DELETE', body: JSON.stringify({ generation: selected.generation }) }); workspace.forget(selected.id); setSelected(null) }
    catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <Dialog open title="恢复本机草稿" description="草稿独立于正式保存的版本。恢复只载入编辑内容，运行和保存仍需验证。来源已有新版本时恢复为副本。" anchor="workbench-recovery" width={860} busy={busy} onOpenChange={(v) => { if (!v) onClose() }} footer={<><Button onClick={onClose} disabled={busy}>关闭</Button><Button variant="danger" onClick={() => void discard()} disabled={busy || !selected} data-wb-draft-delete>移除草稿</Button><Button variant="primary" onClick={() => void recover()} disabled={busy || !selected} data-wb-draft-restore>载入草稿</Button></>}>
    {error && <p className="wb-error" role="alert">{error}</p>}
    {workspace.problems.map((problem, i) => <p key={i} className="wb-error">{problem}</p>)}
    <div className="wb-recovery-layout"><div className="wb-recovery-list">{workspace.drafts.map((draft) => <Button key={draft.id} active={selected?.id === draft.id} disabled={busy} data-wb-draft-item={draft.id} onClick={() => void choose(draft.id)}><strong>{draft.name}</strong><small>{draft.kind === 'canvas' ? '图内编辑' : draft.kind === 'plot' ? '绘图代码与数据' : '模板'} · {draft.updated_at ? new Date(draft.updated_at).toLocaleString() : ''}</small></Button>)}{!workspace.drafts.length && <p className="wb-muted">没有待恢复草稿。</p>}</div>
      <div className="wb-recovery-detail">{selected ? <><h3>{selected.name}</h3><p className="wb-muted">来源版本 r{selected.base_revision} · 草稿修订 {selected.generation}</p>{selected.kind === 'canvas' ? <><p>保留 {Array.isArray(selected.content.patches) ? selected.content.patches.length : 0} 项图内编辑。载入后点击“运行并恢复图内草稿”才建立画布。</p><pre>{JSON.stringify(selected.content.patches, null, 2)}</pre></> : <><p>代码、数据快照与数据规范将一起恢复。</p><CodeBlock code={String(selected.content.code ?? '')} /></>}</> : <p className="wb-muted">选择左侧草稿查看内容。</p>}</div></div>
  </Dialog>
}
