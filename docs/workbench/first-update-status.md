# 第一批更新实施与验收记录

目标：完成 three-update-plan.md 第一批全部六项交付与验收场景，验证后发布 1.3.5。

## 交付审计

| 要求 | 状态 | 完成证据 |
| --- | --- | --- |
| 程序、库、项目的位置展示、打开与安装检查 | 已实现 | StoragePanel.tsx、storage_locations；发行版核对登记路径和版本 |
| 目标库预览、切换与可回退迁移 | 已验证 | test_workbench_workspace.py；真实界面取消、迁移、携带草稿与切回原库 |
| 代码、数据、图内编辑的持久草稿与恢复 | 已验证 | DraftStore 与 Recovery.tsx；CAS、跨进程重开、图内代码/patch 重放用例 |
| 统一编辑状态与禁用原因 | 已实现 | 草稿等待/保存/冲突，未运行、运行中、待保存、已保存、历史预览待验证 |
| 历史浏览、比较与恢复为新版本/副本 | 已验证 | HistoryPanel.tsx、history.py；真实模板历史对比与待验证副本；原件保持 |
| 首页检索、缩略图、时间、列表/卡片 | 已验证 | ProjectHome.tsx、WorkspacePanels.test.tsx；按修改时间排序、路径搜索 |
| 侧栏折叠、画布中心布局、数据/代码展开、密度 | 已实现 | 布局与偏好持久化；桌面门禁覆盖折叠、紧凑模式、代码/画布切换 |
| 异常退出后恢复，不自动执行或视为验证通过 | 已验证 | 独立服务强制退出重启后 UI 恢复；未运行、保存置灰；显式运行后保存 |
| 100%、125%、150% 与窄窗口交互 | 已验证 | 三档真实安装版 WebView2、1000×720 响应式检查通过；工具栏、属性栏、设置、历史与导航切库均过门禁 |
| 现有项目、分享包、认证与正式保存校验兼容 | 已验证 | 全部 workbench 后端、浏览器认证与更新清单回归；前端 137 项通过；Windows 索引同步修复后相关 83 项回归通过 |
| 普通 Explorer 环境的安装/升级及数据保持 | 已验证 | 本机 1.3.4 → 1.3.5 原自选目录更新，安装器退出 0；窗口和 sidecar 就绪；启动后七项原有数据清单 SHA-256 不变，无默认目录第二份程序 |
| 签名构建、五项附件及公开 1.3.5 更新通道 | 已验证并发布 | 五个实际下载附件、安装器 SHA-256、更新归档与安装器一致、minisign 加密验证及旧版密钥连续性、公开 latest.json 均通过 |

本记录中的“待实现/待验证”必须由对应实现和实际验收证据替换后，才能认定目标完成。

## 验证边界与反证

- 草稿只保存 JSON，不运行代码，也不生成正式 revision；历史恢复为独立待验证副本。显式图内恢复仍走全输出热/冷重放、几何和像素比较。
- 手工变异已验证：跳过草稿 CAS、允许未验证历史图导出、跳过历史副本像素门，三项针对性用例均失败；源文件恢复后回归通过。
- 增加两个并发反证：移除索引读写同步会复现 Windows 拒绝替换文件；允许迟到的显示设置覆盖新选择会使侧栏状态测试失败。均已还原保护并复测。
- 图内页面导航离开时先保存草稿、再关闭后台会话；后续切库等待关闭完成，失败可重试。Codex 对话持有的原图会话保留至返回或丢弃。对应单元测试、移除关闭操作的反证，以及三档缩放下导航离开后切库/切回均通过。
- 横向溢出只使用 `web/e2e/overflow.ts`。画布世界坐标层允许平移缩放，其零尺寸原点不适用 HTML 布局溢出判据；图内工具栏、属性栏使用该尺，裁切视口另做窗口内包含检查。
- 本机诊断、隔离项目与截图位于 `D:\download\plot-workbench-first-update`；发行签名、附件和公开通道证明单独保存。用户项目和 `styles/` 未纳入提交。
- 发行版的三档缩放由测试进程显式传入 `--edge-webview-switches`，每档使用独立 WebView profile；应用正常启动参数保持不变。Wry 设置的 SDK 参数会覆盖环境变量，首次发行验收因此拒绝通过；改用 [WebView2 官方宿主参数](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2environmentoptions) 后，已在本机现有正式桌面版上验证 CDP、125% 实际像素比例和隔离数据目录。

## 发行证明

- [1.3.5 已公开发布](https://github.com/pawafa666-eng/plot-workbench/releases/tag/v1.3.5)，发行代码提交：`095b6f6838fb05b6998e4508faf7e82b300873b3`。
- [发行构建与真实安装验收](https://github.com/pawafa666-eng/plot-workbench/actions/runs/41990247644) 两项 job 均成功；包含 1.3.1 → 1.3.5 的中文自选目录升级、缺失历史缓存复现与修复、三档界面缩放、实际渲染与卸载。
- 安装器 SHA-256：`0ae7b26b68357049b785e2bade1a7b0081ff8da79f758e326b2877419d08e196`。
- 普通桌面验证从 `explorer.exe` 启动，更新后程序为 1.3.5，前端构建为 `index-CsRTcDci`；安装前后及正常启动后的数据索引保持一致。
- 本机证明文件位于 `D:\download\plot-workbench-release\1.3.5`：`verification.json`、`native-verification.json`、`ordinary-desktop-update-verified.json`、`ordinary-health-verified.json`、`published-endpoint-verified.json`。这些生成文件和用户路径不加入 Git。
