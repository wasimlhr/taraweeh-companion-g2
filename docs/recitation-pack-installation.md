# Installing approved recitation audio

The app lists Alafasy, Husary, Abdul Basit Murattal, Saad Al-Ghamdi and Noreen Muhammad Siddiq. Missing chapters are prepared by our backend from the verified fixed sources below, then stored and served from our own audio endpoints. The client contacts our backend only. Set `RECITATION_FETCH_ENABLED=false` to permit only installed packs.

## Saad Al-Ghamdi and Noreen Muhammad Siddiq

[MP3Quran's published policy](https://www.mp3quran.net/eng/privacy), verified 23 October 2026, explicitly allows visitors and developers to copy site material and use its links. Attribution and that permission record are retained in the private pack manifest. Neither the recordings nor their rights become ours.

Both additions use the original full-surah files from the fixed `cdn.mp3quran.net/audio/saad-ghamdi/r1/` and `cdn.mp3quran.net/audio/noreen-siddiq/r1/` directories. The backend streams them to a temporary file, verifies complete MPEG frames and actual duration/bitrate, hashes the bytes, and atomically publishes an owned asset and manifest. It preserves the source encoding (sampled Saad: 96 kbps; Noreen: 128 kbps). Downloads are serialized for this provider, deduplicated per chapter, retried up to three times, bounded at 160 MiB and 180 seconds per attempt, and inspected in bounded chunks. No ffmpeg dependency or transcoding is required.

- `saad-al-ghamdi`: Hafs; official [MP3Quran ayah timings](https://www.mp3quran.net/eng/timing-api), read 30. Coverage was checked for all 114 surahs. Missing, overlapping, out-of-order, incomplete, or out-of-duration cues reject preparation rather than fabricate timing. Each ayah track references the same owned MP3 with `startMs` and `endMs`. Playback advances on the real media clock without reloading the file at each boundary; the seek bar is relative to the selected ayah. Cache download sizes, integrity checks and removals count each unique asset once.
- `noreen-muhammad-siddiq`: Al-Duri with automatic verse following (`playbackMode: "ayah"`, `syncAvailable: true`, `timingVersion: 1`). MP3Quran read 138 still has no official timings. Published word timestamps instead come from [Quranic-Recitation-Data](https://huggingface.co/datasets/zaibihassan/Quranic-Recitation-Data), pinned to revision `aa18b96aa182816377bc8dbf3769ce0b8ded799a` (Apache-2.0). All 114 timestamped recordings were compared to the original MP3s at three positions per chapter: minimum waveform correlation 0.85732, maximum measured offset 6.25 ms. Each timing map is bound to the original MP3's SHA-256 and duration; a changed recording is rejected. Boundaries preserve silence between verses and continuous playback. Existing audio-only manifests are invalidated and rebuilt; an outdated client-side audio-only manifest is never accepted as synchronized.

Noreen uses the original Al-Duri Arabic from [Quranpedia's mushaf 6](https://api.quranpedia.net/dumps/mushafs-6.json.gz), dump version 2026-10-23 (6,218 source verses). The source provides explicit mappings to the 6,236 Hafs translation/timing references. Connected split/merged verses are grouped, with each translation included once. Al-Fatihah's invocation remains unnumbered; its final Al-Duri verses 6–7 share one translation. Arabic, source rosettes and the matching unmodified KFGQPC Douri font are preserved. The font's distribution license and both data licenses/credits accompany the files. English and other translations continue through the native glasses text container.

Maintainer tools: `node scripts/prepare-noreen-timings.mjs` audits the pinned audio/timing pair and publishes `backend/data/noreen-timings.json` only after all 114 chapters pass; it requires Python/NumPy and ffmpeg locally. `node scripts/import-duri-reading.mjs <primary-dump.json>` imports the source Arabic and mapping. Production playback/import needs neither Python nor ffmpeg, and never contacts Hugging Face or Quranpedia from the app.

The public manifest contains only owned `/audio/<sha256>.mp3` URLs, mode/narration metadata and attribution; upstream URLs and permission records stay on the server. No additional client network origins are needed.

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

The local per-ayah importer example applies to `alafasy`, `husary`, and `abdul-basit-murattal`. The two MP3Quran IDs use the provider preparation path above with its additional mode/cue metadata. Every per-ayah chapter must have its complete numbered ayahs in order. Each import is atomic at the chapter manifest: validated content-addressed audio is copied before the manifest is published. Orphaned files from an interrupted import are unlisted and never served. Catalog refresh can take ten seconds. Restarting is unnecessary.

Verify `/api/recitations` shows that chapter available, `/api/recitations/alafasy/112` exposes only owned `/audio/<sha256>.mp3` URLs, and byte-range requests return 206. A manifest has actual duration/bytes/hash and a revision. Separate-file reciters advance on media end; Saad advances using official ayah cues within the source file. Long-ayah glasses continuation uses approximate content-weighted intervals within the real ayah clock, not word timestamps. Short ayahs can share a glasses page. Separate-file playback can contain inter-file gaps.

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
