"""Child-only Matplotlib script execution, shared by render and cold replay.

This module is loaded inside the safe engine worker, after its deletion and
write guards are installed. It never enables savefig passthrough.
"""

from __future__ import annotations

import ast
import builtins
import importlib.util
import io
import os
import sys
from pathlib import Path


def execute(
    code,
    snapshot,
    schema,
    *,
    working_directory,
    source_path=None,
    data_helper,
    input_directory=None,
    input_files=(),
    original_directory=None,
    legacy_template=False,
):
    import matplotlib.pyplot as plt
    from matplotlib.figure import Figure

    spec = importlib.util.spec_from_file_location("_pwb_data", data_helper)
    helper = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = helper
    spec.loader.exec_module(helper)
    tree = ast.parse(code)
    structured = any(
        isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "build_figure"
        for node in tree.body
    )
    root = Path(working_directory).resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"项目工作目录不存在：{root}")
    filename = str(Path(source_path).resolve()) if source_path else str(root / "plot.py")
    namespace = {
        "__name__": "_pwb_user_plot" if legacy_template else "__main__",
        "__file__": filename,
        "__package__": None,
    }
    if snapshot is not None:
        issues = helper.validate_schema(snapshot, schema)
        if issues:
            raise ValueError("；".join(issue["message"] for issue in issues))
        namespace["data"] = helper.dataframe_from_snapshot(snapshot)
    figures = []
    identities = set()

    def remember(figure):
        if isinstance(figure, Figure) and id(figure) not in identities:
            identities.add(id(figure))
            figures.append(figure)

    original_init, original_save, original_show = Figure.__init__, Figure.savefig, plt.show
    real_open, real_io_open = builtins.open, io.open
    remaps = {}
    if input_directory:
        for item in input_files:
            relative = Path(item["path"])
            destination = (Path(input_directory) / relative).resolve()
            if not destination.is_relative_to(Path(input_directory).resolve()):
                raise ValueError("数据快照路径无效")
            original = Path(original_directory or root) / relative
            remaps[os.path.normcase(str(original.resolve()))] = str(destination)

    def mapped(file, mode):
        if isinstance(file, (str, os.PathLike)) and not any(c in mode for c in "wax+"):
            key = os.path.normcase(str(Path(file).resolve()))
            return remaps.get(key, file)
        return file

    def redirected(real):
        def read(file, mode="r", *args, **kwargs):
            return real(mapped(file, mode), mode, *args, **kwargs)

        return read

    # NumPy caches its file openers before Python's open wrappers are installed.
    # Redirect at the same DataSource boundary used by the engine's observer.
    datasource = getattr(sys.modules.get("numpy.lib._datasource"), "DataSource", None)
    real_ds_open = getattr(datasource, "open", None)

    def datasource_open(instance, path, mode="r", *args, **kwargs):
        return real_ds_open(instance, mapped(path, mode), mode, *args, **kwargs)

    def create(figure, *args, **kwargs):
        original_init(figure, *args, **kwargs)
        remember(figure)

    def save(figure, filename=None, *args, **kwargs):
        remember(figure)
        extras = kwargs.get("bbox_extra_artists")
        if extras:
            figure._pwb_extra_artists = tuple(extras)
        if not isinstance(filename, (str, bytes, os.PathLike)):
            return original_save(figure, filename, *args, **kwargs)
        return None

    before_cwd, before_argv, before_path = Path.cwd(), sys.argv, list(sys.path)
    Figure.__init__, Figure.savefig = create, save
    plt.show = lambda *_args, **_kwargs: None
    builtins.open, io.open = redirected(real_open), redirected(real_io_open)
    if real_ds_open is not None:
        datasource.open = datasource_open
    try:
        os.chdir(root)
        sys.argv = [filename]
        sys.path[:0] = ([str(input_directory)] if input_directory else []) + [
            str(Path(filename).parent),
            str(root),
        ]
        try:
            exec(compile(tree, filename, "exec"), namespace)
        except SystemExit as error:
            if error.code not in (None, 0):
                raise RuntimeError(f"脚本退出，状态码：{error.code}") from error
        # Function-only v1 templates remain compatible. A normal script takes
        # precedence, even if it happens to define a function with that name.
        if structured and not figures:
            if snapshot is None:
                example = namespace.get("example_data")
                if not callable(example):
                    raise ValueError("此模板需要数据，请导入表格或提供 example_data()")
                snapshot = helper.snapshot_from_dataframe(example())
            issues = helper.validate_schema(snapshot, schema)
            if issues:
                raise ValueError("；".join(issue["message"] for issue in issues))
            figure = namespace["build_figure"](helper.dataframe_from_snapshot(snapshot))
            if not isinstance(figure, Figure):
                raise TypeError("build_figure(data) 必须返回 Figure（Axes 请返回 ax.figure）")
            remember(figure)
        if not figures:
            raise ValueError("脚本未生成 Matplotlib 图，请检查绘图代码")
        # Hold references to closed figures too; multiple savefig calls for one
        # Figure never create duplicate outputs. No pyplot fallback limit here.
        return figures, snapshot
    finally:
        Figure.__init__, Figure.savefig, plt.show = original_init, original_save, original_show
        builtins.open, io.open = real_open, real_io_open
        if real_ds_open is not None:
            datasource.open = real_ds_open
        os.chdir(before_cwd)
        sys.argv, sys.path[:] = before_argv, before_path


def capture(context, *, directory):
    """Register deterministic Workbench stems with the existing safe worker."""
    directory = Path(directory)
    code = (directory / "base.py").read_text("utf-8")
    figures, snapshot = execute(
        code,
        context.get("data"),
        context.get("schema") or {},
        working_directory=context.get("working_directory") or directory,
        source_path=context.get("original_path"),
        data_helper=context["data_helper"],
        input_directory=context.get("input_directory"),
        input_files=context.get("input_files", []),
        original_directory=context.get("original_directory"),
        legacy_template=context.get("legacy_template", False),
    )
    outputs = []
    for index, figure in enumerate(figures):
        stem = "figure" if index == 0 else f"figure_{index + 1}"
        title = figure.get_label() or (figure._suptitle.get_text() if figure._suptitle else "")
        outputs.append({"stem": stem, "title": title or f"图 {index + 1}"})
        # This reaches the safe worker's interception, never the real disk.
        figure.savefig(
            directory / f"{stem}.pdf",
            bbox_inches="tight",
            pad_inches=0,
            bbox_extra_artists=getattr(figure, "_pwb_extra_artists", ()),
        )
    return outputs, snapshot
