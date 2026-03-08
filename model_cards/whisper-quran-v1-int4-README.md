---
language:
- ar
license: cc-by-nc-4.0
tags:
- whisper
- quran
- arabic
- asr
- speech-recognition
- fine-tuned
- quranic-arabic
- tajweed
- islam
- quantized
- int4
- bitsandbytes
- nf4
datasets:
- Buraaq/quran-md-ayahs
metrics:
- wer
base_model: wasimlhr/whisper-quran-v1
pipeline_tag: automatic-speech-recognition
library_name: transformers
model-index:
- name: whisper-quran-v1-int4
  results:
  - task:
      type: automatic-speech-recognition
      name: Speech Recognition
    dataset:
      name: Buraaq/quran-md-ayahs (holdout)
      type: Buraaq/quran-md-ayahs
    metrics:
    - type: wer
      value: ~6.5
      name: WER (int4, expect 2–5% degradation vs v1)
---

# Whisper Quran v1 — int4 Quantized

**4-bit quantized version of [wasimlhr/whisper-quran-v1](https://huggingface.co/wasimlhr/whisper-quran-v1) for minimal VRAM and fastest inference.**

Same fine-tuned Quran recitation model, quantized to int4 (NF4) with bitsandbytes. **~4× smaller** (~1.5 GB vs ~6 GB), **~50–70% faster** than fp16, with **2–5% WER degradation** possible — validate on your data before relying in production.

## Key Results

| Metric | Value |
|--------|-------|
| **Parent model** | [wasimlhr/whisper-quran-v1](https://huggingface.co/wasimlhr/whisper-quran-v1) (5.35% WER best, 5.74% released) |
| **Quantization** | int4 NF4 (bitsandbytes, double quant) |
| **Model size** | ~1.5 GB (vs ~6 GB fp16) |
| **Inference speed** | ~50–70% faster than fp16 |
| **Accuracy** | 2–5% WER degradation possible; test on your recitations |
| **Use case** | Low-resource deployment, latency-sensitive apps |

## When to Use This Model

| Use case | Recommendation |
|----------|----------------|
| **Lowest latency / smallest footprint** | ✅ int4 — test WER on your data first |
| **Very low-memory GPU (e.g. 4–6 GB)** | ✅ int4 — often fits where int8 does not |
| **Production API (conservative)** | Prefer [whisper-quran-v1-int8](https://huggingface.co/wasimlhr/whisper-quran-v1-int8) |
| **Maximum accuracy** | Use [whisper-quran-v1](https://huggingface.co/wasimlhr/whisper-quran-v1) (fp16) |

## Usage

### Pipeline (recommended)

```python
from transformers import pipeline

pipe = pipeline(
    "automatic-speech-recognition",
    model="wasimlhr/whisper-quran-v1-int4",
    device=0  # GPU, or -1 for CPU
)

result = pipe(
    "recitation.wav",
    generate_kwargs={"language": "ar", "task": "transcribe"}
)
print(result["text"])
```

### With word-level timestamps

```python
result = pipe(
    {"array": audio, "sampling_rate": 16000},
    return_timestamps="word",
    generate_kwargs={"language": "ar", "task": "transcribe"}
)
print(result["text"])
print(result["chunks"])  # [{"text": "word", "timestamp": (start, end)}, ...]
```

### From pretrained (no extra quantization step)

This repo contains **already-quantized** weights. Load directly:

```python
import torch
from transformers import WhisperProcessor, WhisperForConditionalGeneration

processor = WhisperProcessor.from_pretrained("wasimlhr/whisper-quran-v1-int4")
model = WhisperForConditionalGeneration.from_pretrained(
    "wasimlhr/whisper-quran-v1-int4",
    torch_dtype=torch.float16,
    device_map="auto"
)

# Then run inference as with v1 (see parent model card)
```

## Quantization Details

| Setting | Value |
|---------|--------|
| Method | bitsandbytes int4 (NF4, double quant) |
| Source | wasimlhr/whisper-quran-v1 |
| Precision | 4-bit weights, fp16 compute |
| VRAM (inference) | ~1.5 GB |

## Deployment

- **Modal:** Use the [modal_whisper_int4](https://github.com/wasimlhr/taraweeh-companion-g2/tree/main/modal_whisper_int4) app; deploy with `modal deploy app.py` from that directory.
- **HuggingFace Inference Endpoint:** Select `wasimlhr/whisper-quran-v1-int4`; minimal GPU tier is enough.
- **Self-hosted:** Fits on 4–6 GB GPUs; validate WER for your use case.

## License & Citation

Same license as the parent model: **CC-BY-NC-4.0** — free for personal, educational, and non-commercial use. Commercial use prohibited without permission.

Cite the parent model [wasimlhr/whisper-quran-v1](https://huggingface.co/wasimlhr/whisper-quran-v1) and this card for the int4 variant:

```bibtex
@misc{whisper-quran-v1-int4,
  title={Whisper Quran v1 int4: 4-bit quantized Quranic Arabic ASR},
  author={Abdul Rahman Nasim},
  year={2026},
  url={https://huggingface.co/wasimlhr/whisper-quran-v1-int4},
  note={Quantized from wasimlhr/whisper-quran-v1}
}
```
