/** Copy diagnostics without depending on canvas clipboard handlers. */
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return }
  } catch { /* Older WebView permissions can still allow native copy below. */ }
  const active = document.activeElement
  const field = document.createElement('textarea')
  field.value = text; field.readOnly = true
  field.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0'
  document.body.appendChild(field)
  try {
    field.focus(); field.select()
    if (!document.execCommand('copy')) throw new Error('无法访问剪贴板，请选中错误文本手动复制。')
  } finally { field.remove(); if (active instanceof HTMLElement) active.focus({ preventScroll: true }) }
}
