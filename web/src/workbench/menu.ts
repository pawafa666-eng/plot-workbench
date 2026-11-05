import { useEffect, useRef } from 'react'
import { onWorkbenchMenu, setWorkbenchMenuEnabled, WORKBENCH_MENU_ACTIONS, type WorkbenchMenuAction } from '@/lib/desktop'
import { runDiscreteAction } from '@/store/gestureCoordinator'
import { runUndoRedo, runZoomCommand } from '@/hooks/useKeyboard'

// Each editor command activates its existing button, including its disabled state
// and verified save path. Native menus must never write a second document model.
const BUTTONS: Partial<Record<WorkbenchMenuAction, string>> = {
  'menu-save': '[data-wb-save], [data-wb-template-save], [data-palette-save], [data-wb-tavotto-finish]',
  'menu-run': '[data-wb-run], [data-wb-template-validate]',
  'menu-export': '[data-wb-export]',
}
const ZOOM = { 'menu-zoom-in': 'in', 'menu-zoom-out': 'out', 'menu-zoom-actual': 'actual', 'menu-zoom-fit': 'fit' } as const

function editorButton(action: WorkbenchMenuAction) {
  const selector = BUTTONS[action]
  return selector ? document.querySelector<HTMLButtonElement>(selector) : null
}
function modalOpen() { return !!document.querySelector('[data-dialog][data-state="open"]') }
function textFocused() {
  const target = document.activeElement
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)
}
export function menuActionEnabled(action: WorkbenchMenuAction, canCreatePlot: boolean) {
  if (action === 'menu-settings' || action === 'menu-about' || action === 'menu-check-updates' || action === 'menu-diagnostics' || action === 'menu-shortcut-help') return true
  if ((action === 'menu-undo' || action === 'menu-redo') && textFocused()) return true
  if (modalOpen()) return false
  if (action === 'menu-new-plot') return canCreatePlot
  if (action in BUTTONS) { const button = editorButton(action); return !!button && !button.disabled }
  if (action === 'menu-undo' || action === 'menu-redo') {
    const button = document.querySelector<HTMLButtonElement>(action === 'menu-undo' ? '[data-wb-undo]' : '[data-wb-redo]')
    return !!button && !button.disabled
  }
  if (action in ZOOM) return !!document.querySelector('[data-wb-tavotto]') && !document.querySelector('.wb-tavotto-body.wb-locked')
  return true
}

export function performEditorMenuAction(action: WorkbenchMenuAction): boolean {
  if (action in BUTTONS) {
    if (menuActionEnabled(action, false)) runDiscreteAction('app', document.activeElement, () => editorButton(action)?.click())
    return true
  }
  if (action === 'menu-undo' || action === 'menu-redo') {
    if (menuActionEnabled(action, false)) runDiscreteAction('canvas', document.activeElement,
      () => runUndoRedo(action === 'menu-redo'),
      () => document.execCommand(action === 'menu-redo' ? 'redo' : 'undo'))
    return true
  }
  if (action in ZOOM) {
    if (menuActionEnabled(action, false)) runDiscreteAction('canvas', document.activeElement, () => runZoomCommand(ZOOM[action as keyof typeof ZOOM]))
    return true
  }
  return false
}

const KEYS: Record<string, WorkbenchMenuAction> = {
  o: 'menu-open-project', s: 'menu-save', e: 'menu-export', Enter: 'menu-run',
  ',': 'menu-settings', '=': 'menu-zoom-in', '+': 'menu-zoom-in', '-': 'menu-zoom-out', '0': 'menu-zoom-actual', '1': 'menu-zoom-fit',
}

export function useWorkbenchMenu(canCreatePlot: boolean, onAction: (action: WorkbenchMenuAction) => void) {
  const current = useRef({ canCreatePlot, onAction })
  current.current = { canCreatePlot, onAction }
  useEffect(() => {
    let disposed = false, stop: (() => void) | undefined
    const dispatch = (action: WorkbenchMenuAction) => {
      if (!menuActionEnabled(action, current.current.canCreatePlot)) return
      if (performEditorMenuAction(action)) return
      runDiscreteAction('app', document.activeElement, () => current.current.onAction(action))
    }
    void onWorkbenchMenu(dispatch).then((unlisten) => { if (disposed) unlisten(); else stop = unlisten })
    // Serialized updates ensure a slow invoke cannot overwrite a newer menu state.
    let previous = '', pending = Promise.resolve()
    const sync = () => {
      const enabled = WORKBENCH_MENU_ACTIONS.filter((action) => menuActionEnabled(action, current.current.canCreatePlot))
      const signature = enabled.join(',')
      if (signature === previous) return
      previous = signature
      pending = pending.then(async () => { if (!disposed) await setWorkbenchMenuEnabled(enabled) })
    }
    const refresh = () => { previous = ''; sync() }
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'data-state'] })
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey || (event.shiftKey && event.key !== '+')) return
      const action = KEYS[event.key.length === 1 ? event.key.toLowerCase() : event.key]
      if (!action) return
      if ((action in ZOOM) && (textFocused() || modalOpen())) return
      event.preventDefault()
      dispatch(action)
    }
    document.addEventListener('focusin', sync); document.addEventListener('focusout', sync)
    window.addEventListener('workbench:menu-refresh', refresh)
    window.addEventListener('keydown', keyboard)
    sync()
    return () => { disposed = true; stop?.(); observer.disconnect(); document.removeEventListener('focusin', sync); document.removeEventListener('focusout', sync); window.removeEventListener('workbench:menu-refresh', refresh); window.removeEventListener('keydown', keyboard) }
  }, [])
}
