"""Fork identity and build inputs, without downloading or building the application."""

import copy
import importlib.util
import json
from pathlib import Path

import pytest
import tomllib

from tavotto.engine import brand, config

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "workbench_build", ROOT / "scripts/workbench_build.py"
)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def desktop_config():
    return json.loads((ROOT / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))


def test_actual_desktop_config_is_an_independent_fork():
    conf = desktop_config()
    builder.validate_packaging(conf)
    assert conf["plugins"]["updater"] == {"endpoints": [], "pubkey": ""}
    assert conf["productName"] == brand.PRODUCT_NAME == "Plot Workbench"
    assert conf["mainBinaryName"] == "PlotWorkbench"
    assert brand.REPO_URL == "https://github.com/pawafa666-eng/plot-workbench"
    assert brand.PACKAGE_EXT == ".tavotto"


def test_release_overlay_embeds_the_fork_endpoint_and_public_key():
    overlay = builder.updater_overlay("minisign-public-key")
    assert overlay == {
        "bundle": {"createUpdaterArtifacts": "v1Compatible"},
        "plugins": {
            "updater": {
                "endpoints": [
                    f"{brand.REPO_URL}/releases/latest/download/latest.json",
                ],
                "pubkey": "minisign-public-key",
            }
        },
    }
    release_conf = builder.merge_config(desktop_config(), overlay)
    builder.validate_packaging(release_conf, updater_enabled=True)


def test_release_packaging_rejects_an_upstream_or_foreign_endpoint():
    release_conf = builder.merge_config(
        desktop_config(), builder.updater_overlay("minisign-public-key")
    )
    release_conf["plugins"]["updater"]["endpoints"] = [
        "https://github.com/Tavotto/Tavotto/releases/latest/download/latest.json"
    ]
    with pytest.raises(ValueError, match="Plot Workbench"):
        builder.validate_packaging(release_conf, updater_enabled=True)


def test_release_tag_matches_the_desktop_version_and_is_newer_than_installed_baseline(
    monkeypatch,
):
    monkeypatch.setattr(builder, "WORKBENCH_VERSION", "1.0.1")
    builder.validate_release_inputs("v1.0.1", "public-key", "private-key")
    with pytest.raises(ValueError, match="match"):
        builder.validate_release_inputs("v1.0.2", "public-key", "private-key")

    monkeypatch.setattr(builder, "WORKBENCH_VERSION", "1.0.0")
    with pytest.raises(ValueError, match="higher than 1.0.0"):
        builder.validate_release_inputs("v1.0.0", "public-key", "private-key")


@pytest.mark.parametrize(
    ("public_key", "private_key"),
    [("", "private-key"), ("public-key", "")],
)
def test_release_build_fails_closed_without_both_signing_keys(public_key, private_key):
    with pytest.raises(ValueError, match="signing"):
        builder.validate_release_inputs("v1.0.1", public_key, private_key)


def test_updater_permission_is_scoped_to_the_local_main_window():
    main = json.loads((ROOT / "src-tauri/capabilities/main.json").read_text(encoding="utf-8"))
    assert "updater:default" in main["permissions"]
    assert main["windows"] == ["main"]
    for capability in (ROOT / "src-tauri/capabilities").glob("remote-*.json"):
        remote = json.loads(capability.read_text(encoding="utf-8"))
        assert all("updater" not in permission for permission in remote["permissions"])


def test_updater_crate_is_a_locked_direct_desktop_dependency():
    lock = tomllib.loads((ROOT / "src-tauri/Cargo.lock").read_text(encoding="utf-8"))
    desktop = next(
        package for package in lock["package"] if package["name"] == "plot-workbench-desktop"
    )
    assert "tauri-plugin-updater" in desktop["dependencies"]


@pytest.mark.parametrize("mutation", ["updater", "identity", "attribution"])
def test_build_rejects_upstream_update_or_colliding_identity_or_missing_attribution(mutation):
    conf = copy.deepcopy(desktop_config())
    if mutation == "updater":
        conf["plugins"]["updater"] = {
            "endpoints": ["https://github.com/Tavotto/Tavotto/releases/latest/download/latest.json"]
        }
    elif mutation == "identity":
        conf["identifier"] = "com.tavotto.tavotto"
    else:
        del conf["bundle"]["resources"]["../docs/workbench/ATTRIBUTION.txt"]
    with pytest.raises(ValueError):
        builder.validate_packaging(conf)


def test_user_state_is_separate_from_tavotto(monkeypatch, tmp_path):
    monkeypatch.delenv("TAVOTTO_CONFIG_DIR", raising=False)
    monkeypatch.delenv("TAVOTTO_DATA_DIR", raising=False)
    monkeypatch.setenv("APPDATA", str(tmp_path / "roaming"))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    assert config.config_dir().name in {"PlotWorkbench", "plot-workbench"}
    assert config.data_dir().name in {"PlotWorkbench", "plot-workbench"}
    override = tmp_path / "isolated"
    monkeypatch.setenv("TAVOTTO_DATA_DIR", str(override))
    assert config.data_dir() == override


def test_windows_runtime_lock_includes_the_complete_excel_stack():
    lock = json.loads((ROOT / "packaging/workbench-runtime-lock.json").read_text(encoding="utf-8"))
    from build_worker_runtime import validate_lock

    validate_lock(lock)
    packages = {name.replace("_", "-") for name in lock["targets"]["windows-amd64"]["packages"]}
    for name in ("matplotlib", "numpy", "pandas", "seaborn", "openpyxl", "xlrd", "et-xmlfile"):
        assert name in packages


def test_template_previews_are_bundled_as_application_data():
    previews = ROOT / "src/tavotto/workbench/previews"
    for key in ("heatmap", "bar", "line"):
        for extension in ("png", "svg", "pdf"):
            assert (previews / key / f"figure.{extension}").is_file()
    spec_text = (ROOT / "packaging/tavotto.spec").read_text(encoding="utf-8")
    assert '"previews"' in spec_text
