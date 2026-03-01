# G2 Quran App — Integration Guide

## Architecture Overview

```
Mic (G2 glasses) → Audio chunks → Whisper ASR → Arabic text
  → Token F1 + IDF matcher → Verse DB (6,236 ayahs)
  → Translation + Transliteration + Arabic
  → G2 Display (640×350 monochrome)
```

**Key insight:** Whisper does NOT need to be perfect. Even at 15% WER, fuzzy matching against a closed vocabulary of 6,236 verses recovers the correct ayah 90%+ of the time. The app displays pre-stored correct content from the verse database, not Whisper's raw output.

---

## 1. Model

**Current best:** `wasimlhr/whisper-quran-phase1-step4500`
- Base: OpenAI Whisper Large V3 (1.5B params)
- Fine-tuned on 5 reciters: Alafasy, Sudais, Husary, Husary Mujawwad, Minshawy Murattal
- WER: 5.74% on trained reciters
- Generalizes to unseen reciters (tested 20+ reciters, 100% detection rate)

**Loading the model:**

```python
from transformers import WhisperProcessor, WhisperForConditionalGeneration
import torch

MODEL_ID = "wasimlhr/whisper-quran-phase1-step4500"

processor = WhisperProcessor.from_pretrained(MODEL_ID, language="ar", task="transcribe")
model = WhisperForConditionalGeneration.from_pretrained(
    MODEL_ID,
    torch_dtype=torch.float16,
    device_map="auto",
)
model.eval()
```

---

## 2. Verse Database — Where to Pull Ayah Data

The app needs a local database of all 6,236 ayahs with Arabic text, English translation, and transliteration. Two sources:

### Option A: Buraaq/quran-md-ayahs (HuggingFace Dataset) — RECOMMENDED

This is the same dataset used for training. It already has all the fields you need.

```python
from datasets import load_dataset

ds = load_dataset("Buraaq/quran-md-ayahs", split="train")

verse_db = {}
for row in ds:
    key = (int(row["surah_id"]), int(row["ayah_id"]))
    if key not in verse_db:
        verse_db[key] = {
            "arabic":          row.get("ayah_ar", ""),
            "translation":     row.get("ayah_en", ""),
            "transliteration": row.get("ayah_tr", ""),
            "surah_name":      row.get("surah_name_en", ""),
        }
# Result: 6,236 unique ayahs
```

**Fields available:**
- `ayah_ar` — Arabic text (Uthmani script with diacritics)
- `ayah_en` — English translation (Sahih International)
- `ayah_tr` — English transliteration
- `surah_name_en` — Surah name in English (e.g., "Al-Fatihah")
- `surah_id` — 1–114
- `ayah_id` — Ayah number within surah

**Pros:** Single source, already used in training, has transliteration.
**Cons:** Large dataset (~40GB with audio), need to extract text fields only.

### Option B: quran.com API — Lightweight Alternative

Good for building a standalone JSON file without downloading the full audio dataset.

```python
import requests, re, json

def strip_html(text):
    text = re.sub(r'<sup[^>]*>.*?</sup>', '', text)
    return re.sub(r'<[^>]+>', '', text).strip()

verse_db = {}
for surah_id in range(1, 115):
    # Arabic + Sahih International translation (resource 20)
    url = (f"https://api.quran.com/api/v4/verses/by_chapter/{surah_id}"
           f"?language=en&translations=20&per_page=300&fields=text_uthmani")
    resp = requests.get(url, timeout=15)
    for v in resp.json().get("verses", []):
        key = (surah_id, v["verse_number"])
        translation = ""
        for t in v.get("translations", []):
            translation = strip_html(t.get("text", ""))
            break
        verse_db[key] = {
            "arabic": v.get("text_uthmani", ""),
            "translation": translation,
            "transliteration": "",  # fetch separately
            "surah_name": "",
        }

# Surah names
r = requests.get("https://api.quran.com/api/v4/chapters?language=en", timeout=10)
names = {ch["id"]: ch["name_simple"] for ch in r.json()["chapters"]}
for k in verse_db:
    verse_db[k]["surah_name"] = names.get(k[0], "")

# Save as JSON (~3MB)
with open("verse_db.json", "w", encoding="utf-8") as f:
    json.dump({f"{k[0]}:{k[1]}": v for k, v in verse_db.items()}, f, ensure_ascii=False)
```

**Pros:** Lightweight (~3MB JSON), no audio download needed.
**Cons:** Transliteration requires separate API call (resource 57), rate limits.

### Option C: Pre-exported verses-display.json

The training script exports `verses-display.json` and `verses_metadata.json` to the processed datasets directory. If you've already run training, these files are ready to use.

```python
import json
with open("verses-display.json", "r", encoding="utf-8") as f:
    display = json.load(f)  # key: "surah_id:ayah_id", value: {arabic, translation, transliteration}
```

### Recommendation

For the G2 app, pre-build a `verse_db.json` once using Option A or B, ship it with the app. At runtime, load it into memory (~3MB). No network calls needed for verse lookup.

---

## 3. Audio Handling — Chunked Inference

Whisper has a 30-second attention window. For the G2 app, audio arrives as a continuous stream from the microphone. Here's how to handle it:

### Short ayahs (≤30s) — Direct transcription

```python
def transcribe(audio_array, sr=16000):
    inputs = processor(audio_array, sampling_rate=sr, return_tensors="pt")
    feats = inputs.input_features.to(device, dtype=torch.float16)
    attn_mask = torch.ones(feats.shape[:2], dtype=torch.long, device=device)

    with torch.no_grad():
        ids = model.generate(
            feats,
            attention_mask=attn_mask,
            language="ar",
            task="transcribe",
            max_new_tokens=256,
        )
    return processor.batch_decode(ids, skip_special_tokens=True)[0].strip()
```

### Long ayahs (>30s) — Segmented transcription

Split audio into 30s chunks with 2s overlap, transcribe each, stitch with overlap dedup:

```python
import librosa

def transcribe_long(audio_array, sr=16000):
    duration = len(audio_array) / sr

    if duration <= 30:
        return transcribe(audio_array, sr)

    # Segment into 30s chunks with 2s overlap
    chunk_len = 30 * sr
    overlap = 2 * sr
    segments = []
    start = 0
    while start < len(audio_array):
        end = min(start + chunk_len, len(audio_array))
        segments.append(audio_array[start:end])
        start = end - overlap
        if end == len(audio_array):
            break

    # Transcribe each segment
    texts = [transcribe(seg, sr) for seg in segments]

    # Stitch with overlap dedup
    combined = texts[0]
    for t in texts[1:]:
        combined_words = combined.split()
        t_words = t.split()
        overlap_len = 0
        for ol in range(min(5, len(combined_words), len(t_words)), 0, -1):
            if combined_words[-ol:] == t_words[:ol]:
                overlap_len = ol
                break
        combined += " " + " ".join(t_words[overlap_len:])

    return combined.strip()
```

### Streaming (real-time on G2) — Cumulative chunks

For real-time use, feed cumulative audio in 3-second intervals:

```python
# Pseudocode for G2 streaming loop
buffer = []          # accumulate audio samples
lock = StreamingLock()

while recording:
    new_audio = mic.read(3 * 16000)  # 3 seconds
    buffer.extend(new_audio)

    text = transcribe(np.array(buffer))
    matches = match_verse(text, top_k=5)

    is_locked, best, reason = lock.update(matches, tokenize(text))

    if is_locked:
        display_verse(best)
        break
```

---

## 4. Verse Matching

### Arabic Normalization

Before matching, normalize both Whisper output and verse database text:

```python
import re

ARABIC_DIACRITICS = re.compile(r'[\u0610-\u061A\u064B-\u065F\u0670]')

def norm_ar(text):
    if not text: return ""
    text = ARABIC_DIACRITICS.sub('', text)           # strip diacritics
    text = re.sub(r'[أإآٱ]', 'ا', text)              # normalize hamza
    text = re.sub(r'ة', 'ه', text)                    # taa marbuta
    text = re.sub(r'ـ', '', text)                      # tatweel
    text = re.sub(r'[\u06D6-\u06ED\u0600-\u0605۞]', '', text)  # Quran marks
    return re.sub(r'\s+', ' ', text).strip()

def tokenize(text):
    return norm_ar(text).split()
```

### Token F1 + IDF Scoring (v5 matcher)

Do NOT use `fuzz.partial_ratio` — it has a bias toward shorter verses. Use token F1 with IDF weighting:

```python
from collections import Counter
import math
from rapidfuzz import fuzz, process

# Pre-compute at startup
verse_tokens = {}  # (surah, ayah) -> list of normalized tokens
doc_freq = Counter()

for key, info in verse_db.items():
    tokens = tokenize(info["arabic"])
    verse_tokens[key] = tokens
    for t in set(tokens):
        doc_freq[t] += 1

N = len(verse_db)
idf = {t: math.log(N / (1 + df)) for t, df in doc_freq.items()}


def idf_weighted_f1(t_tokens, v_tokens):
    """IDF-weighted F1 between transcript and verse tokens."""
    if not t_tokens or not v_tokens:
        return 0.0

    t_counter, v_counter = Counter(t_tokens), Counter(v_tokens)
    overlap = t_counter & v_counter

    if not overlap:
        return 0.0

    matched_w = sum(c * idf.get(t, 1.0) for t, c in overlap.items())
    trans_w   = sum(c * idf.get(t, 1.0) for t, c in t_counter.items())
    verse_w   = sum(c * idf.get(t, 1.0) for t, c in v_counter.items())

    precision = matched_w / trans_w if trans_w else 0
    recall    = matched_w / verse_w if verse_w else 0

    return 2 * precision * recall / (precision + recall) if (precision + recall) else 0


def match_verse(whisper_text, top_k=5):
    t_tokens = tokenize(whisper_text)
    t_norm = " ".join(t_tokens)

    if not t_tokens:
        return []

    # Stage 1: Fast fuzzy retrieval (top 20)
    search_idx = {f"{k[0]}:{k[1]}": " ".join(v) for k, v in verse_tokens.items() if v}
    candidates = process.extract(t_norm, search_idx, scorer=fuzz.ratio, limit=20)

    # Stage 2: IDF-weighted F1 rerank
    scored = []
    for _, _, key_str in candidates:
        s, a = key_str.split(":")
        key = (int(s), int(a))
        v_tok = verse_tokens.get(key, [])

        score = idf_weighted_f1(t_tokens, v_tok)

        info = verse_db.get(key, {})
        scored.append({
            "surah_id": key[0], "ayah_id": key[1],
            "score": round(score * 100, 1),
            "surah_name": info.get("surah_name", ""),
            "arabic": info.get("arabic", ""),
            "translation": info.get("translation", ""),
            "transliteration": info.get("transliteration", ""),
        })

    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:top_k]
```

### Ambiguity-Aware Lock Rule (for streaming)

Don't lock on a match too early. Require margin, consistency, and coverage:

```python
class StreamingLock:
    MARGIN = 8.0        # score gap between #1 and #2
    MIN_WINS = 2        # consecutive chunks where #1 stays #1
    MIN_COVERAGE = 0.3  # must hear 30% of verse tokens

    def __init__(self):
        self.leader = None
        self.wins = 0
        self.locked = False
        self.result = None

    def update(self, matches, transcript_tokens):
        if self.locked:
            return True, self.result, "locked"
        if not matches:
            return False, None, "no matches"

        top1 = matches[0]
        top2 = matches[1] if len(matches) > 1 else None

        margin = top1["score"] - (top2["score"] if top2 else 0)
        leader_key = (top1["surah_id"], top1["ayah_id"])

        if leader_key == self.leader:
            self.wins += 1
        else:
            self.leader = leader_key
            self.wins = 1

        v_count = len(verse_tokens.get(leader_key, []))
        coverage = len(transcript_tokens) / v_count if v_count > 3 else 1.0

        if margin >= self.MARGIN and self.wins >= self.MIN_WINS and coverage >= self.MIN_COVERAGE:
            self.locked = True
            self.result = top1
            return True, top1, "locked"

        return False, top1, f"margin={margin:.1f}, wins={self.wins}, cov={coverage:.1%}"
```

### Special Cases

**Muqatta'at letters** (يس، الم، حم, etc.): Whisper outputs the spoken form ("ياسين" not "يس"). Map these directly:

```python
MUQATTAAT = {
    "ياسين": (36, 1),
    "طه": (20, 1),
    "الم": [(2,1), (3,1), (29,1), (30,1), (31,1), (32,1)],
    # ... add all 14 patterns
}
```

**Repeated verses** (e.g., 55:13 "فبأي آلاء ربكما تكذبان" appears 31 times in Ar-Rahman): Accept the first matching occurrence. The translation is identical across all instances.

---

## 5. Audio Source for Testing

Use everyayah.com for individual ayah MP3 files (same source as Buraaq dataset):

```python
import requests, io, librosa

RECITER_URLS = {
    "alafasy":    "Alafasy_128kbps",
    "sudais":     "Abdurrahmaan_As-Sudais_192kbps",
    "husary":     "Husary_128kbps",
    "ali_jaber":  "Ali_Jaber_64kbps",
    # ... full list in pipeline test script
}

def fetch_audio(reciter, surah, ayah, sr=16000):
    folder = RECITER_URLS[reciter]
    url = f"https://everyayah.com/data/{folder}/{surah:03d}{ayah:03d}.mp3"
    resp = requests.get(url, timeout=15)
    array, _ = librosa.load(io.BytesIO(resp.content), sr=sr, mono=True)
    return array
```

---

## 6. G2 Display

**Hardware constraints:** 640×350 pixels, monochrome, ~42 chars/line, 5 lines/page.

### Pagination

```python
import textwrap

def paginate(text, cpl=42, lpp=5):
    lines = textwrap.wrap(text, width=cpl)
    return [lines[i:i+lpp] for i in range(0, len(lines), lpp)] or [[""]]
```

### Three views

1. **Main View** — Translation (paginated) + surah/ayah reference + confidence score
2. **Word-by-Word View** — Transliteration paired with translation words
3. **Tafsir View** — Extended commentary (future, requires additional data source)

### Navigation

- **TAP:** Next page (within translation)
- **SWIPE:** Next/previous ayah
- **LONG PRESS:** Switch between views

---

## 7. Complete Pipeline Flow

```
1. G2 mic captures audio continuously
2. Every 3 seconds, feed cumulative audio to Whisper
3. Whisper outputs Arabic text
4. Normalize Arabic (strip diacritics, normalize hamza)
5. Stage 1: Fast fuzzy retrieval (top 20 candidates via rapidfuzz)
6. Stage 2: IDF-weighted token F1 rerank
7. Lock rule: Check margin, consistency, coverage
8. If locked → look up verse in verse_db
9. Display: translation (paginated), transliteration, surah reference
10. User taps for next page, swipes for next ayah
```

---

## 8. Performance Benchmarks (Phase 1 Model)

| Test | Result |
|------|--------|
| Full pipeline (10 ayahs) | 9/10 correct |
| Cross-reciter 2:255 (10 reciters) | 10/10 correct |
| Streaming lock (Bismillah) | 6.0s |
| Streaming lock (Al-Ikhlas, unseen reciter) | 3.2s |
| Streaming lock (Ayat al-Kursi) | Needs disambiguation rule |
| Longest ayah 2:282 (segmented) | Correct at 77.5% |

### Known Limitations

- **Ya-Sin [36:1]:** Whisper outputs "ياسين" not "يس" — needs muqatta'at whitelist
- **Ambiguous openings:** 2:255 and 3:2 share opening — lock rule must wait for disambiguating words
- **Very long ayahs:** 2:282 (145s) requires audio segmentation; lower confidence scores

---

## 9. File Inventory

| File | Purpose |
|------|---------|
| `train_quran_windows.py` | Training script (cumulative phases, balanced reciters) |
| `g2_pipeline_test_v5.py` | Colab test: Token F1 + IDF matcher, lock rule, muqatta'at |
| `g2-quran-v3.html` | G2 UI mockup (3 views) |
| `verse_db.json` | Pre-built verse database (generate with Option A/B above) |
| `verses-display.json` | Exported from training (surah:ayah → arabic/translation/transliteration) |
