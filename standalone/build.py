"""Build standalone/Kameleon-<version>.html from standalone/src/ and the VERSION file.

    python standalone/build.py
"""

from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SRC = HERE / "src"


def main() -> None:
    version = (ROOT / "VERSION").read_text("utf-8").strip()
    parts = {
        "STYLE": (SRC / "style.css").read_text("utf-8"),
        "I18N": (SRC / "i18n.js").read_text("utf-8").replace("{{VERSION}}", version),
        # The engine (PDF) and the e-book support run together in the workers.
        "ENGINE": "\n".join((SRC / f).read_text("utf-8") for f in ("engine.js", "ebook.js", "office.js", "text.js", "slides.js", "pages.js", "legacy.js", "doc.js", "xls.js", "ppt.js")),
        # One module: interface, markup tools, field/OCR tools, then start-up.
        "UI": "\n".join((SRC / f).read_text("utf-8") for f in ("ui.js", "markup.js", "tools.js", "picture.js", "offline.js", "pagesui.js", "keywords.js", "theme.js", "reading.js", "main.js")).replace("{{VERSION}}", version),
    }
    for name in ("I18N", "ENGINE", "UI"):
        if "</script" in parts[name].lower():
            raise SystemExit(f"{name} must not contain '</script'")
    html = (SRC / "template.html").read_text("utf-8")
    for name, value in parts.items():
        html = html.replace("{{" + name + "}}", value)
    html = html.replace("{{VERSION}}", version)
    leftover = [p for p in ("{{STYLE}}", "{{I18N}}", "{{ENGINE}}", "{{UI}}", "{{VERSION}}") if p in html]
    if leftover:
        raise SystemExit(f"unreplaced placeholders: {leftover}")
    # The app file carries its version in its name; older builds are removed.
    for stale in list(HERE.glob("Kameleon-*.html")) + [HERE / "pdf-translate.html"]:
        if stale.exists():
            stale.unlink()
    out = HERE / f"Kameleon-{version}.html"
    out.write_text(html, "utf-8")
    print(f"Kameleon v{version}: wrote {out.relative_to(ROOT)} ({len(html):,} bytes)")


if __name__ == "__main__":
    main()
