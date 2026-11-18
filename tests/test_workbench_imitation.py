"""Reference-image drafts use the real worker and template store."""

import io
import json
import time
from pathlib import Path

from flask import Flask
from openpyxl import load_workbook
from PIL import Image

from tavotto.engine import ai_bridge
from tavotto.workbench.api import WorkbenchManager, create_blueprint


def _image():
    stream = io.BytesIO()
    Image.new("RGB", (100, 60), "white").save(stream, format="PNG")
    stream.seek(0)
    return stream


CODE = """from pathlib import Path
import pandas as pd
import matplotlib.pyplot as plt
table = pd.read_excel(Path(__file__).with_name("data.xlsx"), sheet_name="Data")
fig, ax = plt.subplots()
ax.plot(table["Time"], table["Value"])
"""


def _wait(client, expected):
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        task = client.get("/api/workbench/imitation").get_json()["task"]
        if task["status"] not in {"running", "validating"}:
            assert task["status"] == expected, task
            return task
        time.sleep(0.05)
    raise AssertionError("Imitation timed out")


def test_imitation_validates_excel_revises_applies_and_cleans(tmp_path, monkeypatch):
    monkeypatch.setenv("TAVOTTO_DATA_DIR", str(tmp_path / "state"))
    calls = []

    class Done:
        def poll(self):
            return 0

        def wait(self):
            return 0

    def spawn(**kwargs):
        calls.append(kwargs)
        Image.open(kwargs["image"]).verify()
        response = {
            "name": f"Line template {len(calls)}",
            "description": "Synthetic samples",
            "rows": {"mode": "variable", "value": 2},
            "columns": {"mode": "fixed", "value": 2},
            "code": CODE,
            "headers": ["Time", "Value"],
            "values": [[1, 3], [2, 8]],
        }
        if "不读取" in kwargs["prompt"]:
            response["code"] = "import matplotlib.pyplot as plt\nplt.plot([1, 2])"
        kwargs["output"].write_text(json.dumps(response), "utf-8")
        return Done()

    monkeypatch.setattr(ai_bridge, "spawn_structured_codex", spawn)
    manager = WorkbenchManager(tmp_path / "library")
    project_path = tmp_path / "Project"
    project_path.mkdir()
    project = manager.store.create_project("Project", project_path)
    app = Flask(__name__)
    app.register_blueprint(create_blueprint(manager))
    client = app.test_client()
    base = "/api/workbench/imitation"
    try:
        started = client.post(
            base,
            data={
                "image": (_image(), "reference.png"),
                "model": "codex-sol",
                "scope": "project",
                "project_id": project["id"],
            },
        )
        assert started.status_code == 200, started.get_json()
        sid = started.get_json()["id"]
        route = f"{base}/{sid}"
        first = _wait(client, "ready")["candidate"]
        assert calls[0]["model"] == "codex-sol"
        assert "prompt" not in client.get(base).get_json()["task"]
        assert (client.get(f"{route}/reference").data).startswith(b"\x89PNG")
        assert client.post(f"{route}/adjust", json={"prompt": "不读取 Excel"}).status_code == 200
        failed = _wait(client, "failed")
        assert "实际读取" in failed["error"]
        assert failed["candidate"]["run_id"] == first["run_id"]
        assert client.post(f"{route}/apply").status_code == 409
        assert client.post(f"{route}/adjust", json={"prompt": "改用淡蓝色"}).status_code == 200
        ready = _wait(client, "ready")
        assert "Line template 1" in calls[-1]["prompt"] and "改用淡蓝色" in calls[-1]["prompt"]
        assert client.get(first["preview_url"]).status_code == 404
        candidate = ready["candidate"]
        assert candidate["data"]["values"] == [[1, 3], [2, 8]]
        assert client.get(candidate["preview_url"]).data.startswith(b"\x89PNG")
        task_dir = calls[-1]["image"].parent
        render_dir = Path(manager.service.jobs[candidate["run_id"]]["directory"])
        cache = manager.store.project_dir(project["id"]) / "cache"
        assert task_dir.parent == render_dir.parent == cache
        assert {file.name for file in (render_dir / "inputs").iterdir()} == {
            "source.py",
            "data.xlsx",
        }
        saved = client.post(f"{route}/apply")
        assert saved.status_code == 200, saved.get_json()
        record = saved.get_json()
        assert record["schema"]["rows"] == {"mode": "variable", "min": 2}
        assert record["schema"]["columns"] == {"mode": "fixed", "value": 2}
        assert record["description"] == "Synthetic samples"
        assert record["scope"] == "project" and record["project_id"] == project["id"]
        folder = manager.store.template_dir(record["id"]) / "revisions" / "1"
        assert (folder / "source.py").read_text("utf-8") == CODE
        with (folder / "data.xlsx").open("rb") as handle:
            book = load_workbook(handle, read_only=True)
            assert list(book["Data"].values) == [("Time", "Value"), (1, 3), (2, 8)]
            book.close()
        assert client.get(base).get_json() == {"task": None}
        assert not task_dir.exists() and not render_dir.exists()
    finally:
        manager.close()
