import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/Tooltip'
import { CodeBlock } from '@/components/ui/CodeBlock'
import { Markdown } from '@/components/ai/Markdown'
import { copyText } from '@/lib/textClipboard'
import { CodeComparison } from './CodeComparison'
import { TrashPanel } from './TrashPanel'
import { formatDateTime } from './dateTime'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
beforeEach(() => { document.body.innerHTML = '<div id="copy-test"></div>'; root = createRoot(document.getElementById('copy-test')!); vi.stubGlobal('fetch', vi.fn()) })
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '' })
async function render(content: React.ReactNode) { await act(async () => root.render(<TooltipProvider>{content}</TooltipProvider>)) }
async function click(selector: string) { await act(async () => document.querySelector<HTMLButtonElement>(selector)!.click()) }

it('copies the full original source, without line numbers, and safely displays Markdown code', async () => {
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const code = 'import pandas as pd\n# <img src=x onerror=alert(1)>\nx = 2\n'
  await render(<CodeBlock code={code} />)
  expect(document.querySelector('img')).toBeNull()
  expect(document.querySelectorAll('.code-gutter')).toHaveLength(4)
  await click('[data-copy-button]')
  expect(writeText).toHaveBeenCalledWith(code)
  await render(<Markdown text={'```python\n' + code + '```'} />)
  await click('[data-copy-button]')
  expect(writeText).toHaveBeenLastCalledWith(code.trimEnd())
  expect(document.querySelector('img')).toBeNull()
})

it('falls back to a focused native textarea and restores focus when WebView clipboard access fails', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
  const input = document.createElement('input'); document.body.appendChild(input); input.focus()
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => {
    expect(document.activeElement).toBeInstanceOf(HTMLTextAreaElement)
    expect((document.activeElement as HTMLTextAreaElement).value).toBe('完整 traceback\nline two')
    return true
  }) })
  await copyText('完整 traceback\nline two')
  expect(document.activeElement).toBe(input)
  expect(document.querySelector('textarea')).toBeNull()
})

it('marks changed lines red and green and copies each complete version', async () => {
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const value = { before: 'import pandas\nx = 1\n', after: 'import pandas\nx = 2\n', opcodes: [['equal', 0, 1, 0, 1], ['replace', 1, 2, 1, 2]] as [string, number, number, number, number][] }
  await render(<CodeComparison value={value} beforeTitle="历史 r1" afterTitle="当前 r2" />)
  expect(document.querySelectorAll('[data-code-change="before"]')).toHaveLength(1)
  expect(document.querySelectorAll('[data-code-change="after"]')).toHaveLength(1)
  expect(document.querySelector('.code-removed')?.textContent).toContain('x = 1')
  expect(document.querySelector('.code-added')?.textContent).toContain('x = 2')
  expect(document.body.textContent).not.toContain('最多显示')
  await act(async () => { for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy-button]')) button.click() })
  expect(writeText.mock.calls).toEqual([[value.before], [value.after]])
})

it('clears only the confirmed list and reports partial failures with a short 24-hour timestamp', async () => {
  const refresh = vi.fn(async () => {})
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ deleted: ['a'], failed: [{ id: 'b', message: 'file locked' }] }) } as Response)
  const items = [{ id: 'a', name: 'A', kind: 'plot', deleted_at: '2026-11-06T02:34:56.123456+00:00' }, { id: 'b', name: 'B', kind: 'template' }]
  await render(<TrashPanel items={items} root={'D:\\library'} refresh={refresh} onRestored={async () => {}} />)
  const date = new Date(items[0].deleted_at!)
  expect(formatDateTime(items[0].deleted_at)).toMatch(new RegExp(`2026-11-06 ${String(date.getHours()).padStart(2, '0')}:34:56`))
  expect(document.querySelector('time')?.textContent).not.toContain('123456')
  await click('[data-wb-trash-empty]')
  expect(fetch).not.toHaveBeenCalled()
  await click('[data-wb-trash-confirm]')
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({ library_root: 'D:\\library', ids: ['a', 'b'] })
  expect(refresh).toHaveBeenCalledOnce()
  expect(document.body.textContent).toContain('file locked')
})
