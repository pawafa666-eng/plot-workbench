import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from '@/components/ai/Markdown'
import { AgentIcon } from '@/components/settings/AgentIcon'
import { stateLabel } from '@/components/settings/agentState'
import { Button, IconButton } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Reveal } from '@/components/ui/Field'
import { ICON_SIZE } from '@/components/ui/Icon'
import { ArrowDown, ArrowUp, ChevronRight, FileCodeCorner, Maximize2, Minimize2, RefreshCw, Settings, Square } from '@/components/ui/icons'
import { TextArea } from '@/components/ui/Input'
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
  reply?: string
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
interface ChatTurn {
  id: number
  prompt: string
  status: AssistantRun['status']
  reply?: string
  run?: AssistantRun
  error?: string
}
interface HistoryMessage { role: 'user' | 'assistant'; text: string }
const CLI_DEFAULT = '__cli_default__'
const STATUS = { running: 'Codex 正在处理…', done: '本轮对话已完成', failed: '本轮未完成，可以重试', timeout: '任务超时，可以重试', cancelled: '已停止，可以继续或重试', interrupted: '连接已中断，请先停止任务再重试' }
const SUGGESTIONS = ['统一字体和线条样式', '增加误差棒并说明所需数据', '帮我检查这段绘图代码']
const contextFingerprint = (props: CodeAssistantProps) => fingerprintOf(props.code ?? '', props.data, props.schema, [props.contextKey, props.sessionId, props.patches])
const replyFor = (run: AssistantRun) => run.reply?.trim() || run.transcript?.filter((entry) => entry.kind === 'message').map((entry) => entry.text).join('\n\n').trim() || (run.changed ? '已完成修改，请查看代码差异后应用。' : '本轮没有修改代码。')

// The server accepts at most 24 messages / 64000 UTF-8 JSON bytes. Keep whole
// completed pairs; the visible conversation stays intact when older pairs expire.
function historyFor(turns: ChatTurn[]): HistoryMessage[] | null {
  const pairs = turns.filter((turn) => turn.status === 'done' && turn.reply).slice(-12).map((turn): HistoryMessage[] => [{ role: 'user', text: turn.prompt }, { role: 'assistant', text: turn.reply! }])
  const size = (messages: HistoryMessage[]) => new TextEncoder().encode(JSON.stringify(messages)).byteLength
  if (pairs.length && size(pairs[pairs.length - 1]) > 64000) return null
  while (pairs.length && size(pairs.flat()) > 64000) pairs.shift()
  return pairs.flat()
}

export function CodeAssistant(props: CodeAssistantProps) {
  const { code, data, schema, contextKey, sessionId, patches } = props
  const [caps, setCaps] = useState<AiCapabilities | null>(null)
  const [detecting, setDetecting] = useState(true)
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState(useAiStore.getState().models.codex ?? CLI_DEFAULT)
  const [effort, setEffort] = useState(useAiStore.getState().efforts.codex ?? CLI_DEFAULT)
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [proposal, setProposal] = useState<{ run: AssistantRun; fingerprint: string } | null>(null)
  const [running, setRunning] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState('')
  const [captured, setCaptured] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [diffOpen, setDiffOpen] = useState(false)
  const [processOpen, setProcessOpen] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const alive = useRef(true)
  const sequence = useRef(0)
  const capsSequence = useRef(0)
  const activeRun = useRef<string | null>(null)
  const activeTurn = useRef<number | null>(null)
  const requestBusy = useRef(false)
  const lastSuccess = useRef<{ id: string; fingerprint: string } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const composing = useRef(false)
  const latest = useRef(props)
  latest.current = props
  const fingerprint = useMemo(() => fingerprintOf(code ?? '', data, schema, [contextKey, sessionId, patches]), [code, data, schema, contextKey, sessionId, patches])
  const info = agentById(caps, 'codex')
  const stale = captured !== null && captured !== fingerprint
  const lastTurn = turns.at(-1)
  const result = lastTurn?.run
  const process = result?.transcript?.filter((entry) => entry.kind !== 'message') ?? []
  const canRetry = lastTurn && lastTurn.status !== 'done' && lastTurn.status !== 'running' && !running && !activeRun.current && !stopping && !stale
  const canApply = !!proposal?.run.changed && proposal.fingerprint === fingerprint && !running && !activeRun.current && !stopping && !applying && (sessionId || proposal.run.code !== undefined)

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
    const id = activeRun.current
    activeRun.current = null
    if (id) void post(`/assistant/runs/${id}/cancel`).catch(() => undefined)
  }, [])
  useEffect(() => {
    alive.current = true
    void loadCaps()
    return dispose
  }, [loadCaps, dispose])
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [turns, processOpen, diffOpen])

  function updateTurn(id: number, value: Partial<ChatTurn>) {
    setTurns((current) => current.map((turn) => turn.id === id ? { ...turn, ...value } : turn))
  }
  async function poll(id: string, token: number, turnId: number, sourceFingerprint: string) {
    try {
      const next = await api<AssistantRun>(`/assistant/runs/${id}`)
      if (!alive.current || sequence.current !== token) return
      updateTurn(turnId, { status: next.status, run: next, ...(next.status === 'done' ? { reply: replyFor(next) } : {}), error: next.error })
      if (next.status === 'running') timer.current = setTimeout(() => void poll(id, token, turnId, sourceFingerprint), 650)
      else {
        activeRun.current = null; requestBusy.current = false; setRunning(false)
        if (next.status === 'done') {
          lastSuccess.current = { id: next.id, fingerprint: sourceFingerprint }
          setProposal({ run: next, fingerprint: sourceFingerprint })
          setPrompt(''); setDiffOpen(false)
          composer.current?.focus({ preventScroll: true })
        } else if (next.error) setError(next.error)
      }
    } catch (e) {
      if (!alive.current || sequence.current !== token) return
      const message = `读取 Codex 进度失败：${errorText(e)}`
      setError(message); setRunning(false)
      updateTurn(turnId, { status: 'interrupted', error: message })
      // Retain the remote id and request lock until Stop succeeds.
    }
  }
  async function start(retry?: ChatTurn) {
    const text = (retry?.prompt ?? prompt).trim()
    if (!alive.current || !info?.usable || !text || requestBusy.current || activeRun.current || applying || stopping) return
    const source = latest.current
    const sourceFingerprint = contextFingerprint(source)
    const freshContext = captured !== null && captured !== sourceFingerprint
    const previous = freshContext ? [] : turns.filter((turn) => turn.id !== retry?.id)
    const history = historyFor(previous)
    if (history === null) { setError('这段对话过长，请关闭后重新打开助手开始新对话。'); return }
    const token = ++sequence.current
    const turnId = retry?.id ?? token
    requestBusy.current = true; activeTurn.current = turnId
    follow.current = true; setAtBottom(true)
    if (freshContext) { lastSuccess.current = null; setProposal(null) }
    setCaptured(sourceFingerprint); setError(''); setRunning(true); setProcessOpen(false)
    setPrompt(text)
    setTurns([...previous, { id: turnId, prompt: text, status: 'running' }])
    const parent = lastSuccess.current?.fingerprint === sourceFingerprint ? lastSuccess.current.id : undefined
    const data_context = source.data ? { row_count: source.data.row_count, column_count: source.data.column_count, columns: source.data.columns, dtypes: source.data.dtypes } : undefined
    try {
      const created = await post<{ id: string; status: 'running' }>('/assistant/runs', {
        ...(source.sessionId ? { session_id: source.sessionId, patches: source.patches ?? [] } : { code: source.code ?? '' }),
        prompt: text, schema: source.schema, data_context,
        ...(history.length ? { history } : {}), ...(parent ? { parent_id: parent } : {}),
        ...(model !== CLI_DEFAULT ? { model } : {}), ...(effort !== CLI_DEFAULT ? { effort } : {}),
      })
      if (!created.id) throw new Error('服务未返回 Codex 任务编号。')
      if (!alive.current || sequence.current !== token) {
        void post(`/assistant/runs/${created.id}/cancel`).catch(() => undefined)
        return
      }
      activeRun.current = created.id
      await poll(created.id, token, turnId, sourceFingerprint)
    } catch (e) {
      if (alive.current && sequence.current === token) {
        const message = errorText(e)
        requestBusy.current = false; setError(message); setRunning(false)
        updateTurn(turnId, { status: 'failed', error: message })
      }
    }
  }
  async function cancel() {
    sequence.current++
    if (timer.current) clearTimeout(timer.current)
    setRunning(false); setError('')
    if (activeTurn.current !== null) updateTurn(activeTurn.current, { status: 'cancelled' })
    const id = activeRun.current
    if (!id) { requestBusy.current = false; return }
    setStopping(true)
    try {
      await post(`/assistant/runs/${id}/cancel`)
      if (alive.current && activeRun.current === id) { activeRun.current = null; requestBusy.current = false }
    } catch (e) { if (alive.current) setError(`停止 Codex 失败，请重试：${errorText(e)}`) }
    finally { if (alive.current) setStopping(false) }
  }
  function close() {
    if (applying) return
    dispose()
    latest.current.onClose()
  }
  async function apply() {
    if (!canApply || !proposal || proposal.fingerprint !== contextFingerprint(latest.current)) return
    setApplying(true); setError('')
    try {
      await latest.current.onApply(proposal.run)
      if (alive.current) { dispose(); latest.current.onClose() }
    } catch (e) { if (alive.current) setError(errorText(e)) }
    finally { if (alive.current) setApplying(false) }
  }
  return <Dialog open title={<span className="wb-assistant-title"><AgentIcon iconKey="codex" size={24} /><span>Codex 对话</span><span className="wb-assistant-context">{sessionId ? '当前图形' : '模板代码'}</span></span>} width={expanded ? 1280 : 920} height={expanded ? '86vh' : 'min(760px, 86vh)'} chrome="shell" busy={applying} onOpenChange={(open) => { if (!open) close() }} anchor="workbench-code-assistant" footer={<><span className="wb-assistant-apply-note">{proposal?.run.changed ? '代码已暂存，点击应用后才会替换。' : '代码修改会先暂存，供你查看和应用。'}</span><Button disabled={applying} onClick={close} data-wb-assistant-close>关闭</Button><Button variant="secondary" disabled={!canApply} loading={applying} loadingLabel="正在应用并验证…" onClick={() => void apply()} data-wb-assistant-apply><FileCodeCorner size={ICON_SIZE.sm} />{sessionId ? '应用到当前图形' : '应用到模板代码'}</Button></>}>
    <div className="wb-assistant" data-wb-assistant data-expanded={expanded || undefined}>
      <div className="wb-assistant-toolbar">
        <span className="wb-assistant-readiness" data-wb-assistant-readiness><span className="wb-assistant-ready-dot" data-usable={info?.usable || undefined} aria-hidden />{detecting ? '正在检测 Codex…' : info ? stateLabel(info.state) : '未检测到 Codex'}</span>
        <div className="wb-assistant-options">{info?.features.model_selection && <label data-wb-assistant-model><span className="sr-only">模型</span><Select ariaLabel="Codex 模型" value={model} onChange={setModel} disabled={running || !!activeRun.current || applying} options={[{ value: CLI_DEFAULT, label: '跟随 Codex 默认模型' }, ...info.models.map((value) => ({ value, label: value }))]} /></label>}{info?.features.effort_selection && <label data-wb-assistant-effort><span className="sr-only">推理强度</span><Select ariaLabel="Codex 推理强度" value={effort} onChange={setEffort} disabled={running || !!activeRun.current || applying} options={[{ value: CLI_DEFAULT, label: '跟随 Codex 默认设置' }, ...info.efforts.map((value) => ({ value, label: value }))]} /></label>}</div>
        <div className="wb-assistant-tools"><IconButton label="重新检测 Codex" disabled={detecting || running || !!activeRun.current || applying} onClick={() => void loadCaps(true)} data-wb-assistant-refresh><RefreshCw size={ICON_SIZE.md} /></IconButton><IconButton label="编码 Agent 设置" disabled={running || !!activeRun.current || applying} onClick={() => { close(); useUiStore.getState().setSettingsOpen(true, 'ai') }} data-wb-assistant-settings><Settings size={ICON_SIZE.md} /></IconButton><IconButton label={expanded ? '还原对话窗口' : '放大对话窗口'} disabled={applying} onClick={() => setExpanded(!expanded)} data-wb-assistant-expand>{expanded ? <Minimize2 size={ICON_SIZE.md} /> : <Maximize2 size={ICON_SIZE.md} />}</IconButton></div>
      </div>
      {!detecting && !info?.usable && <div className="wb-assistant-notice">请在编码 Agent 设置中完成 Codex 安装、登录或启用，然后重新检测。</div>}
      <div className="wb-assistant-scroll" ref={scroll} onScroll={(event) => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; setAtBottom(follow.current) }}>
        {turns.length === 0 ? <div className="wb-assistant-empty"><AgentIcon iconKey="codex" size={40} /><h3>想怎样调整这张图？</h3><p>讨论绘图思路，或直接描述要修改的细节。</p><div className="wb-assistant-suggestions">{SUGGESTIONS.map((text, index) => <Button variant="secondary" key={text} disabled={applying} data-wb-assistant-suggestion={index} onClick={() => { setPrompt(text); composer.current?.focus() }}>{text}<ArrowUp size={ICON_SIZE.sm} /></Button>)}</div></div> : <div className="wb-assistant-messages" data-wb-assistant-messages>{turns.map((turn) => <div className="wb-assistant-turn" key={turn.id}>
          <div className="wb-assistant-message is-user" data-wb-assistant-message="user"><span className="wb-assistant-speaker">你</span><p>{turn.prompt}</p></div>
          <div className="wb-assistant-message is-assistant" data-wb-assistant-message="assistant"><span className="wb-assistant-speaker">Codex</span>{turn.reply ? <Markdown text={turn.reply} /> : turn.status === 'running' ? <p className="wb-assistant-pending">正在整理回复与代码…</p> : <p className="wb-assistant-pending">{STATUS[turn.status]}</p>}</div>
        </div>)}</div>}
        {!!process.length && <div className="wb-assistant-disclosure"><Button data-wb-assistant-process-toggle aria-expanded={processOpen} onClick={() => setProcessOpen(!processOpen)}><ChevronRight size={ICON_SIZE.xs} className={processOpen ? 'rotate-90' : ''} />处理过程<span>{process.length} 条记录</span></Button><Reveal open={processOpen}><pre data-wb-assistant-transcript>{process.map((entry) => entry.text).join('\n')}</pre></Reveal></div>}
        {proposal?.run.changed && <div className="wb-assistant-disclosure wb-assistant-proposal"><Button data-wb-assistant-diff-toggle aria-expanded={diffOpen} onClick={() => setDiffOpen(!diffOpen)}><ChevronRight size={ICON_SIZE.xs} className={diffOpen ? 'rotate-90' : ''} /><FileCodeCorner size={ICON_SIZE.sm} />代码差异<span>{stale ? '上下文已变化' : running ? '上一版草稿' : '待应用草稿'}</span></Button><Reveal open={diffOpen}><pre data-wb-assistant-diff>{proposal.run.diff || proposal.run.code}</pre></Reveal></div>}
      </div>
      {!atBottom && <div className="wb-assistant-jump"><Button variant="secondary" onClick={() => { follow.current = true; setAtBottom(true); if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight }} data-wb-assistant-bottom><ArrowDown size={ICON_SIZE.sm} />回到最新消息</Button></div>}
      <div className="wb-assistant-compose-area">
        {stale && <p className="wb-error" role="alert" data-wb-assistant-stale>代码、数据或会话已经变化；发送将开始新对话，旧草稿不可应用。</p>}
        {error && <div className="wb-assistant-error" role="alert" data-wb-assistant-error><span>{error}</span>{canRetry && <Button variant="secondary" disabled={!info?.usable || applying} onClick={() => void start(lastTurn)} data-wb-assistant-retry>重试本轮</Button>}</div>}
        {!error && canRetry && <div className="wb-assistant-retry"><span>{STATUS[lastTurn.status]}</span><Button disabled={!info?.usable || applying} onClick={() => void start(lastTurn)} data-wb-assistant-retry>重试本轮</Button></div>}
        <div className="wb-assistant-composer"><TextArea ref={composer} className="wb-assistant-input" aria-label="给 Codex 的消息" data-wb-assistant-prompt placeholder={turns.length ? '继续描述要调整的细节…' : '描述你的绘图想法，或问一个问题…'} rows={3} maxRows={6} value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={running || !!activeRun.current || applying} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !composing.current) { event.preventDefault(); void start() } }} /><div className="wb-assistant-composer-bar"><span data-wb-assistant-status role="status" className={running ? 'text-shimmer' : ''}>{stopping ? '正在停止任务…' : running ? STATUS.running : lastTurn ? STATUS[lastTurn.status] : 'Enter 发送 · Shift + Enter 换行'}</span>{running || activeRun.current ? <Button variant="primary" disabled={stopping} onClick={() => void cancel()} data-wb-assistant-cancel><Square size={ICON_SIZE.sm} />停止</Button> : <Button variant="primary" disabled={detecting || !info?.usable || !prompt.trim() || applying || stopping} onClick={() => void start()} data-wb-assistant-start>发送<ArrowUp size={ICON_SIZE.sm} /></Button>}</div></div>
        <p className="wb-assistant-help">仅发送代码、数据规范与列名/类型，不自动发送数据值。{sessionId ? '应用后仍需“完成并保存”验证。' : '应用后请运行验证并保存模板。'}</p>
      </div>
    </div>
  </Dialog>
}
