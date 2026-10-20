#!/usr/bin/env bash
# Runs every Lua test file in its own interpreter (clean global state per file).
set -u
cd "$(dirname "$0")"
LUA=${LUA:-lua5.4}
command -v "$LUA" >/dev/null || { echo "lua5.4 not found (apt install lua5.4)"; exit 2; }
status=0; passed=0; failed=0
for f in test_*.lua; do
  out=$("$LUA" harness.lua "$f" 2>&1); code=$?
  echo "$out"
  p=$(echo "$out" | tail -1 | sed -n 's/^\([0-9]*\) passed, \([0-9]*\) failed$/\1/p'); q=$(echo "$out" | tail -1 | sed -n 's/^\([0-9]*\) passed, \([0-9]*\) failed$/\2/p')
  passed=$((passed + ${p:-0})); failed=$((failed + ${q:-1}))
  [ $code -ne 0 ] && status=1
done
echo "== Lua total: $passed passed, $failed failed"
exit $status
