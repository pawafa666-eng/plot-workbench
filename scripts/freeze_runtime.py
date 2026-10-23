"""Preserve the private Windows Python distribution as opaque package data."""

from pathlib import Path


def runtime_data_toc(root):
    """Build DATA entries to append after PyInstaller's dependency analysis.

    Feeding these DLLs/PYDs into Analysis makes PyInstaller resolve their
    dependencies into the Flask parent's root. Identically named OpenSSL DLLs
    from different CPython patch releases then replace the parent's own DLLs.
    The worker distribution is already closed and verified by its runtime lock.
    """
    root = Path(root)
    return [
        (str(Path("runtime") / path.relative_to(root)), str(path), "DATA")
        for path in sorted(root.rglob("*"))
        if path.is_file()
    ]
