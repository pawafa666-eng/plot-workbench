import { useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'

/** Notes belong to the template, not to a particular render. */
export function TemplateNotes({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 1)
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(el)
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [value])
  return <>
    <div className="wb-template-notes" data-wb-template-notes>
      <label htmlFor="wb-template-note">备注</label>
      <textarea id="wb-template-note" ref={input} aria-label="模板备注" placeholder="填写模板的用途、数据说明等" maxLength={20000} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      {overflowing && <Button data-wb-note-expand onClick={() => setOpen(true)}>查看全部</Button>}
    </div>
    {open && <Dialog open title="模板备注" description="记录模板用途、数据格式或使用方法。" anchor="workbench-template-notes" width={740} onOpenChange={(v) => setOpen(v)} footer={<Button variant="primary" onClick={() => setOpen(false)}>完成</Button>}>
      <textarea className="wb-template-notes-full" aria-label="完整模板备注" maxLength={20000} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </Dialog>}
  </>
}
