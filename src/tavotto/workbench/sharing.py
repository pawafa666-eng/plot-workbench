"""Portable library packages. Imported code is a draft, never an executed revision."""

from __future__ import annotations

import copy
import io
import json
import os
import re
import shutil
import stat
import struct
import tempfile
import uuid
import zipfile
import zlib

from tavotto.engine import atomicio

from . import data as table_data
from .palettes import validate_colors
from .store import (
    DEFAULT_SCHEMA,
    WorkbenchError,
    _document_backups,
    _restore_documents,
    inside,
    now,
)

FORMAT = "plot-workbench-library"
MAX_ITEMS = 500
MAX_BYTES = 64 * 1024 * 1024
MAX_MANIFEST = 32 * 1024 * 1024
MAX_PREVIEW = 4 * 1024 * 1024
EMPTY_DATA = {
    "columns": [],
    "index": [],
    "values": [],
    "dtypes": [],
    "row_sources": [],
    "column_sources": [],
    "source": {},
    "row_count": 0,
    "column_count": 0,
}


def _invalid(message="不是有效的模板与配色分享包"):
    return WorkbenchError(message, "invalid_library_package")


def _text(value, limit=150):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise _invalid("分享包中的名称或文本无效")
    return value.strip()


def _preview(raw):
    if not (24 <= len(raw) <= MAX_PREVIEW) or raw[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR":
        raise _invalid("模板预览不是有效的 PNG 图片")
    width, height = struct.unpack(">II", raw[16:24])
    if not width or not height or width * height > 16_000_000:
        raise _invalid("模板预览尺寸过大")
    return raw


def _snapshot(value):
    if value is None:
        return None
    table_data.validate_schema(value, None)
    return {**copy.deepcopy(value), "source": {"kind": "shared_template"}}


def _ids(value):
    if (
        not isinstance(value, list)
        or len(value) > MAX_ITEMS
        or any(not isinstance(x, str) for x in value)
    ):
        raise WorkbenchError("请选择要分享的模板或配色")
    if len(set(value)) != len(value):
        raise WorkbenchError("分享列表中有重复项目")
    return value


def export_library(store, palettes, template_ids, palette_ids, project_id=None):
    template_ids, palette_ids = _ids(template_ids), _ids(palette_ids)
    if not 1 <= len(template_ids) + len(palette_ids) <= MAX_ITEMS:
        raise WorkbenchError(f"请选择 1 到 {MAX_ITEMS} 个模板或配色")
    with store.lock, palettes.lock:
        available = {t["id"]: t for t in store.list_templates(project_id)}
        colors = {p["id"]: p for p in palettes.list()}
        categories = {c["id"]: c["name"] for c in store.list_categories(project_id)}
        document = {"format": FORMAT, "version": 1, "templates": [], "palettes": []}
        previews = {}
        for index, tid in enumerate(template_ids):
            if tid not in available:
                raise WorkbenchError("所选模板不存在或不属于当前模板库", "not_found", 404)
            item = available[tid]
            record = {
                "name": item["name"],
                "code": item["code"],
                "data": _snapshot(item.get("data")),
                "schema": item.get("schema", {}),
                "description": item.get("description", ""),
                "category": categories.get(item.get("category_id"))
                if item.get("category_id") != "uncategorized"
                else None,
            }
            path = inside(item["_artifact_dir"], "figure.png")
            if path.is_file():
                name = f"previews/{index:04d}.png"
                if path.stat().st_size > MAX_PREVIEW:
                    raise WorkbenchError("模板预览过大，无法打包")
                previews[name] = _preview(path.read_bytes())
                record["preview"] = name
            document["templates"].append(record)
        for pid in palette_ids:
            if pid not in colors:
                raise WorkbenchError("所选配色不存在", "not_found", 404)
            document["palettes"].append(
                {"name": colors[pid]["name"], "colors": colors[pid]["colors"]}
            )
        manifest = json.dumps(document, ensure_ascii=False, allow_nan=False).encode("utf8")
        if (
            len(manifest) > MAX_MANIFEST
            or len(manifest) + sum(map(len, previews.values())) > MAX_BYTES
        ):
            raise WorkbenchError("分享包过大，请减少所选项目")
        result = io.BytesIO()
        with zipfile.ZipFile(result, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("library.json", manifest)
            for name, raw in previews.items():
                archive.writestr(name, raw)
        result.seek(0)
        read_package(result.getvalue())
        return result


def _json_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise _invalid("分享包中存在重复字段")
        result[key] = value
    return result


def _json_constant(_value):
    raise _invalid("分享包包含无效数值")


def read_package(raw):
    if not raw or len(raw) > MAX_BYTES:
        raise _invalid("分享包为空或超过 64 MB")
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries = archive.infolist()
            names = [entry.filename for entry in entries]
            if (
                len(entries) > MAX_ITEMS + 1
                or len(set(names)) != len(names)
                or "library.json" not in names
            ):
                raise _invalid()
            if sum(e.file_size for e in entries) > MAX_BYTES:
                raise _invalid("分享包解压后过大")
            for entry in entries:
                if entry.flag_bits & 1 or stat.S_ISLNK(entry.external_attr >> 16):
                    raise _invalid()
                if entry.filename == "library.json":
                    limit = MAX_MANIFEST
                elif re.fullmatch(r"previews/[0-9]{4}\.png", entry.filename):
                    limit = MAX_PREVIEW
                else:
                    raise _invalid("分享包包含不支持的文件或路径")
                if entry.file_size > limit:
                    raise _invalid("分享包中的文件过大")
            document = json.loads(
                archive.read("library.json").decode("utf-8-sig"),
                object_pairs_hook=_json_pairs,
                parse_constant=_json_constant,
            )
            if (
                not isinstance(document, dict)
                or document.get("format") != FORMAT
                or type(document.get("version")) is not int
                or document["version"] != 1
            ):
                raise _invalid("分享包格式或版本不受支持")
            templates, palettes = document.get("templates"), document.get("palettes")
            if (
                not isinstance(templates, list)
                or not isinstance(palettes, list)
                or not 1 <= len(templates) + len(palettes) <= MAX_ITEMS
            ):
                raise _invalid("分享包没有可导入的模板或配色")
            referenced = {"library.json"}
            for item in templates:
                if not isinstance(item, dict):
                    raise _invalid()
                item["name"] = _text(item.get("name"))
                code = item.get("code")
                if (
                    not isinstance(code, str)
                    or not code.strip()
                    or len(code.encode("utf8")) > 2 * 1024 * 1024
                ):
                    raise _invalid("模板代码为空或过大")
                item["data"] = _snapshot(item.get("data"))
                if not isinstance(item.get("schema"), dict):
                    raise _invalid("模板参数格式无效")
                item["schema"] = {**copy.deepcopy(DEFAULT_SCHEMA), **item["schema"]}
                table_data.validate_schema(
                    item["data"] if item["data"] is not None else EMPTY_DATA, item["schema"]
                )
                if item.get("category") is not None:
                    item["category"] = _text(item["category"])
                if (
                    not isinstance(item.get("description", ""), str)
                    or len(item.get("description", "")) > 20_000
                ):
                    raise _invalid("模板说明过长或无效")
                preview = item.get("preview")
                if preview is not None:
                    if (
                        not isinstance(preview, str)
                        or preview not in names
                        or preview in referenced
                        or not re.fullmatch(r"previews/[0-9]{4}\.png", preview)
                    ):
                        raise _invalid("模板预览缺失或路径无效")
                    item["_preview"] = _preview(archive.read(preview))
                    referenced.add(preview)
            for item in palettes:
                if not isinstance(item, dict):
                    raise _invalid()
                item["name"] = _text(item.get("name"))
                item["colors"] = validate_colors(item.get("colors"))
            if set(names) != referenced:
                raise _invalid("分享包包含未引用的文件")
            return templates, palettes
    except WorkbenchError:
        raise
    except (
        ValueError,
        TypeError,
        KeyError,
        zipfile.BadZipFile,
        RuntimeError,
        NotImplementedError,
        RecursionError,
        UnicodeError,
        zlib.error,
    ) as error:
        raise _invalid() from error


def _unique_name(name, used):
    candidate, index = name, 1
    while candidate.casefold() in used:
        suffix = f"（导入 {index}）"
        candidate = name[: 150 - len(suffix)] + suffix
        index += 1
    used.add(candidate.casefold())
    return candidate


def import_library(store, palette_store, raw, scope="global", project_id=None):
    templates, palettes = read_package(raw)
    if scope not in ("global", "project") or (scope == "project" and not project_id):
        raise WorkbenchError("请选择模板的存放位置")
    pid = project_id if scope == "project" else None
    if pid:
        store.get_project(pid)
    with store.lock, palette_store.lock:
        library_dir = store._library_dir(pid)
        library_path = inside(library_dir, "library.json")
        backups = _document_backups(library_path, palette_store.path)
        library = store._library(pid)
        palette_data = palette_store._load()
        names = {
            t["name"].casefold() for t in store.list_templates(pid) if t.get("project_id") == pid
        }
        palette_names = {p["name"].casefold() for p in palette_data["palettes"]}
        categories = {name.casefold(): cid for cid, name in library["categories"].items()}
        created, imported_templates, imported_palettes = [], [], []
        with tempfile.TemporaryDirectory(prefix=".import-", dir=library_dir) as scratch:
            try:
                for item in templates:
                    tid, stamp = uuid.uuid4().hex, now()
                    category = item.get("category")
                    cid = categories.get(category.casefold()) if category else "uncategorized"
                    if cid is None:
                        cid = uuid.uuid4().hex
                        library["categories"][cid] = category
                        categories[category.casefold()] = cid
                    name = _unique_name(item["name"], names)
                    path = inside(scratch, tid)
                    draft = inside(path, "draft")
                    draft.mkdir(parents=True)
                    record = {
                        k: copy.deepcopy(item.get(k, ""))
                        for k in ("code", "data", "schema", "description")
                    }
                    record["outputs"] = [{"stem": "figure", "title": "图 1"}]
                    atomicio.write_json(draft / "record.json", record)
                    if item.get("_preview") is not None:
                        atomicio.write_bytes(draft / "figure.png", item["_preview"])
                    atomicio.write_json(
                        path / "template.json",
                        {
                            "id": tid,
                            "name": name,
                            "revision": 0,
                            "validation_state": "pending",
                            "category_id": cid,
                            "favorite": False,
                            "created_at": stamp,
                            "updated_at": stamp,
                        },
                    )
                    target = inside(library_dir, tid)
                    if target.exists():
                        raise WorkbenchError(
                            "模板标识冲突，请重试", "template_identity_conflict", 409
                        )
                    os.replace(path, target)
                    created.append(target)
                    library["templates"][tid] = tid
                    imported_templates.append({"id": tid, "name": name})
                for item in palettes:
                    stamp = now()
                    record = {
                        "id": uuid.uuid4().hex,
                        "name": _unique_name(item["name"], palette_names),
                        "colors": item["colors"],
                        "created_at": stamp,
                        "updated_at": stamp,
                    }
                    palette_data["palettes"].append(record)
                    imported_palettes.append({"id": record["id"], "name": record["name"]})
                if palettes:
                    atomicio.write_json(palette_store.path, palette_data)
                if templates:
                    store._write_library(library, pid)
            except Exception:
                _restore_documents(backups)
                # Only unpublished UUID directories created by this import may be removed.
                for path in created:
                    checked = inside(library_dir, path.name)
                    if checked.parent == library_dir.resolve() and checked.name == path.name:
                        shutil.rmtree(checked)
                raise
        return {"templates": imported_templates, "palettes": imported_palettes}
