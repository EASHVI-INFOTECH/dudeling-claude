"""
Dudeling's icon and cover, made from the logo (assets/dudeling-logo-source.png: black ink on white).

    python3 scripts/make-art.py      (needs Pillow; run on a Mac for the Avenir Next font)

Writes assets/icon.png (the extension icon), assets/icons/ (sizes, light and dark) and assets/cover.png (shown
as the extension's screenshot when installing).
"""
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
SOURCE = ASSETS / "dudeling-logo-source.png"
FONT = "/System/Library/Fonts/Avenir Next.ttc"

INK = (17, 17, 17)
PAPER = (255, 255, 255)
NIGHT = (28, 28, 30)
PURPLE = (112, 72, 232)  # Dudeling's cursor colour on the board


def ink_mask() -> Image.Image:
    """The logo's ink as an alpha mask (white paper → transparent), cropped to the ink."""
    gray = Image.open(SOURCE).convert("L")
    mask = ImageChops.invert(gray).point(lambda v: 0 if v < 24 else min(255, int((v - 24) * 255 / 200)))
    return mask.crop(mask.getbbox())


def tile(size: int, ink: tuple, paper: tuple, fill: float = 0.7, radius: float = 0.22) -> Image.Image:
    """A rounded square with the face centred, `fill` of its width."""
    scale = 4  # draw big, then shrink: smooth edges at every size
    big = size * scale
    out = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    corners = Image.new("L", (big, big), 0)
    ImageDraw.Draw(corners).rounded_rectangle((0, 0, big - 1, big - 1), radius=int(big * radius), fill=255)
    out.paste(Image.new("RGBA", (big, big), paper + (255,)), mask=corners)
    face = ink_mask()
    w = int(big * fill)
    h = int(face.height * w / face.width)
    face = face.resize((w, h), Image.LANCZOS)
    out.paste(Image.new("RGBA", (w, h), ink + (255,)), ((big - w) // 2, (big - h) // 2 + int(big * 0.02)), face)
    return out.resize((size, size), Image.LANCZOS)


def cover(width: int = 1600, height: int = 900) -> Image.Image:
    img = Image.new("RGB", (width, height), (250, 248, 244))
    d = ImageDraw.Draw(img)
    # A whiteboard: a soft card with a dashed frame, like a section on the board.
    card = (70, 70, width - 70, height - 70)
    shadow = Image.new("L", (width, height), 0)
    ImageDraw.Draw(shadow).rounded_rectangle((card[0], card[1] + 10, card[2], card[3] + 10), radius=40, fill=60)
    img.paste((225, 220, 212), mask=shadow.filter(ImageFilter.GaussianBlur(24)))
    d.rounded_rectangle(card, radius=40, fill=PAPER)
    for x in range(card[0] + 60, card[2] - 60, 28):
        d.line((x, card[1] + 44, x + 14, card[1] + 44), fill=(205, 205, 210), width=3)
        d.line((x, card[3] - 44, x + 14, card[3] - 44), fill=(205, 205, 210), width=3)

    face = ink_mask()
    fw = 460
    fh = int(face.height * fw / face.width)
    face = face.resize((fw, fh), Image.LANCZOS)
    fx, fy = 190, (height - fh) // 2 - 10
    img.paste(Image.new("RGB", (fw, fh), INK), (fx, fy), face)

    tx = fx + fw + 110
    title = ImageFont.truetype(FONT, 132, index=2)  # Avenir Next Demi Bold
    body = ImageFont.truetype(FONT, 42, index=7)  # Regular
    small = ImageFont.truetype(FONT, 32, index=5)  # Medium
    d.text((tx, 250), "Dudeling", font=title, fill=INK)
    d.text((tx + 4, 430), "A tutor that teaches on a", font=body, fill=(60, 60, 66))
    d.text((tx + 4, 484), "whiteboard inside your chat.", font=body, fill=(60, 60, 66))
    # The board's cursor, as a small mark beside the tagline.
    cx, cy = tx + 8, 590
    d.polygon([(cx, cy), (cx, cy + 34), (cx + 10, cy + 25), (cx + 26, cy + 25)], fill=PURPLE)
    d.text((cx + 40, cy - 2), "Draws, talks and checks you understood", font=small, fill=PURPLE)
    d.text((tx + 4, 680), "Works with Claude Desktop", font=small, fill=(130, 130, 138))
    return img


def main():
    (ASSETS / "icons").mkdir(exist_ok=True)
    for size in (128, 256, 512):
        tile(size, INK, PAPER).save(ASSETS / "icons" / f"icon-{size}.png", optimize=True)
        tile(size, PAPER, NIGHT).save(ASSETS / "icons" / f"icon-dark-{size}.png", optimize=True)
    tile(512, INK, PAPER).save(ASSETS / "icon.png", optimize=True)
    cover().save(ASSETS / "cover.png", optimize=True)
    print("assets/icon.png, assets/icons/*, assets/cover.png")


if __name__ == "__main__":
    main()
