# Deploy Whisper with Word Timestamps to Modal

## Prerequisites

```bash
# Install Modal CLI
pip install modal

# Authenticate
modal token new
```

## Step 1: Deploy to Modal

```bash
cd /home/exedev/taraweeh-companion-g2

# Deploy (this will build the image and create the endpoint)
modal deploy modal_whisper_deploy.py
```

Output will show:
```
✓ Created web function transcribe_endpoint => https://YOUR-APP-ID.modal.run
```

**Copy that URL!** That's your new endpoint with word timestamps.

## Step 2: Update Your Backend

Edit `backend/.env`:
```bash
WHISPER_ENDPOINT_URL=https://YOUR-APP-ID.modal.run
# Remove or comment out the old HF endpoint
```

## Step 3: Restart Server

```bash
cd backend
pkill -f "node server.js"
node server.js > /tmp/server_v4.log 2>&1 &
```

## Step 4: Test

Watch logs:
```bash
tail -f /tmp/server_v4.log
```

When you send audio, you should see:
```
[Whisper] "بسم الله..." (2000ms) [4 words]
                                 ^^^^^^^^^^ This means timestamps working!

Word pace from timestamps: 650ms avg (500-800ms range, 4 words) → 620ms/w
```

---

## Troubleshooting

### If Modal deploy fails with transformers version:

The endpoint needs transformers >= 4.30.0 for word timestamps. The script already specifies this.

### If you want to test locally first:

```bash
modal run modal_whisper_deploy.py::test
```

This will load the model and test with dummy audio.

### Check Modal logs:

```bash
modal app logs whisper-quran-v1-timestamps
```

### Cost estimate:

- A10G GPU: ~$1/hour
- With 300s idle timeout, it only charges when processing
- Cold starts: ~10-15 seconds (first request)
- Warm requests: ~1-2 seconds

---

## Alternative: Update Existing Modal Deployment

If you already have Modal code deployed, just add these two lines:

**In your existing Modal code:**
```python
# In model.generate()
generated_ids = model.generate(
    ...,
    return_timestamps=True  # ← ADD THIS
)

# In processor.batch_decode()
result = processor.batch_decode(
    generated_ids,
    return_timestamps='word'  # ← ADD THIS
)[0]
```

Then:
```bash
modal deploy your_existing_file.py
```

---

## Expected Result

### Before (Current):
```json
{
  "text": "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ"
}
```

### After (With Timestamps):
```json
{
  "text": "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ",
  "words": [
    {"text": "بِسْمِ", "start": 0.0, "end": 0.6},
    {"text": "اللَّهِ", "start": 0.6, "end": 1.2},
    {"text": "الرَّحْمَٰنِ", "start": 1.2, "end": 1.9},
    {"text": "الرَّحِيمِ", "start": 1.9, "end": 2.5}
  ]
}
```

Backend will automatically use the word timestamps for:
- Learning actual pace
- Displaying word progress
- Smoother tracking

Frontend will show:
```
┌──────────────────────────┐
│ بِسْمِ اللَّهِ الرَّحْمَٰنِ │
│                          │
│ Word 2/4           50%   │
│ ▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░     │
│                          │
│ Al-Fatihah 1:1          │
└──────────────────────────┘
```

---

## Quick Commands

```bash
# Deploy
modal deploy modal_whisper_deploy.py

# Check status
modal app list

# View logs
modal app logs whisper-quran-v1-timestamps

# Stop deployment (to save costs)
modal app stop whisper-quran-v1-timestamps
```

---

**Do this now:**
1. `modal token new` (if not authenticated)
2. `modal deploy modal_whisper_deploy.py`
3. Copy the URL
4. Update `.env` with new URL
5. Restart server
6. Test!
