# Formula models

Model files the app (`standalone/src/formula.js`) downloads on first use from
`raw.githubusercontent.com` (which allows browsers to fetch them) and keeps in the browser.
They are not part of the built HTML file.

| File | Size | What it does | Source | Licence |
|---|---|---|---|---|
| `layout_cdla.onnx` | 7.4 MB | Finds formulas ("equation" boxes) on a page picture: PP-PicoDet layout model trained on CDLA | [RapidLayout](https://github.com/RapidAI/RapidLayout) release v0.0.0 (PaddleDetection model) | Apache-2.0 |
| `encoder.onnx` | 89 MB | pix2tex (LaTeX-OCR) encoder: ViT on the formula picture | [RapidLaTeXOCR](https://github.com/RapidAI/RapidLaTeXOCR) release v0.0.0, from [pix2tex](https://github.com/lukas-blecher/LaTeX-OCR) | MIT (pix2tex), Apache-2.0 (ONNX export) |
| `decoder.onnx` | 13 MB | pix2tex decoder, writes the LaTeX tokens; weights reduced to 8 bits (ONNX Runtime dynamic quantization, MatMul) from the release's 51 MB file – the same readings in tests | as above | as above |
| `tokenizer.json` | 24 KB | pix2tex's tokens | as above | as above |

SHA-256:

```
25b1f27ec56aa932a48f30cbd6293c358a156280f4b20b0a973bab210c39f62c  layout_cdla.onnx
01bf5dc25539ca0cd5b1bd29296ea495977a6ba5f629dc4178277809d26e5e7d  encoder.onnx
6fd79f42e0d5a7d602e2fea1de4f5bdc00fb3aad6fa446348c43aaaddef0a103  decoder.onnx
1dc27b18d6a518d0d5ff3f4bb7bd98521fe80ad39e5b2a246d4109f1bb9d5019  tokenizer.json
```

The decoder was made with:

```python
from onnxruntime.quantization import quantize_dynamic, QuantType
quantize_dynamic("decoder.onnx", "decoder_q8.onnx", weight_type=QuantType.QUInt8)
```
