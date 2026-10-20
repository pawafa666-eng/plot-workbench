"""Render jobs and real Tavotto sessions with verified, atomic completion."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

from tavotto.engine import atomicio, config, patchspec, pool, runtime

from . import data as data_module
from .store import WorkbenchError, inside, read_json

TIMEOUT = 60
_MODULE_ROOT = Path(__file__).resolve().parent


def fingerprint(payload):
    relevant = {k: payload.get(k) for k in ("code", "data", "schema")}
    return hashlib.sha256(
        json.dumps(relevant, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()
    ).hexdigest()


def _data_bootstrap(helper="data_helper.py", data="data.json"):
    return f"""
def _pwb_load_data():
    import importlib.util as _iu
    import json as _json
    import sys as _sys
    from pathlib import Path as _Path
    _root = _Path(__file__).resolve().parent
    _spec = _iu.spec_from_file_location("_pwb_snapshot", _root / {helper!r})
    _module = _iu.module_from_spec(_spec)
    _sys.modules[_spec.name] = _module
    _spec.loader.exec_module(_module)
    return _module.dataframe_from_snapshot(_json.loads((_root / {data!r}).read_text("utf-8")))

def main():
    from pathlib import Path as _Path
    _figure = build_figure(_pwb_load_data())
    _figure.savefig(_Path(__file__).resolve().parent / "figure.pdf", bbox_inches="tight", pad_inches=0)
"""


def executable_code(base_code, patches, *, replay=True):
    """Readable original function plus one generated, versioned execution block."""
    footer = _data_bootstrap()
    if replay:
        footer += f"""
PWB_OVERRIDES = {patches!r}
PWB_ENGINE_VERSION = "0.18.0"

def _pwb_replay():
    import json as _json
    from pathlib import Path as _Path
    from tavotto.engine import pool as _pool
    _here = _Path(__file__).resolve()
    _worker = _pool.one_shot(_here.name, str(_here.parent), "main")
    try:
        _response = _worker.override("figure", PWB_OVERRIDES, inline_svg=True)
        if _response.get("warnings"):
            raise RuntimeError(_json.dumps(_response["warnings"], ensure_ascii=False))
        for _format in ("png", "svg", "pdf"):
            _result = _worker.export("figure", PWB_OVERRIDES, str(_here.with_suffix("." + _format)), _format, 600)
            if _result.get("warnings"):
                raise RuntimeError(str(_result["warnings"]))
    finally:
        _pool.discard(_worker)

if __name__ == "__main__":
    _pwb_replay()
"""
    else:
        footer += """
if __name__ == "__main__":
    from pathlib import Path as _Path
    _fig = build_figure(_pwb_load_data())
    for _fmt in ("png", "svg", "pdf"):
        _fig.savefig(_Path(__file__).with_suffix("." + _fmt), dpi=600, bbox_inches="tight", pad_inches=0)
"""
    return (
        base_code.rstrip()
        + "\n\n# >>> Plot Workbench generated execution block >>>\n"
        + footer
        + "# <<< Plot Workbench generated execution block <<<\n"
    )


def _terminate(process):
    if process.poll() is None:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=runtime.CREATE_NO_WINDOW,
                timeout=5,
                check=False,
            )
        else:
            process.kill()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


class RenderService:
    def __init__(self, store, jobs_root=None):
        self.store = store
        self.root = Path(jobs_root or config.data_dir() / "workbench-jobs").resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.jobs = {}
        self.latest = {}
        self.sessions = {}

    def render(self, payload, plot_id=None):
        if plot_id:
            self.store.assert_editable(plot_id)
        if not isinstance(payload.get("code"), str) or not payload["code"].strip():
            raise WorkbenchError("请提供绘图代码")
        if len(payload["code"].encode("utf-8")) > 2_000_000:
            raise WorkbenchError("代码文件超过 2 MB")
        schema = payload.get("schema") or {}
        if payload.get("data") is not None:
            issues = data_module.validate_schema(payload["data"], schema)
            if issues:
                raise WorkbenchError(
                    "；".join(issue["message"] for issue in issues), "data_schema_mismatch"
                )
        payload = copy.deepcopy({**payload, "schema": schema})
        job_id = uuid.uuid4().hex
        directory = inside(self.root, job_id)
        directory.mkdir()
        atomicio.write_bytes(directory / "base.py", payload["code"].encode("utf-8"))
        atomicio.write_json(
            directory / "input.json",
            {
                "data": payload.get("data"),
                "schema": schema,
                "data_helper": str(_MODULE_ROOT / "data.py"),
            },
        )
        job = {
            "id": job_id,
            "status": "running",
            "plot_id": plot_id,
            "payload": payload,
            "requested_payload": copy.deepcopy(payload),
            "fingerprint": fingerprint(payload),
            "directory": str(directory),
            "cancel": threading.Event(),
            "process": None,
            "created": time.monotonic(),
        }
        with self.lock:
            self.jobs[job_id] = job
            if plot_id:
                self.latest[plot_id] = job_id
        threading.Thread(
            target=self._run, args=(job,), daemon=True, name=f"pwb-render-{job_id[:8]}"
        ).start()
        return job_id

    def _run(self, job):
        directory = Path(job["directory"])
        try:
            if job["cancel"].is_set():
                job["status"] = "cancelled"
                return
            python, source = pool.resolve_worker_python(str(directory), script="base.py")
            bundled = source == pool.SOURCE_BUNDLED
            env = runtime.probe_env(python, bundled=bundled)
            env["MPLBACKEND"] = "Agg"
            env["PYTHONIOENCODING"] = "utf-8"
            env["TAVOTTO_NO_TELEMETRY"] = "1"
            env["MPLCONFIGDIR"] = str(directory / "mpl-cache")
            args = [
                python,
                *runtime.probe_args(bundled=bundled),
                str(_MODULE_ROOT / "runner.py"),
                str(directory),
            ]
            log_path = directory / "output.log"
            with open(log_path, "wb") as log:
                process = subprocess.Popen(
                    args,
                    stdin=subprocess.DEVNULL,
                    stdout=log,
                    stderr=log,
                    cwd=directory,
                    env=env,
                    creationflags=runtime.CREATE_NO_WINDOW,
                )
                job["process"] = process
                started = time.monotonic()
                while process.poll() is None:
                    if job["cancel"].is_set():
                        _terminate(process)
                        job["status"] = "cancelled"
                        return
                    if time.monotonic() - started >= TIMEOUT:
                        _terminate(process)
                        raise WorkbenchError("绘图超过 60 秒，进程已停止", "render_timeout")
                    if log_path.stat().st_size > 16 * 1024 * 1024:
                        _terminate(process)
                        raise WorkbenchError("代码输出过多，绘图进程已停止", "output_limit")
                    time.sleep(0.05)
                process.wait()
            if job["cancel"].is_set():
                job["status"] = "cancelled"
                return
            if process.returncode:
                report = read_json(directory / "error.json", {})
                tail = log_path.read_bytes()[-32768:].decode("utf-8", "replace")
                job.update(
                    {
                        "status": "error",
                        "error": report.get("error", "绘图进程运行失败"),
                        "traceback": report.get("traceback", tail),
                    }
                )
                return
            result = read_json(directory / "result.json")
            environment = result.get("environment", {})
            atomicio.write_json(directory / "environment.json", environment)
            job["payload"]["data"] = result["data"]
            job["environment"] = environment
            job["fingerprint"] = fingerprint(job["payload"])
            job["result"] = {
                "run_id": job["id"],
                "preview_url": f"/api/workbench/jobs/{job['id']}/artifact/figure.png",
                "data": result["data"],
                "schema": result["schema"],
                "environment": environment,
            }
            job["status"] = "success"
        except Exception as error:
            if not job["cancel"].is_set():
                job.update(
                    {
                        "status": "error",
                        "error": str(error),
                        "traceback": getattr(error, "traceback_text", ""),
                    }
                )
        finally:
            process = job.get("process")
            if process is not None and process.poll() is None:
                _terminate(process)
            if job["cancel"].is_set():
                job["status"] = "cancelled"

    def job(self, job_id):
        job = self.jobs.get(job_id)
        if not job:
            raise WorkbenchError("绘图任务不存在，请重新运行", "job_not_found", 404)
        return {k: job[k] for k in ("id", "status", "error", "traceback", "result") if k in job}

    def cancel_job(self, job_id):
        self.job(job_id)
        self.jobs[job_id]["cancel"].set()

    def cancel_plot(self, plot_id):
        """Stop pending runs and editor sessions before a plot enters the trash."""
        for job in self.jobs.values():
            if job.get("plot_id") == plot_id:
                job["cancel"].set()
        for sid, session in list(self.sessions.items()):
            if session.get("plot_id") == plot_id:
                self.cancel_session(sid)

    def successful_run(self, job_id, plot_id=None):
        self.job(job_id)
        job = self.jobs[job_id]
        if job["status"] != "success" or job["cancel"].is_set():
            raise WorkbenchError("当前版本尚未成功运行，不能保存", "run_not_successful", 409)
        if plot_id and (job["plot_id"] != plot_id or self.latest.get(plot_id) != job_id):
            raise WorkbenchError("运行结果已过期，请重新运行当前版本", "stale_run", 409)
        return job

    def save_plot(self, plot_id, run_id):
        with self.lock:
            job = self.successful_run(run_id, plot_id)
            payload = job["payload"]
            source = {"kind": "external"}
            if payload.get("template_id"):
                template = self.store.get_template(payload["template_id"])
                source = {
                    "kind": "template",
                    "template_id": template["id"],
                    "template_revision": template["revision"],
                    "template_name": template["name"],
                }
            if payload.get("original_path"):
                source["original_path"] = payload["original_path"]
            return self.store.commit_plot(
                plot_id,
                {
                    "code": payload["code"],
                    "data": payload["data"],
                    "schema": payload["schema"],
                    "source": source,
                    "overrides": [],
                    "environment": job.get("environment", {}),
                },
                job["directory"],
            )

    def export_path(self, plot_id, fmt):
        if fmt not in ("png", "svg", "pdf"):
            raise WorkbenchError("不支持的图片格式")
        plot = self.store.get_plot(plot_id)
        if not plot.get("revision"):
            raise WorkbenchError("请先成功运行并保存子图", "unsaved_plot", 409)
        latest = self.latest.get(plot_id)
        if latest and plot["state"] != "TAVOTTO_ONLY":
            job = self.jobs[latest]
            if job["status"] != "success":
                raise WorkbenchError("当前草稿尚未成功运行，不能导出", "unsaved_draft", 409)
            if any(job["payload"].get(key) != plot.get(key) for key in ("code", "data", "schema")):
                raise WorkbenchError("当前成功结果尚未保存，不能导出旧版本", "unsaved_draft", 409)
        return inside(plot["_artifact_dir"], f"figure.{fmt}")

    def _adapter(self, plot, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        code = plot.get("base_code", plot["code"])
        atomicio.write_bytes(directory / "base.py", code.encode("utf-8"))
        atomicio.write_json(directory / "data.json", plot["data"])
        shutil.copy2(_MODULE_ROOT / "data.py", directory / "data_helper.py")
        adapter = """import importlib.util
import sys
from pathlib import Path
_ROOT = Path(__file__).resolve().parent
_SPEC = importlib.util.spec_from_file_location("pwb_base_figure", _ROOT / "base.py")
_BASE = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = _BASE
_SPEC.loader.exec_module(_BASE)
build_figure = _BASE.build_figure
""" + _data_bootstrap()
        atomicio.write_bytes(directory / "adapter.py", adapter.encode("utf-8"))
        return directory

    def open_session(self, plot_id):
        plot = self.store.get_plot(plot_id)
        if not plot.get("revision"):
            raise WorkbenchError("请先运行并保存当前子图", "unsaved_plot", 409)
        sid = uuid.uuid4().hex
        directory = self._adapter(plot, inside(self.root, f"session-{sid}"))
        worker = pool.one_shot("adapter.py", str(directory), "main")
        session = {
            "id": sid,
            "plot_id": plot_id,
            "revision": plot["revision"],
            "plot": copy.deepcopy(plot),
            "worker": worker,
            "directory": str(directory),
            "patches": plot.get("overrides", []),
            "lock": threading.RLock(),
            "closed": False,
        }
        self.sessions[sid] = session
        try:
            response = self._session_render(session, session["patches"])
            return {
                "session_id": sid,
                "stem": "figure",
                "script": "adapter.py",
                "project": str(directory),
                "manifest": response["manifest"],
                "svg": response.get("svg"),
                "overrides": session["patches"],
                "preview": response.get("preview"),
                "renderRevision": response.get("render_revision", 1),
            }
        except BaseException:
            self.cancel_session(sid)
            raise

    def _session(self, sid):
        session = self.sessions.get(sid)
        if not session or session["closed"]:
            raise WorkbenchError("编辑会话已结束，请重新打开 Tavotto", "session_closed", 409)
        return session

    def _session_render(self, session, patches):
        normalized = (
            patchspec.canonical_patches(patches)
            if hasattr(patchspec, "canonical_patches")
            else patches
        )
        response = session["worker"].override("figure", normalized, inline_svg=True)
        if response.get("warnings"):
            raise WorkbenchError(
                "编辑无法完整应用：" + str(response["warnings"]), "override_warnings", 409
            )
        session["patches"] = copy.deepcopy(normalized)
        session["response"] = response
        return response

    def session_render(self, sid, patches):
        session = self._session(sid)
        with session["lock"]:
            return self._session_render(session, patches)

    def session_preview(self, sid, patches, bucket=1600):
        session = self._session(sid)
        with session["lock"]:
            path = session["worker"].preview_png(
                "figure", patches, max(200, min(int(bucket), 6400)), uuid.uuid4().hex
            )
            destination = Path(session["directory"]) / "preview.png"
            shutil.copy2(path, destination)
            return destination

    def finish_session(self, sid, patches):
        session = self._session(sid)
        with session["lock"]:
            if self.store.get_plot(session["plot_id"])["revision"] != session["revision"]:
                raise WorkbenchError(
                    "子图已发生变化，当前编辑会话不能覆盖新版本", "stale_session", 409
                )
            hot = self._session_render(session, patches)
            directory = Path(session["directory"])
            staged = directory / f"verified-{uuid.uuid4().hex}"
            staged.mkdir()
            clean = pool.one_shot("adapter.py", str(directory), "main")
            try:
                replay = clean.override("figure", session["patches"], inline_svg=True)
                if replay.get("warnings"):
                    raise WorkbenchError("重新绘图未能完整应用编辑", "replay_failed", 409)
                # The same renderer draws both snapshots at the same resolution.
                hot_png = session["worker"].preview_png(
                    "figure", session["patches"], 1600, "verify-hot"
                )
                cold_png = clean.preview_png("figure", session["patches"], 1600, "verify-cold")
                from tavotto import pdfbackend

                pixels = pdfbackend.compare_png(Path(hot_png), Path(cold_png))

                from tavotto import app as tavotto_app

                geometry_diffs, _ = tavotto_app._compare_manifests(
                    hot["manifest"], replay["manifest"]
                )
                if geometry_diffs:
                    raise WorkbenchError(
                        "重放后的图形几何与当前编辑不一致，未保存", "replay_divergence", 409
                    )
                if not _pixels_match(pixels):
                    raise WorkbenchError(
                        "重放后的图片与当前编辑不一致，未保存", "replay_divergence", 409
                    )
                for fmt in ("png", "svg", "pdf"):
                    result = clean.export(
                        "figure", session["patches"], str(staged / f"figure.{fmt}"), fmt, 600
                    )
                    if result.get("warnings"):
                        raise WorkbenchError("导出时无法完整应用编辑", "replay_failed", 409)
                atomicio.write_json(staged / "manifest.json", replay["manifest"])
                shutil.copy2(_MODULE_ROOT / "data.py", staged / "data_helper.py")
                replay_code = executable_code(
                    session["plot"].get("base_code", session["plot"]["code"]), session["patches"]
                )
                plot = self.store.commit_tavotto(
                    session["plot_id"], session["patches"], replay_code, staged
                )
            finally:
                pool.discard(clean)
            self.cancel_session(sid)
            return plot

    def cancel_session(self, sid):
        session = self.sessions.get(sid)
        if session and not session["closed"]:
            session["closed"] = True
            pool.discard(session["worker"])

    def export_code(self, plot_id, directory=None, replace=False):
        # The no-overwrite name allocation and the write form one operation;
        # two exports in this process must not select the same destination.
        with self.lock:
            return self._export_code_locked(plot_id, directory, replace)

    def _export_code_locked(self, plot_id, directory=None, replace=False):
        plot = self.store.get_plot(plot_id)
        if not plot.get("revision"):
            raise WorkbenchError("请先保存成功运行的子图", "unsaved_plot", 409)
        if replace:
            original = plot.get("source", {}).get("original_path")
            if not original:
                raise WorkbenchError(
                    "此子图没有可替换的外部源文件，请选择文件夹另存", "no_original_path", 409
                )
            target = self.store.validate_code_target(original)
        else:
            if not directory:
                raise WorkbenchError("请选择保存代码的文件夹")
            directory = Path(directory).expanduser().resolve()
            target = self.store.validate_code_target(directory / f"plot_{plot_id[:8]}.py")
            suffix = 2
            while target.exists():
                target = self.store.validate_code_target(
                    directory / f"plot_{plot_id[:8]}_{suffix}.py"
                )
                suffix += 1
        return self._write_code_package(plot, target)

    def _write_code_package(self, plot, target):
        target = self.store.validate_code_target(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        assets = target.parent / f"{target.stem}_assets_{uuid.uuid4().hex[:8]}"
        assets.mkdir()
        atomicio.write_json(assets / "data.json", plot["data"])
        shutil.copy2(_MODULE_ROOT / "data.py", assets / "data_helper.py")
        locked = plot["state"] == "TAVOTTO_ONLY"
        code = executable_code(
            plot.get("base_code", plot["code"]), plot.get("overrides", []), replay=locked
        )
        code = code.replace(
            "_root / 'data_helper.py'", f"_root / {f'{assets.name}/data_helper.py'!r}"
        ).replace("_root / 'data.json'", f"_root / {f'{assets.name}/data.json'!r}")
        environment = plot.get("environment") or {}
        packages = environment.get("packages") or {}
        requirements = "".join(
            f"{('tavotto[worker]' if locked and name == 'tavotto' else name)}=={version}\n"
            for name, version in packages.items()
            if name in {"pandas", "matplotlib", "seaborn", "numpy"}
            or (locked and name == "tavotto")
        )
        if locked and "tavotto" not in packages:
            requirements += "tavotto[worker]==0.18.0\n"
        atomicio.write_json(assets / "environment.json", environment)
        atomicio.write_bytes(assets / "requirements.txt", requirements.encode("utf-8"))
        atomicio.write_bytes(
            assets / "README.txt",
            (
                "此目录包含数据快照、读取辅助代码和实际运行环境版本，须与 .py 一起保留。"
                "requirements.txt 固定了绘图时检测到的核心依赖版本。"
                "Tavotto 编辑版在软件外运行需要匹配的 Tavotto 引擎。\n"
            ).encode("utf-8"),
        )
        backup = None
        if target.exists():
            backup = target.with_suffix(f".backup-{uuid.uuid4().hex[:8]}.py")
            atomicio.write_bytes(backup, target.read_bytes())
        atomicio.write_bytes(target, code.encode("utf-8"))
        return {
            "path": str(target),
            "files": [str(target), str(assets)],
            "backup": str(backup) if backup else None,
        }

    def close(self):
        for job in self.jobs.values():
            job["cancel"].set()
        for sid in list(self.sessions):
            self.cancel_session(sid)


def _geometry_signature(manifest):
    """Compare stable geometry only; render revision/timing are intentionally absent."""

    def rounded(value):
        if isinstance(value, float):
            return round(value, 5)
        if isinstance(value, list):
            return [rounded(v) for v in value]
        if isinstance(value, dict):
            return {
                k: rounded(v) for k, v in value.items() if k not in ("timings", "render_revision")
            }
        return value

    return rounded(
        {
            "size_mm": manifest.get("size_mm"),
            "elements": [
                {k: e.get(k) for k in ("gid", "bbox", "anchor", "role")}
                for e in manifest.get("elements", [])
            ],
        }
    )


def _pixels_match(result):
    if isinstance(result, bool):
        return result
    if isinstance(result, dict):
        # Reuse Tavotto's write-back gate exactly; missing metrics fail closed.
        from tavotto.app import REPLAY_PIXEL_TOL

        if not result.get("ok"):
            return False
        try:
            return all(
                float(result[key]) <= tolerance for key, tolerance in REPLAY_PIXEL_TOL.items()
            )
        except (KeyError, TypeError, ValueError):
            return False
    return False
