import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { SHELL_HEIGHT, SHELL_WIDTH } from '@/components/SettingsDialog'
import { CodingAgentsSection } from '@/components/settings/CodingAgentsSection'
import { DiagnosticsExportButton, PrivacyBlock } from '@/components/settings/PrivacyAboutSettings'
import { SettingRow, SettingSection } from '@/components/settings/SettingRow'
import { DesktopUpdateSettings } from '@/components/settings/UpdateSettings'
import { PRODUCT_NAME, REPO_URL, UPSTREAM_URL } from '@/lib/brand'
import { revealProjectFolder, isDesktop } from '@/lib/desktop'
import { useUiStore } from '@/store/uiStore'
import { cn } from '@/lib/utils'
import type { Project, Status } from './api'

const SECTIONS = [
  ['general', '工作台'], ['ai', 'Codex 助手'], ['diagnostics', '诊断与隐私'], ['about', '关于与更新'],
] as const
type Section = typeof SECTIONS[number][0]

export function WorkbenchSettings({ status, project, onChangeRoot, onHelp }: {
  status: Status | null; project: Project | null; onChangeRoot: () => void; onHelp: () => void
}) {
  const open = useUiStore((s) => s.settingsOpen)
  const requested = useUiStore((s) => s.settingsSection)
  const setOpen = useUiStore((s) => s.setSettingsOpen)
  const [section, setSection] = useState<Section>('general')
  const content = useRef<HTMLDivElement>(null)
  const nav = useRef<HTMLElement>(null)
  const [pathError, setPathError] = useState('')
  useEffect(() => {
    if (open) setSection(SECTIONS.some(([id]) => id === requested) ? requested as Section : 'general')
  }, [open, requested])
  useLayoutEffect(() => { if (content.current) content.current.scrollTop = 0 }, [section])
  if (!open) return null
  const closeThen = (action: () => void) => { setOpen(false); action() }
  const onNavKey = (event: KeyboardEvent<HTMLElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = SECTIONS.findIndex(([id]) => id === section)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? SECTIONS.length - 1 : (index + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) + SECTIONS.length) % SECTIONS.length
    setSection(SECTIONS[next][0]); nav.current?.querySelector<HTMLButtonElement>(`[data-section="${SECTIONS[next][0]}"]`)?.focus()
  }
  return <Dialog open onOpenChange={setOpen} title={`${PRODUCT_NAME} 设置`} width={SHELL_WIDTH} height={SHELL_HEIGHT} chrome="shell" anchor="workbench-settings">
    <div data-settings-shell data-wb-settings-shell className="flex h-full min-h-0 flex-col sm:flex-row">
      <nav ref={nav} aria-label="设置分区" onKeyDown={onNavKey} className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 py-3 sm:w-48 sm:flex-col sm:border-b-0 sm:border-r">
        {SECTIONS.map(([id, label]) => <button type="button" key={id} data-section={id} onClick={() => setSection(id)} aria-current={section === id || undefined} tabIndex={section === id ? 0 : -1} className={cn('h-7 shrink-0 whitespace-nowrap rounded-sm px-2 text-left text-sm outline-none focus-visible:focus-ring', section === id ? 'bg-selected font-medium text-ink' : 'text-ink-2 hover:bg-surface-hover')}>{label}</button>)}
      </nav>
      <div ref={content} data-settings-content className="mb-2 min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-5 [scrollbar-gutter:stable]">
        <div className="flex max-w-[640px] flex-col gap-7">
          {section === 'general' && <>
            <SettingSection title="项目与模板库">
              <SettingRow label="模板库目录" description={status?.root ?? '正在读取…'}><Button variant="secondary" disabled={!status} onClick={() => closeThen(onChangeRoot)} data-wb-settings-root>更换目录…</Button></SettingRow>
              {project && <SettingRow label="当前项目文件夹" description={project.path}>{isDesktop() && <Button variant="secondary" onClick={async () => { setPathError(await revealProjectFolder(project.path) ? '' : `无法打开文件管理器，请手动打开：${project.path}`) }}>在文件管理器中显示</Button>}</SettingRow>}
              {pathError && <p role="alert" className="type-caption text-danger">{pathError}</p>}
            </SettingSection>
            <SettingSection title="使用帮助"><SettingRow label="项目、模板、配色与图内编辑"><Button variant="secondary" onClick={() => closeThen(onHelp)}>查看使用说明</Button></SettingRow></SettingSection>
            <p className="type-caption">图、代码与数据保存在各自的项目文件夹；全局模板和配色保存在模板库目录。更换模板库目录后可随时切回。</p>
          </>}
          {section === 'ai' && <CodingAgentsSection workbench />}
          {section === 'diagnostics' && <>
            <SettingSection title="问题诊断" description="诊断包会先脱敏，再保存到本机。可在报告问题时自行附上。"><div className="flex flex-wrap items-center gap-3"><DiagnosticsExportButton /></div></SettingSection>
            <PrivacyBlock />
          </>}
          {section === 'about' && <>
            <div><h2 className="type-title">{PRODUCT_NAME}{status?.version && <span data-wb-about-version className="ml-2 font-mono text-sm font-normal text-ink-2">v{status.version}</span>}</h2><p className="type-caption mt-1">本地科研绘图工作台 · 项目、模板、数据与图内编辑</p><a href={REPO_URL} target="_blank" rel="noreferrer" className="type-caption underline underline-offset-2">项目源码与问题反馈</a></div>
            {isDesktop() ? <DesktopUpdateSettings currentVersion={status?.version ?? ''} releasesUrl={`${REPO_URL}/releases`} /> : <SettingSection title="软件更新"><p className="type-caption">请在桌面版的“关于与更新”中手动检查并安装更新。</p><a href={`${REPO_URL}/releases`} target="_blank" rel="noreferrer" className="type-caption mt-2 underline underline-offset-2">查看工作台版本</a></SettingSection>}
            <details data-wb-attribution><summary className="cursor-pointer text-sm text-ink-2">开源许可与致谢</summary><div className="type-caption mt-3 flex flex-col gap-2"><p>{PRODUCT_NAME} 基于 <a href={UPSTREAM_URL} target="_blank" rel="noreferrer" className="underline">Tavotto v0.18.0</a>，遵循 AGPL-3.0-only 许可证。保留原作者署名，完整许可与归属信息见随附 LICENSE 和 ATTRIBUTION.txt。</p><p>上游基准提交：<code className="break-all">71c72fdb48f28411bd76a021e5d78d2005e76c8a</code></p></div></details>
          </>}
        </div>
      </div>
    </div>
  </Dialog>
}

export function WorkbenchHelp({ onClose }: { onClose: () => void }) {
  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }} title={`${PRODUCT_NAME} 使用帮助`} width={700} anchor="workbench-help">
    <div className="flex flex-col gap-5 text-sm text-ink-2">
      <SettingSection title="绘图流程"><ol className="list-decimal space-y-2 pl-5"><li>新建项目或打开项目文件夹，在项目中新建图。</li><li>输入或导入 Python 代码，选择模板、导入数据后运行。运行成功后保存，修改代码或数据后需重新运行。</li><li>保存后的图可导出 PNG、SVG、PDF，以及 Python 代码与数据包。</li><li>进入图内编辑可直接调整文字、图例、线条和坐标轴；点击“完成并保存”验证写回。</li></ol></SettingSection>
      <SettingSection title="模板与配色"><p>在模板库创建或导入模板，运行并验证后保存。配色表可保存常用色组，在图内编辑的颜色控件中复用。删除的项目、图和模板可在回收站恢复。</p></SettingSection>
      <SettingSection title="快捷键"><dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-2"><dt>Ctrl / ⌘ + O</dt><dd>打开项目文件夹</dd><dt>Ctrl / ⌘ + Enter</dt><dd>运行图 / 验证模板</dd><dt>Ctrl / ⌘ + S</dt><dd>保存当前图、模板或配色；图内编辑时完成并保存</dd><dt>Ctrl / ⌘ + E</dt><dd>导出已保存的图</dd><dt>Ctrl / ⌘ + Z / Shift + Z</dt><dd>文本或图内编辑的撤销 / 重做</dd><dt>Ctrl / ⌘ + + / − / 0 / 1</dt><dd>图内编辑：放大 / 缩小 / 实际大小 / 适应画布</dd><dt>Ctrl / ⌘ + ,</dt><dd>打开工作台设置</dd></dl></SettingSection>
      <p className="type-caption">菜单按当前页面显示可用状态。未运行或验证的修改需先运行；对话框打开时，后台编辑操作会暂停。</p>
    </div>
  </Dialog>
}
