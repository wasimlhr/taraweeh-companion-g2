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
- int8
- bitsandbytes
datasets:
- Buraaq/quran-md-ayahs
metrics:
- wer
base_model: wasimlhr/whisper-quran-v1
pipeline_tag: automatic-speech-recognition
library_name: transformers
model-index:
- name: whisper-quran-v1-int8
  results:
  - task:
      type: automatic-speech-recognition
      name: Speech Recognition
    dataset:
      name: Buraaq/quran-md-ayahs (holdout)
      type: Buraaq/quran-md-ayahs
    metrics:
    - type: wer
      value: ~5.7
      name: WER (int8, comparable to v1)
---

# Whisper Quran v1 — int8 Quantized

**8-bit quantized version of [wasimlhr/whisper-quran-v1](https://huggingface.co/wasimlhr/whisper-quran-v1) for faster inference and half the VRAM.**

Same fine-tuned Quran recitation model, quantized to int8 with bitsandbytes. **~2× smaller** (~3 GB vs ~6 GB), **~30–50% faster** inference, **&lt;2% accuracy loss** in practice. Ideal for production endpoints (e.g. HuggingFace Inference Endpoints, Modal, or self-hosted) where latency and cost matter.

## Key Results

| Metric | Value |
|--------|-------|
| **Parent model** | [wasimlhr/whisper-quran-v1](https://huggingface.co/wasimlhr/whisper-quran-v1) (5.35% WER best, 5.74% released) |
| **Quantization** | int8 (bitsandbytes) |
| **Model size** | ~3 GB (vs ~6 GB fp16) |
| **Inference speed** | ~30–50% faster than fp16 |
| **Accuracy** | Comparable to v1; &lt;2% WER degradation typical |
| **Use case** | Quran ayah transcription, real-time verse tracking |

## When to Use This Model

| Use case | Recommendation |
|----------|----------------|
| **Production API / Modal / HF Endpoint** | ✅ int8 — best tradeoff of speed and accuracy |
| **Low-memory GPU (e.g. 8 GB)** | ✅ int8 — fits where fp16 v1 does not |
| **Maximum accuracy, plenty of VRAM** | Use [whisper-quran-v1](https://huggingface.co/wasimlhr/whisper-quran-v1) (fp16) |
| **Smallest size / fastest** | Consider [whisper-quran-v1-int4](https://huggingface.co/wasimlhr/whisper-quran-v1-int4) (test WER first) |

## Usage

### Pipeline (recommended)

```python
from transformers import pipeline

pipe = pipeline(
    "automatic-speech-recognition",
    model="wasimlhr/whisper-quran-v1-int8",
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

processor = WhisperProcessor.from_pretrained("wasimlhr/whisper-quran-v1-int8")
model = WhisperForConditionalGeneration.from_pretrained(
    "wasimlhr/whisper-quran-v1-int8",
    torch_dtype=torch.float16,
    device_map="auto"
)

# Then run inference as with v1 (see parent model card)
```

## Quantization Details

| Setting | Value |
|---------|--------|
| Method | bitsandbytes int8 |
| Source | wasimlhr/whisper-quran-v1 |
| Precision | int8 weights, fp16 compute |
| VRAM (inference) | ~3 GB |

## Deployment

- **Modal:** Use the [modal_whisper](https://github.com/wasimlhr/taraweeh-companion-g2/tree/main/modal_whisper) app; deploy with `modal deploy app.py` from that directory.
- **HuggingFace Inference Endpoint:** Select `wasimlhr/whisper-quran-v1-int8` as the model; smaller GPU tiers are sufficient.
- **Self-hosted:** Same as v1; use 8 GB+ GPU for comfortable headroom.

## License & Citation

Same license as the parent model: **CC-BY-NC-4.0** — free for personal, educational, and non-commercial use. Commercial use prohibited without permission.

Cite the parent model [wasimlhr/whisper-quran-v1](https://huggingface.co/wasimlhr/whisper-quran-v1) and this card for the int8 variant:

```bibtex
@misc{whisper-quran-v1-int8,
  title={Whisper Quran v1 int8: 8-bit quantized Quranic Arabic ASR},
  author={Abdul Rahman Nasim},
  year={2026},
  url={https://huggingface.co/wasimlhr/whisper-quran-v1-int8},
  note={Quantized from wasimlhr/whisper-quran-v1}
}
```
