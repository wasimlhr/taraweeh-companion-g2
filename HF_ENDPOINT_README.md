# HuggingFace Inference Endpoint — use this model

If you see:

```text
ImportError: Using `bitsandbytes` 8-bit quantization requires the latest version of bitsandbytes
```

**Cause:** You selected **wasimlhr/whisper-quran-v1-int8** (or **-int4**). Those models need the `bitsandbytes` library. The default HuggingFace Inference Endpoint image **does not** install it, and HF does not let you add pip packages on the default image.

---

## Fix (one change)

**In the endpoint configuration, set the model to:**

### **wasimlhr/whisper-quran-v1**

(Not `whisper-quran-v1-int8` and not `whisper-quran-v1-int4`.)

That’s the same fine-tuned model in **fp16**. It runs on the default endpoint image, no bitsandbytes, no custom container. Same accuracy; a bit more VRAM and slightly slower than int8.

1. Open your endpoint → **Settings** (or **Edit**).
2. Change **Model** from `wasimlhr/whisper-quran-v1-int8` to **`wasimlhr/whisper-quran-v1`**.
3. Save / restart the endpoint.

Your app keeps using the same `WHISPER_ENDPOINT_URL`; only the model behind it changes.

---

## If you really want int8 on an endpoint

- Use **Modal** and the repo’s Modal apps:  
  `modal_whisper/` (int8) and `modal_whisper_int4/` (int4).  
  Their images include `bitsandbytes`, so those models work there.
- Or use an HF Endpoint with a **custom Docker image** that installs `bitsandbytes>=0.46.1` and your inference code; the default HF image cannot be extended with extra pip packages in the UI.

**TL;DR:** On HuggingFace Inference Endpoint, use **wasimlhr/whisper-quran-v1**. Use int8/int4 on Modal or a custom container.
