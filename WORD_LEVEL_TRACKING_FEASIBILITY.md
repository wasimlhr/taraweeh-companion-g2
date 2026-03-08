# Word-Level Tracking Feasibility Analysis
## Taraweeh Companion Enhancement

---

## Executive Summary

**Current State:** Ayah-level tracking with 8-12s latency  
**Goal:** Word-level tracking like Tarteel AI (1-2s latency)  
**Verdict:** ✅ **FEASIBLE** with incremental approach

---

## Three Implementation Paths

### Path 1: Word Timestamps (Low Effort, Medium Gain)
**What:** Use Whisper's built-in word timestamp feature  
**Effort:** 2-4 hours  
**Latency:** Still 4-8s (Whisper inherent delay)  
**Gain:** Smooth word highlighting within ayahs

**Implementation:**
```javascript
// Modify model.generate() to return timestamps
ids, timestamps = model.generate(
    feats,
    language="ar",
    task="transcribe",
    return_timestamps=True,  // ← Enable this
)

// Response format:
{
  "text": "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ",
  "chunks": [
    {"text": "بِسْمِ", "timestamp": [0.0, 0.5]},
    {"text": "اللَّهِ", "timestamp": [0.5, 1.0]},
    {"text": "الرَّحْمَٰنِ", "timestamp": [1.0, 1.6]},
    {"text": "الرَّحِيمِ", "timestamp": [1.6, 2.2]}
  ]
}
```

**Pros:**
- No new models needed
- Uses existing Whisper infrastructure
- Can show word-by-word progress bars
- Improves pace learning accuracy

**Cons:**
- Still has 4-8s confirmation lag
- Whisper word boundaries might not match Quran word boundaries
- Diacritics/normalization issues

**Use Case:**
- Display progress bar showing "word 5 of 12" within current ayah
- More accurate timer (uses actual word durations instead of avg)
- Better visual feedback during long ayahs

---

### Path 2: Phoneme-Level Matching (Medium Effort, High Gain)
**What:** Match audio phonemes against Quran phoneme database  
**Effort:** 1-2 weeks  
**Latency:** 2-4s  
**Gain:** True word tracking without full transcription

**Implementation:**
1. **Phoneme Extraction:**
   - Use Wav2Vec2 Arabic model (facebook/wav2vec2-large-xlsr-53-arabic)
   - Extract phonemes in real-time (300ms windows)
   - Build phoneme sequence buffer

2. **Phoneme-to-Word Matching:**
   - Pre-build Quran phoneme database (IPA transcription)
   - Match incoming phonemes against expected words
   - Use phoneme edit distance scoring

3. **State Machine:**
   - Track current word position
   - Advance on phoneme match confidence > 70%
   - Fall back to Whisper for error correction

**Data Sources:**
- Quranic Arabic Corpus (quranarabic corpus.qld.edu.au) has word-level phonetics
- Can use Buckwalter transliteration → IPA conversion

**Pros:**
- Lower latency (no full transcription needed)
- More granular tracking
- Still language-agnostic (phoneme-based)

**Cons:**
- Need phoneme database for all 77k+ words
- Phoneme models less accurate than Whisper
- Complex state machine

---

### Path 3: Custom Quran ASR Model (High Effort, Highest Gain)
**What:** Train Tarteel-style model specifically for Quran  
**Effort:** 2-4 weeks + GPU resources  
**Latency:** 1-2s  
**Gain:** Industry-leading accuracy

**Approach:**
1. **Dataset:** EveryAyah.com (40+ reciters, all 6236 ayahs)
2. **Model:** Fine-tune Wav2Vec2 or Whisper Small on Quran-only
3. **Architecture:** Streaming CTC (Connectionist Temporal Classification)
4. **Output:** Word boundaries + confidence scores

**Training Pipeline:**
```python
# Pseudo-code
from datasets import load_dataset
from transformers import Wav2Vec2ForCTC

# Load EveryAyah audio dataset
dataset = load_quran_audio_dataset()  # 40 reciters × 6236 ayahs = 250k samples

# Fine-tune on word-level transcription
model = Wav2Vec2ForCTC.from_pretrained("facebook/wav2vec2-large-xlsr-53-arabic")
trainer.train(
    dataset,
    word_boundaries=True,
    streaming=True,
    chunk_size_ms=200,  # Real-time processing
)
```

**Pros:**
- Tarteel-level performance
- True real-time tracking
- Optimized for Quranic Arabic (no diacritics confusion)

**Cons:**
- Requires labeled training data (word boundaries)
- GPU training costs ($100-500)
- Ongoing maintenance

---

## Recommended Path: Hybrid Approach

### Phase 1: Word Timestamps (This Week) ✅
1. Modify `whisper_server.py` to return word timestamps
2. Update `whisperProvider.js` to parse timestamps
3. Enhance `audioPipelineV3.js` to track word positions
4. Display word progress bar in frontend

**Frontend Enhancement:**
```javascript
// Display format
Surah 20:77 (word 5 of 9)
وَأَوۡحَيۡنَآ إِلَىٰ مُوسَىٰٓ أَنۡ أَسۡرِ بِعِبَادِي
     ▓▓▓▓▓░░░░░░░░░░░░░░  // Progress bar
```

### Phase 2: Phoneme Matching (Next Month) ⏳
1. Build Quran phoneme database
2. Implement Wav2Vec2 phoneme extractor
3. Create phoneme matcher
4. Hybrid: Phonemes for tracking, Whisper for confirmation

### Phase 3: Custom Model (Future) 🔮
1. Collect EveryAyah dataset
2. Train custom Quran ASR
3. Deploy on Modal/HF
4. Replace Whisper entirely

---

## Immediate Action Items

### 1. Enable Whisper Word Timestamps (2 hours)

**A. Modify `whisper_server.py`:**
```python
# Line ~52, change generate() call:
ids = model.generate(
    feats,
    language="ar",
    task="transcribe",
    max_new_tokens=448,
    return_timestamps=True,  # ← ADD THIS
)

# Return format changes to:
result = processor.batch_decode(ids, skip_special_tokens=False, return_timestamps=True)
# result now contains: { "text": "...", "chunks": [...] }
```

**B. Update `whisperProvider.js`:**
```javascript
function parseTranscription(result) {
  const text = result.text ?? result.transcription ?? ...;
  const words = result.chunks ?? result.words ?? [];  // ← ADD THIS
  return { text, words };
}
```

**C. Enhance `audioPipelineV3.js`:**
```javascript
_onWhisperConfirm(transcript, words = []) {
  // Existing logic...
  
  // NEW: Track word positions
  if (words.length > 0) {
    this._wordTimestamps = words.map(w => ({
      text: w.text,
      start: w.timestamp[0],
      end: w.timestamp[1],
    }));
    this._learnWordPace();
  }
}

_learnWordPace() {
  // Use actual word durations instead of average
  const durations = this._wordTimestamps.map(w => w.end - w.start);
  const avgMs = durations.reduce((a, b) => a + b, 0) / durations.length * 1000;
  this._measuredMsPerWord = Math.round(avgMs);
  console.log(`[Pipeline] Learned word pace: ${this._measuredMsPerWord}ms/word from ${durations.length} words`);
}
```

### 2. Frontend Word Progress (1 hour)

**WebSocket Event:**
```javascript
{
  type: 'lockedUpdate',
  surah: 20,
  ayah: 77,
  wordIndex: 5,      // ← NEW
  totalWords: 9,     // ← NEW
  progress: 0.56,    // ← NEW (5/9)
}
```

**Display Component:**
```html
<div class="ayah-container">
  <div class="ayah-text">وَأَوۡحَيۡنَآ إِلَىٰ مُوسَىٰٓ أَنۡ أَسۡرِ بِعِبَادِي</div>
  <div class="word-progress">
    <span>Word {{ wordIndex }} of {{ totalWords }}</span>
    <div class="progress-bar">
      <div class="fill" :style="{ width: progress * 100 + '%' }"></div>
    </div>
  </div>
</div>
```

---

## Data Requirements

### Quran Word-Level Data (Already Available!)
- **quran-full.json** already has words (space-separated)
- **Quranic Arabic Corpus** has phonetic data
- **Tanzil.net** has word boundaries + morphology

### External Datasets for Training
1. **EveryAyah.com:** 40+ reciters, all 6236 ayahs, segmented audio
2. **Tarteel Dataset:** Open-source Quran recitation dataset (GitHub)
3. **YouTube Quran Playlists:** Aligned transcripts

---

## Performance Comparison

| Feature | Current | Path 1 (Timestamps) | Path 2 (Phonemes) | Path 3 (Custom) |
|---------|---------|---------------------|-------------------|-----------------|
| Latency | 8-12s | 4-8s | 2-4s | 1-2s |
| Granularity | Ayah | Word (delayed) | Word (real-time) | Word (real-time) |
| Accuracy | 95% | 95% | 85% | 98% |
| Effort | Done | 2-4 hours | 1-2 weeks | 2-4 weeks |
| Cost | $0 | $0 | $0 | $100-500 |

---

## Conclusion

**Start with Path 1 (Word Timestamps) immediately:**
- Low effort, immediate value
- Improves user experience without infrastructure changes
- Foundation for Path 2/3

**Evaluate Path 2 (Phonemes) after 1 month of usage:**
- If users want lower latency
- If word timestamps prove valuable

**Consider Path 3 (Custom Model) only if:**
- Budget available ($500+)
- Want industry-leading performance
- Plan to commercialize
