import { tokenizePythonLine } from '@/lib/pythonHighlight'
import { useState } from 'react'
import { t } from '@/i18n'
import { CopyButton } from './CopyButton'
import { Button } from './Button'

export function PythonLine({ text }: { text: string }) {
  return <>{tokenizePythonLine(text).map((token, index) => <span key={index} className={`code-${token.kind}`}>{token.text}</span>)}</>
}

export function CodeBlock({ code, title = 'Python', language = 'python' }: { code: string; title?: string; language?: string }) {
  const [expanded, setExpanded] = useState(false)
  const lines = code.split('\n')
  const visible = expanded ? lines : lines.slice(0, 2000)
  return <section className="code-block" data-code-block><div className="code-block-heading"><span>{title}</span><span>{lines.length} 行</span><CopyButton appearance="icon" label="复制代码" text={code} /></div><div className="code-block-scroll"><pre><code>{visible.map((line, index) => <span className="code-line" key={index}><span className="code-gutter" aria-hidden>{index + 1}</span><span>{language === 'python' || language === 'py' ? <PythonLine text={line} /> : line}{'\n'}</span></span>)}</code></pre></div>{visible.length < lines.length && <Button onClick={() => setExpanded(true)}>{t('codeBlock.showAll', { count: lines.length })}</Button>}</section>
}
