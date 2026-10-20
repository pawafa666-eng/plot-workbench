"""Fork identity and build inputs, without downloading or building the application."""

import copy
import importlib.util
import json
from pathlib import Path

import pytest

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
    assert conf["productName"] == brand.PRODUCT_NAME == "Plot Workbench"
    assert conf["mainBinaryName"] == "PlotWorkbench"
    assert brand.REPO_URL == "https://github.com/pawafa666-eng/plot-workbench"
    assert brand.PACKAGE_EXT == ".tavotto"


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
