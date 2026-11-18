"""Excel-only templates: actual selected values, confirmation and cold replay."""

import io
import time
from pathlib import Path
from zipfile import ZipFile

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


def test_standalone_excel_script_reads_the_selected_sheet_under_its_original_name(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("TAVOTTO_DATA_DIR", str(tmp_path / "state"))
    manager = WorkbenchManager(tmp_path / "library")
    app = Flask(__name__)
    app.register_blueprint(create_blueprint(manager))
    client = app.test_client()
    project_dir = tmp_path / "项目"
    project_dir.mkdir()
    project = manager.store.create_project("Project", project_dir)
    plot = manager.store.create_plot(project["id"], "Plot")
    source_dir = tmp_path / "原脚本"
    source_dir.mkdir()
    source = source_dir / "代码.py"
    code = """from pathlib import Path
from openpyxl import load_workbook
import matplotlib.pyplot as plt

if __name__ == "__main__":
    with_path = Path(__file__).with_name("数据.xlsx")
    assert [path.name for path in with_path.parent.glob("*.xlsx")] == ["data.xlsx"]
    book = load_workbook(with_path, read_only=True)
    rows = list(book["数据"].values)
    book.close()
    assert rows == [("value",), (10,), (20,)], rows
    fig, ax = plt.subplots(figsize=(3, 2))
    ax.plot([row[0] for row in rows[1:]])
    ax.set_xlabel("Selected rows")
"""
    source.write_text(code, "utf-8")
    book = Workbook()
    book.active.title = "数据"
    for row in (("unused", "value"), ("A", 10), ("B", 20), ("C", 500)):
        book.active.append(row)
    workbook = source_dir / "数据.xlsx"
    book.save(workbook)
    original_bytes = workbook.read_bytes()
    try:
        data_api = "/api/workbench/data"
        response = client.post(
            f"{data_api}/inspect",
            data={"file": (io.BytesIO(original_bytes), workbook.name), "sheet": "数据"},
        )
        assert response.status_code == 200, response.get_json()
        selected_data = client.post(
            f"{data_api}/select",
            json={
                "table_id": response.get_json()["table_id"],
                "rows": [{"start": 1, "end": 3}],
                "columns": [{"start": 2, "end": 2}],
                "header": True,
            },
        ).get_json()["data"]
        plot_api = f"/api/workbench/plots/{plot['id']}"
        render = client.post(
            f"{plot_api}/render",
            json={
                "code": code,
                "data": selected_data,
                "schema": {"input_format": "excel"},
                "original_path": str(source),
            },
        )
        assert render.status_code == 200, render.get_json()
        job = render.get_json()["job_id"]
        wait(client, job)
        saved = client.post(f"{plot_api}/save", json={"run_id": job})
        assert saved.status_code == 200, saved.get_json()
        record = manager.store.get_plot(plot["id"])
        standard, alias = record["input_files"]
        assert standard["path"] == "data.xlsx"
        assert alias["read_as"] == "数据.xlsx"
        inputs = Path(record["_artifact_dir"]) / "inputs"
        for item, sheet in ((standard, "Data"), (alias, "数据")):
            with (inputs / item["path"]).open("rb") as file:
                staged = load_workbook(file, read_only=True)
                assert list(staged[sheet].values) == [("value",), (10,), (20,)]
                staged.close()
        with ZipFile(io.BytesIO(client.get(f"{plot_api}/code-package").data)) as package:
            assert any(name.endswith(f"/inputs/{alias['path']}") for name in package.namelist())
        session = manager.service.open_session(plot["id"])
        sid = session["session_id"]
        patch = {"gid": "axes_0.xlabel", "prop": "text", "value": "Verified rows"}
        manager.service.session_render(sid, [patch])
        finished = manager.service.finish_session(sid, [patch])
        assert finished["overrides"] == [patch]
        reopened = manager.service.open_session(plot["id"])
        assert reopened["overrides"] == [patch]
        manager.service.cancel_session(reopened["session_id"])
        assert workbook.read_bytes() == original_bytes
        assert source.read_text("utf-8") == code
    finally:
        manager.service.close()


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
