# Ayah Repeat Detection - Fix Summary

## Problem
When imam repeats an ayah (e.g. goes back from 125 → 124), the system:
1. Kept advancing display forward while waiting for confirmation
2. Required 2-3 Whisper confirmations (16-24 seconds delay!)
3. Created massive drift requiring manual sync

## Example Scenario (OLD BEHAVIOR)
```
Time 0s:  Display at 125, Imam starts repeating 124
Time 8s:  Whisper detects 124 (repeat count 1/3), Display advances to 126
Time 16s: Whisper detects 124 again (repeat count 2/3), Display advances to 127
Time 24s: Whisper detects 124 third time (3/3) → FINALLY goes back to 124
Result:   User had to manually click back 3 times
```

## Solution Implemented

### Fix 1: Faster Back-Correction for High Confidence
**Old logic:**
- Lag 1 (1 ayah behind): needs 2 confirmations
- Lag 2+ (2+ ayahs behind): needs 3 confirmations

**New logic:**
```javascript
const REPEAT_BACK_CORRECT_WINS = score >= 80 ? 1 : (lag === 1 ? 2 : 3);
```

- **≥80% confidence:** Immediate back-correct (1 confirmation) ✨
- **<80% confidence:** Original behavior (2-3 confirmations)

### Fix 2: Stop Timer While Behind
**Old behavior:** Timer kept advancing display forward even when Whisper was behind

**New behavior:**
```javascript
if (score >= REPEAT_BACK_CORRECT_MIN_CONF) {
  this._cancelReadAdvance();  // STOP advancing forward
  // Wait for confirmation before resuming
}
```

When Whisper is confidently behind (≥65%), PAUSE the display timer until:
- Whisper catches up, OR
- Back-correction is triggered

## New Behavior Example
```
Time 0s:  Display at 125, Imam starts repeating 124
Time 8s:  Whisper detects 124 at 82% confidence
          → Timer PAUSED (display stays at 125)
          → Score ≥80% → Immediate back-correct to 124 ✨
Time 9s:  Timer resumes from 124
Result:   No manual intervention needed!
```

## Edge Cases Handled

### High Confidence (≥80%)
- Immediate back-correct on first detection
- Timer paused → no drift

### Medium Confidence (65-79%)
- Timer still paused
- Waits for 2-3 confirmations (original behavior)
- Prevents runaway drift

### Low Confidence (<65%)
- Timer continues with drift multiplier
- Waits for higher confidence before acting
- Prevents false positives

### Cooldowns Still Active
- Manual adjust cooldown (2s): blocks back-corrections after user clicks
- Back-correct cooldown (6s): prevents ping-pong
- Max distance (3 ayahs): blocks confused anchor

## Expected Improvement

**Before:**
- Repeat detection delay: 16-24 seconds
- Manual syncs needed: 2-5 clicks per repeat
- Drift accumulation during delay

**After:**
- Repeat detection delay: 8 seconds (high conf) or 16 seconds (medium conf)
- Manual syncs needed: 0-1 clicks per repeat
- No drift (timer paused while behind)

## Testing Notes

Watch for:
- ✅ Faster response when imam repeats
- ✅ Display doesn't run away during repeats
- ⚠️ False positives on similar verses (should be prevented by cooldowns)
- ⚠️ Ping-pong between adjacent ayahs (6s cooldown should prevent)

