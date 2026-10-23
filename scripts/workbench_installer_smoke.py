"""Install, run and uninstall the actual Windows installer with Python off PATH.

The harness itself uses an absolute build-Python path; every application child
receives only Windows system directories on PATH and no interpreter override.
"""

from __future__ import annotations

import argparse
import ctypes
import importlib.util
import json
import os
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(argv, env: dict, timeout: int = 600) -> None:
    result = subprocess.run(argv, cwd=ROOT, env=env, timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}): {argv}")


def alive(pid: int) -> bool:
    kernel = ctypes.windll.kernel32
    kernel.OpenProcess.restype = ctypes.c_void_p
    handle = kernel.OpenProcess(0x100000, False, pid)
    if not handle:
        return False
    try:
        return kernel.WaitForSingleObject(ctypes.c_void_p(handle), 0) == 258
    finally:
        kernel.CloseHandle(ctypes.c_void_p(handle))


def close_window(pid: int) -> None:
    user = ctypes.windll.user32
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    @callback_type
    def visit(window, _):
        owner = ctypes.c_ulong()
        user.GetWindowThreadProcessId(ctypes.c_void_p(window), ctypes.byref(owner))
        if owner.value == pid:
            user.PostMessageW(ctypes.c_void_p(window), 0x0010, 0, 0)
        return True

    user.EnumWindows(visit, 0)


def shell_smoke(shell: Path, env: dict) -> None:
    before = set(Path(tempfile.gettempdir()).glob("tavotto-handshake-*.json"))
    process = subprocess.Popen([str(shell)], env=env, cwd=shell.parent)
    side_pid = None
    try:
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f"Desktop shell exited early: {process.returncode}")
            for handshake in (
                set(Path(tempfile.gettempdir()).glob("tavotto-handshake-*.json")) - before
            ):
                # The shell includes its own PID in the public handshake filename.
                if not handshake.name.startswith(f"tavotto-handshake-{process.pid}-"):
                    continue
                try:
                    state = json.loads(handshake.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                if state.get("ready"):
                    side_pid = state["pid"]
                    with urllib.request.urlopen(
                        f"http://127.0.0.1:{state['port']}/", timeout=10
                    ) as response:
                        assert response.status == 200
                    break
            if side_pid:
                break
            time.sleep(0.25)
        if not side_pid:
            raise RuntimeError("Desktop shell did not start its authenticated sidecar")
        close_window(process.pid)
        process.wait(timeout=30)
        deadline = time.monotonic() + 20
        while alive(side_pid) and time.monotonic() < deadline:
            time.sleep(0.2)
        if alive(side_pid):
            raise RuntimeError(f"Orphaned sidecar after desktop close: {side_pid}")
        print("PASS: installed desktop shell -> sidecar -> clean close")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)


def workbench_smoke(sidecar: Path, env: dict, work: Path) -> None:
    """Exercise workbench HTTP operations on the installed, authenticated sidecar."""
    script = ROOT / "scripts" / "workbench_api_smoke.py"
    if not script.is_file():
        raise RuntimeError(f"Workbench HTTP smoke is missing: {script}")
    spec = importlib.util.spec_from_file_location("workbench_api_smoke", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    work.mkdir(parents=True, exist_ok=True)
    handshake = work / "handshake.json"
    child_env = {
        **env,
        "TAVOTTO_DATA_DIR": str(work / "data"),
        "TAVOTTO_CONFIG_DIR": str(work / "config"),
        "TAVOTTO_DESKTOP_HANDSHAKE": str(handshake),
    }
    nonce = secrets.token_urlsafe(32)
    with (work / "sidecar.log").open("w", encoding="utf-8") as output:
        process = subprocess.Popen(
            [str(sidecar), "--desktop-sidecar"],
            stdin=subprocess.PIPE,
            stdout=output,
            stderr=subprocess.STDOUT,
            env=child_env,
            cwd=work,
        )
        try:
            process.stdin.write(
                json.dumps({"nonce": nonce, "parent_pid": os.getpid()}).encode() + b"\n"
            )
            process.stdin.flush()
            deadline = time.monotonic() + 90
            state = None
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(
                        f"Installed workbench sidecar exited early: {process.returncode}"
                    )
                try:
                    state = json.loads(handshake.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    time.sleep(0.2)
                    continue
                break
            if not state or not state.get("ready") or state.get("pid") != process.pid:
                raise RuntimeError("Installed workbench sidecar did not complete its own handshake")
            base = f"http://127.0.0.1:{state['port']}"
            request = urllib.request.Request(
                f"{base}/api/desktop/bootstrap",
                data=json.dumps({"nonce": nonce}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=15) as response:
                cookie = response.headers.get("Set-Cookie", "").split(";", 1)[0]
            if not cookie:
                raise RuntimeError("Installed sidecar did not issue a session cookie")
            # Authentication material is passed in memory and is never printed.
            module.smoke_workbench(base, headers={"Cookie": cookie})
            print("PASS: installed workbench authenticated project/data/template/render operations")
        finally:
            if process.stdin:
                process.stdin.close()
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
                raise RuntimeError(
                    "Installed workbench sidecar failed to exit after stdin EOF"
                ) from None


def main() -> None:
    if sys.platform != "win32":
        raise SystemExit("This installer smoke runs on Windows.")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installer", type=Path, required=True)
    args = parser.parse_args()
    installer = args.installer.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="plot-workbench-install-") as scratch:
        work = Path(scratch)
        install = work / "中文 安装目录" / "Plot Workbench"
        env = dict(os.environ)
        for name in (
            "PYTHONHOME",
            "PYTHONPATH",
            "PYTHONSTARTUP",
            "PYTHONUSERBASE",
            "CONDA_PREFIX",
            "VIRTUAL_ENV",
            "TAVOTTO_WORKER_PYTHON",
            "MM_WORKER_PYTHON",
            "TAVOTTO_RUNTIME_DIR",
            "TAVOTTO_WORKERD_BIN",
            "TAVOTTO_SIDECAR_EXE",
        ):
            env.pop(name, None)
        windows = Path(env.get("SystemRoot", r"C:\Windows"))
        env.update(
            PATH=os.pathsep.join([str(windows / "System32"), str(windows)]),
            TAVOTTO_NO_TELEMETRY="1",
            TAVOTTO_NO_UPDATE_CHECK="1",
            TAVOTTO_DATA_DIR=str(work / "data"),
            TAVOTTO_CONFIG_DIR=str(work / "config"),
        )
        # NSIS /D must be last and unquoted. shell=False passes this command line
        # directly to CreateProcess; no command interpreter parses the path.
        command = subprocess.list2cmdline([str(installer), "/S"]) + f" /D={install}"
        run(command, env)
        sidecar = install / "sidecar" / "Tavotto" / "Tavotto.exe"
        bundled = sidecar.parent / "_internal" / "runtime" / "python.exe"
        shell = install / "PlotWorkbench.exe"
        try:
            for path in (sidecar, bundled, shell, install / "LICENSE", install / "ATTRIBUTION.txt"):
                if not path.is_file():
                    raise RuntimeError(f"Missing installed artifact: {path}")
            run(
                [
                    str(bundled),
                    "-B",
                    "-c",
                    "import matplotlib, pandas, seaborn, openpyxl, xlrd; print('PASS: all bundled scientific and Excel imports')",
                ],
                env,
            )
            run(
                [
                    sys.executable,
                    "scripts/smoke_desktop.py",
                    "--sidecar",
                    str(sidecar),
                    "--diagnostics",
                    str(ROOT / "build" / "workbench-installer-smoke" / "desktop"),
                ],
                env,
            )
            run(
                [
                    sys.executable,
                    "scripts/smoke_app.py",
                    "--exe",
                    str(sidecar),
                    "--figures",
                    "examples/runtime_check",
                    "--workdir",
                    str(work / "绘图 冒烟"),
                    "--expect-source",
                    "bundled",
                    "--expect-runtime",
                    "--expect-control-plane",
                    "workerd",
                    "--expect-packages",
                    "numpy,pandas,scipy,seaborn,PIL,matplotlib,openpyxl,xlrd",
                ],
                env,
            )
            workbench_smoke(sidecar, env, work / "workbench-api")
            shell_smoke(shell, env)
        finally:
            uninstaller = install / "uninstall.exe"
            if uninstaller.is_file():
                run([str(uninstaller), "/S"], env)
                deadline = time.monotonic() + 30
                while shell.exists() and time.monotonic() < deadline:
                    time.sleep(0.2)
                if shell.exists():
                    raise RuntimeError("Uninstall did not remove the desktop executable")
        print("PASS: installer, bundled runtime, rendering, native window and uninstall")


if __name__ == "__main__":
    main()
