import time

import pytest

from tavotto.workbench.examples import EXAMPLES, example_snapshot
from tavotto.workbench.rendering import RenderService
from tavotto.workbench.store import WorkbenchError, WorkbenchStore


def _wait(service, job_id):
    deadline = time.monotonic() + 65
    while time.monotonic() < deadline:
        job = service.job(job_id)
        if job["status"] != "running":
            return job
        time.sleep(0.05)
    raise AssertionError("job did not settle")


def test_tavotto_first_and_repeated_edit_replay_and_lock_the_plot(tmp_path):
    store = WorkbenchStore(tmp_path / "data")
    service = RenderService(store, tmp_path / "jobs")
    project = store.create_project("P")
    plot = store.create_plot(project["id"], "Bar")
    example = EXAMPLES[1]
    job_id = service.render(
        {"code": example["code"], "data": example_snapshot(example), "schema": example["schema"]},
        plot["id"],
    )
    assert _wait(service, job_id)["status"] == "success"
    service.save_plot(plot["id"], job_id)
    first = service.open_session(plot["id"])
    try:
        assert first["manifest"]["size_mm"][0] > 0
        assert isinstance(first.get("svg"), str)
        assert first["script"] == "adapter.py"
        base_patch = {"gid": "axes_0.xlabel", "prop": "text", "value": "Category"}
        response = service.session_render(first["session_id"], [base_patch])
        assert response["manifest"]
        locked = service.finish_session(first["session_id"], [base_patch])
        assert locked["state"] == "TAVOTTO_ONLY"
        assert locked["source"]["kind"] == "external"
        assert locked["source"]["via"] == "tavotto"
        assert locked["overrides"] == [base_patch]
        assert "PWB_OVERRIDES" in locked["code"]
        assert locked["code"].count("def build_figure") == 1
        for fmt in ("png", "svg", "pdf"):
            assert (
                tmp_path
                / "data"
                / "projects"
                / project["id"]
                / "plots"
                / plot["id"]
                / "revisions"
                / "2"
                / f"figure.{fmt}"
            ).is_file()

        # A process restart reopens the same plot and sends original base code plus
        # the complete edit history, never the generated replay wrapper as new base.
        restarted = RenderService(store, tmp_path / "jobs-after-restart")
        second = restarted.open_session(plot["id"])
        try:
            assert second["overrides"] == [base_patch]
            extra_patch = {"gid": "axes_0.ylabel", "prop": "text", "value": "Measurement"}
            complete_history = [base_patch, extra_patch]
            persisted = restarted.finish_session(second["session_id"], complete_history)
            assert persisted["state"] == "TAVOTTO_ONLY"
            assert persisted["overrides"] == complete_history
            assert persisted["code"].count("def build_figure") == 1
            assert persisted["base_code"] == example["code"]
            with pytest.raises(WorkbenchError, match="Tavotto 专用"):
                store.assert_editable(plot["id"])
        finally:
            restarted.close()
    finally:
        service.close()
