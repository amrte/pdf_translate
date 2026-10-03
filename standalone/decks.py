"""Anki decks baked into the Kameleon app.

Copy .apkg files into standalone/decks/ and run `python standalone/build.py`: every deck's
cards (term, translation, example sentence and its translation) are embedded into the built
HTML as JSON and offered under Vocabulary -> "Built-in decks", where one click adds them to the
vocabulary of a language pair. Media (audio, pictures) is left out.

A file named like `Name.de-en.apkg` presets the language pair; otherwise the field names of the
deck ("Hanzi", "English") are used, and the app detects or asks for the rest.

    python standalone/decks.py            # list what would be embedded
    python standalone/decks.py file.apkg  # convert one deck and print a summary

Decks in the anki21b format (zstd-compressed, Anki 2.1.50+ "new export format") need the
`zstandard` module; without it they are skipped with a note. Export them from Anki with
"Support older Anki versions" ticked instead.
"""

import html
import json
import re
import sqlite3
import sys
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
DECKS = HERE / "decks"

EXAMPLE_RE = re.compile(r"example|beispiel|sentence|satz|пример|приклад|exemple|ejemplo|esempio|usage|context", re.I)
PRON_RE = re.compile(r"pinyin|pīnyīn|reading|romaji|furigana|translit|transcri|pronunc|aussprache|romani[sz]|jyutping|zhuyin|bopomofo|kana|ipa$", re.I)
MEDIA_RE = re.compile(r"audio|sound|image|picture|photo|bild|^ton$|mp3|recording", re.I)
LANG_NAMES = {
    "deutsch": "de", "german": "de", "schweizerdeutsch": "gsw", "swiss german": "gsw", "englisch": "en", "english": "en", "französisch": "fr", "french": "fr", "spanisch": "es", "spanish": "es",
    "italienisch": "it", "italian": "it", "portugiesisch": "pt", "portuguese": "pt", "niederländisch": "nl", "dutch": "nl", "polnisch": "pl", "polish": "pl",
    "tschechisch": "cs", "czech": "cs", "russisch": "ru", "russian": "ru", "ukrainisch": "uk", "ukrainian": "uk", "chinesisch": "zh", "chinese": "zh",
    "japanisch": "ja", "japanese": "ja", "koreanisch": "ko", "korean": "ko", "türkisch": "tr", "turkish": "tr", "schwedisch": "sv", "swedish": "sv",
    "hanzi": "zh", "汉字": "zh", "中文": "zh", "mandarin": "zh", "kanji": "ja", "日本語": "ja", "hangul": "ko", "한국어": "ko", "русский": "ru",
    "українська": "uk", "français": "fr", "español": "es", "italiano": "it", "português": "pt",
}


def plain(s: str) -> str:
    """Field HTML to text, the way the app's own reader does it."""
    s = re.sub(r"\[sound:[^\]]*\]", "", s or "")
    s = re.sub(r"<br\s*/?>|</div>|</p>|</li>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s.replace("&nbsp;", " "))
    s = re.sub(r"[ \t]+\n", "\n", s)
    s = re.sub(r"\n{2,}", "\n", s)
    return s.strip()


def field_lang(name: str) -> str:
    n = re.sub(r"\(.*?\)", "", (name or "").lower()).strip()
    return LANG_NAMES.get(n, "")


def read_apkg(path: Path) -> dict:
    """{name, src, tgt, rows: [{term, translation, example, exampleTr}], skipped?}"""
    out = {"name": path.stem, "src": "", "tgt": "", "rows": []}
    m = re.search(r"\.([a-z]{2,3})-([a-z]{2,3})$", path.stem)
    if m:
        out["src"], out["tgt"] = m.group(1), m.group(2)
        out["name"] = path.stem[: m.start()]
    z = zipfile.ZipFile(path)
    names = set(z.namelist())
    db_name = "collection.anki21" if "collection.anki21" in names else "collection.anki2" if "collection.anki2" in names else None
    data = None
    if db_name:
        data = z.read(db_name)
    elif "collection.anki21b" in names:
        try:
            import zstandard  # type: ignore
            data = zstandard.ZstdDecompressor().decompress(z.read("collection.anki21b"), max_output_size=1 << 31)
        except ImportError:
            out["skipped"] = "anki21b (zstd) – install the zstandard module or export for older Anki versions"
            return out
    if data is None:
        out["skipped"] = "no collection database in the package"
        return out
    with tempfile.NamedTemporaryFile(delete=False, suffix=".anki2") as tmp:
        tmp.write(data)
    try:
        con = sqlite3.connect(tmp.name)
        cur = con.cursor()
        col = cur.execute("select models, decks from col").fetchone()
        try:
            models = json.loads(col[0] or "{}")
        except Exception:
            models = {}
        try:
            decks = json.loads(col[1] or "{}")
        except Exception:
            decks = {}
        if not models:  # newer schema: notetypes table
            try:
                models = {str(r[0]): {"flds": [{"name": n} for n in cur.execute("select name from fields where ntid=? order by ord", (r[0],)).fetchall() for n in [n[0]]]} for r in cur.execute("select id from notetypes")}
            except Exception:
                models = {}
        deck_names = [d.get("name") for d in decks.values() if d.get("name") and d.get("name") != "Default"]
        if not deck_names:
            try:
                deck_names = [r[0] for r in cur.execute("select name from decks") if r[0] and r[0] != "Default"]
            except Exception:
                pass
        if deck_names and not m:
            out["name"] = deck_names[0].replace("\x1f", " / ")
        for mid, flds in cur.execute("select mid, flds from notes"):
            parts = (flds or "").split("\x1f")
            model = models.get(str(mid))
            fnames = [f["name"] for f in model["flds"]] if model else []
            fi, bi, pi = 0, 1, -1
            if fnames:
                is_plain = lambda nm: not EXAMPLE_RE.search(nm) and not PRON_RE.search(nm) and not MEDIA_RE.search(nm)
                fi = next((i for i, nm in enumerate(fnames) if is_plain(nm)), 0)
                bi = next((i for i, nm in enumerate(fnames) if i != fi and is_plain(nm)), -1)
                if bi < 0:
                    bi = next((i for i, nm in enumerate(fnames) if i != fi and not MEDIA_RE.search(nm) and not EXAMPLE_RE.search(nm)), -1)
                if bi < 0:
                    bi = 1 if fi == 0 else 0
                pi = next((i for i, nm in enumerate(fnames) if i not in (fi, bi) and PRON_RE.search(nm)), -1)
                if not out["src"]:
                    out["src"] = field_lang(fnames[fi]) if fi < len(fnames) else ""
                if not out["tgt"]:
                    out["tgt"] = field_lang(fnames[bi]) if bi < len(fnames) else ""
            term = plain(parts[fi]) if fi < len(parts) else ""
            translation = plain(parts[bi]) if bi < len(parts) else ""
            if not term or not translation:
                continue
            pron = re.sub(r"\s*\n\s*", " ", plain(parts[pi])) if 0 <= pi < len(parts) else ""
            if pron and pron != term:
                term += f" ({pron})"
            ex_idx = next((i for i, nm in enumerate(fnames) if i not in (fi, bi, pi) and EXAMPLE_RE.search(nm)), -1)
            rest = [plain(f) for i, f in enumerate(parts) if i not in (fi, bi, pi) and not (i < len(fnames) and MEDIA_RE.search(fnames[i]))]
            rest = [r for r in rest if r]
            example = plain(parts[ex_idx]) if 0 <= ex_idx < len(parts) else (rest[0] if rest else "")
            example_tr = ""
            lines = [l for l in example.split("\n") if l.strip()]
            if len(lines) >= 2 and len(lines) % 2 == 0:
                half = len(lines) // 2
                example, example_tr = " ".join(lines[:half]), " ".join(lines[half:])
            else:
                example = " ".join(lines)
            out["rows"].append({"term": re.sub(r"\s*\n\s*", " ", term), "translation": re.sub(r"\s*\n\s*", " ", translation), "example": example, "exampleTr": example_tr})
        con.close()
    finally:
        Path(tmp.name).unlink(missing_ok=True)
    return out


def collect(folder: Path = DECKS) -> list:
    """All decks of the folder, ready for embedding (skipped ones are reported, not embedded)."""
    decks = []
    for path in sorted(folder.glob("*.apkg")):
        try:
            d = read_apkg(path)
        except Exception as err:  # a broken file must not stop the build
            print(f"decks: {path.name}: not readable ({err})", file=sys.stderr)
            continue
        if d.get("skipped"):
            print(f"decks: {path.name}: skipped – {d['skipped']}", file=sys.stderr)
            continue
        if not d["rows"]:
            print(f"decks: {path.name}: no cards found", file=sys.stderr)
            continue
        decks.append(d)
    return decks


def embed_json(decks: list) -> str:
    """JSON safe inside a <script> element."""
    return json.dumps(decks, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


if __name__ == "__main__":
    paths = [Path(a) for a in sys.argv[1:]]
    items = [read_apkg(p) for p in paths] if paths else collect()
    for d in items:
        if d.get("skipped"):
            print(f"{d['name']}: skipped – {d['skipped']}")
            continue
        print(f"{d['name']}: {len(d['rows'])} cards, pair {d['src'] or '?'} → {d['tgt'] or '?'}")
        for r in d["rows"][:3]:
            print(f"   {r['term']} = {r['translation']}" + (f"  |  {r['example']}" if r["example"] else ""))
    if not items:
        print(f"no .apkg files in {DECKS}")
