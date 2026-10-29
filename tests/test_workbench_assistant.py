"""Codex works on copies; applying a result remains an explicit editor action."""

import threading
import time
from pathlib import Path

import pytest
from flask import Flask

from tavotto.engine import ai_bridge
from tavotto.workbench.api import WorkbenchManager, create_blueprint
from tavotto.workbench.assistant import AssistantService
from tavotto.workbench.rendering import RenderService
from tavotto.workbench.store import WorkbenchError, WorkbenchStore

ORIGINAL = "import matplotlib.pyplot as plt\nplt.plot([1, 2])\n"
CHANGED = ORIGINAL + "plt.title('Codex proposal')\n"


@pytest.fixture
def bridge(monkeypatch):
    sessions = {}
    calls = []

    def run(**kwargs):
        sid = f"cli-{len(calls)}"
        calls.append(kwargs)
        path = Path(kwargs["figures_dir"]) / kwargs["script"]
        kwargs["initial_code"] = path.read_text("utf-8")
        path.write_text(CHANGED, encoding="utf-8")
        sessions[sid] = {
            "status": "done",
            "changed": True,
            "diff": "+plt.title('Codex proposal')",
            "transcript": [{"kind": "message", "text": "已修改标题。"}],
        }
        return sid

    monkeypatch.setattr(ai_bridge, "run", run)
    monkeypatch.setattr(ai_bridge, "get", sessions.get)
    monkeypatch.setattr(ai_bridge, "cancel", lambda sid: sessions[sid].update(status="cancelled"))
    monkeypatch.setattr(ai_bridge, "script_busy", lambda path: False)
    return calls, sessions


def test_codex_only_edits_a_copy_and_context_excludes_table_values(tmp_path, bridge):
    original = tmp_path / "original.py"
    original.write_text(ORIGINAL, "utf-8")
    service = AssistantService(tmp_path / "assistant")
    task = service.start(
        code=ORIGINAL,
        prompt="修改标题",
        schema={"description": "x, y"},
        data_context={
            "columns": ["x", "y"],
            "dtypes": ["int64", "float64"],
            "row_count": 3,
            "column_count": 2,
            "values": [[9123456789]],
            "source": {"path": "private-data.xlsx"},
        },
    )
    result = service.poll(task["id"])
    assert result["status"] == "done"
    assert result["code"] == CHANGED
    assert original.read_text("utf-8") == ORIGINAL
    call = bridge[0][0]
    assert call["agent"] == "codex"
    assert Path(call["figures_dir"]).is_relative_to(tmp_path / "assistant")
    assert "9123456789" not in call["user_prompt"]
    assert "private-data.xlsx" not in call["user_prompt"]
    assert "x" in call["user_prompt"] and "3" in call["user_prompt"]
    assert "model" not in call or call["model"] is None


def test_cancelled_failed_and_invalid_results_cannot_be_applied(tmp_path, bridge):
    service = AssistantService(tmp_path / "assistant")
    task = service.start(code=ORIGINAL, prompt="修改")
    service.cancel(task["id"])
    assert service.poll(task["id"])["status"] == "cancelled"
    with pytest.raises(WorkbenchError):
        service.proposal(task["id"])
    task = service.start(code=ORIGINAL, prompt="修改")
    call = bridge[0][-1]
    (Path(call["figures_dir"]) / call["script"]).write_text("def broken(:", "utf-8")
    assert service.poll(task["id"])["status"] == "failed"
    with pytest.raises(WorkbenchError):
        service.proposal(task["id"])
    bridge[1]["cli-1"]["status"] = "failed"
    with pytest.raises(WorkbenchError):
        service.proposal(task["id"])


def test_chat_history_and_reply_support_followup_on_the_staged_proposal(tmp_path, bridge):
    service = AssistantService(tmp_path / "assistant")
    first = service.start(code=ORIGINAL, prompt="修改标题", owner="a", token="v1")
    followup = service.start(
        code=ORIGINAL,
        prompt="保留标题，解释一下",
        history=[
            {"role": "user", "text": "修改标题"},
            {"role": "assistant", "text": "已修改标题。"},
        ],
        parent_id=first["id"],
        owner="a",
        token="v1",
    )
    assert bridge[0][-1]["initial_code"] == CHANGED
    assert "已修改标题。" in bridge[0][-1]["user_prompt"]
    result = service.poll(followup["id"])
    assert result["reply"] == "已修改标题。"
    assert result["changed"] is True
    assert "plt.title('Codex proposal')" in result["diff"]
    assert service.proposal(followup["id"], owner="a", token="v1") == CHANGED


@pytest.mark.parametrize(
    "changes",
    [{"owner": "other", "token": "v1"}, {"owner": "a", "token": "v2"}],
)
def test_chat_parent_rejects_other_editors_and_stale_context(tmp_path, bridge, changes):
    service = AssistantService(tmp_path / "assistant")
    first = service.start(code=ORIGINAL, prompt="修改", owner="a", token="v1")
    with pytest.raises(WorkbenchError):
        service.start(code=ORIGINAL, prompt="继续", parent_id=first["id"], **changes)
    assert len(bridge[0]) == 1


def test_chat_parent_rejects_changed_template_source(tmp_path, bridge):
    service = AssistantService(tmp_path / "assistant")
    first = service.start(code=ORIGINAL, prompt="修改")
    with pytest.raises(WorkbenchError):
        service.start(code=ORIGINAL + "# new edit\n", prompt="继续", parent_id=first["id"])
    assert len(bridge[0]) == 1


def test_chat_parent_rejects_changed_data_structure(tmp_path, bridge):
    service = AssistantService(tmp_path / "assistant")
    first = service.start(code=ORIGINAL, prompt="修改", data_context={"columns": ["a"]})
    with pytest.raises(WorkbenchError):
        service.start(
            code=ORIGINAL, prompt="继续", parent_id=first["id"], data_context={"columns": ["b"]}
        )
    assert len(bridge[0]) == 1


@pytest.mark.parametrize(
    "history",
    [
        "wrong",
        [{"role": "system", "text": "bad"}],
        [{"role": "user", "text": 3}],
        [{"role": "user", "text": "x"}] * 25,
        [{"role": "user", "text": "中" * 22000}],
    ],
)
def test_chat_history_is_bounded_and_validated(tmp_path, bridge, history):
    with pytest.raises(WorkbenchError):
        AssistantService(tmp_path / "assistant").start(
            code=ORIGINAL, prompt="继续", history=history
        )
    assert not bridge[0]


def test_a_normal_chat_reply_can_succeed_without_modifying_code(tmp_path, bridge):
    service = AssistantService(tmp_path / "assistant")
    task = service.start(code=ORIGINAL, prompt="你好，先不要修改")
    call = bridge[0][-1]
    (Path(call["figures_dir"]) / call["script"]).write_text(ORIGINAL, "utf-8")
    bridge[1]["cli-0"]["transcript"] = [{"kind": "message", "text": "你好！你想怎样调整这张图？"}]
    result = service.poll(task["id"])
    assert result["status"] == "done" and result["changed"] is False
    assert result["reply"] == "你好！你想怎样调整这张图？"
    assert result["diff"] == ""


def test_classified_dictionary_model_error_keeps_actionable_diagnosis(tmp_path, bridge):
    service = AssistantService(tmp_path / "assistant")
    task = service.start(code=ORIGINAL, prompt="修改")
    bridge[1]["cli-0"].update(
        status="failed",
        transcript=[
            {
                "kind": "message",
                "text": "{'type': 'invalid_request_error', 'message': 'unsupported model', 'code': 'model_not_found'}",
            }
        ],
    )
    assert "CLI" in service.poll(task["id"])["error"]


def test_service_owns_tasks_and_rejects_results_from_another_session(tmp_path, bridge):
    service = AssistantService(tmp_path / "assistant")
    task = service.start(code=ORIGINAL, prompt="修改", owner="session-a", token="generation-a")
    proposal = service.proposal(task["id"], owner="session-a", token="generation-a")
    assert proposal == CHANGED
    with pytest.raises(WorkbenchError, match="变化"):
        service.proposal(task["id"], owner="session-a", token="generation-b")
    with pytest.raises(WorkbenchError):
        service.proposal(task["id"], owner="session-b", token="generation-a")
    with pytest.raises(WorkbenchError):
        AssistantService(tmp_path / "other").poll(task["id"])


def test_codex_unavailable_is_an_actionable_error(tmp_path, monkeypatch):
    def missing(**kwargs):
        raise ai_bridge.AgentError("ai_agent_not_installed")

    monkeypatch.setattr(ai_bridge, "run", missing)
    with pytest.raises(WorkbenchError, match="Codex") as error:
        AssistantService(tmp_path / "assistant").start(code=ORIGINAL, prompt="修改")
    assert error.value.code == "ai_agent_not_installed"


def test_model_rejection_explains_cli_and_model_choices(tmp_path, bridge):
    service = AssistantService(tmp_path / "assistant")
    task = service.start(code=ORIGINAL, prompt="修改")
    bridge[1]["cli-0"].update(
        status="failed",
        transcript=[
            {
                "kind": "message",
                "text": '{"status":400,"message":"The configured model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}',
            }
        ],
    )
    result = service.poll(task["id"])
    assert result["status"] == "failed"
    assert "模型" in result["error"] and "CLI" in result["error"]
    assert "code" not in result


def test_assistant_routes_start_poll_cancel_and_switch_root_isolation(tmp_path, bridge):
    app = Flask(__name__)
    manager = WorkbenchManager(tmp_path / "library")
    app.register_blueprint(create_blueprint(manager))
    client = app.test_client()
    try:
        response = client.post(
            "/api/workbench/assistant/runs", json={"code": ORIGINAL, "prompt": "修改标题"}
        )
        assert response.status_code == 200
        task = response.get_json()
        result = client.get(f"/api/workbench/assistant/runs/{task['id']}")
        assert result.get_json()["code"] == CHANGED
        assert "figures_dir" not in result.get_json()
        assert client.post(f"/api/workbench/assistant/runs/{task['id']}/cancel").status_code == 200
        manager.switch_root(tmp_path / "another-library")
        assert client.get(f"/api/workbench/assistant/runs/{task['id']}").status_code == 404
    finally:
        manager.close()


def test_tavotto_proposals_preserve_overrides_verify_every_output_and_reopen(
    tmp_path, bridge, monkeypatch
):
    code = (
        "import matplotlib.pyplot as plt\n"
        "fig, ax = plt.subplots(figsize=(4, 3))\n"
        "ax.plot([1, 2], [2, 3])\nax.set_title('Original A')\n"
        "fig2, bx = plt.subplots(figsize=(4, 3))\n"
        "bx.scatter([1, 2], [4, 3])\nbx.set_title('Original B')\n"
    )
    changed = code.replace("Original A", "Changed A").replace("Original B", "Changed B")
    store = WorkbenchStore(tmp_path / "library")
    service = RenderService(store, tmp_path / "jobs")
    project = store.create_project("P")
    plot = store.create_plot(project["id"], "Two figures")
    run_id = service.render({"code": code, "data": None, "schema": {}}, plot["id"])
    deadline = time.monotonic() + 65
    while service.job(run_id)["status"] == "running" and time.monotonic() < deadline:
        time.sleep(0.05)
    assert service.job(run_id)["status"] == "success", service.job(run_id)
    saved = service.save_plot(plot["id"], run_id)
    original_svgs = {
        stem: service.export_path(plot["id"], "svg", stem).read_bytes()
        for stem in ("figure", "figure_2")
    }
    opened = service.open_session(plot["id"])
    sid = opened["session_id"]
    patches = [{"gid": "axes_0.xlabel", "prop": "text", "value": "Keep this edit"}]
    service.session_render(sid, patches)

    def propose(text, edits=patches):
        task = service.start_assistant(
            {"session_id": sid, "patches": edits, "prompt": "修改图标题"}
        )
        call = bridge[0][-1]
        (Path(call["figures_dir"]) / call["script"]).write_text(text, "utf-8")
        return task["id"]

    try:
        stale_task = propose(changed)
        latest_patches = patches + [{"gid": "axes_0.ylabel", "prop": "text", "value": "Newer edit"}]
        service.session_render(sid, latest_patches)
        with pytest.raises(WorkbenchError, match="变化"):
            service.apply_assistant(sid, stale_task, latest_patches)
        missing_output = propose(ORIGINAL, latest_patches)
        before = service._session(sid)
        with pytest.raises(WorkbenchError, match="出图数量"):
            service.apply_assistant(sid, missing_output, latest_patches)
        assert service._session(sid) is before
        assert "Original A" in service.session_render(sid, latest_patches)["svg"]
        # Tavotto mode retains the saved input snapshot; a newly referenced
        # project file must not silently disappear from later code exports.
        project_root = store.working_directory(project["id"])
        (project_root / "new-input.txt").write_text("42", "utf-8")
        changed_input = propose(
            changed + "\nfrom pathlib import Path\nPath('new-input.txt').read_text()\n",
            latest_patches,
        )
        with pytest.raises(WorkbenchError, match="数据"):
            service.apply_assistant(sid, changed_input, latest_patches)
        task_id = propose(changed, latest_patches)
        with pytest.raises(WorkbenchError, match="预览"):
            service.apply_assistant(sid, task_id, latest_patches, require_preview=True)
        resumed = service.resume_session(sid, latest_patches)
        assert resumed["session_id"] == sid and resumed["overrides"] == latest_patches
        assert service.resume_session(sid, patches)["overrides"] == latest_patches
        candidate_parent = Path(service._session(sid)["directory"]).parent
        before_directories = {item.name for item in candidate_parent.iterdir()}
        comparison = service.preview_assistant(sid, task_id, latest_patches)
        assert {item.name for item in candidate_parent.iterdir()} == before_directories
        assert comparison["before_image"].startswith("data:image/png;base64,")
        assert comparison["after_image"].startswith("data:image/png;base64,")
        assert comparison["before_image"] != comparison["after_image"]
        assert [figure["stem"] for figure in comparison["figures"]] == ["figure", "figure_2"]
        assert all(
            figure["before_image"] != figure["after_image"] for figure in comparison["figures"]
        )
        assert service._session(sid) is before
        assert "Original A" in service.session_render(sid, latest_patches)["svg"]
        assert store.get_plot(plot["id"])["revision"] == saved["revision"]
        with monkeypatch.context() as changed_pixels:
            real_preview = service._assistant_preview_image
            changed_pixels.setattr(
                service,
                "_assistant_preview_image",
                lambda current, values, stem=None: (
                    "different image" if stem == "figure_2" else real_preview(current, values, stem)
                ),
            )
            with pytest.raises(WorkbenchError, match="预览"):
                service.apply_assistant(sid, task_id, latest_patches, require_preview=True)
        assert {item.name for item in candidate_parent.iterdir()} == before_directories
        assert "Original A" in service.session_render(sid, latest_patches)["svg"]
        retired_directory = Path(service._session(sid)["directory"])
        applied = service.apply_assistant(sid, task_id, latest_patches, require_preview=True)
        assert not retired_directory.exists()
        assert Path(service._session(sid)["directory"]).is_dir()
        assert service._session(sid) is before
        assert applied["session_id"] == sid and applied["overrides"] == latest_patches
        assert "Changed A" in applied["svg"]
        assert "Keep this edit" in applied["svg"]
        assert store.get_plot(plot["id"])["revision"] == saved["revision"]
        with pytest.raises(WorkbenchError, match="变化"):
            service.apply_assistant(sid, task_id, latest_patches)

        from tavotto import pdfbackend

        real_compare = pdfbackend.compare_png
        monkeypatch.setattr(pdfbackend, "compare_png", lambda *_: False)
        with pytest.raises(WorkbenchError, match="不一致"):
            service.finish_session(sid, latest_patches)
        assert store.get_plot(plot["id"])["revision"] == saved["revision"]
        for stem in original_svgs:
            assert service.export_path(plot["id"], "svg", stem).read_bytes() == original_svgs[stem]
        monkeypatch.setattr(pdfbackend, "compare_png", real_compare)
        finished = service.finish_session(sid, latest_patches)
        assert finished["base_code"] == changed
        assert finished["overrides"] == latest_patches
        assert finished["state"] == "TAVOTTO_ONLY"
        assert finished["revision"] == saved["revision"] + 1
        for stem in original_svgs:
            updated_svg = service.export_path(plot["id"], "svg", stem).read_bytes()
            assert updated_svg != original_svgs[stem]
            assert b"Changed" in updated_svg
        restarted = RenderService(store, tmp_path / "restart-jobs")
        try:
            reopened = restarted.open_session(plot["id"], "figure_2")
            assert "Changed B" in reopened["svg"]
        finally:
            restarted.close()
    finally:
        service.close()


def test_commit_tavotto_rejects_a_revision_changed_during_verification(tmp_path):
    store = WorkbenchStore(tmp_path / "library")
    project = store.create_project("P")
    plot = store.create_plot(project["id"], "F")
    store.commit_plot(plot["id"], {"code": ORIGINAL, "data": None, "schema": {}})
    before = store.get_plot(plot["id"])
    with pytest.raises(WorkbenchError, match="变化"):
        store.commit_tavotto(plot["id"], [], CHANGED, base_code=CHANGED, expected_revision=0)
    assert store.get_plot(plot["id"]) == before


@pytest.mark.parametrize("close_service", [False, True])
@pytest.mark.parametrize("phase", ["build", "preview_proof"])
def test_cancel_or_root_close_during_candidate_build_cannot_resurrect_a_session(
    tmp_path, monkeypatch, close_service, phase
):
    store = WorkbenchStore(tmp_path / "library")
    project = store.create_project("P")
    plot = store.create_plot(project["id"], "F")
    service = RenderService(store, tmp_path / "jobs")
    original_worker = object()
    session = {
        "id": "session",
        "plot_id": plot["id"],
        "revision": 0,
        "plot": store.get_plot(plot["id"]),
        "stem": "figure",
        "patches": [],
        "directory": str(tmp_path / "sessions" / "original"),
        "worker": original_worker,
        "lock": threading.RLock(),
        "closed": False,
    }
    service.sessions["session"] = session
    session["plot"]["_artifact_dir"] = str(tmp_path / "artifacts")
    discarded = []
    monkeypatch.setattr("tavotto.workbench.rendering.pool.discard", discarded.append)
    monkeypatch.setattr(service.assistant, "proposal", lambda *args, **kwargs: CHANGED)
    monkeypatch.setattr(service, "_adapter", lambda plot, directory: directory)

    class Candidate:
        def ensure_built(self):
            # Simulate the cancellation/close transition at the exact boundary
            # after apply captured its candidate, before candidate acceptance.
            if phase == "build":
                if close_service:
                    service.close()
                else:
                    service.cancel_session("session")
            return {"stems": {"figure": {}}}

        def override(self, *args, **kwargs):
            return {"manifest": {}, "svg": "candidate"}

    candidate = Candidate()
    monkeypatch.setattr(service, "_session_worker", lambda value: candidate)
    if phase == "preview_proof":
        image = "proof-image"
        service.assistant_previews[("session", "task")] = (
            service._assistant_token(session, []),
            service._assistant_images_digest([{"stem": "figure", "after_image": image}]),
        )

        def close_during_preview(*args):
            if close_service:
                service.close()
            else:
                service.cancel_session("session")
            return image

        monkeypatch.setattr(service, "_assistant_preview_image", close_during_preview)
    with pytest.raises(WorkbenchError, match="结束"):
        service.apply_assistant("session", "task", [], require_preview=phase == "preview_proof")
    assert session["closed"] is True
    assert session["worker"] is original_worker
    assert candidate in discarded
    assert store.get_plot(plot["id"])["revision"] == 0
    service.close()
