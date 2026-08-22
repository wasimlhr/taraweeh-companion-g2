#!/usr/bin/env bash
#
# Sync-accuracy runner. Two modes:
#
#   bash scripts/run-sync-bench.sh scenarios          # all scenarios, current code
#   bash scripts/run-sync-bench.sh ab "A=1" "B=2"     # same scenario, tuning A/B
#   BASELINE=<rev> bash scripts/run-sync-bench.sh compare   # vs another revision
#
# Runs in parallel because each case is a real-time replay. Run from taraweeh-companion/.
set -u

MODE="${1:-scenarios}"
SCENARIO="${SCENARIO:-steady}"
OUT="${OUT:-/tmp/syncbench}"
BASELINE="${BASELINE:-5bccb84^}"
EXTRA="${EXTRA:---taraweeh}"
BASELINE_FILE="backend/.bench-baseline-pipeline.js"
fields='first lock|ASR calls|IN SYNC|within|AHEAD|BEHIND|wrong surah|worst'

mkdir -p "$OUT"

case "$MODE" in
scenarios)
  names=$(node scripts/sync-accuracy-bench.js --list | awk '{print $1}')
  for s in $names; do
    # shellcheck disable=SC2086
    node scripts/sync-accuracy-bench.js --scenario="$s" $EXTRA --quiet \
      > "$OUT/scenario-$s.txt" 2>/dev/null &
  done
  wait
  for s in $names; do
    echo "### $s"
    grep -E "$fields" "$OUT/scenario-$s.txt"
    echo
  done
  ;;
ab)
  shift
  i=0
  for cfg in "$@"; do
    i=$((i + 1))
    # shellcheck disable=SC2086
    env $cfg node scripts/sync-accuracy-bench.js --scenario="$SCENARIO" $EXTRA --quiet \
      > "$OUT/ab-$i.txt" 2>/dev/null &
  done
  wait
  i=0
  for cfg in "$@"; do
    i=$((i + 1))
    echo "### ${cfg:-defaults}"
    grep -E "$fields" "$OUT/ab-$i.txt"
    echo
  done
  ;;
compare)
  git show "$BASELINE:taraweeh-companion/backend/audioPipelineV4.js" > "$BASELINE_FILE" \
    || { echo "cannot read pipeline at $BASELINE" >&2; exit 1; }
  trap 'rm -f "$BASELINE_FILE"' EXIT
  names=$(node scripts/sync-accuracy-bench.js --list | awk '{print $1}')
  for s in $names; do
    for pipe in audioPipelineV4.js .bench-baseline-pipeline.js; do
      # shellcheck disable=SC2086
      node scripts/sync-accuracy-bench.js --scenario="$s" --pipeline="$pipe" $EXTRA --quiet \
        > "$OUT/cmp-$s-$pipe.txt" 2>/dev/null &
    done
  done
  wait
  for s in $names; do
    echo "### $s"
    for pipe in audioPipelineV4.js .bench-baseline-pipeline.js; do
      [ "$pipe" = audioPipelineV4.js ] && echo "-- working tree" || echo "-- baseline $BASELINE"
      grep -E "$fields" "$OUT/cmp-$s-$pipe.txt"
    done
    echo
  done
  ;;
*)
  echo "usage: $0 [scenarios|ab <ENV=V>...|compare]" >&2; exit 2 ;;
esac
