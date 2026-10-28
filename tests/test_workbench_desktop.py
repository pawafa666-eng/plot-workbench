"""The local Workbench shell and the Windows shortcut icon contract.

These checks inspect declared commands, capability JSON and NSIS instructions.
They do not stand in for building or opening the Windows installer.
"""

import copy
import json
import re
import shlex
from pathlib import Path

import pytest
import tomllib

from tests.support.rustsrc import (
    handler_commands,
    manifest_commands,
    rust_code,
    tauri_commands,
    window_builders,
)

ROOT = Path(__file__).resolve().parents[1]
TAURI = ROOT / "src-tauri"
LOCAL_COMMANDS = {
    "reveal_export",
    "reveal_project_dir",
    "set_menu_locale",
    "codex_integration",
    "arm_close_guard",
    "resolve_close_request",
    "native_file_drop",
}
SHORTCUT_ICON = "$INSTDIR\\workbench.ico"


def _config():
    return json.loads((TAURI / "tauri.conf.json").read_text(encoding="utf-8"))


def test_updater_http_client_enables_windows_system_proxy():
    # Subject: the desktop shell's resolved HTTP-client family, not the WebView
    # or Python sidecar. Updater 2.10.1 disables reqwest defaults, including
    # system-proxy, so an explicit shared dependency must restore that feature.
    manifest = tomllib.loads((TAURI / "Cargo.toml").read_text(encoding="utf-8"))
    http = manifest["dependencies"].get("reqwest", {})
    assert "system-proxy" in http.get("features", []), "Updater must read Windows proxy settings"
    assert http["version"] == "0.13"
    assert http["default-features"] is False
    packages = tomllib.loads((TAURI / "Cargo.lock").read_text(encoding="utf-8"))["package"]
    clients = [package for package in packages if package["name"] == "reqwest"]
    assert len(clients) == 1 and clients[0]["version"].startswith("0.13.")
    updater = next(package for package in packages if package["name"] == "tauri-plugin-updater")
    assert "reqwest" in updater["dependencies"], "Shell and updater must share the HTTP client"


def _nsis_body(name):
    source = (TAURI / "windows/installer.nsi").read_text(encoding="utf-8")
    return source.split(f"Function {name}\n", 1)[1].split("FunctionEnd", 1)[0]


def _nsis_instructions(source):
    return [
        shlex.split(line, posix=True)
        for line in source.splitlines()
        if line.strip() and not line.lstrip().startswith(";")
    ]


def test_workbench_only_registers_local_desktop_commands():
    assert set(tauri_commands()) == LOCAL_COMMANDS
    assert set(manifest_commands()) == LOCAL_COMMANDS
    assert set(handler_commands()) == LOCAL_COMMANDS


def test_workbench_only_builds_and_grants_permissions_to_the_main_window():
    code = rust_code((TAURI / "src/main.rs").read_text(encoding="utf-8"))
    assert set(window_builders(code)) == {"MAIN_WINDOW"}
    caps = list((TAURI / "capabilities").glob("*.json"))
    assert {p.name for p in caps} == {"main.json"}
    for path in caps:
        cap = json.loads(path.read_text(encoding="utf-8"))
        assert cap["windows"] == ["main"]
        granted_commands = {p for p in cap["permissions"] if p.startswith("allow-")}
        assert granted_commands == {"allow-" + c.replace("_", "-") for c in LOCAL_COMMANDS}


def test_bundled_shell_pages_are_the_local_startup_and_error_pages():
    assert {p.name for p in (TAURI / "shell").glob("*.html")} == {
        "splash.html",
        "error.html",
    }


def test_shortcut_icon_is_an_installed_resource_from_the_approved_icon():
    conf = _config()
    assert conf["bundle"]["resources"]["../assets/workbench/icon.ico"] == "workbench.ico"
    assert "../assets/workbench/icon.ico" in conf["bundle"]["icon"]


def test_every_created_windows_shortcut_has_an_explicit_workbench_icon():
    instructions = _nsis_instructions((TAURI / "windows/installer.nsi").read_text("utf-8"))
    shortcuts = [row for row in instructions if row[0] == "CreateShortcut"]
    assert len(shortcuts) == 3
    for row in shortcuts:
        assert row[2:] == ["$INSTDIR\\${MAINBINARYNAME}.exe", "", SHORTCUT_ICON, "0"]


@pytest.mark.parametrize(
    "function", ["CreateOrUpdateStartMenuShortcut", "CreateOrUpdateDesktopShortcut"]
)
def test_existing_shortcut_icon_is_refreshed_before_update_skips_creation(function):
    body = _nsis_body(function)
    instructions = _nsis_instructions(body)
    refresh = [
        row for row in instructions if row[:2] == ["!insertmacro", "RefreshWorkbenchShortcutIcon"]
    ]
    assert len(refresh) == (2 if "StartMenu" in function else 1)
    assert body.index("!insertmacro RefreshWorkbenchShortcutIcon") < body.index("$UpdateMode = 1")


def test_refresh_only_updates_matching_shortcuts_and_preserves_other_link_properties():
    source = (TAURI / "windows/installer.nsi").read_text("utf-8")
    body = source.split("!macro RefreshWorkbenchShortcutIcon shortcut\n", 1)[1].split(
        "!macroend", 1
    )[0]
    instructions = _nsis_instructions(body)
    assert instructions[0] == [
        "!insertmacro",
        "IsShortcutTarget",
        "${shortcut}",
        "$INSTDIR\\${MAINBINARYNAME}.exe",
    ]
    assert instructions[1:3] == [["Pop", "$0"], ["${If}", "$0", "=", "1"]]
    assert re.search(
        r'\$\{IShellLink::SetIconLocation\}\s+\$0\s+\'\(w "\$INSTDIR\\workbench.ico", 0\)\'', body
    )
    assert "${IPersistFile::Load}" in body and "${IPersistFile::Save}" in body
    assert all(row[0] != "CreateShortcut" for row in instructions)


def test_build_refuses_to_ship_without_the_shortcut_icon_resource():
    from tests.test_workbench_packaging import builder

    conf = copy.deepcopy(_config())
    conf["bundle"]["resources"].pop("../assets/workbench/icon.ico", None)
    with pytest.raises(ValueError, match="shortcut icon"):
        builder.validate_packaging(conf)
