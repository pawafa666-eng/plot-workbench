"""桌面版「软件内直接更新」的清单合成（scripts/make_updater_manifest.py）。

看护的是发行链上最容易静默坏掉的一环：清单产不出来 / 产出半份，壳那边表现
都是「一直显示已是最新」——用户停在旧版本上，而 CI 全绿。
"""

import importlib.util
import json
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "make_updater_manifest",
    Path(__file__).resolve().parents[1] / "scripts" / "make_updater_manifest.py",
)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


def _artifact(root: Path, name: str, sig: str | None = "SIG") -> Path:
    root.mkdir(parents=True, exist_ok=True)
    p = root / name
    p.write_bytes(b"payload")
    if sig is not None:
        (root / (name + ".sig")).write_text(sig, encoding="utf-8")
    return p


def test_manifest_uses_the_filename_github_publishes_for_a_spaced_product(tmp_path):
    # Observed on the actual v1.0.9 Release: GitHub replaces upload-name spaces
    # with periods. The signature still belongs to the unchanged archive bytes.
    _artifact(tmp_path, "Plot Workbench_1.0.9_x64-setup.nsis.zip", "SIGNED-ARCHIVE")
    manifest = mod.build_manifest(
        tmp_path, "1.0.9", "v1.0.9", "pawafa666-eng", "plot-workbench", ""
    )
    windows = manifest["platforms"]["windows-x86_64"]
    assert windows["url"] == (
        "https://github.com/pawafa666-eng/plot-workbench/releases/download/v1.0.9/"
        "Plot.Workbench_1.0.9_x64-setup.nsis.zip"
    )
    assert windows["signature"] == "SIGNED-ARCHIVE"


def test_draft_temporary_urls_are_checked_against_actual_uploaded_names(tmp_path):
    _artifact(tmp_path, "Plot Workbench_1.1.2_x64-setup.nsis.zip", "SIGNED")
    manifest = mod.build_manifest(
        tmp_path, "1.1.2", "v1.1.2", "pawafa666-eng", "plot-workbench", ""
    )
    name = "Plot.Workbench_1.1.2_x64-setup.nsis.zip"
    prefix = mod.brand.REPO_URL + "/releases/download/untagged-abc123/"
    release = {
        "tag_name": "v1.1.2",
        "draft": True,
        "assets": [
            {"name": name, "browser_download_url": prefix + name},
            {"name": name + ".sig", "browser_download_url": prefix + name + ".sig"},
        ],
    }
    mod.validate_published_assets(manifest, release)
    # A public release must already expose its final URLs.
    with pytest.raises(SystemExit):
        mod.validate_published_assets(manifest, {**release, "draft": False})
    # Metadata names must agree with the URL, rather than assuming local names.
    release["assets"][0]["name"] = "different-archive.zip"
    with pytest.raises(SystemExit):
        mod.validate_published_assets(manifest, release)


def test_cli_rejects_an_update_url_absent_from_actual_uploaded_assets(tmp_path):
    _artifact(tmp_path / "updater", "Plot Workbench_1.0.9_x64-setup.nsis.zip")
    metadata = tmp_path / "release.json"
    metadata.write_text(json.dumps({"tag_name": "v1.0.9", "assets": []}), "utf-8")
    output = tmp_path / "latest.json"
    args = [
        "--artifacts",
        str(tmp_path / "updater"),
        "--tag",
        "v1.0.9",
        "--out",
        str(output),
        "--published-release",
        str(metadata),
    ]
    with pytest.raises(SystemExit, match="uploaded release assets"):
        mod.main(args)
    assert not output.exists()
    archive_url = (
        f"{mod.brand.REPO_URL}/releases/download/v1.0.9/Plot.Workbench_1.0.9_x64-setup.nsis.zip"
    )
    metadata.write_text(
        json.dumps(
            {
                "tag_name": "v1.0.9",
                "assets": [
                    {"browser_download_url": archive_url},
                    {"browser_download_url": archive_url + ".sig"},
                ],
            }
        ),
        "utf-8",
    )
    assert mod.main(args) == 0
    assert (
        json.loads(output.read_text("utf-8"))["platforms"]["windows-x86_64"]["url"] == archive_url
    )


def test_two_platforms_land_in_one_manifest(tmp_path):
    """两条 matrix 腿各自上传的产物，拼成同一份清单。"""
    _artifact(tmp_path / "desktop-tauri-dmg", "Plot Workbench.app.tar.gz", "MAC-SIG\n")
    _artifact(tmp_path / "desktop-tauri-nsis", "Plot Workbench_0.7.0_x64-setup.nsis.zip", "WIN-SIG")

    man = mod.build_manifest(tmp_path, "0.7.0", "v0.7.0", "Tavotto", "Tavotto", "更新说明")

    assert man["version"] == "0.7.0"
    assert man["notes"] == "更新说明"
    assert set(man["platforms"]) == {"darwin-aarch64", "windows-x86_64"}
    # 签名原样搬运（末尾换行要去掉，minisign 的签名是一行）
    assert man["platforms"]["darwin-aarch64"]["signature"] == "MAC-SIG"
    assert man["platforms"]["windows-x86_64"]["url"] == (
        "https://github.com/Tavotto/Tavotto/releases/download/v0.7.0/"
        "Plot.Workbench_0.7.0_x64-setup.nsis.zip"
    )


def test_missing_signature_is_a_hard_error(tmp_path):
    """有包没签名 = 装到一半才发现对不上。宁可不发清单。"""
    _artifact(tmp_path, "Plot Workbench.app.tar.gz", sig=None)
    with pytest.raises(SystemExit, match="没有配套的 .sig"):
        mod.build_manifest(tmp_path, "0.7.0", "v0.7.0", "Tavotto", "Tavotto", "")


def test_no_artifacts_at_all_is_an_error(tmp_path):
    """一个包都没有还产出清单 = 壳拉到一份空清单，永远查不到新版。"""
    (tmp_path / "empty").mkdir()
    with pytest.raises(SystemExit, match="一个更新包都没找到"):
        mod.build_manifest(tmp_path, "0.7.0", "v0.7.0", "Tavotto", "Tavotto", "")


def test_installer_and_dmg_are_not_mistaken_for_update_packages(tmp_path):
    """安装包本身不是更新包：更新器要的是 .app.tar.gz / *-setup.nsis.zip。"""
    _artifact(tmp_path, "Plot Workbench-0.7.0-macOS.dmg")
    _artifact(tmp_path, "Plot Workbench-0.7.0-Windows-Setup.exe")
    with pytest.raises(SystemExit, match="一个更新包都没找到"):
        mod.build_manifest(tmp_path, "0.7.0", "v0.7.0", "Tavotto", "Tavotto", "")


def test_each_mac_arch_gets_exactly_its_own_package(tmp_path):
    """两个 macOS 包各进各的平台，谁也不认下对方的（ADR 0076）。

    判据的主语是**每个平台条目的 url 指向哪个文件**：宽模式（`\\.app\\.tar\\.gz$`）
    会同时认下两个包，靠先后顺序决定谁赢——把一个装不上的更新推给另一个架构的
    用户，比「查不到更新」糟糕得多。所以两条都是精确名，互换目录顺序也不影响。
    """
    _artifact(
        tmp_path / "desktop-tauri-dmg-intel", "Plot Workbench-Intel.app.tar.gz", "INTEL-SIG\n"
    )
    _artifact(tmp_path / "desktop-tauri-dmg", "Plot Workbench.app.tar.gz", "ARM-SIG\n")
    man = mod.build_manifest(tmp_path, "0.7.0", "v0.7.0", "Tavotto", "Tavotto", "")
    assert man["platforms"]["darwin-aarch64"]["url"].endswith("/Plot.Workbench.app.tar.gz")
    assert man["platforms"]["darwin-aarch64"]["signature"] == "ARM-SIG"
    assert man["platforms"]["darwin-x86_64"]["url"].endswith("/Plot.Workbench-Intel.app.tar.gz")
    assert man["platforms"]["darwin-x86_64"]["signature"] == "INTEL-SIG"


def test_an_unknown_mac_package_name_is_not_claimed_by_either_arch(tmp_path):
    """名字对不上精确名的 .app.tar.gz 不进清单——不猜它是哪个架构。"""
    _artifact(tmp_path, "Plot Workbench-universal.app.tar.gz")
    with pytest.raises(SystemExit, match="一个更新包都没找到"):
        mod.build_manifest(tmp_path, "0.7.0", "v0.7.0", "Tavotto", "Tavotto", "")


def test_intel_is_required_alongside_the_other_two(tmp_path):
    """--require 三平台时缺 Intel 那份要报出名字，不是只查「有没有 mac」。"""
    _artifact(tmp_path / "desktop-tauri-dmg", "Plot Workbench.app.tar.gz")
    _artifact(tmp_path / "desktop-tauri-nsis", "Plot Workbench_0.7.0_x64-setup.nsis.zip")
    with pytest.raises(SystemExit, match="清单缺平台：darwin-x86_64"):
        mod.build_manifest(
            tmp_path,
            "0.7.0",
            "v0.7.0",
            "Tavotto",
            "Tavotto",
            "",
            ["darwin-aarch64", "darwin-x86_64", "windows-x86_64"],
        )


def test_cli_writes_the_file(tmp_path):
    _artifact(tmp_path / "in", "Plot Workbench.app.tar.gz")
    out = tmp_path / "out" / "latest.json"
    assert (
        mod.main(["--artifacts", str(tmp_path / "in"), "--tag", "v1.2.3", "--out", str(out)]) == 0
    )
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["version"] == "1.2.3"
    assert data["platforms"]["darwin-aarch64"]["url"] == (
        f"{mod.brand.REPO_URL}/releases/download/v1.2.3/Plot.Workbench.app.tar.gz"
    )


def test_workbench_release_defaults_to_its_repository_and_accepts_notes_file(tmp_path):
    archive_name = "Plot Workbench_1.0.1_x64-setup.nsis.zip"
    _artifact(tmp_path / "updater", archive_name, "WORKBENCH-SIGNATURE\n")
    notes = tmp_path / "release-notes.md"
    notes.write_text("Plot Workbench 1.0.1 improvements", encoding="utf-8")
    out = tmp_path / "release" / "latest.json"

    assert (
        mod.main(
            [
                "--artifacts",
                str(tmp_path / "updater"),
                "--tag",
                "v1.0.1",
                "--notes-file",
                str(notes),
                "--require",
                "windows-x86_64",
                "--out",
                str(out),
            ]
        )
        == 0
    )

    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["notes"] == "Plot Workbench 1.0.1 improvements"
    assert set(data["platforms"]) == {"windows-x86_64"}
    platform = data["platforms"]["windows-x86_64"]
    assert platform["signature"] == "WORKBENCH-SIGNATURE"
    assert platform["url"] == (
        f"{mod.brand.REPO_URL}/releases/download/v1.0.1/Plot.Workbench_1.0.1_x64-setup.nsis.zip"
    )


def test_half_a_manifest_is_rejected_when_both_platforms_are_required(tmp_path):
    """v0.7.0 真实发生过：只有 Windows 那半进了清单，链路全绿。

    根因在工作流（macOS 的 out/ 没被传成 desktop-tauri-* artifact，只挂了
    Release），但脚本这一侧当时也拦不住——「一个都没有」是硬错误，「只有
    一半」却照常产出。缺的那个平台的用户于是永远显示「已是最新」。
    """
    _artifact(tmp_path / "desktop-tauri-nsis", "Plot Workbench_0.7.0_x64-setup.nsis.zip")

    with pytest.raises(SystemExit, match="清单缺平台：darwin-aarch64"):
        mod.build_manifest(
            tmp_path,
            "0.7.0",
            "v0.7.0",
            "Tavotto",
            "Tavotto",
            "",
            ["darwin-aarch64", "windows-x86_64"],
        )


def test_require_passes_when_both_are_present(tmp_path):
    _artifact(tmp_path / "desktop-tauri-dmg", "Plot Workbench.app.tar.gz")
    _artifact(tmp_path / "desktop-tauri-nsis", "Plot Workbench_0.7.0_x64-setup.nsis.zip")

    man = mod.build_manifest(
        tmp_path, "0.7.0", "v0.7.0", "Tavotto", "Tavotto", "", ["darwin-aarch64", "windows-x86_64"]
    )
    assert set(man["platforms"]) == {"darwin-aarch64", "windows-x86_64"}


def test_require_is_opt_in(tmp_path):
    """不传 --require 时行为不变（手工 dispatch 单腿构建仍能用）。"""
    _artifact(tmp_path / "desktop-tauri-nsis", "Plot Workbench_0.7.0_x64-setup.nsis.zip")
    man = mod.build_manifest(tmp_path, "0.7.0", "v0.7.0", "Tavotto", "Tavotto", "")
    assert set(man["platforms"]) == {"windows-x86_64"}
