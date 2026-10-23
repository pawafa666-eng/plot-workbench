"""Standalone scientific subprocess. Never imported by the Flask parent."""

from __future__ import annotations

import importlib.util
import json
import platform
import sys
import traceback
from pathlib import Path


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def run(directory):
    directory = Path(directory).resolve()
    context = json.loads((directory / "input.json").read_text("utf-8"))
    data_module = load_module(context["data_helper"], "pwb_snapshot_data")
    if "operation" in context:
        operation = context["operation"]
        if operation in ("inspect", "select"):
            stored = context["table"]
            table = data_module.ParsedTable(
                rows=[[data_module._decode_cell(cell) for cell in row] for row in stored["rows"]],
                source=stored["source"],
            )
            if operation == "inspect":
                result = data_module.inspect_table(table)
            else:
                result = data_module.select_data(
                    table, context["rows"], context["columns"], context.get("header", False)
                )
        elif operation == "transform":
            result = data_module.transform_data(
                context["data"], context["transform"], context.get("i"), context.get("j")
            )
        else:
            raise ValueError("Unknown table operation")
        (directory / "result.json").write_text(
            json.dumps(result, ensure_ascii=False, allow_nan=False), "utf-8"
        )
        return
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.figure import Figure

    source = load_module(directory / "base.py", "pwb_user_plot")
    if not callable(getattr(source, "build_figure", None)):
        raise ValueError("代码必须提供 build_figure(data) 函数，并返回一个 Figure")
    snapshot = context.get("data")
    if snapshot is None:
        example = getattr(source, "example_data", None)
        if not callable(example):
            raise ValueError("请导入示例表格，或在代码中提供 example_data()")
        snapshot = data_module.snapshot_from_dataframe(example())
    issues = data_module.validate_schema(snapshot, context.get("schema") or {})
    if issues:
        raise ValueError("；".join(issue["message"] for issue in issues))
    frame = data_module.dataframe_from_snapshot(snapshot)
    fig = source.build_figure(frame)
    if not isinstance(fig, Figure):
        raise TypeError(
            "build_figure(data) 必须返回 matplotlib.figure.Figure（Axes 请返回 ax.figure）"
        )
    if len(plt.get_fignums()) > 1:
        raise ValueError("一个子图只能返回一个 Figure，请关闭额外创建的 Figure")
    with matplotlib.rc_context({"pdf.fonttype": 42, "ps.fonttype": 42, "svg.fonttype": "none"}):
        for fmt in ("png", "svg", "pdf"):
            fig.savefig(
                directory / f"figure.{fmt}", format=fmt, dpi=600, bbox_inches="tight", pad_inches=0
            )
    result = {"data": snapshot, "schema": context.get("schema") or {}, "dpi": 600}
    from importlib import metadata

    packages = {}
    for distribution in (
        "matplotlib",
        "numpy",
        "pandas",
        "seaborn",
        "scipy",
        "pillow",
        "openpyxl",
        "xlrd",
        "tavotto",
    ):
        try:
            packages[distribution] = metadata.version(distribution)
        except metadata.PackageNotFoundError:
            continue
    result["environment"] = {
        "python": platform.python_version(),
        "implementation": platform.python_implementation(),
        "packages": packages,
    }
    (directory / "result.json").write_text(
        json.dumps(result, ensure_ascii=False, allow_nan=False), "utf-8"
    )
    plt.close("all")


if __name__ == "__main__":
    try:
        run(sys.argv[1])
    except BaseException as error:
        report = {"error": str(error), "traceback": traceback.format_exc()[-65536:]}
        (Path(sys.argv[1]) / "error.json").write_text(
            json.dumps(report, ensure_ascii=False), "utf-8"
        )
        sys.exit(1)
