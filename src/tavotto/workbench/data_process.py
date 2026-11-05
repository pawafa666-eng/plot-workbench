"""Run dataframe-dependent table operations in the selected Python child."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

from tavotto.engine import atomicio, config, pool, runtime

from .data import _encode_cell
from .store import WorkbenchError, read_json


def run_operation(operation, *, table=None, **parameters):
    root = config.data_dir() / "workbench-data-jobs"
    root.mkdir(parents=True, exist_ok=True)
    module_root = Path(__file__).resolve().parent
    request = {"operation": operation, "data_helper": str(module_root / "data.py"), **parameters}
    if table is not None:
        request["table"] = {
            "rows": [[_encode_cell(cell) for cell in row] for row in table.rows],
            "source": table.source,
        }
    with tempfile.TemporaryDirectory(prefix="table-", dir=root) as temporary:
        directory = Path(temporary)
        atomicio.write_json(directory / "input.json", request)
        python, source = pool.resolve_worker_python(str(directory), discover=False)
        bundled = source == pool.SOURCE_BUNDLED
        env = runtime.probe_env(python, bundled=bundled)
        env = os.environ.copy() if env is None else env
        env.update(PYTHONIOENCODING="utf-8", TAVOTTO_NO_TELEMETRY="1")
        try:
            with (directory / "output.log").open("wb") as output:
                result = subprocess.run(
                    [
                        python,
                        *runtime.probe_args(bundled=bundled),
                        str(module_root / "runner.py"),
                        str(directory),
                    ],
                    stdin=subprocess.DEVNULL,
                    stdout=output,
                    stderr=subprocess.STDOUT,
                    cwd=directory,
                    env=env,
                    timeout=60,
                    creationflags=runtime.CREATE_NO_WINDOW,
                    check=False,
                )
        except subprocess.TimeoutExpired:
            raise WorkbenchError("表格处理超过 60 秒，进程已停止", "data_timeout", 408) from None
        if result.returncode:
            report = read_json(directory / "error.json", {})
            raise ValueError(report.get("error", "表格处理进程运行失败"))
        return json.loads((directory / "result.json").read_text("utf-8"))
