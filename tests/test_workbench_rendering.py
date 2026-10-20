import time

import pytest

from tavotto.workbench.examples import EXAMPLES, example_snapshot
from tavotto.workbench.rendering import RenderService, executable_code
from tavotto.workbench.store import WorkbenchError, WorkbenchStore


def wait_job(service, job_id):
    deadline = time.monotonic() + 65
    while time.monotonic() < deadline:
        job = service.job(job_id)
        if job["status"] != "running":
            return job
        time.sleep(0.05)
    raise AssertionError("job did not settle")


def test_validated_run_can_save_and_export_three_formats(tmp_path):
    store = WorkbenchStore(tmp_path / "data")
    service = RenderService(store, tmp_path / "jobs")
    project = store.create_project("P")
    plot = store.create_plot(project["id"], "F")
    example = EXAMPLES[1]
    job_id = service.render(
        {"code": example["code"], "data": example_snapshot(example), "schema": example["schema"]},
        plot["id"],
    )
    result = wait_job(service, job_id)
    assert result["status"] == "success", result
    saved = service.save_plot(plot["id"], job_id)
    assert saved["revision"] == 1
    for fmt in ("png", "svg", "pdf"):
        assert service.export_path(plot["id"], fmt).stat().st_size > 100


def test_failed_and_obsolete_jobs_cannot_be_saved(tmp_path):
    store = WorkbenchStore(tmp_path / "data")
    service = RenderService(store, tmp_path / "jobs")
    project = store.create_project("P")
    plot = store.create_plot(project["id"], "F")
    payload = {
        "code": "def build_figure(data):\n    raise RuntimeError('specific failure')",
        "data": example_snapshot(EXAMPLES[0]),
        "schema": {},
    }
    job_id = service.render(payload, plot["id"])
    job = wait_job(service, job_id)
    assert job["status"] == "error"
    assert "specific failure" in job["traceback"]
    with pytest.raises(WorkbenchError):
        service.save_plot(plot["id"], job_id)
    assert store.get_plot(plot["id"])["revision"] == 0


def test_cancelled_process_is_reaped(tmp_path):
    store = WorkbenchStore(tmp_path / "data")
    service = RenderService(store, tmp_path / "jobs")
    project = store.create_project("P")
    plot = store.create_plot(project["id"], "F")
    job_id = service.render(
        {
            "code": "import time\ndef build_figure(data):\n    time.sleep(120)",
            "data": example_snapshot(EXAMPLES[0]),
            "schema": {},
        },
        plot["id"],
    )
    service.cancel_job(job_id)
    job = wait_job(service, job_id)
    assert job["status"] == "cancelled"
    proc = service.jobs[job_id].get("process")
    assert proc is None or proc.poll() is not None


def test_generated_code_keeps_readable_base_and_no_recursive_wrapping():
    code = executable_code(
        "def build_figure(data):\n    return None\n",
        [{"gid": "title", "prop": "text", "value": "changed"}],
    )
    compile(code, "figure.py", "exec")
    assert code.count("def build_figure") == 1
    assert "PWB_OVERRIDES" in code
    assert "one_shot" in code
