# Update Your HuggingFace Endpoint for Word Timestamps

## Your Current Endpoint
`https://paiabspio5ph0zvp.us-east-1.aws.endpoints.huggingface.cloud`

This is a **HuggingFace Inference Endpoint** (not Modal).

## How to Update It

### Step 1: Find Your Endpoint Code

Go to: https://huggingface.co/spaces/wasimlhr/whisper-quran-v1

Or check your HF dashboard for the inference endpoint configuration.

### Step 2: Add These Two Lines to Your Inference Code

In your endpoint's Python code (usually `handler.py` or `app.py`):

```python
# Find this section (in your model.generate() call):
generated_ids = model.generate(
    inputs.input_features,
    language="ar",
    task="transcribe",
    max_new_tokens=448,
    return_timestamps=True  # ← ADD THIS LINE
)

# Find this section (in your decode call):
result = processor.batch_decode(
    generated_ids,
    skip_special_tokens=True,
    return_timestamps='word'  # ← ADD THIS LINE
)[0]

# Then update your response to include words:
return {
    "text": result['text'],
    "words": [
        {
            "text": chunk['text'],
            "start": chunk['timestamp'][0],
            "end": chunk['timestamp'][1]
        }
        for chunk in result.get('chunks', [])
    ]
}
```

### Step 3: Redeploy

In HuggingFace Inference Endpoints dashboard:
1. Update the code
2. Redeploy the endpoint
3. Wait for it to restart (cold start ~30s)

## Alternative: Deploy to Modal Instead

Modal is easier to control and cheaper:

```bash
cd /home/exedev/taraweeh-companion-g2
pip install modal
modal token new
modal deploy modal_whisper_deploy.py

# Get the URL (looks like: https://YOUR-APP-ID.modal.run)
# Update backend/.env:
# WHISPER_ENDPOINT_URL=https://YOUR-APP-ID.modal.run
```

Modal script is already created for you: `modal_whisper_deploy.py`

## How to Check if It's Working

After updating, watch logs:
```bash
tail -f /tmp/server_v4.log
```

Look for:
```
[Whisper] "بسم الله..." (2000ms) [4 words]
                                 ^^^^^^^^^^ This!

Word pace from timestamps: 650ms avg (500-800ms range, 4 words) → 620ms/w
^^^^^^^^^^^^^^^^^^^^^^^^^^^ This!
```

## Current Status

**Without real timestamps:**
- Progress bar works ✅
- Updates smoothly (5 FPS) ✅  
- Based on learned pace (775ms/word) ✅
- But NOT from actual audio word timing ❌

**With real timestamps:**
- Progress bar works ✅
- Updates smoothly (5 FPS) ✅
- Learns actual word durations from audio ✅✅
- Much more accurate ✅✅

## Summary

**You CAN use it now** - it's working with estimated timing!

**For REAL word timestamps**, update your HF endpoint or deploy to Modal.

Modal is recommended because:
- ✅ You control the code directly
- ✅ Script already written for you
- ✅ Easier to debug
- ✅ Usually cheaper (only pay when processing)
