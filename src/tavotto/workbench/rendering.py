"""Render jobs and real Tavotto sessions with verified, atomic completion."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

from tavotto.engine import atomicio, config, patchspec, pool, runtime, workdir

from . import data as data_module
from .assistant import AssistantService
from .store import WorkbenchError, inside, read_json

TIMEOUT = 60
_MODULE_ROOT = Path(__file__).resolve().parent


def fingerprint(payload):
    relevant = {k: payload.get(k) for k in ("code", "data", "schema")}
    return hashlib.sha256(
        json.dumps(relevant, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()
    ).hexdigest()


def executable_code(base_code, patches, *, replay=True, output_overrides=None):
    """Original source and one versioned entry shared by standalone and replay."""
    histories = output_overrides or {"figure": patches}
    footer = f"""
PWB_SOURCE = {base_code!r}
PWB_OVERRIDES = {histories!r}
PWB_ENGINE_VERSION = "0.18.0"

def main(_capture=True):
    import importlib.util as _iu
    import json as _json
    from pathlib import Path as _Path
    _root = _Path(__file__).resolve().parent
    _spec = _iu.spec_from_file_location("_pwb_execution", _root / 'execution.py')
    _helper = _iu.module_from_spec(_spec)
    _spec.loader.exec_module(_helper)
    _context = _json.loads((_root / 'context.json').read_text("utf-8"))
    _context["data_helper"] = str(_root / 'data_helper.py')
    _context["data"] = _json.loads((_root / 'data.json').read_text("utf-8"))
    _context["working_directory"] = str(_root / 'inputs')
    _context["input_directory"] = str(_root / 'inputs')
    _figures, _snapshot = _helper.execute(PWB_SOURCE, _context["data"], _context.get("schema", {{}}),
        working_directory=_context["working_directory"], source_path=_context.get("original_path"),
        data_helper=_context["data_helper"], input_directory=_context["input_directory"],
        input_files=_context.get("input_files", []), original_directory=_context.get("original_directory"),
        legacy_template=_context.get("legacy_template", False))
    for _index, _fig in enumerate(_figures):
        _stem = "figure" if _index == 0 else f"figure_{{_index + 1}}"
        if _capture:
            _fig.savefig(_root / (_stem + ".pdf"), bbox_inches="tight", pad_inches=0)
    return _figures
"""
    if replay:
        footer += """
def _pwb_replay():
    import json as _json
    from pathlib import Path as _Path
    from tavotto.engine import pool as _pool
    _here = _Path(__file__).resolve()
    _worker = _pool.one_shot(_here.name, str(_here.parent), "main")
    try:
        for _index, (_stem, _patches) in enumerate(PWB_OVERRIDES.items()):
            _response = _worker.override(_stem, _patches, inline_svg=True)
            if _response.get("warnings"):
                raise RuntimeError(_json.dumps(_response["warnings"], ensure_ascii=False))
            for _format in ("png", "svg", "pdf"):
                _target = _here.with_suffix("." + _format) if _index == 0 else _here.with_name(_here.stem + "_" + _stem + "." + _format)
                _result = _worker.export(_stem, _patches, str(_target), _format, 600)
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
    _figures = main(_capture=False)
    for _index, _fig in enumerate(_figures):
        for _fmt in ("png", "svg", "pdf"):
            _path = _Path(__file__).with_suffix("." + _fmt) if _index == 0 else _Path(__file__).with_name(_Path(__file__).stem + "_figure_" + str(_index + 1) + "." + _fmt)
            _fig.savefig(_path, dpi=600, bbox_inches="tight", pad_inches=0)
"""
    return (
        "# >>> Plot Workbench generated execution block >>>\n"
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
        self.assistant = AssistantService(self.root / "assistant")
        self.closed = False

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
        working_directory = None
        if plot_id:
            plot = self.store.get_plot(plot_id)
            working_directory = str(self.store.working_directory(plot["project_id"]))
            directory = inside(self.store.project_dir(plot["project_id"]), f"cache/runs/{job_id}")
        else:
            directory = inside(self.root, job_id)
        directory.mkdir(parents=True)
        shutil.copy2(_MODULE_ROOT / "data.py", directory / "data_helper.py")
        shutil.copy2(_MODULE_ROOT / "execution.py", directory / "execution.py")
        atomicio.write_bytes(directory / "base.py", payload["code"].encode("utf-8"))
        atomicio.write_json(
            directory / "input.json",
            {
                "data": payload.get("data"),
                "schema": schema,
                "data_helper": str(directory / "data_helper.py"),
                "working_directory": working_directory or str(directory),
                "original_path": payload.get("original_path"),
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
            "working_directory": working_directory or str(directory),
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
            python, source = pool.resolve_worker_python(job["working_directory"], script="base.py")
            bundled = source == pool.SOURCE_BUNDLED
            env = runtime.probe_env(python, bundled=bundled)
            if env is None:
                env = os.environ.copy()
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
            job["outputs"] = result.get("outputs", [{"stem": "figure", "title": "图 1"}])
            job["input_files"] = result.get("input_files", [])
            job["fingerprint"] = fingerprint(job["payload"])
            job["result"] = {
                "run_id": job["id"],
                "preview_url": f"/api/workbench/jobs/{job['id']}/artifact/figure.png",
                "data": result["data"],
                "schema": result["schema"],
                "environment": environment,
                "outputs": [
                    {
                        **item,
                        "preview_url": f"/api/workbench/jobs/{job['id']}/artifact/{item['stem']}.png",
                    }
                    for item in job["outputs"]
                ],
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
                root = Path(job["working_directory"])
                original = Path(payload["original_path"]).resolve()
                if original.is_relative_to(root):
                    source["original_relative_path"] = original.relative_to(root).as_posix()
            return self.store.commit_plot(
                plot_id,
                {
                    "code": payload["code"],
                    "data": payload["data"],
                    "schema": payload["schema"],
                    "source": source,
                    "overrides": [],
                    "environment": job.get("environment", {}),
                    "outputs": job["outputs"],
                    "input_files": job.get("input_files", []),
                    "execution_version": 2,
                },
                job["directory"],
            )

    def export_path(self, plot_id, fmt, stem="figure"):
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
        self._output(plot, stem)
        return inside(plot["_artifact_dir"], f"{stem}.{fmt}")

    @staticmethod
    def _output(plot, stem):
        outputs = plot.get("outputs") or [{"stem": "figure", "title": "图 1"}]
        if not re.fullmatch(r"figure(?:_[2-9][0-9]*|_1[0-9]+)?", str(stem)) or stem not in {
            item["stem"] for item in outputs
        }:
            raise WorkbenchError("图形不存在", "output_not_found", 404)
        return next(item for item in outputs if item["stem"] == stem)

    def _adapter(self, plot, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        code = plot.get("base_code", plot["code"])
        atomicio.write_bytes(directory / "base.py", code.encode("utf-8"))
        atomicio.write_json(directory / "data.json", plot["data"])
        for filename, fallback in (("data_helper.py", "data.py"), ("execution.py", "execution.py")):
            frozen = Path(plot["_artifact_dir"]) / filename
            shutil.copy2(
                frozen if frozen.is_file() else _MODULE_ROOT / fallback, directory / filename
            )
        working_directory = self.store.working_directory(plot["project_id"])
        source_inputs = Path(plot["_artifact_dir"]) / "inputs"
        if source_inputs.is_dir():
            shutil.copytree(source_inputs, directory / "inputs", dirs_exist_ok=True)
        else:
            (directory / "inputs").mkdir(exist_ok=True)
        atomicio.write_json(
            directory / "input.json",
            {
                "data": plot.get("data"),
                "schema": plot.get("schema") or {},
                "working_directory": str(working_directory),
                "original_directory": str(working_directory),
                "original_path": plot.get("source", {}).get("original_path"),
                "data_helper": str(directory / "data_helper.py"),
                "input_directory": str(directory / "inputs"),
                "input_files": plot.get("input_files", []),
                "legacy_template": not plot.get("execution_version"),
            },
        )
        adapter = """import importlib.util
import json
from pathlib import Path
_ROOT = Path(__file__).resolve().parent
_SPEC = importlib.util.spec_from_file_location("_pwb_execution", _ROOT / "execution.py")
_HELPER = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_HELPER)
def main():
    return _HELPER.capture(json.loads((_ROOT / "input.json").read_text("utf-8")), directory=_ROOT)
"""
        atomicio.write_bytes(directory / "adapter.py", adapter.encode("utf-8"))
        return directory

    def _session_worker(self, session):
        root = self.store.working_directory(session["plot"]["project_id"])
        # Selecting the folder is the user's explicit project-cwd decision.
        workdir.set_mode(root, workdir.MODE_PROJECT_ROOT)
        script = (Path(session["directory"]) / "adapter.py").relative_to(root).as_posix()
        return pool.one_shot(script, str(root), "main")

    def open_session(self, plot_id, stem="figure"):
        plot = self.store.get_plot(plot_id)
        if not plot.get("revision"):
            raise WorkbenchError("请先运行并保存当前子图", "unsaved_plot", 409)
        self.export_path(plot_id, "png", stem)
        self._output(plot, stem)
        sid = uuid.uuid4().hex
        directory = self._adapter(
            plot, inside(self.store.project_dir(plot["project_id"]), f"cache/sessions/{sid}")
        )
        histories = plot.get("output_overrides") or {"figure": plot.get("overrides", [])}
        session = {
            "id": sid,
            "plot_id": plot_id,
            "revision": plot["revision"],
            "plot": copy.deepcopy(plot),
            "directory": str(directory),
            "stem": stem,
            "patches": histories.get(stem, []),
            "lock": threading.RLock(),
            "closed": False,
        }
        session["worker"] = self._session_worker(session)
        self.sessions[sid] = session
        try:
            response = self._session_render(session, session["patches"])
            return {
                "session_id": sid,
                "stem": stem,
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
        if self.closed or not session or session["closed"]:
            raise WorkbenchError("编辑会话已结束，请重新打开 Tavotto", "session_closed", 409)
        return session

    @staticmethod
    def _assistant_token(session, patches):
        content = {
            "base": session["plot"].get("base_code", session["plot"]["code"]),
            "generation": session.get("code_generation", 0),
            "revision": session["revision"],
            "patches": patches,
        }
        return hashlib.sha256(
            json.dumps(content, sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest()

    def start_assistant(self, body):
        sid = body.get("session_id")
        if sid is None:
            return self.assistant.start(
                code=body.get("code"),
                prompt=body.get("prompt"),
                schema=body.get("schema"),
                data_context=body.get("data_context"),
                model=body.get("model"),
                effort=body.get("effort"),
            )
        if not isinstance(sid, str):
            raise WorkbenchError("编辑会话标识无效")
        session = self._session(sid)
        with session["lock"]:
            patches = body.get("patches", [])
            if patches != session["patches"]:
                raise WorkbenchError(
                    "图内修改尚未同步，请同步后再使用 Codex", "stale_assistant", 409
                )
            return self.assistant.start(
                code=session["plot"].get("base_code", session["plot"]["code"]),
                prompt=body.get("prompt"),
                schema=session["plot"].get("schema"),
                data_context=session["plot"].get("data"),
                model=body.get("model"),
                effort=body.get("effort"),
                owner=sid,
                token=self._assistant_token(session, patches),
                context={"stem": session["stem"], "overrides": patches},
            )

    @staticmethod
    def _session_payload(session):
        response = session["response"]
        return {
            "session_id": session["id"],
            "stem": session["stem"],
            "script": "adapter.py",
            "project": session["directory"],
            "manifest": response["manifest"],
            "svg": response.get("svg"),
            "overrides": session["patches"],
            "preview": response.get("preview"),
            "renderRevision": response.get("render_revision", 1),
        }

    @staticmethod
    def _session_histories(session, patches):
        plot = session["plot"]
        histories = {item["stem"]: [] for item in plot.get("outputs", [{"stem": "figure"}])}
        histories.update(
            copy.deepcopy(plot.get("output_overrides") or {"figure": plot.get("overrides", [])})
        )
        histories[session["stem"]] = copy.deepcopy(patches)
        return histories

    def apply_assistant(self, sid, task_id, patches):
        session = self._session(sid)
        with session["lock"]:
            self._session(sid)
            if self.store.get_plot(session["plot_id"])["revision"] != session["revision"]:
                raise WorkbenchError("子图已发生变化，请重新打开编辑会话", "stale_session", 409)
            if patches != session["patches"]:
                raise WorkbenchError(
                    "图内编辑已发生变化，请重新让 Codex 修改", "stale_assistant", 409
                )
            code = self.assistant.proposal(
                task_id, owner=sid, token=self._assistant_token(session, patches)
            )
            if code == session["plot"].get("base_code", session["plot"]["code"]):
                return self._session_payload(session)
            candidate = {**session, "plot": copy.deepcopy(session["plot"])}
            candidate["plot"]["base_code"] = code
            directory = Path(session["directory"]).parent / uuid.uuid4().hex
            candidate["directory"] = str(self._adapter(candidate["plot"], directory))
            worker = self._session_worker(candidate)
            candidate["worker"] = worker
            try:
                histories = self._session_histories(candidate, patches)
                built = worker.ensure_built()
                self._check_assistant_inputs(session, built)
                if set(built.get("stems", {})) != set(histories):
                    raise WorkbenchError(
                        "Codex 改变了出图数量，请保留原有图形后重试",
                        "assistant_outputs_changed",
                        409,
                    )
                for stem, history in histories.items():
                    result = worker.override(stem, history, inline_svg=True)
                    if result.get("warnings"):
                        raise WorkbenchError(
                            "Codex 结果无法保留已有图内编辑，未应用", "override_warnings", 409
                        )
                self._session_render(candidate, patches)
                # A root close can start while this lock is held. Never accept
                # a candidate from that closed service/session generation.
                self._session(sid)
            except pool.WorkerError as exc:
                pool.discard(worker)
                raise WorkbenchError(
                    f"Codex 候选代码无法运行，未应用：{exc}", "assistant_render_failed", 409
                ) from exc
            except BaseException:
                pool.discard(worker)
                raise
            candidate["code_changed"] = True
            candidate["code_generation"] = session.get("code_generation", 0) + 1
            previous_worker = session["worker"]
            # Queued render/preview requests may already hold this dict and lock.
            # Keep its identity so they observe the accepted candidate worker.
            session.update(candidate)
            pool.discard(previous_worker)
            return self._session_payload(session)

    def _check_assistant_inputs(self, session, built):
        # Keep Tavotto's frozen data contract. The worker's Python file observer
        # covers project files/local modules; its documented blind channels
        # (native readers, network, databases) are not claimed as covered here.
        inputs = (built.get("runtime") or {}).get("inputs") or {}
        allowed = {item["path"] for item in session["plot"].get("input_files", [])}
        root = self.store.working_directory(session["plot"]["project_id"])
        # The owned session/artifact directories exist in both storage layouts;
        # a v1 working directory must never be exempted wholesale.
        owned = [
            Path(session["directory"]).parent.resolve(),
            Path(session["plot"]["_artifact_dir"]).resolve(),
        ]
        for item in inputs.get("files", []) + inputs.get("local_modules", []):
            relative = Path(item["path"])
            actual = (root / relative).resolve()
            if any(actual.is_relative_to(directory) for directory in owned):
                continue
            if relative.as_posix() not in allowed:
                raise WorkbenchError(
                    "Codex 引用了新的项目数据或模块，未应用。图内编辑须沿用已保存的数据；更换数据请新建图。",
                    "assistant_inputs_changed",
                    409,
                )

    def _session_render(self, session, patches):
        normalized = (
            patchspec.canonical_patches(patches)
            if hasattr(patchspec, "canonical_patches")
            else patches
        )
        response = session["worker"].override(session["stem"], normalized, inline_svg=True)
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
            self._session(sid)
            return self._session_render(session, patches)

    def session_preview(self, sid, patches, bucket=1600):
        session = self._session(sid)
        with session["lock"]:
            self._session(sid)
            path = session["worker"].preview_png(
                session["stem"], patches, max(200, min(int(bucket), 6400)), uuid.uuid4().hex
            )
            destination = Path(session["directory"]) / "preview.png"
            shutil.copy2(path, destination)
            return destination

    def finish_session(self, sid, patches):
        session = self._session(sid)
        with session["lock"]:
            self._session(sid)
            if self.store.get_plot(session["plot_id"])["revision"] != session["revision"]:
                raise WorkbenchError(
                    "子图已发生变化，当前编辑会话不能覆盖新版本", "stale_session", 409
                )
            if session.get("code_changed"):
                return self._finish_assistant_session(session, patches)
            hot = self._session_render(session, patches)
            directory = Path(session["directory"])
            staged = directory / f"v-{uuid.uuid4().hex[:8]}"
            staged.mkdir()
            clean = self._session_worker(session)
            stem = session["stem"]
            try:
                replay = clean.override(stem, session["patches"], inline_svg=True)
                if replay.get("warnings"):
                    raise WorkbenchError("重新绘图未能完整应用编辑", "replay_failed", 409)
                # The same renderer draws both snapshots at the same resolution.
                hot_png = session["worker"].preview_png(
                    stem, session["patches"], 1600, "verify-hot"
                )
                cold_png = clean.preview_png(stem, session["patches"], 1600, "verify-cold")
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
                from .store import copy_artifacts

                copy_artifacts(
                    session["plot"]["_artifact_dir"], staged, session["plot"].get("outputs", [])
                )
                for fmt in ("png", "svg", "pdf"):
                    result = clean.export(
                        stem, session["patches"], str(staged / f"{stem}.{fmt}"), fmt, 600
                    )
                    if result.get("warnings"):
                        raise WorkbenchError("导出时无法完整应用编辑", "replay_failed", 409)
                atomicio.write_json(staged / "manifest.json", replay["manifest"])
                shutil.copy2(directory / "data_helper.py", staged / "data_helper.py")
                histories = {
                    item["stem"]: []
                    for item in session["plot"].get("outputs", [{"stem": "figure"}])
                }
                histories.update(
                    session["plot"].get("output_overrides")
                    or {"figure": session["plot"].get("overrides", [])}
                )
                histories[stem] = session["patches"]
                replay_code = executable_code(
                    session["plot"].get("base_code", session["plot"]["code"]),
                    session["patches"],
                    output_overrides=histories,
                )
                plot = self.store.commit_tavotto(
                    session["plot_id"],
                    histories.get("figure", []),
                    replay_code,
                    staged,
                    output_overrides=histories,
                    expected_revision=session["revision"],
                )
            finally:
                pool.discard(clean)
            self.cancel_session(sid)
            return plot

    def _finish_assistant_session(self, session, patches):
        """A changed base must verify/export all figures, including inactive ones."""
        from tavotto import app as tavotto_app, pdfbackend

        from .store import copy_artifacts

        self._session_render(session, patches)
        histories = self._session_histories(session, session["patches"])
        directory = Path(session["directory"])
        staged = directory / f"v-{uuid.uuid4().hex[:8]}"
        staged.mkdir()
        copy_artifacts(session["plot"]["_artifact_dir"], staged, session["plot"].get("outputs", []))
        clean = self._session_worker(session)
        try:
            built = clean.ensure_built()
            self._check_assistant_inputs(session, built)
            if set(built.get("stems", {})) != set(histories):
                raise WorkbenchError("重新绘图的图形集合发生变化，未保存", "replay_divergence", 409)
            for stem, history in histories.items():
                hot = session["worker"].override(stem, history, inline_svg=True)
                replay = clean.override(stem, history, inline_svg=True)
                if hot.get("warnings") or replay.get("warnings"):
                    raise WorkbenchError("重新绘图未能完整应用编辑，未保存", "replay_failed", 409)
                geometry_diffs, _ = tavotto_app._compare_manifests(
                    hot["manifest"], replay["manifest"]
                )
                hot_png = session["worker"].preview_png(stem, history, 1600, f"verify-hot-{stem}")
                cold_png = clean.preview_png(stem, history, 1600, f"verify-cold-{stem}")
                pixels = pdfbackend.compare_png(Path(hot_png), Path(cold_png))
                if geometry_diffs or not _pixels_match(pixels):
                    raise WorkbenchError(
                        "重放后的图形与当前编辑不一致，未保存", "replay_divergence", 409
                    )
                for fmt in ("png", "svg", "pdf"):
                    exported = clean.export(stem, history, str(staged / f"{stem}.{fmt}"), fmt, 600)
                    if exported.get("warnings"):
                        raise WorkbenchError("导出无法完整应用编辑，未保存", "replay_failed", 409)
                if stem == "figure":
                    atomicio.write_json(staged / "manifest.json", replay["manifest"])
            shutil.copy2(directory / "data_helper.py", staged / "data_helper.py")
            base_code = session["plot"]["base_code"]
            replay_code = executable_code(
                base_code, histories.get("figure", []), output_overrides=histories
            )
            plot = self.store.commit_tavotto(
                session["plot_id"],
                histories.get("figure", []),
                replay_code,
                staged,
                output_overrides=histories,
                base_code=base_code,
                expected_revision=session["revision"],
            )
        finally:
            pool.discard(clean)
        self.cancel_session(session["id"])
        return plot

    def cancel_session(self, sid):
        session = self.sessions.get(sid)
        if session:
            with session["lock"]:
                if not session["closed"]:
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
        self.export_path(plot_id, "png")
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
        for filename, fallback in (("data_helper.py", "data.py"), ("execution.py", "execution.py")):
            frozen = Path(plot["_artifact_dir"]) / filename
            shutil.copy2(frozen if frozen.is_file() else _MODULE_ROOT / fallback, assets / filename)
        inputs = Path(plot["_artifact_dir"]) / "inputs"
        if inputs.is_dir():
            shutil.copytree(inputs, assets / "inputs")
        else:
            (assets / "inputs").mkdir()
        atomicio.write_json(
            assets / "context.json",
            {
                "schema": plot.get("schema") or {},
                "original_path": plot.get("source", {}).get("original_path"),
                "original_directory": str(self.store.working_directory(plot["project_id"])),
                "input_files": plot.get("input_files", []),
                "legacy_template": not plot.get("execution_version"),
            },
        )
        atomicio.write_bytes(
            assets / "original.py", plot.get("base_code", plot["code"]).encode("utf-8")
        )
        locked = plot["state"] == "TAVOTTO_ONLY"
        histories = {item["stem"]: [] for item in plot.get("outputs", [{"stem": "figure"}])}
        histories.update(plot.get("output_overrides") or {"figure": plot.get("overrides", [])})
        code = executable_code(
            plot.get("base_code", plot["code"]),
            plot.get("overrides", []),
            replay=locked,
            output_overrides=histories,
        )
        for filename in ("data_helper.py", "data.json", "execution.py", "context.json", "inputs"):
            code = code.replace(f"_root / {filename!r}", f"_root / {f'{assets.name}/{filename}'!r}")
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
        self.closed = True
        self.assistant.close()
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
