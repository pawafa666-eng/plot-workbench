import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PaletteEditor } from './PaletteEditor'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
beforeEach(() => {
  document.body.innerHTML = '<div id="test"></div>'
  root = createRoot(document.getElementById('test')!)
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => ({ ok: true, json: async () => ({ id: 'new', ...JSON.parse(String(init.body)) }) })))
})
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals() })

it('adds, replaces, and saves an independent palette', async () => {
  const saved = vi.fn()
  await act(async () => root.render(<PaletteEditor onBack={() => {}} onSaved={saved} />))
  const setInput = async (selector: string, value: string) => {
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>(selector)!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  await setInput('[data-palette-name]', 'Test')
  await setInput('[data-palette-hex]', '#123456')
  await act(async () => document.querySelector<HTMLButtonElement>('[data-palette-add]')!.click())
  expect(document.querySelectorAll('[data-palette-swatch]')).toHaveLength(1)
  await setInput('[data-palette-hex]', '#ABCDEF')
  await act(async () => document.querySelector<HTMLButtonElement>('[data-palette-replace]')!.click())
  await act(async () => document.querySelector<HTMLButtonElement>('[data-palette-save]')!.click())
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toEqual({ name: 'Test', colors: ['#ABCDEF'] })
  expect(saved).toHaveBeenCalledOnce()
})

it('keeps edits made while a save request is in flight', async () => {
  let resolve!: (response: Response) => void
  vi.mocked(fetch).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
  const saved = vi.fn()
  await act(async () => root.render(<PaletteEditor onBack={() => {}} onSaved={saved} />))
  const setInput = async (selector: string, value: string) => {
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>(selector)!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  await setInput('[data-palette-name]', 'First')
  await act(async () => document.querySelector<HTMLButtonElement>('[data-palette-add]')!.click())
  await act(async () => document.querySelector<HTMLButtonElement>('[data-palette-save]')!.click())
  await setInput('[data-palette-name]', 'Newer edit')
  await act(async () => resolve({ ok: true, json: async () => ({ id: 'new', name: 'First', colors: ['#4077CB'] }) } as Response))
  expect(saved).not.toHaveBeenCalled()
  expect(document.querySelector<HTMLInputElement>('[data-palette-name]')!.value).toBe('Newer edit')
  await act(async () => document.querySelector<HTMLButtonElement>('[data-palette-save]')!.click())
  expect(vi.mocked(fetch).mock.calls[1]?.[0]).toBe('/api/workbench/palettes/new')
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body)).name).toBe('Newer edit')
})
