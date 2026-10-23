import subprocess
import sys

import pytest

from tavotto.workbench.rendering import RenderService
from tavotto.workbench.store import WorkbenchStore
from test_workbench_rendering import wait_job


def test_ordinary_script_captures_closed_and_live_figures_without_polluting_folder(tmp_path):
    folder = tmp_path / "research"
    folder.mkdir()
    (folder / "measurements.csv").write_text("x,y\n1,3\n2,5\n", "utf-8")
    store = WorkbenchStore(tmp_path / "library")
    project = store.create_project("Research", path=folder)
    plot = store.create_plot(project["id"], "All figures")
    service = RenderService(store, tmp_path / "jobs")
    code = """import argparse
import io
import pandas as pd
import matplotlib.pyplot as plt

def main():
    argparse.ArgumentParser().parse_args()
    table = pd.read_csv("measurements.csv")
    first, ax = plt.subplots(figsize=(2, 2))
    ax.plot(table.x, table.y)
    first.savefig("unwanted.pdf")
    first.savefig("unwanted.png")
    buffer = io.BytesIO()
    first.savefig(buffer, format="png")
    assert len(buffer.getvalue()) > 100
    plt.close(first)
    second, ax = plt.subplots(figsize=(2, 2))
    ax.bar(table.x, table.y)
    plt.show()

if __name__ == "__main__":
    main()
"""
    job_id = service.render({"code": code, "data": None, "schema": {}}, plot["id"])
    job = wait_job(service, job_id)
    assert job["status"] == "success", job
    assert [item["stem"] for item in job["result"]["outputs"]] == ["figure", "figure_2"]
    saved = service.save_plot(plot["id"], job_id)
    assert len(saved["outputs"]) == 2
    for stem in ("figure", "figure_2"):
        for fmt in ("png", "svg", "pdf"):
            assert service.export_path(plot["id"], fmt, stem).stat().st_size > 100
    assert {path.name for path in folder.iterdir()} == {"measurements.csv", ".plot-workbench"}
    with pytest.raises(ValueError):
        service.export_path(plot["id"], "png", "../measurements")
    service.close()


def test_plain_script_export_package_runs_without_special_function(tmp_path):
    store = WorkbenchStore(tmp_path / "library")
    project = store.create_project("P")
    plot = store.create_plot(project["id"], "Plain")
    service = RenderService(store, tmp_path / "jobs")
    job_id = service.render(
        {
            "code": "import matplotlib.pyplot as plt\ndef build_figure():\n    raise RuntimeError('unused function')\nif __name__ == '__main__':\n    plt.plot([1, 2], [3, 4])\n",
            "schema": {},
        },
        plot["id"],
    )
    assert wait_job(service, job_id)["status"] == "success"
    service.save_plot(plot["id"], job_id)
    exported = service.export_code(plot["id"], tmp_path / "export")
    result = subprocess.run([sys.executable, exported["path"]], capture_output=True, timeout=60)
    assert result.returncode == 0, result.stderr.decode("utf-8", "replace")
    assert list((tmp_path / "export").glob("*.png"))
    service.close()


def test_multi_figure_tavotto_edits_are_independent_and_replay_frozen_inputs(tmp_path):
    folder = tmp_path / "folder"
    folder.mkdir()
    values = folder / "values.csv"
    values.write_text("1,2\n3,4\n", "utf-8")
    store = WorkbenchStore(tmp_path / "library")
    project = store.create_project("P", path=folder)
    plot = store.create_plot(project["id"], "Two")
    service = RenderService(store, tmp_path / "jobs")
    code = """import numpy as np
import matplotlib.pyplot as plt
values = np.loadtxt("values.csv", delimiter=",")
for column in range(2):
    fig, ax = plt.subplots(figsize=(2, 2))
    ax.plot(values[:, column])
    ax.set_xlabel("Original")
    ax.set_title(f"Sample {values[0, column]}")
"""
    job_id = service.render({"code": code, "schema": {}}, plot["id"])
    job = wait_job(service, job_id)
    assert job["status"] == "success", job
    saved = service.save_plot(plot["id"], job_id)
    assert saved["input_files"][0]["path"] == "values.csv"
    untouched = service.export_path(plot["id"], "png", "figure").read_bytes()
    values.write_text("100,200\n300,400\n", "utf-8")
    first = service.open_session(plot["id"], "figure_2")
    assert "Sample 2.0" in first["svg"]
    patch = {"gid": "axes_0.xlabel", "prop": "text", "value": "Second edited"}
    locked = service.finish_session(first["session_id"], [patch])
    assert locked["state"] == "TAVOTTO_ONLY"
    assert locked["output_overrides"]["figure_2"] == [patch]
    assert service.export_path(plot["id"], "png", "figure").read_bytes() == untouched
    restarted = RenderService(store, tmp_path / "restarted")
    second = restarted.open_session(plot["id"], "figure_2")
    assert second["overrides"] == [patch]
    restarted.cancel_session(second["session_id"])
    second_image = restarted.export_path(plot["id"], "png", "figure_2").read_bytes()
    edit_first = restarted.open_session(plot["id"], "figure")
    first_patch = {"gid": "axes_0.ylabel", "prop": "text", "value": "First edited"}
    final = restarted.finish_session(edit_first["session_id"], [first_patch])
    assert final["output_overrides"]["figure"] == [first_patch]
    assert final["output_overrides"]["figure_2"] == [patch]
    assert restarted.export_path(plot["id"], "png", "figure_2").read_bytes() == second_image
    exported = restarted.export_code(plot["id"], tmp_path / "export")
    result = subprocess.run([sys.executable, exported["path"]], capture_output=True, timeout=60)
    assert result.returncode == 0, result.stderr.decode("utf-8", "replace")
    assert len(list((tmp_path / "export").glob("*.png"))) == 2
    service.close()
    restarted.close()
