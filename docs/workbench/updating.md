# Plot Workbench 更新与签名密钥

## 使用软件内更新

打开「设置 → 关于与隐私 → 检查更新」，按「立即检查」。打开应用或设置页不会访问 GitHub Releases。发现新版后，页面会显示版本和发行说明；按「下载并安装」后才下载，安装前会验证 minisign 签名。失败时当前版本继续可用，可以从本项目的 GitHub Releases 下载常规 Windows 安装程序后覆盖安装。

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
| Repository variable | `TAURI_UPDATER_PUBLIC_KEY` | `.pub` 文件完整内容的 Base64 编码 |

复制 Tauri 配置需要的公钥值到剪贴板，再粘贴为 Repository variable：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\.tauri\plot-workbench.key.pub")) | Set-Clipboard
```

在 GitHub 仓库 Settings → Secrets and variables → Actions → Variables 中新建 `TAURI_UPDATER_PUBLIC_KEY`，把剪贴板内容粘贴到 Value。普通分支构建中的 updater 配置保持空端点、空公钥且不生成更新包；稳定版构建才注入更新端点和公钥。工作流会用签名和嵌入的公钥核对 key id；不匹配时不会发布。

## 发布新版本

仓库当前版本为 `1.0.0`，这版安装程序早于 updater 接入，不能在软件内自查。首个带更新器的稳定版应为 `1.0.1` 或更高；现有用户要先从 Releases 手动下载并覆盖安装一次，之后才可在软件内更新。将以下版本保持一致：

- `src/tavotto/engine/brand.py` 的 `WORKBENCH_VERSION`
- `src-tauri/tauri.conf.json` 的 `version`
- `src-tauri/Cargo.toml` 的包版本

提交版本变更后创建同名稳定标签，例如 `v1.0.1`，并推送该标签。Windows 工作流会运行测试、构建并安装冒烟、验证更新包签名、生成只含 `windows-x86_64` 的 `latest.json`，再由只有发布 job 拥有的 GitHub 写权限创建 Release。标签与应用版本不一致、版本不高于 `1.0.0`、任一密钥缺失、签名无效或资产不完整，都会阻止发布。

保持同一对密钥。更换公钥后，已经安装的版本仍信任旧公钥，不能通过新密钥收到更新；这时需要用户从 Releases 手动下载并安装新版。
