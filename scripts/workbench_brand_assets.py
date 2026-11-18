"""Create the fork's original, code-drawn desktop and installer assets."""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "workbench"
INK = "#17392f"
ACCENT = "#d6f580"
PAPER = "#eef7ee"
AXES = [(60, 62), (60, 191), (198, 191)]
SERIES = [(91, 151), (124, 110), (153, 132), (191, 73)]
STROKE = 14
ENDPOINT_RADIUS = 12


def logo(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    unit = size / 256
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=52 * unit, fill=INK)
    for points, color in ((AXES, PAPER), (SERIES, ACCENT)):
        scaled = [(x * unit, y * unit) for x, y in points]
        draw.line(scaled, fill=color, width=round(STROKE * unit), joint="curve")
        for x, y in scaled:
            r = STROKE * unit / 2
            draw.ellipse((x - r, y - r, x + r, y + r), fill=color)
    x, y = (point * unit for point in SERIES[-1])
    r = ENDPOINT_RADIUS * unit
    draw.ellipse((x - r, y - r, x + r, y + r), fill=ACCENT)
    return image


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    icon = logo(512)
    icon.save(OUT / "icon.png")
    icon.resize((128, 128), Image.Resampling.LANCZOS).save(OUT / "128x128.png")
    icon.save(
        OUT / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    header = Image.new("RGB", (150, 57), PAPER)
    mark = icon.resize((44, 44), Image.Resampling.LANCZOS)
    header.paste(mark, (97, 6), mark)
    header.save(OUT / "installer-header.bmp")
    sidebar = Image.new("RGB", (164, 314), INK)
    mark = icon.resize((116, 116), Image.Resampling.LANCZOS)
    sidebar.paste(mark, (24, 82), mark)
    sidebar.save(OUT / "installer-sidebar.bmp")
    axes_points = " ".join(f"{x},{y}" for x, y in AXES)
    series_points = " ".join(f"{x},{y}" for x, y in SERIES)
    endpoint_x, endpoint_y = SERIES[-1]
    (OUT / "logo.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">'
        f'<rect width="256" height="256" rx="52" fill="{INK}"/>'
        f'<g fill="none" stroke-width="{STROKE}" stroke-linecap="round" stroke-linejoin="round">'
        f'<polyline points="{axes_points}" stroke="{PAPER}"/>'
        f'<polyline points="{series_points}" stroke="{ACCENT}"/></g>'
        f'<circle cx="{endpoint_x}" cy="{endpoint_y}" r="{ENDPOINT_RADIUS}" fill="{ACCENT}"/>'
        "</svg>\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
