import time
import uuid

import pytest

from tavotto.workbench.examples import EXAMPLES, example_snapshot
from tavotto.workbench.history import restore_copy
from tavotto.workbench.recovery import DraftStore
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


def test_durable_canvas_recovery_and_history_copy_use_full_verification(tmp_path, monkeypatch):
    monkeypatch.setenv("TAVOTTO_DATA_DIR", str(tmp_path / "state"))
    store = WorkbenchStore(tmp_path / "library")
    service = RenderService(store, tmp_path / "jobs")
    project = store.create_project("恢复测试")
    plot = store.create_plot(project["id"], "恢复图")
    code = "import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.plot([1,2], [3,4])\n"
    run = service.render({"code": code, "data": None, "schema": {}}, plot["id"])
    assert _wait(service, run)["status"] == "success"
    saved = service.save_plot(plot["id"], run)
    patches = [{"gid": "axes_0.xlabel", "prop": "text", "value": "Recovered"}]
    drafts = DraftStore(store.root)
    draft_id = uuid.uuid4().hex
    drafts.save(
        draft_id,
        {
            "kind": "canvas",
            "entity_id": plot["id"],
            "project_id": project["id"],
            "name": "恢复图",
            "base_revision": saved["revision"],
            "generation": 0,
            "content": {
                "patches": patches,
                "code": code + "ax.set_ylabel('Candidate')\n",
                "stem": "figure",
            },
        },
    )
    service.close()
    restarted = RenderService(store, tmp_path / "restart-jobs")
    try:
        restored = DraftStore(store.root).get(draft_id)
        assert not restarted.jobs and not restarted.sessions
        assert store.get_plot(plot["id"])["revision"] == saved["revision"]
        session = restarted.open_session(plot["id"], draft=restored)
        assert session["overrides"] == patches
        assert restarted.sessions[session["session_id"]]["code_changed"]
        committed = restarted.finish_session(session["session_id"], patches)
        assert committed["revision"] == saved["revision"] + 1
        assert committed["overrides"] == patches
        clone = restore_copy(
            store, "plot", plot["id"], committed["revision"], committed["revision"]
        )
        assert clone["validation_state"] == "pending"
        session = restarted.open_session(clone["id"])
        assert restarted.sessions[session["session_id"]]["code_changed"]
        from tavotto import pdfbackend

        head = store.plot_dir(clone["id"]) / "plot.json"
        before = head.read_bytes()
        with monkeypatch.context() as scoped:
            scoped.setattr(pdfbackend, "compare_png", lambda *_: False)
            with pytest.raises(WorkbenchError, match="未保存"):
                restarted.finish_session(session["session_id"], patches)
        assert head.read_bytes() == before
        assert store.get_plot(clone["id"])["validation_state"] == "pending"
        verified = restarted.finish_session(session["session_id"], patches)
        assert "validation_state" not in verified
        assert verified["saved_revision"] == verified["revision"]
        assert store.get_plot(plot["id"])["revision"] == committed["revision"]
    finally:
        restarted.close()
