"""Physical table selection and lossless, JSON-safe plot-data snapshots.

All public operations are read-only. Imports of pandas, openpyxl and xlrd happen
inside calls, so importing this module does not load the scientific stack. The
caller runs these operations in its data worker, not in the Flask process.

Snapshot ``columns`` are display labels; ``index`` contains typed JSON scalars.
Cells use ordinary JSON scalars where lossless, otherwise ``{"$type": ...,
"value": ...}`` tags: datetime/date/time/timestamp/timedelta, na/nat/nan,
infinity, integer, decimal, complex, bytes and tuple. ``None`` stays JSON null,
an empty string stays empty, and pandas' missing sentinels remain distinguishable.
Source maps are physical, one-based spreadsheet coordinates. After transpose,
``source.transposed`` tells consumers that the maps refer to the opposite axes.
"""

from __future__ import annotations

import base64
import copy
import csv
import datetime as dt
import io
import math
import numbers
import re
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

_NUMBER = re.compile(
    r"[+-]?(?:0|[1-9]\d*)(?:\.\d*)?(?:[eE][+-]?\d+)?\Z|[+-]?\.\d+(?:[eE][+-]?\d+)?\Z"
)
_TAG = "$type"
_JSON_SAFE_INTEGER = 2**53 - 1


@dataclass
class ParsedTable:
    """A rectangular physical table with no automatically consumed header."""

    rows: list[list[Any]]
    source: dict[str, Any]

    @property
    def row_count(self) -> int:
        return len(self.rows)

    @property
    def column_count(self) -> int:
        return len(self.rows[0]) if self.rows else 0


def _sheet_name(sheets: list[str], sheet: str | int | None) -> str:
    if sheet is None:
        return sheets[0]
    if type(sheet) is int and 0 <= sheet < len(sheets):
        return sheets[sheet]
    if isinstance(sheet, str) and sheet in sheets:
        return sheet
    raise ValueError(f"Unknown worksheet: {sheet!r}; available sheets: {sheets!r}")


def _csv_cell(value: str) -> Any:
    # Preserve identifier-like 001 and all textual NA spellings; infer only
    # unambiguous numeric tokens, without making a header row a special case.
    if not _NUMBER.fullmatch(value):
        return value
    try:
        if not any(char in value for char in ".eE"):
            return int(value)
        result = float(value)
        return result if math.isfinite(result) else value
    except ValueError:
        return value


def load_table(
    path_or_bytes: str | Path | bytes | bytearray,
    filename: str | None = None,
    sheet: str | int | None = None,
    encoding: str = "utf-8-sig",
    delimiter: str = ",",
) -> ParsedTable:
    """Read .csv/.xlsx/.xls without a header; Excel sheet indices are zero-based.

    CSV records preserve blank lines and quoted newlines; short records are
    padded with None. Decoding is strict. Excel bounds end at the final cell
    containing a value, ignoring formatting; leading/interior blank rows and
    columns keep their physical coordinates. Formula strings are retained and
    never evaluated (a numeric schema will report their source coordinates).
    """
    if isinstance(path_or_bytes, (str, Path)):
        path = Path(path_or_bytes)
        payload = path.read_bytes()
        filename = filename or path.name
    elif isinstance(path_or_bytes, (bytes, bytearray)):
        payload = bytes(path_or_bytes)
        if not filename:
            raise ValueError("A filename is required when importing bytes")
    else:
        raise ValueError("Expected a local path or bytes")
    suffix = Path(filename).suffix.lower()
    source: dict[str, Any] = {
        "filename": Path(filename).name,
        "format": suffix.lstrip("."),
        "transposed": False,
    }
    if suffix == ".csv":
        if not isinstance(delimiter, str) or len(delimiter) != 1 or delimiter in "\r\n":
            raise ValueError("CSV delimiter must be one non-newline character")
        text = payload.decode(encoding, errors="strict")
        try:
            rows = [
                [_csv_cell(cell) for cell in row]
                for row in csv.reader(
                    io.StringIO(text, newline=""), delimiter=delimiter, strict=True
                )
            ]
        except csv.Error as exc:
            raise ValueError(f"Invalid CSV: {exc}") from exc
        width = max(map(len, rows), default=0)
        # A file of blank records still contains physical rows and one column.
        width = max(1, width) if rows else 0
        rows = [row + [None] * (width - len(row)) for row in rows]
        source.update({"encoding": encoding, "delimiter": delimiter, "sheets": [], "sheet": None})
    elif suffix == ".xlsx":
        import openpyxl

        workbook = openpyxl.load_workbook(io.BytesIO(payload), data_only=False)
        try:
            sheets = workbook.sheetnames
            chosen = _sheet_name(sheets, sheet)
            worksheet = workbook[chosen]
            # Sparse cell storage avoids a huge styled-only tail materializing
            # every empty cell between the origin and its formatting boundary.
            populated = [cell for cell in worksheet._cells.values() if cell.value is not None]
            height = max((cell.row for cell in populated), default=0)
            width = max((cell.column for cell in populated), default=0)
            rows = [[None] * width for _ in range(height)]
            for cell in populated:
                rows[cell.row - 1][cell.column - 1] = cell.value
            source.update({"sheets": sheets, "sheet": chosen})
        finally:
            workbook.close()
    elif suffix == ".xls":
        import xlrd

        workbook = xlrd.open_workbook(file_contents=payload, on_demand=True)
        try:
            sheets = workbook.sheet_names()
            chosen = _sheet_name(sheets, sheet)
            worksheet = workbook.sheet_by_name(chosen)
            cells: list[tuple[int, int, Any]] = []
            for row in range(worksheet.nrows):
                for col in range(worksheet.row_len(row)):
                    cell = worksheet.cell(row, col)
                    if cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
                        continue
                    value = cell.value
                    if cell.ctype == xlrd.XL_CELL_DATE:
                        value = xlrd.xldate_as_datetime(value, workbook.datemode)
                    elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                        value = bool(value)
                    elif cell.ctype == xlrd.XL_CELL_ERROR:
                        value = xlrd.error_text_from_code.get(value, f"#ERROR:{value}")
                    cells.append((row, col, value))
            height = max((row + 1 for row, _, _ in cells), default=0)
            width = max((col + 1 for _, col, _ in cells), default=0)
            rows = [[None] * width for _ in range(height)]
            for row, col, value in cells:
                rows[row][col] = value
            source.update({"sheets": sheets, "sheet": chosen})
        finally:
            workbook.release_resources()
    else:
        raise ValueError("Supported table formats: .csv, .xlsx, .xls")
    return ParsedTable(rows=rows, source=source)


def _expand_ranges(ranges: list[dict[str, int]], size: int, axis: str) -> list[int]:
    if not isinstance(ranges, list) or not ranges or not size:
        raise ValueError(f"{axis} ranges must select a nonempty axis")
    selected: list[int] = []
    seen: set[int] = set()
    for position, segment in enumerate(ranges):
        if not isinstance(segment, dict) or set(segment) != {"start", "end"}:
            raise ValueError(f"Each {axis} range requires start and end")
        start, end = segment["start"], segment["end"]
        if type(start) is not int or type(end) is not int:
            raise ValueError(f"{axis} range boundaries must be integers")
        if start == 0:
            if position != 0:
                raise ValueError("0 is allowed only at the first start")
            start = 1
        if end == 0:
            if position != len(ranges) - 1:
                raise ValueError("0 is allowed only at the last end")
            end = size
        if not 1 <= start <= end <= size:
            raise ValueError(f"{axis} range {segment!r} is outside 1..{size}")
        indices = list(range(start - 1, end))
        if seen.intersection(indices):
            raise ValueError(f"{axis} ranges overlap")
        selected.extend(indices)
        seen.update(indices)
    return selected


def _encode_cell(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool)):
        return value
    kind = type(value)
    if kind.__module__.startswith("pandas"):
        import pandas as pd

        if value is pd.NA:
            return {_TAG: "na"}
        if value is pd.NaT:
            return {_TAG: "nat"}
        if isinstance(value, pd.Timestamp):
            return {_TAG: "timestamp", "value": value.isoformat()}
        if isinstance(value, pd.Timedelta):
            return {_TAG: "timedelta", "value": str(value.value)}
    if kind.__module__.startswith("numpy"):
        import numpy as np

        if isinstance(value, np.datetime64):
            import pandas as pd

            return _encode_cell(pd.Timestamp(value))
        if isinstance(value, np.timedelta64):
            import pandas as pd

            return _encode_cell(pd.Timedelta(value))
        return _encode_cell(value.item())
    if isinstance(value, numbers.Integral):
        value = int(value)
        return value if abs(value) <= _JSON_SAFE_INTEGER else {_TAG: "integer", "value": str(value)}
    if isinstance(value, numbers.Real):
        value = float(value)
        if math.isnan(value):
            return {_TAG: "nan"}
        if math.isinf(value):
            return {_TAG: "infinity", "value": 1 if value > 0 else -1}
        return value
    if isinstance(value, dt.datetime):
        return {_TAG: "datetime", "value": value.isoformat()}
    if isinstance(value, dt.date):
        return {_TAG: "date", "value": value.isoformat()}
    if isinstance(value, dt.time):
        return {_TAG: "time", "value": value.isoformat()}
    if isinstance(value, dt.timedelta):
        return {_TAG: "python_timedelta", "value": [value.days, value.seconds, value.microseconds]}
    if isinstance(value, Decimal):
        return {_TAG: "decimal", "value": str(value)}
    if isinstance(value, complex):
        return {_TAG: "complex", "value": [_encode_cell(value.real), _encode_cell(value.imag)]}
    if isinstance(value, bytes):
        return {_TAG: "bytes", "value": base64.b64encode(value).decode("ascii")}
    if isinstance(value, tuple):
        return {_TAG: "tuple", "value": [_encode_cell(item) for item in value]}
    raise ValueError(f"Unsupported data cell type: {kind.__name__}")


def _decode_cell(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    import pandas as pd

    tag = value.get(_TAG)
    payload = value.get("value")
    if tag in ("na", "nat", "nan"):
        return {"na": pd.NA, "nat": pd.NaT, "nan": math.nan}[tag]
    if tag == "infinity":
        return math.inf if payload == 1 else -math.inf
    decoders = {
        "integer": int,
        "decimal": Decimal,
        "datetime": dt.datetime.fromisoformat,
        "date": dt.date.fromisoformat,
        "time": dt.time.fromisoformat,
        "timestamp": pd.Timestamp,
        "bytes": base64.b64decode,
    }
    if tag in decoders:
        return decoders[tag](payload)
    if tag == "timedelta":
        return pd.Timedelta(int(payload), unit="ns")
    if tag == "python_timedelta":
        return dt.timedelta(days=payload[0], seconds=payload[1], microseconds=payload[2])
    if tag == "complex":
        return complex(*[_decode_cell(item) for item in payload])
    if tag == "tuple":
        return tuple(_decode_cell(item) for item in payload)
    raise ValueError(f"Unsupported cell tag: {tag!r}")


def _display_label(value: Any) -> str:
    if isinstance(value, dict):
        value = _decode_cell(value)
    return "" if value is None else str(value)


def _normalize_headers(values: list[Any], sources: list[int]) -> list[str]:
    used: set[str] = set()
    result: list[str] = []
    for value, physical in zip(values, sources):
        base = _display_label(value).strip() or f"Column {physical}"
        candidate = base
        number = 2
        while candidate in used:
            candidate = f"{base}_{number}"
            number += 1
        used.add(candidate)
        result.append(candidate)
    return result


def _inferred_dtypes(values: list[list[Any]], width: int) -> list[str]:
    import pandas as pd

    # dtype=object first prevents [1, None] becoming [1.0, NaN] in the stored
    # cells. Dtypes describe columns; the encoded cells are never overwritten.
    result = []
    for col in range(width):
        column = [row[col] for row in values]
        if not column:
            result.append("object")
            continue
        inferred = pd.Series(column)
        if any(value is None for value in column) and inferred.dtype.kind in "ifu":
            result.append("object")
        else:
            result.append(str(inferred.dtype))
    return result


def select_data(
    table: ParsedTable,
    row_ranges: list[dict[str, int]],
    column_ranges: list[dict[str, int]],
    header: bool = False,
) -> dict[str, Any]:
    """Select inclusive, one-based segments in their entered order.

    0 means the first boundary only for the first start, and the last boundary
    only for the last end; a sole 0..0 selects all. Repeated coordinates,
    noninteger bounds and empty selections are errors. A header consumes the
    first *selected* row before any later transforms.
    """
    if not isinstance(header, bool):
        raise ValueError("header must be a boolean")
    rows = _expand_ranges(row_ranges, table.row_count, "row")
    cols = _expand_ranges(column_ranges, table.column_count, "column")
    values = [[table.rows[row][col] for col in cols] for row in rows]
    source = copy.deepcopy(table.source)
    column_sources = [col + 1 for col in cols]
    labels = [f"Column {col}" for col in column_sources]
    if header:
        headers = values.pop(0)
        labels = _normalize_headers(headers, column_sources)
        source["header_values"] = [_encode_cell(cell) for cell in headers]
        source["header_row"] = rows.pop(0) + 1
    row_sources = [row + 1 for row in rows]
    return {
        "columns": labels,
        "index": list(row_sources),
        "values": [[_encode_cell(cell) for cell in row] for row in values],
        "dtypes": _inferred_dtypes(values, len(cols)),
        "row_sources": row_sources,
        "column_sources": column_sources,
        "source": source,
        "row_count": len(rows),
        "column_count": len(cols),
    }


def _check_snapshot(snapshot: dict[str, Any]) -> None:
    if not isinstance(snapshot, dict):
        raise ValueError("Snapshot must be an object")
    height, width = snapshot.get("row_count"), snapshot.get("column_count")
    if type(height) is not int or type(width) is not int or height < 0 or width < 0:
        raise ValueError("Invalid snapshot dimensions")
    for key, expected in [
        ("index", height),
        ("row_sources", height),
        ("columns", width),
        ("column_sources", width),
        ("dtypes", width),
        ("values", height),
    ]:
        if not isinstance(snapshot.get(key), list) or len(snapshot[key]) != expected:
            raise ValueError(f"Snapshot {key} does not match its dimensions")
    if any(not isinstance(row, list) or len(row) != width for row in snapshot["values"]):
        raise ValueError("Snapshot values must be rectangular")
    if any(not isinstance(label, str) for label in snapshot["columns"]):
        raise ValueError("Snapshot column labels must be strings")
    if not isinstance(snapshot.get("source"), dict):
        raise ValueError("Snapshot source must be an object")


def transform_data(
    snapshot: dict[str, Any], operation: str, i: int | None = None, j: int | None = None
) -> dict[str, Any]:
    """Return an independent snapshot after transpose or one-based swaps.

    Operations: ``transpose``, ``swap_rows`` and ``swap_columns``. Labels and
    physical source maps move with their cells. A transpose exchanges axes and
    records orientation, so source-coordinate errors still identify the file.
    """
    _check_snapshot(snapshot)
    result = copy.deepcopy(snapshot)
    source = result["source"]
    if operation == "transpose":
        old_columns = source.get("column_labels", result["columns"])
        old_index = result["index"]
        result["columns"] = [_display_label(item) for item in old_index]
        result["index"] = copy.deepcopy(old_columns)
        result["values"] = [
            [snapshot["values"][row][col] for row in range(snapshot["row_count"])]
            for col in range(snapshot["column_count"])
        ]
        result["row_sources"], result["column_sources"] = (
            result["column_sources"],
            result["row_sources"],
        )
        result["row_count"], result["column_count"] = result["column_count"], result["row_count"]
        source["column_labels"] = copy.deepcopy(old_index)
        source["transposed"] = not source.get("transposed", False)
        source["index_name"], source["columns_name"] = (
            source.get("columns_name"),
            source.get("index_name"),
        )
        for suffix in ("dtype", "range"):
            old_row = source.pop("index_" + suffix, None)
            old_col = source.pop("columns_" + suffix, None)
            if old_col is not None:
                source["index_" + suffix] = old_col
            if old_row is not None:
                source["columns_" + suffix] = old_row
        source.pop("dtype_metadata", None)
    elif operation in ("swap_rows", "swap_columns"):
        dimension = result["row_count"] if operation == "swap_rows" else result["column_count"]
        if any(type(value) is not int or not 1 <= value <= dimension for value in (i, j)):
            raise ValueError(f"Swap coordinates must be integers in 1..{dimension}")
        a, b = i - 1, j - 1
        if operation == "swap_rows":
            for key in ("values", "index", "row_sources"):
                result[key][a], result[key][b] = result[key][b], result[key][a]
            source.pop("index_range", None)
        else:
            for row in result["values"]:
                row[a], row[b] = row[b], row[a]
            for key in ("columns", "column_sources", "dtypes"):
                result[key][a], result[key][b] = result[key][b], result[key][a]
            for key in ("column_labels", "dtype_metadata"):
                if key in source:
                    source[key][a], source[key][b] = source[key][b], source[key][a]
            source.pop("columns_range", None)
    else:
        raise ValueError(f"Unknown data operation: {operation!r}")
    if operation == "transpose":
        decoded = [[_decode_cell(cell) for cell in row] for row in result["values"]]
        result["dtypes"] = _inferred_dtypes(decoded, result["column_count"])
    return result


def preview_data(snapshot: dict[str, Any], limit: int = 50) -> dict[str, Any]:
    """Return at most 50x50 display cells, retaining full dimension totals.

    The returned preview is deliberately not a valid render snapshot when
    truncated: its totals stay full so consumers cannot silently plot a preview.
    """
    _check_snapshot(snapshot)
    if type(limit) is not int or limit < 1:
        raise ValueError("Preview limit must be a positive integer")
    limit = min(limit, 50)
    result = copy.deepcopy(snapshot)
    for key in ("columns", "column_sources", "dtypes", "index", "row_sources"):
        result[key] = result[key][:limit]
    result["values"] = [row[:limit] for row in result["values"][:limit]]
    result["preview_row_count"] = min(snapshot["row_count"], limit)
    result["preview_column_count"] = min(snapshot["column_count"], limit)
    return result


def inspect_table(table: ParsedTable) -> dict[str, Any]:
    """Return source/sheet metadata, physical totals and a bounded preview."""
    if table.row_count and table.column_count:
        preview = preview_data(
            select_data(table, [{"start": 0, "end": 0}], [{"start": 0, "end": 0}])
        )
    else:
        preview = {
            "values": [],
            "columns": [],
            "index": [],
            "row_count": 0,
            "column_count": 0,
            "preview_row_count": 0,
            "preview_column_count": 0,
        }
    return {
        "source": copy.deepcopy(table.source),
        "sheets": list(table.source.get("sheets", [])),
        "row_count": table.row_count,
        "column_count": table.column_count,
        "preview": preview,
    }


def snapshot_from_dataframe(df: Any) -> dict[str, Any]:
    """Serialize a DataFrame, preserving scalar types, column dtypes and labels."""
    import pandas as pd

    if not isinstance(df, pd.DataFrame):
        raise ValueError("Expected a pandas DataFrame")
    source: dict[str, Any] = {
        "format": "dataframe",
        "transposed": False,
        "index_name": _encode_cell(df.index.name),
        "columns_name": _encode_cell(df.columns.name),
        "index_dtype": str(df.index.dtype),
        "columns_dtype": str(df.columns.dtype),
        "column_labels": [_encode_cell(item) for item in df.columns],
    }
    if isinstance(df.index, pd.MultiIndex) or isinstance(df.columns, pd.MultiIndex):
        raise ValueError("MultiIndex axes are not supported; flatten them explicitly")
    if isinstance(df.index, pd.RangeIndex):
        source["index_range"] = [df.index.start, df.index.stop, df.index.step]
    if isinstance(df.columns, pd.RangeIndex):
        source["columns_range"] = [df.columns.start, df.columns.stop, df.columns.step]
    dtype_metadata = []
    for position in range(len(df.columns)):
        dtype = df.iloc[:, position].dtype
        dtype_metadata.append(
            {
                "categories": [_encode_cell(item) for item in dtype.categories],
                "ordered": dtype.ordered,
            }
            if isinstance(dtype, pd.CategoricalDtype)
            else None
        )
    source["dtype_metadata"] = dtype_metadata
    return {
        "columns": [str(item) for item in df.columns],
        "index": [_encode_cell(item) for item in df.index],
        "values": [
            [_encode_cell(df.iloc[row, col]) for col in range(len(df.columns))]
            for row in range(len(df.index))
        ],
        "dtypes": [str(dtype) for dtype in df.dtypes],
        "row_sources": list(range(1, len(df.index) + 1)),
        "column_sources": list(range(1, len(df.columns) + 1)),
        "source": source,
        "row_count": len(df.index),
        "column_count": len(df.columns),
    }


def dataframe_from_snapshot(snapshot: dict[str, Any]) -> Any:
    """Restore all cells and dtypes; malformed/truncated snapshots are rejected."""
    import pandas as pd

    _check_snapshot(snapshot)
    source = snapshot["source"]
    arrays = []
    for col, dtype in enumerate(snapshot["dtypes"]):
        values = [_decode_cell(row[col]) for row in snapshot["values"]]
        metadata = source.get("dtype_metadata", [None] * snapshot["column_count"])[col]
        if dtype == "category" and metadata is not None:
            target = pd.CategoricalDtype(
                [_decode_cell(item) for item in metadata["categories"]], ordered=metadata["ordered"]
            )
        else:
            target = dtype
        try:
            arrays.append(pd.Series(values, dtype=object).astype(target))
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError(f"Cannot restore column {col + 1} as {dtype}: {exc}") from exc
    frame = (
        pd.concat(arrays, axis=1) if arrays else pd.DataFrame(index=range(snapshot["row_count"]))
    )
    labels = source.get("column_labels", snapshot["columns"])
    if "columns_range" in source:
        bounds = source["columns_range"]
        if list(range(*bounds)) != [_decode_cell(item) for item in labels]:
            raise ValueError("Column metadata does not match snapshot labels")
        frame.columns = pd.RangeIndex(*bounds, name=_decode_cell(source.get("columns_name")))
    else:
        frame.columns = pd.Index(
            [_decode_cell(item) for item in labels],
            dtype=source.get("columns_dtype"),
            name=_decode_cell(source.get("columns_name")),
        )
    index = [_decode_cell(item) for item in snapshot["index"]]
    if "index_range" in source:
        bounds = source["index_range"]
        if list(range(*bounds)) != index:
            raise ValueError("Index metadata does not match snapshot index")
        frame.index = pd.RangeIndex(*bounds, name=_decode_cell(source.get("index_name")))
    else:
        frame.index = pd.Index(
            index, dtype=source.get("index_dtype"), name=_decode_cell(source.get("index_name"))
        )
    return frame


def _missing(value: Any) -> bool:
    return (
        value is None
        or value == ""
        or isinstance(value, dict)
        and value.get(_TAG) in ("na", "nat", "nan")
    )


def _coordinate(snapshot: dict[str, Any], row: int, col: int) -> dict[str, int]:
    source_row, source_col = snapshot["row_sources"][row], snapshot["column_sources"][col]
    if snapshot["source"].get("transposed", False):
        source_row, source_col = source_col, source_row
    return {
        "row": row + 1,
        "column": col + 1,
        "source_row": source_row,
        "source_column": source_col,
    }


def validate_schema(
    snapshot: dict[str, Any], schema: dict[str, Any] | None
) -> list[dict[str, Any]]:
    """Return data mismatch issues, or [] when valid; malformed schemas raise.

    Each of ``rows`` and ``columns`` is optional and is either
    ``{mode: 'fixed', value: N}`` or ``{mode: 'variable', min: N}`` (N >= 0).
    ``column_roles`` entries accept a one-based ``index`` or exact column
    ``name`` and ``dtype`` = any/numeric/text. When index is present, name is a
    descriptive role label. Missing/blank cells are allowed. Numeric text must
    parse strictly; values are never modified or silently coerced.
    """
    _check_snapshot(snapshot)
    if schema is None:
        return []
    if not isinstance(schema, dict):
        raise ValueError("Data schema must be an object")
    issues: list[dict[str, Any]] = []
    for axis, total_key in (("rows", "row_count"), ("columns", "column_count")):
        rule = schema.get(axis)
        if rule is None:
            continue
        if not isinstance(rule, dict) or rule.get("mode") not in ("fixed", "variable"):
            raise ValueError(f"Invalid {axis} schema mode")
        fixed = rule["mode"] == "fixed"
        expected = rule.get("value" if fixed else "min")
        if type(expected) is not int or expected < 0:
            raise ValueError(
                f"{axis} schema requires a nonnegative integer {'value' if fixed else 'min'}"
            )
        actual = snapshot[total_key]
        if actual != expected if fixed else actual < expected:
            issues.append(
                {
                    "code": total_key + "_mismatch",
                    "axis": axis,
                    "expected": expected,
                    "actual": actual,
                    "message": f"{axis}: expected {'exactly' if fixed else 'at least'} {expected}, got {actual}",
                }
            )
    roles = schema.get("column_roles", [])
    if not isinstance(roles, list):
        raise ValueError("column_roles must be a list")
    for role in roles:
        if not isinstance(role, dict) or role.get("dtype", "any") not in ("any", "numeric", "text"):
            raise ValueError("Column role dtype must be any, numeric or text")
        dtype = role.get("dtype", "any")
        index = role.get("index")
        if index is None:
            name = role.get("name")
            if not isinstance(name, str):
                raise ValueError("Column role requires a one-based index or a name")
            matches = [col + 1 for col, label in enumerate(snapshot["columns"]) if label == name]
            index = matches[0] if len(matches) == 1 else None
        elif type(index) is not int or index < 1:
            raise ValueError("Column role index must be a positive integer")
        if index is None or index > snapshot["column_count"]:
            issues.append(
                {
                    "code": "column_missing",
                    "role": copy.deepcopy(role),
                    "message": f"Required column is missing: {role.get('name', index)}",
                }
            )
            continue
        for row, values in enumerate(snapshot["values"]):
            encoded = values[index - 1]
            if dtype == "any" or _missing(encoded):
                continue
            value = _decode_cell(encoded)
            numeric = (
                isinstance(value, numbers.Number)
                and not isinstance(value, (bool, complex))
                or isinstance(value, str)
                and bool(_NUMBER.fullmatch(value))
            )
            valid = numeric if dtype == "numeric" else isinstance(value, str)
            if not valid:
                coordinate = _coordinate(snapshot, row, index - 1)
                issues.append(
                    {
                        "code": "dtype_mismatch",
                        "dtype": dtype,
                        "role": copy.deepcopy(role),
                        **coordinate,
                        "message": f"Expected {dtype} at source row {coordinate['source_row']}, column {coordinate['source_column']}",
                    }
                )
    return issues
