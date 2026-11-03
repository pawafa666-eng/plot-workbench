import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import * as keyboard from '@/hooks/useKeyboard'
import { afterEach, expect, it, vi } from 'vitest'
import { menuActionEnabled, performEditorMenuAction, useWorkbenchMenu } from './menu'
import { registerGesture, resetGestureCoordinator } from '@/store/gestureCoordinator'

const originalExec = Object.getOwnPropertyDescriptor(document, 'execCommand')
afterEach(() => {
  resetGestureCoordinator()
  document.body.innerHTML = ''
  if (originalExec) Object.defineProperty(document, 'execCommand', originalExec)
  else delete (document as unknown as Record<string, unknown>).execCommand
})

it('does not run a background save while a dialog is open', () => {
  document.body.innerHTML = '<button data-wb-save>Save</button><div data-dialog data-state="open"></div>'
  const save = document.querySelector<HTMLButtonElement>('[data-wb-save]')!
  const onSave = vi.fn(), finish = vi.fn()
  save.addEventListener('click', onSave)
  registerGesture(finish)
  expect(menuActionEnabled('menu-save', true)).toBe(false)
  performEditorMenuAction('menu-save')
  expect(onSave).not.toHaveBeenCalled()
  expect(finish).not.toHaveBeenCalled()
})

it('settles an active gesture before the normal save button is activated', () => {
  document.body.innerHTML = '<button data-wb-save>Save</button>'
  const order: string[] = []
  registerGesture(() => order.push('finish'))
  document.querySelector('[data-wb-save]')!.addEventListener('click', () => order.push('save'))
  performEditorMenuAction('menu-save')
  expect(order).toEqual(['finish', 'save'])
})

it('leaves text undo in a dialog to the native editor without settling its gesture', () => {
  document.body.innerHTML = '<div data-dialog data-state="open"><textarea data-field></textarea></div>'
  document.querySelector<HTMLTextAreaElement>('[data-field]')!.focus()
  const finish = vi.fn(), exec = vi.fn()
  registerGesture(finish)
  Object.defineProperty(document, 'execCommand', { configurable: true, value: exec })
  expect(menuActionEnabled('menu-undo', false)).toBe(true)
  performEditorMenuAction('menu-undo')
  expect(exec).toHaveBeenCalledWith('undo')
  expect(finish).not.toHaveBeenCalled()
})


it('accepts the shifted plus key for canvas zoom without taking other shifted shortcuts', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  const zoom = vi.spyOn(keyboard, 'runZoomCommand').mockImplementation(() => {})
  function Surface() { useWorkbenchMenu(false, () => {}); return createElement('div', { 'data-wb-tavotto': '' }) }
  try {
    await act(async () => root.render(createElement(Surface)))
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '+', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })) })
    expect(zoom).toHaveBeenCalledWith('in')
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'E', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })) })
    expect(zoom).toHaveBeenCalledTimes(1)
  } finally { await act(async () => root.unmount()); zoom.mockRestore() }
})
