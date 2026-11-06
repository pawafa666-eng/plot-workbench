"""Read-only source projections and bounded line comparisons, never execution."""

import ast
from difflib import SequenceMatcher


def display_code(record):
    if isinstance(record.get("base_code"), str):
        return record["base_code"]
    code = record.get("code", "")
    if not code.startswith("# >>> Plot Workbench generated execution block >>>\n"):
        return code
    try:
        tree = ast.parse(code)
    except (SyntaxError, RecursionError):
        return code
    values = {
        node.targets[0].id: node.value
        for node in tree.body
        if isinstance(node, ast.Assign)
        and len(node.targets) == 1
        and isinstance(node.targets[0], ast.Name)
    }
    source = values.get("PWB_SOURCE")
    if (
        {"PWB_SOURCE", "PWB_OVERRIDES", "PWB_ENGINE_VERSION"} <= values.keys()
        and any(isinstance(node, ast.FunctionDef) and node.name == "main" for node in tree.body)
        and isinstance(source, ast.Constant)
        and isinstance(source.value, str)
    ):
        return source.value
    return code


def comparison(before, after):
    a, b = before.splitlines(), after.splitlines()
    # Very large scripts use a bounded whole-file replacement rather than a
    # quadratic comparison. Full source is still returned and copyable.
    if len(a) + len(b) > 20000:
        opcodes = [("equal" if before == after else "replace", 0, len(a), 0, len(b))]
    else:
        opcodes = SequenceMatcher(None, a, b, autojunk=True).get_opcodes()
    return {"before": before, "after": after, "opcodes": opcodes}


def history_comparison(record, current):
    import json

    before, after = display_code(record), display_code(current)
    result = {
        "display_code": before,
        "comparison": comparison(before, after),
        "current_revision": current["revision"],
        "current_outputs": current.get("outputs", []),
    }
    old = record.get("output_overrides") or {"figure": record.get("overrides", [])}
    new = current.get("output_overrides") or {"figure": current.get("overrides", [])}
    if old != new:
        result["graph_comparison"] = comparison(
            json.dumps(old, ensure_ascii=False, indent=2, sort_keys=True),
            json.dumps(new, ensure_ascii=False, indent=2, sort_keys=True),
        )
    return result
