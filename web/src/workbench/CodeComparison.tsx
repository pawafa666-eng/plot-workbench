import { useMemo, useRef } from 'react'
import { CopyButton } from '@/components/ui/CopyButton'
import { PythonLine } from '@/components/ui/CodeBlock'

export interface Comparison { before: string; after: string; opcodes: [string, number, number, number, number][] }
export function CodeComparison({ value, beforeTitle, afterTitle, python = true }: { value: Comparison; beforeTitle: string; afterTitle: string; python?: boolean }) {
  const left = useRef<HTMLDivElement>(null), right = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => {
    const a = value.before.split(/\r?\n/), b = value.after.split(/\r?\n/)
    const result: { old?: number; next?: number; kind: string }[] = []
    for (const [kind, i, end, j, stop] of value.opcodes) {
      for (let k = 0; k < Math.max(end - i, stop - j) && result.length < 5000; k++) result.push({ kind, old: i + k < end ? i + k : undefined, next: j + k < stop ? j + k : undefined })
      if (result.length >= 5000) break
    }
    return { a, b, result, limited: value.opcodes.reduce((sum, [, i, end, j, stop]) => sum + Math.max(end - i, stop - j), 0) > result.length }
  }, [value])
  return <div data-code-comparison><p className="wb-help"><span className="code-removed-key">− 历史删除或修改</span>　<span className="code-added-key">+ 当前新增或修改</span>{value.before === value.after && ' · Python 源代码一致；图内样式变化单独列在下方。'}</p><div className="wb-code-comparison">{(['before', 'after'] as const).map((side) => <section className="code-block" key={side} data-code-side={side}><div className="code-block-heading"><span>{side === 'before' ? beforeTitle : afterTitle}</span><CopyButton appearance="icon" label="复制代码" text={value[side]} /></div><div className="code-block-scroll" ref={side === 'before' ? left : right} onScroll={(e) => { const other = side === 'before' ? right.current : left.current; if (other && Math.abs(other.scrollTop - e.currentTarget.scrollTop) > 1) other.scrollTop = e.currentTarget.scrollTop }}><pre><code>{rows.result.map((row, index) => {
    const n = side === 'before' ? row.old : row.next
    const text = n === undefined ? '' : (side === 'before' ? rows.a[n] : rows.b[n]) ?? ''
    const changed = row.kind !== 'equal' && n !== undefined
    return <span key={index} className={`code-line ${changed ? side === 'before' ? 'code-removed' : 'code-added' : ''}`} data-code-change={changed ? side : undefined}><span className="code-gutter" aria-hidden>{n === undefined ? '' : n + 1}</span><span className="code-diff-sign" aria-hidden>{changed ? side === 'before' ? '−' : '+' : ' '}</span><span>{python ? <PythonLine text={text} /> : text}{'\n'}</span></span>
  })}</code></pre></div></section>)}</div>{rows.limited && <p className="wb-help">对比预览最多显示 5000 行；复制按钮可复制各版本完整代码。</p>}</div>
}
