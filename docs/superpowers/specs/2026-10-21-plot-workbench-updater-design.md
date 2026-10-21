# Plot Workbench 手动更新设计

日期：2026-10-21

状态：用户已批准，实施中

适用范围：Plot Workbench Windows x64 桌面版

## 目标

安装后的用户可以在「设置 → 检查更新」里手动查询 Plot Workbench 自己的 GitHub Releases。发现新版后，界面显示版本号和发行说明；用户确认后，软件下载并安装更新。Tauri updater 在安装前校验 minisign 签名。检查失败、离线或签名无效时，当前安装继续可用并显示错误。

应用启动和打开设置页都不访问更新服务器。没有定时检查、后台下载或静默安装。稳定更新只从 `pawafa666-eng/plot-workbench` 的正式 GitHub Release 提供，不读取 Tavotto 上游发布源。

## 当前实现基线

- `web/src/lib/desktop.ts` 已封装桌面版检查、下载、安装和重启调用，`UpdateSettings.tsx` 已有桌面更新界面与进度状态。
- `web/src/App.tsx` 调用 `checkUpdateOnStartup()`；设置组件也会在装载时自动检查，因此需要收敛为明确的手动检查。
- `src-tauri/Cargo.toml` 尚未注册 `tauri-plugin-updater`；`tauri.conf.json` 关闭了更新包生成且没有 updater endpoint/public key。
- `scripts/workbench_build.py::validate_packaging` 当前拒绝更新器配置；`.github/workflows/workbench-build.yml` 只保留 30 天的构建 artifact，没有发布 GitHub Release 的步骤。
- Plot Workbench 是 Windows x64 首发。本文不启用 macOS、Linux 或浏览器/Python 更新通道。

## 用户流程

1. 用户打开「设置 → 检查更新」。页面显示当前版本和上一次检查时间；打开页面本身不联网。
2. 用户按「立即检查」。工作台只请求配置的 Plot Workbench 更新端点。
3. 没有新版时显示“截至本次检查没有更新”；离线、请求失败、manifest 无效时显示可读错误和手动 Releases 下载入口。
4. 有新版时显示版本、发行说明和「下载并安装」按钮。下载时显示进度；用户按下按钮前不下载更新包。
5. 下载包由 Tauri updater 按内置公钥验签。验签失败或安装失败时保留当前安装并显示错误，不提供跳过签名的选项。
6. 安装成功后按 Tauri 的 Windows NSIS 更新流程切换到新版，并清楚显示安装与重启状态。更新过程不触碰项目、数据、模板和导出目录。

“手动检查”是唯一检查入口：删除启动时的 `checkUpdateOnStartup()` 更新网络行为，并移除桌面设置组件装载时调用 `checkDesktop()` 的 effect。桌面设置不显示自动检查开关。首次查询前必须显示未知状态，不把“尚未查询”说成“已是最新”。

## 更新源与发布资产

- Tauri updater endpoint 固定为 `https://github.com/pawafa666-eng/plot-workbench/releases/latest/download/latest.json`，经 HTTPS 获取公开静态清单。
- 首发仅支持 `windows-x86_64`。每个稳定版 Release 至少附带：
  - 常规 NSIS 安装包 `Plot-Workbench-<version>-Windows-x64-Setup.exe`，供新用户及手动恢复安装；
  - Tauri NSIS updater archive（`.nsis.zip`）及对应 `.sig`；
  - 更新清单 `latest.json`；
  - 安装包 SHA-256 文件。
- `latest.json` 的 `windows-x86_64` 项引用该 Release 中的 updater archive，并内嵌 `.sig` 文件文本；它不引用普通安装程序或外部 Tavotto 资产。清单中的版本、资产名、平台键及签名由构建产物生成，不手工复制旧值。
- 正式版本使用严格递增的 SemVer tag（例如 `v1.0.1`）。正式 Release 由该 tag 构建并发布；普通分支构建仍只上传临时 artifact，不创建或覆盖正式 Release。草稿和 prerelease 不作为稳定更新源。
- 发布 job 在安装冒烟、签名、manifest schema/资产校验均成功后才创建或更新 Release。发布权限只授予该 job 的 `contents: write`；其他 job 保持只读。缺少签名密钥、更新 archive、签名或有效 manifest 时，发布失败，不发布一个会让客户端误判为最新的残缺 Release。
- 当前 1.0.0 安装包构建于 Tauri updater 接入之前，无法自查更新。首个带更新器的稳定版必须高于 1.0.0（例如 1.0.1）；用户需要先从 Releases 手动安装这一版，之后才能在软件内检查并安装后续版本。

## 签名密钥与信任边界

- 采用 Tauri updater 的 minisign 签名。稳定版构建从 GitHub Actions Variable `TAURI_UPDATER_PUBLIC_KEY` 读取 Base64 编码的完整公钥文件，经 Tauri CLI 配置覆盖注入并编入应用；普通构建只保留空端点和空公钥。私钥由仓库维护者单独生成，只存放在 GitHub Actions Secret `TAURI_SIGNING_PRIVATE_KEY`，口令（如使用）存入 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
- 私钥不得进入 Git、构建 artifact、Release、日志或对话。仓库文档只说明如何生成密钥、设置 Secret、确认公钥和轮换密钥，不记录私钥值。
- 公钥一旦随正式版本发布，后续更新必须由对应私钥签名。私钥丢失或泄露时不能静默更换已安装客户端信任的公钥；需要单独规划用旧密钥签发迁移版本，若旧密钥不可用则以手动安装新版本恢复。
- HTTPS 保护传输；Tauri updater 的 minisign 校验是安装授权的最终门槛。TLS、GitHub Release 的 SHA-256 校验和不代替签名校验。
- 更新能力只作用于应用安装目录，不读取或上传用户项目内容、图表代码、数据表、模板或本机路径。

## 实施边界

1. 在 Tauri 壳注册 Rust updater 插件及其最小前端权限；稳定版构建启用 updater artifacts，并把唯一的 Plot Workbench Releases endpoint 和公钥注入最终配置；继续使用已有的 `desktop.ts` 桥接，React 组件不直接导入 Tauri 插件。
2. 调整更新状态与设置页：移除启动检查、装载时检查和桌面自动检查偏好；保留手动检查、检查时间、版本/发行说明、进度、失败状态和恢复链接。只在桌面工作台中启用该自更新能力。
3. 修改 `scripts/workbench_build.py` 的打包校验：允许且校验 Plot Workbench 自有 updater 配置；本地或分支构建可在没有私钥时只打普通安装包，正式 tag 发布则必须有签名密钥并产出签名更新 archive。
4. 扩展 Windows 工作流：以稳定版本 tag 为 Release 输入；构建、运行现有后端/前端测试、打包并在无系统 Python 的环境安装冒烟；签名 updater archive；生成并校验清单；最后发布 Release assets。
5. 增加更新设置说明和维护者发布说明，解释首个更新版本、签名密钥准备、版本号/tag 对齐、失败回退和手动安装方式。

现有项目、模板、数据格式、Python 绘图执行、Tavotto 编辑流程和 AGPL 来源说明不在此次更新功能改造范围内。仓库不保存用户数据或生成的用户图表。

## 验收标准

- 启动应用、停留在主界面、打开设置页均不请求 Release manifest；只有点击「立即检查」才请求。
- 点击检查可区分“未知”“已检查且没有新版”“发现新版”和“检查失败”，并使用本次实际检查时间。
- 测试 Release manifest 可正确解析 `windows-x86_64`、发行说明、直链和签名；缺字段、错误平台、无签名或悬空资产会阻止发布。
- 构建的 updater artifact 签名可由配置的公钥验证；损坏签名或错误签名的包不能安装。
- 没有新版、离线、404、GitHub 限流、下载中断、签名不匹配和安装失败都保留当前应用可用，并提供明确错误或手动下载路径。
- 用户确认之前不下载；确认后显示下载进度；成功更新后启动版本与目标 SemVer 一致。
- 更新前后用户选定的数据目录和项目文件不变；更新 workflow 不将这些内容上传为 artifact。
- 普通分支构建仍可生成首次安装包；无签名密钥的正式 Release 不发布任何可被客户端当作有效更新的清单。

## 参考

- [Tauri v2 updater 插件文档](https://v2.tauri.app/plugin/updater/)：签名配置、Windows NSIS updater archive、静态 GitHub Release manifest 和平台键。
- [Tauri updater JavaScript API](https://v2.tauri.app/reference/javascript/updater/)：检查返回值、下载进度及安装行为。
