"""Build standalone/Kameleon-<version>.html from standalone/src/ and the VERSION file.

    python standalone/build.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import decks  # noqa: E402  (standalone/decks.py: Anki decks baked into the app)

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
        "UI": "\n".join((SRC / f).read_text("utf-8") for f in ("ui.js", "markup.js", "tools.js", "picture.js", "offline.js", "pagesui.js", "keywords.js", "words.js", "batch.js", "theme.js", "reading.js", "segedit.js", "vocab.js", "anki.js", "main.js")).replace("{{VERSION}}", version),
    }
    # The easter egg picture (ten quick clicks on the chameleon in the top bar), embedded as a data URI.
    import base64
    parts["EGG"] = "data:image/jpeg;base64," + base64.b64encode((SRC / "egg.jpg").read_bytes()).decode("ascii")
    # Anki decks from standalone/decks/*.apkg, embedded as JSON (Vocabulary -> "Built-in decks").
    built_in = decks.collect()
    parts["DECKS"] = decks.embed_json(built_in)
    for name in ("I18N", "ENGINE", "UI"):
        if "</script" in parts[name].lower():
            raise SystemExit(f"{name} must not contain '</script'")
    html = (SRC / "template.html").read_text("utf-8")
    for name, value in parts.items():
        html = html.replace("{{" + name + "}}", value)
    html = html.replace("{{VERSION}}", version)
    leftover = [p for p in ("{{STYLE}}", "{{I18N}}", "{{ENGINE}}", "{{UI}}", "{{VERSION}}", "{{EGG}}", "{{DECKS}}") if p in html]
    if leftover:
        raise SystemExit(f"unreplaced placeholders: {leftover}")
    # The app file carries its version in its name; older builds are removed.
    for stale in list(HERE.glob("Kameleon-*.html")) + [HERE / "pdf-translate.html"]:
        if stale.exists():
            stale.unlink()
    out = HERE / f"Kameleon-{version}.html"
    out.write_text(html, "utf-8")
    print(f"Kameleon v{version}: wrote {out.relative_to(ROOT)} ({len(html):,} bytes)")
    if built_in:
        print("  built-in decks: " + ", ".join(f"{d['name']} ({len(d['rows'])})" for d in built_in))


if __name__ == "__main__":
    main()
