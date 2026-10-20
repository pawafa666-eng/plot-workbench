"""Regenerate the redistributable synthetic Plot Workbench starter previews."""

from __future__ import annotations

import shutil
import tempfile
import time
from pathlib import Path

from tavotto.workbench.examples import EXAMPLES, example_snapshot
from tavotto.workbench.rendering import RenderService
from tavotto.workbench.store import WorkbenchStore

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="pwb-example-previews-") as scratch:
        root = Path(scratch)
        store = WorkbenchStore(root / "store")
        service = RenderService(store, root / "jobs")
        try:
            for example in EXAMPLES:
                job_id = service.render(
                    {
                        "code": example["code"],
                        "data": example_snapshot(example),
                        "schema": example["schema"],
                    }
                )
                deadline = time.monotonic() + 65
                while time.monotonic() < deadline:
                    job = service.job(job_id)
                    if job["status"] != "running":
                        break
                    time.sleep(0.05)
                else:
                    raise RuntimeError(f"Preview timed out: {example['name']}")
                if job["status"] != "success":
                    raise RuntimeError(
                        f"Preview failed for {example['name']}: {job.get('error')}\n{job.get('traceback', '')}"
                    )
                source = Path(service.jobs[job_id]["directory"])
                destination = ROOT / "src" / "tavotto" / "workbench" / "previews" / example["key"]
                destination.mkdir(parents=True, exist_ok=True)
                for fmt in ("png", "svg", "pdf"):
                    shutil.copy2(source / f"figure.{fmt}", destination / f"figure.{fmt}")
                print(f"Generated {example['name']} · 600 dpi PNG / SVG / PDF")
        finally:
            service.close()


if __name__ == "__main__":
    main()
