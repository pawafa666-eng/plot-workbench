import { useEffect, useRef, useState } from 'react'
import { CanvasStage } from '@/canvas/CanvasStage'
import { ElementInspector } from '@/components/inspector/ElementInspector'
import { Button, IconButton } from '@/components/ui/Button'
import { FileCodeCorner, Redo2, Undo2 } from '@/components/ui/icons'
import { seedEmbeddedSession, type EmbeddedFigure } from '@/embedded/session'
import { useEngineSync } from '@/hooks/useEngineSync'
import { runUndoRedo } from '@/hooks/useKeyboard'
import { formatMessage, msg } from '@/i18n'
import type { EngineRenderResponse } from '@/lib/api'
import { setEngineTransport } from '@/lib/engineTransport'
import { useDocumentStore } from '@/store/documentStore'
import { exactPanelRender, usePanelRender, useRenderStore } from '@/store/renderStore'
import { finishActiveGesture } from '@/store/gestureCoordinator'
import { useUiStore } from '@/store/uiStore'
import { useWorkspaceStore } from '@/store/workspace'
import type { PanelObject, PanelOverride } from '@/types/document'
import { errorText, post, type Plot, type Snapshot } from './api'
import { DEFAULT_SCHEMA, type Schema } from './model'
import { CodeAssistant, type AssistantRun } from './CodeAssistant'

export interface TavottoSession extends EmbeddedFigure { session_id: string }
export function TavottoEditor({ session, data = null, schema = DEFAULT_SCHEMA, onFinish, onCancel }: { session: TavottoSession; data?: Snapshot | null; schema?: Schema; onFinish: (plot: Plot) => void; onCancel: () => void }) {
  const [staged, setStaged] = useState({ source: session, current: session })
  const currentSession = staged.source === session ? staged.current : session
  const liveSession = useRef(currentSession)
  liveSession.current = currentSession
  const alive = useRef(true)
  const [panelId, setPanelId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { setBusy(false); setError('') }, [session])
  useEffect(() => {
    const restore = setEngineTransport({
      render: (_id, patches) => post<EngineRenderResponse>(`/sessions/${currentSession.session_id}/render`, { patches, inline_svg: true }),
      previewPngUrl: async (_id, patches, bucket, signal) => {
        const response = await fetch(`/api/workbench/sessions/${currentSession.session_id}/preview`, { method: 'POST', credentials: 'same-origin', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patches, bucket }) })
        const body = await response.json(); if (!response.ok) throw new Error(body.error ?? '预览失败'); return body.url
      },
      panelSrc: () => null,
    })
    const seeded = seedEmbeddedSession(currentSession, msg('history.open', undefined, 'workspace'))
    useWorkspaceStore.setState({ mode: 'fast_edit', activePanelId: seeded.panelId, addedForEdit: null })
    useUiStore.setState({ showGrid: false, showRulers: false })
    setPanelId(seeded.panelId)
    return () => { useUiStore.getState().setElementPanel(null); restore() }
  }, [currentSession])
  async function applyAssistant(result: AssistantRun, patches: PanelOverride[], sourcePanelId: string) {
    const source = currentSession
    const unchanged = () => {
      const panel = useDocumentStore.getState().doc.objects.find((p): p is PanelObject => p.type === 'panel' && p.id === sourcePanelId)
      return alive.current && liveSession.current === source && !!panel && JSON.stringify(panel.overrides) === JSON.stringify(patches)
    }
    if (!unchanged()) throw new Error('图形会话已经变化，请重新生成 Codex 修改。')
    finishActiveGesture()
    if (!unchanged()) throw new Error('图内修改尚未同步，请关闭助手后重试。')
    setBusy(true); setError('')
    try {
      const next = await post<TavottoSession>(`/sessions/${source.session_id}/assistant/${result.id}/apply`, { patches })
      if (!unchanged()) throw new Error('图形会话已经变化，未将此结果载入画布。')
      setStaged({ source: session, current: next })
    } finally { if (alive.current && liveSession.current === source) setBusy(false) }
  }
  if (!panelId) return <div className="wb-loading">正在准备 Tavotto 画布…</div>
  return <EmbeddedCanvas panelId={panelId} sessionId={currentSession.session_id} data={data} schema={schema} busy={busy} error={error} onApplyAssistant={applyAssistant} onFinish={async () => {
    setBusy(true); setError('')
    try {
      const panel = useDocumentStore.getState().doc.objects.find((p): p is PanelObject => p.type === 'panel' && p.id === panelId)
      if (!panel) throw new Error('画布对象已关闭')
      const plot = await post<Plot>(`/sessions/${currentSession.session_id}/finish`, { patches: panel.overrides })
      onFinish(plot)
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }} onCancel={async () => {
    setBusy(true); setError('')
    try { await post(`/sessions/${currentSession.session_id}/cancel`); onCancel() }
    catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }} />
}
function EmbeddedCanvas({ panelId, sessionId, data, schema, busy, error, onApplyAssistant, onFinish, onCancel }: { panelId: string; sessionId: string; data: Snapshot | null; schema: Schema; busy: boolean; error: string; onApplyAssistant: (result: AssistantRun, patches: PanelOverride[], sourcePanelId: string) => Promise<void>; onFinish: () => Promise<void>; onCancel: () => Promise<void> }) {
  const [assistantOpen, setAssistantOpen] = useState(false)
  useEngineSync()
  const panel = useDocumentStore((s) => s.doc.objects.find((p): p is PanelObject => p.type === 'panel' && p.id === panelId))
  const canUndo = useDocumentStore((s) => s.past.length > 0)
  const canRedo = useDocumentStore((s) => s.future.length > 0)
  const render = usePanelRender(panel ?? null)
  const pending = render?.status === 'rendering' || (panel && JSON.stringify(panel.overrides) !== render?.lastPatches)
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (assistantOpen) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) {
        event.preventDefault(); runUndoRedo(event.shiftKey)
      }
    }
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler)
  }, [assistantOpen])
  return <div className="wb-tavotto" data-wb-tavotto>
    <div className="wb-editor-bar"><div className="wb-toolbar"><strong>Tavotto 图内编辑</strong><IconButton label="撤销" tip={false} disabled={!canUndo || busy} onClick={() => runUndoRedo(false)}><Undo2 /></IconButton><IconButton label="重做" tip={false} disabled={!canRedo || busy} onClick={() => runUndoRedo(true)}><Redo2 /></IconButton><span className="wb-muted">{pending ? '正在同步图内修改…' : '画布已同步'}</span></div><div className="wb-toolbar"><Button variant="secondary" disabled={busy || !!pending || render?.status !== 'ready'} onClick={() => { finishActiveGesture(); const current = useDocumentStore.getState().doc.objects.find((p): p is PanelObject => p.type === 'panel' && p.id === panelId); if (current && exactPanelRender(useRenderStore.getState(), current)?.status === 'ready') setAssistantOpen(true) }} data-wb-tavotto-assistant><FileCodeCorner />Codex 助手</Button><Button disabled={busy} onClick={onCancel}>取消本次编辑</Button><Button variant="primary" disabled={busy || !!pending || render?.status === 'error'} loading={busy} loadingLabel="正在验证并写回…" onClick={onFinish} data-wb-tavotto-finish>完成并保存</Button></div></div>
    {(error || render?.error) && <div className="wb-error" role="alert">{error || formatMessage(render?.error ?? null)}</div>}
    <div className={`wb-tavotto-body${busy ? ' wb-locked' : ''}`}><div className="wb-canvas-stage"><CanvasStage /></div>{panel && <aside className="wb-inspector"><ElementInspector panel={panel} /></aside>}</div>
    <div className="wb-editor-foot">完成后将保存到 Python 脚本，后续继续使用 Tavotto 调整。取消或验证失败不会锁定代码。</div>
    {assistantOpen && panel && <CodeAssistant data={data} schema={schema} contextKey={panelId} sessionId={sessionId} patches={panel.overrides} onClose={() => setAssistantOpen(false)} onApply={(result) => onApplyAssistant(result, panel.overrides, panelId)} />}
  </div>
}
