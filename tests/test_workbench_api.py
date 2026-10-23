import io
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from flask import Flask

from tavotto.workbench.api import WorkbenchManager, create_blueprint
from tavotto.workbench.store import WorkbenchError


@pytest.fixture
def client(tmp_path):
    app = Flask(__name__)
    manager = WorkbenchManager(tmp_path / "data")
    app.config["WORKBENCH_MANAGER"] = manager
    app.register_blueprint(create_blueprint(manager))
    app.config.update(TESTING=True, MAX_CONTENT_LENGTH=128 * 1024 * 1024)
    return app.test_client()


def settle(client, job_id):
    deadline = time.monotonic() + 65
    while time.monotonic() < deadline:
        result = client.get(f"/api/workbench/jobs/{job_id}").get_json()
        if result["status"] != "running":
            return result
        time.sleep(0.05)
    raise AssertionError("job did not settle")


def test_projects_plots_render_save_and_export(client):
    project = client.post("/api/workbench/projects", json={"name": "试验"}).get_json()
    plot = client.post(
        f"/api/workbench/projects/{project['id']}/plots", json={"name": "曲线"}
    ).get_json()
    code = "import matplotlib.pyplot as plt\ndef build_figure(data):\n fig, ax = plt.subplots()\n ax.plot(data.iloc[:, 0], data.iloc[:, 1])\n return fig\n"
    run = client.post(
        f"/api/workbench/plots/{plot['id']}/render",
        json={
            "code": code,
            "schema": {
                "rows": {"mode": "variable", "min": 1},
                "columns": {"mode": "fixed", "value": 2},
            },
            "data": {
                "columns": ["x", "y"],
                "index": [1, 2],
                "values": [[1, 2], [2, 5]],
                "dtypes": ["int64", "int64"],
                "row_sources": [1, 2],
                "column_sources": [1, 2],
                "source": {"kind": "test"},
                "row_count": 2,
                "column_count": 2,
            },
        },
    ).get_json()
    job = settle(client, run["job_id"])
    assert job["status"] == "success", job
    saved = client.post(f"/api/workbench/plots/{plot['id']}/save", json={"run_id": run["job_id"]})
    assert saved.status_code == 200, saved.get_json()
    for fmt in ("png", "svg", "pdf"):
        response = client.get(f"/api/workbench/plots/{plot['id']}/export?format={fmt}")
        assert response.status_code == 200 and len(response.data) > 100


def test_table_import_is_confirmed_and_uses_inclusive_ranges(client):
    body = {"file": (io.BytesIO(b"a,b,c,d\n1,2,3,4\n5,6,7,8\n9,10,11,12\n"), "table.csv")}
    response = client.post(
        "/api/workbench/data/inspect", data=body, content_type="multipart/form-data"
    )
    assert response.status_code == 200
    inspected = response.get_json()
    assert (inspected["row_count"], inspected["column_count"]) == (4, 4)
    selected = client.post(
        "/api/workbench/data/select",
        json={
            "table_id": inspected["table_id"],
            "rows": [{"start": 0, "end": 2}, {"start": 4, "end": 0}],
            "columns": [{"start": 1, "end": 1}, {"start": 3, "end": 0}],
        },
    ).get_json()
    assert (selected["data"]["row_count"], selected["data"]["column_count"]) == (3, 3)
    bad = client.post(
        "/api/workbench/data/select",
        json={
            "table_id": inspected["table_id"],
            "rows": [{"start": 1, "end": 3}, {"start": 0, "end": 4}],
            "columns": [{"start": 1, "end": 1}],
        },
    )
    assert bad.status_code == 400


def test_template_requires_successful_matching_run_and_compatible_dimensions(client):
    template = client.get("/api/workbench/templates").get_json()["templates"][0]
    project = client.post("/api/workbench/projects", json={"name": "P"}).get_json()
    data = template["data"]
    matches = client.post(
        "/api/workbench/templates/compatible", json={"project_id": project["id"], "data": data}
    ).get_json()
    assert template["id"] in {item["id"] for item in matches["templates"]}
    failed = client.post(
        "/api/workbench/templates",
        json={
            "name": "坏模板",
            "scope": "project",
            "project_id": project["id"],
            "code": "def build_figure(data): raise RuntimeError('bad')",
            "data": data,
            "schema": {},
            "run_id": "not-a-job",
        },
    )
    assert failed.status_code in (400, 404, 409)
    payload = {"code": template["code"], "data": data, "schema": template["schema"]}
    job = client.post("/api/workbench/templates/validate", json=payload).get_json()
    result = settle(client, job["job_id"])
    assert result["status"] == "success", result
    saved = client.post(
        "/api/workbench/templates",
        json={
            **payload,
            "name": "复制",
            "scope": "project",
            "project_id": project["id"],
            "run_id": job["job_id"],
        },
    )
    assert saved.status_code == 200, saved.get_json()


def test_tavotto_only_plot_rejects_new_code_data_and_render(client, tmp_path):
    project = client.post("/api/workbench/projects", json={"name": "P"}).get_json()
    plot = client.post(
        f"/api/workbench/projects/{project['id']}/plots", json={"name": "F"}
    ).get_json()
    # Simulate the durable state produced by the independently verified Tavotto finish path.
    manager = client.application.config["WORKBENCH_MANAGER"]
    manager.store.commit_tavotto(plot["id"], [], "frozen replay code")
    updated = client.patch(
        f"/api/workbench/plots/{plot['id']}", json={"code": "changed", "data": {}}
    )
    assert updated.status_code == 409
    rendered = client.post(
        f"/api/workbench/plots/{plot['id']}/render", json={"code": "changed", "data": {}}
    )
    assert rendered.status_code == 409


def test_workbench_routes_stay_behind_the_existing_session_guard():
    import tavotto.app as app_module
    from tavotto import security
    from tavotto.engine.session_client import AUTH_HEADER

    previous = app_module.app.config.get(security.STATE_KEY)
    app_module.app.config[security.STATE_KEY] = security.SessionState(
        "nonce", api_secret="local-smoke-secret"
    )
    try:
        client = app_module.app.test_client()
        assert client.get("/api/workbench/status").status_code == 401
        allowed = client.get("/api/workbench/status", headers={AUTH_HEADER: "local-smoke-secret"})
        assert allowed.status_code == 200
    finally:
        if previous is None:
            app_module.app.config.pop(security.STATE_KEY, None)
        else:
            app_module.app.config[security.STATE_KEY] = previous


def test_script_import_returns_utf8_python_and_rejects_non_python(tmp_path):
    from tavotto.workbench.api import WorkbenchManager

    manager = WorkbenchManager(tmp_path / "data")
    app = Flask(__name__)
    app.register_blueprint(create_blueprint(manager))
    script = tmp_path / "绘图.py"
    script.write_text("# 中文\ndef build_figure(data):\n    return None\n", encoding="utf-8-sig")
    client = app.test_client()
    loaded = client.post("/api/workbench/scripts/read", json={"path": str(script)})
    assert loaded.status_code == 200
    assert loaded.get_json()["code"].startswith("# 中文")
    assert loaded.get_json()["name"] == "绘图"
    rejected = client.post(
        "/api/workbench/scripts/read", json={"path": str(script.with_suffix(".txt"))}
    )
    assert rejected.status_code == 400


def test_code_export_uses_unique_names_and_records_runtime_versions(tmp_path):
    manager = WorkbenchManager(tmp_path / "data")
    project = manager.store.create_project("P")
    plot = manager.store.create_plot(project["id"], "F")
    manager.store.commit_plot(
        plot["id"],
        {
            "code": "def build_figure(data):\n    return None\n",
            "data": None,
            "schema": {},
            "source": {"kind": "external"},
            "environment": {"python": "3.13.1", "packages": {"pandas": "3.0.0"}},
        },
    )
    output = tmp_path / "exports"
    output.mkdir()
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(
            executor.map(lambda _: manager.service.export_code(plot["id"], output), range(2))
        )
    first, second = results
    assert first["path"] != second["path"]
    environment = Path(first["files"][1]) / "environment.json"
    requirements = Path(first["files"][1]) / "requirements.txt"
    assert '"python": "3.13.1"' in environment.read_text("utf-8")
    assert "pandas==3.0.0" in requirements.read_text("utf-8")


def test_export_replace_requires_a_real_boolean(tmp_path):
    manager = WorkbenchManager(tmp_path / "data")
    project = manager.store.create_project("P")
    plot = manager.store.create_plot(project["id"], "F")
    manager.store.commit_plot(plot["id"], {"code": "x = 1", "data": None, "schema": {}})
    app = Flask(__name__)
    app.register_blueprint(create_blueprint(manager))
    response = app.test_client().post(
        f"/api/workbench/plots/{plot['id']}/export-code",
        json={"directory": str(tmp_path), "replace": "false"},
    )
    assert response.status_code == 400


def test_replace_external_script_keeps_a_backup_and_protects_template_source(tmp_path):
    manager = WorkbenchManager(tmp_path / "data")
    project = manager.store.create_project("P")
    plot = manager.store.create_plot(project["id"], "F")
    original = tmp_path / "outside.py"
    original.write_text("old code", encoding="utf-8")
    manager.store.commit_plot(
        plot["id"],
        {
            "code": "def build_figure(data):\n    return None\n",
            "data": None,
            "schema": {},
            "source": {"kind": "external", "original_path": str(original)},
        },
    )
    replaced = manager.service.export_code(plot["id"], replace=True)
    assert Path(replaced["backup"]).read_text("utf-8") == "old code"
    assert Path(replaced["path"]).read_text("utf-8").startswith("def build_figure")

    template = manager.store.list_templates()[0]
    protected = manager.store.template_dir(template["id"]) / "source.py"
    manager.store.get_plot(plot["id"])
    record = manager.store.get_plot(plot["id"])
    record["source"]["original_path"] = str(protected)
    manager.store.commit_plot(
        plot["id"],
        {
            "code": record["code"],
            "data": record["data"],
            "schema": record["schema"],
            "source": record["source"],
        },
    )
    with pytest.raises(WorkbenchError, match="模板"):
        manager.service.export_code(plot["id"], replace=True)


def test_table_operations_do_not_import_scientific_stack_in_parent(client, monkeypatch):
    import builtins

    original_import = builtins.__import__

    def without_scientific_stack(name, *args, **kwargs):
        if name.split(".")[0] in {"pandas", "numpy"}:
            raise ModuleNotFoundError(f"parent must not import {name}")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", without_scientific_stack)
    inspected = client.post(
        "/api/workbench/data/inspect",
        data={"file": (io.BytesIO(b"x,y\n1,2\n3,4\n"), "data.csv")},
    )
    assert inspected.status_code == 200, inspected.get_json()
    selected = client.post(
        "/api/workbench/data/select",
        json={
            "table_id": inspected.get_json()["table_id"],
            "rows": [{"start": 0, "end": 0}],
            "columns": [{"start": 0, "end": 0}],
            "header": True,
        },
    )
    assert selected.status_code == 200, selected.get_json()
    transformed = client.post(
        "/api/workbench/data/transform",
        json={"data": selected.get_json()["data"], "operation": "transpose"},
    )
    assert transformed.status_code == 200, transformed.get_json()
    assert transformed.get_json()["data"]["values"] == [[1, 3], [2, 4]]
    tagged = selected.get_json()["data"]
    tagged["values"][0][1] = {"$type": "integer", "value": "2"}
    compatible = client.post("/api/workbench/templates/compatible", json={"data": tagged})
    assert compatible.status_code == 200, compatible.get_json()
