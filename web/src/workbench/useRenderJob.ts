import { useEffect, useRef, useState } from 'react'
import { api, errorText, post, type Job } from './api'

export function useRenderJob() {
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  const generation = useRef(0)
  const activeJob = useRef<string | null>(null)
  const cancelRequested = useRef(false)
  useEffect(() => () => { generation.current++; if (activeJob.current) void post(`/jobs/${activeJob.current}/cancel`).catch(() => undefined) }, [])
  async function start(path: string, body: unknown): Promise<Job | null> {
    const token = ++generation.current
    cancelRequested.current = false
    setStarting(true); setError(''); setJob(null)
    try {
      const created = await post<{ job_id?: string; id?: string }>(path, body)
      const id = created.job_id ?? created.id
      if (!id) throw new Error('服务未返回任务编号')
      activeJob.current = id
      if (token !== generation.current) { void post(`/jobs/${id}/cancel`); return null }
      if (cancelRequested.current) await post(`/jobs/${id}/cancel`)
      setStarting(false); setJob({ id, status: 'running' })
      while (token === generation.current) {
        const current = await api<Job>(`/jobs/${id}`)
        if (token !== generation.current) return null
        setJob(current)
        if (current.status !== 'running') {
          activeJob.current = null
          if (current.status === 'error') setError(current.error ?? '运行失败')
          return current
        }
        await new Promise((resolve) => setTimeout(resolve, 650))
      }
    } catch (err) { if (token === generation.current) { setError(errorText(err)); setJob(null) } }
    finally { if (token === generation.current) setStarting(false) }
    return null
  }
  async function cancel() {
    cancelRequested.current = true
    if (!activeJob.current) return
    try { await post(`/jobs/${activeJob.current}/cancel`) }
    catch (err) { setError(errorText(err)) }
  }
  return { job, error, busy: starting || job?.status === 'running', start, cancel }
}
