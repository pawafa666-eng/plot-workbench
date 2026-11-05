import base64
import io
import json
import zipfile

import pytest
from flask import Flask

from tavotto.engine import atomicio
from tavotto.workbench.api import WorkbenchManager, create_blueprint
from tavotto.workbench.sharing import FORMAT, export_library, import_library
from tavotto.workbench.store import WorkbenchError

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="
)


def package(templates=None, palettes=None, extra=None, version=1):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "library.json",
            json.dumps(
                {
                    "format": FORMAT,
                    "version": version,
                    "templates": templates or [],
                    "palettes": palettes or [],
                }
            ),
        )
        for name, value in (extra or {}).items():
            archive.writestr(name, value)
    return output.getvalue()


def template(**changes):
    return {
        "name": "示例模板",
        "code": "raise RuntimeError('must not execute on import')",
        "data": None,
        "schema": {},
        **changes,
    }


@pytest.fixture
def manager(tmp_path):
    value = WorkbenchManager(tmp_path / "local")
    yield value
    value.close()


def test_roundtrip_selected_templates_and_palettes_with_independent_ids(manager, tmp_path):
    category = manager.store.create_category("论文图")
    artifacts = tmp_path / "preview"
    artifacts.mkdir()
    (artifacts / "figure.png").write_bytes(PNG)
    original = manager.store.commit_template(
        {**template(), "scope": "global", "category_id": category["id"]}, artifacts
    )
    palette = manager.palettes.save({"name": "论文蓝", "colors": ["#123abc", "#ABCDEF"]})
    raw = export_library(
        manager.store, manager.palettes, [original["id"]], [palette["id"]]
    ).getvalue()
    target = WorkbenchManager(tmp_path / "recipient")
    try:
        result = import_library(target.store, target.palettes, raw)
        imported = target.store.get_template(result["templates"][0]["id"])
        assert imported["id"] != original["id"]
        assert imported["code"] == original["code"]
        assert imported["validation_state"] == "pending" and imported["revision"] == 0
        assert imported["schema"]["rows"]["mode"] == "variable"
        assert (target.store.template_dir(imported["id"]) / "draft/figure.png").read_bytes() == PNG
        assert not (target.store.template_dir(imported["id"]) / "revisions").exists()
        assert any(
            c["name"] == "论文图" and c["id"] == imported["category_id"]
            for c in target.store.list_categories()
        )
        new_palette = next(
            p for p in target.palettes.list() if p["id"] == result["palettes"][0]["id"]
        )
        assert new_palette["id"] != palette["id"] and new_palette["colors"] == [
            "#123ABC",
            "#ABCDEF",
        ]
        again = import_library(target.store, target.palettes, raw)
        assert again["templates"][0]["name"] == "示例模板（导入 1）"
        assert again["palettes"][0]["name"] == "论文蓝（导入 1）"
        reloaded = WorkbenchManager(target.root)
        assert reloaded.store.get_template(imported["id"])["code"] == original["code"]
        reloaded.close()
    finally:
        target.close()


@pytest.mark.parametrize(
    "raw",
    [
        b"not zip",
        package(version=2, palettes=[{"name": "P", "colors": ["#123456"]}]),
        package([template()], extra={"../outside.py": b"malicious"}),
        package([template()], [{"name": "bad", "colors": ["red"]}]),
        package([template(data={"row_count": 999, "column_count": 2})]),
        package([template(preview="previews/0000.png")]),
        package([template()], extra={"previews/0000.png": b"unused"}),
    ],
)
def test_invalid_packages_do_not_partially_import(manager, raw):
    before_templates = manager.store.list_templates()
    before_palettes = manager.palettes.list()
    with pytest.raises((WorkbenchError, ValueError)):
        import_library(manager.store, manager.palettes, raw)
    assert manager.store.list_templates() == before_templates
    assert manager.palettes.list() == before_palettes


def test_import_rolls_back_both_libraries_after_a_late_disk_failure(manager, monkeypatch):
    manager.palettes.list()
    library = manager.store._library_dir() / "library.json"
    before_library, before_palettes = library.read_bytes(), manager.palettes.path.read_bytes()
    before_dirs = set(library.parent.iterdir())
    write = atomicio.write_json

    def fail_after_write(path, value):
        write(path, value)
        if path == library:
            raise OSError("simulated directory fsync error")

    monkeypatch.setattr(atomicio, "write_json", fail_after_write)
    with pytest.raises(OSError):
        import_library(
            manager.store,
            manager.palettes,
            package([template()], [{"name": "New", "colors": ["#123456"]}]),
        )
    assert library.read_bytes() == before_library
    assert manager.palettes.path.read_bytes() == before_palettes
    assert set(library.parent.iterdir()) == before_dirs


def test_project_destination_is_local_and_not_taken_from_the_package(manager, tmp_path):
    folder = tmp_path / "project"
    folder.mkdir()
    project = manager.store.create_project("P", folder)
    result = import_library(
        manager.store,
        manager.palettes,
        package([template(project_id="foreign", scope="global")]),
        "project",
        project["id"],
    )
    imported = manager.store.get_template(result["templates"][0]["id"])
    assert imported["scope"] == "project" and imported["project_id"] == project["id"]
    assert manager.store.template_dir(imported["id"]).is_relative_to(folder)
    with pytest.raises(WorkbenchError):
        export_library(manager.store, manager.palettes, [imported["id"]], [])


def test_a_preview_cannot_be_referenced_many_times_to_amplify_the_import(manager):
    raw = package(
        [template(preview="previews/0000.png"), template(preview="previews/0000.png")],
        extra={"previews/0000.png": PNG},
    )
    with pytest.raises(WorkbenchError):
        import_library(manager.store, manager.palettes, raw)


def test_imported_example_data_does_not_retain_sender_path_metadata(manager):
    snapshot = {
        "columns": ["x"],
        "index": [1],
        "values": [[3]],
        "dtypes": ["int64"],
        "row_sources": [1],
        "column_sources": [1],
        "row_count": 1,
        "column_count": 1,
        "source": {"path": "C:/sender/private/data.csv", "sheet": "Sheet1"},
    }
    result = import_library(manager.store, manager.palettes, package([template(data=snapshot)]))
    assert manager.store.get_template(result["templates"][0]["id"])["data"]["source"] == {
        "kind": "shared_template"
    }


def test_http_zip_import_export_and_validation_gate(manager):
    app = Flask(__name__)
    app.register_blueprint(create_blueprint(manager))
    app.config["TESTING"] = True
    client = app.test_client()
    response = client.post(
        "/api/workbench/library/import",
        data={
            "file": (
                io.BytesIO(package([template()], [{"name": "P", "colors": ["#123456"]}])),
                "shared.zip",
            )
        },
    )
    assert response.status_code == 200, response.get_json()
    tid = response.get_json()["templates"][0]["id"]
    pid = response.get_json()["palettes"][0]["id"]
    exported = client.post(
        "/api/workbench/library/export", json={"template_ids": [tid], "palette_ids": [pid]}
    )
    assert exported.status_code == 200 and exported.mimetype == "application/zip"
    assert (
        client.patch(
            f"/api/workbench/templates/{tid}", json={"code": "new", "data": None, "schema": {}}
        ).status_code
        == 400
    )
    assert manager.store.get_template(tid)["revision"] == 0
    assert (
        client.patch(
            f"/api/workbench/templates/{tid}", json={"validation_state": "verified"}
        ).status_code
        == 400
    )
    verified = manager.store.commit_template(
        {**template(code="verified"), "scope": "global"}, template_id=tid
    )
    assert verified["revision"] == 1 and "validation_state" not in verified
