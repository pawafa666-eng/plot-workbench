"""Inspect saved snapshots and restore independent, explicitly unverified copies."""

from __future__ import annotations

import copy
import re
import shutil
import uuid

from tavotto.engine import atomicio

from .store import (
    WorkbenchError,
    _document_backups,
    _restore_documents,
    copy_artifacts,
    inside,
    name_of,
    now,
    read_json,
)


def _entity(store, kind, entity_id):
    if kind == "plot":
        return store.get_plot(entity_id), store.plot_dir(entity_id)
    if kind == "template":
        return store.get_template(entity_id), store.template_dir(entity_id)
    raise WorkbenchError("历史类型无效")


def revision_record(store, kind, entity_id, revision):
    current, path = _entity(store, kind, entity_id)
    if type(revision) is not int or not 1 <= revision <= current["revision"]:
        raise WorkbenchError("历史版本不存在", "not_found", 404)
    directory = inside(path, f"revisions/{revision}")
    record = read_json(directory / "record.json")
    if not isinstance(record, dict) or not isinstance(record.get("code"), str):
        raise WorkbenchError("历史存档格式无效", "invalid_history", 409)
    # Old revisions may predate parent links. They remain viewable as archives;
    # no archive is treated as a newly verified render when restored.
    return current, record, directory


def list_history(store, kind, entity_id):
    current, root = _entity(store, kind, entity_id)
    result = []
    revisions = inside(root, "revisions")
    if not revisions.is_dir():
        return {"current_revision": current["revision"], "versions": []}
    reachable, cursor = set(), current["revision"]
    while cursor:
        reachable.add(cursor)
        record = read_json(inside(root, f"revisions/{cursor}/record.json"))
        parent = record.get("parent_revision")
        if type(parent) is not int or not 0 <= parent < cursor:
            break
        cursor = parent
    for path in revisions.iterdir():
        if not path.name.isdecimal():
            continue
        revision = int(path.name)
        if not 1 <= revision <= current["revision"] or not (path / "record.json").is_file():
            continue
        _, record, _ = revision_record(store, kind, entity_id, revision)
        if "parent_revision" in record and revision not in reachable:
            continue
        outputs = record.get("outputs") or [{"stem": "figure", "title": "图 1"}]
        result.append(
            {
                "revision": revision,
                "updated_at": record.get("updated_at") or current.get("created_at"),
                "legacy": "parent_revision" not in record and revision != current["revision"],
                "pending": record.get("validation_state") == "pending",
                "outputs": [
                    {
                        "stem": output["stem"],
                        "title": output.get("title", "图形"),
                        "preview_url": f"/api/workbench/history/{kind}/{entity_id}/{revision}/preview/{output['stem']}",
                    }
                    for output in outputs
                    if re.fullmatch(r"figure(?:_[1-9][0-9]*)?", str(output.get("stem")))
                ],
                "data_rows": (record.get("data") or {}).get("row_count", 0),
                "data_columns": (record.get("data") or {}).get("column_count", 0),
            }
        )
    return {
        "current_revision": current["revision"],
        "versions": sorted(result, key=lambda r: r["revision"], reverse=True),
    }


def _check_links(directory):
    if any(path.is_symlink() for path in directory.rglob("*")):
        raise WorkbenchError("历史产物含符号链接，未恢复", "history_symlink", 409)


def restore_copy(store, kind, entity_id, revision, expected_revision):
    with store.lock:
        current, record, artifacts = revision_record(store, kind, entity_id, revision)
        if type(expected_revision) is not int or expected_revision != current["revision"]:
            raise WorkbenchError("当前版本已变化，请刷新历史列表", "history_conflict", 409)
        _check_links(artifacts)
        new_id, stamp = uuid.uuid4().hex, now()
        title = name_of(f"{current['name'][:120]}（r{revision} 副本）")
        payload = copy.deepcopy(record)
        payload.update(
            validation_state="pending",
            history_origin={"id": entity_id, "revision": revision},
            parent_revision=0,
        )
        if kind == "plot":
            project_path = store.project_dir(current["project_id"])
            project_manifest = project_path / "project.json"
            project = read_json(project_manifest)
            path = inside(project_path, f"plots/{new_id}")
            meta = {
                "schema_version": 1,
                "id": new_id,
                "project_id": current["project_id"],
                "name": title,
                "revision": 1,
                "saved_revision": 0,
                "state": record.get("state", "CODE_EDITABLE"),
                "validation_state": "pending",
                "created_at": stamp,
            }
            payload.update(
                id=new_id, project_id=current["project_id"], revision=1, saved_revision=0
            )
            target = path / "revisions/1"
            backups = _document_backups(project_manifest)
            try:
                target.mkdir(parents=True)
                copy_artifacts(artifacts, target, payload.get("outputs", []))
                atomicio.write_json(target / "record.json", payload)
                atomicio.write_bytes(target / "source.py", payload["code"].encode("utf8"))
                atomicio.write_json(target / "data.json", payload.get("data"))
                atomicio.write_json(path / "plot.json", meta)
                project["plots"][new_id] = f"plots/{new_id}"
                atomicio.write_json(project_manifest, project)
            except Exception:
                _restore_documents(backups)
                if path.exists():
                    shutil.rmtree(inside(project_path, f"plots/{new_id}"))
                raise
            return store.get_plot(new_id)
        pid = current.get("project_id")
        library_dir = store._library_dir(pid)
        library = store._library(pid)
        path = inside(library_dir, new_id)
        backups = _document_backups(library_dir / "library.json")
        try:
            target = path / "draft"
            target.mkdir(parents=True)
            copy_artifacts(artifacts, target, payload.get("outputs", []))
            atomicio.write_json(target / "record.json", payload)
            atomicio.write_json(
                path / "template.json",
                {
                    "id": new_id,
                    "name": title,
                    "revision": 0,
                    "validation_state": "pending",
                    "category_id": current.get("category_id", "uncategorized"),
                    "favorite": False,
                    "created_at": stamp,
                    "updated_at": stamp,
                },
            )
            library["templates"][new_id] = new_id
            store._write_library(library, pid)
        except Exception:
            _restore_documents(backups)
            if path.exists():
                shutil.rmtree(inside(library_dir, new_id))
            raise
        return store.get_template(new_id)
