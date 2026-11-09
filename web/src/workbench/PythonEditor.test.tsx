import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { PythonEditor } from './PythonEditor'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('colors code while retaining native editing, indentation, scrolling and IME input', async () => {
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  function Harness() {
    const [code, setCode] = useState('"""说明\n第二行"""\nimport math\n# 注释')
    return <PythonEditor code={code} onChange={setCode} />
  }
  try {
    await act(async () => root.render(<Harness />))
    const input = host.querySelector<HTMLTextAreaElement>('textarea')!
    expect(host.querySelector('.code-keyword')?.textContent).toBe('import')
    expect(host.querySelectorAll('.code-string')[1].textContent).toContain('第二行')
    input.selectionStart = input.selectionEnd = input.value.length
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); await new Promise((resolve) => requestAnimationFrame(resolve)) })
    expect(input.value.endsWith('    ')).toBe(true)
    input.scrollTop = 35; input.scrollLeft = 17
    await act(async () => input.dispatchEvent(new Event('scroll', { bubbles: true })))
    expect(host.querySelector<HTMLPreElement>('pre')!.style.transform).toBe('translate(-17px, -35px)')
    await act(async () => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    expect(host.querySelector('.wb-python-editor')?.classList.contains('is-plain')).toBe(true)
    await act(async () => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    expect(host.querySelector<HTMLPreElement>('pre')!.style.transform).toBe('translate(-17px, -35px)')
    expect(input.value.endsWith('    ')).toBe(true)
  } finally { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() }
})
