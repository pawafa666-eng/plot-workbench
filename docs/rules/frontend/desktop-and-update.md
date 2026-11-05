# 桌面感知与更新

> 原文出自 `web/AGENTS.md`「桌面感知与更新」（2026-09-17 指导文档治理时迁出）；
> Plot Workbench 的手动更新要求于 2026-10-21 加入。这里是这一主题规则的**唯一全文**；
> `web/AGENTS.md` 只留速查行。改规则改这里，并同步那一行。

- **前端唯一桌面感知点是 `web/src/lib/desktop.ts`**：组件不得直接 import
  `@tauri-apps/*`；每个能力都有浏览器回退（vitest 看护）。菜单事件 id 与
  `src-tauri/src/main.rs` 严格同源（`tavotto:menu`）。
- **菜单转发只有一个分派点 `hooks/menuActions.ts` 的 `runMenuAction()`**（2026-09-26）：
  每一条都落到键盘 / 顶栏 / 命令面板 / 属性页已经在调的那个函数上，不新增能力。
  菜单加速键可能先于 keydown 截获按键（Windows 一定如此），所以挂了加速键的几条与
  `useKeyboard` 问**同一个**让位判据 `yieldsCanvasShortcuts()`——焦点在输入框 / 对话框里
  时 ⌘D / ⌘0 / ⌘1 / ⌘± 什么都不做，⌘S 照存。不带修饰键的前端键位（Delete、?、工具字母）
  **不挂**菜单加速键：挂上等于输入框里打不了那个字。看护 `hooks/menuActions.test.tsx`
  （逐键比「按键」与「菜单转发」的效果，画布那一格必须真的有效果）。
- **Plot Workbench 桌面版只手动检查**：应用启动不调用 updater；打开桌面设置不触发
  `checkDesktop()`；菜单项只导航到「设置 → 关于与隐私」。只有设置页「立即检查」按钮
  才访问 Tauri updater endpoint，检查结果显示在当前设置页。恢复入口由同一页的 Releases
  链接提供。`App.tsx` 不挂载 `UpdateNoticeDialog`。
- 工作台根组件挂载同一个 `SettingsDialog`，顶栏提供设置入口；应用设置、更新与诊断菜单
  不要求先打开上游画布项目，仍统一交给 `runMenuAction()` 分派。
- 桌面壳使用 Tauri updater，浏览器/Python 的 `/api/update/*` 是另一通道；桌面模式后端
  仍应禁用 Python updater。壳侧签名、release-only 配置和权限细节见 `src-tauri/AGENTS.md`。

## 速查表原要点（2026-09-25 迁入，#608）

`web/AGENTS.md` 那一行的「必守要点」从这天起只留索引（Codex 自动拼接的 32 KiB 上限，#608）。
下面是当时写在那一格、而本文上面没有逐字出现的要点，原文照搬、一字未改；
它们与上文同等有效，改规则时一并改这里。

- 每个版本只问一次、让位给更急的框
