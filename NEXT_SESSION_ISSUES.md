# Issues to Fix Next Session (InshaAllah)

## 1. Duplicate Phrase Scoring Bug (PRIORITY)
**Problem:** Locked on wrong surah during Taraweeh
- User reciting: **20:77** (Ta-Ha)
- System locked on: **26:52** (Ash-Shu'ara)
- Both verses contain identical phrase: "وَأَوۡحَيۡنَآ إِلَىٰ مُوسَىٰٓ أَنۡ أَسۡرِ بِعِبَادِي"

**Matcher Results:**
```
1. [26:52] score=0.44 matched 5 words ← WRONG (picked this)
2. [20:77] score=0.40 matched 9 words ← CORRECT (should have won)
```

**Root Cause:** 
- 20:77 matched MORE words (9 vs 5) but got LOWER score
- Scoring algorithm needs to weight word count/coverage more heavily
- IDF scoring may be favoring shorter matches incorrectly

**Fix Location:** `backend/keywordMatcher.js` - scoring algorithm

**Solution Options:**
1. Increase weight of coverage% in final score
2. Penalize matches with low word count
3. Add "uniqueness bonus" for longer continuous matches
4. Prefer matches with more unique words when scores are close (<0.05 margin)

## Today's Accomplishments ✅
1. Fixed 6 major tracking issues for Surah Ar-Rahman
2. Reduced manual cooldown from 4s → 2s
3. Reduced manual back timer from 50% → 30%
4. Overlapping audio windows (4-10s)
5. Force-unblock at 8s
6. Display lead increased to 3-4
7. Pace learning death spiral fixes

## Known Workarounds
- Enable Taraweeh mode (if available in UI)
- Manual corrections work better now with 2s cooldown
- Avoid rapid clicking (wait 3+ seconds between clicks)

