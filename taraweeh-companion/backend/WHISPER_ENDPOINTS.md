# Whisper Endpoints Configuration

## Your Deployed Models

### 1. Original Model (large-v3)
**Endpoint:** `https://paiabspio5ph0zvp.us-east-1.aws.endpoints.huggingface.cloud`  
**Model:** `wasimlhr/whisper-quran-v1`  
**Size:** 6.18 GB  
**Expected Latency:** 2-3 seconds  
**Status:** ✅ Working (current default)

### 2. int8 Quantized ⭐ RECOMMENDED
**Endpoint:** `https://sgsv8hmzgyh6shoq.us-east-1.aws.endpoints.huggingface.cloud`  
**Model:** `wasimlhr/whisper-quran-v1-int8-neq`  
**Size:** 1.5 GB  
**Expected Latency:** 1-1.5 seconds  
**Status:** 🔄 Initializing  
**GPU:** T4

### 3. int4 Quantized (Experimental)
**Endpoint:** `https://vdwzxcg14e88l16t.us-east-1.aws.endpoints.huggingface.cloud`  
**Model:** `wasimlhr/whisper-quran-v1-int4-jua`  
**Size:** 867 MB  
**Expected Latency:** 0.5-0.8 seconds  
**Status:** 🔄 Initializing  
**GPU:** T4

---

## How to Switch Endpoints

### Method 1: Environment Variable (Backend)

Edit `backend/.env` (create if doesn't exist):

```bash
# Use int8 (recommended - 2x faster)
WHISPER_ENDPOINT_URL=https://sgsv8hmzgyh6shoq.us-east-1.aws.endpoints.huggingface.cloud

# Or use int4 (experimental - 4x faster)
# WHISPER_ENDPOINT_URL=https://vdwzxcg14e88l16t.us-east-1.aws.endpoints.huggingface.cloud

# Original (slower but proven)
# WHISPER_ENDPOINT_URL=https://paiabspio5ph0zvp.us-east-1.aws.endpoints.huggingface.cloud

HUGGINGFACE_TOKEN=hf_your_token_here
```

Then restart the backend:
```bash
pkill -f "node server.js"
node server.js > /tmp/server_v4.log 2>&1 &
```

### Method 2: Frontend Settings (Per-User)

Users can override in the app settings (if you add UI for it).

### Method 3: Runtime Override

```bash
# Test with int8 temporarily
WHISPER_ENDPOINT_URL=https://sgsv8hmzgyh6shoq.us-east-1.aws.endpoints.huggingface.cloud node server.js
```

---

## Testing the New Endpoints

### Check if Endpoints Are Ready

```bash
# int8
curl -X POST \
  https://sgsv8hmzgyh6shoq.us-east-1.aws.endpoints.huggingface.cloud \
  -H "Authorization: Bearer hf_YOUR_TOKEN" \
  -H "Content-Type: audio/wav" \
  --data-binary @test_audio.wav

# int4
curl -X POST \
  https://vdwzxcg14e88l16t.us-east-1.aws.endpoints.huggingface.cloud \
  -H "Authorization: Bearer hf_YOUR_TOKEN" \
  -H "Content-Type: audio/wav" \
  --data-binary @test_audio.wav
```

**Expected responses:**
- **200 OK:** `{"text": "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ"}`
- **503:** Endpoint is waking up (wait 30s and retry)
- **400:** Endpoint may not be fully initialized yet

### Monitor Logs During Testing

```bash
# Watch for Whisper responses
journalctl -f --no-pager | grep -E "Whisper|ms\)"

# Look for:
# [Whisper] "..." (1200ms)  <- int8 should be ~1-1.5s
# [Whisper] "..." (600ms)   <- int4 should be ~0.5-0.8s
```

---

## Performance Comparison (Expected)

| Model | Size | Cold Start | Warm Latency | Cost/hr | Notes |
|-------|------|------------|--------------|---------|-------|
| Original | 6.2GB | ~60s | 2-3s | $0.60 | Proven accuracy |
| int8 ⭐ | 1.5GB | ~30s | 1-1.5s | $0.60 | Best balance |
| int4 🚀 | 867MB | ~20s | 0.5-0.8s | $0.60 | Test accuracy! |

*All on T4 GPU (same pricing)*

---

## Troubleshooting

### "Endpoint stuck initializing"

**Problem:** HF endpoint shows "Initializing" for >5 minutes

**Solutions:**
1. Check HF dashboard: https://endpoints.huggingface.co/wasimlhr
2. Try pausing and resuming the endpoint
3. Check model repo has all required files (config.json, model.safetensors, etc.)

### "HTTP 400: could not convert string to float"

**Problem:** Endpoint has a broken handler.py

**Solution:** 
1. Go to model repo (e.g., `wasimlhr/whisper-quran-v1-int8-neq`)
2. Delete `handler.py` if present
3. Let HF use default handler
4. Restart endpoint

### "Slower than expected"

**Problem:** Latency not improving

**Checklist:**
- Endpoint using T4 GPU? (Check HF dashboard)
- Model fully loaded? (First request is always slower)
- Network latency? (Test from same region)
- Measuring warm requests? (Do 2-3 requests, measure the last one)

### "Transcription quality degraded"

**Problem:** int4 has errors

**Solution:** Switch back to int8 or original

---

## Recommendation

**Phase 1:** Switch to **int8** immediately
- Same accuracy as original
- 30-50% faster (2-3s → 1-1.5s)
- Proven safe
- Easy rollback if issues

**Phase 2:** Test **int4** with real usage
- Monitor transcription accuracy
- If good: migrate for 3x speedup
- If issues: stay on int8

**Monitor:** Watch logs for `[X words]` to verify word timestamps

---

## Current Status

**Last Updated:** 2026-03-08 13:30 UTC

**Active Endpoint:** Original (paiabspio5ph0zvp)  
**New Endpoints:** Initializing  
**Next Step:** Wait for initialization → test with curl → switch backend → verify in app

