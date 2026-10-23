import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkbenchApp } from './WorkbenchApp'
import { checkDesktopUpdate, onDesktopMenu, type MenuAction } from '@/lib/desktop'
import { useUiStore } from '@/store/uiStore'
import { useUpdateStore } from '@/store/updateStore'

vi.mock('@/lib/desktop', async (original) => ({
  ...await original<typeof import('@/lib/desktop')>(),
  isDesktop: () => true,
  onDesktopMenu: vi.fn(async () => () => {}),
  checkDesktopUpdate: vi.fn(async () => null),
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root

beforeEach(async () => {
  document.body.innerHTML = ''
  localStorage.setItem('workbench.selectedRoot', '/workbench-test')
  useUiStore.setState({ settingsOpen: false, settingsSection: null, dialogStack: [] })
  useUpdateStore.setState({ status: null, desktopPhase: 'idle', desktopChecked: false, desktopError: null })
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const data = url.includes('/workbench/status')
      ? { root: '/workbench-test', version: '1.0.5', projects: [] }
      : url.includes('/workbench/templates')
        ? { templates: [], categories: [] }
        : url.includes('/update/check')
          ? { desktop: true, current: '1.0.5', auto_check: false, repo_url: 'https://github.com/pawafa666-eng/plot-workbench', releases_url: 'https://github.com/pawafa666-eng/plot-workbench/releases' }
          : { checks: [] }
    return { ok: true, json: async () => data } as Response
  }))
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(<WorkbenchApp />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  vi.unstubAllGlobals()
  useUiStore.setState({ settingsOpen: false, settingsSection: null, dialogStack: [] })
  document.body.innerHTML = ''
})

const checkButton = () => [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === '立即检查')

it('opens the real update settings from the workbench and checks only after a click', async () => {
  expect(checkDesktopUpdate).not.toHaveBeenCalled()
  const settings = document.querySelector<HTMLButtonElement>('[data-wb-settings]')
  expect(settings).toBeTruthy()
  await act(async () => settings!.click())
  expect(document.querySelector('[role="dialog"]')).toBeTruthy()
  expect(checkButton()).toBeTruthy()
  expect(checkDesktopUpdate).not.toHaveBeenCalled()
  await act(async () => checkButton()!.click())
  expect(checkDesktopUpdate).toHaveBeenCalledTimes(1)
})

it('routes the native update menu to the same settings without checking', async () => {
  expect(onDesktopMenu).toHaveBeenCalledTimes(1)
  const handler = vi.mocked(onDesktopMenu).mock.calls[0][0]
  await act(async () => handler('menu-check-updates' satisfies MenuAction))
  expect(checkButton()).toBeTruthy()
  expect(checkDesktopUpdate).not.toHaveBeenCalled()
})
