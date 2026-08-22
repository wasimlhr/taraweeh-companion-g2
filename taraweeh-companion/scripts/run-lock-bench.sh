#!/usr/bin/env bash
#
# Lock-latency A/B runner. Compares the working-tree pipeline against the same
# file at an older commit, so a suspected pacing/gating regression can be
# measured instead of argued about. Run from taraweeh-companion/.
#
#   bash scripts/run-lock-bench.sh mic-levels        # sweep phone-mic RMS levels
#   bash scripts/run-lock-bench.sh scenarios         # Fatiha / long breaths / refrains
#   BASELINE=<rev> bash scripts/run-lock-bench.sh …  # compare against another rev
#
set -u

MODE="${1:-mic-levels}"
BASELINE="${BASELINE:-5bccb84^}"        # last release before the 2.6.7 matching rework
DURATION="${DURATION:-30000}"
OUT="${OUT:-/tmp/lockbench}"
PIPELINE_SRC="backend/audioPipelineV4.js"
BASELINE_FILE="backend/.bench-baseline-pipeline.js"

mkdir -p "$OUT"
git show "$BASELINE:taraweeh-companion/$PIPELINE_SRC" > "$BASELINE_FILE" \
  || { echo "cannot read $PIPELINE_SRC at $BASELINE" >&2; exit 1; }
trap 'rm -f "$BASELINE_FILE"' EXIT

PIPES=("audioPipelineV4.js" ".bench-baseline-pipeline.js")
label() { [ "$1" = "audioPipelineV4.js" ] && echo "working tree" || echo "baseline $BASELINE"; }
fields='ASR calls|first ASR|ASR call gaps|ASR windows|FIRST LOCK|verse locks|truncs'

run() {  # run <tag> <pipeline> <args…>
  local tag="$1" pipe="$2"; shift 2
  node scripts/lock-latency-bench.js --pipeline="$pipe" --duration="$DURATION" \
    --quiet "$@" > "$OUT/$tag.txt" 2>/dev/null
}

case "$MODE" in
mic-levels)
  # The pipeline's own (pre-2.6.7) comment put the phone/G2 mic at 0.002-0.015 RMS.
  for rms in 0.0025 0.0035 0.006 0.012; do
    for pipe in "${PIPES[@]}"; do
      run "mic-$rms-$pipe" "$pipe" --source=browser --rms="$rms" &
    done
  done
  wait
  for rms in 0.0025 0.0035 0.006 0.012; do
    echo "### browser mic, rms=$rms"
    for pipe in "${PIPES[@]}"; do
      echo "-- $(label "$pipe")"
      grep -E "$fields" "$OUT/mic-$rms-$pipe.txt"
    done
    echo
  done
  ;;
scenarios)
  # Run on the permissive g2 profile so the voice gate is not the confound and
  # the buffering / throttling behaviour is what gets measured.
  declare -A S=(
    [fatiha-taraweeh]="--surah=1 --from=1 --ayahs=7 --taraweeh --pause=1200"
    [mulk-long-breaths]="--surah=67 --from=1 --ayahs=10 --pause=3000"
    [rahman-refrains]="--surah=55 --from=1 --ayahs=14 --pause=1500"
    [practice-pauses]="--surah=67 --from=1 --ayahs=6 --practice --pause=3500"
  )
  for name in "${!S[@]}"; do
    for pipe in "${PIPES[@]}"; do
      # shellcheck disable=SC2086
      run "$name-$pipe" "$pipe" --source=g2 --rms=0.003 ${S[$name]} &
    done
  done
  wait
  for name in "${!S[@]}"; do
    echo "### scenario: $name"
    for pipe in "${PIPES[@]}"; do
      echo "-- $(label "$pipe")"
      grep -E "$fields" "$OUT/$name-$pipe.txt"
    done
    echo
  done
  ;;
*)
  echo "usage: $0 [mic-levels|scenarios]" >&2; exit 2 ;;
esac
