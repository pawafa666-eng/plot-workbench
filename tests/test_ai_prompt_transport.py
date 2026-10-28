"""Long Codex conversations must not enter Windows' bounded command line."""

import hashlib
import subprocess
import sys
import time

from tavotto.engine import ai_agents, ai_bridge


def test_codex_transports_the_full_prompt_outside_argv():
    prompt = "x" * 40000 + "\n中文对话🖋"
    spec = ai_agents.CodexAgent().build_command(
        ai_agents.RunContext(argv=["codex"], cwd="/scratch", prompt=prompt)
    )
    assert spec.argv[-1] == "-"
    assert spec.stdin_text == prompt
    assert len(subprocess.list2cmdline(spec.argv)) < 1000


def test_finite_prompt_stdin_reaches_a_real_child_without_inheriting_parent_input(
    tmp_path, monkeypatch
):
    tmp_path = tmp_path / "中文 研究 数据"
    tmp_path.mkdir()
    prompt = "hello 中文 🖋\n" * 8000
    expected = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
    program = (
        "import sys,json,hashlib; data=sys.stdin.buffer.read(); "
        "print(json.dumps({'type':'item.completed','item':{'type':'agent_message',"
        "'text':hashlib.sha256(data).hexdigest()}}))"
    )
    spec = ai_agents.SpawnSpec([sys.executable, "-c", program], {}, stdin_text=prompt)
    monkeypatch.setattr(ai_bridge, "require_usable", lambda agent: {})
    monkeypatch.setattr(ai_bridge, "_cmd", lambda *args, **kwargs: spec)
    monkeypatch.setattr(ai_bridge.ai_providers, "resolve", lambda *args: None)
    monkeypatch.setenv("TAVOTTO_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(ai_bridge, "SNAP_DIR", tmp_path / "snapshots")
    monkeypatch.setattr(ai_bridge.ai_history, "DB_PATH", tmp_path / "data" / "ai_history.sqlite3")
    code = tmp_path / "figure.py"
    code.write_text("# unchanged\n", "utf-8")
    sid = ai_bridge.run(
        agent="codex", script=code.name, figures_dir=str(tmp_path), user_prompt="test"
    )
    deadline = time.monotonic() + 15
    while ai_bridge.get(sid)["status"] == "running" and time.monotonic() < deadline:
        time.sleep(0.05)
    session = ai_bridge.get(sid)
    assert session["status"] == "done", session.get("error")
    assert session["transcript"] == [{"kind": "message", "text": expected}]
    assert code.read_text("utf-8") == "# unchanged\n"
    # The run keeps the original user instruction for history/audit consumers.
    assert session["prompt"] == "test"
    ai_bridge.SESSIONS.pop(sid, None)
