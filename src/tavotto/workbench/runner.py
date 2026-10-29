"""Standalone scientific subprocess. Never imported by the Flask parent."""

from __future__ import annotations

import importlib.util
import json
import platform
import shutil
import sys
import traceback
from pathlib import Path
from types import SimpleNamespace


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

    # Reuse the safe engine worker itself: its file guards are installed before
    # user execution. The helper only collects figures and cannot relax guards.
    engine = Path(__file__).resolve().parents[1] / "engine"
    worker_module = load_module(engine / "worker.py", "_pwb_safe_worker")
    adapter = directory / "adapter.py"
    helper_path = str(directory / "execution.py")
    adapter.write_text(
        "import importlib.util, json\nfrom pathlib import Path\n"
        f"_ROOT = Path({str(directory)!r})\n"
        f"_SPEC = importlib.util.spec_from_file_location('_pwb_execution', {helper_path!r})\n"
        "_HELPER = importlib.util.module_from_spec(_SPEC)\n"
        "_SPEC.loader.exec_module(_HELPER)\n"
        "def main():\n"
        "    global PWB_RESULT\n"
        "    context = json.loads((_ROOT / 'input.json').read_text('utf-8'))\n"
        "    PWB_RESULT = _HELPER.capture(context, directory=_ROOT)\n",
        "utf-8",
    )
    worker = worker_module.Worker(
        SimpleNamespace(
            script=str(adapter),
            figures_dir=context.get("working_directory") or str(directory),
            out_dir=str(directory / "engine"),
            sandbox=str(directory / "sandbox"),
            cwd=context.get("working_directory") or str(directory),
            entry="main",
            preview_dpi=150,
        )
    )
    worker.build()
    outputs, snapshot = sys.modules["adapter"].PWB_RESULT
    with matplotlib.rc_context({"pdf.fonttype": 42, "ps.fonttype": 42, "svg.fonttype": "none"}):
        for output in outputs:
            fig = worker.session.capture[output["stem"]]
            for fmt in ("png", "svg", "pdf"):
                worker_module._REAL_SAVEFIG(
                    fig,
                    directory / f"{output['stem']}.{fmt}",
                    format=fmt,
                    dpi=600,
                    bbox_inches="tight",
                    pad_inches=0,
                    bbox_extra_artists=getattr(fig, "_pwb_extra_artists", ()),
                )
    # Persist observed project inputs, not the original workbook's future state.
    # The engine observation reports its known blind channels explicitly.
    inputs = worker._inputs_report or {}
    input_files = []
    project_root = Path(context.get("working_directory") or directory).resolve()
    (directory / "inputs").mkdir(exist_ok=True)
    for item in inputs.get("files", []) + inputs.get("local_modules", []):
        relative = Path(item["path"])
        source = (project_root / relative).resolve()
        if (
            not source.is_relative_to(project_root)
            or source.is_relative_to(directory)
            or ".plot-workbench" in relative.parts
            or not source.is_file()
        ):
            continue
        if source.stat().st_size > 128 * 1024 * 1024:
            raise ValueError(f"脚本输入超过 128 MB，无法保存快照：{relative}")
        target = directory / "inputs" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        input_files.append({"path": relative.as_posix(), "sha256": item.get("sha256")})
    result = {
        "data": snapshot,
        "schema": context.get("schema") or {},
        "dpi": 600,
        "outputs": outputs,
        "input_files": input_files,
        "input_observation": {
            k: v for k, v in inputs.items() if k not in ("files", "local_modules")
        },
    }
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
    with open(directory / "result.json", "w", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, allow_nan=False)
    plt.close("all")


if __name__ == "__main__":
    job_directory = sys.argv[1]
    try:
        run(job_directory)
    except BaseException as error:
        report = {"error": str(error), "traceback": traceback.format_exc()[-65536:]}
        with open(Path(job_directory) / "error.json", "w", encoding="utf-8") as stream:
            json.dump(report, stream, ensure_ascii=False)
        sys.exit(1)
