import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { PaletteContext, PalettePicker } from '@/components/ui/PalettePicker'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('chooses a saved swatch without changing other colors', async () => {
  document.body.innerHTML = '<div id="host"></div>'
  const root = createRoot(document.getElementById('host')!)
  const onColor = vi.fn()
  const palettes = [{ id: 'one', name: '方案 A', colors: ['#123456', '#ABCDEF'], created_at: '', updated_at: '' }]
  await act(async () => root.render(<PaletteContext.Provider value={{ palettes, error: '' }}><PalettePicker onColor={onColor} /></PaletteContext.Provider>))
  await act(async () => document.querySelector<HTMLButtonElement>('[data-palette-picker]')!.click())
  await act(async () => document.querySelector<HTMLButtonElement>('[data-palette-color="#ABCDEF"]')!.click())
  expect(onColor).toHaveBeenCalledWith('#ABCDEF')
  await act(async () => root.unmount())
})

it('passes a snapshot of a complete palette for a heatmap', async () => {
  document.body.innerHTML = '<div id="host"></div>'
  const root = createRoot(document.getElementById('host')!)
  const onMap = vi.fn()
  const palettes = [{ id: 'one', name: '方案 A', colors: ['#123456', '#ABCDEF'], created_at: '', updated_at: '' }]
  await act(async () => root.render(<PaletteContext.Provider value={{ palettes, error: '' }}><PalettePicker onMap={onMap} /></PaletteContext.Provider>))
  await act(async () => document.querySelector<HTMLButtonElement>('[data-palette-picker]')!.click())
  const ramp = document.querySelector<HTMLElement>('[data-palette-ramp]')!
  expect(ramp.getAttribute('data-palette-ramp')).toBe('continuous')
  await act(async () => {
    const select = document.querySelector<HTMLSelectElement>('[data-palette-picker-panel] select:last-of-type')!
    select.value = 'discrete'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(ramp.getAttribute('data-palette-ramp')).toBe('discrete')
  expect(ramp.style.background.match(/50(?:\.0+)?%/g)).toHaveLength(2)
  await act(async () => [...document.querySelectorAll('button')].find((button) => button.textContent === '应用配色')!.click())
  expect(onMap).toHaveBeenCalledWith({ kind: 'workbench_palette_v1', mode: 'discrete', colors: ['#123456', '#ABCDEF'] })
  palettes[0].colors[0] = '#FFFFFF'
  expect(onMap.mock.calls[0][0].colors[0]).toBe('#123456')
  await act(async () => root.unmount())
})
