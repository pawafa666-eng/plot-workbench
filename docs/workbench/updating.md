# Plot Workbench 更新与签名密钥

## 开发与发布边界

本文是 Plot Workbench 版本与发布规则的唯一详细说明。日常修复和功能调整先完成约定范围、运行相关测试，再汇总交付。未经用户明确要求，不递增版本、不创建或推送版本标签、不发布 Release、不分发新安装包；完成一次修改不代表需要发布一个版本。

只有在约定改动全部完成、测试通过且用户明确决定发布后，才确定发行范围和版本号。用户确认准备发行后可以创建标签并构建已验证草稿；草稿核验完毕后，仍须由用户明确决定公开发布。自动工作流不会把草稿公开。

## 使用软件内更新

打开「设置 → 关于与更新 → 检查更新」，按「立即检查」。打开应用或设置页不会访问 GitHub Releases。发现新版后，页面会显示版本和发行说明；按「下载并安装」后才下载，安装前会验证 minisign 签名。失败时当前版本继续可用，可以从本项目的 GitHub Releases 下载常规 Windows 安装程序后覆盖安装。

Windows 更新器的检查和下载均使用支持系统代理发现的 reqwest 客户端实现；可以跟随 Windows 中配置的代理访问 GitHub，无需固定代理端口或修改全局网络设置。连接失败时设置页保留原生错误详情，签名校验与 TLS 验证保持启用。

2026-10-28 按用户要求替换同名 1.2.0 发行包，修复系统代理与错误提示。已安装早先 1.2.0 的用户需手动覆盖安装修正版：同版本号不会被 SemVer 更新检查识别为更高版本。1.1.2 等较早版本可以手动安装修正版；如果旧更新器本身连不上，请使用 Releases 安装包。

## 一次性配置签名密钥

更新包的私钥只能留在维护者本机和 GitHub Actions Secret 中。不要把私钥提交到仓库、上传为构建附件或发到聊天里。丢失私钥后，已安装客户端无法信任新密钥；请离线保留加密备份。

在 Windows PowerShell 中生成密钥。Tauri CLI 会要求输入口令；建议设置口令并妥善保存：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.tauri" | Out-Null
pnpm dlx @tauri-apps/cli@2.11.4 signer generate -w "$env:USERPROFILE\.tauri\plot-workbench.key"
```

命令会生成私钥文件 `plot-workbench.key` 和公钥文件 `plot-workbench.key.pub`。在 GitHub 仓库 Settings → Secrets and variables → Actions 中配置：

| 类型 | 名称 | 内容 |
|---|---|---|
| Repository secret | `TAURI_SIGNING_PRIVATE_KEY` | `plot-workbench.key` 的全部内容 |
| Repository secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 生成密钥时设置的口令；若未设置口令，可不创建此项 |
| Repository variable | `TAURI_UPDATER_PUBLIC_KEY` | Tauri 生成的 `.pub` 文件原始内容（已经是 Base64，不要再次编码） |

复制 Tauri 配置需要的公钥值到剪贴板，再粘贴为 Repository variable：

```powershell
(Get-Content -Raw "$env:USERPROFILE\.tauri\plot-workbench.key.pub").Trim() | Set-Clipboard
```

在 GitHub 仓库 Settings → Secrets and variables → Actions → Variables 中新建 `TAURI_UPDATER_PUBLIC_KEY`，把剪贴板内容粘贴到 Value。普通分支构建中的 updater 配置保持空端点、空公钥且不生成更新包；稳定版构建才注入更新端点和公钥。工作流会用签名和嵌入的公钥核对 key id；不匹配时不会发布。

## 经用户决定后准备发行草稿

Windows 构建门禁包括 Codex 长提示词传输、编码 Agent 和对话工作流的回归测试。

早期 `1.0.0` 安装程序未启用更新器，不能在软件内自查。请先从 Releases 手动下载带更新器的稳定安装包并覆盖安装一次，之后即可在软件内更新。每次发布新版本时，将以下版本保持一致：

- `src/tavotto/engine/brand.py` 的 `WORKBENCH_VERSION`
- `src-tauri/tauri.conf.json` 的 `version`
- `src-tauri/Cargo.toml` 的包版本
- `src-tauri/Cargo.lock` 中 `plot-workbench-desktop` 的包版本

在用户明确同意发行范围与版本号后，提交一致的版本变更，再创建并推送对应稳定标签。不要为日常修改创建标签。普通分支构建仍运行验证并生成构建附件，不启用 updater，也不创建 Release。

标签触发的 Windows 工作流会运行测试、构建并安装冒烟、验证更新包签名、核对安装包 SHA-256，并生成只含 `windows-x86_64` 的 `latest.json`。只有 `publish-release` job（显示名为 `Prepare verified release draft`）拥有 GitHub 写权限；它创建 **Draft Release**、上传附件，再核对 GitHub 实际返回的附件 URL 与更新清单，成功后保留草稿。标签与应用版本不一致、版本不高于 `1.0.0`、任一密钥缺失、签名无效或资产不完整，都会阻止草稿通过验证。失败后可能留下未通过验证的草稿，不能公开。

保持同一对密钥。更换公钥后，已经安装的版本仍信任旧公钥，不能通过新密钥收到更新；这时需要用户从 Releases 手动下载并安装新版。

GitHub 会把上传文件名中的空格替换为点号；更新清单中的下载地址必须与上传后名称一致，签名对应的压缩包字节保持不变。

## 用户决定后的手动公开

1. 在 GitHub Actions 中确认对应标签的 `Plot Workbench Windows` 工作流与 `Prepare verified release draft` job 全部成功，核对标签、提交和已完成的测试。
2. 在仓库 Releases 中打开该版本草稿，核对发行说明，以及 Windows 安装包、`.sha256`、`.nsis.zip`、`.nsis.zip.sig` 和 `latest.json` 五项附件。保留验证后的附件，修改或替换附件后须重新验证。
3. 将具体版本、发行说明和验证结果交用户审阅；只有用户明确决定公开后，才由维护者在 GitHub 草稿编辑页手动点击 **Publish release**。没有此决定就保留草稿。

公开后的版本才会进入软件内更新检查使用的稳定 Releases 通道。自动流程没有公开发布步骤，也不会自动把草稿标记为 latest。
