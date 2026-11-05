"""Read-only storage inspection and verified copy-before-switch library migration."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

from tavotto.engine import atomicio, brand, config

from .recovery import DraftStore
from .store import WorkbenchError, inside

OWNED_NAMES = ("projects.json", "projects", "templates", "palettes.json", "trash")


def library_path(value):
    if not isinstance(value, (str, Path)) or not str(value).strip():
        raise WorkbenchError("请选择模板与配色库目录")
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise WorkbenchError("请输入完整目录路径")
    return path.resolve()


def _manifest(path, default):
    try:
        value = json.loads(path.read_text("utf8"))
        if not isinstance(value, dict):
            raise ValueError("Expected an object")
        return value
    except FileNotFoundError:
        return default
    except (OSError, ValueError) as error:
        raise WorkbenchError(
            "目录中的库清单无法读取，请保留原文件", "invalid_library", 409
        ) from error


def inspect_library(value):
    path = library_path(value)
    if path.exists() and not path.is_dir():
        raise WorkbenchError("所选路径不是文件夹")
    projects = _manifest(inside(path, "projects.json"), {}).get("projects", {})
    templates = _manifest(inside(path, "templates/library.json"), {}).get("templates", {})
    palettes = _manifest(inside(path, "palettes.json"), {}).get("palettes", [])
    if (
        not isinstance(projects, dict)
        or not isinstance(templates, dict)
        or not isinstance(palettes, list)
    ):
        raise WorkbenchError("目录中的库清单格式无效", "invalid_library", 409)
    trash = inside(path, "trash")
    return {
        "path": str(path),
        "exists": path.exists(),
        "empty": not path.exists() or not any(path.iterdir()),
        "projects": len(projects),
        "templates": len(templates),
        "palettes": len(palettes),
        "trash": sum(1 for p in trash.iterdir() if p.is_dir()) if trash.is_dir() else 0,
        "recognized": any(
            (path / name).exists()
            for name in ("projects.json", "templates/library.json", "palettes.json")
        ),
    }


def _files(root):
    for name in OWNED_NAMES:
        if (root / name).is_symlink():
            raise WorkbenchError("库中含符号链接，请先确认文件归属", "library_symlink", 409)
        path = inside(root, name)
        if path.is_symlink():
            raise WorkbenchError("库中含符号链接，请先确认文件归属", "library_symlink", 409)
        if path.is_dir():
            for directory, dirs, files in os.walk(path, followlinks=False):
                for child in dirs + files:
                    if (Path(directory) / child).is_symlink():
                        raise WorkbenchError("库中含符号链接，未迁移", "library_symlink", 409)
                for filename in files:
                    item = inside(root, Path(directory) / filename)
                    yield item.relative_to(root)
        elif path.is_file():
            yield path.relative_to(root)


def _digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def _rebase(path, source, target):
    try:
        relative = Path(path).resolve().relative_to(source)
    except (ValueError, TypeError):
        return path
    if relative.parts and relative.parts[0] in ("projects", "templates", "trash"):
        return str(target / relative)
    return path


def migrate_library(manager, value, expected_source):
    target = library_path(value)
    with manager.lock, manager.store.lock, manager.palettes.lock, manager.drafts.lock:
        source = manager.root.resolve()
        if library_path(expected_source) != source:
            raise WorkbenchError("当前库已变化，请重新检查迁移位置", "library_changed", 409)
        if target == source or target.is_relative_to(source) or source.is_relative_to(target):
            raise WorkbenchError("新库与原库不能相同或互相包含", "library_overlap", 409)
        if not inspect_library(target)["empty"]:
            raise WorkbenchError("迁移目标须为空文件夹；已有库请使用切换", "library_not_empty", 409)
        if any(job["status"] == "running" for job in manager.service.jobs.values()) or any(
            not session.get("closed") for session in manager.service.sessions.values()
        ):
            raise WorkbenchError("请先完成或取消正在运行的绘图与图内编辑", "library_busy", 409)
        before = {str(p): _digest(inside(source, p)) for p in _files(source)}
        # Drafts live in the user-data directory, scoped by library identity.
        # Carry the complete namespace, including unreadable recovery files,
        # without touching the rollback namespace or replacing target drafts.
        source_drafts, target_drafts = manager.drafts.root, DraftStore(target).root
        if target_drafts.exists() and any(target_drafts.iterdir()):
            raise WorkbenchError("目标位置已有本机草稿，请先切换到该库检查", "draft_conflict", 409)
        draft_files = {}
        if source_drafts.exists():
            for item in source_drafts.rglob("*"):
                if item.is_symlink():
                    raise WorkbenchError("草稿含符号链接，原库保持不变", "library_symlink", 409)
                if item.is_file():
                    draft_files[str(item.relative_to(source_drafts))] = _digest(item)
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".pwb-migrate-", dir=target.parent) as temporary:
            stage = Path(temporary) / "library"
            stage.mkdir()
            for relative in before:
                destination = inside(stage, relative)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(inside(source, relative), destination)
                if _digest(destination) != before[relative]:
                    raise WorkbenchError(
                        "复制校验失败，原库保持不变", "migration_verify_failed", 409
                    )
            if before != {str(p): _digest(inside(source, p)) for p in _files(source)}:
                raise WorkbenchError("原库在复制期间发生变化，请重试", "library_changed", 409)
            index_path = stage / "projects.json"
            if index_path.is_file():
                index = _manifest(index_path, {})
                for project in index.get("projects", {}).values():
                    project["path"] = _rebase(project["path"], source, target)
                atomicio.write_json(index_path, index)
            trash = stage / "trash"
            for metadata in trash.glob("*/trash.json") if trash.is_dir() else ():
                item = _manifest(metadata, {})
                if item.get("original_path"):
                    item["original_path"] = _rebase(item["original_path"], source, target)
                    atomicio.write_json(metadata, item)
            # Publication is confined to an explicitly selected empty target.
            if target.exists():
                target.rmdir()
            os.replace(stage, target)
        if draft_files:
            target_drafts.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(
                prefix=".pwb-drafts-", dir=target_drafts.parent
            ) as temporary:
                stage = Path(temporary) / "drafts"
                stage.mkdir()
                for relative, digest in draft_files.items():
                    item = inside(stage, relative)
                    item.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(inside(source_drafts, relative), item)
                    if (
                        _digest(item) != digest
                        or _digest(inside(source_drafts, relative)) != digest
                    ):
                        raise WorkbenchError(
                            "草稿复制校验失败，原库保持不变", "migration_verify_failed", 409
                        )
                if target_drafts.exists():
                    target_drafts.rmdir()
                os.replace(stage, target_drafts)
        try:
            status = manager.switch_root(target)
        except Exception:
            # The verified copy remains available for recovery; the old root is untouched.
            raise
        return {
            **status,
            "migration": {
                "source": str(source),
                "files_verified": len(before),
                "draft_files_verified": len(draft_files),
                "original_preserved": True,
            },
        }


def storage_locations(manager, project_id=None):
    frozen = bool(getattr(sys, "frozen", False))
    executable = Path(sys.executable).resolve()
    program = executable.parents[2] if frozen else Path(__file__).resolve().parents[3]
    result = {
        "program": str(program),
        "program_mode": "installed" if frozen else "development",
        "library": str(manager.root),
        "data": str(config.data_dir()),
        "project": str(manager.store.working_directory(project_id)) if project_id else None,
        "installation": {
            "status": "development",
            "message": "当前为源码运行，安装检查在桌面发行版中可用。",
        },
    }
    if frozen:
        binary = program / "PlotWorkbench.exe"
        result["installation"] = {
            "status": "unsupported",
            "message": "此平台暂不提供安装登记检查。",
        }
        if os.name == "nt":
            import winreg

            key_path = rf"Software\Microsoft\Windows\CurrentVersion\Uninstall\{brand.PRODUCT_NAME}"
            try:
                with winreg.OpenKey(
                    winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY
                ) as key:
                    location = winreg.QueryValueEx(key, "InstallLocation")[0].strip('"')
                    uninstall = winreg.QueryValueEx(key, "UninstallString")[0].strip('"')
                    version = winreg.QueryValueEx(key, "DisplayVersion")[0]
                matches = config.normalize_path_identity(
                    Path(location).resolve()
                ) == config.normalize_path_identity(program)
                matches = matches and config.normalize_path_identity(
                    Path(uninstall).resolve()
                ) == config.normalize_path_identity(program / "uninstall.exe")
                matches = matches and version == brand.WORKBENCH_VERSION
                result["installation"] = {
                    "status": "ok" if matches and binary.is_file() else "mismatch",
                    "message": "安装登记与正在运行的程序一致。"
                    if matches and binary.is_file()
                    else "安装登记的位置或版本与当前程序不一致，请使用正式安装包修复安装。",
                    "registered_directory": location,
                    "registered_version": version,
                }
            except OSError:
                result["installation"] = {
                    "status": "missing",
                    "message": "未找到完整的系统安装登记，请使用正式安装包修复安装。",
                }
    return result
