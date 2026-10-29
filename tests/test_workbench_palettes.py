import pytest
from flask import Flask

from tavotto.workbench.api import WorkbenchManager, create_blueprint


@pytest.fixture
def client(tmp_path):
    app = Flask(__name__)
    manager = WorkbenchManager(tmp_path / "library")
    app.register_blueprint(create_blueprint(manager))
    app.config.update(TESTING=True)
    yield app.test_client()
    manager.close()


def test_palette_library_seed_create_edit_copy_and_delete(client):
    initial = client.get("/api/workbench/palettes").get_json()["palettes"]
    assert len(initial) >= 12
    created = client.post(
        "/api/workbench/palettes", json={"name": "方案 A", "colors": ["#ff0000", "#123456"]}
    )
    assert created.status_code == 200
    first = created.get_json()
    assert first["colors"] == ["#FF0000", "#123456"]
    changed = client.put(
        f"/api/workbench/palettes/{first['id']}",
        json={"name": "方案 A", "colors": ["#FFFFFF", "#000000"]},
    )
    assert changed.status_code == 200
    copy = client.post(
        "/api/workbench/palettes", json={"name": "方案 B", "colors": ["#FFFFFF", "#000000"]}
    ).get_json()
    assert copy["id"] != first["id"]
    assert client.delete(f"/api/workbench/palettes/{first['id']}").status_code == 200
    entries = client.get("/api/workbench/palettes").get_json()["palettes"]
    assert copy["id"] in [item["id"] for item in entries]
    assert first["id"] not in [item["id"] for item in entries]


@pytest.mark.parametrize("colors", [[], ["red"], ["#12"], ["#00000000"], ["#FF0000"] * 1025])
def test_invalid_palette_does_not_write(client, colors):
    before = client.get("/api/workbench/palettes").get_json()
    response = client.post("/api/workbench/palettes", json={"name": "无效", "colors": colors})
    assert response.status_code == 400
    assert client.get("/api/workbench/palettes").get_json() == before


def test_palette_file_survives_restart_and_root_isolation(tmp_path):
    from tavotto.workbench.palettes import PaletteStore

    first_root = tmp_path / "first"
    second_root = tmp_path / "second"
    first_root.mkdir()
    second_root.mkdir()
    first = PaletteStore(first_root)
    saved = first.save({"name": "Private", "colors": ["#112233", "#AABBCC"]})
    assert saved in PaletteStore(first_root).list()
    assert saved not in PaletteStore(second_root).list()
    first.delete(saved["id"])
    assert saved not in PaletteStore(first_root).list()


def test_palette_write_failure_preserves_previous_data(tmp_path, monkeypatch):
    from tavotto.workbench.palettes import PaletteStore

    store = PaletteStore(tmp_path)
    before = store.list()
    old = store.path.read_bytes()

    def fail(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr("tavotto.workbench.palettes.atomicio.write_json", fail)
    with pytest.raises(OSError, match="disk full"):
        store.save({"name": "Unsaved", "colors": ["#123456"]})
    assert store.path.read_bytes() == old
    assert store.list() == before
