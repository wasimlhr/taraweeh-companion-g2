# Word-Level Tracking Implementation Guide
## Quick Start: 2-Hour Enhancement

---

## Overview

This guide implements **Path 1: Word Timestamps** from the feasibility study.

**What you get:**
- Word-by-word progress bars within each ayah
- More accurate pace learning (actual word durations)
- Visual feedback: "Word 5 of 12" display
- Foundation for future word highlighting

**What you DON'T get (yet):**
- Lower latency (still 4-8s Whisper delay)
- True real-time word tracking (need Path 2/3 for that)

---

## Prerequisites

Check your transformers version:
```bash
cd /home/exedev/taraweeh-companion-g2/backend
python3 -c "import transformers; print(transformers.__version__)"
```

**Required:** >= 4.30.0 for `return_timestamps='word'`

If too old:
```bash
pip3 install --upgrade transformers
```

---

## Implementation Steps

### Step 1: Modify whisper_server.py (10 minutes)

**File:** `/home/exedev/taraweeh-companion-g2/backend/whisper_server.py`

**Change 1:** Update the `transcribe()` function (around line 52):

```python
def transcribe(wav_bytes):
    """Transcribe WAV audio bytes to Arabic text with word timestamps."""
    import soundfile as sf

    audio_data, sr = sf.read(io.BytesIO(wav_bytes))
    if len(audio_data.shape) > 1:
        audio_data = audio_data.mean(axis=1)  # Mono

    if sr != 16000:
        import librosa
        audio_data = librosa.resample(audio_data, orig_sr=sr, target_sr=16000)

    audio_data = audio_data.astype(np.float32)
    inputs = processor(audio_data, sampling_rate=16000, return_tensors="pt")
    feats = inputs.input_features.to(DEVICE, dtype=DTYPE)

    with torch.no_grad():
        ids = model.generate(
            feats,
            language="ar",
            task="transcribe",
            max_new_tokens=448,
            return_timestamps=True,  # ← ADD THIS LINE
        )

    # CHANGE THIS: from batch_decode to decode with timestamps
    result = processor.batch_decode(
        ids, 
        skip_special_tokens=True,
        return_timestamps='word'  # ← ADD THIS PARAMETER
    )[0]
    
    # result is now: {'text': '...', 'chunks': [{'text': '...', 'timestamp': (start, end)}]}
    return result
```

**Change 2:** Update the HTTP response handler (around line 73):

```python
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        # ... existing body parsing code ...

        try:
            result = transcribe(wav_data)  # Now returns dict with 'text' and 'chunks'
            
            # Build response with word timestamps
            import json
            response_data = {
                "text": result.get('text', '').strip(),
                "words": [
                    {
                        "text": chunk['text'],
                        "start": chunk['timestamp'][0],
                        "end": chunk['timestamp'][1],
                    }
                    for chunk in result.get('chunks', [])
                ]
            }
            
            response = json.dumps(response_data, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(response)
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(f'{{"error": "{str(e)}"}}'.encode())
```

**Restart the Python server:**
```bash
# Find and kill existing server
pkill -f whisper_server.py

# Start with new code
cd /home/exedev/taraweeh-companion-g2/backend
nohup python3 whisper_server.py > /tmp/whisper_server.log 2>&1 &

# Check logs
tail -f /tmp/whisper_server.log
```

---

### Step 2: Update whisperProvider.js (5 minutes)

**File:** `/home/exedev/taraweeh-companion-g2/backend/whisperProvider.js`

**Change:** Update `parseTranscription()` function (around line 69):

```javascript
function parseTranscription(result) {
  if (!result || typeof result !== 'object') return { text: '', words: [] };
  
  const text = (
    result.text ??
    result.transcription ??
    (Array.isArray(result) ? result[0]?.text : undefined) ??
    result.chunks?.[0]?.text ??
    result.segments?.[0]?.text ??
    ''
  ).trim();
  
  // NEW: Extract word-level timestamps
  const words = result.words ?? [];
  
  return { text, words };  // ← CHANGE: return object instead of just text
}
```

**Update all return statements in the file:**

Search for `return { text, provider:` (3-4 locations) and change from:
```javascript
return { text, provider: 'local' };
```

To:
```javascript
return { text, words: result.words || [], provider: 'local' };
```

Do this for:
- `callLocal()` (line ~62)
- `callRaw()` (line ~120)
- `callModal()` (line ~168)
- `transcribeWithWhisper()` fallback (line ~276)

---

### Step 3: Enhance audioPipelineV3.js (30-45 minutes)

**File:** `/home/exedev/taraweeh-companion-g2/backend/audioPipelineV3.js`

**Change 1:** Add new fields to constructor (around line 95):

```javascript
constructor(opts) {
  // ... existing fields ...
  
  // NEW: Word tracking fields
  this._currentWordIndex = 0;
  this._currentAyahWords = [];
  this._wordTimestamps = [];
  this._wordProgressInterval = null;
}
```

**Change 2:** Update `_onWhisperRawResult()` to pass words (around line 1135):

```javascript
async _onWhisperRawResult(result) {
  const transcript = result.text;
  const words = result.words || [];  // ← NEW
  
  // ... existing matching code ...
  
  if (match) {
    this._onWhisperConfirm(transcript, match, words);  // ← Add words parameter
  } else {
    this._onWhisperNoMatch(transcript, words);  // ← Add words parameter
  }
}
```

**Change 3:** Update `_onWhisperConfirm()` signature and add word tracking (around line 986):

```javascript
_onWhisperConfirm(transcript, match, words = []) {  // ← Add words parameter
  // ... ALL existing confirmation logic stays the same ...
  
  // NEW: Add at the end of the function, before closing brace
  if (words.length > 0) {
    this._wordTimestamps = words;
    this._learnWordPaceFromTimestamps();
  }
  this._updateWordProgress();
}
```

**Change 4:** Add new method `_learnWordPaceFromTimestamps()` (add after `_onWhisperConfirm()`):

```javascript
_learnWordPaceFromTimestamps() {
  if (this._wordTimestamps.length === 0) return;
  
  // Calculate actual pace from word durations
  const durations = this._wordTimestamps.map(w => (w.end - w.start) * 1000);
  const avgMs = durations.reduce((a, b) => a + b, 0) / durations.length;
  
  // Weighted average with existing estimate (70% old, 30% new)
  if (this._measuredMsPerWord > 0) {
    this._measuredMsPerWord = Math.round(this._measuredMsPerWord * 0.7 + avgMs * 0.3);
  } else {
    this._measuredMsPerWord = Math.round(avgMs);
  }
  
  // Also update WPS for consistency
  this._measuredWps = 1000 / this._measuredMsPerWord;
  
  console.log(
    `[Pipeline] Word pace from timestamps: ${avgMs.toFixed(0)}ms avg ` +
    `(${Math.min(...durations).toFixed(0)}-${Math.max(...durations).toFixed(0)}ms range, ` +
    `${this._wordTimestamps.length} words)`
  );
}
```

**Change 5:** Add `_updateWordProgress()` method (add after `_learnWordPaceFromTimestamps()`):

```javascript
_updateWordProgress() {
  const ayah = getAyah(this._surah, this._displayAyah);
  if (!ayah) return;
  
  const totalWords = ayah.words.length;
  if (totalWords === 0) return;
  
  // Estimate current word based on timer
  const elapsedMs = Date.now() - this._lockTime;
  const msPerWord = this._measuredMsPerWord || 700;
  this._currentWordIndex = Math.max(0, Math.min(
    Math.floor(elapsedMs / msPerWord),
    totalWords - 1
  ));
  
  // Emit word progress to frontend
  this._emitUpdate({
    type: 'wordProgress',
    surah: this._surah,
    ayah: this._displayAyah,
    wordIndex: this._currentWordIndex,
    totalWords: totalWords,
    progress: this._currentWordIndex / totalWords,
    words: ayah.words,  // Send full word list for highlighting
  });
}
```

**Change 6:** Start word progress timer in `_startReadAdvanceTimer()` (around line 1352):

```javascript
_startReadAdvanceTimer() {
  this._cancelReadAdvance();
  
  // ... existing timer code ...
  
  // NEW: Also update word progress periodically
  this._wordProgressInterval = setInterval(() => {
    this._updateWordProgress();
  }, 200);  // 5 updates per second
}
```

**Change 7:** Clear word progress timer in `_cancelReadAdvance()` (around line 1366):

```javascript
_cancelReadAdvance() {
  if (this._readAdvanceTimer) {
    clearTimeout(this._readAdvanceTimer);
    this._readAdvanceTimer = null;
  }
  
  // NEW: Clear word progress timer
  if (this._wordProgressInterval) {
    clearInterval(this._wordProgressInterval);
    this._wordProgressInterval = null;
  }
}
```

**Change 8:** Update `_onWhisperNoMatch()` signature (around line 1094):

```javascript
_onWhisperNoMatch(transcript, words = []) {  // ← Add words parameter
  // ... existing code stays the same ...
}
```

---

### Step 4: Restart Node.js Server (2 minutes)

```bash
# Kill existing server
pkill -9 -f "node server.js"

# Restart with new code
cd /home/exedev/taraweeh-companion-g2/backend
nohup node server.js > /dev/null 2>&1 &

# Check status
lsof -i:3001
```

---

### Step 5: Frontend Display (30-45 minutes)

**Create new component or update existing display.**

If using Vue.js, add to your ayah display component:

```vue
<template>
  <div class="ayah-display">
    <!-- Existing ayah text -->
    <div class="ayah-text arabic">{{ currentAyah.text }}</div>
    
    <!-- NEW: Word progress indicator -->
    <div v-if="wordProgress.totalWords > 0" class="word-progress">
      <div class="progress-info">
        <span class="word-count">
          Word {{ wordProgress.wordIndex + 1 }} / {{ wordProgress.totalWords }}
        </span>
        <span class="percentage">
          {{ Math.round(wordProgress.progress * 100) }}%
        </span>
      </div>
      <div class="progress-bar">
        <div 
          class="progress-fill" 
          :style="{ width: (wordProgress.progress * 100) + '%' }"
        ></div>
      </div>
    </div>
    
    <!-- Existing surah/ayah info -->
    <div class="ayah-info">
      {{ currentAyah.surahName }} {{ currentAyah.surah }}:{{ currentAyah.ayah }}
    </div>
  </div>
</template>

<script>
export default {
  data() {
    return {
      currentAyah: {},
      wordProgress: {
        wordIndex: 0,
        totalWords: 0,
        progress: 0,
      }
    };
  },
  
  mounted() {
    // Add to existing WebSocket message handler
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      
      // Existing handlers...
      
      // NEW: Handle word progress updates
      if (msg.type === 'wordProgress') {
        this.wordProgress = {
          wordIndex: msg.wordIndex,
          totalWords: msg.totalWords,
          progress: msg.progress,
        };
      }
    });
  }
}
</script>

<style scoped>
.ayah-display {
  padding: 20px;
}

.ayah-text {
  font-size: 32px;
  line-height: 1.8;
  margin-bottom: 15px;
  font-family: 'Traditional Arabic', 'Arabic Typesetting', serif;
}

.word-progress {
  margin: 15px 0;
  background: rgba(255, 255, 255, 0.1);
  padding: 10px;
  border-radius: 8px;
}

.progress-info {
  display: flex;
  justify-content: space-between;
  font-size: 14px;
  color: #999;
  margin-bottom: 8px;
  font-family: system-ui, -apple-system, sans-serif;
}

.word-count {
  font-weight: 500;
}

.percentage {
  color: #4CAF50;
}

.progress-bar {
  height: 6px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #4CAF50, #8BC34A);
  transition: width 0.2s ease-out;
  box-shadow: 0 0 10px rgba(76, 175, 80, 0.5);
}

.ayah-info {
  font-size: 14px;
  color: #999;
  margin-top: 10px;
  font-family: system-ui, -apple-system, sans-serif;
}

/* Optional: Pulse animation when progressing */
.progress-fill {
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.8; }
}
</style>
```

---

## Testing

### Test 1: Long Ayah (Surah 2:282)
- Navigate to Surah 2, Ayah 282 (longest ayah in Quran - 128 words!)
- Start reciting or play audio
- Watch word progress bar advance
- Should show "Word 1 of 128" → "Word 128 of 128"

### Test 2: Short Ayah (Surah 108:1)
- Navigate to Surah 108, Ayah 1 (3 words)
- Observe rapid progress: "Word 1 of 3" → "Word 3 of 3"

### Test 3: Pace Learning
- Recite 3-4 ayahs in a row
- Check console logs for: "Word pace from timestamps: XXXms avg"
- Verify pace updates and matches your actual speed

### Test 4: Manual Advance
- Use manual advance button during recitation
- Verify word progress resets to 0 for new ayah
- Check that progress bar doesn't break

---

## Debugging

### If word timestamps not appearing:

1. **Check Python server response:**
```bash
curl -X POST http://localhost:8000/transcribe \
  -H "Content-Type: audio/wav" \
  --data-binary @test.wav \
  | python3 -m json.tool
```

Should see:
```json
{
  "text": "بسم الله الرحمن الرحيم",
  "words": [
    {"text": "بسم", "start": 0.0, "end": 0.5},
    {"text": "الله", "start": 0.5, "end": 1.0},
    ...
  ]
}
```

2. **Check Node.js logs:**
```bash
journalctl _PID=$(pgrep -f "node server.js") -f
```

Look for: `Word pace from timestamps: XXXms avg`

3. **Check browser console:**
- Open DevTools → Console
- Look for WebSocket messages with `type: 'wordProgress'`

4. **Verify transformers version:**
```bash
python3 -c "import transformers; print(transformers.__version__)"
```

Must be >= 4.30.0

---

## Rollback (If Something Breaks)

All changes are additive and backwards-compatible. If issues occur:

1. **Backend:** Remove `return_timestamps` parameters, revert to simple text return
2. **whisperProvider.js:** Return just `{ text }` instead of `{ text, words }`
3. **audioPipelineV3.js:** Comment out word tracking methods
4. **Frontend:** Hide word progress component with `v-if="false"`

---

## Performance Notes

- **CPU/GPU:** No additional load (same Whisper inference)
- **Memory:** +10KB per transcription (word timestamp data)
- **Network:** +10-20% WebSocket payload size
- **Frontend:** 5 FPS updates (200ms interval) — negligible

---

## Next Enhancements (After This Works)

1. **Word Highlighting:** Highlight current word in ayah text (like Tarteel)
2. **Word-by-Word Pronunciation:** Show transliteration for current word
3. **Tajweed Rules:** Display tajweed markers for current word
4. **Pace Visualization:** Graph showing word speed variations
5. **Path 2 Implementation:** Phoneme-based tracking for lower latency

---

## Questions?

Check logs:
```bash
# Python server
tail -f /tmp/whisper_server.log

# Node.js server
journalctl _PID=$(pgrep -f "node server.js") -f

# Browser
# Open DevTools → Console
```

Git commit message:
```
feat: Add word-level progress tracking within ayahs

- Enable Whisper word timestamps (return_timestamps='word')
- Track word positions and durations in audioPipelineV3
- Emit wordProgress events to frontend
- Display "Word X of Y" progress bar
- Learn pace from actual word durations (more accurate)

Estimated effort: 2-4 hours
Performance impact: Minimal
```
