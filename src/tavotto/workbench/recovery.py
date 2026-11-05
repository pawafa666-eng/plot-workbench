"""Durable, unexecuted editor drafts, separate from verified project revisions."""

from __future__ import annotations

import copy
import hashlib
import json
import threading
from pathlib import Path

from tavotto.engine import atomicio, config

from . import data as table_data
from .store import WorkbenchError, _document_backups, _restore_documents, checked_id, inside, now

MAX_DRAFT_BYTES = 64 * 1024 * 1024
DRAFT_KINDS = {"plot", "template", "canvas"}


def _nonfinite(_value):
    raise WorkbenchError("草稿包含无效数值", "invalid_draft")


def read_draft(path):
    try:
        if Path(path).stat().st_size > MAX_DRAFT_BYTES + 4096:
            raise WorkbenchError("草稿文件过大，原文件已保留", "invalid_draft", 409)
        return json.loads(Path(path).read_text("utf-8"), parse_constant=_nonfinite)
    except FileNotFoundError:
        raise WorkbenchError("草稿不存在", "not_found", 404) from None
    except (ValueError, RecursionError) as error:
        raise WorkbenchError("草稿文件损坏，请保留文件用于恢复", "invalid_draft", 409) from error


class DraftStore:
    """A root-scoped CAS store. Saving a draft never creates a render or revision."""

    def __init__(self, library_root, directory=None):
        identity = config.normalize_path_identity(Path(library_root).resolve())
        namespace = hashlib.sha256(identity.encode("utf8")).hexdigest()
        self.root = Path(directory or config.data_dir() / "workbench-drafts") / namespace
        self.lock = threading.RLock()

    def path(self, draft_id):
        return inside(self.root, checked_id(draft_id) + ".json")

    def get(self, draft_id):
        with self.lock:
            record = read_draft(self.path(draft_id))
            if (
                not isinstance(record, dict)
                or record.get("id") != draft_id
                or record.get("kind") not in DRAFT_KINDS
                or type(record.get("generation")) is not int
                or record["generation"] < 1
                or not isinstance(record.get("content"), dict)
                or not isinstance(record.get("name"), str)
                or not isinstance(record.get("updated_at"), str)
            ):
                raise WorkbenchError("草稿标识不一致", "invalid_draft", 409)
            return record

    def list(self):
        with self.lock:
            drafts, problems = [], []
            if self.root.exists():
                for path in self.root.glob("*.json"):
                    try:
                        record = self.get(checked_id(path.stem))
                        drafts.append({k: v for k, v in record.items() if k != "content"})
                    except (WorkbenchError, OSError):
                        problems.append("有一份草稿无法读取，原文件已保留。")
            return {
                "drafts": sorted(drafts, key=lambda item: item["updated_at"], reverse=True),
                "problems": problems,
            }

    def save(self, draft_id, body):
        path = self.path(draft_id)
        kind, content = body.get("kind"), body.get("content")
        generation = body.get("generation")
        if kind not in DRAFT_KINDS or not isinstance(content, dict):
            raise WorkbenchError("草稿类型或内容无效", "invalid_draft")
        if type(generation) is not int or generation < 0:
            raise WorkbenchError("请提供草稿修订号", "invalid_draft")
        entity_id, project_id = body.get("entity_id"), body.get("project_id")
        for value in (entity_id, project_id):
            if value is not None:
                checked_id(value)
        if kind in ("plot", "canvas") and (not entity_id or not project_id):
            raise WorkbenchError("图形草稿需要项目和图形标识", "invalid_draft")
        if body.get("scope", "global") not in ("global", "project"):
            raise WorkbenchError("模板范围无效", "invalid_draft")
        if kind == "template" and body.get("scope") == "project" and not project_id:
            raise WorkbenchError("项目模板草稿需要项目标识", "invalid_draft")
        revision = body.get("base_revision", 0)
        if type(revision) is not int or revision < 0:
            raise WorkbenchError("来源版本无效", "invalid_draft")
        name = body.get("name", "未命名草稿")
        if not isinstance(name, str) or len(name) > 150:
            raise WorkbenchError("草稿名称过长", "invalid_draft")
        if kind == "canvas":
            patches = content.get("patches")
            if not isinstance(patches, list) or len(patches) > 10_000:
                raise WorkbenchError("图内草稿参数无效", "invalid_draft")
            if not all(isinstance(patch, dict) for patch in patches):
                raise WorkbenchError("图内草稿参数无效", "invalid_draft")
        else:
            code = content.get("code")
            if not isinstance(code, str) or len(code.encode("utf8")) > 2_000_000:
                raise WorkbenchError("草稿代码超过 2 MB 或格式无效", "invalid_draft")
            if not isinstance(content.get("schema"), dict):
                raise WorkbenchError("草稿数据规范无效", "invalid_draft")
            if content.get("data") is not None:
                table_data.validate_schema(content["data"], None)
        try:
            raw = json.dumps(content, ensure_ascii=False, allow_nan=False).encode("utf8")
        except (ValueError, TypeError, RecursionError) as error:
            raise WorkbenchError("草稿内容无法保存", "invalid_draft") from error
        if len(raw) > MAX_DRAFT_BYTES:
            raise WorkbenchError("草稿超过 64 MB", "draft_too_large", 413)
        with self.lock:
            previous = self.get(draft_id) if path.exists() else None
            if generation != (previous["generation"] if previous else 0):
                raise WorkbenchError(
                    "这份草稿已在另一窗口更新，请重新打开后选择恢复", "draft_conflict", 409
                )
            reference = {"kind": kind, "entity_id": entity_id, "project_id": project_id}
            if previous and any(previous.get(key) != value for key, value in reference.items()):
                raise WorkbenchError("不能更改草稿所属的图或模板", "draft_conflict", 409)
            record = {
                "schema_version": 1,
                "id": draft_id,
                **reference,
                "scope": body.get("scope", "global"),
                "base_revision": revision,
                "name": name.strip() or "未命名草稿",
                "created_at": previous["created_at"] if previous else now(),
                "updated_at": now(),
                "generation": generation + 1,
                "content": copy.deepcopy(content),
            }
            self.root.mkdir(parents=True, exist_ok=True)
            backups = _document_backups(path)
            try:
                atomicio.write_json(path, record)
            except Exception:
                _restore_documents(backups)
                raise
            return {k: v for k, v in record.items() if k != "content"}

    def delete(self, draft_id, generation):
        with self.lock:
            record = self.get(draft_id)
            if type(generation) is not int or generation != record["generation"]:
                raise WorkbenchError("草稿已更新，未删除较新的内容", "draft_conflict", 409)
            self.path(draft_id).unlink()
