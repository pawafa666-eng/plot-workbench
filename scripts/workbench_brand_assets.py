"""Create the fork's original, code-drawn desktop and installer assets."""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "workbench"
INK = "#1d3340"
GOLD = "#e9b85c"
PALE = "#f6f5ef"


def logo(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    unit = size / 256
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=52 * unit, fill=INK)
    points = [(53, 181), (53, 63), (65, 63), (65, 169), (203, 169), (203, 181)]
    draw.polygon([(x * unit, y * unit) for x, y in points], fill=PALE)
    curve = [(76, 146), (112, 111), (146, 128), (190, 78)]
    draw.line([(x * unit, y * unit) for x, y in curve], fill=GOLD, width=max(2, int(10 * unit)))
    for x, y in curve:
        r = 7 * unit
        draw.ellipse((x * unit - r, y * unit - r, x * unit + r, y * unit + r), fill=GOLD)
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
    header = Image.new("RGB", (150, 57), PALE)
    header.paste(
        icon.resize((44, 44), Image.Resampling.LANCZOS),
        (97, 6),
        icon.resize((44, 44), Image.Resampling.LANCZOS),
    )
    header.save(OUT / "installer-header.bmp")
    sidebar = Image.new("RGB", (164, 314), INK)
    mark = icon.resize((116, 116), Image.Resampling.LANCZOS)
    sidebar.paste(mark, (24, 82), mark)
    sidebar.save(OUT / "installer-sidebar.bmp")
    (OUT / "logo.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">'
        '<rect width="256" height="256" rx="52" fill="#1d3340"/>'
        '<path d="M59 63V175H203" stroke="#f6f5ef" stroke-width="12" fill="none"/>'
        '<path d="m76 146 36-35 34 17 44-50" stroke="#e9b85c" stroke-width="10" fill="none"/>'
        '<g fill="#e9b85c"><circle cx="76" cy="146" r="7"/><circle cx="112" cy="111" r="7"/>'
        '<circle cx="146" cy="128" r="7"/><circle cx="190" cy="78" r="7"/></g></svg>\n',
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
