import json
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest

from tavotto.engine import atomicio
from tavotto.workbench.store import WorkbenchError, WorkbenchStore


def test_folder_project_keeps_generated_content_in_one_metadata_child(tmp_path):
    store = WorkbenchStore(tmp_path / "state")
    folder = tmp_path / "existing study"
    folder.mkdir()
    source = folder / "experiment.py"
    source.write_bytes(b"# original user script\n")
    data = folder / "measurements.csv"
    data.write_bytes(b"x,y\n1,2\n")

    project = store.create_project("研究一", folder)
    plot = store.create_plot(project["id"], "图一")
    store.commit_plot(plot["id"], {"code": "saved code", "data": None})
    store.commit_template(
        {"scope": "project", "project_id": project["id"], "name": "T", "code": "T", "data": None}
    )

    metadata = folder / ".plot-workbench"
    assert set(folder.iterdir()) == {source, data, metadata}
    assert source.read_bytes() == b"# original user script\n"
    assert data.read_bytes() == b"x,y\n1,2\n"
    assert store.project_dir(project["id"]) == metadata
    assert store.working_directory(project["id"]) == folder
    assert project["working_directory"] == str(folder)
    assert store.list_projects()[0]["working_directory"] == str(folder)
    assert store.get_plot(plot["id"])["working_directory"] == str(folder)
    assert str(folder) not in (metadata / "project.json").read_text("utf-8")


@pytest.mark.parametrize("open_metadata", [False, True])
def test_folder_project_reopens_after_moving_with_derived_working_directory(
    tmp_path, open_metadata
):
    store = WorkbenchStore(tmp_path / "state")
    folder = tmp_path / "original"
    folder.mkdir()
    (folder / "values.csv").write_text("x,y\n1,2\n", "utf-8")
    project = store.create_project("P", folder)
    plot = store.create_plot(project["id"], "F")
    manifest = (store.project_dir(project["id"]) / "project.json").read_bytes()
    moved = tmp_path / "moved study"
    shutil.move(folder, moved)

    reloaded = WorkbenchStore(tmp_path / "other-state")
    reopened = reloaded.open_project(moved / ".plot-workbench" if open_metadata else moved)

    assert reopened["id"] == project["id"]
    assert reopened["plots"][0]["id"] == plot["id"]
    assert reopened["working_directory"] == str(moved)
    assert reopened["plots"][0]["working_directory"] == str(moved)
    assert (moved / ".plot-workbench/project.json").read_bytes() == manifest


def test_folder_project_recycle_moves_only_metadata_and_preserves_user_folder(tmp_path):
    store = WorkbenchStore(tmp_path / "state")
    folder = tmp_path / "study"
    folder.mkdir()
    original = folder / "data.csv"
    original.write_bytes(b"original data")
    project = store.create_project("P", folder)
    plot = store.create_plot(project["id"], "F")

    store.delete_project(project["id"])

    assert folder.is_dir()
    assert set(folder.iterdir()) == {original}
    assert original.read_bytes() == b"original data"
    assert store.list_projects() == []
    item = store.list_trash()[0]
    store.restore(item["id"])
    assert set(folder.iterdir()) == {original, folder / ".plot-workbench"}
    assert original.read_bytes() == b"original data"
    assert store.get_plot(plot["id"])["working_directory"] == str(folder)


def test_external_legacy_project_recycle_keeps_all_original_files_in_place(tmp_path):
    original_store = WorkbenchStore(tmp_path / "old-state")
    project = original_store.create_project("Legacy")
    plot = original_store.create_plot(project["id"], "Old plot")
    folder = tmp_path / "old project"
    shutil.move(project["path"], folder)
    source = folder / "original.py"
    source.write_bytes(b"original source")
    before = {
        str(path.relative_to(folder)): path.read_bytes()
        for path in folder.rglob("*")
        if path.is_file()
    }
    store = WorkbenchStore(tmp_path / "state")
    reopened = store.open_project(folder)
    assert reopened["working_directory"] == str(folder)
    assert store.get_plot(plot["id"])["id"] == plot["id"]

    store.delete_project(project["id"])

    assert folder.is_dir()
    assert {
        str(path.relative_to(folder)): path.read_bytes()
        for path in folder.rglob("*")
        if path.is_file()
    } == before
    item = store.list_trash()[0]
    store.restore(item["id"])
    assert store.get_project(project["id"])["working_directory"] == str(folder)
    assert store.list_trash() == []


def test_opening_duplicate_project_identity_does_not_replace_registered_folder(tmp_path):
    store = WorkbenchStore(tmp_path / "state")
    project = store.create_project("P")
    copied = tmp_path / "copy"
    shutil.copytree(project["path"], copied)
    index = store.index_path.read_bytes()

    with pytest.raises(WorkbenchError) as caught:
        store.open_project(copied)

    assert caught.value.code == "project_identity_conflict"
    assert store.index_path.read_bytes() == index
    assert store.project_dir(project["id"]) == Path(project["path"])


def test_opening_colliding_plot_identity_does_not_register_project(tmp_path):
    store = WorkbenchStore(tmp_path / "state")
    first = store.create_project("P")
    plot = store.create_plot(first["id"], "F")
    copied = tmp_path / "copy"
    shutil.copytree(first["path"], copied)
    manifest = json.loads((copied / "project.json").read_text("utf-8"))
    manifest["id"] = "1" * 32
    atomicio.write_json(copied / "project.json", manifest)
    index = store.index_path.read_bytes()

    with pytest.raises(WorkbenchError) as caught:
        store.open_project(copied)

    assert caught.value.code == "plot_identity_conflict"
    assert store.index_path.read_bytes() == index
    assert store.get_plot(plot["id"])["project_id"] == first["id"]


@pytest.mark.parametrize("invalid_id", ["../escape", "", None])
def test_opening_invalid_project_identity_has_no_filesystem_side_effect(tmp_path, invalid_id):
    store = WorkbenchStore(tmp_path / "state")
    folder = tmp_path / "invalid"
    folder.mkdir()
    atomicio.write_json(
        folder / "project.json",
        {"schema_version": 1, "id": invalid_id, "name": "P", "plots": {}},
    )
    before = store.index_path.read_bytes()
    with pytest.raises(WorkbenchError):
        store.open_project(folder)
    assert store.index_path.read_bytes() == before


def test_folder_create_rejects_existing_metadata_and_missing_folder(tmp_path):
    store = WorkbenchStore(tmp_path / "state")
    missing = tmp_path / "missing"
    with pytest.raises(WorkbenchError):
        store.create_project("P", missing)
    assert not missing.exists()
    folder = tmp_path / "study"
    folder.mkdir()
    metadata = folder / ".plot-workbench"
    metadata.mkdir()
    sentinel = metadata / "keep.txt"
    sentinel.write_bytes(b"unrecognized original content")
    with pytest.raises(WorkbenchError):
        store.create_project("P", folder)
    assert sentinel.read_bytes() == b"unrecognized original content"
    assert set(metadata.iterdir()) == {sentinel}


def test_generated_plot_identity_collision_cannot_shadow_another_project(tmp_path, monkeypatch):
    store = WorkbenchStore(tmp_path / "state")
    first = store.create_project("First")
    plot = store.create_plot(first["id"], "Original plot")
    second = store.create_project("Second")
    before = (store.project_dir(second["id"]) / "project.json").read_bytes()
    monkeypatch.setattr(
        "tavotto.workbench.store.uuid.uuid4", lambda: SimpleNamespace(hex=plot["id"])
    )

    with pytest.raises(WorkbenchError) as caught:
        store.create_plot(second["id"], "Colliding plot")

    assert caught.value.code == "plot_identity_conflict"
    assert (store.project_dir(second["id"]) / "project.json").read_bytes() == before
    assert not (store.project_dir(second["id"]) / "plots" / plot["id"]).exists()
    assert store.get_plot(plot["id"])["project_id"] == first["id"]


@pytest.mark.parametrize("after_write", [False, True])
def test_external_legacy_recycle_rolls_back_only_registration_on_write_failure(
    tmp_path, monkeypatch, after_write
):
    original_store = WorkbenchStore(tmp_path / "old-state")
    project = original_store.create_project("Legacy")
    folder = tmp_path / "legacy"
    shutil.move(project["path"], folder)
    original = folder / "original.csv"
    original.write_bytes(b"user data")
    store = WorkbenchStore(tmp_path / "state")
    store.open_project(folder)
    index = store.index_path.read_bytes()

    with monkeypatch.context() as fault:
        _fail_json_write(fault, store.index_path, after_write)
        with pytest.raises(OSError, match="injected"):
            store.delete_project(project["id"])

    assert original.read_bytes() == b"user data"
    assert store.index_path.read_bytes() == index
    assert store.get_project(project["id"])["working_directory"] == str(folder)
    assert store.list_trash() == []
    store.delete_project(project["id"])
    item = store.list_trash()[0]
    with monkeypatch.context() as fault:
        _fail_json_write(fault, store.index_path, after_write)
        with pytest.raises(OSError, match="injected"):
            store.restore(item["id"])
    assert store.list_projects() == []
    assert store.list_trash()[0]["id"] == item["id"]
    assert original.read_bytes() == b"user data"
    store.restore(item["id"])
    assert store.get_project(project["id"])["working_directory"] == str(folder)


def test_project_identity_survives_moving_folder(tmp_path):
    store = WorkbenchStore(tmp_path / "data")
    project = store.create_project("研究一")
    plot = store.create_plot(project["id"], "图一")
    destination = tmp_path / "moved"
    shutil.move(project["path"], destination)
    reopened = store.open_project(destination)
    assert reopened["id"] == project["id"]
    assert reopened["plots"][0]["id"] == plot["id"]


def test_favorite_is_same_template_and_deleted_category_unfiles(tmp_path):
    store = WorkbenchStore(tmp_path)
    category = store.create_category("新分类", "global")
    template = store.list_templates()[0]
    changed = store.update_template_metadata(
        template["id"], category_id=category["id"], favorite=True
    )
    assert changed["id"] == template["id"]
    assert len(store.list_templates()) == 3
    store.delete_category(category["id"])
    assert store.get_template(template["id"])["category_id"] == "uncategorized"
    assert store.get_template(template["id"])["favorite"] is True


def test_saved_plot_owns_template_snapshot(tmp_path):
    store = WorkbenchStore(tmp_path)
    project = store.create_project("P")
    plot = store.create_plot(project["id"], "F")
    template = store.list_templates()[0]
    revision = store.commit_plot(
        plot["id"],
        {
            "code": template["code"],
            "data": template["data"],
            "schema": template["schema"],
            "source": {"kind": "template", "template_id": template["id"]},
        },
    )
    store.delete_template(template["id"])
    assert store.get_plot(plot["id"])["code"] == template["code"]
    assert revision["revision"] == revision["saved_revision"]


def test_tavotto_only_cannot_replace_base_and_reopens_locked(tmp_path):
    store = WorkbenchStore(tmp_path)
    project = store.create_project("P")
    plot = store.create_plot(project["id"], "F")
    store.commit_plot(plot["id"], {"code": "base", "data": None, "schema": {}})
    store.commit_tavotto(plot["id"], [{"gid": "a", "prop": "text", "value": "B"}], "replay")
    with pytest.raises(WorkbenchError, match="Tavotto"):
        store.commit_plot(plot["id"], {"code": "edited"})
    reloaded = WorkbenchStore(tmp_path).get_plot(plot["id"])
    assert reloaded["state"] == "TAVOTTO_ONLY"
    assert reloaded["base_code"] == "base"
    assert reloaded["code"] == "replay"


def test_repeated_tavotto_does_not_nest_base_code(tmp_path):
    store = WorkbenchStore(tmp_path)
    project = store.create_project("P")
    plot = store.create_plot(project["id"], "F")
    store.commit_plot(plot["id"], {"code": "base", "data": None, "schema": {}})
    store.commit_tavotto(plot["id"], [], "replay1")
    second = store.commit_tavotto(plot["id"], [], "replay2")
    assert second["base_code"] == "base"
    assert second["code"] == "replay2"


def test_delete_restore_project_and_template(tmp_path):
    store = WorkbenchStore(tmp_path)
    project = store.create_project("P")
    store.delete_project(project["id"])
    assert store.list_projects() == []
    item = store.list_trash()[0]
    store.restore(item["id"])
    assert store.list_projects()[0]["id"] == project["id"]
    template = store.list_templates()[0]
    store.delete_template(template["id"])
    assert len(store.list_templates()) == 2
    template_trash = next(t for t in store.list_trash() if t["kind"] == "template")
    store.restore(template_trash["id"])
    assert len(store.list_templates()) == 3


def test_template_paths_cannot_be_export_targets(tmp_path):
    store = WorkbenchStore(tmp_path / "data")
    template = store.list_templates()[0]
    protected = store.template_dir(template["id"]) / "anything.py"
    with pytest.raises(WorkbenchError, match="模板"):
        store.validate_code_target(protected)
    assert store.validate_code_target(tmp_path / "export" / "ok.py").name == "ok.py"


def test_deleted_template_source_stays_protected_in_trash(tmp_path):
    store = WorkbenchStore(tmp_path / "data")
    template = store.list_templates()[0]
    store.delete_template(template["id"])
    trashed = next(item for item in store.list_trash() if item["kind"] == "template")
    source = store.root / "trash" / trashed["id"] / "content" / "source.py"
    with pytest.raises(WorkbenchError, match="模板"):
        store.validate_code_target(source)


def test_manifests_use_relative_paths(tmp_path):
    store = WorkbenchStore(tmp_path)
    project = store.create_project("P")
    store.create_plot(project["id"], "F")
    manifest = json.loads((store.project_dir(project["id"]) / "project.json").read_text("utf-8"))
    assert all(not p.startswith(str(tmp_path)) for p in manifest["plots"].values())


def _fail_json_write(monkeypatch, target, after_write=False):
    original = atomicio.write_json

    def failing(path, value, **kwargs):
        if Path(path) == target:
            if after_write:
                original(path, value, **kwargs)
            raise OSError("injected manifest write failure")
        return original(path, value, **kwargs)

    monkeypatch.setattr(atomicio, "write_json", failing)


@pytest.mark.parametrize("failure_file", ["record.json", "plot.json"])
@pytest.mark.parametrize("after_write", [False, True])
def test_failed_plot_revision_can_be_retried_without_deleting_partial_data(
    tmp_path, monkeypatch, failure_file, after_write
):
    store = WorkbenchStore(tmp_path)
    project = store.create_project("P")
    plot = store.create_plot(project["id"], "F")
    path = store.plot_dir(plot["id"])
    old_head = (path / "plot.json").read_bytes()
    failure = path / ("plot.json" if failure_file == "plot.json" else "revisions/1/record.json")
    with monkeypatch.context() as fault:
        _fail_json_write(fault, failure, after_write)
        with pytest.raises(OSError, match="injected"):
            store.commit_plot(plot["id"], {"code": "failed attempt", "data": None})
    assert (path / "plot.json").read_bytes() == old_head
    partial_source = path / "revisions/1/source.py"
    assert partial_source.read_text("utf-8") == "failed attempt"
    saved = store.commit_plot(plot["id"], {"code": "successful retry", "data": None})
    assert saved["code"] == "successful retry"
    assert saved["revision"] == saved["saved_revision"]
    assert partial_source.read_text("utf-8") == "failed attempt"


def test_revision_collision_never_overwrites_existing_directory(tmp_path):
    store = WorkbenchStore(tmp_path)
    project = store.create_project("P")
    plot = store.create_plot(project["id"], "F")
    occupied = store.plot_dir(plot["id"]) / "revisions/1"
    occupied.mkdir(parents=True)
    sentinel = occupied / "user-content.txt"
    sentinel.write_text("do not delete", "utf-8")
    saved = store.commit_plot(plot["id"], {"code": "new revision", "data": None})
    assert saved["revision"] > 1
    assert sentinel.read_text("utf-8") == "do not delete"


@pytest.mark.parametrize("failure_file", ["record.json", "template.json"])
@pytest.mark.parametrize("after_write", [False, True])
def test_failed_template_revision_can_be_retried_without_changing_saved_template(
    tmp_path, monkeypatch, failure_file, after_write
):
    store = WorkbenchStore(tmp_path)
    template = store.list_templates()[0]
    path = store.template_dir(template["id"])
    old_head = (path / "template.json").read_bytes()
    number = template["revision"] + 1
    failure = path / (
        "template.json" if failure_file == "template.json" else f"revisions/{number}/record.json"
    )
    payload = {"scope": "global", "name": "edited", "code": "failed attempt", "data": None}
    with monkeypatch.context() as fault:
        _fail_json_write(fault, failure, after_write)
        with pytest.raises(OSError, match="injected"):
            store.commit_template(payload, template_id=template["id"])
    assert (path / "template.json").read_bytes() == old_head
    assert store.get_template(template["id"])["code"] == template["code"]
    partial = path / f"revisions/{number}/source.py"
    assert partial.read_text("utf-8") == "failed attempt"
    payload["code"] = "retry"
    saved = store.commit_template(payload, template_id=template["id"])
    assert saved["code"] == "retry"
    assert partial.read_text("utf-8") == "failed attempt"


@pytest.mark.parametrize("mode", ["existing", "new-global", "new-project"])
@pytest.mark.parametrize("after_write", [False, True])
def test_failed_template_library_commit_restores_both_heads(
    tmp_path, monkeypatch, mode, after_write
):
    store = WorkbenchStore(tmp_path)
    project_id = store.create_project("P")["id"] if mode == "new-project" else None
    library = store._library_dir(project_id) / "library.json"
    before = library.read_bytes() if library.exists() else None
    template = store.list_templates()[0] if mode == "existing" else None
    payload = {
        "scope": "project" if project_id else "global",
        "project_id": project_id,
        "name": "attempt",
        "code": "failed attempt",
        "data": None,
    }
    with monkeypatch.context() as fault:
        _fail_json_write(fault, library, after_write)
        with pytest.raises(OSError, match="injected"):
            store.commit_template(payload, template_id=template["id"] if template else None)
    assert (library.read_bytes() if library.exists() else None) == before
    assert len(store.list_templates(project_id)) == 3
    if template:
        assert store.get_template(template["id"])["code"] == template["code"]
        assert store.get_template(template["id"])["revision"] == template["revision"]
    saved = store.commit_template(payload, template_id=template["id"] if template else None)
    assert saved["code"] == "failed attempt"


def _deletable_entity(store, kind):
    if kind == "template":
        entity = store.list_templates()[0]
        return entity, store.template_dir(entity["id"]), store.root / "templates/library.json"
    project = store.create_project("P")
    if kind == "project":
        return project, store.project_dir(project["id"]), store.index_path
    plot = store.create_plot(project["id"], "F")
    return plot, store.plot_dir(plot["id"]), store.project_dir(project["id"]) / "project.json"


@pytest.mark.parametrize("kind", ["project", "plot", "template"])
@pytest.mark.parametrize("after_write", [False, True])
def test_failed_delete_restores_directory_and_manifest(tmp_path, monkeypatch, kind, after_write):
    store = WorkbenchStore(tmp_path)
    entity, directory, manifest = _deletable_entity(store, kind)
    before = manifest.read_bytes()
    with monkeypatch.context() as fault:
        _fail_json_write(fault, manifest, after_write)
        with pytest.raises(OSError, match="injected"):
            getattr(store, "delete_" + kind)(entity["id"])
    assert directory.is_dir()
    assert manifest.read_bytes() == before
    assert store.list_trash() == []
    assert getattr(store, "get_" + kind)(entity["id"])["id"] == entity["id"]
    # A new command succeeds after the transient failure; the rollback must not
    # leave a hidden conflict at either end of the move.
    getattr(store, "delete_" + kind)(entity["id"])
    assert not directory.exists()
    assert len(store.list_trash()) == 1


@pytest.mark.parametrize("kind", ["project", "plot", "template"])
@pytest.mark.parametrize("after_write", [False, True])
def test_failed_restore_returns_content_to_trash_and_can_retry(
    tmp_path, monkeypatch, kind, after_write
):
    store = WorkbenchStore(tmp_path)
    entity, directory, manifest = _deletable_entity(store, kind)
    getattr(store, "delete_" + kind)(entity["id"])
    item = store.list_trash()[0]
    before = manifest.read_bytes()
    with monkeypatch.context() as fault:
        _fail_json_write(fault, manifest, after_write)
        with pytest.raises(OSError, match="injected"):
            store.restore(item["id"])
    assert not directory.exists()
    assert manifest.read_bytes() == before
    assert store.list_trash()[0]["id"] == item["id"]
    store.restore(item["id"])
    assert directory.is_dir()
    assert getattr(store, "get_" + kind)(entity["id"])["id"] == entity["id"]
    assert store.list_trash() == []


def test_restored_template_without_its_deleted_category_becomes_uncategorized(tmp_path):
    store = WorkbenchStore(tmp_path)
    category = store.create_category("removed")
    template = store.list_templates()[0]
    store.update_template_metadata(template["id"], category_id=category["id"], favorite=True)
    store.delete_template(template["id"])
    item = store.list_trash()[0]
    store.delete_category(category["id"])
    store.restore(item["id"])
    restored = store.get_template(template["id"])
    assert restored["category_id"] == "uncategorized"
    assert restored["favorite"] is True


@pytest.mark.parametrize(
    "scope, project_id", [("project", None), ("project", ""), ("unknown", None)]
)
def test_invalid_template_scope_is_rejected_before_touching_libraries(tmp_path, scope, project_id):
    store = WorkbenchStore(tmp_path)
    before = (tmp_path / "templates/library.json").read_bytes()
    folders = set((tmp_path / "templates").iterdir())
    with pytest.raises(WorkbenchError):
        store.commit_template(
            {
                "scope": scope,
                "project_id": project_id,
                "name": "scoped",
                "code": "code",
                "data": None,
            }
        )
    assert (tmp_path / "templates/library.json").read_bytes() == before
    assert set((tmp_path / "templates").iterdir()) == folders


def test_plot_and_template_revisions_keep_frozen_data_helper(tmp_path):
    store = WorkbenchStore(tmp_path / "data")
    artifacts = tmp_path / "rendered"
    artifacts.mkdir()
    helper = b"def dataframe_from_snapshot(snapshot):\n    return snapshot\n"
    (artifacts / "data_helper.py").write_bytes(helper)
    (artifacts / "unapproved.py").write_text("not a revision artifact", "utf-8")
    project = store.create_project("P")
    plot = store.create_plot(project["id"], "F")
    saved_plot = store.commit_plot(plot["id"], {"code": "base", "data": None}, artifacts)
    assert (Path(saved_plot["_artifact_dir"]) / "data_helper.py").read_bytes() == helper
    assert not (Path(saved_plot["_artifact_dir"]) / "unapproved.py").exists()
    frozen = store.commit_tavotto(plot["id"], [], "replay", artifacts)
    assert (Path(frozen["_artifact_dir"]) / "data_helper.py").read_bytes() == helper
    saved_template = store.commit_template(
        {"scope": "global", "name": "T", "code": "base", "data": None}, artifacts
    )
    assert (Path(saved_template["_artifact_dir"]) / "data_helper.py").read_bytes() == helper
    assert not (Path(saved_template["_artifact_dir"]) / "unapproved.py").exists()
