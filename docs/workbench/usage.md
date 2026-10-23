# 绘图工作台使用说明

Plot Workbench 是在本机运行的科研绘图工作台。Windows x64 安装包自带 Python、Matplotlib、pandas、seaborn、openpyxl 和 xlrd；绘图与 Excel 读取无需另装 Python。

## 创建和保存项目

首次启动先选择工作空间目录，再新建项目。项目保存源数据的工作副本、表格选择、绘图代码及输出；请把整个项目文件夹一起备份或移动。原始导入文件不会被修改。项目、图和模板删除后先进入工作台回收站，可在回收站恢复。

模板库分为全局模板和项目模板，可分类、移动和收藏；收藏只添加标记。创建图时会复制模板的代码和数据，因此修改原模板不会改动已有的图。

## 选择数据

导入 CSV、XLSX 或 XLS 文件。Excel 可选择工作表；CSV 可选择编码与分隔符。行和列分别添加一个或多个范围：编号从 **1** 开始，包含起止位置，多个范围按添加顺序拼接。重叠、重复、越界和反向范围会被拒绝。

**0 至 0** 表示全部。`0` 只能用于第一个范围的起点或最后一个范围的终点，分别表示第一行／列或最后一行／列。例如行 `1–5、7–9` 配合列 `1–2、4–4`，得到 **8 行 × 3 列**。「所选第一行作为表头」会提取第一行作为列名，该行不计入绘图尺寸。

预览最多显示 **50 行 × 50 列**，该限制不会截断实际导入的数据。需要调整方向时，可交换指定行、交换指定列或转置。转置后的表头及索引随数据一起保存。

数值、空值和日期按各自类型处理；非数值内容或无效选区会显示错误。先检查预览中的表头、首末行和缺失值，再确认列映射。

## 绘图与导出

在模板中调整列映射、标题、坐标轴、配色、尺寸和字体。模板按行列数量和列类型匹配数据；模板编辑器的绘图入口为 `build_figure(data)`，返回 Matplotlib Figure，可选 `example_data()` 提供 pandas DataFrame 示例。

修改代码或数据后需要重新运行并保存成功，才能导出当前版本；旧预览会明确标记。运行可取消，超过 60 秒会停止。可导出 **600 dpi PNG、矢量 SVG 或 PDF**，以及可复现的 Python 脚本和数据快照。替换同名导出代码前会备份，模板源目录受到保护。

代码导出包附带数据快照、`environment.json`、`requirements.txt` 和运行说明。请保留脚本旁的配套目录。软件内使用内置环境运行；软件外运行需要匹配的 Python 和依赖，Tavotto 编辑后的脚本还需要对应 Tavotto 引擎。

高级编辑器使用继承自 Tavotto 的画布和渲染引擎。脚本写回沿用 prepare → verify → commit 校验；失败时不替换原脚本。**首次成功完成 Tavotto 编辑后，该图转为 Tavotto 编辑模式**，其基础代码、数据和模板固定，后续通过 Tavotto 调整。若要换基础数据或重新改代码，请新建一张图。

## 文件位置与隐私

Windows 配置保存在 `%APPDATA%\PlotWorkbench`，缓存和日志保存在 `%LOCALAPPDATA%\PlotWorkbench`；项目文件保存在你选定的目录。安装、卸载工作台不会覆盖既有 Tavotto 的配置。

本分支关闭遥测和 Tavotto 官方更新检查。数据与绘图在本机处理。若你主动选用自己的 Python 环境，该环境仍需具备脚本使用的依赖；内置环境不会自动安装未知包。

## 安装与构建

从 [GitHub Releases](https://github.com/pawafa666-eng/plot-workbench/releases/latest) 下载 Windows x64 的 `Setup.exe`，双击安装，完成后从开始菜单启动 **Plot Workbench**。卸载使用 Windows「已安装的应用」。更新包使用 minisign 签名；安装程序目前没有 Windows Authenticode 发布者证书。

检查新版本时，点击工作台右上角齿轮「设置」，在「关于与隐私 → 检查更新」中按「立即检查」。也可使用原生菜单进入该页。启动软件和打开设置页都不会自动检查。发现新版本后可确认下载并安装，安装前验证更新签名；安装完成后重启软件。早期 1.0.0 用户需要手动覆盖安装一次带更新器的版本。

开发构建运行 `python scripts/workbench_build.py`。完整 Windows 构建需要 Python 打包依赖、pnpm、Rust 与 MSVC/Windows SDK；仓库的 **Plot Workbench Windows** GitHub Actions 使用 Windows runner 构建，验证安装、运行与卸载后才上传安装包。

## 开源与来源

本项目基于 [Tavotto v0.18.0](https://github.com/Tavotto/Tavotto)，保留其作者署名、AGPL-3.0-only 许可、安全边界和渲染协议。修改后的完整源码见 [Plot Workbench](https://github.com/pawafa666-eng/plot-workbench)，上游基准提交为 `71c72fdb48f28411bd76a021e5d78d2005e76c8a`。安装包包含 LICENSE 和 ATTRIBUTION.txt。
