"""Excel-only templates: actual selected values, confirmation and cold replay."""

import io
import time
from pathlib import Path

import pytest
from flask import Flask
from openpyxl import Workbook, load_workbook

from tavotto.workbench.api import WorkbenchManager, create_blueprint
from tavotto.workbench.data import load_table, select_data, validate_schema, workbook_bytes


def selected():
    book = Workbook()
    sheet = book.active
    sheet.append(["City", "Unused", "Value"])
    sheet.append(["A", 888, 10])
    sheet.append(["B", 999, 20])
    output = io.BytesIO()
    book.save(output)
    table = load_table(output.getvalue(), "原始数据.xlsx")
    return select_data(
        table, [{"start": 0, "end": 0}], [{"start": 1, "end": 1}, {"start": 3, "end": 3}], True
    )


def wait(client, job):
    deadline = time.monotonic() + 65
    while time.monotonic() < deadline:
        response = client.get(f"/api/workbench/jobs/{job}").get_json()
        if response["status"] != "running":
            assert response["status"] == "success", response
            return response["result"]
        time.sleep(0.05)
    raise AssertionError("Excel job timed out")


def test_selected_workbook_contains_only_final_data_and_literal_strings():
    snapshot = selected()
    assert (snapshot["row_count"], snapshot["column_count"]) == (2, 2)
    snapshot["values"][0][0] = "=1+2"
    book = load_workbook(io.BytesIO(workbook_bytes(snapshot)), data_only=False)
    assert list(book["Data"].values) == [("City", "Value"), ("=1+2", 10), ("B", 20)]
    assert book["Data"]["A2"].data_type == "s"


@pytest.mark.parametrize(
    "rule,valid",
    [
        ({"mode": "fixed", "value": 2}, True),
        ({"mode": "fixed", "value": 3}, False),
        ({"mode": "variable", "min": 2}, True),
        ({"mode": "variable", "min": 3}, False),
        ({"mode": "maximum", "max": 2}, True),
        ({"mode": "maximum", "max": 1}, False),
        ({"mode": "any"}, True),
    ],
)
def test_dimension_declarations_measure_input_not_python_internals(rule, valid):
    assert (not validate_schema(selected(), {"rows": rule, "columns": rule})) == valid


def test_excel_template_confirmation_save_replace_and_graphical_replay(tmp_path, monkeypatch):
    monkeypatch.setenv("TAVOTTO_DATA_DIR", str(tmp_path / "state"))
    manager = WorkbenchManager(tmp_path / "library")
    app = Flask(__name__)
    app.register_blueprint(create_blueprint(manager))
    client = app.test_client()
    snapshot = selected()
    code = """from pathlib import Path
import pandas as pd
import matplotlib.pyplot as plt
data = pd.read_excel(Path(__file__).with_name('data.xlsx'), sheet_name='Data')
fig, ax = plt.subplots(figsize=(3,2))
ax.bar(data.iloc[:, 0], data.iloc[:, 1])
ax.set_xlabel('City')
fig.tight_layout()
"""
    payload = {
        "code": code,
        "data": snapshot,
        "schema": {
            "input_format": "excel",
            "rows": {"mode": "any"},
            "columns": {"mode": "any"},
            "code_filename": "bar.py",
        },
    }
    try:
        for invalid in (None, {**snapshot, "source": {"filename": "data.csv"}}):
            assert (
                client.post(
                    "/api/workbench/templates/validate", json={**payload, "data": invalid}
                ).status_code
                == 400
            )
        job = client.post("/api/workbench/templates/validate", json=payload).get_json()["job_id"]
        result = wait(client, job)
        create = {**payload, "run_id": job, "name": "Excel template", "scope": "global"}
        assert (
            client.post("/api/workbench/templates", json=create).get_json()["code"]
            == "dimensions_unconfirmed"
        )
        dimensions = {"rows": {"mode": "any"}, "columns": {"mode": "fixed", "value": 2}}
        assert (
            client.post(
                f"/api/workbench/jobs/{job}/dimensions",
                json={**payload, "code": code + "\n# changed", "dimensions": dimensions},
            ).status_code
            == 409
        )
        assert (
            client.post(
                f"/api/workbench/jobs/{job}/dimensions",
                json={
                    **payload,
                    "dimensions": {**dimensions, "columns": {"mode": "fixed", "value": 3}},
                },
            ).status_code
            == 400
        )
        confirmed = client.post(
            f"/api/workbench/jobs/{job}/dimensions", json={**payload, "dimensions": dimensions}
        )
        assert confirmed.status_code == 200, confirmed.get_json()
        create["schema"] = confirmed.get_json()["schema"]
        saved = client.post("/api/workbench/templates", json=create)
        assert saved.status_code == 200, saved.get_json()
        template = saved.get_json()
        folder = manager.store.template_dir(template["id"]) / "revisions" / "1"
        assert (folder / "source.py").read_text("utf-8") == code
        assert list(load_workbook(folder / "data.xlsx")["Data"].values) == [
            ("City", "Value"),
            ("A", 10),
            ("B", 20),
        ]
        exported = client.post("/api/workbench/data/workbook", json={"data": snapshot})
        assert exported.status_code == 200
        assert list(load_workbook(io.BytesIO(exported.data))["Data"].values)[1:] == [
            ("A", 10),
            ("B", 20),
        ]
        # A different source and size actually change the rendered image.
        replacement = {
            **snapshot,
            "index": [1, 2, 3],
            "row_sources": [2, 3, 4],
            "row_count": 3,
            "values": [["C", 1], ["D", 40], ["E", 15]],
        }
        project_folder = tmp_path / "project"
        project_folder.mkdir()
        project = manager.store.create_project("P", project_folder)
        plot = manager.store.create_plot(project["id"], "replacement")
        render = {
            "code": code,
            "data": replacement,
            "schema": create["schema"],
            "template_id": template["id"],
        }
        job2 = client.post(f"/api/workbench/plots/{plot['id']}/render", json=render).get_json()[
            "job_id"
        ]
        changed = wait(client, job2)
        assert client.get(result["preview_url"]).data != client.get(changed["preview_url"]).data
        assert (
            client.post(
                f"/api/workbench/plots/{plot['id']}/save", json={"run_id": job2}
            ).status_code
            == 200
        )
        assert not (project_folder / "data.xlsx").exists()
        # Frozen workbook, same selected data, and normal hot/cold verification.
        session = manager.service.open_session(plot["id"])
        patch = {"gid": "axes_0.xlabel", "prop": "text", "value": "Selected City"}
        manager.service.session_render(session["session_id"], [patch])
        finished = manager.service.finish_session(session["session_id"], [patch])
        assert finished["overrides"] == [patch]
        assert (Path(finished["_artifact_dir"]) / "inputs" / "data.xlsx").is_file()
        reopened = manager.service.open_session(plot["id"])
        assert reopened["overrides"] == [patch]
        manager.service.cancel_session(reopened["session_id"])
    finally:
        manager.service.close()
