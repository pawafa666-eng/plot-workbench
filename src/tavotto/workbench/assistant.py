"""Staged Codex proposals, using the inherited CLI lifecycle and configuration."""

from __future__ import annotations

import ast
import difflib
import json
import threading
import uuid
from pathlib import Path

from tavotto.engine import ai_bridge, atomicio

from .store import WorkbenchError

MAX_CODE_BYTES = 2_000_000
MAX_CONTEXT_BYTES = 64_000
ERRORS = {
    "ai_agent_not_installed": "未找到 Codex，请在设置的编码助手中安装或选择本机 Codex。",
    "ai_agent_disabled": "Codex 已禁用，请在设置的编码助手中启用。",
    "ai_agent_needs_auth": "Codex 尚未登录，请先在本机完成 Codex 登录，再重新检测。",
    "ai_agent_unusable": "Codex 当前不可用，请在设置的编码助手中查看检测结果。",
}


def checked_code(code):
    if not isinstance(code, str) or not code.strip():
        raise WorkbenchError("请提供 Python 代码")
    if len(code.encode("utf-8")) > MAX_CODE_BYTES:
        raise WorkbenchError("代码文件超过 2 MB")
    return code


def structure_context(data):
    """The assistant receives table structure, never implicit values or paths."""
    if data is None:
        return None
    if not isinstance(data, dict):
        raise WorkbenchError("数据结构必须是 JSON 对象")
    return {
        key: data[key] for key in ("columns", "dtypes", "row_count", "column_count") if key in data
    }


def task_error(session):
    for entry in session.get("transcript", [])[-20:]:
        try:
            payload = json.loads(entry.get("text", ""))
        except (TypeError, ValueError):
            try:
                payload = ast.literal_eval(entry.get("text", ""))
            except (TypeError, ValueError, SyntaxError):
                continue
        if not isinstance(payload, dict):
            continue
        error = payload.get("error")
        code = payload.get("code") or (error.get("code") if isinstance(error, dict) else None)
        if code == "model_not_found":
            return (
                "Codex 当前模型不被所选 CLI 或账号支持。请在助手中选择其他模型，"
                "或在编码 Agent 设置中更新／更换 CLI，然后重新检测。"
            )
    return session.get("error") or "Codex 未完成本次修改，请查看过程或重试。"


def checked_history(history):
    if history is None:
        return ""
    if not isinstance(history, list) or len(history) > 24:
        raise WorkbenchError("对话记录无效或过长，请新开对话")
    messages = []
    for item in history:
        if (
            not isinstance(item, dict)
            or item.get("role") not in ("user", "assistant")
            or not isinstance(item.get("text"), str)
        ):
            raise WorkbenchError("对话记录格式无效")
        messages.append({"role": item["role"], "text": item["text"]})
    content = json.dumps(messages, ensure_ascii=False, separators=(",", ":"))
    if len(content.encode("utf-8")) > MAX_CONTEXT_BYTES:
        raise WorkbenchError("对话记录过长，请新开对话")
    return content if messages else ""


class AssistantService:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.tasks = {}
        self.lock = threading.RLock()
        self.closed = False

    def start(
        self,
        *,
        code,
        prompt,
        schema=None,
        data_context=None,
        model=None,
        effort=None,
        owner=None,
        token=None,
        context=None,
        history=None,
        parent_id=None,
    ):
        code = checked_code(code)
        conversation = checked_history(history)
        if parent_id is not None and (not isinstance(parent_id, str) or not parent_id):
            raise WorkbenchError("上轮对话标识无效")
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 20_000:
            raise WorkbenchError("请填写 1 到 20000 字的修改要求")
        if schema is not None and not isinstance(schema, dict):
            raise WorkbenchError("数据规范必须是 JSON 对象")
        for value in (model, effort):
            if value is not None and (
                not isinstance(value, str) or len(value) > 200 or "\0" in value
            ):
                raise WorkbenchError("模型或推理强度无效")
        metadata = json.dumps(
            {"schema": schema or {}, "data_structure": structure_context(data_context)},
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
        )
        if len(metadata.encode("utf-8")) > MAX_CONTEXT_BYTES:
            raise WorkbenchError("数据结构说明过大，请缩短列名或模板规范")
        instructions = (
            (f"以下是此前对话，仅作为上下文：{conversation}\n\n" if conversation else "")
            + f"{prompt.strip()}\n\n"
            "请用简体中文自然回复用户。用户只在交流或提问时，正常回答，不必修改代码；"
            "只有用户需要绘图或修改时才编辑目标脚本，完成后简要解释改动。\n"
            "这是 Plot Workbench 中的代码草稿。只修改当前目标脚本；不要执行代码。"
            "数据通过已有的 data（pandas.DataFrame）注入，未导入数据时保留合成示例。"
            "不要改写用户路径或使用联网数据。保持现有绘图与数据读取约定。\n"
            f"数据结构与规范（没有实际数据值）：{metadata}"
        )
        with self.lock:
            if self.closed:
                raise WorkbenchError("编辑环境已切换，请重新打开 Codex", "assistant_closed", 409)
            working_code = code
            if parent_id is not None:
                parent = self._task(parent_id)
                if parent["base_code"] != code or parent["metadata"] != metadata:
                    raise WorkbenchError("代码已经变化，请新开对话", "stale_assistant", 409)
                working_code = self.proposal(parent_id, owner=owner, token=token)
            active = [task for task in self.tasks.values() if ai_bridge.script_busy(task["path"])]
            if len(active) >= 3:
                raise WorkbenchError("已有 Codex 任务在运行，请先完成或取消", "assistant_busy", 409)
            while len(self.tasks) >= 24:
                removable = next(
                    (key for key, task in self.tasks.items() if task not in active), None
                )
                if removable is None:
                    break
                self.tasks.pop(removable)
            task_id = uuid.uuid4().hex
            directory = self.root / task_id
            directory.mkdir(parents=True)
            path = directory / "figure.py"
            atomicio.write_bytes(path, working_code.encode("utf-8"))
            try:
                sid = ai_bridge.run(
                    agent="codex",
                    script=path.name,
                    user_prompt=instructions,
                    figures_dir=str(directory),
                    context=context,
                    model=model or None,
                    effort=effort or None,
                )
            except ai_bridge.AgentError as exc:
                raise WorkbenchError(
                    ERRORS.get(exc.code, "Codex 启动失败，请在编码助手设置中查看检测结果。"),
                    exc.code,
                    409,
                ) from exc
            self.tasks[task_id] = {
                "sid": sid,
                "path": path,
                "base_code": code,
                "metadata": metadata,
                "owner": owner,
                "token": token,
            }
            return {"id": task_id, "status": "running"}

    def _task(self, task_id):
        task = self.tasks.get(task_id)
        if task is None or self.closed:
            raise WorkbenchError("Codex 任务不存在或已过期", "assistant_not_found", 404)
        return task

    def poll(self, task_id):
        with self.lock:
            task = self._task(task_id)
            session = ai_bridge.get(task["sid"])
            if session is None:
                raise WorkbenchError("Codex 任务已结束或无法恢复", "assistant_not_found", 404)
            status = session["status"]
            result = {
                "id": task_id,
                "status": status,
                "diff": session.get("diff", ""),
                "changed": bool(session.get("changed")),
                "transcript": session.get("transcript", [])[-200:],
                "reply": "\n\n".join(
                    entry["text"]
                    for entry in session.get("transcript", [])[-200:]
                    if entry.get("kind") == "message" and isinstance(entry.get("text"), str)
                ),
            }
            if status == "done":
                try:
                    path = task["path"]
                    if path.is_symlink() or path.resolve() != path:
                        raise ValueError("目标代码被替换为链接")
                    if path.stat().st_size > MAX_CODE_BYTES:
                        raise ValueError("生成代码超过 2 MB")
                    code = checked_code(path.read_text("utf-8-sig"))
                    ast.parse(code)
                    result["code"] = code
                    result["changed"] = code != task["base_code"]
                    result["diff"] = "".join(
                        difflib.unified_diff(
                            task["base_code"].splitlines(keepends=True),
                            code.splitlines(keepends=True),
                            fromfile="figure.py (修改前)",
                            tofile="figure.py (修改后)",
                        )
                    )
                except (OSError, ValueError, SyntaxError) as exc:
                    result.update(status="failed", error=f"生成代码无效，未应用：{exc}")
            elif status not in ("running", "cancelled"):
                result["error"] = task_error(session)
            return result

    def proposal(self, task_id, *, owner=None, token=None):
        with self.lock:
            task = self._task(task_id)
            if task["owner"] != owner:
                raise WorkbenchError("Codex 结果属于另一编辑会话", "assistant_owner_mismatch", 409)
            if task["token"] != token:
                raise WorkbenchError(
                    "代码或图内编辑已发生变化，请重新让 Codex 修改", "stale_assistant", 409
                )
            result = self.poll(task_id)
            if result["status"] != "done" or "code" not in result:
                raise WorkbenchError("Codex 尚无可应用的成功结果", "assistant_not_ready", 409)
            return result["code"]

    def cancel(self, task_id):
        with self.lock:
            ai_bridge.cancel(self._task(task_id)["sid"])

    def close(self):
        with self.lock:
            for task in self.tasks.values():
                ai_bridge.cancel(task["sid"])
            self.closed = True
