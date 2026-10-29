"""Release automation must fail closed and isolate GitHub write permission.

The contract reads only the stable indentation used in this workflow. It asserts
that expected jobs and named steps are present, so a layout change fails loudly;
the repository does not install PyYAML in its test environment.
"""

import re
import shlex
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/workbench-build.yml"
SOURCE = WORKFLOW.read_text(encoding="utf-8")


def _jobs():
    match = re.search(r"(?ms)^jobs:\s*\n(.*?)(?=^\S|\Z)", SOURCE)
    assert match, "workbench workflow has no jobs block"
    body = match.group(1)
    starts = list(re.finditer(r"(?m)^  ([A-Za-z_][\w-]*):\s*$", body))
    assert starts, "workbench workflow has no jobs at two-space indentation"
    return {
        start.group(1): body[
            start.end() : starts[i + 1].start() if i + 1 < len(starts) else len(body)
        ]
        for i, start in enumerate(starts)
    }


def _step(job, name):
    blocks = re.split(r"(?m)(?=^      - )", job)
    for block in blocks:
        if re.search(rf"(?m)^      - name: {re.escape(name)}\s*$", block):
            return block
    raise AssertionError(f"workflow step not found: {name}")


def test_workbench_workflow_builds_stable_tags_without_widening_normal_triggers():
    assert re.search(r"(?m)^    branches: \[workbench/v1\]$", SOURCE)
    assert re.search(r"(?m)^    tags: \[\"v\*\"\]$", SOURCE)
    assert re.search(r"(?m)^  workflow_dispatch:$", SOURCE)
    assert re.search(r"(?m)^permissions:\n  contents: read$", SOURCE)


def test_signed_release_is_built_only_for_tags_and_missing_keys_fail_closed():
    build = _jobs()["windows-installer"]
    checks = _step(build, "Verify backend and fork packaging")
    assert "tests/test_updater_manifest.py" in checks
    assert "updateStates.test.tsx" in checks
    release_step = _step(build, "Build signed Windows updater release")
    assert "if: startsWith(github.ref, 'refs/tags/v')" in release_step
    assert "--release-tag" in release_step
    assert "TAURI_SIGNING_PRIVATE_KEY" in release_step
    assert "TAURI_UPDATER_PUBLIC_KEY" in release_step
    signature_check = _step(build, "Verify updater signature matches embedded public key")
    upload_updater = _step(build, "Upload signed updater archive")
    assert build.index(signature_check) < build.index(upload_updater)
    assert "check_updater_key.py" in signature_check


def test_windows_release_build_executes_the_codex_transport_regressions():
    checks = _step(_jobs()["windows-installer"], "Verify backend and fork packaging")
    command = next(
        line.strip()
        for line in checks.splitlines()
        if line.strip().startswith("python -m pytest -q ")
    )
    arguments = shlex.split(command)
    assert {
        "tests/test_ai_prompt_transport.py",
        "tests/test_ai_agents.py",
        "tests/test_ai_bridge.py",
        "tests/test_ai_history.py",
        "tests/test_ai_refresh.py",
        "tests/test_ai_revert_stale.py",
        "tests/test_ai_capabilities.py",
        "tests/test_agents_rules_index.py",
    } <= set(arguments)


def test_only_the_draft_job_gets_release_write_permission_after_validation():
    jobs = _jobs()
    build = jobs["windows-installer"]
    publish = jobs["publish-release"]
    assert re.search(r"(?m)^    permissions:\n      contents: read$", build)
    assert re.search(r"(?m)^    needs: windows-installer$", publish)
    assert re.search(r"(?m)^    permissions:\n      actions: read\n      contents: write$", publish)
    manifest = _step(publish, "Validate signed update manifest")
    assert "make_updater_manifest.py" in manifest
    assert "--require" in manifest
    assert "windows-x86_64" in manifest
    assert re.search(r"(?m)^    name: Prepare verified release draft$", publish)
    release = _step(publish, "Prepare verified release draft")
    assert publish.index(manifest) < publish.index(release)


def test_release_draft_commands_stop_after_validating_uploaded_assets():
    # Subject: the executable commands in the final release-writing step. This
    # deliberately supports only simple commands and shell line continuations;
    # changing that grammar requires reviewing this contract, not a silent pass.
    release = re.split(r"(?m)(?=^      - )", _jobs()["publish-release"])[-1]
    run = re.search(r"(?ms)^        run: \|\n((?:          .*\n?)+)\Z", release)
    assert run, "release draft step must have a simple run block"
    script = "\n".join(line[10:] for line in run.group(1).splitlines())
    commands = [shlex.split(line) for line in script.replace("\\\n", "").splitlines()]
    commands = [command for command in commands if command]
    assert [command[:2] for command in commands] == [
        ["gh", "release"],
        ["gh", "api"],
        ["python3", "scripts/select_workbench_draft.py"],
        ["python3", "scripts/make_updater_manifest.py"],
    ], "release preparation must finish at draft validation, without a publication command"
    create, metadata, select, validate = commands
    assert create == [
        "gh",
        "release",
        "create",
        "$GITHUB_REF_NAME",
        "release-assets/installer/*",
        "release-assets/updater/*",
        "release-assets/latest.json",
        "--title",
        "$GITHUB_REF_NAME",
        "--draft",
        "--notes-file",
        "release-notes.md",
    ]
    assert metadata == [
        "gh",
        "api",
        "repos/${GITHUB_REPOSITORY}/releases?per_page=100",
        ">",
        "release-list.json",
    ]
    assert select == [
        "python3",
        "scripts/select_workbench_draft.py",
        "--releases",
        "release-list.json",
        "--tag",
        "$GITHUB_REF_NAME",
        "--out",
        "release-metadata.json",
    ]
    assert validate == [
        "python3",
        "scripts/make_updater_manifest.py",
        "--artifacts",
        "release-assets/updater",
        "--tag",
        "$GITHUB_REF_NAME",
        "--require",
        "windows-x86_64",
        "--notes-file",
        "release-notes.md",
        "--out",
        "release-assets/latest.json",
        "--published-release",
        "release-metadata.json",
    ]


def test_select_draft_accepts_only_one_matching_unpublished_release(tmp_path):
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "select_draft", ROOT / "scripts/select_workbench_draft.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    draft = {"id": 123, "tag_name": "v1.1.2", "draft": True, "assets": []}
    other = {"id": 456, "tag_name": "v1.0.9", "draft": False}
    assert module.select_draft([other, draft], "v1.1.2") == draft
    import pytest

    for releases in ([other], [draft, draft], [{**draft, "draft": False}], [{**draft, "id": True}]):
        with pytest.raises(ValueError):
            module.select_draft(releases, "v1.1.2")
