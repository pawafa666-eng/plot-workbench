import json
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError

import pytest
from flask import Flask

from tavotto.engine import atomicio
from tavotto.workbench import store as store_module
from tavotto.workbench.api import WorkbenchManager, create_blueprint
from tavotto.workbench.history import list_history, restore_copy
from tavotto.workbench.recovery import DraftStore
from tavotto.workbench.storage import inspect_library, migrate_library
from tavotto.workbench.store import WorkbenchError


@pytest.fixture
def manager(tmp_path, monkeypatch):
    monkeypatch.setenv("TAVOTTO_DATA_DIR", str(tmp_path / "cache"))
    value = WorkbenchManager(tmp_path / "library")
    yield value
    value.close()


def draft_body(manager, **changes):
    return {
        "kind": "template",
        "generation": 0,
        "name": "未完成的模板",
        "library_root": str(manager.root),
        "base_revision": 0,
        "content": {"code": "def unfinished(:", "data": None, "schema": {}},
        **changes,
    }


def test_drafts_survive_restart_and_do_not_create_verified_templates(manager):
    before = manager.store.list_templates()
    draft_id = uuid.uuid4().hex
    result = manager.drafts.save(draft_id, draft_body(manager))
    assert result["generation"] == 1
    restarted = DraftStore(manager.root)
    assert restarted.get(draft_id)["content"]["code"] == "def unfinished(:"
    assert len(restarted.list()["drafts"]) == 1
    assert manager.store.list_templates() == before
    assert DraftStore(manager.root.parent / "other").list()["drafts"] == []


def test_stale_save_and_delete_cannot_replace_a_newer_draft(manager):
    draft_id = uuid.uuid4().hex
    manager.drafts.save(draft_id, draft_body(manager))
    latest = draft_body(manager, generation=1, name="较新的草稿")
    manager.drafts.save(draft_id, latest)
    with pytest.raises(WorkbenchError, match="另一窗口"):
        manager.drafts.save(draft_id, draft_body(manager))
    with pytest.raises(WorkbenchError, match="未删除"):
        manager.drafts.delete(draft_id, 1)
    assert manager.drafts.get(draft_id)["name"] == "较新的草稿"
    manager.drafts.delete(draft_id, 2)
    assert manager.drafts.list()["drafts"] == []


def test_canvas_draft_only_stores_patches_and_never_executes(manager):
    project = manager.store.create_project("研究")
    plot = manager.store.create_plot(project["id"], "未运行的图")
    draft_id = uuid.uuid4().hex
    manager.drafts.save(
        draft_id,
        draft_body(
            manager,
            kind="canvas",
            entity_id=plot["id"],
            project_id=project["id"],
            content={
                "patches": [{"gid": "text-1", "prop": "text", "value": "草稿文字"}],
                "stem": "figure",
            },
        ),
    )
    assert manager.store.get_plot(plot["id"])["revision"] == 0
    assert not manager.service.jobs and not manager.service.sessions
    assert manager.drafts.get(draft_id)["content"]["patches"][0]["value"] == "草稿文字"


def test_nonfinite_or_malformed_draft_leaves_the_saved_one_unchanged(manager):
    draft_id = uuid.uuid4().hex
    manager.drafts.save(draft_id, draft_body(manager))
    before = manager.drafts.path(draft_id).read_bytes()
    with pytest.raises(WorkbenchError):
        manager.drafts.save(
            draft_id,
            draft_body(
                manager,
                generation=1,
                content={"code": "x", "schema": {}, "data": None, "extra": float("nan")},
            ),
        )
    assert manager.drafts.path(draft_id).read_bytes() == before


def test_inspecting_a_new_library_does_not_create_it(manager, tmp_path):
    target = tmp_path / "尚未创建的库"
    result = inspect_library(target)
    assert not target.exists()
    assert result["empty"] and not result["exists"] and result["templates"] == 0


def test_migration_preserves_source_and_rebases_internal_projects(manager, tmp_path):
    old = manager.root
    project = manager.store.create_project("内部项目")
    folder = tmp_path / "外部试验"
    folder.mkdir()
    external = manager.store.create_project("外部项目", folder)
    palette = manager.palettes.save({"name": "试验配色", "colors": ["#123456"]})
    source_index = manager.store.index_path.read_bytes()
    template_ids = {item["id"] for item in manager.store.list_templates()}
    draft_id = uuid.uuid4().hex
    manager.drafts.save(draft_id, draft_body(manager))
    draft_bytes = manager.drafts.path(draft_id).read_bytes()
    original_drafts = manager.drafts
    (old / "unrelated-private-file.txt").write_text("not owned by workbench", encoding="utf8")
    target = tmp_path / "新模板库"
    result = migrate_library(manager, target, old)
    assert result["migration"]["original_preserved"]
    assert (old / "projects.json").read_bytes() == source_index
    assert manager.store.project_dir(project["id"]).is_relative_to(target)
    assert manager.store.working_directory(external["id"]) == folder
    assert {item["id"] for item in manager.store.list_templates()} == template_ids
    assert palette["id"] in {item["id"] for item in manager.palettes.list()}
    assert result["migration"]["draft_files_verified"] >= 1
    assert manager.drafts.path(draft_id).read_bytes() == draft_bytes
    assert original_drafts.path(draft_id).read_bytes() == draft_bytes
    assert not (target / "unrelated-private-file.txt").exists()
    assert json.loads(manager.preference.read_text("utf8"))["root"] == str(target)


def test_migration_refuses_existing_content_overlap_and_changed_source(manager, tmp_path):
    original = manager.root
    target = tmp_path / "occupied"
    target.mkdir()
    sentinel = target / "user.txt"
    sentinel.write_bytes(b"preserve")
    for destination, source in [
        (target, original),
        (original / "child", original),
        (tmp_path / "new", target),
    ]:
        with pytest.raises(WorkbenchError):
            migrate_library(manager, destination, source)
    assert manager.root == original and sentinel.read_bytes() == b"preserve"


def test_failed_preference_write_keeps_the_original_active_library(manager, tmp_path, monkeypatch):
    manager.switch_root(manager.root)
    old, previous = manager.root, manager.preference.read_bytes()
    write = atomicio.write_json

    def fail_after_write(path, value):
        write(path, value)
        if path == manager.preference and value["root"] != str(old):
            raise OSError("directory fsync failed")

    monkeypatch.setattr(atomicio, "write_json", fail_after_write)
    with pytest.raises(OSError):
        manager.switch_root(tmp_path / "other")
    assert manager.root == old
    assert manager.preference.read_bytes() == previous
    assert manager.status()["library_confirmed"]


def test_confirming_the_current_default_library_persists_across_restart(manager):
    assert not manager.status()["library_confirmed"]
    manager.switch_root(manager.root)
    restarted = WorkbenchManager()
    try:
        assert restarted.root == manager.root and restarted.status()["library_confirmed"]
    finally:
        restarted.close()


def test_library_switch_rolls_back_if_the_old_service_fails_to_close(
    manager, tmp_path, monkeypatch
):
    manager.switch_root(manager.root)
    old, previous = manager.root, manager.preference.read_bytes()
    original_close = manager.service.close

    def fail_close():
        original_close()
        raise OSError("close failed")

    monkeypatch.setattr(manager.service, "close", fail_close)
    with pytest.raises(OSError):
        manager.switch_root(tmp_path / "other")
    assert manager.root == old and manager.preference.read_bytes() == previous
    assert not manager.service.closed


def saved_plot(manager, tmp_path):
    project = manager.store.create_project("历史试验")
    plot = manager.store.create_plot(project["id"], "历史图")
    artifact = tmp_path / "artifact"
    artifact.mkdir()
    (artifact / "figure.png").write_bytes(b"saved preview")
    (artifact / "inputs").mkdir()
    (artifact / "inputs/data.csv").write_bytes(b"x,y\n1,2\n")
    record = manager.store.commit_plot(
        plot["id"],
        {"code": "raise RuntimeError('must not execute during restore')", "data": None},
        artifact,
    )
    return record


def test_history_restore_creates_an_independent_unverified_copy_with_inputs(manager, tmp_path):
    old = saved_plot(manager, tmp_path)
    before = manager.store.get_plot(old["id"])
    new = restore_copy(manager.store, "plot", old["id"], 1, 1)
    assert new["id"] != old["id"] and new["validation_state"] == "pending"
    assert new["saved_revision"] == 0 and new["code"] == old["code"]
    assert (
        manager.store.plot_dir(new["id"]) / "revisions/1/inputs/data.csv"
    ).read_bytes() == b"x,y\n1,2\n"
    assert manager.store.get_plot(old["id"]) == before
    assert not manager.service.jobs and not manager.service.sessions
    with pytest.raises(WorkbenchError, match="验证"):
        manager.service.export_path(new["id"], "png")


def test_failed_unpublished_revision_is_not_shown_as_saved_history(manager, tmp_path, monkeypatch):
    plot = saved_plot(manager, tmp_path)
    head = manager.store.plot_dir(plot["id"]) / "plot.json"
    write = atomicio.write_json

    def fail_head(path, value):
        if path == head and value.get("revision") == 2:
            raise OSError("failed publication")
        write(path, value)

    with monkeypatch.context() as scoped:
        scoped.setattr(atomicio, "write_json", fail_head)
        with pytest.raises(OSError):
            manager.store.commit_plot(plot["id"], {"code": "orphan", "data": None})
    new = manager.store.commit_plot(plot["id"], {"code": "published", "data": None})
    assert new["revision"] == 3
    assert [r["revision"] for r in list_history(manager.store, "plot", plot["id"])["versions"]] == [
        3,
        1,
    ]


def test_template_history_copy_requires_fresh_validation(manager):
    template = manager.store.list_templates()[0]
    clone = restore_copy(manager.store, "template", template["id"], 1, 1)
    assert clone["revision"] == 0 and clone["validation_state"] == "pending"
    assert clone["code"] == template["code"] and clone["category_id"] == template["category_id"]


def test_http_draft_scope_and_history_cas(manager, tmp_path):
    app = Flask(__name__)
    app.register_blueprint(create_blueprint(manager))
    client = app.test_client()
    draft_id = uuid.uuid4().hex
    assert (
        client.put(f"/api/workbench/drafts/{draft_id}", json=draft_body(manager)).status_code == 200
    )
    assert client.get("/api/workbench/drafts").get_json()["drafts"][0]["id"] == draft_id
    wrong_root = draft_body(manager, generation=1, library_root=str(tmp_path / "other"))
    assert client.put(f"/api/workbench/drafts/{draft_id}", json=wrong_root).status_code == 409
    plot = saved_plot(manager, tmp_path)
    assert (
        client.get(f"/api/workbench/history/plot/{plot['id']}/1/preview/figure").data
        == b"saved preview"
    )
    route = f"/api/workbench/history/plot/{plot['id']}/1/restore"
    assert (
        client.post(
            route, json={"library_root": str(manager.root), "current_revision": 0}
        ).status_code
        == 409
    )
    assert (
        client.post(
            route, json={"library_root": str(manager.root), "current_revision": 1}
        ).status_code
        == 200
    )
    assert (
        client.delete(f"/api/workbench/drafts/{draft_id}", json={"generation": 1}).status_code
        == 200
    )


def test_invalid_library_manifest_is_reported_without_changes(manager, tmp_path):
    path = tmp_path / "broken"
    path.mkdir()
    sentinel = path / "projects.json"
    sentinel.write_bytes(b"not json")
    with pytest.raises(WorkbenchError, match="清单"):
        inspect_library(path)
    assert sentinel.read_bytes() == b"not json"


def test_invalid_preferences_are_reported_and_preserved(manager):
    app = Flask(__name__)
    app.register_blueprint(create_blueprint(manager))
    client = app.test_client()
    path = manager.preference.parent / "workbench-ui.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"[]")
    assert client.get("/api/workbench/preferences").status_code == 409
    assert (
        client.patch("/api/workbench/preferences", json={"density": "compact"}).status_code == 409
    )
    assert path.read_bytes() == b"[]"


@pytest.mark.skipif(
    os.name != "nt", reason="Windows atomic replace versus non-delete-sharing reads"
)
def test_project_creation_waits_for_a_thumbnail_index_read(manager, monkeypatch):
    held, release = threading.Event(), threading.Event()
    read = store_module.read_json

    def thumbnail_read(path, *args, **kwargs):
        if path == manager.store.index_path and threading.current_thread().name.startswith(
            "thumbnail"
        ):
            with path.open(encoding="utf8") as stream:
                held.set()
                assert release.wait(5)
                return json.load(stream)
        return read(path, *args, **kwargs)

    monkeypatch.setattr(store_module, "read_json", thumbnail_read)
    with (
        ThreadPoolExecutor(1, thread_name_prefix="thumbnail") as readers,
        ThreadPoolExecutor(1) as writers,
    ):
        reader = readers.submit(manager.store.list_projects, details=True)
        assert held.wait(5)
        writer = writers.submit(manager.store.create_project, "缩略图加载期间新建")
        try:
            with pytest.raises(FutureTimeoutError):
                writer.result(timeout=0.1)
        finally:
            release.set()
        reader.result(timeout=5)
        project = writer.result(timeout=5)
    assert manager.store.get_project(project["id"])["name"] == "缩略图加载期间新建"
