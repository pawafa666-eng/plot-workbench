import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { CodeBlock } from '@/components/ui/CodeBlock'
import { Dialog } from '@/components/ui/Dialog'
import { TextArea } from '@/components/ui/Input'
import { CircleAlert, CircleCheck, Images, LoaderCircle, RefreshCw, Sparkles, Upload } from '@/components/ui/icons'
import { Select } from '@/components/ui/Select'
import { agentById, fetchAiCapabilities, type AiCapabilities } from '@/lib/api'
import { useWorkspace } from './Recovery'
import { api, errorText, post, type FigureOutput, type Snapshot, type Template } from './api'
import { DataTable } from './DataWizard'
import { schemaSummary, type Schema } from './model'

interface Destination {
  scope: 'global' | 'project'
  projectId?: string
  categoryId: string
}

interface Candidate {
  name: string
  description: string
  code: string
  data: Snapshot
  schema: Schema
  outputs: FigureOutput[]
}

interface Task {
  id: string
  scope: Destination['scope']
  status: 'running' | 'validating' | 'ready' | 'failed' | 'cancelling'
  error?: string
  candidate?: Candidate
}

const STATE_TEXT = {
  running: '正在创建模板',
  validating: '正在验证模板',
  ready: '仿图模板已就绪',
  failed: '仿图需要处理',
  cancelling: '正在清理临时文件',
}
const DEFAULT_MODEL = '__default__'
const Launch = createContext<((target: Destination) => void) | null>(null)
export const useTemplateImitation = () => useContext(Launch)

function TaskMark({ status }: { status: Task['status'] }) {
  const Icon = status === 'ready' ? CircleCheck : status === 'failed' ? CircleAlert : LoaderCircle
  return <span className="wb-imitation-mark" data-state={status}><Icon aria-hidden /></span>
}

export function TemplateImitationHost({ children, onApplied }: { children: ReactNode; onApplied: (template: Template) => void }) {
  const workspace = useWorkspace()
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<Destination>({ scope: 'global', categoryId: 'uncategorized' })
  const [image, setImage] = useState<File | null>(null)
  const [localPreview, setLocalPreview] = useState('')
  const [dragging, setDragging] = useState(false)
  const [model, setModel] = useState(workspace.preferences.codex_model || DEFAULT_MODEL)
  const [caps, setCaps] = useState<AiCapabilities | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [task, setTask] = useState<Task | null>(null)
  const [adjusting, setAdjusting] = useState(false)
  const [adjustment, setAdjustment] = useState('')
  const [pending, setPending] = useState(false)
  const [applied, setApplied] = useState<Template | null>(null)
  const [error, setError] = useState('')
  const mutation = useRef(0)
  const picker = useRef<HTMLInputElement>(null)
  const info = agentById(caps, 'codex')
  const working = task?.status === 'running' || task?.status === 'validating' || task?.status === 'cancelling'
  const candidate = task?.candidate
  const scope = (task?.scope ?? target.scope) === 'project' ? '项目模板库' : '全局模板库'

  useEffect(() => {
    if (!image) return
    const url = URL.createObjectURL(image)
    setLocalPreview(url)
    return () => { URL.revokeObjectURL(url); setLocalPreview('') }
  }, [image])

  useEffect(() => {
    let active = true
    const generation = mutation.current
    void api<{ task: Task | null }>('/imitation').then((result) => {
      if (active && generation === mutation.current) setTask(result.task ?? null)
    }).catch(() => undefined)
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!working || pending) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const generation = mutation.current
    async function poll() {
      try {
        const result = await api<{ task: Task | null }>('/imitation')
        if (active && generation === mutation.current) {
          setTask(result.task)
          setError('')
        }
      } catch (err) {
        if (active && generation === mutation.current) setError(errorText(err))
      } finally {
        if (active) timer = setTimeout(poll, 900)
      }
    }
    timer = setTimeout(poll, 600)
    return () => { active = false; clearTimeout(timer) }
  }, [working, task?.id, pending])

  async function detect(refresh = false) {
    setDetecting(true)
    setError('')
    try {
      const detected = await fetchAiCapabilities(refresh)
      setCaps(detected)
      const names = agentById(detected, 'codex')?.models ?? []
      setModel((value) => names.includes(value) ? value : DEFAULT_MODEL)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setDetecting(false)
    }
  }

  function launch(destination: Destination) {
    setTarget(destination)
    setApplied(null)
    setOpen(true)
    if (!task && !caps && !detecting) void detect()
  }

  function choose(file?: File) {
    if (!file) return
    if (!/\.(png|jpe?g|webp)$/i.test(file.name) || file.size > 12 * 1024 * 1024) {
      setError('请选择不超过 12 MB 的 PNG、JPEG 或 WebP 图片。')
      return
    }
    setImage(file)
    setError('')
  }

  async function act(action: () => Promise<void>) {
    if (pending) return
    mutation.current++
    setPending(true)
    setError('')
    try { await action() }
    catch (err) { setError(errorText(err)) }
    finally { setPending(false) }
  }

  function start() {
    if (!image || !info?.usable) return
    const form = new FormData()
    form.set('image', image)
    form.set('scope', target.scope)
    form.set('category_id', target.categoryId)
    if (target.projectId) form.set('project_id', target.projectId)
    if (model !== DEFAULT_MODEL) form.set('model', model)
    void act(async () => {
      setTask(await api<Task>('/imitation', { method: 'POST', body: form }))
      setImage(null)
    })
  }

  function adjust() {
    if (!task || !adjustment.trim()) return
    void act(async () => {
      setTask(await post<Task>(`/imitation/${task.id}/adjust`, { prompt: adjustment }))
      setAdjusting(false)
      setAdjustment('')
    })
  }

  function discard() {
    if (!task) return
    void act(async () => {
      const result = await api<{ task: Task | null }>(`/imitation/${task.id}`, { method: 'DELETE' })
      setTask(result.task)
      setAdjusting(false)
      setAdjustment('')
    })
  }

  function apply() {
    if (!task) return
    void act(async () => {
      const template = await post<Template>(`/imitation/${task.id}/apply`)
      setTask(null)
      setApplied(template)
      onApplied(template)
    })
  }

  const description = applied ? applied.name : task ? scope : `参考图将发送给所选 Codex 模型。生成的模板将保存到${scope}。`
  return <Launch.Provider value={launch}>
    {children}
    {!open && task && <Button data-wb-imitation-chip variant="secondary" className="wb-imitation-chip" onClick={() => setOpen(true)}>
      <TaskMark status={task.status} /><span><strong>{STATE_TEXT[task.status]}</strong><small>{candidate?.name ?? '仿图绘制'}</small></span>
    </Button>}
    {open && <Dialog open title={applied ? '已添加到模板库' : '仿图绘制'} description={description} anchor="workbench-imitation"
      width={1020} height={candidate ? 'min(84vh, 740px)' : undefined} chrome="shell"
      onOpenChange={(value) => { if (!value && !pending) setOpen(false) }}
      footer={applied
        ? <Button variant="primary" onClick={() => setOpen(false)}>完成</Button>
        : !task
          ? <><Button onClick={() => setOpen(false)}>取消</Button><Button variant="primary" disabled={!image || !info?.usable || detecting} loading={pending} data-wb-imitation-start onClick={start}><Sparkles />开始创建</Button></>
          : <>
            <Button onClick={() => setOpen(false)} disabled={pending}>关闭窗口</Button>
            <Button variant="danger" disabled={pending || task.status === 'cancelling'} data-wb-imitation-delete onClick={discard}>{working ? '停止并删除' : '删除'}</Button>
            {!working && <Button variant="secondary" disabled={pending} data-wb-imitation-adjust onClick={() => setAdjusting(!adjusting)}>调整</Button>}
            {adjusting
              ? <Button variant="primary" disabled={pending || !adjustment.trim()} data-wb-imitation-send onClick={adjust}>提交调整</Button>
              : <Button variant="primary" disabled={task.status !== 'ready'} loading={pending} data-wb-imitation-apply onClick={apply}>应用到{scope}</Button>}
          </>}>
      {applied ? <div className="wb-imitation-complete"><TaskMark status="ready" />模板已保存，含 Python 代码、Excel 示例和数据要求。</div>
        : <div className="wb-imitation">
          {error && <div className="wb-error" role="alert">{error}</div>}
          {!task && <div className="wb-imitation-setup">
            <div className="wb-imitation-drop" data-wb-imitation-drop data-dragging={dragging || undefined}
              onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => { event.preventDefault(); setDragging(false); choose(event.dataTransfer.files[0]) }}>
              <input type="file" hidden ref={picker} accept=".png,.jpg,.jpeg,.webp" data-wb-imitation-image
                onChange={(event) => { choose(event.target.files?.[0]); event.currentTarget.value = '' }} />
              {localPreview ? <img src={localPreview} alt="参考图" /> : <><Images /><strong>拖入参考图</strong><small>PNG、JPEG 或 WebP</small></>}
              <Button variant="secondary" data-wb-imitation-pick onClick={() => picker.current?.click()}><Upload />{image ? '更换参考图' : '选择图片'}</Button>
            </div>
            <div className="wb-imitation-options">
              <label className="wb-field">Codex 模型<Select ariaLabel="Codex 模型" value={model} disabled={detecting || pending}
                onChange={setModel} options={[{ value: DEFAULT_MODEL, label: info?.default_model ? `自动 · ${info.default_model}` : '使用 Codex 默认模型' },
                  ...(info?.models ?? []).map((name) => ({ value: name, label: name }))]} /></label>
              <p className="wb-muted">{detecting ? '正在检查本机 Codex…' : info?.usable ? '生成示例使用合成数据。' : 'Codex 不可用，请在设置中检查登录或 CLI 路径。'}</p>
              <Button variant="secondary" disabled={detecting || pending} onClick={() => void detect(true)}><RefreshCw />重新检测</Button>
            </div>
          </div>}
          {task && <div className="wb-imitation-status" role="status"><TaskMark status={task.status} /><strong>{STATE_TEXT[task.status]}</strong>
            {working && <span>可以关闭窗口，完成后在右下角查看。</span>}
          </div>}
          {task?.error && <div className="wb-error" role="alert">{task.error}</div>}
          {task && candidate && <>
            <div className="wb-imitation-metadata"><h2>{candidate.name}</h2><span>{schemaSummary(candidate.schema)}</span><p>{candidate.description}</p></div>
            <div className="wb-imitation-previews">
              <figure><figcaption>参考图</figcaption><img src={`/api/workbench/imitation/${task.id}/reference`} alt="参考图" /></figure>
              <figure><figcaption>生成效果</figcaption><img src={candidate.outputs[0]?.preview_url} alt="生成的图形" /></figure>
            </div>
            <div className="wb-imitation-details">
              <CodeBlock code={candidate.code} title="source.py" />
              <DataTable data={candidate.data} caption="data.xlsx" />
            </div>
          </>}
          {adjusting && <label className="wb-field">调整要求<TextArea aria-label="调整要求" data-wb-imitation-request maxLength={4000} value={adjustment}
            rows={3} onChange={(event) => setAdjustment(event.target.value)} placeholder="例如：保留数据列，把图例移到上方并减小网格线对比度。" /></label>}
        </div>}
    </Dialog>}
  </Launch.Provider>
}
