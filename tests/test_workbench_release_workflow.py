"""Release automation must fail closed and isolate GitHub write permission.

The contract reads only the stable indentation used in this workflow. It asserts
that expected jobs and named steps are present, so a layout change fails loudly;
the repository does not install PyYAML in its test environment.
"""

import re
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


def test_only_the_publish_job_gets_release_write_permission_after_validation():
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
    release = _step(publish, "Publish stable Release")
    assert "gh release create" in release
