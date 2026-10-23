"""Installed-sidecar smoke for the authenticated Plot Workbench API."""

from __future__ import annotations

import argparse
import json
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path


def _request(base_url: str, path: str, *, method="GET", body=None, headers=None, content_type=None):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    request_headers = dict(headers or {})
    if data is not None:
        request_headers["Content-Type"] = "application/json"
    if content_type:
        request_headers["Content-Type"] = content_type
    req = urllib.request.Request(
        base_url.rstrip("/") + path, data=data, headers=request_headers, method=method
    )
    try:
        with urllib.request.urlopen(req, timeout=70) as response:
            raw = response.read()
            return response.status, raw, response.headers
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            detail = json.loads(raw.decode("utf-8"))
        except Exception:
            detail = raw[:500].decode("utf-8", "replace")
        raise RuntimeError(f"Workbench API {method} {path} returned {exc.code}: {detail}") from None


def _json(base_url, path, *, method="GET", body=None, headers=None):
    status, raw, _ = _request(base_url, path, method=method, body=body, headers=headers)
    if status != 200:
        raise RuntimeError(f"Workbench API {method} {path} returned {status}")
    return json.loads(raw.decode("utf-8"))


def _multipart(base_url, path, *, filename, payload, fields, headers):
    boundary = "----PlotWorkbench" + uuid.uuid4().hex
    chunks = []
    for key, value in fields.items():
        chunks.extend(
            (
                f"--{boundary}\r\n".encode(),
                f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode(),
                str(value).encode("utf-8"),
                b"\r\n",
            )
        )
    chunks.extend(
        (
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode(),
            b"Content-Type: text/csv\r\n\r\n",
            payload,
            b"\r\n",
            f"--{boundary}--\r\n".encode(),
        )
    )
    # The multipart body is intentionally assembled locally; no third-party HTTP
    # package is needed in the frozen runtime.
    req = urllib.request.Request(
        base_url.rstrip("/") + path,
        data=b"".join(chunks),
        headers={**(headers or {}), "Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=70) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        raise RuntimeError(
            f"Workbench API POST {path} returned {exc.code}: {raw[:500].decode('utf-8', 'replace')}"
        ) from None


def _settle(base_url, job_id, headers):
    deadline = time.monotonic() + 65
    while time.monotonic() < deadline:
        job = _json(base_url, f"/api/workbench/jobs/{job_id}", headers=headers)
        if job["status"] != "running":
            if job["status"] != "success":
                raise RuntimeError(
                    f"Workbench render failed: {job.get('error')}\n{job.get('traceback', '')}"
                )
            return job
        time.sleep(0.1)
    raise RuntimeError("Workbench render did not finish within 65 seconds")


def smoke_workbench(base_url: str, headers: dict[str, str] | None = None) -> None:
    """Exercise status, root switching, CSV selection, render, save and export.

    The smoke temporarily selects an isolated folder and always restores the
    original data root, so it does not add test projects to a user's workspace.
    """
    auth = headers or {}
    status = _json(base_url, "/api/workbench/status", headers=auth)
    original_root = status["root"]
    with tempfile.TemporaryDirectory(prefix="plot-workbench-smoke-") as scratch:
        try:
            isolated = _json(
                base_url, "/api/workbench/root", method="POST", body={"path": scratch}, headers=auth
            )
            assert Path(isolated["root"]).resolve() == Path(scratch).resolve()
            seeded = _json(base_url, "/api/workbench/templates", headers=auth)
            assert len(seeded["templates"]) >= 3
            assert all(item.get("preview_url") for item in seeded["templates"])

            imported = _multipart(
                base_url,
                "/api/workbench/data/inspect",
                filename="smoke.csv",
                payload=b"group,value\na,2\nb,4\nc,3\n",
                fields={"encoding": "utf-8-sig", "delimiter": ","},
                headers=auth,
            )
            selected = _json(
                base_url,
                "/api/workbench/data/select",
                method="POST",
                body={
                    "table_id": imported["table_id"],
                    "rows": [{"start": 1, "end": 0}],
                    "columns": [{"start": 0, "end": 0}],
                    "header": True,
                },
                headers=auth,
            )
            assert (selected["data"]["row_count"], selected["data"]["column_count"]) == (3, 2)

            working_folder = Path(scratch) / "research"
            working_folder.mkdir()
            project = _json(
                base_url,
                "/api/workbench/projects",
                method="POST",
                body={"name": "安装器冒烟", "path": str(working_folder)},
                headers=auth,
            )
            plot = _json(
                base_url,
                f"/api/workbench/projects/{project['id']}/plots",
                method="POST",
                body={"name": "柱状图"},
                headers=auth,
            )
            template = next(item for item in seeded["templates"] if item["name"] == "柱状图")
            rendered = _json(
                base_url,
                f"/api/workbench/plots/{plot['id']}/render",
                method="POST",
                body={
                    "code": template["code"],
                    "data": selected["data"],
                    "schema": template["schema"],
                    "template_id": template["id"],
                },
                headers=auth,
            )
            _settle(base_url, rendered["job_id"], auth)
            saved = _json(
                base_url,
                f"/api/workbench/plots/{plot['id']}/save",
                method="POST",
                body={"run_id": rendered["job_id"]},
                headers=auth,
            )
            assert saved["revision"] == 1
            for fmt in ("png", "svg", "pdf"):
                code, payload, _ = _request(
                    base_url, f"/api/workbench/plots/{plot['id']}/export?format={fmt}", headers=auth
                )
                assert code == 200 and len(payload) > 100
            # Exercise the installed private runtime's ordinary-script route,
            # not only the backwards-compatible function template above.
            values = working_folder / "values.csv"
            values.write_text("x,y\n1,2\n2,4\n", "utf-8")
            multiple = _json(
                base_url,
                f"/api/workbench/projects/{project['id']}/plots",
                method="POST",
                body={"name": "多图脚本"},
                headers=auth,
            )
            script = """import pandas as pd
import matplotlib.pyplot as plt
table = pd.read_csv("values.csv")
for index in range(2):
    fig, ax = plt.subplots(figsize=(2, 2))
    ax.plot(table.x, table.y + index)
    ax.set_title(f"Snapshot {int(table.y.iloc[0])}")
    fig.savefig("must-not-appear.pdf")
    plt.close(fig)
"""
            multi_run = _json(
                base_url,
                f"/api/workbench/plots/{multiple['id']}/render",
                method="POST",
                body={"code": script, "data": None, "schema": {}},
                headers=auth,
            )
            _settle(base_url, multi_run["job_id"], auth)
            multi_saved = _json(
                base_url,
                f"/api/workbench/plots/{multiple['id']}/save",
                method="POST",
                body={"run_id": multi_run["job_id"]},
                headers=auth,
            )
            assert [item["stem"] for item in multi_saved["outputs"]] == ["figure", "figure_2"]
            values.write_text("x,y\n1,999\n2,1000\n", "utf-8")
            session = _json(
                base_url,
                f"/api/workbench/plots/{multiple['id']}/tavotto/open",
                method="POST",
                body={"stem": "figure_2"},
                headers=auth,
            )
            assert "Snapshot 2" in session["svg"]
            patches = [{"gid": "axes_0.xlabel", "prop": "text", "value": "Edited"}]
            locked = _json(
                base_url,
                f"/api/workbench/sessions/{session['session_id']}/finish",
                method="POST",
                body={"patches": patches},
                headers=auth,
            )
            assert locked["state"] == "TAVOTTO_ONLY"
            assert locked["output_overrides"]["figure_2"] == patches
            for stem in ("figure", "figure_2"):
                exported = _json(
                    base_url,
                    f"/api/workbench/plots/{multiple['id']}/export-image",
                    method="POST",
                    body={"format": "png", "stem": stem},
                    headers=auth,
                )
                assert Path(exported["path"]).is_relative_to(working_folder / ".plot-workbench")
                assert Path(exported["path"]).read_bytes().startswith(b"\x89PNG")
            assert {item.name for item in working_folder.iterdir()} == {
                "values.csv",
                ".plot-workbench",
            }
        finally:
            _json(
                base_url,
                "/api/workbench/root",
                method="POST",
                body={"path": original_root},
                headers=auth,
            )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True, help="Installed local sidecar URL")
    parser.add_argument("--token-file", help="Optional file containing a Cookie header value")
    args = parser.parse_args()
    headers = {}
    if args.token_file:
        cookie = Path(args.token_file).read_text("utf-8").strip()
        if cookie:
            headers["Cookie"] = cookie
    smoke_workbench(args.url, headers=headers)
    print("Plot Workbench API smoke passed")


if __name__ == "__main__":
    main()
