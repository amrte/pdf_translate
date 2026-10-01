import io
import sys
from pathlib import Path

import pymupdf
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from make_sample import make_sample  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import app as app_module

    monkeypatch.setattr(app_module, "DATA_DIR", tmp_path / "data")
    app_module.app.config["TESTING"] = True
    return app_module.app.test_client()


@pytest.fixture()
def uploaded(client, tmp_path):
    pdf = tmp_path / "sample.pdf"
    make_sample(str(pdf))
    res = client.post("/api/documents", data={"file": (io.BytesIO(pdf.read_bytes()), "sample.pdf")},
                      content_type="multipart/form-data")
    assert res.status_code == 200
    return res.get_json()


def test_upload_returns_segments_with_view_boxes(uploaded):
    assert uploaded["name"] == "sample.pdf"
    assert len(uploaded["pages"]) == 2
    seg = uploaded["segments"][0]
    assert seg["text"] == "Annual Report 2026"
    assert all(0 <= v <= 1 for v in seg["view"])


def test_upload_rejects_non_pdf(client):
    res = client.post("/api/documents", data={"file": (io.BytesIO(b"hello"), "x.pdf")},
                      content_type="multipart/form-data")
    assert res.status_code == 400 and "error" in res.get_json()


def test_full_flow(client, uploaded):
    doc_id = uploaded["id"]
    assert client.get(f"/api/documents/{doc_id}/pages/0.png").mimetype == "image/png"

    res = client.post(f"/api/documents/{doc_id}/export", json={"format": "txt"})
    assert res.status_code == 200
    txt = res.data.decode()
    assert txt.startswith("[[1]]\nAnnual Report 2026")

    translated = txt.replace("Annual Report 2026", "Jahresbericht 2026").replace("Key figures", "Kennzahlen")
    res = client.post(f"/api/documents/{doc_id}/import",
                      data={"file": (io.BytesIO(translated.encode()), "sample.segments.txt")},
                      content_type="multipart/form-data")
    body = res.get_json()
    assert body["matched"] == len(uploaded["segments"])
    tr = {k: v for k, v in body["translations"].items() if v in ("Jahresbericht 2026", "Kennzahlen")}
    assert len(tr) == 2

    res = client.post(f"/api/documents/{doc_id}/build", json={"translations": tr})
    assert res.status_code == 200 and res.get_json()["replaced"] == 2

    res = client.get(f"/api/documents/{doc_id}/translated.pdf")
    text = pymupdf.open(stream=res.data)[0].get_text()
    assert "Jahresbericht 2026" in text and "Kennzahlen" in text and "Annual Report" not in text
    assert client.get(f"/api/documents/{doc_id}/pages/0.png?variant=translated").status_code == 200


def test_import_pasted_text(client, uploaded):
    res = client.post(f"/api/documents/{uploaded['id']}/import", json={"text": "[[2]]\nHallo\n[[999]]\nx"})
    body = res.get_json()
    assert body["translations"] == {"2": "Hallo"} and body["unknown"] == [999]


@pytest.mark.parametrize("fmt", ["docx", "xliff", "csv", "json"])
def test_export_formats(client, uploaded, fmt):
    res = client.post(f"/api/documents/{uploaded['id']}/export", json={"format": fmt, "target_lang": "de"})
    assert res.status_code == 200 and len(res.data) > 100


def test_unknown_document(client):
    assert client.get("/api/documents/../../etc").status_code == 404
    assert client.get("/api/documents/" + "0" * 24).status_code == 404
