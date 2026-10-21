"""Build the independent Windows installer, preserving upstream engine contracts.

Requires Python build dependencies, pnpm, Rust and the MSVC Windows SDK.
The GitHub Actions windows-latest runner provides the native toolchain.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "src"))

from build_desktop import build_workerd, stage_private_python  # noqa: E402
from build_worker_runtime import BuildError, check_runtime_dir  # noqa: E402
from tavotto.engine.brand import DESKTOP_BUNDLE_ID, REPO_URL, WORKBENCH_VERSION  # noqa: E402

LOCK = ROOT / "packaging" / "workbench-runtime-lock.json"
UPDATE_BASELINE_VERSION = (1, 0, 0)
_UPDATER_ENDPOINT = f"{REPO_URL}/releases/latest/download/latest.json"


def updater_overlay(public_key: str) -> dict:
    """Return the Tauri config merged only into a signed, tagged release build."""
    key = public_key.strip()
    if not key:
        raise ValueError("Updater signing requires TAURI_UPDATER_PUBLIC_KEY")
    return {
        "bundle": {"createUpdaterArtifacts": True},
        "plugins": {
            "updater": {
                "endpoints": [_UPDATER_ENDPOINT],
                "pubkey": key,
            }
        },
    }


def merge_config(base: dict, overlay: dict) -> dict:
    """Merge a small Tauri JSON overlay without mutating the checked-in config."""
    result = copy.deepcopy(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge_config(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def _stable_version_parts(version: str) -> tuple[int, int, int] | None:
    match = re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version)
    if not match:
        return None
    return tuple(int(part) for part in match.groups())


def validate_release_inputs(tag: str, public_key: str, private_key: str) -> None:
    """Fail before build work unless a newer stable app version can be signed."""
    if not public_key.strip() or not private_key.strip():
        raise ValueError(
            "A stable updater release requires updater signing variables "
            "TAURI_UPDATER_PUBLIC_KEY and "
            "TAURI_SIGNING_PRIVATE_KEY"
        )
    current = _stable_version_parts(WORKBENCH_VERSION)
    if current is None:
        raise ValueError("WORKBENCH_VERSION must be a stable three-part SemVer version")
    if tag != f"v{WORKBENCH_VERSION}":
        raise ValueError(f"Release tag must match the desktop version v{WORKBENCH_VERSION}")
    if current <= UPDATE_BASELINE_VERSION:
        raise ValueError("The first updater release must be higher than 1.0.0")


def validate_packaging(conf: dict, *, updater_enabled: bool = False) -> None:
    """Validate the desktop configuration consumed by this particular build."""
    if conf.get("identifier") != DESKTOP_BUNDLE_ID:
        raise ValueError("Desktop application ID differs from the fork's brand")
    if conf.get("version") != WORKBENCH_VERSION:
        raise ValueError("Desktop version differs from engine.brand.WORKBENCH_VERSION")
    bundle = conf.get("bundle", {})
    updater = conf.get("plugins", {}).get("updater")
    if updater_enabled:
        if bundle.get("createUpdaterArtifacts") is not True:
            raise ValueError("A stable release must create signed updater artifacts")
        if (
            not isinstance(updater, dict)
            or updater.get("endpoints") != [_UPDATER_ENDPOINT]
            or not isinstance(updater.get("pubkey"), str)
            or not updater["pubkey"].strip()
        ):
            raise ValueError("Stable updater releases must use the Plot Workbench endpoint and key")
    elif bundle.get("createUpdaterArtifacts") is not False or updater != {
        "endpoints": [],
        "pubkey": "",
    }:
        raise ValueError("Ordinary Plot Workbench builds must not create updater artifacts")
    resources = bundle.get("resources", {})
    if (
        resources.get("../LICENSE") != "LICENSE"
        or resources.get("../docs/workbench/ATTRIBUTION.txt") != "ATTRIBUTION.txt"
    ):
        raise ValueError("The installer must include AGPL license and upstream attribution")


def run(argv: list[str], **kwargs) -> None:
    print("$ " + " ".join(argv), flush=True)
    subprocess.run(argv, cwd=ROOT, check=True, **kwargs)


def runtime_current() -> bool:
    manifest = ROOT / "runtime" / "runtime-manifest.json"
    try:
        info = check_runtime_dir(manifest, require_smoke=True)
        return info["build"]["lock_sha256"] == hashlib.sha256(LOCK.read_bytes()).hexdigest()
    except (OSError, ValueError, KeyError, BuildError):
        return False


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-tauri", action="store_true")
    parser.add_argument("--skip-frontend", action="store_true")
    parser.add_argument(
        "--release-tag",
        help="Build a signed stable updater release for the exact desktop version tag",
    )
    args = parser.parse_args()
    if sys.platform != "win32":
        raise SystemExit("The Plot Workbench v1 installer is built on Windows x64.")
    os.environ["TAVOTTO_NO_TELEMETRY"] = "1"
    os.environ["TAVOTTO_NO_UPDATE_CHECK"] = "1"
    os.environ["TAVOTTO_REQUIRE_RUNTIME"] = "1"
    os.environ["TAVOTTO_REQUIRE_PRIVATE_PYTHON"] = "1"
    conf = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
    overlay = None
    if args.release_tag:
        public_key = os.environ.get("TAURI_UPDATER_PUBLIC_KEY", "")
        private_key = os.environ.get("TAURI_SIGNING_PRIVATE_KEY", "")
        validate_release_inputs(args.release_tag, public_key, private_key)
        overlay = updater_overlay(public_key)
        conf = merge_config(conf, overlay)
        validate_packaging(conf, updater_enabled=True)
        release_conf_path = ROOT / "build" / "workbench-tauri-release.json"
        release_conf_path.parent.mkdir(parents=True, exist_ok=True)
        release_conf_path.write_text(
            json.dumps(conf, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
    else:
        validate_packaging(conf)
    if not args.skip_frontend:
        run([sys.executable, "scripts/build_frontend.py"])
    build_workerd()
    if not runtime_current():
        run([sys.executable, "scripts/build_worker_runtime.py", "--lock", str(LOCK), "--clean"])
    run([sys.executable, "scripts/fetch_fonts.py"])
    run([sys.executable, "scripts/fetch_fonts.py", "--check"])
    stage_private_python(False)
    run([sys.executable, "-m", "PyInstaller", "packaging/tavotto.spec", "--noconfirm"])
    sidecar = ROOT / "dist" / "Tavotto" / "Tavotto.exe"
    for item in (
        sidecar,
        sidecar.parent / "tavotto-cli.exe",
        sidecar.parent / "_internal" / "tavotto-workerd.exe",
    ):
        if not item.is_file():
            raise SystemExit(f"Missing frozen artifact: {item}")
    run([str(sidecar.parent / "tavotto-cli.exe"), "doctor", "--json"])
    if args.skip_tauri:
        return
    pnpm = shutil.which("pnpm.cmd") or shutil.which("pnpm")
    if not pnpm:
        raise SystemExit("pnpm is missing")
    tauri_args = [pnpm, "dlx", "@tauri-apps/cli@2.11.4", "build", "--bundles", "nsis"]
    if overlay is not None:
        tauri_args.extend(["--config", json.dumps(overlay, separators=(",", ":"))])
    run(tauri_args)
    installers = list((ROOT / "src-tauri/target/release/bundle/nsis").glob("*.exe"))
    if len(installers) != 1:
        raise SystemExit(f"Expected one NSIS installer, found {len(installers)}")
    out = ROOT / "dist" / f"Plot-Workbench-{WORKBENCH_VERSION}-Windows-x64-Setup.exe"
    shutil.copy2(installers[0], out)
    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    out.with_suffix(".exe.sha256").write_text(f"{digest}  {out.name}\n", encoding="ascii")
    print(f"Installer: {out}\nSHA-256: {digest}")


if __name__ == "__main__":
    main()
