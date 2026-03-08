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
- onnx
- onnxruntime
- quantized
datasets:
- Buraaq/quran-md-ayahs
base_model: wasimlhr/whisper-quran-v1
pipeline_tag: automatic-speech-recognition
library_name: optimum
model-index:
- name: whisper-quran-v1-onnx-quantized
  results:
  - task:
      type: automatic-speech-recognition
      name: Speech Recognition
    dataset:
      name: Buraaq/quran-md-ayahs (holdout)
      type: Buraaq/quran-md-ayahs
    metrics:
    - type: wer
      value: "~5.7"
      name: WER (ONNX dynamic int8, comparable to v1)
---

# Whisper Quran v1 — ONNX (dynamic int8)

**ONNX export of [wasimlhr/whisper-quran-v1](https://huggingface.co/wasimlhr/whisper-quran-v1) with dynamic int8 quantization for fast inference on CPU or GPU.**

Same fine-tuned Quran recitation model, exported to ONNX and quantized with ONNX Runtime. **~1.6 GB**, runs with **ONNX Runtime** (no `bitsandbytes`). Ideal for Modal, Inference Endpoints, or self-hosted servers.

## Key details

| Metric | Value |
|--------|--------|
| **Parent model** | [wasimlhr/whisper-quran-v1](https://huggingface.co/wasimlhr/whisper-quran-v1) |
| **Format** | ONNX, dynamic int8 |
| **Model size** | ~1.6 GB |
| **Use case** | Quran ayah transcription |

## Usage

### Optimum + ONNX Runtime

```python
from optimum.onnxruntime import ORTModelForSpeechSeq2Seq
from transformers import WhisperProcessor, pipeline

model = ORTModelForSpeechSeq2Seq.from_pretrained("wasimlhr/whisper-quran-v1-onnx-quantized")
processor = WhisperProcessor.from_pretrained("wasimlhr/whisper-quran-v1-onnx-quantized")

pipe = pipeline(
    "automatic-speech-recognition",
    model=model,
    tokenizer=processor.tokenizer,
    feature_extractor=processor.feature_extractor,
)

result = pipe(
    "recitation.wav",
    return_timestamps="word",
    generate_kwargs={"language": "ar", "task": "transcribe", "max_new_tokens": 448}
)
print(result["text"])
print(result["chunks"])  # [{"text": "word", "timestamp": (start, end)}, ...]
```

## Deploy on Hugging Face Inference Endpoint

This repo includes a **custom handler** and **requirements.txt** so you can deploy it as an Inference Endpoint:

1. Go to [Inference Endpoints](https://ui.endpoints.huggingface.co/), create a new **Endpoint**.
2. Select model **wasimlhr/whisper-quran-v1-onnx-quantized**.
3. The endpoint will use the repo’s `handler.py` and install deps from `requirements.txt` (optimum, onnxruntime-gpu, etc.). Task will show as **Custom**.
4. After deploy, call the endpoint with JSON: `{"inputs": "<base64-encoded-audio>", "parameters": {"return_timestamps": true, "language": "ar", "task": "transcribe"}}`. Response: `{"text": "...", "chunks": [{"text": "word", "start": 0.0, "end": 0.5}, ...]}`.

Use this endpoint URL as `WHISPER_ENDPOINT_URL` in your app (same as for Modal).

## Deploy on Modal

Use the included Modal app to serve this model as an HTTP API (same interface as the int8/int4 PyTorch deployments).

**Endpoints**

| Method | Path | Description |
|--------|------|-------------|
| **GET** | `/` | Model card JSON (model id, description, language). |
| **POST** | `/` | Transcribe — body: raw WAV bytes. Query: `?language=ar&task=transcribe&return_timestamps=true`. Returns `{"text": "...", "chunks": [{"text": "word", "start": 0.0, "end": 0.5}, ...]}`. |

**Deploy**

```bash
pip install modal
cd modal_whisper_onnx
modal deploy app.py
```

Set your backend `WHISPER_ENDPOINT_URL` to the URL Modal prints (e.g. `https://your-workspace--whisper-quran-onnx-web.modal.run`).

**Optional:** If the endpoint uses proxy auth, set `MODAL_KEY` and `MODAL_SECRET` in your backend `.env`.

The Modal app lives in the same repo as this model: clone the repo and use the `modal_whisper_onnx/` folder, or copy `app.py` and `handler.py` from the model’s **Files** tab once the card is updated.

## Other variants

- **int8 (PyTorch):** [wasimlhr/whisper-quran-v1-int8](https://huggingface.co/wasimlhr/whisper-quran-v1-int8) — bitsandbytes int8
- **int4 (PyTorch):** [wasimlhr/whisper-quran-v1-int4](https://huggingface.co/wasimlhr/whisper-quran-v1-int4) — smaller, test WER first
- **fp16:** [wasimlhr/whisper-quran-v1](https://huggingface.co/wasimlhr/whisper-quran-v1) — full precision

## License

Same as parent model: **CC-BY-NC-4.0** — free for personal, educational, and non-commercial use.
