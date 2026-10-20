"""Small redistributable starter templates and their synthetic data."""

COMMON = """import matplotlib.pyplot as plt
import pandas as pd

"""

EXAMPLES = [
    {
        "key": "heatmap",
        "name": "热力图",
        "category": "热力图",
        "description": "数值矩阵；行和列均可变化，空值显示为空白。",
        "code": COMMON
        + """def build_figure(data):
    values = data.apply(pd.to_numeric).to_numpy(dtype=float)
    fig, ax = plt.subplots(figsize=(5.2, 3.6))
    image = ax.imshow(values, aspect="auto", cmap="YlGnBu")
    ax.set_xticks(range(len(data.columns)), labels=[str(x) for x in data.columns])
    ax.set_yticks(range(len(data.index)), labels=[str(x) for x in data.index])
    fig.colorbar(image, ax=ax, label="Value")
    fig.tight_layout()
    return fig

def example_data():
    return pd.DataFrame([[2, 5, 7], [4, 8, 3], [6, 1, 9]], columns=["A", "B", "C"])
""",
        "values": [[2, 5, 7], [4, 8, 3], [6, 1, 9]],
        "columns": ["A", "B", "C"],
        "schema": {
            "rows": {"mode": "variable", "min": 1},
            "columns": {"mode": "variable", "min": 1},
            "numeric": True,
        },
    },
    {
        "key": "bar",
        "name": "柱状图",
        "category": "柱状图",
        "description": "两列：第一列为类别，第二列为数值；行数可变。",
        "code": COMMON
        + """def build_figure(data):
    fig, ax = plt.subplots(figsize=(5.2, 3.6))
    ax.bar(data.iloc[:, 0].astype(str), pd.to_numeric(data.iloc[:, 1]), color="#376879", width=0.62)
    ax.set_xlabel(str(data.columns[0]))
    ax.set_ylabel(str(data.columns[1]))
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    return fig

def example_data():
    return pd.DataFrame({"Group": ["A", "B", "C", "D"], "Value": [12, 19, 15, 23]})
""",
        "values": [["A", 12], ["B", 19], ["C", 15], ["D", 23]],
        "columns": ["Group", "Value"],
        "schema": {
            "rows": {"mode": "variable", "min": 1},
            "columns": {"mode": "fixed", "value": 2},
            "column_roles": [
                {"index": 1, "name": "类别", "dtype": "any"},
                {"index": 2, "name": "数值", "dtype": "numeric"},
            ],
        },
    },
    {
        "key": "line",
        "name": "折线图",
        "category": "折线图",
        "description": "两列数值：第一列 X，第二列 Y；至少两行。",
        "code": COMMON
        + """def build_figure(data):
    fig, ax = plt.subplots(figsize=(5.2, 3.6))
    ax.plot(pd.to_numeric(data.iloc[:, 0]), pd.to_numeric(data.iloc[:, 1]), marker="o", color="#376879", linewidth=1.4)
    ax.set_xlabel(str(data.columns[0]))
    ax.set_ylabel(str(data.columns[1]))
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    return fig

def example_data():
    return pd.DataFrame({"X": [1, 2, 3, 4, 5], "Y": [2, 3.5, 3, 5.5, 7]})
""",
        "values": [[1, 2], [2, 3.5], [3, 3], [4, 5.5], [5, 7]],
        "columns": ["X", "Y"],
        "schema": {
            "rows": {"mode": "variable", "min": 2},
            "columns": {"mode": "fixed", "value": 2},
            "column_roles": [
                {"index": 1, "name": "X", "dtype": "numeric"},
                {"index": 2, "name": "Y", "dtype": "numeric"},
            ],
        },
    },
]


def example_snapshot(example):
    rows, columns = len(example["values"]), len(example["columns"])
    return {
        "columns": example["columns"],
        "index": list(range(rows)),
        "values": example["values"],
        "dtypes": ["object"] * columns,
        "row_sources": list(range(1, rows + 1)),
        "column_sources": list(range(1, columns + 1)),
        "row_count": rows,
        "column_count": columns,
        "source": {"kind": "example"},
    }
