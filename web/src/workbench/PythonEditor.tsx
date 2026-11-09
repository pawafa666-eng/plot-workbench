import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { tokenizePython } from '@/lib/pythonHighlight'

const HIGHLIGHT_LIMIT = 500_000

export function PythonEditor({ code, onChange, readOnly }: { code: string; onChange: (value: string) => void; readOnly?: boolean }) {
  const mirror = useRef<HTMLPreElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const [composing, setComposing] = useState(false)
  const highlighted = code.length <= HIGHLIGHT_LIMIT
  const lines = useMemo(() => highlighted ? tokenizePython(code.replace(/\r\n?/g, '\n')) : [], [code, highlighted])
  const plain = !highlighted || composing
  useLayoutEffect(() => {
    if (mirror.current && input.current) mirror.current.style.transform = `translate(${-input.current.scrollLeft}px, ${-input.current.scrollTop}px)`
  }, [plain])
  return <div className={`wb-python-editor ${plain ? 'is-plain' : ''}`}>
    {!plain && <pre ref={mirror} className="wb-python-highlight" aria-hidden="true">{lines.map((line, row) => <span key={row}>{row > 0 && '\n'}{line.map((token, col) => <span className={`code-${token.kind}`} key={col}>{token.text}</span>)}</span>)}{code.endsWith('\n') && '\n'}{'\u200b'}</pre>}
    <textarea ref={input} aria-label="Python 代码" spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off" value={code} readOnly={readOnly} data-wb-code
      onChange={(e) => onChange(e.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
      onScroll={(e) => { if (mirror.current) mirror.current.style.transform = `translate(${-e.currentTarget.scrollLeft}px, ${-e.currentTarget.scrollTop}px)` }}
      onKeyDown={(e) => {
        if (e.key === 'Tab' && !readOnly && !e.nativeEvent.isComposing) { e.preventDefault(); const el = e.currentTarget; const start = el.selectionStart; const end = el.selectionEnd; onChange(code.slice(0, start) + '    ' + code.slice(end)); requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = start + 4 }) }
      }} />
  </div>
}
