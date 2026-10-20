"""Portable user-owned manifests. Only verified runs may commit code revisions."""

from __future__ import annotations

import copy
import json
import os
import re
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from tavotto.engine import atomicio, projectenv

from .examples import EXAMPLES, example_snapshot


class WorkbenchError(ValueError):
    def __init__(self, message, code="invalid_request", status=400):
        super().__init__(message)
        self.code, self.status = code, status


def now():
    return datetime.now(timezone.utc).isoformat()


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text("utf-8"))
    except FileNotFoundError:
        if default is not None:
            return copy.deepcopy(default)
        raise WorkbenchError("文件不存在", "not_found", 404) from None


def checked_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{32}", value):
        raise WorkbenchError("无效标识符")
    return value


def inside(root, candidate):
    result = projectenv.contained_path(root, candidate)
    if result is None:
        raise WorkbenchError("路径超出允许的目录", "path_out_of_scope", 403)
    return Path(result)


def name_of(value):
    name = str(value or "").strip()
    if not name or len(name) > 150:
        raise WorkbenchError("名称须为 1 到 150 个字符")
    return name


DEFAULT_CODE = """import matplotlib.pyplot as plt

def build_figure(data):
    fig, ax = plt.subplots(figsize=(5.2, 3.6))
    ax.plot(data.iloc[:, 0], data.iloc[:, 1], marker="o")
    ax.set_xlabel(str(data.columns[0]))
    ax.set_ylabel(str(data.columns[1]))
    fig.tight_layout()
    return fig
"""

DEFAULT_SCHEMA = {"rows": {"mode": "variable", "min": 1}, "columns": {"mode": "variable", "min": 1}}
REVISION_ARTIFACTS = (
    "figure.png",
    "figure.svg",
    "figure.pdf",
    "manifest.json",
    "data_helper.py",
    "environment.json",
)


def _allocate_revision(path, previous):
    """Reserve a fresh numbered directory without removing earlier attempts.

    An interrupted save can leave an unreferenced directory. It may contain
    useful artifacts, so retry with the next free number rather than replacing
    or deleting it. The externally visible revision remains an integer.
    """
    revision = previous + 1
    while True:
        target = inside(path, f"revisions/{revision}")
        try:
            target.mkdir(parents=True)
            return revision, target
        except FileExistsError:
            revision += 1


def _document_backups(*paths):
    result = {}
    for path in paths:
        path = Path(path)
        try:
            result[path] = path.read_bytes()
        except FileNotFoundError:
            result[path] = None
    return result


def _restore_documents(backups):
    """Undo only the exact manifest files touched by the failed operation."""
    for path, previous in backups.items():
        try:
            current = path.read_bytes()
        except FileNotFoundError:
            current = None
        if current == previous:
            continue
        if previous is None:
            # This exact manifest did not exist before the operation. Revision
            # folders and data/artifacts are deliberately never removed here.
            path.unlink()
        else:
            atomicio.write_bytes(path, previous)


def _rollback_move(moved_path, original_path, backups, cause):
    """Restore registration and directory after a failed delete or restore."""
    failures = []
    try:
        _restore_documents(backups)
    except Exception as exc:
        failures.append(exc)
    try:
        if Path(original_path).exists():
            raise FileExistsError("Rollback destination is occupied")
        shutil.move(str(moved_path), str(original_path))
    except Exception as exc:
        failures.append(exc)
    if failures:
        raise WorkbenchError(
            "操作失败且回滚未完成，请保留项目和回收站内容", "rollback_failed", 500
        ) from cause


class WorkbenchStore:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()
        self.lock = threading.RLock()
        self.root.mkdir(parents=True, exist_ok=True)
        for name in ("projects", "templates", "trash"):
            inside(self.root, name).mkdir(exist_ok=True)
        self.index_path = self.root / "projects.json"
        if not self.index_path.exists():
            atomicio.write_json(self.index_path, {"schema_version": 1, "projects": {}})
        self._seed()

    def _index(self):
        return read_json(self.index_path)

    def project_dir(self, project_id):
        checked_id(project_id)
        entry = self._index()["projects"].get(project_id)
        if not entry:
            raise WorkbenchError("项目不存在", "not_found", 404)
        # External project folders enter this index only through an explicit open.
        path = Path(entry["path"]).resolve()
        if not path.is_dir():
            raise WorkbenchError("项目已移动，请使用「打开项目」重新定位", "project_moved", 404)
        return path

    def _project(self, project_id):
        return read_json(self.project_dir(project_id) / "project.json")

    def list_projects(self):
        result = []
        for pid, entry in self._index()["projects"].items():
            try:
                record = self._project(pid)
                result.append({**record, "path": entry["path"], "plot_count": len(record["plots"])})
            except WorkbenchError:
                result.append(
                    {
                        "id": pid,
                        "name": entry.get("name", "项目"),
                        "path": entry["path"],
                        "missing": True,
                        "plots": {},
                        "plot_count": 0,
                    }
                )
        return result

    def create_project(self, name):
        with self.lock:
            pid = uuid.uuid4().hex
            path = inside(self.root, Path("projects") / pid)
            path.mkdir()
            record = {
                "schema_version": 1,
                "id": pid,
                "name": name_of(name),
                "created_at": now(),
                "plots": {},
            }
            atomicio.write_json(path / "project.json", record)
            return self.open_project(path)

    def open_project(self, path):
        with self.lock:
            path = Path(path).expanduser().resolve()
            record = read_json(path / "project.json")
            checked_id(record["id"])
            if record.get("schema_version") != 1 or not isinstance(record.get("plots"), dict):
                raise WorkbenchError("不支持的项目格式")
            for value in record["plots"].values():
                inside(path, value)
            index = self._index()
            index["projects"][record["id"]] = {"path": str(path), "name": record["name"]}
            atomicio.write_json(self.index_path, index)
            return self.get_project(record["id"])

    def get_project(self, project_id):
        record = self._project(project_id)
        return {
            **record,
            "path": str(self.project_dir(project_id)),
            "plots": [self.get_plot(pid) for pid in record["plots"]],
        }

    def rename_project(self, project_id, name):
        with self.lock:
            record = self._project(project_id)
            record["name"] = name_of(name)
            atomicio.write_json(self.project_dir(project_id) / "project.json", record)
            index = self._index()
            index["projects"][project_id]["name"] = record["name"]
            atomicio.write_json(self.index_path, index)
            return self.get_project(project_id)

    def create_plot(self, project_id, name):
        with self.lock:
            project = self._project(project_id)
            pid = uuid.uuid4().hex
            relative = Path("plots") / pid
            path = inside(self.project_dir(project_id), relative)
            path.mkdir(parents=True)
            record = {
                "schema_version": 1,
                "id": pid,
                "project_id": project_id,
                "name": name_of(name),
                "state": "CODE_EDITABLE",
                "revision": 0,
                "saved_revision": 0,
                "code": DEFAULT_CODE,
                "data": None,
                "schema": DEFAULT_SCHEMA,
                "source": {"kind": "external"},
                "overrides": [],
                "created_at": now(),
            }
            atomicio.write_json(path / "plot.json", record)
            project["plots"][pid] = relative.as_posix()
            atomicio.write_json(self.project_dir(project_id) / "project.json", project)
            return self.get_plot(pid)

    def plot_dir(self, plot_id):
        checked_id(plot_id)
        for project in self.list_projects():
            relative = project.get("plots", {}).get(plot_id)
            if relative:
                return inside(self.project_dir(project["id"]), relative)
        raise WorkbenchError("子图不存在", "not_found", 404)

    def get_plot(self, plot_id):
        path = self.plot_dir(plot_id)
        record = read_json(path / "plot.json")
        if record.get("revision"):
            payload = read_json(inside(path, f"revisions/{record['revision']}/record.json"))
            record = {**record, **payload}
            record["_artifact_dir"] = str(inside(path, f"revisions/{record['revision']}"))
            if (Path(record["_artifact_dir"]) / "figure.png").exists():
                record["preview_url"] = (
                    f"/api/workbench/artifact/plot/{plot_id}/{record['revision']}/figure.png"
                )
        return record

    def assert_editable(self, plot_id):
        record = self.get_plot(plot_id)
        if record["state"] != "CODE_EDITABLE":
            raise WorkbenchError(
                "此子图已进入 Tavotto 专用模式，代码、数据和模板已固定", "tavotto_only", 409
            )
        return record

    def rename_plot(self, plot_id, name):
        with self.lock:
            path = self.plot_dir(plot_id) / "plot.json"
            record = read_json(path)
            record["name"] = name_of(name)
            atomicio.write_json(path, record)
            return self.get_plot(plot_id)

    def _commit_plot(self, plot_id, payload, artifacts=None):
        path = self.plot_dir(plot_id)
        head = read_json(path / "plot.json")
        old = self.get_plot(plot_id)
        revision, target = _allocate_revision(path, head["revision"])
        payload = {
            **{
                k: v
                for k, v in old.items()
                if not k.startswith("_") and k not in ("preview_url", "name")
            },
            **copy.deepcopy(payload),
            "revision": revision,
            "saved_revision": revision,
            "updated_at": now(),
        }
        if artifacts:
            for filename in REVISION_ARTIFACTS:
                source = Path(artifacts) / filename
                if source.is_file():
                    shutil.copy2(source, target / filename)
        atomicio.write_bytes(target / "source.py", payload["code"].encode("utf-8"))
        atomicio.write_json(target / "data.json", payload.get("data"))
        atomicio.write_json(target / "record.json", payload)
        head.update({"revision": revision, "saved_revision": revision, "state": payload["state"]})
        backups = _document_backups(path / "plot.json")
        try:
            atomicio.write_json(path / "plot.json", head)
        except Exception:
            # atomicio can report a directory-fsync failure *after* replace;
            # restore the previous head even in that case.
            _restore_documents(backups)
            raise
        return self.get_plot(plot_id)

    def commit_plot(self, plot_id, payload, artifacts=None):
        with self.lock:
            self.assert_editable(plot_id)
            return self._commit_plot(plot_id, payload, artifacts)

    def commit_tavotto(self, plot_id, patches, replay_code, artifacts=None):
        with self.lock:
            old = self.get_plot(plot_id)
            source = dict(old.get("source") or {})
            source["kind"] = "external"
            source["via"] = "tavotto"
            return self._commit_plot(
                plot_id,
                {
                    "state": "TAVOTTO_ONLY",
                    "base_code": old.get("base_code", old["code"]),
                    "code": replay_code,
                    "overrides": patches,
                    "source": source,
                    "engine_version": "0.18.0",
                },
                artifacts,
            )

    def _library_dir(self, project_id=None):
        if project_id:
            return inside(self.project_dir(project_id), "templates")
        return inside(self.root, "templates")

    def _library(self, project_id=None):
        path = self._library_dir(project_id)
        path.mkdir(exist_ok=True)
        return read_json(
            path / "library.json",
            {"schema_version": 1, "categories": {"uncategorized": "未分类"}, "templates": {}},
        )

    def _write_library(self, library, project_id=None):
        atomicio.write_json(self._library_dir(project_id) / "library.json", library)

    def list_categories(self, project_id=None):
        result = []
        for scope_pid in [None, project_id] if project_id else [None]:
            library = self._library(scope_pid)
            result.extend(
                {
                    "id": cid,
                    "name": name,
                    "scope": "project" if scope_pid else "global",
                    "project_id": scope_pid,
                }
                for cid, name in library["categories"].items()
            )
        return result

    def create_category(self, name, scope="global", project_id=None):
        if scope not in ("global", "project") or (scope == "project" and not project_id):
            raise WorkbenchError("项目分类需要指定项目")
        pid = project_id if scope == "project" else None
        with self.lock:
            library = self._library(pid)
            cid = uuid.uuid4().hex
            library["categories"][cid] = name_of(name)
            self._write_library(library, pid)
            return {"id": cid, "name": name_of(name), "scope": scope, "project_id": pid}

    def _find_category(self, category_id):
        if category_id == "uncategorized":
            raise WorkbenchError("不能删除或重命名未分类")
        checked_id(category_id)
        for pid in [None] + list(self._index()["projects"]):
            try:
                library = self._library(pid)
            except WorkbenchError:
                continue
            if category_id in library["categories"]:
                return pid, library
        raise WorkbenchError("分类不存在", "not_found", 404)

    def rename_category(self, category_id, name):
        with self.lock:
            pid, library = self._find_category(category_id)
            library["categories"][category_id] = name_of(name)
            self._write_library(library, pid)

    def delete_category(self, category_id):
        with self.lock:
            pid, library = self._find_category(category_id)
            for tid in library["templates"]:
                meta_path = (
                    inside(self._library_dir(pid), library["templates"][tid]) / "template.json"
                )
                meta = read_json(meta_path)
                if meta["category_id"] == category_id:
                    meta["category_id"] = "uncategorized"
                    atomicio.write_json(meta_path, meta)
            del library["categories"][category_id]
            self._write_library(library, pid)

    def _find_template(self, template_id):
        checked_id(template_id)
        for pid in [None] + list(self._index()["projects"]):
            try:
                library = self._library(pid)
            except WorkbenchError:
                continue
            if template_id in library["templates"]:
                return pid, inside(self._library_dir(pid), library["templates"][template_id])
        raise WorkbenchError("模板不存在", "not_found", 404)

    def template_dir(self, template_id):
        return self._find_template(template_id)[1]

    def get_template(self, template_id):
        pid, path = self._find_template(template_id)
        record = read_json(path / "template.json")
        revision_dir = inside(path, f"revisions/{record['revision']}")
        payload = read_json(revision_dir / "record.json")
        record = {
            **payload,
            **record,
            "project_id": pid,
            "scope": "project" if pid else "global",
            "_artifact_dir": str(revision_dir),
        }
        if (revision_dir / "figure.png").exists():
            record["preview_url"] = (
                f"/api/workbench/artifact/template/{template_id}/{record['revision']}/figure.png"
            )
        return record

    def list_templates(self, project_id=None):
        result = []
        for pid in [None, project_id] if project_id else [None]:
            result.extend(self.get_template(tid) for tid in self._library(pid)["templates"])
        return result

    def commit_template(self, payload, artifacts=None, template_id=None):
        with self.lock:
            scope = payload.get("scope", "global")
            if scope not in ("global", "project") or (
                scope == "project" and not payload.get("project_id")
            ):
                raise WorkbenchError("项目模板需要指定项目，范围须为 global 或 project")
            pid = payload.get("project_id") if scope == "project" else None
            library = self._library(pid)
            if template_id:
                actual_pid, path = self._find_template(template_id)
                if actual_pid != pid:
                    raise WorkbenchError("模板范围不能在编辑时切换")
                meta = read_json(path / "template.json")
            else:
                template_id = uuid.uuid4().hex
                path = inside(self._library_dir(pid), template_id)
                path.mkdir()
                meta = {"id": template_id, "revision": 0, "favorite": False, "created_at": now()}
            category = payload.get("category_id", meta.get("category_id", "uncategorized"))
            if category not in library["categories"]:
                raise WorkbenchError("分类不属于当前模板库")
            revision, target = _allocate_revision(path, meta["revision"])
            record = {
                "code": payload["code"],
                "data": payload["data"],
                "schema": payload.get("schema") or DEFAULT_SCHEMA,
                "description": payload.get(
                    "description", payload.get("schema", {}).get("description", "")
                ),
            }
            atomicio.write_bytes(target / "source.py", record["code"].encode("utf-8"))
            atomicio.write_json(target / "data.json", record["data"])
            atomicio.write_json(target / "record.json", record)
            if artifacts:
                for filename in REVISION_ARTIFACTS:
                    source = Path(artifacts) / filename
                    if source.is_file():
                        shutil.copy2(source, target / filename)
            meta.update(
                {
                    "name": name_of(payload["name"]),
                    "category_id": category,
                    "revision": revision,
                    "updated_at": now(),
                }
            )
            backups = _document_backups(
                path / "template.json", self._library_dir(pid) / "library.json"
            )
            try:
                atomicio.write_json(path / "template.json", meta)
                library["templates"][template_id] = template_id
                self._write_library(library, pid)
            except Exception:
                _restore_documents(backups)
                raise
            return self.get_template(template_id)

    def update_template_metadata(self, template_id, **changes):
        with self.lock:
            pid, path = self._find_template(template_id)
            meta = read_json(path / "template.json")
            if "name" in changes:
                meta["name"] = name_of(changes["name"])
            if "favorite" in changes:
                if not isinstance(changes["favorite"], bool):
                    raise WorkbenchError("收藏状态必须为布尔值")
                meta["favorite"] = changes["favorite"]
            if "category_id" in changes:
                if changes["category_id"] not in self._library(pid)["categories"]:
                    raise WorkbenchError("分类不属于当前模板库")
                meta["category_id"] = changes["category_id"]
            atomicio.write_json(path / "template.json", meta)
            return self.get_template(template_id)

    def _seed(self):
        with self.lock:
            marker = self.root / "templates" / ".seeded-v1"
            if marker.exists():
                return
            for example in EXAMPLES:
                category = self.create_category(example["category"])
                artifacts = Path(__file__).parent / "previews" / example["key"]
                self.commit_template(
                    {
                        "name": example["name"],
                        "scope": "global",
                        "category_id": category["id"],
                        "code": example["code"],
                        "data": example_snapshot(example),
                        "schema": {**example["schema"], "description": example["description"]},
                    },
                    artifacts if artifacts.exists() else None,
                )
            atomicio.write_bytes(marker, b"1")

    def _trash(self, kind, entity_id, path, extra):
        resolved = Path(path).resolve()
        if not resolved.is_dir() or resolved == self.root or resolved == Path(resolved.anchor):
            raise WorkbenchError("拒绝移动无效目录")
        tid = uuid.uuid4().hex
        target = inside(self.root, Path("trash") / tid)
        target.mkdir()
        atomicio.write_json(
            target / "trash.json",
            {
                "id": tid,
                "kind": kind,
                "entity_id": entity_id,
                "original_path": str(resolved),
                "deleted_at": now(),
                **extra,
            },
        )
        shutil.move(str(resolved), str(target / "content"))
        return target / "content"

    def delete_project(self, project_id):
        with self.lock:
            project = self._project(project_id)
            original = self.project_dir(project_id)
            backups = _document_backups(self.index_path)
            index = self._index()
            del index["projects"][project_id]
            moved = self._trash("project", project_id, original, {"name": project["name"]})
            try:
                atomicio.write_json(self.index_path, index)
            except Exception as exc:
                _rollback_move(moved, original, backups, exc)
                raise

    def delete_plot(self, plot_id):
        with self.lock:
            plot = self.get_plot(plot_id)
            original = self.plot_dir(plot_id)
            manifest = self.project_dir(plot["project_id"]) / "project.json"
            backups = _document_backups(manifest)
            project = self._project(plot["project_id"])
            del project["plots"][plot_id]
            moved = self._trash(
                "plot", plot_id, original, {"name": plot["name"], "project_id": plot["project_id"]}
            )
            try:
                atomicio.write_json(manifest, project)
            except Exception as exc:
                _rollback_move(moved, original, backups, exc)
                raise

    def delete_template(self, template_id):
        with self.lock:
            record = self.get_template(template_id)
            pid, path = self._find_template(template_id)
            backups = _document_backups(self._library_dir(pid) / "library.json")
            library = self._library(pid)
            del library["templates"][template_id]
            moved = self._trash(
                "template", template_id, path, {"name": record["name"], "project_id": pid}
            )
            try:
                self._write_library(library, pid)
            except Exception as exc:
                _rollback_move(moved, path, backups, exc)
                raise

    def list_trash(self):
        return [
            read_json(path)
            for path in (self.root / "trash").glob("*/trash.json")
            if (path.parent / "content").is_dir()
        ]

    def restore(self, trash_id):
        with self.lock:
            path = inside(self.root, Path("trash") / checked_id(trash_id))
            item = read_json(path / "trash.json")
            if item["kind"] not in ("project", "plot", "template"):
                raise WorkbenchError("未知回收站类型")
            checked_id(item["entity_id"])
            destination = Path(item["original_path"]).resolve()
            manifest = self.index_path
            if item["kind"] == "template":
                destination = inside(self._library_dir(item.get("project_id")), item["entity_id"])
                manifest = self._library_dir(item.get("project_id")) / "library.json"
            elif item["kind"] == "plot":
                destination = inside(
                    self.project_dir(item["project_id"]), Path("plots") / item["entity_id"]
                )
                manifest = self.project_dir(item["project_id"]) / "project.json"
            if destination.exists():
                raise WorkbenchError("原位置已有同名内容，无法恢复", "restore_conflict", 409)
            destination.parent.mkdir(parents=True, exist_ok=True)
            backups = _document_backups(manifest)
            shutil.move(str(path / "content"), str(destination))
            try:
                if item["kind"] == "project":
                    self.open_project(destination)
                elif item["kind"] == "plot":
                    project = self._project(item["project_id"])
                    project["plots"][item["entity_id"]] = (
                        Path("plots") / item["entity_id"]
                    ).as_posix()
                    atomicio.write_json(manifest, project)
                else:
                    library = self._library(item.get("project_id"))
                    metadata_path = destination / "template.json"
                    metadata = read_json(metadata_path)
                    if metadata.get("category_id") not in library["categories"]:
                        backups.update(_document_backups(metadata_path))
                        metadata["category_id"] = "uncategorized"
                        atomicio.write_json(metadata_path, metadata)
                    library["templates"][item["entity_id"]] = item["entity_id"]
                    self._write_library(library, item.get("project_id"))
            except Exception as exc:
                _rollback_move(destination, path / "content", backups, exc)
                raise
            return item

    def validate_code_target(self, target):
        target = Path(target).expanduser().resolve()
        identity = os.path.normcase(str(target))
        roots = [self._library_dir(None)]
        for pid in self._index()["projects"]:
            try:
                roots.append(self._library_dir(pid))
            except WorkbenchError:
                continue
        for item in self.list_trash():
            if item.get("kind") == "template":
                roots.append(self.root / "trash" / item["id"] / "content")
        for root in roots:
            prefix = os.path.normcase(str(root.resolve()))
            if identity == prefix or identity.startswith(prefix + os.sep):
                raise WorkbenchError("禁止替换模板库中的代码", "template_protected", 403)
        if target.suffix.lower() != ".py":
            raise WorkbenchError("代码目标必须为 .py 文件")
        return target
