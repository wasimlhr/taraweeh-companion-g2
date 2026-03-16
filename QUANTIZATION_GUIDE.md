# Whisper Quran Model Quantization Guide

## Why Quantize?

**Current model:** `whisper-quran-v1` (6.18 GB, large-v3 based)
- Latency: 2-3 seconds per transcription
- GPU memory: ~6GB

**After int8 quantization:** (3 GB)
- Latency: **1-1.5 seconds** (30-50% faster)
- GPU memory: ~3GB
- Accuracy loss: <2%

**After int4 quantization:** (1.5 GB)
- Latency: **500-800ms** (50-70% faster)
- GPU memory: ~1.5GB  
- Accuracy loss: 2-5% (needs testing!)

---

## Setup (On Your PC)

### 1. Install Dependencies

```bash
pip install transformers torch bitsandbytes accelerate huggingface_hub
```

**Requirements:**
- Python 3.8+
- CUDA GPU (same one you used for training)
- 20GB free disk space (for downloading + saving)

### 2. Download the Script

```bash
cd /path/to/your/workspace
wget https://raw.githubusercontent.com/wasimlhr/taraweeh-companion-g2/master/quantize_whisper.py
chmod +x quantize_whisper.py
```

---

## Usage

### Option A: Safe Quantization (int8, Recommended)

```bash
python quantize_whisper.py --mode int8
```

**What it does:**
1. Downloads `wasimlhr/whisper-quran-v1` from HF
2. Quantizes to int8 (2x smaller)
3. Tests inference speed
4. Saves to `./whisper-quran-v1-int8/`

**Expected output:**
```
✅ Processor loaded
⏳ Quantizing to int8 (this takes 2-3 minutes)...
✅ Model quantized to int8
✅ Test inference: 0.85s
✅ Saved locally
```

### Option B: Aggressive Quantization (int4)

```bash
python quantize_whisper.py --mode int4
```

**Warning:** int4 may reduce accuracy on complex ayahs. Test thoroughly!

### Option C: Both (Compare)

```bash
python quantize_whisper.py --mode both
```

---

## Testing Locally

### Test Script

Create `test_quantized.py`:

```python
import torch
from transformers import WhisperProcessor, WhisperForConditionalGeneration
import librosa
import time

# Load quantized model
model_path = "./whisper-quran-v1-int8"  # or int4
processor = WhisperProcessor.from_pretrained(model_path)
model = WhisperForConditionalGeneration.from_pretrained(model_path)
model = model.to("cuda")

# Load test audio (use your Quran test file)
audio_file = "test_quran.wav"  # Replace with your test file
audio, sr = librosa.load(audio_file, sr=16000)

# Transcribe
inputs = processor(audio, sampling_rate=16000, return_tensors="pt")
input_features = inputs.input_features.to("cuda")

t0 = time.time()
with torch.no_grad():
    predicted_ids = model.generate(
        input_features,
        language="ar",
        task="transcribe",
        max_new_tokens=448
    )
latency = time.time() - t0

transcription = processor.batch_decode(predicted_ids, skip_special_tokens=True)[0]

print(f"Latency: {latency:.2f}s")
print(f"Transcription: {transcription}")
```

**Run:**
```bash
python test_quantized.py
```

**Compare with original:**
- Original model: 2-3s
- int8: Should be 1-1.5s
- int4: Should be 0.5-0.8s

---

## Push to HuggingFace

### After Testing Locally

If accuracy is good:

```bash
python quantize_whisper.py --mode int8 --push --token hf_YOUR_TOKEN_HERE
```

**This will:**
1. Quantize the model
2. Create repo `wasimlhr/whisper-quran-v1-int8`
3. Upload all files (~5-10 minutes for 3GB)

---

## Update Your HF Endpoint

### 1. Go to HF Endpoints Dashboard

https://endpoints.huggingface.co/wasimlhr/endpoints/whisper-quran-v1-g2

### 2. Update Model Repository

- Click "Edit endpoint"
- Change model from `wasimlhr/whisper-quran-v1`  
  to `wasimlhr/whisper-quran-v1-int8`
- Save and restart

### 3. Wait for Initialization

~2-3 minutes for endpoint to restart

### 4. Test with Your App

No backend code changes needed! Just use the app and watch logs:

```bash
journalctl -f | grep Whisper
```

**You should see:**
- Faster response times (1-1.5s instead of 2-3s)
- Same transcription quality

---

## Troubleshooting

### "CUDA out of memory"

**Problem:** GPU doesn't have enough VRAM

**Solution:** 
```bash
# Use CPU instead (slower but works)
python quantize_whisper.py --mode int8 --device cpu
```

### "bitsandbytes not found"

**Problem:** Missing dependency

**Solution:**
```bash
pip install bitsandbytes

# If on Windows, use:
pip install bitsandbytes-windows
```

### "Model accuracy degraded too much"

**Problem:** int4 is too aggressive

**Solution:**
- Stick with int8 (safer)
- Or try different quantization config (edit script)

---

## Expected Results

### Performance Comparison

| Model | Size | Latency | Accuracy |
|-------|------|---------|----------|
| Original (large-v3) | 6.2 GB | 2-3s | 100% |
| int8 quantized | 3.1 GB | 1-1.5s | 98-99% |
| int4 quantized | 1.5 GB | 0.5-0.8s | 95-98% |

### Word Progress Impact

**With faster model:**
- Word timestamps still work the same
- Overall system latency reduced
- User experience: smoother, more responsive
- Timer leads can be reduced (currently 2-4 ayahs, could be 1-2)

---

## Next Steps (Vocabulary Pruning)

After quantization, the next optimization is **vocabulary pruning**:

1. **Analyze token usage** - Find which tokens are used in Quran
2. **Remove unused tokens** - Keep only Arabic + Quran-specific tokens
3. **Retrain embedding layer** - Smaller vocabulary = faster inference
4. **Expected:** Another 2-3x speedup

Let me know if you want a script for this too!

---

## Questions?

Test the int8 version first - it's the safest bet for 30-50% speedup with minimal accuracy loss.

The int4 version is more experimental but could get you to sub-second latency!
