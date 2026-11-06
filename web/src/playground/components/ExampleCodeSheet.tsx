/**
 * Code Sheet：卡片的「背面」——点「查看代码」后展开成一张大代码页。
 *
 * 完整源码 + 行号 + 复制 + 「用这个案例开始」。**只读**：本轮不做在线代码
 * 编辑器——产品主叙事是直接改 Figure、代码仍是源头；第一屏同时鼓励改代码
 * 会模糊产品差异（PLAYGROUND_V2.md §三）。
 *
 * 可访问性走既有 Dialog（Radix）：焦点圈定、Esc 关闭、关闭后焦点回到打开它
 * 的按钮。行号放在 aria-hidden + select-none 的独立列里——屏幕阅读器读到的
 * 与复制到剪贴板的都只有代码本身。打开它**不触发任何 Pyodide 加载**。
 */
import { Play } from '@/components/ui/icons'
import { ICON_SIZE } from '@/components/ui/Icon'
import { Dialog } from '@/components/ui/Dialog'
import type { PlaygroundExample } from '../examples'
import { pg } from '../pgText'
import { CodeBlock } from '@/components/ui/CodeBlock'

//: 技术名词，语言中立，不进翻译（与 runtime 包名同一口径）
const CODE_DEPS = ['NumPy', 'Matplotlib'].join(' · ')

export function ExampleCodeSheet({
  example,
  onClose,
  onStart,
}: {
  example: PlaygroundExample | null
  onClose: () => void
  onStart: (example: PlaygroundExample) => void
}) {
  if (!example) return null

  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      size="lg"
      width={640}
      title={<span className="font-mono text-[15px]">{example.filename}</span>}
      description={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span>{pg('codePlain')}</span>
          <span aria-hidden>·</span>
          <span className="font-mono">{CODE_DEPS}</span>
          <span aria-hidden>·</span>
          <span>{pg('codeSelfContained')}</span>
        </span>
      }
      footer={
        <>
          <button
            onClick={() => onStart(example)}
            className="flex h-7 items-center gap-1.5 rounded-sm bg-ink px-3 text-xs font-medium text-white transition-opacity hover:opacity-90"
          >
            <Play size={ICON_SIZE.sm} aria-hidden />
            {pg('codeStart')}
          </button>
        </>
      }
    >
      <CodeBlock code={example.source} title={example.filename} />
    </Dialog>
  )
}
