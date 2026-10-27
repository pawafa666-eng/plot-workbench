import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { stateLabel } from '@/components/settings/agentState'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { TextInput } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { agentById, fetchAiCapabilities, type AiCapabilities } from '@/lib/api'
import { useAiStore } from '@/store/aiStore'
import { useUiStore } from '@/store/uiStore'
import type { PanelOverride } from '@/types/document'
import { api, errorText, post, type Snapshot } from './api'
import { fingerprintOf, type Schema } from './model'

export interface AssistantRun {
  id: string
  status: 'running' | 'done' | 'failed' | 'timeout' | 'cancelled' | 'interrupted'
  code?: string
  diff: string
  changed: boolean
  transcript?: { kind: string; text: string }[]
  error?: string
}
interface CodeAssistantProps {
  code?: string
  data: Snapshot | null
  schema: Schema
  contextKey: string
  sessionId?: string
  patches?: PanelOverride[]
  onApply: (result: AssistantRun) => Promise<void> | void
  onClose: () => void
}
const CLI_DEFAULT = '__cli_default__'
const STATUS = { running: 'Codex 正在处理…', done: '已完成，请查看代码差异后应用。', failed: 'Codex 任务失败。', timeout: 'Codex 任务超时，请重试。', cancelled: '任务已取消。', interrupted: '任务已中断，请重新发起。' }
const contextFingerprint = (props: CodeAssistantProps) => fingerprintOf(props.code ?? '', props.data, props.schema, [props.contextKey, props.sessionId, props.patches])

export function CodeAssistant(props: CodeAssistantProps) {
  const { code, data, schema, contextKey, sessionId, patches } = props
  const [caps, setCaps] = useState<AiCapabilities | null>(null)
  const [detecting, setDetecting] = useState(true)
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState(useAiStore.getState().models.codex ?? CLI_DEFAULT)
  const [effort, setEffort] = useState(useAiStore.getState().efforts.codex ?? CLI_DEFAULT)
  const [result, setResult] = useState<AssistantRun | null>(null)
  const [running, setRunning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState('')
  const [captured, setCaptured] = useState<string | null>(null)
  const alive = useRef(true)
  const sequence = useRef(0)
  const capsSequence = useRef(0)
  const activeRun = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(props)
  latest.current = props
  const fingerprint = useMemo(() => fingerprintOf(code ?? '', data, schema, [contextKey, sessionId, patches]), [code, data, schema, contextKey, sessionId, patches])
  const info = agentById(caps, 'codex')
  const stale = captured !== null && captured !== fingerprint

  const loadCaps = useCallback(async (refresh = false) => {
    const token = ++capsSequence.current
    setDetecting(true); setError('')
    try {
      const next = await fetchAiCapabilities(refresh)
      if (!alive.current || capsSequence.current !== token) return
      setCaps(next)
      const agent = agentById(next, 'codex')
      setModel((value) => agent?.models.includes(value) ? value : CLI_DEFAULT)
      setEffort((value) => agent?.efforts.includes(value) ? value : CLI_DEFAULT)
    } catch (e) { if (alive.current && capsSequence.current === token) setError(errorText(e)) }
    finally { if (alive.current && capsSequence.current === token) setDetecting(false) }
  }, [])
  const dispose = useCallback(() => {
    alive.current = false; sequence.current++; capsSequence.current++
    if (timer.current) clearTimeout(timer.current)
    if (activeRun.current) void post(`/assistant/runs/${activeRun.current}/cancel`).catch(() => undefined)
  }, [])
  useEffect(() => {
    alive.current = true
    void loadCaps()
    return dispose
  }, [loadCaps, dispose])

  async function poll(id: string, token: number) {
    try {
      const next = await api<AssistantRun>(`/assistant/runs/${id}`)
      if (!alive.current || sequence.current !== token) return
      setResult(next)
      if (next.status === 'running') timer.current = setTimeout(() => void poll(id, token), 650)
      else {
        activeRun.current = null; setRunning(false)
        if (next.error) setError(next.error)
      }
    } catch (e) {
      if (!alive.current || sequence.current !== token) return
      setError(`读取 Codex 进度失败：${errorText(e)}`); setRunning(false)
      // Keep the task id so close/cancel can still stop the remote process.
    }
  }
  async function start() {
    if (!info?.usable || !prompt.trim() || running || activeRun.current) return
    const token = ++sequence.current
    const source = latest.current
    setCaptured(contextFingerprint(source)); setResult(null); setError(''); setRunning(true)
    const data_context = source.data ? { row_count: source.data.row_count, column_count: source.data.column_count, columns: source.data.columns, dtypes: source.data.dtypes } : undefined
    try {
      const created = await post<{ id: string; status: 'running' }>('/assistant/runs', {
        ...(source.sessionId ? { session_id: source.sessionId, patches: source.patches ?? [] } : { code: source.code ?? '' }),
        prompt: prompt.trim(), schema: source.schema, data_context,
        ...(model !== CLI_DEFAULT ? { model } : {}), ...(effort !== CLI_DEFAULT ? { effort } : {}),
      })
      if (!created.id) throw new Error('服务未返回 Codex 任务编号。')
      if (!alive.current || sequence.current !== token) {
        void post(`/assistant/runs/${created.id}/cancel`).catch(() => undefined)
        return
      }
      activeRun.current = created.id
      await poll(created.id, token)
    } catch (e) {
      if (alive.current && sequence.current === token) { setError(errorText(e)); setRunning(false) }
    }
  }
  async function cancel() {
    sequence.current++
    if (timer.current) clearTimeout(timer.current)
    setRunning(false); setResult((value) => ({ id: activeRun.current ?? '', diff: '', changed: false, ...value, status: 'cancelled' }))
    const id = activeRun.current
    if (!id) return
    try {
      await post(`/assistant/runs/${id}/cancel`)
      if (alive.current && activeRun.current === id) { activeRun.current = null; setError(''); setResult((value) => ({ id, diff: '', changed: false, ...value, status: 'cancelled' })) }
    } catch (e) { if (alive.current) setError(`取消 Codex 失败，请重试：${errorText(e)}`) }
  }
  async function apply() {
    if (!result || result.status !== 'done' || !result.changed || applying || stale) return
    if (captured !== contextFingerprint(latest.current)) { setError('代码、数据或会话已经变化，请重新生成。'); return }
    setApplying(true); setError('')
    try {
      await latest.current.onApply(result)
      if (alive.current) latest.current.onClose()
    } catch (e) { if (alive.current) setError(errorText(e)) }
    finally { if (alive.current) setApplying(false) }
  }
  return <Dialog open title="Codex 代码助手" description={props.sessionId ? '修改当前图形的绘图代码，应用后继续在画布中调整。' : '描述要创建或修改的模板，生成后查看差异并应用。'} width={820} busy={applying} onOpenChange={(open) => { if (!open) props.onClose() }} anchor="workbench-code-assistant" footer={<><Button disabled={applying} onClick={props.onClose} data-wb-assistant-close>关闭</Button><Button variant="primary" disabled={applying || running || stale || result?.status !== 'done' || !result.changed || (!props.sessionId && result.code === undefined)} loading={applying} loadingLabel="正在应用并验证…" onClick={() => void apply()} data-wb-assistant-apply>{props.sessionId ? '应用到当前图形' : '应用到模板代码'}</Button></>}>
    <div className="wb-assistant" data-wb-assistant>
      <div className="wb-assistant-settings"><span data-wb-assistant-readiness>{detecting ? '正在检测本机 Codex…' : info ? `${info.display_name} · ${stateLabel(info.state)}` : '未检测到可用的 Codex'}</span><Button disabled={detecting || running || applying} onClick={() => void loadCaps(true)} data-wb-assistant-refresh>重新检测</Button><Button disabled={running || applying} onClick={() => { props.onClose(); useUiStore.getState().setSettingsOpen(true, 'ai') }} data-wb-assistant-settings>编码 Agent 设置</Button></div>
      {!detecting && info && !info.usable && <p className="wb-assistant-help">请在编码 Agent 设置中完成 Codex 安装、登录或启用，然后重新打开助手。</p>}
      <div className="wb-assistant-options">{info?.features.model_selection && <label data-wb-assistant-model>模型<Select ariaLabel="Codex 模型" value={model} onChange={setModel} disabled={running || applying} options={[{ value: CLI_DEFAULT, label: '跟随 Codex 默认模型' }, ...info.models.map((value) => ({ value, label: value }))]} /></label>}{info?.features.effort_selection && <label data-wb-assistant-effort>推理强度<Select ariaLabel="Codex 推理强度" value={effort} onChange={setEffort} disabled={running || applying} options={[{ value: CLI_DEFAULT, label: '跟随 Codex 默认设置' }, ...info.efforts.map((value) => ({ value, label: value }))]} /></label>}</div>
      <label className="wb-field">修改要求<TextInput aria-label="Codex 修改要求" data-wb-assistant-prompt placeholder="例如：改成双面板折线图，增加误差棒并统一字体" value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={running || applying} /></label>
      <p className="wb-assistant-help">发送当前代码、数据规范和列名/类型，不自动发送数据值。应用后{props.sessionId ? '仍需点击“完成并保存”验证并保存。' : '请运行并验证后保存模板。'}</p>
      <div className="wb-assistant-actions">{running || activeRun.current ? <Button variant="secondary" onClick={() => void cancel()} data-wb-assistant-cancel>取消任务</Button> : <Button variant="secondary" disabled={detecting || !info?.usable || !prompt.trim() || applying} onClick={() => void start()} data-wb-assistant-start>交给 Codex</Button>}<span data-wb-assistant-status role="status">{running ? STATUS.running : result ? STATUS[result.status] : '尚未生成代码'}</span></div>
      {stale && <p className="wb-error" role="alert" data-wb-assistant-stale>代码、数据或会话已经变化，请重新生成后应用。</p>}
      {error && <p className="wb-error" role="alert" data-wb-assistant-error>{error}</p>}
      {!!result?.transcript?.length && <section className="wb-assistant-output"><h3>Codex 输出</h3><pre data-wb-assistant-transcript>{result.transcript.map((entry) => entry.text).join('\n')}</pre></section>}
      {result?.status === 'done' && <section className="wb-assistant-output"><h3>{result.diff ? '代码差异' : result.changed ? '生成代码' : '没有代码变更'}</h3><pre data-wb-assistant-diff>{result.diff || result.code || 'Codex 未修改代码。'}</pre></section>}
    </div>
  </Dialog>
}
