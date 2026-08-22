#!/usr/bin/env bash
#
# Download a real recitation from everyayah.com as per-ayah MP3s and stitch them
# into one 16kHz mono WAV, writing a JSON manifest of exact ayah boundaries.
#
# Per-ayah files are used deliberately: each file's duration gives the ground
# truth for when the reciter moves on, which is what the sync bench grades
# against. A single surah-length MP3 would leave the boundaries unknown.
#
#   bash scripts/fetch-recitation.sh <reciter-dir> <surah> <from> <to> [outdir]
#   bash scripts/fetch-recitation.sh Alafasy_128kbps 78 1 40
#
set -euo pipefail

RECITER="${1:?reciter directory, e.g. Alafasy_128kbps}"
SURAH="${2:?surah number}"
FROM="${3:?from ayah}"
TO="${4:?to ayah}"
OUT="${5:-/tmp/recitations}"

BASE="https://everyayah.com/data/$RECITER"
TAG="${RECITER}_${SURAH}_${FROM}-${TO}"
WORK="$OUT/$TAG"
mkdir -p "$WORK/parts"

echo "[fetch] $RECITER surah $SURAH ayah $FROM-$TO"
for a in $(seq "$FROM" "$TO"); do
  f=$(printf '%03d%03d.mp3' "$SURAH" "$a")
  if [ ! -s "$WORK/parts/$f" ]; then
    curl -sfS --max-time 60 -o "$WORK/parts/$f" "$BASE/$f" \
      || { echo "[fetch] MISSING $f" >&2; exit 1; }
  fi
done

# Convert each ayah separately so its exact duration is known, then concatenate.
: > "$WORK/list.txt"
manifest="$WORK/manifest.json"
echo "{\"reciter\":\"$RECITER\",\"surah\":$SURAH,\"ayahs\":[" > "$manifest"
first=1
for a in $(seq "$FROM" "$TO"); do
  f=$(printf '%03d%03d' "$SURAH" "$a")
  ffmpeg -v error -y -i "$WORK/parts/$f.mp3" -ac 1 -ar 16000 -c:a pcm_s16le "$WORK/parts/$f.wav"
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$WORK/parts/$f.wav")
  echo "file 'parts/$f.wav'" >> "$WORK/list.txt"
  [ $first -eq 0 ] && echo "," >> "$manifest"
  printf '{"ayah":%d,"durationMs":%d}' "$a" "$(python3 -c "print(round($dur*1000))")" >> "$manifest"
  first=0
done
echo "]}" >> "$manifest"

ffmpeg -v error -y -f concat -safe 0 -i "$WORK/list.txt" -ac 1 -ar 16000 -c:a pcm_s16le "$WORK/audio.wav"
total=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$WORK/audio.wav")
echo "[fetch] wrote $WORK/audio.wav (${total}s) and manifest.json"
