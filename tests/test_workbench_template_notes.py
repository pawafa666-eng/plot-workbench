"""Template notes persist as metadata and travel with shared templates."""

import pytest
from flask import Flask

from tavotto.workbench.api import WorkbenchManager, create_blueprint
from tavotto.workbench.sharing import export_library, import_library
from tavotto.workbench.store import DESCRIPTION_LIMIT, WorkbenchError


@pytest.mark.parametrize("scope", ["global", "project"])
def test_template_note_survives_metadata_edit_reload_and_sharing(tmp_path, scope):
    manager = WorkbenchManager(tmp_path / "source")
    recipient = WorkbenchManager(tmp_path / "recipient")
    try:
        project = manager.store.create_project("Research") if scope == "project" else None
        pid = project["id"] if project else None
        category = manager.store.create_category("论文", scope=scope, project_id=pid)
        original = manager.store.commit_template(
            {
                "name": "模板",
                "scope": scope,
                "project_id": pid,
                "category_id": category["id"],
                "code": "print(1)",
                "data": None,
                "description": "原始备注",
            }
        )
        app = Flask(__name__)
        app.register_blueprint(create_blueprint(manager))
        client = app.test_client()
        note = "用途：热力图\n第二行保留空格  "
        response = client.patch(
            f"/api/workbench/templates/{original['id']}", json={"description": note}
        )
        assert response.status_code == 200
        updated = response.get_json()
        assert updated["description"] == note
        assert updated["category_id"] == category["id"]
        assert updated["revision"] == original["revision"]
        assert manager.store.get_template(original["id"])["description"] == note

        raw = export_library(manager.store, manager.palettes, [original["id"]], [], pid).getvalue()
        imported = import_library(recipient.store, recipient.palettes, raw)
        received = recipient.store.get_template(imported["templates"][0]["id"])
        assert received["description"] == note
        assert received["validation_state"] == "pending"

        # A later code revision must supersede metadata rather than being shadowed by it.
        revised = manager.store.commit_template(
            {**updated, "description": "新版本备注", "code": "print(2)"}, template_id=original["id"]
        )
        assert revised["description"] == "新版本备注"
        assert revised["revision"] == original["revision"] + 1
        cleared = client.patch(
            f"/api/workbench/templates/{original['id']}", json={"description": ""}
        )
        assert cleared.status_code == 200 and cleared.get_json()["description"] == ""
    finally:
        manager.close()
        recipient.close()


def test_invalid_note_rejected_without_changing_template(tmp_path):
    manager = WorkbenchManager(tmp_path / "source")
    try:
        original = manager.store.commit_template(
            {
                "name": "T",
                "scope": "global",
                "code": "print(1)",
                "data": None,
                "description": "keep",
            }
        )
        app = Flask(__name__)
        app.register_blueprint(create_blueprint(manager))
        client = app.test_client()
        for value in [None, 42, "x" * (DESCRIPTION_LIMIT + 1)]:
            result = client.patch(
                f"/api/workbench/templates/{original['id']}", json={"description": value}
            )
            assert result.status_code == 400
            assert manager.store.get_template(original["id"])["description"] == "keep"
            with pytest.raises(WorkbenchError):
                manager.store.commit_template(
                    {**original, "description": value}, template_id=original["id"]
                )
            assert manager.store.get_template(original["id"])["revision"] == original["revision"]
        result = client.patch(
            f"/api/workbench/templates/{original['id']}",
            json={"description": "x" * DESCRIPTION_LIMIT},
        )
        assert result.status_code == 200
    finally:
        manager.close()
