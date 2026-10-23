"""The native smoke must observe the shell's child, not its consumed handshake."""

import importlib.util
import io
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "workbench_installer_smoke", ROOT / "scripts/workbench_installer_smoke.py"
)
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def test_close_only_targets_the_desktop_frame_not_visible_runtime_windows(monkeypatch):
    # The real Windows candidate also exposes WS_VISIBLE message sinks. Closing
    # Tao's event target first destroys dispatch before Tauri can finish Exit.
    # Visibility alone does not mean a user-facing application window.
    windows = [
        {"handle": 101, "class": "Tauri Window", "visible": True},
        {"handle": 102, "class": "workbench-sic", "visible": True},
        {"handle": 103, "class": "Tao Thread Event Target", "visible": True},
        {"handle": 104, "class": "Tauri Window", "visible": False},
    ]
    observed = []

    def native_windows(pid):
        observed.append(pid)
        return windows

    posted = []

    def post(window, message, wparam, lparam):
        posted.append((window.value, message, wparam, lparam))
        return True

    monkeypatch.setattr(smoke, "native_windows", native_windows)
    monkeypatch.setattr(
        smoke.ctypes,
        "windll",
        SimpleNamespace(user32=SimpleNamespace(PostMessageW=post)),
        raising=False,
    )
    assert smoke.close_window(412) == 1
    assert observed == [412]
    assert posted == [(101, 0x0010, 0, 0)]


@pytest.mark.parametrize("protected_status", [401, 200])
def test_shell_smoke_uses_owned_listener_after_handshake_is_consumed(
    tmp_path, monkeypatch, protected_status
):
    shell = tmp_path / "PlotWorkbench.exe"
    sidecar = tmp_path / "sidecar/Tavotto/Tavotto.exe"
    process = SimpleNamespace(pid=412, returncode=None)
    process.poll = lambda: process.returncode
    process.wait = lambda **_: setattr(process, "returncode", 0)
    process.kill = lambda: setattr(process, "returncode", -1)
    monkeypatch.setattr(smoke.subprocess, "Popen", lambda *a, **kw: process)
    monkeypatch.setattr(smoke, "ROOT", tmp_path)
    monkeypatch.setattr(smoke, "native_windows", lambda _: [])
    monkeypatch.setattr(smoke.tempfile, "gettempdir", lambda: str(tmp_path))
    ticks = iter(range(1000))
    monkeypatch.setattr(smoke.time, "monotonic", lambda: next(ticks))
    monkeypatch.setattr(smoke.time, "sleep", lambda *_: None)
    monkeypatch.setattr(smoke, "alive", lambda _: False)
    closed = []

    def close(pid):
        closed.append(pid)
        return int(len(closed) >= 2)

    monkeypatch.setattr(smoke, "close_window", close)
    listeners = [
        {"pid": 555, "exe": str(tmp_path / "other.exe"), "ports": [12345]},
        {"pid": 456, "exe": str(sidecar), "ports": [54321]},
    ]
    monkeypatch.setattr(
        smoke.subprocess,
        "run",
        lambda *a, **kw: SimpleNamespace(returncode=0, stdout=json.dumps(listeners), stderr=""),
    )
    requests = []

    def open_url(url, **_):
        requests.append(url)
        assert ":54321/" in url, "must ignore a listener owned by another executable"
        if url.endswith("/api/session/ping") and protected_status == 401:
            raise HTTPError(url, 401, "Unauthorized", {}, io.BytesIO(b"{}"))

    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

    def response(url, **kwargs):
        open_url(url, **kwargs)
        return Response()

    monkeypatch.setattr(smoke.urllib.request, "urlopen", response)
    if protected_status == 401:
        smoke.shell_smoke(shell, {})
        assert closed == [412, 412]
        assert requests == [
            "http://127.0.0.1:54321/",
            "http://127.0.0.1:54321/api/session/ping",
        ]
    else:
        with pytest.raises(RuntimeError, match="authentication"):
            smoke.shell_smoke(shell, {})


@pytest.mark.skipif(os.name != "nt", reason="Uses Windows process and TCP owner queries")
def test_listener_query_observes_a_real_owned_child(tmp_path):
    # venv python.exe is a launcher on Windows; use the real interpreter so the
    # tested listener belongs to our direct child, as the frozen sidecar does.
    interpreter = Path(sys._base_executable)
    process = subprocess.Popen(
        [str(interpreter), "-m", "http.server", "0", "--bind", "127.0.0.1"],
        cwd=tmp_path,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        deadline = time.monotonic() + 20
        listeners = []
        while time.monotonic() < deadline:
            listeners = smoke.shell_listeners(os.getpid(), interpreter)
            if any(pid == process.pid for pid, _ in listeners):
                break
            time.sleep(0.1)
        assert any(pid == process.pid and port > 0 for pid, port in listeners)
        assert smoke.shell_listeners(os.getpid(), tmp_path / "another.exe") == []
    finally:
        process.terminate()
        process.wait(timeout=10)
