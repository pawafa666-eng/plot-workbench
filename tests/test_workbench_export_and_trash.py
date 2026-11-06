"""User-facing export destinations, frozen source paths and owned trash deletion."""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from flask import Flask

from tavotto.workbench.api import WorkbenchManager, create_blueprint
from tavotto.workbench.codeview import comparison, display_code
from tavotto.workbench.exportfiles import save_export
from tavotto.workbench.rendering import executable_code
from tavotto.workbench.store import WorkbenchError
from test_workbench_excel import selected
from test_workbench_rendering import wait_job


@pytest.fixture
def local(tmp_path, monkeypatch):
    monkeypatch.setenv("TAVOTTO_DATA_DIR", str(tmp_path / "state"))
    manager = WorkbenchManager(tmp_path / "library")
    app = Flask(__name__)
    app.register_blueprint(create_blueprint(manager))
    try:
        yield manager, app.test_client()
    finally:
        manager.service.close()


def test_edited_export_uses_selected_directory_exact_saved_bytes_and_revision(local, tmp_path):
    manager, client = local
    project = manager.store.create_project("P")
    plot = manager.store.create_plot(project["id"], "F")
    job = manager.service.render(
        {"code": "import matplotlib.pyplot as plt\nplt.plot([1,2], [3,4])\n", "schema": {}},
        plot["id"],
    )
    assert wait_job(manager.service, job)["status"] == "success"
    manager.service.save_plot(plot["id"], job)
    old_image = manager.service.export_path(plot["id"], "png").read_bytes()
    session = manager.service.open_session(plot["id"])
    patch = {"gid": "axes_0.xlabel", "prop": "text", "value": "Edited label"}
    saved = manager.service.finish_session(session["session_id"], [patch])
    assert manager.service.export_path(plot["id"], "png").read_bytes() != old_image
    destination = tmp_path / "chosen figure"
    destination.mkdir()
    for fmt in ("png", "svg", "pdf"):
        body = {
            "format": fmt,
            "stem": "figure",
            "revision": saved["revision"],
            "directory": str(destination),
            "filename": f"已编辑.{fmt}",
        }
        response = client.post(f"/api/workbench/plots/{plot['id']}/export-image", json=body)
        assert response.status_code == 200, response.get_json()
        result = response.get_json()
        actual = Path(result["path"])
        expected = manager.service.export_path(plot["id"], fmt).read_bytes()
        assert actual.parent == destination
        assert actual.read_bytes() == expected
        assert result["sha256"] == hashlib.sha256(expected).hexdigest()
        assert (
            client.post(f"/api/workbench/plots/{plot['id']}/export-image", json=body).status_code
            == 409
        )
        stale = {**body, "revision": saved["revision"] - 1, "filename": f"stale.{fmt}"}
        assert (
            client.post(f"/api/workbench/plots/{plot['id']}/export-image", json=stale).status_code
            == 409
        )
        assert not (destination / f"stale.{fmt}").exists()
        assert (
            client.get(
                f"/api/workbench/plots/{plot['id']}/export?format={fmt}&revision={saved['revision']}"
            ).data
            == expected
        )
        assert (
            client.get(
                f"/api/workbench/plots/{plot['id']}/export?format={fmt}&revision=0"
            ).status_code
            == 409
        )
    history = client.get(f"/api/workbench/history/plot/{plot['id']}/1").get_json()
    assert "PWB_SOURCE" not in history["comparison"]["after"]
    assert history["comparison"]["before"] == history["comparison"]["after"]
    assert history["graph_comparison"]["before"] != history["graph_comparison"]["after"]


def test_excel_path_exists_survives_graphical_save_reopen_and_portable_code_package(
    local, tmp_path
):
    manager, _ = local
    project = manager.store.create_project("P")
    plot = manager.store.create_plot(project["id"], "Excel")
    code = """from pathlib import Path
import pandas as pd
import matplotlib.pyplot as plt
root = Path(__file__).resolve().parent
assert Path(__file__).is_file()
assert (root / 'data.xlsx').exists() and (root / 'data.xlsx').is_file()
assert Path('data.xlsx').is_file()
frame = pd.read_excel(root / 'data.xlsx')
plt.bar(frame.iloc[:,0], frame.iloc[:,1])
"""
    job = manager.service.render(
        {"code": code, "data": selected(), "schema": {"input_format": "excel"}}, plot["id"]
    )
    result = wait_job(manager.service, job)
    assert result["status"] == "success", result
    assert result["execution_context"]["mode"] == "excel"
    manager.service.save_plot(plot["id"], job)
    session = manager.service.open_session(plot["id"])
    manager.service.finish_session(
        session["session_id"], [{"gid": "axes_0.xlabel", "prop": "text", "value": "Edited"}]
    )
    reopened = manager.service.open_session(plot["id"])
    manager.service.cancel_session(reopened["session_id"])
    exported = manager.service.export_code(plot["id"], tmp_path / "export")
    moved = tmp_path / "moved export"
    shutil.move(tmp_path / "export", moved)
    result = subprocess.run(
        [sys.executable, str(moved / Path(exported["path"]).name)], capture_output=True, timeout=60
    )
    assert result.returncode == 0, result.stderr.decode("utf-8", "replace")
    assert list(moved.glob("*.png"))


def test_imported_script_uses_its_parent_then_replays_frozen_inputs(local, tmp_path):
    manager, _ = local
    project = manager.store.create_project("Different project directory")
    plot = manager.store.create_plot(project["id"], "External")
    original = tmp_path / "original source"
    original.mkdir()
    (original / "values.csv").write_text("1,4\n2,6\n", "utf-8")
    code = """from pathlib import Path
import numpy as np
import matplotlib.pyplot as plt
assert Path(__file__).is_file()
assert Path('values.csv').is_file()
assert Path(__file__).with_name('values.csv').is_file()
values = np.loadtxt('values.csv', delimiter=',')
plt.plot(values[:,0], values[:,1])
"""
    source = original / "external.py"
    source.write_text(code, "utf-8")
    job = manager.service.render(
        {"code": code, "schema": {}, "original_path": str(source)}, plot["id"]
    )
    result = wait_job(manager.service, job)
    assert result["status"] == "success", result
    assert result["execution_context"]["working_directory"] == str(original)
    saved = manager.service.save_plot(plot["id"], job)
    assert saved["source"]["original_path"] == str(source)
    assert "original_relative_path" not in saved["source"]
    # Only this synthetic source is removed. Real user files are never touched.
    shutil.rmtree(original)
    session = manager.service.open_session(plot["id"])
    manager.service.finish_session(session["session_id"], [])


@pytest.mark.parametrize(
    "filename", ["../outside.zip", "bad/name.zip", "CON.zip", "wrong.py", "bad?.zip", "x.zip "]
)
def test_export_names_cannot_escape_or_use_reserved_filenames(tmp_path, filename):
    with pytest.raises(WorkbenchError):
        save_export(str(tmp_path), filename, b"data", "zip")
    assert not list(tmp_path.iterdir())


def test_selected_trash_deletion_preserves_new_entries_and_external_original(local, tmp_path):
    manager, client = local
    store = manager.store
    project = store.create_project("P")
    first = store.create_plot(project["id"], "First")
    store.delete_plot(first["id"])
    selected_id = store.list_trash()[0]["id"]
    second = store.create_plot(project["id"], "New")
    store.delete_plot(second["id"])
    body = {"library_root": str(manager.root), "ids": [selected_id]}
    assert (
        client.post(
            "/api/workbench/trash/delete", json={**body, "library_root": str(tmp_path / "other")}
        ).status_code
        == 409
    )
    response = client.post("/api/workbench/trash/delete", json=body)
    assert response.get_json() == {"deleted": [selected_id], "failed": []}
    assert [item["entity_id"] for item in store.list_trash()] == [second["id"]]
    external = tmp_path / "external original"
    external.mkdir()
    (external / "project.json").write_text(json.dumps({"id": project["id"]}), "utf-8")
    (external / "keep.txt").write_text("keep", "utf-8")
    content = store._trash(
        "project", project["id"], external, {"name": "Reference", "reference_only": True}
    )
    result = store.purge_trash([content.parent.name])
    assert not result["failed"]
    assert (external / "keep.txt").read_text("utf-8") == "keep"


def test_failed_trash_deletion_remains_visible_and_retryable(local, monkeypatch):
    manager, _ = local
    store = manager.store
    project = store.create_project("P")
    plot = store.create_plot(project["id"], "Locked")
    store.delete_plot(plot["id"])
    item = store.list_trash()[0]
    real = shutil.rmtree
    with monkeypatch.context() as patcher:
        patcher.setattr(
            shutil, "rmtree", lambda *_a, **_k: (_ for _ in ()).throw(PermissionError("locked"))
        )
        result = store.purge_trash([item["id"]])
        assert not result["deleted"] and result["failed"]
        assert store.list_trash()[0]["deletion_pending"]
        with pytest.raises(WorkbenchError, match="不能恢复"):
            store.restore(item["id"])
    assert shutil.rmtree is real
    assert store.purge_trash([item["id"]])["deleted"] == [item["id"]]


def test_purge_reference_never_deletes_original_directory(local, tmp_path):
    manager, _ = local
    external = tmp_path / "external"
    external.mkdir()
    (external / "project.json").write_text("{}", "utf-8")
    (external / "important.txt").write_text("keep", "utf-8")
    content = manager.store._trash("project", "a" * 32, external, {"reference_only": True})
    result = manager.store.purge_trash([content.parent.name])
    assert (external / "important.txt").read_text("utf-8") == "keep"
    assert result["deleted"] == [content.parent.name]


def test_trash_refuses_directory_links_and_keeps_external_files(local, tmp_path):
    manager, _ = local
    store = manager.store
    project = store.create_project("P")
    plot = store.create_plot(project["id"], "Link")
    store.delete_plot(plot["id"])
    item = store.list_trash()[0]
    content = store.root / "trash" / item["id"] / "content"
    outside = tmp_path / "external user files"
    outside.mkdir()
    (outside / "important.txt").write_text("keep", "utf-8")
    link = content / "linked"
    assert link.parent.resolve().is_relative_to(tmp_path.resolve())
    if os.name == "nt":
        result = subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(outside)], capture_output=True
        )
        assert result.returncode == 0, result.stderr
        assert link.lstat().st_file_attributes & 0x400
    else:
        link.symlink_to(outside, target_is_directory=True)
    try:
        result = store.purge_trash([item["id"]])
        assert not result["deleted"] and result["failed"]
        assert (outside / "important.txt").read_text("utf-8") == "keep"
        assert content.is_dir()
    finally:
        # Remove only this verified synthetic link, never traverse its target.
        if os.name == "nt":
            link.rmdir()
        else:
            link.unlink()


def test_library_zip_is_saved_with_selected_name_and_imports_again(local, tmp_path):
    manager, client = local
    palette = manager.palettes.save({"name": "Share", "colors": ["#123456", "#ABCDEF"]})
    body = {
        "palette_ids": [palette["id"]],
        "template_ids": [],
        "directory": str(tmp_path),
        "filename": "导出-2026-11-06.zip",
    }
    response = client.post("/api/workbench/library/export", json=body)
    assert response.status_code == 200, response.get_json()
    path = Path(response.get_json()["path"])
    assert path.parent == tmp_path and path.name == body["filename"]
    with zipfile.ZipFile(path) as archive:
        assert json.loads(archive.read("library.json"))["palettes"][0]["name"] == "Share"
    assert client.post("/api/workbench/library/export", json=body).status_code == 409
    with path.open("rb") as stream:
        imported = client.post(
            "/api/workbench/library/import", data={"file": (stream, path.name), "scope": "global"}
        )
    assert imported.status_code == 200, imported.get_json()
    assert len(imported.get_json()["palettes"]) == 1


def test_source_projection_does_not_execute_or_unwrap_ordinary_user_variables():
    source = "print('line one')\nprint('line two')\n"
    assert display_code({"code": executable_code(source, [])}) == source
    ordinary = "PWB_SOURCE = 'ordinary user value'\n"
    assert display_code({"code": ordinary}) == ordinary
    result = comparison("a\nb\n", "a\nc\n")
    assert result["opcodes"] == [("equal", 0, 1, 0, 1), ("replace", 1, 2, 1, 2)]
