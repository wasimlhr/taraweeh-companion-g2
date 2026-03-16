# How to Verify V4 is Running

## Quick Check

**Server PID:** 93097  
**Log File:** `/tmp/server_v4.log`  
**Status:** ✅ V4 forced for all connections

---

## Step 1: Refresh Your App

**Refresh the browser/app** to reconnect with the new V4 server.

---

## Step 2: Monitor Logs

```bash
tail -f /tmp/server_v4.log
```

---

## Step 3: Look for V4 Indicators

### On Connect:
```
[Init] preferredSurah=0 pipeline=v4 (client requested: v3)
                                ^^^^ Should say "v4" now!

[Init] Creating pipeline V4 translationLang=(built-in)
                         ^^ Should be "V4" (not V3)
```

### On Audio Processing:
```
[Whisper] "بسم الله..." [12 words]
                       ^^^^^^^^^^^ Word count = timestamps received!

Word pace from timestamps: 650ms avg (500-800ms range, 12 words) → 620ms/w
^^^^^^^^^^^^^^^^^^^^^^^^^ This means V4 is learning from word durations!
```

### Word Progress Events (every 200ms):
```
# These are sent to frontend but not logged by default
# Check browser DevTools → WebSocket messages:
{
  "type": "wordProgress",
  "surah": 20,
  "ayah": 77,
  "wordIndex": 5,
  "totalWords": 12,
  "progress": 0.42
}
```

---

## What Changed

**Before (V3):**
- Client could choose pipeline version
- Default was V3

**Now (V4 Forced):**
- Server ignores client's version request
- Always uses V4
- Log shows: `(client requested: v3)` but uses V4 anyway

---

## Rollback if Needed

If V4 causes issues:

```bash
# Edit server.js line 168
# Change: const ver = 'v4';
# To:     const ver = requestedVer;

pkill -f "node server.js"
cd /home/exedev/taraweeh-companion-g2/backend
node server.js > /tmp/server.log 2>&1 &
```

---

## Current Server Status

```bash
# Check if running
ps aux | grep "[n]ode server.js"

# Check port
lsof -i:3001

# View logs
tail -50 /tmp/server_v4.log
```

**Expected:** PID 93097 on port 3001

---

## Frontend Changes Needed

V4 backend is ready, but frontend doesn't display word progress yet.

Add this to your ayah display component:

```vue
<template>
  <div class="ayah-display">
    <div class="ayah-text">{{ ayah.text }}</div>
    
    <!-- NEW: Word progress bar -->
    <div v-if="wordProgress.totalWords > 0" class="word-progress">
      <span>Word {{ wordProgress.wordIndex + 1 }} / {{ wordProgress.totalWords }}</span>
      <div class="progress-bar">
        <div class="fill" :style="{ width: wordProgress.progress * 100 + '%' }"></div>
      </div>
    </div>
  </div>
</template>

<script>
data() {
  return {
    wordProgress: { wordIndex: 0, totalWords: 0, progress: 0 }
  };
},

mounted() {
  this.ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'wordProgress') {
      this.wordProgress = msg;
    }
  });
}
</script>

<style>
.progress-bar {
  height: 6px;
  background: #333;
  border-radius: 3px;
  margin-top: 5px;
}
.fill {
  height: 100%;
  background: linear-gradient(90deg, #4CAF50, #8BC34A);
  transition: width 0.2s ease;
}
</style>
```

---

## Testing Checklist

- [ ] Refresh app/browser
- [ ] Check logs show "pipeline=v4"
- [ ] Send audio (recite or play recording)
- [ ] Look for "[X words]" in Whisper logs
- [ ] Look for "Word pace from timestamps" messages
- [ ] (Optional) Check browser DevTools for wordProgress events

---

**Last Updated:** 2024-03-08 12:13 UTC  
**Server:** Running with V4 forced  
**Frontend:** Needs progress bar component
