"""Save explicit local exports without overwriting an existing user file."""

from pathlib import Path

from .store import WorkbenchError, inside


def save_export(directory, filename, content, extension):
    if not isinstance(directory, str) or not directory.strip():
        raise WorkbenchError("请选择导出目录")
    root = Path(directory).expanduser()
    if not root.is_absolute():
        raise WorkbenchError("导出目录必须为绝对路径")
    if (
        not isinstance(filename, str)
        or not filename.strip()
        or len(filename) > 180
        or any(c in filename for c in '<>:"/\\|?*')
        or any(ord(c) < 32 for c in filename)
        or filename.endswith((" ", "."))
        or Path(filename).suffix.lower() != f".{extension}"
        or filename.split(".")[0].upper()
        in {
            "CON",
            "PRN",
            "AUX",
            "NUL",
            *(f"COM{i}" for i in range(1, 10)),
            *(f"LPT{i}" for i in range(1, 10)),
        }
    ):
        raise WorkbenchError(f"请输入有效的 .{extension} 文件名")
    target = inside(root, filename)
    if not target.parent.is_dir():
        raise WorkbenchError("导出目录不存在，请重新选择")
    try:
        stream = target.open("xb")
    except FileExistsError as exc:
        raise WorkbenchError("已有同名文件，请修改导出名称后重试", "export_exists", 409) from exc
    try:
        with stream:
            stream.write(content)
            stream.flush()
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return target
