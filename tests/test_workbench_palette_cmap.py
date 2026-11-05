import io
import time

import pytest
from PIL import Image, ImageChops

from tavotto.engine import pool
from tavotto.workbench.rendering import RenderService
from tavotto.workbench.store import WorkbenchStore

try:
    WORKER_PY = pool.find_worker_python()
except pool.WorkerError:
    WORKER_PY = None

pytestmark = pytest.mark.skipif(WORKER_PY is None, reason="matplotlib worker unavailable")


@pytest.mark.parametrize("mode", ["continuous", "discrete"])
@pytest.mark.parametrize("gid", ["axes_0.images_0", "axes_1.colorbar"])
def test_palette_colormap_survives_worker_replay_and_restore(tmp_path, mode, gid):
    (tmp_path / "figure.py").write_text(
        "import matplotlib.pyplot as plt\n"
        "def main():\n"
        " fig, ax = plt.subplots()\n"
        " image = ax.imshow([[0, 1], [2, 3]], cmap='viridis')\n"
        " fig.colorbar(image, ax=ax)\n"
        " fig.savefig('Palette.pdf')\n",
        encoding="utf-8",
    )
    value = {"kind": "workbench_palette_v1", "mode": mode, "colors": ["#0000FF", "#FF0000"]}
    patches = [{"gid": gid, "prop": "cmap", "value": value}]
    worker = pool.one_shot("figure.py", str(tmp_path), "main")
    try:
        worker.ensure_built()
        changed = worker.override("Palette", patches, inline_svg=True)
        assert not changed.get("warnings"), changed.get("warnings")
        field = next(
            f
            for e in changed["manifest"]["elements"]
            if e["gid"] == "axes_0.images_0"
            for f in e["editable"]
            if f["prop"] == "cmap"
        )
        assert field["cmap_current"]["custom"]
        assert field["cmap_current"]["discrete"] == (mode == "discrete")
        colorbar = next(
            f
            for e in changed["manifest"]["elements"]
            if e["gid"] == "axes_1.colorbar"
            for f in e["editable"]
            if f["prop"] == "cmap"
        )
        assert colorbar["cmap_current"] == field["cmap_current"]
        first_png = worker.preview_png("Palette", patches, 1200, "first").read_bytes()
        restored = worker.override("Palette", [], inline_svg=True)
        assert not restored.get("warnings")
        assert (
            next(
                f
                for e in restored["manifest"]["elements"]
                if e["gid"] == "axes_0.images_0"
                for f in e["editable"]
                if f["prop"] == "cmap"
            )["value"]
            == "viridis"
        )
    finally:
        pool.discard(worker)
    replay = pool.one_shot("figure.py", str(tmp_path), "main")
    try:
        replay.ensure_built()
        fresh = replay.override("Palette", patches, inline_svg=True)
        assert not fresh.get("warnings")
        second_png = replay.preview_png("Palette", patches, 1200, "second").read_bytes()
        assert (
            ImageChops.difference(
                Image.open(io.BytesIO(first_png)).convert("RGB"),
                Image.open(io.BytesIO(second_png)).convert("RGB"),
            ).getbbox()
            is None
        )
    finally:
        pool.discard(replay)


def test_palette_snapshot_survives_verified_save_and_reopen(tmp_path):
    store = WorkbenchStore(tmp_path / "library")
    service = RenderService(store, tmp_path / "jobs")
    project = store.create_project("P")
    plot = store.create_plot(project["id"], "Heat")
    code = (
        "import matplotlib.pyplot as plt\n"
        "fig, ax = plt.subplots()\n"
        "im = ax.imshow([[0, 1], [2, 3]], cmap='viridis')\n"
        "fig.colorbar(im, ax=ax)\n"
    )
    try:
        job_id = service.render({"code": code, "data": None, "schema": {}}, plot["id"])
        deadline = time.monotonic() + 60
        while service.job(job_id)["status"] == "running" and time.monotonic() < deadline:
            time.sleep(0.05)
        assert service.job(job_id)["status"] == "success", service.job(job_id)
        service.save_plot(plot["id"], job_id)
        session = service.open_session(plot["id"])
        patches = [
            {
                "gid": "axes_0.images_0",
                "prop": "cmap",
                "value": {
                    "kind": "workbench_palette_v1",
                    "mode": "continuous",
                    "colors": ["#0000FF", "#FF0000"],
                },
            }
        ]
        rendered = service.session_render(session["session_id"], patches)
        assert not rendered.get("warnings")
        finished = service.finish_session(session["session_id"], patches)
        assert finished["overrides"] == patches
        reopened = service.open_session(plot["id"])
        assert reopened["overrides"] == patches
        assert next(
            f
            for e in reopened["manifest"]["elements"]
            if e["gid"] == "axes_0.images_0"
            for f in e["editable"]
            if f["prop"] == "cmap"
        )["cmap_current"]["custom"]
    finally:
        service.close()


def test_large_discrete_palette_is_reported_as_discrete(tmp_path):
    (tmp_path / "figure.py").write_text(
        "import matplotlib.pyplot as plt\n"
        "def main():\n"
        " fig, ax = plt.subplots()\n"
        " ax.imshow([[0, 1], [2, 3]])\n"
        " fig.savefig('Palette.pdf')\n",
        encoding="utf-8",
    )
    colors = [f"#{i:02X}0000" for i in range(100)]
    patches = [
        {
            "gid": "axes_0.images_0",
            "prop": "cmap",
            "value": {"kind": "workbench_palette_v1", "mode": "discrete", "colors": colors},
        }
    ]
    worker = pool.one_shot("figure.py", str(tmp_path), "main")
    try:
        worker.ensure_built()
        result = worker.override("Palette", patches)
        assert not result.get("warnings")
        facts = next(
            f
            for e in result["manifest"]["elements"]
            if e["gid"] == "axes_0.images_0"
            for f in e["editable"]
            if f["prop"] == "cmap"
        )["cmap_current"]
        assert facts["discrete"] is True
        assert [item.upper() for item in facts["stops"]] == colors
    finally:
        pool.discard(worker)
