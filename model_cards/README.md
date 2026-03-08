# HuggingFace model cards for whisper-quran-v1-int8 and int4

Copy the right file into the model repo as `README.md`, then push.

## int8

```powershell
# From repo root, after you have the model files in training/whisper-quran-v1-int8/
Copy-Item model_cards\whisper-quran-v1-int8-README.md training\whisper-quran-v1-int8\README.md
cd training\whisper-quran-v1-int8
huggingface-cli upload wasimlhr/whisper-quran-v1-int8 .
```

Or upload only the README to an existing repo:

```powershell
huggingface-cli upload wasimlhr/whisper-quran-v1-int8 model_cards/whisper-quran-v1-int8-README.md README.md
```

## int4

```powershell
Copy-Item model_cards\whisper-quran-v1-int4-README.md training\whisper-quran-v1-int4\README.md
cd training\whisper-quran-v1-int4
huggingface-cli upload wasimlhr/whisper-quran-v1-int4 .
```

Or README only:

```powershell
huggingface-cli upload wasimlhr/whisper-quran-v1-int4 model_cards/whisper-quran-v1-int4-README.md README.md
```

Log in first: `huggingface-cli login` (or `hf auth login` if you use the new CLI).

---

## HuggingFace Inference Endpoint — which model to use

**Quantized models (int8/int4)** need **bitsandbytes** in the runtime. The default HF Inference Endpoint image does **not** include it, and the checkpoint weights are 8-bit/4-bit so they cannot be loaded as plain float.

- **Use the non-quantized model on HF Endpoint:** Deploy **[wasimlhr/whisper-quran-v1](https://huggingface.co/wasimlhr/whisper-quran-v1)** (fp16). No extra deps, works on the default container. Same accuracy, ~2× larger and a bit slower than int8.
- **Use int8/int4:** Either (1) deploy on **Modal** (see `modal_whisper/` and `modal_whisper_int4/` — images include bitsandbytes), or (2) use an HF Endpoint with a **custom container** that installs `bitsandbytes>=0.46.1`.
