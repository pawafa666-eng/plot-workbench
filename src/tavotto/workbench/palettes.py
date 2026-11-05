"""Local, user-owned palette library.

ColorBrewer palettes: color specifications and designs developed by Cynthia
Brewer (https://colorbrewer.org/), Apache-2.0; see the upstream LICENCE.txt.
"""

from __future__ import annotations

import re
import threading
import uuid
from pathlib import Path

from tavotto.engine import atomicio

from .store import WorkbenchError, checked_id, inside, name_of, now, read_json

# Five-class ColorBrewer color specifications, stored independently of matplotlib.
SEEDS = {
    "Set1": ["#E41A1C", "#377EB8", "#4DAF4A", "#984EA3", "#FF7F00"],
    "Set2": ["#66C2A5", "#FC8D62", "#8DA0CB", "#E78AC3", "#A6D854"],
    "Set3": ["#8DD3C7", "#FFFFB3", "#BEBADA", "#FB8072", "#80B1D3"],
    "Paired": ["#A6CEE3", "#1F78B4", "#B2DF8A", "#33A02C", "#FB9A99"],
    "Accent": ["#7FC97F", "#BEAED4", "#FDC086", "#FFFF99", "#386CB0"],
    "Dark2": ["#1B9E77", "#D95F02", "#7570B3", "#E7298A", "#66A61E"],
    "Pastel1": ["#FBB4AE", "#B3CDE3", "#CCEBC5", "#DECBE4", "#FED9A6"],
    "Pastel2": ["#B3E2CD", "#FDCDAC", "#CBD5E8", "#F4CAE4", "#E6F5C9"],
    "Blues": ["#EFF3FF", "#BDD7E7", "#6BAED6", "#3182BD", "#08519C"],
    "Greens": ["#EDF8E9", "#BAE4B3", "#74C476", "#31A354", "#006D2C"],
    "Oranges": ["#FEEDDE", "#FDBE85", "#FD8D3C", "#E6550D", "#A63603"],
    "Purples": ["#F2F0F7", "#CBC9E2", "#9E9AC8", "#756BB1", "#54278F"],
    "RdBu": ["#CA0020", "#F4A582", "#F7F7F7", "#92C5DE", "#0571B0"],
    "BrBG": ["#A6611A", "#DFC27D", "#F5F5F5", "#80CDC1", "#018571"],
    "Spectral": ["#D7191C", "#FDAE61", "#FFFFBF", "#ABDDA4", "#2B83BA"],
}


def validate_colors(colors):
    if not isinstance(colors, list) or not 1 <= len(colors) <= 1024:
        raise WorkbenchError("配色方案须包含 1 到 1024 个颜色")
    if any(not isinstance(c, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", c) for c in colors):
        raise WorkbenchError("颜色须为六位十六进制代码")
    return [c.upper() for c in colors]


class PaletteStore:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.path = inside(self.root, "palettes.json")
        self.lock = threading.RLock()

    def _load(self):
        if not self.path.exists():
            stamp = now()
            entries = [
                {
                    "id": uuid.uuid4().hex,
                    "name": name,
                    "colors": colors,
                    "created_at": stamp,
                    "updated_at": stamp,
                }
                for name, colors in SEEDS.items()
            ]
            atomicio.write_json(self.path, {"schema_version": 1, "palettes": entries})
        data = read_json(self.path)
        if data.get("schema_version") != 1 or not isinstance(data.get("palettes"), list):
            raise WorkbenchError("配色库格式无效，请保留原文件", "invalid_palette_library", 409)
        return data

    def list(self):
        with self.lock:
            return self._load()["palettes"]

    def save(self, payload, palette_id=None):
        if not isinstance(payload, dict):
            raise WorkbenchError("配色方案格式无效")
        name = name_of(payload.get("name"))
        colors = validate_colors(payload.get("colors"))
        with self.lock:
            data = self._load()
            stamp = now()
            if palette_id is None:
                record = {"id": uuid.uuid4().hex, "created_at": stamp}
                data["palettes"].append(record)
            else:
                checked_id(palette_id)
                record = next((item for item in data["palettes"] if item["id"] == palette_id), None)
                if record is None:
                    raise WorkbenchError("配色方案不存在", "not_found", 404)
            record.update(name=name, colors=colors, updated_at=stamp)
            atomicio.write_json(self.path, data)
            return record

    def delete(self, palette_id):
        checked_id(palette_id)
        with self.lock:
            data = self._load()
            records = [item for item in data["palettes"] if item["id"] != palette_id]
            if len(records) == len(data["palettes"]):
                raise WorkbenchError("配色方案不存在", "not_found", 404)
            data["palettes"] = records
            atomicio.write_json(self.path, data)
