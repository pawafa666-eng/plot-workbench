# 绘图工作台使用说明

Plot Workbench 是在本机运行的科研绘图工作台。Windows x64 安装包自带 Python、Matplotlib、pandas、seaborn、openpyxl 和 xlrd；绘图与 Excel 读取无需另装 Python。

## 创建和保存项目

首次启动选择全局模板库目录。新建项目时选择一个已有文件夹作为工作目录，也可通过「打开项目」选择已有项目文件夹。代码中的 `pd.read_excel("data.xlsx")` 等相对路径以此工作目录为准；导入代码时保留其 `__file__` 位置。

工作台生成的清单、数据快照、代码版本、预览与导出集中保存在工作目录的 **`.plot-workbench`** 子文件夹，图片默认导出到其中的 `exports`。原有 Excel、CSV、Python 文件可继续放在原位置。备份或移动时保留整个工作目录，包括 `.plot-workbench`。旧版项目仍可打开。

删除项目只回收工作台所属内容，不移动所选工作目录及其原始文件。旧版外部项目仅取消登记，可在回收站恢复。脚本自行执行的其他文件写入仍按其代码运行；工作台接管 Matplotlib 图片输出，不会替脚本猜测文件路径。

模板库分为全局模板和项目模板，可分类、移动和收藏；收藏只添加标记。创建图时会复制模板的代码和数据，因此修改原模板不会改动已有的图。点击 **在线模板** 打开 [公开模板库](https://github.com/pawafa666-eng/plot-workbench-templates)，浏览预览并复制 Python 代码，再在本地新建模板、粘贴、运行和保存。

## 选择数据

导入 CSV、XLSX 或 XLS 文件。Excel 可选择工作表；CSV 可选择编码与分隔符。行和列分别添加一个或多个范围：编号从 **1** 开始，包含起止位置，多个范围按添加顺序拼接。重叠、重复、越界和反向范围会被拒绝。

**0 至 0** 表示全部。`0` 只能用于第一个范围的起点或最后一个范围的终点，分别表示第一行／列或最后一行／列。例如行 `1–5、7–9` 配合列 `1–2、4–4`，得到 **8 行 × 3 列**。「所选第一行作为表头」会提取第一行作为列名，该行不计入绘图尺寸。

预览最多显示 **50 行 × 50 列**，该限制不会截断实际导入的数据。需要调整方向时，可交换指定行、交换指定列或转置。转置后的表头及索引随数据一起保存。

数值、空值和日期按各自类型处理；非数值内容或无效选区会显示错误。先检查预览中的表头、首末行和缺失值，再确认列映射。

## 绘图与导出

直接粘贴或导入常规 Matplotlib 脚本即可运行，**无需特殊函数**，包括 `if __name__ == "__main__":` 入口。工作台捕获脚本生成的全部 Figure，自动处理 `plt.show()`、`savefig()` 和关闭窗口；同一 Figure 保存为多个格式时不会重复计数。一次生成多张图时，预览上方可切换，保存会保留全部结果，Tavotto 和导出操作作用于当前选中的图。

导入表格后，脚本可直接使用 `data`（pandas.DataFrame）。既有 `build_figure(data)` / `example_data()` 函数式模板继续兼容。模板按声明的行列数量和列类型匹配数据。

修改代码或数据后需要重新运行并保存成功，才能导出当前版本；旧预览会明确标记。运行可取消，超过 60 秒会停止。可导出 **600 dpi PNG、矢量 SVG 或 PDF**，以及可复现的 Python 脚本和数据快照。替换同名导出代码前会备份，模板源目录受到保护。

代码导出包附带原始代码 `original.py`、数据快照、观察到的项目输入文件、`environment.json`、`requirements.txt` 和运行说明。请保留脚本旁的配套目录。普通脚本直接读取的项目文件会保留快照供再次编辑；网络、数据库及原生扩展直接读取等通道不属于 Python 文件观察范围。软件外运行需要匹配的 Python 和依赖，Tavotto 编辑后的脚本还需要对应 Tavotto 引擎。

高级编辑器使用继承自 Tavotto 的画布和渲染引擎。脚本写回沿用 prepare → verify → commit 校验；失败时不替换原脚本。**首次成功完成 Tavotto 编辑后，该图转为 Tavotto 编辑模式**，其基础代码、数据和模板固定，后续通过 Tavotto 调整。若要换基础数据或重新改代码，请新建一张图。

## 文件位置与隐私

Windows 配置保存在 `%APPDATA%\PlotWorkbench`，缓存和日志保存在 `%LOCALAPPDATA%\PlotWorkbench`；项目文件保存在你选定的目录。安装、卸载工作台不会覆盖既有 Tavotto 的配置。

本分支关闭遥测和 Tavotto 官方更新检查。数据与绘图在本机处理。若你主动选用自己的 Python 环境，该环境仍需具备脚本使用的依赖；内置环境不会自动安装未知包。

## 安装与构建

从 [GitHub Releases](https://github.com/pawafa666-eng/plot-workbench/releases/latest) 下载 Windows x64 的 `Setup.exe`，双击安装，完成后从开始菜单启动 **Plot Workbench**。卸载使用 Windows「已安装的应用」。更新包使用 minisign 签名；安装程序目前没有 Windows Authenticode 发布者证书。

检查新版本时，点击工作台右上角齿轮「设置」，在「关于与更新 → 检查更新」中按「立即检查」。也可使用原生菜单进入该页。启动软件和打开设置页都不会自动检查。发现新版本后可确认下载并安装，安装前验证更新签名；安装完成后重启软件。早期 1.0.0 用户需要手动覆盖安装一次带更新器的版本。

开发构建运行 `python scripts/workbench_build.py`。完整 Windows 构建需要 Python 打包依赖、pnpm、Rust 与 MSVC/Windows SDK；仓库的 **Plot Workbench Windows** GitHub Actions 使用 Windows runner 构建，验证安装、运行与卸载后才上传安装包。

## 开源与来源

本项目基于 [Tavotto v0.18.0](https://github.com/Tavotto/Tavotto)，保留其作者署名、AGPL-3.0-only 许可、安全边界和渲染协议。修改后的完整源码见 [Plot Workbench](https://github.com/pawafa666-eng/plot-workbench)，上游基准提交为 `71c72fdb48f28411bd76a021e5d78d2005e76c8a`。安装包包含 LICENSE 和 ATTRIBUTION.txt。
