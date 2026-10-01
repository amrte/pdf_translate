"""Generate a sample PDF with text, images and vector drawings for testing."""

import sys

import pymupdf

LOREM = (
    "Portable Document Format files keep their appearance on every device. This paragraph "
    "wraps over several lines so that the extractor has to merge them into one segment, "
    "and the rebuild step has to reflow the translated text into the same box."
)


def make_sample(path: str) -> None:
    doc = pymupdf.open()

    page = doc.new_page()  # A4-ish letter
    # Vector drawings: header bar, frame, circle, line.
    page.draw_rect(pymupdf.Rect(0, 0, page.rect.width, 70), color=None, fill=(0.12, 0.3, 0.55))
    page.draw_rect(pymupdf.Rect(50, 420, 300, 560), color=(0.8, 0.1, 0.1), width=2)
    page.draw_circle((450, 490), 50, color=(0.1, 0.6, 0.2), fill=(0.85, 0.95, 0.85))
    page.draw_line((50, 600), (560, 600), color=(0.3, 0.3, 0.3), width=1)

    # Raster image with text on top of it.
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 64, 32), False)
    for x in range(64):
        for y in range(32):
            pix.set_pixel(x, y, (x * 4, 80, 255 - x * 4))
    page.insert_image(pymupdf.Rect(320, 620, 560, 740), pixmap=pix)

    page.insert_text((50, 45), "Annual Report 2026", fontsize=24, fontname="hebo", color=(1, 1, 1))
    page.insert_textbox(pymupdf.Rect(50, 100, 560, 200), LOREM, fontsize=11, fontname="tiro")
    page.insert_text((50, 230), "Key figures", fontsize=16, fontname="hebo", color=(0.12, 0.3, 0.55))
    page.insert_text((50, 260), "• Revenue grew by twelve percent.", fontsize=11, fontname="helv")
    page.insert_text((50, 275), "• Costs were reduced in every region.", fontsize=11, fontname="helv")
    # A table-like row: label and value far apart on the same baseline.
    page.insert_text((50, 320), "Total revenue", fontsize=11, fontname="helv")
    page.insert_text((400, 320), "1,234,567 EUR", fontsize=11, fontname="cour")
    page.insert_text((60, 450), "Text inside a frame", fontsize=12, fontname="heit", color=(0.8, 0.1, 0.1))
    page.insert_text((415, 494), "Circle", fontsize=12, fontname="helv")
    page.insert_text((330, 685), "Text over an image", fontsize=14, fontname="hebo", color=(1, 1, 1))
    page.insert_text((580, 500), "Rotated margin note", fontsize=9, fontname="helv", rotate=90)
    page.insert_text((306 - 60, 780), "Centered footer line", fontsize=10, fontname="helv")

    page2 = doc.new_page()
    page2.insert_text((50, 72), "Second page", fontsize=18, fontname="hebo")
    page2.insert_textbox(pymupdf.Rect(50, 90, 300, 400), LOREM, fontsize=10, fontname="helv")
    page2.insert_textbox(pymupdf.Rect(320, 90, 560, 400), LOREM, fontsize=10, fontname="helv")
    doc.save(path)


if __name__ == "__main__":
    make_sample(sys.argv[1] if len(sys.argv) > 1 else "sample.pdf")
