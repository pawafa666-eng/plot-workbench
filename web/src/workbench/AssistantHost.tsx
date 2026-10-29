import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CodeAssistant, type CodeAssistantProps } from './CodeAssistant'
import type { FigureOutput, Run } from './api'

export interface TemplateAssistantDraft {
  assistantKey: string
  name: string; scope: 'global' | 'project'; categoryId: string; projectId?: string
  outputs: FigureOutput[]; selectedStem: string; run: Run | null; savedFingerprint: string; outputFingerprint: string
}
export type AssistantSource = Omit<CodeAssistantProps, 'open' | 'onClose' | 'onReopen' | 'onReturn' | 'onDiscard' | 'targetAvailable'> & { templateDraft?: TemplateAssistantDraft }
type Source = AssistantSource
type ReturnToSource = (source: Source) => void | Promise<void>
type Entry = { key: string; owner: object; source: Source; returnTo: ReturnToSource; open: boolean; attached: boolean }
type Host = {
  launch: (key: string, owner: object, source: Source, returnTo: ReturnToSource) => void
  sync: (key: string, owner: object, source: Source) => void
  detach: (key: string, owner: object) => void
}
const Context = createContext<Host | null>(null)
export function useAssistantHost() { return useContext(Context) }

export function useAssistantBinding(key: string, source: Source | null) {
  const host = useAssistantHost()
  const owner = useRef({}).current
  const current = useRef(source)
  current.current = source
  useEffect(() => {
    if (!host || !source) return
    host.sync(key, owner, source)
  }, [host, key, owner, source?.code, source?.data, source?.schema, source?.contextKey, source?.sessionId, source?.patches, source?.previewKey, source?.targetLabel, source?.templateDraft?.assistantKey, source?.templateDraft?.name, source?.templateDraft?.scope, source?.templateDraft?.categoryId, source?.templateDraft?.projectId, source?.templateDraft?.outputs, source?.templateDraft?.selectedStem, source?.templateDraft?.run, source?.templateDraft?.savedFingerprint, source?.templateDraft?.outputFingerprint])
  useEffect(() => () => { host?.detach(key, owner) }, [host, key, owner])
  return { host, launch: (returnTo: ReturnToSource) => { if (current.current) host?.launch(key, owner, current.current, returnTo) } }
}

export function AssistantHost({ children }: { children: ReactNode }) {
  const [entry, setEntry] = useState<Entry | null>(null)
  const current = useRef(entry)
  current.current = entry
  const launch = useCallback<Host['launch']>((key, owner, source, returnTo) => {
    if (current.current && current.current.key !== key) {
      window.alert('请先处理已有的 Codex 对话，再打开另一段对话。')
      setEntry((old) => old ? { ...old, open: true } : old)
      return
    }
    setEntry((old) => {
      return old ? { ...old, owner, source, returnTo, attached: true, open: true } : { key, owner, source, returnTo, attached: true, open: true }
    })
  }, [])
  const sync = useCallback<Host['sync']>((key, owner, source) => {
    setEntry((old) => old?.key === key ? { ...old, owner, source, attached: true } : old)
  }, [])
  const detach = useCallback<Host['detach']>((key, owner) => {
    setEntry((old) => old?.key === key && old.owner === owner ? { ...old, attached: false } : old)
  }, [])
  const host = useMemo(() => ({ launch, sync, detach }), [launch, sync, detach])
  return <Context.Provider value={host}>{children}{entry && <CodeAssistant key={entry.key} {...entry.source} open={entry.open} targetAvailable={entry.attached} onClose={() => setEntry((old) => old?.key === entry.key ? { ...old, open: false } : old)} onReopen={() => setEntry((old) => old?.key === entry.key ? { ...old, open: true } : old)} onDiscard={() => setEntry(null)} onReturn={() => { setEntry((old) => old?.key === entry.key ? { ...old, open: false } : old); if (!entry.attached) void entry.returnTo(entry.source) }} onApply={async (result) => { if (!entry.attached) throw new Error('请先返回原来的编辑页面。'); await entry.source.onApply(result); setEntry(null) }} />}</Context.Provider>
}
