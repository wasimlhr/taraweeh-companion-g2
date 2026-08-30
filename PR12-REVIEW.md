# PR #12 Review — "Harden Railway multi-user transcription security"

- **PR**: https://github.com/wasimlhr/taraweeh-companion-g2/pull/12 (`fix/railway-multiuser-security` → `master`)
- **Reviewed**: 2026-08-30, Claude Code max-effort review (10 finder angles → 1-vote verification → gap sweep)
- **Base**: `3eaf4a3` (v3.1.1) · **Head**: `77f76b8` · **Master at review time**: `2e5eafc` (v3.3.4)
- **Verdict**: **DO NOT MERGE AS-IS.** The diagnoses are largely right; the two flagship mechanisms (IP-keyed limits, token-gated shared mode) break the exact multi-user scenario the title claims to harden. Salvage the good parts on a fresh branch off v3.3.4.

The PR is also stale: based on v3.1.1, six releases behind master, with a hard conflict in
`backend/server.js` — precisely where master has since *improved* the session dedup this PR
deletes. Its TLS-cert deletion is already done on master (v3.2.0). It ships no version bump.

---

## How it was verified

Not just read — exercised. The PR's server was booted from its own branch and probed over
real WebSockets:

| Check | Result |
|---|---|
| PR's own test suite (its claim: 62/62) | **62/62 pass** — claim honest |
| Boots with certs deleted (fresh clone) | **Yes** — HTTP-only, no crash |
| Duplicate `sessionId` closes the stale socket (old dedup) | **No** — both sockets stay open (dedup really gone) |
| 6th connection from one IP | **Refused 503** |
| >600 msgs/min from one IP | **RATE_LIMITED + close 1008** |
| Innocent 2nd socket on the same IP after bucket exhausted | **Killed 1008 on its next message** (collateral confirmed) |
| Shared keys + `SHARED_ACCESS_TOKEN` set, client sends no token | **"No groq key — transcribe will fail"** (locked out) |
| Client sends the token | Shared key granted (gate works; no shipped client has the field) |
| `fetchWithDeadline` vs stalled response body | **Hangs past deadline** (still pending at 8s with a 1.5s deadline) |
| `pipeline.destroy()` abort vs in-flight body read | **Does not cancel it** |

---

## Findings (15, ranked most severe first)

### 1. Per-IP message quota disconnects users who share an IP — CONFIRMED
`backend/server.js:518` — The 600 msgs/min quota keys on `req.socket.remoteAddress` and
closes sockets with 1008. One recording G2 client already sends ~300 msgs/min (PCM flush
every 200 ms), so **two** reciters behind one mosque NAT — or *everyone* behind Railway's
edge proxy, since `X-Forwarded-For` is never read anywhere — share one bucket and disconnect
each other. Clients auto-reconnect on ~1 s timers into the still-full sliding window: a
sustained mosque-wide disconnect storm. The PR deleted the code comment that warned exactly
this ("not IP — prod users share NAT/carrier IPs and would cannibalise each other").

### 2. Shared-key mode is unreachable — CONFIRMED
`backend/server.js:399` — Shared mode now requires `tokenMatches(opts.sharedAccessToken,
SHARED_ACCESS_TOKEN)`. No client anywhere sends `sharedAccessToken` (zero hits in the G2 app
and the entire mentra repo; no settings UI was added), and `tokenMatches` also returns false
when the env var is unset. Live-probed both operator shapes: keyless users of a shared-keys
deployment get "No groq key — transcribe will fail", a message that misdirects them toward
buying their own API key. The whole quota/token machinery is dead code as shipped.

### 3. New frame caps reject the client's own reconnect flush — CONFIRMED
`backend/security.js:3` — `MAX_PCM_FRAME` 64 KB / `maxPayload` 96 KB are smaller than the G2
client's deliberate reconnect burst: it buffers up to 5 s of PCM (160,000 bytes, comment "cap
at 5s to prevent burst on reconnect") and flushes it as **one** frame; the accumulator is never
cleared on socket close. Outage 2.05–3.07 s → `INVALID_PCM`, recitation silently discarded.
Outage >3.07 s → 1009 kills the freshly reconnected socket, accumulator still ≥3 s, next flush
kills it again — a reconnect loop on exactly the path the buffer was built to protect.

### 4. Per-IP connection cap of 5 collapses behind the proxy — CONFIRMED
`backend/server.js:344` — Live-probed: 6th same-IP connection refused with a raw 503. Behind
Railway's TLS-terminating proxy every client shares the proxy's internal address, so 5 becomes
a de facto cap on **total** concurrent users — reached long before the intended
`MAX_CONNECTIONS=100`. Zombie sockets from finding 7 count toward the same 5.

### 5. Provider deadline/abort don't cover the response body — CONFIRMED (empirical)
`backend/requestControl.js:51` — `fetchWithDeadline` clears its timer and detaches the
parent-abort listener in `finally` as soon as headers arrive, so every provider's
`res.text()`/`res.json()` is unbounded and uncancellable — a regression from the old
`AbortSignal.timeout` in the fetch init, which covered the whole request. Proven with a
stub server: body read still pending at 8 s under a 1.5 s deadline, and a parent abort
(`pipeline.destroy()`) didn't reach it either. A provider stalling mid-body wedges that
pipeline's search loop permanently.

### 6. Gemini catch assigns a deleted variable → ReferenceError → possible process crash — CONFIRMED
`backend/geminiProvider.js:59` — `collectTranscription`'s catch still runs `session = null;`
but the PR deleted the module-level `let session`. Strict-mode ESM throws
`ReferenceError` inside a fire-and-forget async IIFE nothing awaits → unhandled rejection,
which under Node's default policy can terminate the whole multi-user backend. The path is
routine when gemini is active: the new `finally { liveSession.close() }` races the receive
loop after any timeout/abort. The graceful partial-transcript fallback dies with it.

### 7. Session dedup removed; zombie sockets never reaped — CONFIRMED
`backend/server.js:585` — The `_activeSessions` dedup (same `sessionId` reconnecting closes
the stale socket) is deleted with no replacement reaper. A TCP-alive-but-abandoned socket
auto-answers WebSocket pings at the protocol level, so the 30 s keepalive never terminates
it; its pipeline keeps running (duplicate provider spend), and it counts toward the per-IP
cap of 5 until the WebView process dies. Master has meanwhile *kept and improved* this dedup —
in the one file that hard-conflicts, so a careless conflict resolution would silently drop it.

### 8. Aborted probes poison the global `/api/status` for everyone — CONFIRMED
`backend/whisperProvider.js:274` — The probe's catch now emits `{status:'error'}` before
rethrowing `PROVIDER_CANCELLED`/`PROVIDER_TIMEOUT`, and `destroy()` now aborts in-flight
probes. Any client disconnecting during the ~15 s probe window writes "error" into the
module-global `lastEndpointLifecycle` served to **all** clients. Also flips
`/api/endpoint/warmup` from 200-with-lifecycle to HTTP 500 on a probe timeout, breaking the
app's wake flow ("Start failed" instead of proceeding).

### 9. Whisper timeout failover removed — CONFIRMED
`backend/whisperProvider.js:307` — The transcription ladder's catches now rethrow
`PROVIDER_TIMEOUT` *before* the fallback logic. Previously a hung local/dedicated endpoint
timed out after 30–35 s and failed over (local → dedicated → HF public); now the chunk fails
outright, every chunk, until the endpoint recovers. Rethrowing `PROVIDER_CANCELLED` is
correct; the timeout rethrow removes the feature. (Env-gated: whisper family only, not the
Groq/OpenAI default.)

### 10. MentraOS users lose reconnect/restart recovery — CONFIRMED
`backend/server.js:481` — Recovery moved from the server-side `/tmp` file (which restored any
client's pipeline within 30 min — and was rightly removed: it could leak one user's position
into another's session) to client-echoed `recoveryState`. Only the G2 client was wired up.
The separately-installed mentra app neither stores the `recovery_state` message nor sends the
field, so a backend redeploy or socket blip mid-Taraweeh cold-starts its pipeline at 0:0.

### 11. Mentra's own chunk bound exceeds the new server caps — PLAUSIBLE
`backend/security.js:4` — The mentra client's `validAudioChunk` accepts up to 256 KB of
base64 (~192 KB PCM) per chunk and forwards it verbatim; the new server caps are 64 KB PCM /
96 KB frame. Host-delivered chunks of 64–71 KB PCM draw `INVALID_PCM` (audio silently lost);
above ~72 KB PCM the JSON text frame exceeds `maxPayload` → 1009 → reconnect loop. Depends on
host chunk sizing, but the two bounds were never reconciled.

### 12. `recovery_state` emitted every 500 ms for the whole session — CONFIRMED
`backend/audioPipelineV4.js:2926` — `onRecoveryState` sits inside `_emitState`'s
`if (mode === 'LOCKED')` block with no change/transition guard, and the 500 ms heartbeat calls
`_emitState` unconditionally. ~7,200–14,400 extra sends per connection per session, each one
a synchronous `localStorage` write **plus an EvenHub bridge IPC round-trip** on the client,
for a value that changes once per ayah. (The old code had the same cadence but paid it as a
local `/tmp` write; the PR exports it over the network.) Fix: emit only when (surah, ayah)
changes.

### 13. HF token sent to Groq as a Bearer for keyless clients — PLAUSIBLE
`backend/transcriptionRouter.js:41` — `collectKeys` treats `opts.apiKey` as the Groq BYOK key
when provider is groq, and `buildWhisperOpts()` injects `apiKey: HUGGINGFACE_TOKEN`. With that
env var set, a keyless client (sharedMode=false → **no quota gate at all**) still fires Groq
calls carrying the server's HF credential (cross-provider credential transmission, 401 churn) —
while the server's own hand-rolled key derivation says "No groq key" to the client. Inherited
call-time behavior, but it breaks the PR's stated invariant and its new derivations disagree
with what `transcribe()` actually does.

### 14. Saved `http://` backend URLs silently rerouted to the hosted server — CONFIRMED
`taraweeh-companion/app/index.html:1637` — `backendBase()` now drops a previously-saved
non-loopback `http://` URL at read time (the HTTPS warning only fires on re-save) and falls
back to `HOSTED_BACKEND`. An existing LAN-dev user updates the app and, with no visible
change, their BYOK keys and live microphone audio stream to the public Railway deployment.
LAN IPs can never satisfy the HTTPS rule, so the documented dev-PC-over-LAN path is left with
no supported configuration and no error.

### 15. All shared-token users share one quota principal — CONFIRMED (latent)
`backend/server.js:414` — The quota principal is the sha256 of the single
`SHARED_ACCESS_TOKEN`, so every user hashes to one principal:
`SHARED_PRINCIPAL_CALLS_PER_MINUTE=20` (≈ one reciter's cadence) and concurrency 2 become a
second, *tighter* global cap. Quota errors carry no 429 status so the pipeline applies no
backoff (retry every ~3 s, error spam, burned windows), and failed concurrency acquires still
consume quota slots. Dormant only because finding 2 makes shared mode unreachable; fixing 2
without fixing this ships a new incident at the next multi-user night.

---

## Refuted during verification (don't re-chase these)

- **"Destroy-abort sprays error frames onto the live socket after re-init"** — REFUTED.
  `destroy()` rebinds `onError`/`onStatus`/`onStateUpdate` to no-ops synchronously in the same
  tick as the abort; the rejection lands as a microtask strictly after, so the unguarded emits
  hit no-ops.
- **"503 write to a listener-less upgrade socket crashes on RST"** — REFUTED empirically
  (2,400+ RST attempts, zero crashes). The synchronous `socket.destroy()` on the next line
  suppresses the read-side ECONNRESET; removing it crashes on the first batch. Correct but
  fragile — any future `await` between the write and the destroy reintroduces the crash.
- Gemini's raced-out promises are handled (`Promise.race` observes losers); the compare
  endpoint's `whisperOpts.signal` mutation is per-request; mentra parses unknown
  `recovery_state` messages harmlessly; the PR's pinned test list skips nothing (master has
  only `transcriptionRouter.test.js`); `resolveProvider` honors explicit provider choices.

## Below the report cap (still worth fixing in the rework)

- `server.js` derives keys/provider three hand-rolled times (`initiallySelected` /
  `effectiveKeys` / `selectedKey` ternary chain) instead of `collectKeys` + `resolveProvider` +
  `keys[selected]` — three angles independently converged on this drift trap.
- `requestControl.js` builds the `PROVIDER_CANCELLED` error shape three times; the
  req/res AbortController wiring is pasted verbatim into three Express handlers; the
  `timedOut` flag duplicates `signal.reason instanceof ProviderTimeoutError`.
- Two `security.test.js` tests are theater (assert nothing about server wiring — e.g.
  "duplicate identifiers do not grant access" never touches an identifier); the quota tests
  never exercise the IP-keying composition that findings 1/4 break.
- `SlidingQuota` is O(window) per message with a fresh array allocation, and its Map never
  evicts idle IPs (unbounded growth); a token bucket / fixed-window counter is O(1).
- Gemini per-*request* Live sessions add a full WS handshake per 3 s chunk (~1,200–2,400 per
  session); per-*pipeline* sessions isolate users equally well at ~1 handshake. Timeout now
  rejects instead of returning the partial transcript.
- `Number(env) || default` traps: `"0"`/garbage silently become the default; negative values
  pass through and invert semantics (`WS_MAX_CONNECTIONS=-1` rejects everyone).
- `validRecoveryState` accepts impossible pairs (1:250); V3 `manualPrev` emits nonexistent
  positions with blank content (current clients happen to mask it). The restored `pace` is
  dead — zeroed later in the constructor (pre-existing; carried over).
- `engines: ">=18"` vs `--test-isolation` needing Node ≥22.8 — `npm test` breaks on 18/20 LTS.
- README addition uses an `#` heading glued to a list (every sibling section is `##`).

## What the PR gets right (salvage list)

Real bugs it correctly diagnosed: the `/tmp` recovery file was cross-user contamination on a
shared host; the global Gemini Live session interleaved different users' transcripts; three of
six provider paths had no timeout at all; committed TLS certs didn't belong in git (already
fixed on master in v3.2.0); WS payloads were unbounded; PCM frames were never shape-checked;
malformed JSON was silently swallowed. Its test suite claim was honest (62/62 verified) and
the server boots cleanly without certs.

## Recommended path forward

1. Close or rebase — don't resolve the `server.js` conflict toward the PR side (that would
   delete master's improved session dedup). Start fresh from v3.3.4.
2. Re-key abuse limits per **connection/session** with global backstops; if IP is ever used,
   read `X-Forwarded-For` from the trusted proxy. Rate-limit by **bytes/sec**, not message
   count, and don't close on breach — drop/throttle.
3. Raise frame caps above real client behavior (single flush can be 160 KB; mentra chunks up
   to 192 KB PCM) or slice the client flush.
4. Extend the deadline wrapper to cover body reads (keep the signal armed until the body is
   consumed); delete `session = null` in geminiProvider; make Gemini sessions per-pipeline.
5. Keep client-carried recovery, but: wire it into the mentra app, emit on ayah change only,
   validate ayah existence via `getAyah`.
6. Shared-mode auth needs a client half (settings field + init payload in both apps) before
   the server gate ships; meter per session, not per token.
7. Version-bump per release convention (one commit, `vX.Y.Z:` title), run
   `scripts/wordclock-invariant-bench.js` + both test suites before shipping.
