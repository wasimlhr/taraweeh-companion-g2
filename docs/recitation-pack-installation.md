# Installing approved recitation audio

The app lists Alafasy, Husary and Abdul Basit Murattal. Missing chapters are prepared by our backend from the verified fixed source below, then stored and served from our own audio endpoints. The client contacts our backend only. Set `RECITATION_FETCH_ENABLED=false` to permit only manually installed packs.

## Authorized source, verified 23 October 2026

[Al Quran Cloud terms](https://alquran.cloud/terms-and-conditions), updated 14 June 2026, section IV permits free noncommercial redistribution of published recitations; copyright remains with reciters/estates. Section III encourages downstream caching. Attribution is retained in each manifest. This implementation preserves the published 64-kbps bitrate and maps only `ar.alafasy`, `ar.husary`, `ar.abdulbasitmurattal` on the fixed Islamic Network CDN. No arbitrary source URLs, redirects, or client media origins are accepted. Reassess terms before commercial use or changing sources.

`GET /api/recitations/:id/:surah` waits for preparation when absent. Installation deduplicates requests, allows two simultaneous chapter jobs globally and four file downloads per chapter, limits each file to 10 MiB and each chapter to 120 MiB, retries temporary fetch failures, validates MPEG frame bitrate/duration, hashes files and publishes the chapter manifest only after all tracks succeed. A failed preparation returns 503 with Retry-After. Already cached chapters do not require the upstream source. Canceled client requests may leave server preparation running to completion for other readers. Backend disk capacity and network egress should be monitored.

Set `RECITATION_PATH=/data/recitations` on the backend with persistent storage mounted at `/data`. This folder is separate from `/data/usage` and does not replace usage logs. Keep approved recordings outside Git and the EHPK. Back up the volume independently.

Prepare local 64-kbit/s MP3 files, one file per numbered ayah, with filenames under the same directory as an import description. The importer uses installed `ffprobe` to read actual duration, codec and bitrate, and computes size and SHA-256 from each file. It does not transcode, fetch URLs, or grant rights to audio.

Example import description (`approved-pack.json`); this example is deliberately incomplete and will be rejected until every ayah in the chosen chapter is supplied:

```json
{
  "reciter": "alafasy",
  "surah": 112,
  "rights": {
    "redistributionApproved": true,
    "license": "Exact permission or license identifier",
    "source": "Rights holder and source revision",
    "reviewedBy": "Name of person who verified permission",
    "attribution": "Required public attribution"
  },
  "tracks": [
    {"ayah": 1, "file": "112001.mp3"}
  ]
}
```

Only set approval after documenting permission for redistribution, self-hosting and offline downloads. Preserve that permission record with the archive. Quran text rights do not establish recording rights.

From `taraweeh-companion`:

```text
node scripts/import-recitation-pack.mjs /path/to/approved-pack.json /data/recitations
```

Accepted reciter IDs: `alafasy`, `husary`, `abdul-basit-murattal`. Every chapter must have its complete numbered ayahs in order. Each import is atomic at the chapter manifest: validated content-addressed audio is copied before the manifest is published. Orphaned files from an interrupted import are unlisted and never served. Catalog refresh can take ten seconds. Restarting is unnecessary.

Verify `/api/recitations` shows that chapter available, `/api/recitations/alafasy/112` exposes only owned `/audio/<sha256>.mp3` URLs, and byte-range requests return 206. A manifest has actual per-track duration/bytes/hash and a revision. There are no word/segment cues yet; per-ayah file end is the only automatic ayah transition. Long ayah continuation remains manual rather than guessed. Per-ayah playback can contain inter-file gaps.

Frontend integration:

```js
const cache = new ReaderAudioCache({baseUrl: effectiveBackendUrl});
const player = new ReaderPlayback({
  resolveTrack: track => cache.resolveTrack(track),
  onChange: state => updatePlayerAndSelectedAyah(state)
});
await player.load(manifest, {ayah: selectedAyah});
await player.play(); // invoke from the user's Play action
```

`download(manifest,{signal,onProgress})` validates every new track's actual length and SHA-256 before caching it. Abort cancels the active request and preserves already verified tracks so a later download resumes. `has(manifest)` is true only when every asset is cached. `remove(manifest)` deletes that chapter's cached assets. `resolveTrack(track)` returns a cache blob URL if present, otherwise the owned network URL; the controller releases blob URLs on selection/disposal. Offline storage is capability-dependent and may be evicted by the host.

No credentials, raw audio or playback history are uploaded by these modules. Persistent playback analytics is a future integration; current transcription analytics must not be used as evidence of successful playback.
