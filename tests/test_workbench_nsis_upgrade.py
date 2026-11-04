"""Execute the real NSIS directory-selection code against isolated registry keys.

The probe installer contains no product files and writes only to pytest's temp
directory. It must never read or alter the real Plot Workbench installation.
Set WORKBENCH_MAKENSIS to a Unicode NSIS compiler on Windows to run it.
"""

import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

if sys.platform == "win32":
    import winreg


ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "src-tauri/windows/installer.nsi"


def _function(source: str, name: str) -> str:
    return source.split(f"Function {name}\n", 1)[1].split("FunctionEnd", 1)[0]


@pytest.fixture
def probe(tmp_path):
    if sys.platform != "win32":
        pytest.skip("NSIS installer behavior requires Windows")
    compiler = os.environ.get("WORKBENCH_MAKENSIS") or shutil.which("makensis.exe")
    if not compiler:
        pytest.skip("Set WORKBENCH_MAKENSIS to the NSIS compiler")

    key_name = rf"Software\PlotWorkbenchUpgradeProbe_{uuid.uuid4().hex}"
    source = TEMPLATE.read_text(encoding="utf-8")
    output, executable = tmp_path / "selected.txt", tmp_path / "probe.exe"
    script = r"""
Unicode true
RequestExecutionLevel user
!include LogicLib.nsh
!include FileFunc.nsh
!include x64.nsh
!define PRODUCTNAME "Plot Workbench"
!define MAINBINARYNAME "PlotWorkbench"
!define INSTALLMODE "currentUser"
!define ARCH "x64"
!define DISPLAYLANGUAGESELECTOR "false"
!define UNINSTKEY "__KEY__\Uninstall"
!define MANUPRODUCTKEY "__KEY__\Manufacturer"
!define PLACEHOLDER_INSTALL_DIR "placeholder\${PRODUCTNAME}"
!macro SetContext
SetShellVarContext current
${If} ${RunningX64}
  SetRegView 64
${EndIf}
!macroend
Var PassiveMode
Var NoShortcutMode
Var UpdateMode
Var ExistingInstall
InstallDir "${PLACEHOLDER_INSTALL_DIR}"
SilentInstall silent
OutFile "__EXE__"
LangString updateInstallNotFound ${LANG_ENGLISH} "Cannot find the existing installation."
Function .onInit
__INIT__
FunctionEnd
Function RestorePreviousInstallLocation
__RESTORE__
FunctionEnd
Section
FileOpen $0 "__OUT__" w
FileWriteUTF16LE $0 "$INSTDIR"
FileClose $0
SectionEnd
"""
    for old, new in (
        ("__KEY__", key_name),
        ("__EXE__", str(executable)),
        ("__OUT__", str(output)),
        ("__INIT__", _function(source, ".onInit")),
        ("__RESTORE__", _function(source, "RestorePreviousInstallLocation")),
    ):
        script = script.replace(old, new)
    script_path = tmp_path / "probe.nsi"
    script_path.write_text(script, encoding="utf-8-sig")
    subprocess.run([compiler, str(script_path)], check=True, capture_output=True)
    try:
        with (
            winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_name + r"\Manufacturer") as path_key,
            winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_name + r"\Uninstall") as key,
        ):
            yield path_key, key, executable, output
    finally:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_name + r"\Manufacturer")
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_name + r"\Uninstall")
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_name)


@pytest.mark.parametrize("explicit_other_dir", [False, True])
@pytest.mark.parametrize("mode", ["/S", "/P"])
def test_updater_uses_recorded_custom_install_even_with_a_different_default(
    probe, tmp_path, explicit_other_dir, mode
):
    path_key, key, exe, output = probe
    installed = tmp_path / "原先的 安装目录"
    installed.mkdir()
    (installed / "PlotWorkbench.exe").write_bytes(b"old")
    winreg.SetValueEx(path_key, "", 0, winreg.REG_SZ, str(installed))
    winreg.SetValueEx(key, "UninstallString", 0, winreg.REG_SZ, f'"{installed}\\uninstall.exe"')
    other = tmp_path / "different location"
    # Tauri's Windows updater also passes /R and /ARGS, even with no app arguments.
    command = subprocess.list2cmdline([str(exe), mode, "/R", "/UPDATE", "/ARGS"])
    if explicit_other_dir:
        command += f" /D={other}"
    subprocess.run(command, check=True)
    assert output.read_text(encoding="utf-16le") == str(installed)
    assert not other.exists()


def test_updater_refuses_to_guess_when_existing_install_is_not_registered(probe):
    _, _, exe, output = probe
    completed = subprocess.run([str(exe), "/S", "/UPDATE"])
    assert completed.returncode != 0
    assert not output.exists()


def test_updater_refuses_a_stale_registered_directory(probe, tmp_path):
    path_key, key, exe, output = probe
    missing = tmp_path / "missing"
    winreg.SetValueEx(path_key, "", 0, winreg.REG_SZ, str(missing))
    winreg.SetValueEx(key, "UninstallString", 0, winreg.REG_SZ, f'"{missing}\\uninstall.exe"')
    completed = subprocess.run([str(exe), "/S", "/UPDATE"])
    assert completed.returncode != 0
    assert not output.exists()


def test_updater_refuses_old_path_without_an_active_installation_record(probe, tmp_path):
    path_key, _, exe, output = probe
    old = tmp_path / "old installation"
    old.mkdir()
    (old / "PlotWorkbench.exe").write_bytes(b"old")
    winreg.SetValueEx(path_key, "", 0, winreg.REG_SZ, str(old))
    completed = subprocess.run([str(exe), "/S", "/UPDATE"])
    assert completed.returncode != 0
    assert not output.exists()


def test_updater_refuses_conflicting_installation_records(probe, tmp_path):
    path_key, key, exe, output = probe
    old = tmp_path / "registered executable"
    old.mkdir()
    (old / "PlotWorkbench.exe").write_bytes(b"old")
    winreg.SetValueEx(path_key, "", 0, winreg.REG_SZ, str(old))
    winreg.SetValueEx(
        key, "UninstallString", 0, winreg.REG_SZ, f'"{tmp_path}\\other\\uninstall.exe"'
    )
    completed = subprocess.run([str(exe), "/S", "/UPDATE"])
    assert completed.returncode != 0
    assert not output.exists()


@pytest.mark.parametrize("cache", ["missing", "stale"])
@pytest.mark.parametrize("quoted", [False, True])
def test_active_install_location_wins_over_the_historical_cache(probe, tmp_path, cache, quoted):
    path_key, key, exe, output = probe
    installed = tmp_path / "当前的 安装目录"
    installed.mkdir()
    (installed / "PlotWorkbench.exe").write_bytes(b"old")
    location = f'"{installed}"' if quoted else str(installed)
    winreg.SetValueEx(key, "InstallLocation", 0, winreg.REG_SZ, location)
    winreg.SetValueEx(key, "UninstallString", 0, winreg.REG_SZ, f'"{installed}\\uninstall.exe"')
    if cache == "stale":
        winreg.SetValueEx(path_key, "", 0, winreg.REG_SZ, str(tmp_path / "old location"))
    subprocess.run([str(exe), "/P", "/R", "/UPDATE", "/ARGS"], check=True)
    assert output.read_text(encoding="utf-16le") == str(installed)


def test_updater_refuses_conflicting_active_install_location(probe, tmp_path):
    path_key, key, exe, output = probe
    installed = tmp_path / "actual installation"
    installed.mkdir()
    (installed / "PlotWorkbench.exe").write_bytes(b"old")
    winreg.SetValueEx(path_key, "", 0, winreg.REG_SZ, str(installed))
    winreg.SetValueEx(key, "UninstallString", 0, winreg.REG_SZ, f'"{installed}\\uninstall.exe"')
    winreg.SetValueEx(key, "InstallLocation", 0, winreg.REG_SZ, f'"{tmp_path / "other"}"')
    completed = subprocess.run([str(exe), "/S", "/UPDATE"])
    assert completed.returncode != 0
    assert not output.exists()


def test_first_install_still_respects_explicit_directory(probe, tmp_path):
    _, _, exe, output = probe
    target = tmp_path / "new install"
    command = subprocess.list2cmdline([str(exe), "/S"]) + f" /D={target}"
    subprocess.run(command, check=True)
    assert output.read_text(encoding="utf-16le") == str(target)
