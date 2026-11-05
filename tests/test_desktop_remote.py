"""Inherited engine-window capability guards remain conservative.

Plot Workbench creates only its local main window. Keep the browser fallback
checks for the shared frontend adapter and the upstream engine version contract.
The local-only shell is checked in test_workbench_desktop.py.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DESKTOP_TS = ROOT / "web/src/lib/desktop.ts"


def test_the_shared_engine_keeps_its_compatibility_feature():
    from tavotto import app as tavotto_app

    body = tavotto_app.app.test_client().get("/api/version").get_json()
    assert tavotto_app.DESKTOP_REMOTE_WINDOW_FEATURE in body["features"]
    assert isinstance(body["version"], str) and "build" in body


def test_local_file_capabilities_are_gated_on_the_local_engine():
    """本机文件类能力按 `isDesktop()`（= 壳 + 本机引擎）判，壳本身的能力按 `hasDesktopShell()`。

    反了的两种坏法：本机能力用了 `hasDesktopShell()` → 远程窗口里弹本机对话框；
    菜单 / 关窗询问用了 `isDesktop()` → 远程窗口里 ⌘S 与关窗询问全部失灵。"""
    ts = DESKTOP_TS.read_text(encoding="utf-8")

    def guard(fn: str) -> str:
        start = ts.index(f"export async function {fn}(")
        body = ts[start : ts.index("\n}\n", start)]
        m = re.search(r"if \(!(\w+)\(\)", body)
        assert m, f"{fn} 开头没有桌面判据"
        return m.group(1)

    local = [
        "nativeFileDropAvailable",
        "onNativeFileDrop",
        "pickDirectory",
        "pickScriptFile",
        "revealExportedFile",
        "revealProjectFolder",
        "setDesktopMenuLocale",
        "runCodexIntegration",
        "checkDesktopUpdate",
        "onDesktopOpen",
    ]
    shell = [
        "onDesktopMenu",
        "armDesktopCloseGuard",
        "onDesktopCloseRequested",
        "resolveDesktopCloseRequest",
    ]
    assert {f: guard(f) for f in local} == dict.fromkeys(local, "isDesktop")
    assert {f: guard(f) for f in shell} == dict.fromkeys(shell, "hasDesktopShell")
