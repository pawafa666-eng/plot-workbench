# Plot Workbench · 绘图工作台

本地科研绘图工具：从 CSV / XLSX / XLS 选择数据区域，设置表头、转置和列映射，使用模板生成 Matplotlib 图表，保存项目并导出图片与脚本。

Windows x64 安装包自带 Python 与 Matplotlib、pandas、seaborn、openpyxl、xlrd，使用时无需另装 Python。配置和缓存使用独立的 PlotWorkbench 目录，关闭遥测与 Tavotto 官方更新。

## 安装和使用

双击经验证的 `Plot-Workbench-1.0.0-Windows-x64-Setup.exe`，完成安装后从开始菜单打开 **Plot Workbench**。新建项目，导入表格，核对数据预览并选择绘图模板。详细步骤见 [使用说明](docs/workbench/usage.md)。

## 开发和构建

在 Windows 上安装 Python、Node/pnpm、Rust 与 MSVC/Windows SDK 后：

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -e ".[worker,workbench]" pyinstaller
pnpm --dir web install --frozen-lockfile
.venv\Scripts\python scripts/workbench_build.py
```

安装包输出到 `dist/Plot-Workbench-1.0.0-Windows-x64-Setup.exe`。也可运行仓库中的 **Plot Workbench Windows** GitHub Actions；只有打包产物通过安装、内置 Python 渲染和卸载检查后才上传 artifact。

用户数据、项目、缓存、导出图与安装包均不进入 Git。

## 来源与许可

本项目是 [Tavotto v0.18.0](https://github.com/Tavotto/Tavotto) 的授权衍生版本，基准提交 `71c72fdb48f28411bd76a021e5d78d2005e76c8a`。感谢 erwanjun 和 Tavotto 贡献者。继承的内部模块、绘图文件格式和 worker 协议继续使用 tavotto 标识。

修改后的完整源码：[pawafa666-eng/plot-workbench](https://github.com/pawafa666-eng/plot-workbench)。本项目继续使用 **AGPL-3.0-only**，见 [LICENSE](LICENSE) 和 [署名说明](docs/workbench/ATTRIBUTION.txt)。Python、科学计算库及字体保留各自许可证。
