"""Authenticated local HTTP API for Plot Workbench."""

from __future__ import annotations

import io
import json
import re
import tempfile
import threading
import time
import uuid
import zipfile
from pathlib import Path

from flask import Blueprint, jsonify, request, send_file

from tavotto.engine import atomicio, config

from . import VERSION, data as table_data
from .data_process import run_operation
from .rendering import RenderService
from .store import WorkbenchError, WorkbenchStore, checked_id, inside

TABLE_TTL = 15 * 60
TABLE_LIMIT = 24
TABLE_UPLOAD_LIMIT = 128 * 1024 * 1024
ARTIFACTS = {"figure.png", "figure.svg", "figure.pdf", "manifest.json"}


class WorkbenchManager:
    """Own the selected local data root, stores, jobs, sessions and pending imports."""

    def __init__(self, root: str | Path | None = None):
        self.preference = Path(config.data_dir()) / "workbench-root.json"
        selected = Path(root).expanduser() if root is not None else self._saved_root()
        self.root = selected.resolve()
        self.store = WorkbenchStore(self.root)
        self.service = RenderService(self.store)
        self.tables: dict[str, tuple[float, table_data.ParsedTable]] = {}
        self.lock = threading.RLock()

    def _saved_root(self) -> Path:
        try:
            value = json.loads(self.preference.read_text("utf-8"))["root"]
            if isinstance(value, str) and value.strip():
                return Path(value)
        except (OSError, ValueError, KeyError, TypeError):
            pass
        return Path(config.data_dir()) / "workbench"

    def switch_root(self, path: str | Path) -> dict:
        if not isinstance(path, (str, Path)) or not str(path).strip():
            raise WorkbenchError("请选择有效的数据目录")
        target = Path(path).expanduser().resolve()
        if target == self.root:
            return self.status()
        with self.lock:
            self.service.close()
            self.tables.clear()
            self.root = target
            self.store = WorkbenchStore(target)
            self.service = RenderService(self.store)
            atomicio.write_json(self.preference, {"root": str(target), "schema_version": 1})
            return self.status()

    def status(self) -> dict:
        return {"root": str(self.root), "version": VERSION, "projects": self.store.list_projects()}

    def remember_table(self, table: table_data.ParsedTable) -> str:
        with self.lock:
            now = time.monotonic()
            self.tables = {
                key: value for key, value in self.tables.items() if now - value[0] < TABLE_TTL
            }
            while len(self.tables) >= TABLE_LIMIT:
                oldest = min(self.tables, key=lambda key: self.tables[key][0])
                del self.tables[oldest]
            table_id = uuid.uuid4().hex
            self.tables[table_id] = (now, table)
            return table_id

    def table(self, table_id: str) -> table_data.ParsedTable:
        table_id = checked_id(table_id)
        with self.lock:
            entry = self.tables.get(table_id)
            if entry is None or time.monotonic() - entry[0] >= TABLE_TTL:
                self.tables.pop(table_id, None)
                raise WorkbenchError("导入预览已过期，请重新选择文件", "table_expired", 410)
            return entry[1]

    def close(self) -> None:
        self.service.close()
        self.tables.clear()


def _public(value):
    if isinstance(value, dict):
        return {key: _public(item) for key, item in value.items() if not key.startswith("_")}
    if isinstance(value, list):
        return [_public(item) for item in value]
    if isinstance(value, tuple):
        return [_public(item) for item in value]
    return value


def _body() -> dict:
    value = request.get_json(silent=True)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise WorkbenchError("请求内容必须是 JSON 对象")
    return value


def _need(body: dict, key: str):
    if key not in body:
        raise WorkbenchError(f"缺少参数：{key}")
    return body[key]


def _run_matches(service: RenderService, run_id: str, payload: dict) -> dict:
    job = service.successful_run(run_id)
    submitted = {
        "code": payload.get("code"),
        "data": payload.get("data"),
        "schema": payload.get("schema") or {},
    }
    requested = job.get("requested_payload", job["payload"])
    if requested.get("code") != submitted["code"] or requested.get("schema") != submitted["schema"]:
        raise WorkbenchError("验证结果对应另一份代码或参数，请重新运行", "stale_run", 409)
    requested_data = requested.get("data")
    if requested_data is not None and requested_data != submitted["data"]:
        raise WorkbenchError("验证结果对应另一份数据，请重新运行", "stale_run", 409)
    rendered_data = job["payload"].get("data")
    if submitted["data"] is not None and rendered_data != submitted["data"]:
        raise WorkbenchError("验证结果对应另一份数据，请重新运行", "stale_run", 409)
    return job


def create_blueprint(manager: WorkbenchManager | None = None) -> Blueprint:
    manager = manager or WorkbenchManager()
    bp = Blueprint("workbench", __name__, url_prefix="/api/workbench")
    bp.manager = manager  # type: ignore[attr-defined]

    @bp.errorhandler(WorkbenchError)
    def handle_workbench_error(error: WorkbenchError):
        return jsonify(
            {"message": str(error), "error": str(error), "code": error.code}
        ), error.status

    @bp.errorhandler(ValueError)
    def handle_value_error(error: ValueError):
        return jsonify({"message": str(error), "error": str(error), "code": "invalid_request"}), 400

    @bp.errorhandler(OSError)
    def handle_os_error(error: OSError):
        return jsonify({"message": str(error), "error": str(error), "code": "storage_error"}), 500

    @bp.get("/status")
    def status():
        return jsonify(manager.status())

    @bp.post("/root")
    def select_root():
        return jsonify(manager.switch_root(_need(_body(), "path")))

    @bp.get("/projects")
    def projects():
        return jsonify({"projects": manager.store.list_projects()})

    @bp.post("/projects")
    def create_project():
        body = _body()
        path = _need(body, "path")
        if not isinstance(path, str) or not path.strip():
            raise WorkbenchError("请选择项目文件夹")
        return jsonify(
            _public(manager.store.create_project(body.get("name") or Path(path).name, path=path))
        )

    @bp.post("/projects/open")
    def open_project():
        return jsonify(_public(manager.store.open_project(_need(_body(), "path"))))

    @bp.get("/projects/<project_id>")
    def get_project(project_id):
        return jsonify(_public(manager.store.get_project(project_id)))

    @bp.patch("/projects/<project_id>")
    def update_project(project_id):
        body = _body()
        if set(body) != {"name"}:
            raise WorkbenchError("项目仅支持重命名")
        return jsonify(_public(manager.store.rename_project(project_id, body["name"])))

    @bp.delete("/projects/<project_id>")
    def delete_project(project_id):
        record = manager.store.get_project(project_id)
        for plot in record["plots"]:
            manager.service.cancel_plot(plot["id"])
        manager.store.delete_project(project_id)
        return jsonify({"ok": True})

    @bp.post("/projects/<project_id>/plots")
    def create_plot(project_id):
        return jsonify(_public(manager.store.create_plot(project_id, _need(_body(), "name"))))

    @bp.get("/plots/<plot_id>")
    def get_plot(plot_id):
        return jsonify(_public(manager.store.get_plot(plot_id)))

    @bp.patch("/plots/<plot_id>")
    def rename_plot(plot_id):
        body = _body()
        if set(body) != {"name"}:
            manager.store.assert_editable(plot_id)
        if set(body) != {"name"}:
            raise WorkbenchError("绘图内容必须通过成功运行后的保存操作更新")
        return jsonify(_public(manager.store.rename_plot(plot_id, body["name"])))

    @bp.delete("/plots/<plot_id>")
    def delete_plot(plot_id):
        manager.store.get_plot(plot_id)
        manager.service.cancel_plot(plot_id)
        manager.store.delete_plot(plot_id)
        return jsonify({"ok": True})

    @bp.get("/templates")
    def templates():
        project_id = request.args.get("project_id") or None
        if project_id:
            manager.store.get_project(project_id)
        result = [_public(item) for item in manager.store.list_templates(project_id)]
        category_list = manager.store.list_categories(project_id)
        category_id = request.args.get("category_id")
        if request.args.get("favorite", "").lower() in ("1", "true", "yes"):
            result = [item for item in result if item.get("favorite")]
        if category_id:
            result = [item for item in result if item.get("category_id") == category_id]
        return jsonify({"templates": result, "categories": category_list})

    @bp.get("/templates/<template_id>")
    def get_template(template_id):
        return jsonify(_public(manager.store.get_template(template_id)))

    @bp.post("/templates/compatible")
    def compatible_templates():
        body = _body()
        project_id = body.get("project_id")
        if project_id:
            manager.store.get_project(project_id)
        snapshot = _need(body, "data")
        compatible = []
        for item in manager.store.list_templates(project_id):
            if not table_data.validate_schema(snapshot, item.get("schema") or {}):
                compatible.append(_public(item))
        compatible_ids = {item["id"] for item in compatible}
        categories = [
            item
            for item in manager.store.list_categories(project_id)
            if any(t.get("category_id") == item["id"] for t in compatible)
        ]
        return jsonify(
            {
                "templates": compatible,
                "categories": categories,
                "compatible_ids": sorted(compatible_ids),
            }
        )

    @bp.post("/categories")
    def create_category():
        body = _body()
        return jsonify(
            manager.store.create_category(
                _need(body, "name"), body.get("scope", "global"), body.get("project_id")
            )
        )

    @bp.patch("/categories/<category_id>")
    def rename_category(category_id):
        body = _body()
        if set(body) != {"name"}:
            raise WorkbenchError("分类仅支持重命名")
        manager.store.rename_category(category_id, body["name"])
        return jsonify({"ok": True})

    @bp.delete("/categories/<category_id>")
    def delete_category(category_id):
        manager.store.delete_category(category_id)
        return jsonify({"ok": True})

    @bp.post("/templates/validate")
    def validate_template():
        body = _body()
        job_id = manager.service.render(
            {
                "code": _need(body, "code"),
                "data": body.get("data"),
                "schema": body.get("schema") or {},
            }
        )
        return jsonify({"job_id": job_id})

    @bp.post("/templates")
    def create_template():
        body = _body()
        job = _run_matches(manager.service, _need(body, "run_id"), body)
        payload = {
            **body,
            "data": job["payload"]["data"],
            "schema": job["payload"]["schema"],
            "outputs": job.get("outputs", []),
            "project_id": body.get("project_id") if body.get("scope") == "project" else None,
            "category_id": body.get("category_id") or "uncategorized",
        }
        if not payload.get("name"):
            raise WorkbenchError("请填写模板名称")
        saved = manager.store.commit_template(payload, job["directory"])
        return jsonify(_public(saved))

    @bp.patch("/templates/<template_id>")
    def update_template(template_id):
        body = _body()
        content_keys = {"code", "data", "schema"} & set(body)
        if content_keys:
            if not content_keys.issuperset({"code", "data", "schema"}):
                raise WorkbenchError("修改模板代码时必须同时提交数据和参数说明")
            current = manager.store.get_template(template_id)
            if body.get("scope", current["scope"]) != current["scope"] or body.get(
                "project_id", current.get("project_id")
            ) != current.get("project_id"):
                raise WorkbenchError("模板范围不能在编辑时切换")
            job = _run_matches(manager.service, _need(body, "run_id"), body)
            payload = {
                **current,
                **body,
                "data": job["payload"]["data"],
                "schema": job["payload"]["schema"],
                "outputs": job.get("outputs", []),
                "category_id": body.get("category_id")
                or current.get("category_id")
                or "uncategorized",
            }
            saved = manager.store.commit_template(payload, job["directory"], template_id)
            return jsonify(_public(saved))
        allowed = {"name", "favorite", "category_id"}
        if not body or not set(body) <= allowed:
            raise WorkbenchError("仅支持修改模板名称、收藏状态或分类")
        if body.get("category_id") is None:
            body["category_id"] = "uncategorized"
        return jsonify(_public(manager.store.update_template_metadata(template_id, **body)))

    @bp.delete("/templates/<template_id>")
    def delete_template(template_id):
        manager.store.delete_template(template_id)
        return jsonify({"ok": True})

    @bp.post("/plots/<plot_id>/render")
    def render_plot(plot_id):
        manager.store.assert_editable(plot_id)
        body = _body()
        payload = {
            "code": _need(body, "code"),
            "data": body.get("data"),
            "schema": body.get("schema") or {},
            "template_id": body.get("template_id"),
            "original_path": body.get("original_path"),
        }
        return jsonify({"job_id": manager.service.render(payload, plot_id)})

    @bp.get("/jobs/<job_id>")
    def get_job(job_id):
        return jsonify(manager.service.job(job_id))

    @bp.post("/jobs/<job_id>/cancel")
    def cancel_job(job_id):
        manager.service.cancel_job(job_id)
        return jsonify({"ok": True})

    @bp.post("/plots/<plot_id>/save")
    def save_plot(plot_id):
        return jsonify(_public(manager.service.save_plot(plot_id, _need(_body(), "run_id"))))

    @bp.post("/data/inspect")
    def inspect_data():
        upload = request.files.get("file")
        if upload is None or not upload.filename:
            raise WorkbenchError("请选择 Excel 或 CSV 文件")
        payload = upload.stream.read(TABLE_UPLOAD_LIMIT + 1)
        if len(payload) > TABLE_UPLOAD_LIMIT:
            raise WorkbenchError("表格文件超过 128 MB")
        filename = Path(upload.filename.replace("\\", "/")).name
        table = table_data.load_table(
            payload,
            filename,
            request.form.get("sheet") or None,
            request.form.get("encoding", "utf-8-sig"),
            request.form.get("delimiter", ","),
        )
        inspected = run_operation("inspect", table=table)
        return jsonify(
            {
                "table_id": manager.remember_table(table),
                "sheets": inspected["sheets"],
                "row_count": inspected["row_count"],
                "column_count": inspected["column_count"],
                "preview": inspected["preview"],
            }
        )

    @bp.post("/data/select")
    def select_data():
        body = _body()
        table = manager.table(_need(body, "table_id"))
        snapshot = run_operation(
            "select",
            table=table,
            rows=_need(body, "rows"),
            columns=_need(body, "columns"),
            header=body.get("header", False),
        )
        return jsonify({"data": snapshot, "preview": table_data.preview_data(snapshot)})

    @bp.post("/data/transform")
    def transform_data():
        body = _body()
        transformed = run_operation(
            "transform",
            data=_need(body, "data"),
            transform=_need(body, "operation"),
            i=body.get("i"),
            j=body.get("j"),
        )
        return jsonify({"data": transformed, "preview": table_data.preview_data(transformed)})

    @bp.get("/trash")
    def list_trash():
        return jsonify({"items": manager.store.list_trash()})

    @bp.post("/trash/<trash_id>/restore")
    def restore_trash(trash_id):
        return jsonify(manager.store.restore(trash_id))

    @bp.post("/plots/<plot_id>/tavotto/open")
    def open_tavotto(plot_id):
        return jsonify(manager.service.open_session(plot_id, _body().get("stem", "figure")))

    @bp.post("/assistant/runs")
    def start_assistant():
        return jsonify(manager.service.start_assistant(_body()))

    @bp.get("/assistant/runs/<task_id>")
    def poll_assistant(task_id):
        return jsonify(manager.service.assistant.poll(task_id))

    @bp.post("/assistant/runs/<task_id>/cancel")
    def cancel_assistant(task_id):
        manager.service.assistant.cancel(task_id)
        return jsonify({"ok": True})

    @bp.post("/sessions/<session_id>/assistant/<task_id>/apply")
    def apply_assistant(session_id, task_id):
        return jsonify(
            manager.service.apply_assistant(session_id, task_id, _need(_body(), "patches"))
        )

    @bp.post("/sessions/<session_id>/render")
    def render_session(session_id):
        body = _body()
        return jsonify(manager.service.session_render(session_id, _need(body, "patches")))

    @bp.post("/sessions/<session_id>/preview")
    def preview_session(session_id):
        body = _body()
        manager.service.session_preview(
            session_id, _need(body, "patches"), body.get("bucket", 1600)
        )
        return jsonify(
            {
                "url": f"/api/workbench/sessions/{session_id}/artifact/preview.png?v={uuid.uuid4().hex}"
            }
        )

    @bp.get("/sessions/<session_id>/artifact/preview.png")
    def session_preview_artifact(session_id):
        session = manager.service._session(session_id)
        path = inside(session["directory"], "preview.png")
        if not path.is_file():
            raise WorkbenchError("预览尚未生成", "artifact_not_found", 404)
        return send_file(path, mimetype="image/png", max_age=0)

    @bp.post("/sessions/<session_id>/finish")
    def finish_session(session_id):
        body = _body()
        return jsonify(_public(manager.service.finish_session(session_id, _need(body, "patches"))))

    @bp.post("/sessions/<session_id>/cancel")
    def cancel_session(session_id):
        manager.service.cancel_session(session_id)
        return jsonify({"ok": True})

    @bp.get("/plots/<plot_id>/export")
    def export_plot(plot_id):
        fmt = request.args.get("format", "").lower()
        stem = request.args.get("stem", "figure")
        path = manager.service.export_path(plot_id, fmt, stem)
        return send_file(
            path,
            mimetype={"png": "image/png", "svg": "image/svg+xml", "pdf": "application/pdf"}[fmt],
            as_attachment=True,
            download_name=f"{manager.store.get_plot(plot_id)['name']}{'_' + stem if stem != 'figure' else ''}.{fmt}",
        )

    @bp.post("/plots/<plot_id>/export-image")
    def save_image_file(plot_id):
        body = _body()
        fmt, stem = body.get("format", "png"), body.get("stem", "figure")
        source = manager.service.export_path(plot_id, fmt, stem)
        plot = manager.store.get_plot(plot_id)
        directory = inside(
            manager.store.project_dir(plot["project_id"]), f"exports/{plot_id}/{plot['revision']}"
        )
        destination = inside(directory, f"{stem}.{fmt}")
        atomicio.write_bytes(destination, source.read_bytes())
        return jsonify({"path": str(destination)})

    @bp.post("/plots/<plot_id>/export-code")
    def export_code(plot_id):
        body = _body()
        replace = body.get("replace", False)
        if not isinstance(replace, bool):
            raise WorkbenchError("replace 必须为布尔值")
        return jsonify(manager.service.export_code(plot_id, body.get("directory"), replace))

    @bp.post("/scripts/read")
    def read_script():
        raw_path = _need(_body(), "path")
        if not isinstance(raw_path, str) or not raw_path.strip():
            raise WorkbenchError("请选择 Python 文件")
        path = Path(raw_path).expanduser().resolve()
        if path.suffix.lower() != ".py" or not path.is_file():
            raise WorkbenchError("请选择存在的 .py 文件")
        if path.stat().st_size > 2_000_000:
            raise WorkbenchError("代码文件超过 2 MB")
        code = path.read_text("utf-8-sig")
        return jsonify({"path": str(path), "name": path.stem, "code": code})

    @bp.get("/plots/<plot_id>/code-package")
    def download_code_package(plot_id):
        manager.service.export_path(plot_id, "png")
        plot = manager.store.get_plot(plot_id)
        if not plot.get("revision"):
            raise WorkbenchError("请先保存成功运行的子图", "unsaved_plot", 409)
        with tempfile.TemporaryDirectory(prefix="pwb-zip-", dir=manager.service.root) as scratch:
            source = Path(scratch) / f"plot_{plot_id[:8]}.py"
            manager.service._write_code_package(plot, source)
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.write(source, source.name)
                for path in source.parent.iterdir():
                    if path.is_dir():
                        for nested in path.rglob("*"):
                            if nested.is_file():
                                archive.write(nested, nested.relative_to(source.parent).as_posix())
            stream.seek(0)
            return send_file(
                stream,
                mimetype="application/zip",
                as_attachment=True,
                download_name=f"{plot['name']}-code.zip",
            )

    @bp.get("/artifact/<kind>/<entity_id>/<int:revision>/<filename>")
    def artifact(kind, entity_id, revision, filename):
        if filename not in ARTIFACTS and not re.fullmatch(
            r"figure_[1-9][0-9]*\.(png|svg|pdf)", filename
        ):
            raise WorkbenchError("不允许访问该产物", "artifact_forbidden", 403)
        if kind == "plot":
            root = manager.store.plot_dir(entity_id)
            record = manager.store.get_plot(entity_id)
            if record["revision"] != revision:
                raise WorkbenchError("预览版本已过期", "artifact_not_found", 404)
            directory = inside(root, f"revisions/{revision}")
        elif kind == "template":
            record = manager.store.get_template(entity_id)
            if record["revision"] != revision:
                raise WorkbenchError("模板预览版本已过期", "artifact_not_found", 404)
            directory = inside(manager.store.template_dir(entity_id), f"revisions/{revision}")
        else:
            raise WorkbenchError("未知产物类型", "artifact_not_found", 404)
        path = inside(directory, filename)
        if not path.is_file():
            raise WorkbenchError("产物不存在", "artifact_not_found", 404)
        mimetype = {
            "png": "image/png",
            "svg": "image/svg+xml",
            "pdf": "application/pdf",
            "json": "application/json",
        }[Path(filename).suffix[1:]]
        return send_file(path, mimetype=mimetype, max_age=0)

    @bp.get("/jobs/<job_id>/artifact/<filename>")
    def job_artifact(job_id, filename):
        if not re.fullmatch(r"figure(?:_[1-9][0-9]*)?\.png", filename):
            raise WorkbenchError("不允许访问该产物", "artifact_forbidden", 403)
        job = manager.service.successful_run(job_id)
        path = inside(job["directory"], filename)
        if not path.is_file():
            raise WorkbenchError("预览不存在", "artifact_not_found", 404)
        return send_file(path, mimetype="image/png", max_age=0)

    return bp


_DEFAULT_MANAGER: WorkbenchManager | None = None
_DEFAULT_LOCK = threading.Lock()


def register(app) -> None:
    """Install the feature routes after Tavotto's global session guard."""
    global _DEFAULT_MANAGER
    app.config.setdefault("MAX_CONTENT_LENGTH", TABLE_UPLOAD_LIMIT + 1024 * 1024)
    with _DEFAULT_LOCK:
        if _DEFAULT_MANAGER is None:
            _DEFAULT_MANAGER = WorkbenchManager()
        if "workbench" not in app.blueprints:
            app.register_blueprint(create_blueprint(_DEFAULT_MANAGER))
