import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkbenchApp } from './WorkbenchApp'
import { checkDesktopUpdate, isDesktop, onWorkbenchMenu, pickDirectory, setWorkbenchMenuEnabled, type WorkbenchMenuAction } from '@/lib/desktop'
import { useUiStore } from '@/store/uiStore'
import { useUpdateStore } from '@/store/updateStore'

vi.mock('@/lib/desktop', async (original) => ({
  ...await original<typeof import('@/lib/desktop')>(),
  isDesktop: vi.fn(() => true),
  onWorkbenchMenu: vi.fn(async () => () => {}),
  checkDesktopUpdate: vi.fn(async () => null),
  setWorkbenchMenuEnabled: vi.fn(async () => true),
  pickDirectory: vi.fn(async () => null),
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root

beforeEach(async () => {
  document.body.innerHTML = ''
  localStorage.setItem('workbench.selectedRoot', '/workbench-test')
  useUiStore.setState({ settingsOpen: false, settingsSection: null, dialogStack: [] })
  useUpdateStore.setState({ status: null, desktopPhase: 'idle', desktopChecked: false, desktopError: null })
  vi.clearAllMocks()
  vi.mocked(isDesktop).mockReturnValue(true)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const data = url.includes('/workbench/status')
      ? { root: '/workbench-test', version: '1.0.5', projects: [] }
      : url.includes('/workbench/templates')
        ? { templates: [], categories: [] }
        : url.includes('/workbench/projects')
          ? { id: 'project-new', name: '已有数据', path: 'D:\\研究\\已有数据', plots: [] }
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
  expect(document.querySelector('[data-section=general][aria-current=true]')).toBeTruthy()
  expect(checkButton()).toBeUndefined()
  await act(async () => document.querySelector<HTMLButtonElement>('[data-section=about]')!.click())
  expect(checkButton()).toBeTruthy()
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/update/check'))).toBe(false)
  expect(checkDesktopUpdate).not.toHaveBeenCalled()
  await act(async () => checkButton()!.click())
  expect(checkDesktopUpdate).toHaveBeenCalledTimes(1)
})

it('routes the native update menu to the same settings without checking', async () => {
  expect(onWorkbenchMenu).toHaveBeenCalledTimes(1)
  const handler = vi.mocked(onWorkbenchMenu).mock.calls[0][0]
  await act(async () => handler('menu-check-updates' satisfies WorkbenchMenuAction))
  expect(checkButton()).toBeTruthy()
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/update/check'))).toBe(false)
  expect(checkDesktopUpdate).not.toHaveBeenCalled()
})

it('uses workbench settings and keeps attribution inside About', async () => {
  expect(document.querySelector('.wb-sidebar-bottom')?.textContent).not.toContain('Tavotto')
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-settings]')!.click())
  expect([...document.querySelectorAll('[data-section]')].map((node) => node.getAttribute('data-section'))).toEqual(['general', 'ai', 'diagnostics', 'about'])
  expect(document.querySelector('[data-wb-settings-root]')).toBeTruthy()
  await act(async () => document.querySelector<HTMLButtonElement>('[data-section=about]')!.click())
  const attribution = document.querySelector<HTMLDetailsElement>('[data-wb-attribution]')
  expect(attribution?.open).toBe(false)
  expect(attribution?.textContent).toContain('Tavotto v0.18.0')
  expect(attribution?.textContent).toContain('AGPL-3.0-only')
})

it('opens project and template workflows from native menus, with current availability', async () => {
  const handler = vi.mocked(onWorkbenchMenu).mock.calls[0][0]
  const enabled = vi.mocked(setWorkbenchMenuEnabled).mock.calls.at(-1)![0]
  expect(enabled).toContain('menu-open-project')
  expect(enabled).not.toContain('menu-new-plot')
  expect(enabled).not.toContain('menu-save')
  await act(async () => handler('menu-open-project'))
  expect(document.querySelector('[data-dialog="workbench-open-project"]')).toBeTruthy()
  // A second navigation command cannot leave an open dialog behind.
  await act(async () => handler('menu-new-template'))
  expect(document.querySelector('[data-wb-template-editor]')).toBeNull()
  await act(async () => document.querySelector<HTMLButtonElement>('[data-dialog="workbench-open-project"] [data-dialog-close]')!.click())
  await act(async () => handler('menu-new-template'))
  expect(document.querySelector('[data-wb-template-editor]')).toBeTruthy()
})

it('uses the workbench help and protects an unsaved template when navigating', async () => {
  const handler = vi.mocked(onWorkbenchMenu).mock.calls[0][0]
  await act(async () => handler('menu-shortcut-help'))
  expect(document.querySelector('[data-dialog="workbench-help"]')?.textContent).toContain('运行图 / 验证模板')
  await act(async () => document.querySelector<HTMLButtonElement>('[data-dialog="workbench-help"] [data-dialog-close]')!.click())
  await act(async () => handler('menu-new-template'))
  expect(document.querySelector('[data-wb-template-editor]')).toBeTruthy()
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  await act(async () => handler('menu-home'))
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(document.querySelector('[data-wb-template-editor]')).toBeTruthy()
  confirm.mockRestore()
})

it('creates a project in an existing folder with an optional name', async () => {
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-project-create]')!.click())
  const path = document.querySelector<HTMLInputElement>('[data-wb-project-path]')
  expect(path).toBeTruthy()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(path, 'D:\\研究\\已有数据')
    path!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const confirm = document.querySelector<HTMLButtonElement>('[data-wb-project-confirm]')
  expect(confirm?.disabled).toBe(false)
  await act(async () => confirm!.click())
  const request = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url) === '/api/workbench/projects' && init?.method === 'POST')
  expect(request).toBeTruthy()
  expect(JSON.parse(String(request![1]!.body))).toEqual({ path: 'D:\\研究\\已有数据', name: '' })
})

it('keeps local template upload and creation available without an online template entry', async () => {
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-nav-templates]')!.click())
  const library = document.querySelector('[data-wb-template-library]')!
  const upload = library.querySelector<HTMLInputElement>('[data-wb-library-upload]')
  expect(upload?.type).toBe('file')
  expect(upload?.accept).toBe('.py')
  expect(library.querySelector('[data-wb-online-templates]')).toBeNull()
  expect(library.querySelectorAll('a[href]')).toHaveLength(0)
  const uploadClick = vi.spyOn(upload!, 'click')
  const uploadButton = library.querySelector<HTMLButtonElement>('[data-wb-library-upload-trigger]')
  expect(uploadButton?.disabled).toBe(false)
  await act(async () => uploadButton!.click())
  expect(uploadClick).toHaveBeenCalledTimes(1)
  const create = library.querySelector<HTMLButtonElement>('[data-wb-template-create]')
  expect(create?.disabled).toBe(false)
  await act(async () => create!.click())
  expect(document.querySelector('[data-wb-template-editor]')).toBeTruthy()
})

it('uses the native existing-folder picker for project creation', async () => {
  vi.mocked(pickDirectory).mockResolvedValueOnce('D:\\研究\\已有数据')
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-project-create]')!.click())
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-project-browse]')!.click())
  expect(pickDirectory).toHaveBeenCalledWith('选择项目文件夹')
  expect(document.querySelector<HTMLInputElement>('[data-wb-project-path]')?.value).toBe('D:\\研究\\已有数据')
  await act(async () => document.querySelector<HTMLButtonElement>('[data-wb-project-confirm]')!.click())
  expect(document.querySelector('[data-dialog="workbench-create-project"]')).toBeNull()
  expect(document.querySelector('h1')?.textContent).toContain('已有数据')
})


it('browser About uses the workbench version without exposing the inherited Python updater', async () => {
  vi.mocked(isDesktop).mockReturnValue(false)
  await act(async () => useUiStore.getState().setSettingsOpen(true, 'about'))
  expect(document.querySelector('[data-wb-about-version]')?.textContent).toBe('v1.0.5')
  expect(checkButton()).toBeUndefined()
  expect(document.querySelector('[data-update-auto]')).toBeNull()
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/update/'))).toBe(false)
})
